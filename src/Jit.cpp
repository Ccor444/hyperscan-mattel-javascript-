#include "Jit.h"
#include "SCore7.h"
#include "Bus.h"
#include <algorithm>
#include <cstdio>
#include <cstring>

#ifdef __wasm__
extern "C" __attribute__((import_module("env"), import_name("hs_jit_sync"))) int hs_jit_sync_cb(void*);
#endif

namespace hyperscan {

uint32_t g_jitDbg = 0;   // bit0: pares via interpretador, bit1: sem laços, bit2: sem desvios laterais/saltos seguidos, bit3: sem eliminação de flags, bit4: kMaxIns=1

namespace {

constexpr int FN = 0, FZ = 1, FC = 2, FV = 3, FT = 4;      // índices das flags
constexpr uint32_t kMaxIns = 128;

inline int32_t sx(int32_t v, int b) { int s = 32 - b; return (v << s) >> s; }

struct Buf {
    std::vector<uint8_t> b;
    void u8(uint8_t v) { b.push_back(v); }
    void uleb(uint32_t v) { do { uint8_t c = v & 0x7f; v >>= 7; if (v) c |= 0x80; b.push_back(c); } while (v); }
    void sleb(int32_t v) {
        for (;;) {
            uint8_t c = v & 0x7f; v >>= 7;
            bool done = (v == 0 && !(c & 0x40)) || (v == -1 && (c & 0x40));
            if (!done) c |= 0x80;
            b.push_back(c);
            if (done) break;
        }
    }
    void sleb64(int64_t v) {
        for (;;) {
            uint8_t c = v & 0x7f; v >>= 7;
            bool done = (v == 0 && !(c & 0x40)) || (v == -1 && (c & 0x40));
            if (!done) c |= 0x80;
            b.push_back(c);
            if (done) break;
        }
    }
    void append(const std::vector<uint8_t>& o) { b.insert(b.end(), o.begin(), o.end()); }
};

// opcodes wasm usados
enum : uint8_t {
    O_IF = 0x04, O_ELSE = 0x05, O_END = 0x0b, O_RETURN = 0x0f, O_CALL = 0x10, O_DROP = 0x1a, O_SELECT = 0x1b,
    O_LGET = 0x20, O_LSET = 0x21, O_LTEE = 0x22,
    O_LD32 = 0x28, O_LD8S = 0x2c, O_LD8U = 0x2d, O_LD16S = 0x2e, O_LD16U = 0x2f,
    O_ST32 = 0x36, O_ST8 = 0x3a, O_ST16 = 0x3b,
    O_I32C = 0x41, O_I64C = 0x42,
    O_EQZ = 0x45, O_EQ = 0x46, O_NE = 0x47, O_LTS = 0x48, O_LTU = 0x49, O_GTS = 0x4a, O_GTU = 0x4b, O_LES = 0x4c, O_LEU = 0x4d,
    O_GES = 0x4e, O_GEU = 0x4f,
    O_ADD = 0x6a, O_SUB = 0x6b, O_MUL = 0x6c, O_DIVS = 0x6d, O_DIVU = 0x6e, O_REMS = 0x6f, O_REMU = 0x70,
    O_AND = 0x71, O_OR = 0x72, O_XOR = 0x73, O_SHL = 0x74, O_SHRS = 0x75, O_SHRU = 0x76, O_ROTL = 0x77, O_ROTR = 0x78,
    O_I64ADD = 0x7c, O_I64MUL = 0x7e, O_I64SHRU = 0x88,
    O_WRAP = 0xa7, O_EXT_S = 0xac, O_EXT_U = 0xad, O_EXT8S = 0xc0, O_EXT16S = 0xc1,
};

struct Ins {
    uint32_t pc;
    uint32_t w;       // P (32 bits) ou h (16 bits) ou palavra inteira (par)
    uint8_t len;
    uint8_t kind;     // 0 = 16 bits, 1 = 32 bits, 2 = par/desalinhado (vai pro interpretador)
};

enum { F_IMPORT_RD = 0, F_IMPORT_WR = 1, F_IMPORT_INV = 2, F_IMPORT_INTERP = 3, F_IMPORTS = 4 };

} // namespace

// ------------------------------------------------------------------------------------------------------------------
// Tradutor de um bloco
// ------------------------------------------------------------------------------------------------------------------
class Tr {
public:
    Tr(Jit& j, SCore7& cpu, Bus& bus) : J(j), cpu(cpu), bus(bus) {
        for (int& x : regL) x = -1;
        for (int& x : flL) x = -1;
    }

    // Passo de tradução. `live` (se não nulo) dá as flags vivas após cada instrução. Preenche ins/R/W.
    void build(uint32_t start, const std::vector<uint8_t>* live) {
        live_ = live;
        start_ = start;
        uint32_t p = start;
        bool term = false;
        while (ins.size() < ((g_jitDbg & 16) ? 1u : kMaxIns)) {
            if (hookAt(p)) { if (ins.empty()) { hookFirst = true; return; } break; }
            Ins d = decode(p);
            ins.push_back(d);
            liveAfter_ = live ? (*live)[ins.size() - 1] : 0x1f;
            curR = curW = wSoFar_ = 0;
            follow_ = false;
            term = one(d, ins.size());
            Rm.push_back(curR); Wm.push_back(curW);
            p = follow_ ? followPc_ : p + d.len;
            if (term) break;
        }
        if (!term) { i32c((int32_t)p); lset(tNext()); }
        endPc = p;
        terminated = term;
    }

    // Monta o corpo da função (locais + prólogo + código + epílogo)
    std::vector<uint8_t> finish() {
        if (loopMode_) { regRead_ |= loopDirtyR_; flRead_ |= loopDirtyF_; }
        // prólogo: carrega regs/flags lidos antes de escritos
        Buf pro;
        auto I32C = [&](int32_t v) { pro.u8(O_I32C); pro.sleb(v); };
        for (int i = 0; i < 32; ++i)
            if (regRead_ >> i & 1) { I32C(0); pro.u8(O_LD32); pro.uleb(0); pro.uleb(addrR(i)); pro.u8(O_LSET); pro.uleb(regL[i]); }
        for (int k = 0; k < 5; ++k)
            if (flRead_ >> k & 1) { I32C(0); pro.u8(O_LD32); pro.uleb(0); pro.uleb(addrF(k)); pro.u8(O_LSET); pro.uleb(flL[k]); }
        Buf locals;
        locals.uleb(2);
        locals.uleb(1); locals.u8(0x7e);            // 1 × i64
        locals.uleb((uint32_t)nI32_); locals.u8(0x7f);
        Buf fn;
        fn.append(locals.b);
        fn.append(pro.b);
        if (loopMode_) { fn.u8(0x03); fn.u8(0x40); }          // loop
        fn.append(body_.b);
        if (loopMode_) fn.u8(O_END);
        // epílogo: contagem (laço), spill das regs/flags sujos e valor de retorno
        Buf ep;
        if (loopMode_) { ep.u8(O_I32C); ep.sleb(0); ep.u8(O_LGET); ep.uleb(accL_); ep.u8(O_ST32); ep.uleb(0); ep.uleb(addrOf(&J.doneCell)); }
        spillBuf(ep, loopMode_ ? loopDirtyR_ : regDirty_, loopMode_ ? loopDirtyF_ : flDirty_);
        fn.append(ep.b);
        fn.u8(O_LGET); fn.uleb(tNext());
        fn.u8(O_END);
        Buf res; res.uleb((uint32_t)fn.b.size()); res.append(fn.b);
        return res.b;
    }

    bool sawLoop() const { return sawLoop_; }
    uint32_t dirtyR() const { return regDirty_; }
    uint32_t dirtyF() const { return flDirty_; }
    // modo laço: o bloco inteiro vira um `loop` wasm (função recebe o orçamento de instruções como parâmetro)
    void enableLoop(uint32_t n, uint32_t dr, uint32_t df) {
        loopMode_ = true; loopN_ = n; loopDirtyR_ = dr; loopDirtyF_ = df;
        accL_ = newLocal();
        for (int i = 0; i < 32; ++i) if (dr >> i & 1) regL[i] = newLocal();
        for (int k = 0; k < 5; ++k) if (df >> k & 1) flL[k] = newLocal();
    }
    std::vector<Ins> ins;
    std::vector<uint8_t> Rm, Wm;
    uint32_t endPc = 0;
    bool terminated = false, hookFirst = false;

private:
    Jit& J; SCore7& cpu; Bus& bus;
    const std::vector<uint8_t>* live_ = nullptr;
    uint8_t liveAfter_ = 0x1f, curR = 0, curW = 0, wSoFar_ = 0;
    uint32_t start_ = 0, followPc_ = 0;
    bool follow_ = false;
    bool loopMode_ = false, sawLoop_ = false;
    uint32_t loopN_ = 0, loopDirtyR_ = 0, loopDirtyF_ = 0;
    int accL_ = -1;
    Buf body_;
    Buf& w_ = body_;
    int regL[32]; int flL[5];
    uint32_t regRead_ = 0, regWritten_ = 0, regDirty_ = 0;
    uint32_t flRead_ = 0, flWritten_ = 0, flDirty_ = 0;
    int nI32_ = 0;
    int tA_ = -1, tB_ = -1, tR_ = -1, tAddr_ = -1, tOff_ = -1, tHit_ = -1, tNext_ = -1, tC_ = -1, tW_ = -1;

    // ---- utilidades de emissão
    int newLocal() { return (loopMode_ ? 2 : 1) + nI32_++; }
    int i64L() const { return loopMode_ ? 1 : 0; }
    int tmp(int& s) { if (s < 0) s = newLocal(); return s; }
    int tA() { return tmp(tA_); } int tB() { return tmp(tB_); } int tR() { return tmp(tR_); }
    int tAddr() { return tmp(tAddr_); } int tOff() { return tmp(tOff_); } int tHit() { return tmp(tHit_); }
    int tNext() { return tmp(tNext_); } int tC() { return tmp(tC_); } int tW() { return tmp(tW_); }

    void op(uint8_t b) { w_.u8(b); }
    void i32c(int32_t v) { op(O_I32C); w_.sleb(v); }
    void lget(int l) { op(O_LGET); w_.uleb(l); }
    void lset(int l) { op(O_LSET); w_.uleb(l); }
    void ltee(int l) { op(O_LTEE); w_.uleb(l); }
    void mem(uint8_t opc, uint32_t off) { op(opc); w_.uleb(0); w_.uleb(off); }
    void i64c(int64_t v) { op(O_I64C); w_.sleb64(v); }

    static uint32_t addrOf(const void* p) { return (uint32_t)(uintptr_t)p; }
    uint32_t addrR(int i) { return addrOf(&cpu.r[i]); }
    uint32_t addrF(int k) {
        switch (k) { case FN: return addrOf(&cpu.N); case FZ: return addrOf(&cpu.Z); case FC: return addrOf(&cpu.C);
                     case FV: return addrOf(&cpu.V); default: return addrOf(&cpu.T); }
    }

    void spillBuf(Buf& b, uint32_t rd, uint32_t fd) {
        for (int i = 0; i < 32; ++i)
            if (rd >> i & 1) { b.u8(O_I32C); b.sleb(0); b.u8(O_LGET); b.uleb(regL[i]); b.u8(O_ST32); b.uleb(0); b.uleb(addrR(i)); }
        for (int k = 0; k < 5; ++k)
            if (fd >> k & 1) { b.u8(O_I32C); b.sleb(0); b.u8(O_LGET); b.uleb(flL[k]); b.u8(O_ST32); b.uleb(0); b.uleb(addrF(k)); }
    }
    void spillNow() {   // emite spill dos sujos até aqui, no corpo
        Buf b; spillBuf(b, loopMode_ ? loopDirtyR_ : regDirty_, loopMode_ ? loopDirtyF_ : flDirty_); w_.append(b.b);
    }

    // registradores
    void getR(int i) {
        if (regL[i] < 0) regL[i] = newLocal();
        if (!(regWritten_ >> i & 1)) regRead_ |= 1u << i;
        lget(regL[i]);
    }
    void setR(int i) {
        if (regL[i] < 0) regL[i] = newLocal();
        lset(regL[i]);
        regWritten_ |= 1u << i; regDirty_ |= 1u << i;
    }
    // flags
    bool want(int k) const { return (liveAfter_ >> k) & 1; }
    void getF(int k) {
        if (flL[k] < 0) flL[k] = newLocal();
        if (!(wSoFar_ >> k & 1)) curR |= 1u << k;
        if (!(flWritten_ >> k & 1)) flRead_ |= 1u << k;
        lget(flL[k]);
    }
    void setF(int k) {      // valor no topo da pilha
        curW |= 1u << k; wSoFar_ |= 1u << k;
        if (!want(k)) { op(O_DROP); return; }
        if (flL[k] < 0) flL[k] = newLocal();
        lset(flL[k]);
        flWritten_ |= 1u << k; flDirty_ |= 1u << k;
    }

    // ---- decodificação
    bool hookAt(uint32_t p) {
        if (cpu.hooks_.empty() || (p >> 24) != 0xa0) return false;
        return cpu.hookMask_[(p & 0xffffff) >> 1] != 0;
    }
    Ins decode(uint32_t p) {
        Ins d{p, 0, 2, 2};
        uint32_t seg = p >> 24;
        if (!(seg == 0x80 || seg == 0xa0 || seg == 0x9e || seg == 0x9f) || (p & 1)) { d.kind = 2; return d; }
        if (p & 2) { d.kind = 0; d.w = bus.r16(p) & 0x7fff; d.len = 2; return d; }
        uint32_t w = bus.r32(p), lo = w & 0x7fff, hi = (w >> 16) & 0x7fff;
        if ((w >> 15) & 1) { d.kind = 1; d.w = (hi << 15) | lo; d.len = 4; }
        else if (w >> 31)  { d.kind = 2; d.w = w; d.len = 4; }
        else               { d.kind = 0; d.w = lo; d.len = 2; }
        return d;
    }

    // ---- blocos de construção
    void nz() {
        if (want(FN)) { lget(tR()); i32c(31); op(O_SHRU); setF(FN); }
        if (want(FZ)) { lget(tR()); op(O_EQZ); setF(FZ); }
        if (!want(FN)) { curW |= 1u << FN; wSoFar_ |= 1u << FN; }
        if (!want(FZ)) { curW |= 1u << FZ; wSoFar_ |= 1u << FZ; }
    }
    // finaliza uma operação lógica: valor no topo → tR (+N/Z se cu) → r[rD]
    void finLogic(int rD, bool cu) { lset(tR()); if (cu) nz(); lget(tR()); setR(rD); }

    // tA + tB (+C) → tR ; flags se cu
    void doAdd(bool cu, bool useC) {
        if (!useC) {
            lget(tA()); lget(tB()); op(O_ADD); lset(tR());
            if (cu) {
                nz();
                if (want(FC)) { lget(tR()); lget(tA()); op(O_LTU); setF(FC); } else { curW |= 1u << FC; wSoFar_ |= 1u << FC; }
            }
        } else {
            lget(tA()); op(O_EXT_U); lget(tB()); op(O_EXT_U); op(O_I64ADD); getF(FC); op(O_EXT_U); op(O_I64ADD);
            op(O_LTEE); w_.uleb(i64L());
            op(O_WRAP); lset(tR());
            if (cu) {
                nz();
                if (want(FC)) { lget_i64(); i64c(32); op(O_I64SHRU); op(O_WRAP); setF(FC); } else { curW |= 1u << FC; wSoFar_ |= 1u << FC; }
            } else {
                // i64 já foi consumido pelo tee/wrap
            }
        }
        if (cu) {
            if (want(FV)) {
                lget(tA()); lget(tB()); op(O_XOR); i32c(-1); op(O_XOR); lget(tA()); lget(tR()); op(O_XOR); op(O_AND); i32c(31); op(O_SHRU); setF(FV);
            } else { curW |= 1u << FV; wSoFar_ |= 1u << FV; }
        }
    }
    void lget_i64() { op(O_LGET); w_.uleb(i64L()); }

    // tA - tB (-borrow) → tR. useC: bw = 1 - C
    void doSub(bool cu, bool useC) {
        if (!useC) {
            lget(tA()); lget(tB()); op(O_SUB); lset(tR());
            if (cu) {
                nz();
                if (want(FC)) { lget(tA()); lget(tB()); op(O_GEU); setF(FC); } else { curW |= 1u << FC; wSoFar_ |= 1u << FC; }
            }
        } else {
            i32c(1); getF(FC); op(O_SUB); lset(tW());
            lget(tA()); lget(tB()); op(O_SUB); lget(tW()); op(O_SUB); lset(tR());
            if (cu) {
                nz();
                if (want(FC)) { lget(tA()); lget(tB()); lget(tW()); op(O_ADD); op(O_GEU); setF(FC); } else { curW |= 1u << FC; wSoFar_ |= 1u << FC; }
            }
        }
        if (cu) {
            if (want(FV)) {
                lget(tA()); lget(tB()); op(O_XOR); lget(tA()); lget(tR()); op(O_XOR); op(O_AND); i32c(31); op(O_SHRU); setF(FV);
            } else { curW |= 1u << FV; wSoFar_ |= 1u << FV; }
        }
    }

    // condição (0/1 na pilha)
    void cond(int c, bool cnt) {
        switch (c) {
            case 0: getF(FC); break;
            case 1: getF(FC); op(O_EQZ); break;
            case 2: getF(FC); getF(FZ); op(O_EQZ); op(O_AND); break;
            case 3: getF(FC); op(O_EQZ); getF(FZ); op(O_OR); break;
            case 4: getF(FZ); break;
            case 5: getF(FZ); op(O_EQZ); break;
            case 6: getF(FZ); op(O_EQZ); getF(FN); getF(FV); op(O_EQ); op(O_AND); break;
            case 7: getF(FZ); getF(FN); getF(FV); op(O_NE); op(O_OR); break;
            case 8: getF(FN); getF(FV); op(O_EQ); break;
            case 9: getF(FN); getF(FV); op(O_NE); break;
            case 10: getF(FN); break;
            case 11: getF(FN); op(O_EQZ); break;
            case 12: getF(FV); break;
            case 13: getF(FV); op(O_EQZ); break;
            case 14: {
                uint32_t a = addrOf(&cpu.sr[0]);
                i32c(0); mem(O_LD32, a); lset(tW());
                if (cnt) {
                    lget(tW()); op(O_IF); op(0x40);
                    i32c(0); lget(tW()); i32c(1); op(O_SUB); mem(O_ST32, a);
                    op(O_END);
                }
                lget(tW()); i32c(0); op(O_NE);
                break;
            }
            case 15: i32c(1); break;
            default: i32c(0); break;
        }
    }

    // ---- memória
    // endereço em tAddr
    void isRam() { lget(tAddr()); i32c(24); op(O_SHRU); i32c(0x20); op(O_OR); i32c(0xa0); op(O_EQ); }
    // kind: 0 lw, 1 lh(s), 2 lh(u), 3 lb(s), 6 lb(u)
    void emitLoad(int kind, int rD) {
        int sz = (kind == 0) ? 4 : (kind == 1 || kind == 2) ? 2 : 1;
        isRam();
        op(O_IF); op(0x7f);
        lget(tAddr()); i32c(0xffffff); op(O_AND);
        uint8_t lo = kind == 0 ? O_LD32 : kind == 1 ? O_LD16S : kind == 2 ? O_LD16U : kind == 3 ? O_LD8S : O_LD8U;
        mem(lo, addrOf(bus.ram()));
        op(O_ELSE);
        i32c((int32_t)addrOf(&J)); lget(tAddr()); i32c(sz); op(O_CALL); w_.uleb(F_IMPORT_RD);
        if (kind == 1) op(O_EXT16S); else if (kind == 3) op(O_EXT8S);
        op(O_END);
        setR(rD);
    }
    // valor em pushVal() ; kind: 4 sw, 5 sh, 7 sb
    template <typename F> void emitStore(int kind, F pushVal) {
        int sz = (kind == 4) ? 4 : (kind == 5) ? 2 : 1;
        i32c(0); lset(tHit());
        isRam();
        op(O_IF); op(0x40);
        lget(tAddr()); i32c(0xffffff); op(O_AND); ltee(tOff());
        pushVal();
        mem(kind == 4 ? O_ST32 : kind == 5 ? O_ST16 : O_ST8, addrOf(bus.ram()));
        const uint32_t fl = addrOf(bus.codeFlags());
        lget(tOff()); i32c(10); op(O_SHRU); mem(O_LD8U, fl);
        if (sz > 1) { lget(tOff()); i32c(sz - 1); op(O_ADD); i32c(10); op(O_SHRU); mem(O_LD8U, fl); op(O_OR); }
        lset(tHit());
        op(O_ELSE);
        i32c((int32_t)addrOf(&J)); lget(tAddr()); pushVal();
        if (sz == 1) { i32c(0xff); op(O_AND); } else if (sz == 2) { i32c(0xffff); op(O_AND); }
        i32c(sz); op(O_CALL); w_.uleb(F_IMPORT_WR);
        op(O_END);
    }
    // depois que a instrução inteira terminou: se escreveu em página com código, invalida e sai (k = nº de instruções feitas)
    void codeCheck(uint32_t nextPc, uint32_t k, int sz) {
        lget(tHit()); op(O_IF); op(0x40);
        i32c((int32_t)addrOf(&J)); lget(tOff()); i32c(sz); op(O_CALL); w_.uleb(F_IMPORT_INV);
        i32c((int32_t)nextPc); lset(tNext());
        storeDone(k);
        spillNow();
        lget(tNext()); op(O_RETURN);
        op(O_END);
        curR |= 0x1f;
    }

    void memOp(int kind, int rD, const Ins& d, size_t k, bool defer = false) {
        // endereço já em tAddr
        if (kind == 4 || kind == 5 || kind == 7) {
            emitStore(kind, [&] { getR(rD); });
            if (!defer) codeCheck(d.pc + d.len, (uint32_t)k, kind == 4 ? 4 : kind == 5 ? 2 : 1);
        } else {
            emitLoad(kind, rD);
        }
    }

    // ---- fallback para o interpretador (termina o bloco)
    bool fallback(const Ins& d) {
        spillNow();
        regDirty_ = 0; flDirty_ = 0;
        i32c((int32_t)addrOf(&J)); i32c((int32_t)d.pc); op(O_CALL); w_.uleb(F_IMPORT_INTERP); lset(tNext());
        curR = 0x1f;
        uint32_t key;
        if (d.kind == 1) { uint32_t o = d.w >> 25; key = 0x10000u | (o << 10) | (o == 0 ? (d.w & 0x3ff) : o == 6 ? (d.w & 0x3ff) : 0); }
        else if (d.kind == 0) key = 0x20000u | (((d.w >> 12) & 7) << 8) | ((d.w & 15) << 0) | ((((d.w >> 12) & 7) == 1 ? (d.w & 0xf0f) : 0) << 12);
        else key = 0x30000u;
        ++J.fallbackOps[key];
        return true;
    }

    void storeDone(uint32_t k) {
        i32c(0);
        if (loopMode_) { lget(accL_); i32c((int32_t)k); op(O_ADD); } else i32c((int32_t)k);
        mem(O_ST32, addrOf(&J.doneCell));
    }
    // desvio condicional de volta ao início do bloco: continua dentro do wasm enquanto couber no orçamento
    bool loopBranch(uint32_t target, uint32_t fall, uint32_t k) {
        curR |= 0x1f;
        lget(tC()); op(O_IF); op(0x40);
        lget(accL_); i32c((int32_t)k); op(O_ADD); lset(accL_);
        i32c((int32_t)target); lset(tNext());
        lget(accL_); i32c((int32_t)loopN_); op(O_ADD); lget(0); op(O_LEU);
        op(O_IF); op(0x40); op(0x0c); w_.uleb(2); op(O_END);
        op(O_ELSE);
        lget(accL_); i32c((int32_t)k); op(O_ADD); lset(accL_);
        i32c((int32_t)fall); lset(tNext());
        op(O_END);
        return true;
    }

    bool visited(uint32_t pc) const {
        if (pc == start_) return true;
        for (const Ins& i : ins) if (i.pc == pc) return true;
        return false;
    }
    // saída lateral: se tC != 0, grava link (opcional), contagem e devolve o alvo
    void sideExit(uint32_t target, uint32_t k, bool link, uint32_t linkVal) {
        lget(tC()); op(O_IF); op(0x40);
        spillNow();
        if (link) { i32c(0); i32c((int32_t)linkVal); mem(O_ST32, addrR(3)); }
        storeDone(k);
        i32c((int32_t)target); op(O_RETURN);
        op(O_END);
        curR |= 0x1f;
    }

    // saída condicional/incondicional: calcula próximo PC em tNext
    static bool simple16(uint32_t h) {
        const int op_ = (h >> 12) & 7, fn = h & 15;
        switch (op_) {
            case 0: return fn == 0 || fn == 1 || fn == 2 || fn == 3 || fn == 5 || fn == 8 || fn == 9 || fn == 10 || fn == 11;
            case 1: { uint32_t m = h & 0xf0f; return m == 0 || m == 1 || m == 0x100 || m == 0x101 || m == 2 || m == 3; }
            case 2: return true;
            case 5: return true;
            case 6: return (h & 7) != 2;
            case 7: { int kk = h & 7; return kk == 0 || kk == 4 || kk == 1 || kk == 5 || kk == 3 || kk == 7; }
            default: return false;     // saltos/desvios ficam de fora
        }
    }
    struct Snap { uint32_t rr, rw, rd, fr, fw, fd; uint8_t cr, cw, ws; };
    Snap snap() const { return {regRead_, regWritten_, regDirty_, flRead_, flWritten_, flDirty_, curR, curW, wSoFar_}; }
    void restore(const Snap& s) { regWritten_ = s.rw; regDirty_ = s.rd; flWritten_ = s.fw; flDirty_ = s.fd; curW = s.cw; wSoFar_ = s.ws; }

    // par "paralelo": executa a metade baixa se T, senão a alta (4 bytes, uma instrução)
    bool pair(const Ins& d, size_t k) {
        const uint32_t lo = d.w & 0x7fff, hi = (d.w >> 16) & 0x7fff;
        if ((g_jitDbg & 1) || !simple16(lo) || !simple16(hi) || (d.pc & 3)) return fallback(d);
        getF(FT); op(O_IF); op(0x40);
        Snap s0 = snap();
        Ins a{d.pc, lo, 4, 0};
        t16(a, k);
        Snap s1 = snap();
        restore(s0);
        op(O_ELSE);
        Ins b{d.pc, hi, 4, 0};
        t16(b, k);
        Snap s2 = snap();
        op(O_END);
        regRead_ |= s1.rr | s2.rr; flRead_ |= s1.fr | s2.fr;
        regWritten_ = s1.rw & s2.rw; flWritten_ = s1.fw & s2.fw;
        regDirty_ = s1.rd | s2.rd; flDirty_ = s1.fd | s2.fd;
        // escrito só em um dos ramos: o outro ramo precisa do valor de entrada no local (e o spill também)
        regRead_ |= regDirty_ & ~regWritten_; flRead_ |= flDirty_ & ~flWritten_;
        curR = s1.cr | s2.cr; curW = s1.cw & s2.cw; wSoFar_ = curW;
        return false;
    }

    bool one(const Ins& d, size_t k) {
        if (d.kind == 2) return ((d.w >> 31) && !(d.pc & 3) && d.len == 4 && !((d.w >> 15) & 1)) ? pair(d, k) : fallback(d);
        return d.kind == 1 ? t32(d, k) : t16(d, k);
    }

    bool t32(const Ins& d, size_t k) {
        const uint32_t P = d.w, pcVal = d.pc, nxt = d.pc + 4;
        const int op_ = (int)(P >> 25), rD = (P >> 20) & 31, rA = (P >> 15) & 31, rB = (P >> 10) & 31;
        const bool cu = (P & 1) != 0;
        auto AB = [&] { getR(rA); lset(tA()); getR(rB); lset(tB()); };
        switch (op_) {
            case 0: {
                uint32_t f = P & 0x3ff;
                const bool fu = f & 1;
                switch (f) {
                    case 0x000: case 0x002: case 0x004: case 0x006: case 0x00a: return false;
                    case 0x008: case 0x009: {
                        cond((P >> 10) & 15, true); lset(tC());
                        getR(rA); i32c((int32_t)nxt); lget(tC()); op(O_SELECT); lset(tNext());
                        if (f & 1) { i32c((int32_t)nxt); getR(3); lget(tC()); op(O_SELECT); setR(3); }
                        return true;
                    }
                    case 0x00c: getR(rA); lset(tAddr()); emitLoad(0, rD); return false;
                    case 0x00e: getR(rA); lset(tAddr()); memOp(4, rD, d, k); return false;
                    case 0x010: case 0x011: AB(); doAdd(fu, false); lget(tR()); setR(rD); return false;
                    case 0x012: case 0x013: AB(); doAdd(fu, true); lget(tR()); setR(rD); return false;
                    case 0x014: case 0x015: AB(); doSub(fu, false); lget(tR()); setR(rD); return false;
                    case 0x016: case 0x017: AB(); doSub(fu, true); lget(tR()); setR(rD); return false;
                    case 0x018: case 0x019: {
                        AB(); doSub(true, false);
                        int t = rD & 3;
                        if (t == 0) { lget(tA()); lget(tB()); op(O_EQ); setF(FT); }
                        else if (t == 1) { lget(tR()); i32c(31); op(O_SHRU); setF(FT); }
                        return false;
                    }
                    case 0x01a: case 0x01b: {
                        getR(rA); lset(tA()); i32c(0); lset(tB()); doSub(true, false);
                        int t = rD & 3;
                        if (t == 0) { lget(tA()); op(O_EQZ); setF(FT); }
                        else if (t == 1) { lget(tR()); i32c(31); op(O_SHRU); setF(FT); }
                        return false;
                    }
                    case 0x01e: case 0x01f: i32c(0); lset(tA()); getR(rB); lset(tB()); doSub(fu, false); lget(tR()); setR(rD); return false;
                    case 0x020: case 0x021: getR(rA); getR(rB); op(O_AND); finLogic(rD, fu); return false;
                    case 0x022: case 0x023: getR(rA); getR(rB); op(O_OR); finLogic(rD, fu); return false;
                    case 0x024: case 0x025: getR(rA); i32c(-1); op(O_XOR); finLogic(rD, fu); return false;
                    case 0x026: case 0x027: getR(rA); getR(rB); op(O_XOR); finLogic(rD, fu); return false;
                    case 0x029: getR(rA); i32c(~(1 << rB)); op(O_AND); finLogic(rD, true); return false;
                    case 0x02b: getR(rA); i32c(1 << rB); op(O_OR); finLogic(rD, true); return false;
                    case 0x02d: {
                        getR(rA); i32c(1 << rB); op(O_AND); lset(tR());
                        lget(tR()); op(O_EQZ); setF(FZ);
                        lget(tR()); i32c(31); op(O_SHRU); setF(FN);
                        return false;
                    }
                    case 0x02f: getR(rA); i32c(1 << rB); op(O_XOR); finLogic(rD, true); return false;
                    case 0x030: case 0x031: getR(rA); getR(rB); op(O_SHL); finLogic(rD, fu); return false;
                    case 0x034: case 0x035: getR(rA); getR(rB); op(O_SHRU); finLogic(rD, fu); return false;
                    case 0x036: case 0x037: getR(rA); getR(rB); op(O_SHRS); finLogic(rD, fu); return false;
                    case 0x038: case 0x039: getR(rA); getR(rB); op(O_ROTR); finLogic(rD, fu); return false;
                    case 0x03c: case 0x03d: getR(rA); getR(rB); op(O_ROTL); finLogic(rD, fu); return false;
                    case 0x040: case 0x041: case 0x042: {
                        getR(rA); op(f == 0x042 ? O_EXT_U : O_EXT_S); getR(rB); op(f == 0x042 ? O_EXT_U : O_EXT_S); op(O_I64MUL); ltee64();
                        op(O_DROP);
                        stCE();
                        return false;
                    }
                    case 0x044: {
                        AB();
                        lget(tB()); op(O_IF); op(0x40);
                        lget(tA()); i32c((int32_t)0x80000000u); op(O_EQ); lget(tB()); i32c(-1); op(O_EQ); op(O_AND);
                        op(O_IF); op(0x40);
                        i32c(0); i32c((int32_t)0x80000000u); mem(O_ST32, addrOf(&cpu.cel));
                        i32c(0); i32c(0); mem(O_ST32, addrOf(&cpu.ceh));
                        op(O_ELSE);
                        i32c(0); lget(tA()); lget(tB()); op(O_DIVS); mem(O_ST32, addrOf(&cpu.cel));
                        i32c(0); lget(tA()); lget(tB()); op(O_REMS); mem(O_ST32, addrOf(&cpu.ceh));
                        op(O_END);
                        op(O_END);
                        return false;
                    }
                    case 0x046: {
                        AB();
                        lget(tB()); op(O_IF); op(0x40);
                        i32c(0); lget(tA()); lget(tB()); op(O_DIVU); mem(O_ST32, addrOf(&cpu.cel));
                        i32c(0); lget(tA()); lget(tB()); op(O_REMU); mem(O_ST32, addrOf(&cpu.ceh));
                        op(O_END);
                        return false;
                    }
                    case 0x048: {
                        uint32_t s = P & 0x7c00;
                        if (s == 0x400) { i32c(0); mem(O_LD32, addrOf(&cpu.cel)); setR(rD); }
                        else if (s == 0x800) { i32c(0); mem(O_LD32, addrOf(&cpu.ceh)); setR(rD); }
                        else if (s == 0xc00) { i32c(0); mem(O_LD32, addrOf(&cpu.cel)); setR(rD); i32c(0); mem(O_LD32, addrOf(&cpu.ceh)); setR(rA); }
                        else return fallback(d);
                        return false;
                    }
                    case 0x04a: {
                        uint32_t s = P & 0x7c00;
                        if (s == 0x400) { i32c(0); getR(rD); mem(O_ST32, addrOf(&cpu.cel)); }
                        else if (s == 0x800) { i32c(0); getR(rD); mem(O_ST32, addrOf(&cpu.ceh)); }
                        else if (s == 0xc00) { i32c(0); getR(rD); mem(O_ST32, addrOf(&cpu.cel)); i32c(0); getR(rA); mem(O_ST32, addrOf(&cpu.ceh)); }
                        else return fallback(d);
                        return false;
                    }
                    case 0x050: i32c(0); mem(O_LD32, addrOf(&cpu.sr[rB])); setR(rD); return false;
                    case 0x052: i32c(0); getR(rA); mem(O_ST32, addrOf(&cpu.sr[rB])); return false;
                    case 0x054: cond((P >> 10) & 15, false); setF(FT); return false;
                    case 0x056: cond((P >> 10) & 15, false); lset(tC()); getR(rA); getR(rD); lget(tC()); op(O_SELECT); setR(rD); return false;
                    case 0x058: case 0x059: getR(rA); op(O_EXT8S); finLogic(rD, fu); return false;
                    case 0x05a: case 0x05b: getR(rA); op(O_EXT16S); finLogic(rD, fu); return false;
                    case 0x05c: case 0x05d: getR(rA); i32c(0xff); op(O_AND); finLogic(rD, fu); return false;
                    case 0x05e: case 0x05f: getR(rA); i32c(0xffff); op(O_AND); finLogic(rD, fu); return false;
                    case 0x070: case 0x071: getR(rA); i32c(rB); op(O_SHL); finLogic(rD, fu); return false;
                    case 0x074: case 0x075: getR(rA); i32c(rB); op(O_SHRU); finLogic(rD, fu); return false;
                    case 0x076: case 0x077: getR(rA); i32c(rB); op(O_SHRS); finLogic(rD, fu); return false;
                    case 0x078: case 0x079: getR(rA); i32c(rB); op(O_ROTR); finLogic(rD, fu); return false;
                    case 0x07c: case 0x07d: getR(rA); i32c(rB); op(O_ROTL); finLogic(rD, fu); return false;
                    default: return fallback(d);
                }
            }
            case 1: case 5: {
                int f3 = (P >> 17) & 7;
                uint32_t imm = (P >> 1) & 0xffff;
                int32_t s = (op_ == 5) ? (int32_t)(imm << 16) : sx((int32_t)imm, 16);
                uint32_t u = (op_ == 5) ? (imm << 16) : imm;
                switch (f3) {
                    case 0: getR(rD); lset(tA()); i32c(s); lset(tB()); doAdd(cu, false); lget(tR()); setR(rD); return false;
                    case 2: getR(rD); lset(tA()); i32c(s); lset(tB()); doSub(true, false); return false;
                    case 4: getR(rD); i32c((int32_t)u); op(O_AND); finLogic(rD, cu); return false;
                    case 5: getR(rD); i32c((int32_t)u); op(O_OR); finLogic(rD, cu); return false;
                    case 6: i32c(s); finLogic(rD, cu); return false;
                    default: return fallback(d);
                }
            }
            case 2: {
                const uint32_t tgt = (pcVal & 0xfe000000u) | (P & 0x01fffffeu);
                if (cu) { i32c((int32_t)nxt); setR(3); }
                if (!(g_jitDbg & 4) && !visited(tgt)) { follow_ = true; followPc_ = tgt; return false; }
                i32c((int32_t)tgt); lset(tNext());
                return true;
            }
            case 4: {
                int cc = (P >> 10) & 31;
                uint32_t t = pcVal + (uint32_t)sx((int32_t)((((P >> 15) & 0x3ff) << 10) | (P & 0x3fe)), 20);
                cond(cc, true); lset(tC());
                if (t == start_ && !cu) { if (loopMode_) return loopBranch(t, nxt, (uint32_t)k); sawLoop_ = true; }
                if (!(g_jitDbg & 4) && t > pcVal && !visited(t)) { sideExit(t, (uint32_t)k, cu, nxt); return false; }   // desvio para frente: segue pelo fall-through
                i32c((int32_t)t); i32c((int32_t)nxt); lget(tC()); op(O_SELECT); lset(tNext());
                if (cu) { i32c((int32_t)nxt); getR(3); lget(tC()); op(O_SELECT); setR(3); }
                return true;
            }
            case 8: getR(rA); lset(tA()); i32c(sx((int32_t)((P >> 1) & 0x3fff), 14)); lset(tB()); doAdd(cu, false); lget(tR()); setR(rD); return false;
            case 12: getR(rA); i32c((int32_t)((P >> 1) & 0x3fff)); op(O_AND); finLogic(rD, cu); return false;
            case 13: getR(rA); i32c((int32_t)((P >> 1) & 0x3fff)); op(O_OR); finLogic(rD, cu); return false;
            case 16: case 17: case 18: case 19: case 20: case 21: case 22: case 23:
                getR(rA); i32c(sx((int32_t)(P & 0x7fff), 15)); op(O_ADD); lset(tAddr());
                memOp(op_ & 7, rD, d, k);
                return false;
            case 3: case 7: {
                int32_t imm = sx((int32_t)((P >> 3) & 0xfff), 12);
                int kk = P & 7;
                if (op_ == 3) {
                    getR(rA); i32c(imm); op(O_ADD); ltee(tAddr()); setR(rA);
                    memOp(kk, rD, d, k);
                } else {
                    getR(rA); lset(tAddr());
                    memOp(kk, rD, d, k, true);
                    lget(tAddr()); i32c(imm); op(O_ADD); setR(rA);
                    if (kk == 4 || kk == 5 || kk == 7) codeCheck(d.pc + d.len, (uint32_t)k, kk == 4 ? 4 : kk == 5 ? 2 : 1);
                }
                return false;
            }
            case 24: return false;
            default: return fallback(d);
        }
    }

    void ltee64() { op(O_LTEE); w_.uleb(i64L()); }
    // i64 em local 0 → cel = low, ceh = high  (nada na pilha antes/depois)
    void stCE() {
        i32c(0); lget_i64(); op(O_WRAP); mem(O_ST32, addrOf(&cpu.cel));
        i32c(0); lget_i64(); i64c(32); op(O_I64SHRU); op(O_WRAP); mem(O_ST32, addrOf(&cpu.ceh));
    }

    bool t16(const Ins& d, size_t k) {
        const uint32_t h = d.w, pcVal = d.pc, nxt = d.pc + d.len;
        const int op_ = (h >> 12) & 7, rd = (h >> 8) & 15, ra = (h >> 4) & 15, fn = h & 15;
        switch (op_) {
            case 0:
                switch (fn) {
                    case 0: return false;
                    case 1: getR(16 + (ra & 15)); setR(rd); return false;
                    case 2: getR(ra); setR(16 + rd); return false;
                    case 3: getR(ra); setR(rd); return false;
                    case 4: cond(rd, true); lset(tC()); getR(ra); i32c((int32_t)nxt); lget(tC()); op(O_SELECT); lset(tNext()); return true;
                    case 5: cond(rd, false); setF(FT); return false;
                    case 8: getR(rd); getR(ra); op(O_SHL); finLogic(rd, true); return false;
                    case 9: getR(rd); lset(tA()); getR(ra); lset(tB()); doAdd(true, true); lget(tR()); setR(rd); return false;
                    case 10: getR(rd); getR(ra); op(O_SHRU); finLogic(rd, true); return false;
                    case 11: getR(rd); getR(ra); op(O_SHRS); finLogic(rd, true); return false;
                    case 12:
                        cond(rd, true); lset(tC());
                        getR(ra); i32c((int32_t)nxt); lget(tC()); op(O_SELECT); lset(tNext());
                        i32c((int32_t)nxt); getR(3); lget(tC()); op(O_SELECT); setR(3);
                        return true;
                    default: return fallback(d);
                }
            case 1:
                switch (h & 0xf0f) {
                    case 0x000: i32c(0); getR(ra); mem(O_ST32, addrOf(&cpu.cel)); return false;
                    case 0x001: i32c(0); mem(O_LD32, addrOf(&cpu.cel)); setR(ra); return false;
                    case 0x100: i32c(0); getR(ra); mem(O_ST32, addrOf(&cpu.ceh)); return false;
                    case 0x101: i32c(0); mem(O_LD32, addrOf(&cpu.ceh)); setR(ra); return false;
                    case 0x002: case 0x003: {
                        uint8_t e = fn == 3 ? O_EXT_U : O_EXT_S;
                        getR(rd); op(e); getR(ra); op(e); op(O_I64MUL); ltee64(); op(O_DROP);
                        stCE();
                        return false;
                    }
                    default: return fallback(d);
                }
            case 2:
                switch (fn) {
                    case 0: getR(rd); lset(tA()); getR(ra); lset(tB()); doAdd(true, false); lget(tR()); setR(rd); return false;
                    case 1: getR(rd); lset(tA()); getR(ra); lset(tB()); doSub(true, false); lget(tR()); setR(rd); return false;
                    case 2: i32c(0); lset(tA()); getR(ra); lset(tB()); doSub(true, false); lget(tR()); setR(rd); return false;
                    case 3: getR(rd); lset(tA()); getR(ra); lset(tB()); doSub(true, false); return false;
                    case 4: getR(rd); getR(ra); op(O_AND); finLogic(rd, true); return false;
                    case 5: getR(rd); getR(ra); op(O_OR); finLogic(rd, true); return false;
                    case 6: getR(ra); i32c(-1); op(O_XOR); finLogic(rd, true); return false;
                    case 7: getR(rd); getR(ra); op(O_XOR); finLogic(rd, true); return false;
                    case 8: getR(ra); lset(tAddr()); emitLoad(0, rd); return false;
                    case 9: getR(ra); lset(tAddr()); emitLoad(1, rd); return false;
                    case 11: getR(ra); lset(tAddr()); emitLoad(6, rd); return false;
                    case 12: getR(ra); lset(tAddr()); memOp(4, rd, d, k); return false;
                    case 13: getR(ra); lset(tAddr()); memOp(5, rd, d, k); return false;
                    case 15: getR(ra); lset(tAddr()); memOp(7, rd, d, k); return false;
                    case 10: case 14: {
                        bool hi = (h & 0x80) != 0;
                        int dd = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra;
                        if (fn == 14) {
                            getR(base); i32c(4); op(O_SUB); setR(base);
                            getR(base); lset(tAddr());
                            memOp(4, dd, d, k);
                        } else {
                            getR(base); lset(tAddr());
                            emitLoad(0, dd);
                            getR(base); i32c(4); op(O_ADD); setR(base);
                        }
                        return false;
                    }
                }
                return fallback(d);
            case 3: {
                const uint32_t tgt = (pcVal & 0xfffff000u) | (h & 0xffeu);
                if (h & 1) { i32c((int32_t)nxt); setR(3); }
                if (!(g_jitDbg & 4) && !visited(tgt)) { follow_ = true; followPc_ = tgt; return false; }
                i32c((int32_t)tgt); lset(tNext());
                return true;
            }
            case 4: {
                const uint32_t tgt = pcVal + (uint32_t)(sx((int32_t)(h & 0xff), 8) * 2);
                cond(rd, true); lset(tC());
                if (tgt == start_) { if (loopMode_) return loopBranch(tgt, nxt, (uint32_t)k); sawLoop_ = true; }
                if (!(g_jitDbg & 4) && tgt > pcVal && !visited(tgt)) { sideExit(tgt, (uint32_t)k, false, 0); return false; }
                i32c((int32_t)tgt); i32c((int32_t)nxt); lget(tC()); op(O_SELECT); lset(tNext());
                return true;
            }
            case 5: i32c((int32_t)(h & 0xff)); setR(rd); return false;
            case 6: {
                int f3 = h & 7, i5 = (h >> 3) & 31;
                if (f3 == 0) {
                    int i4 = (h >> 3) & 15;
                    getR(rd); lset(tA()); i32c(i4); lset(tB());
                    if (h & 0x80) doSub(true, false); else doAdd(true, false);
                    lget(tR()); setR(rd);
                }
                else if (f3 == 1) { getR(rd); i32c(i5); op(O_SHL); finLogic(rd, true); }
                else if (f3 == 3) { getR(rd); i32c(i5); op(O_SHRU); finLogic(rd, true); }
                else if (f3 == 4) { getR(rd); i32c(~(1 << i5)); op(O_AND); finLogic(rd, true); }
                else if (f3 == 5) { getR(rd); i32c(1 << i5); op(O_OR); finLogic(rd, true); }
                else if (f3 == 6) {
                    getR(rd); i32c(1 << i5); op(O_AND); lset(tR());
                    lget(tR()); op(O_EQZ); setF(FZ);
                    lget(tR()); i32c(31); op(O_SHRU); setF(FN);
                }
                else if (f3 == 7) { getR(rd); i32c(1 << i5); op(O_XOR); finLogic(rd, true); }
                else return fallback(d);
                return false;
            }
            case 7: {
                int i5 = (h >> 3) & 31, kk = h & 7;
                int kind, scale;
                switch (kk) {
                    case 0: kind = 0; scale = 2; break;
                    case 4: kind = 4; scale = 2; break;
                    case 1: kind = 1; scale = 1; break;
                    case 5: kind = 5; scale = 1; break;
                    case 3: kind = 6; scale = 0; break;
                    case 7: kind = 7; scale = 0; break;
                    default: return fallback(d);
                }
                getR(2); i32c(i5 << scale); op(O_ADD); lset(tAddr());
                memOp(kind, rd, d, k);
                return false;
            }
        }
        return fallback(d);
    }
};

// ------------------------------------------------------------------------------------------------------------------
// Jit
// ------------------------------------------------------------------------------------------------------------------
Jit::Jit(SCore7& cpu, Bus& bus) : cpu_(cpu), bus_(bus), hot_(65536, 0), pageBlocks_(16384 + 2) {
    enabled = sizeof(void*) == 4;
}

Jit::Block* Jit::findSlow(uint32_t pc) {
    auto it = byPc_.find(pc);
    if (it == byPc_.end()) return nullptr;
    FC& e = fc_[(pc >> 1) & (kFC - 1)];
    e.pc = pc; e.idx = it->second;
    return &blocks_[it->second];
}

void Jit::flush() {
    for (Block& b : blocks_) if (b.fn) { freeSlots_.push_back(b.fn); b.fn = 0; }
    byPc_.clear();
    for (auto& e : fc_) { e.pc = 1; e.idx = kNone; }
    std::fill(hot_.begin(), hot_.end(), 0);
    for (auto& v : pageBlocks_) v.clear();
    bus_.clearCodeFlags();
    blocks_.clear();
    bodies_.clear(); bodyIds_.clear(); bodyLoop_.clear();
    // módulo já enviado ao JS e ainda não instalado: seus ids deixam de valer (install confere o tamanho de blocks_)
    pendingIds_.clear(); pending_.clear();
    ++statInval;
}

void Jit::invalidateRange(uint32_t off, uint32_t len) {
    if (!len) return;
    invalidate(off >> 10, (off + len - 1) >> 10);
}

void Jit::invalidate(uint32_t lo, uint32_t hi) {
    if (hi >= pageBlocks_.size()) hi = (uint32_t)pageBlocks_.size() - 1;
    for (uint32_t pg = lo; pg <= hi; ++pg) {
        auto& v = pageBlocks_[pg];
        for (uint32_t id : v) {
            if (id >= blocks_.size()) continue;
            Block& b = blocks_[id];
            if (!b.valid) continue;
            b.valid = false; ++statInval;
            if (b.fn) { freeSlots_.push_back(b.fn); b.fn = 0; }
            auto it = byPc_.find(b.pc);
            if (it != byPc_.end() && it->second == id) byPc_.erase(it);
            FC& e = fc_[(b.pc >> 1) & (kFC - 1)];
            if (e.pc == b.pc) { e.pc = 1; e.idx = kNone; }
            hot_[(b.pc >> 1) & 0xffff] = 0;
        }
        v.clear();
        bus_.clearCodeFlag(pg);
    }
}

Jit::Block* Jit::translate(uint32_t start) {
    if (blocks_.size() > 100000) flush();      // código que se reescreve sem parar: recomeça em vez de acumular registros mortos
    uint32_t id = (uint32_t)blocks_.size();
    blocks_.emplace_back();
    blocks_[id].pc = start;
    byPc_[start] = id;
    FC& e = fc_[(start >> 1) & (kFC - 1)];
    e.pc = start; e.idx = id;
    hot_[(start >> 1) & 0xffff] = 0;

    std::vector<uint8_t> live;
    Tr t1(*this, cpu_, bus_);
    std::vector<uint32_t> savedFallbacks;
    t1.build(start, nullptr);
    if (t1.hookFirst || t1.ins.empty() || (t1.ins.size() == 1 && t1.ins[0].kind == 2)) return &blocks_[id];   // sem JIT: fica no interpretador
    // liveness
    size_t n = t1.ins.size();
    live.assign(n, 0x1f);
    uint8_t lv = 0x1f;
    if (!(g_jitDbg & 8)) for (size_t i = n; i-- > 0;) { live[i] = lv; lv = (uint8_t)((lv & ~t1.Wm[i]) | t1.Rm[i]); }
    Tr t2(*this, cpu_, bus_);
    const bool loop = !(g_jitDbg & 2) && t1.sawLoop() && t1.terminated && !t1.hookFirst;
    if (loop) t2.enableLoop((uint32_t)n, t1.dirtyR(), t1.dirtyF());
    t2.build(start, &live);
    // t1 e t2 contaram fallbacks duas vezes: desfaz a contagem do t1 (aproximação: só estatística)
    Block& b = blocks_[id];
    b.n = (uint32_t)t2.ins.size();
    b.ram = false; b.loop = loop;
    ++statBlocks; statInstrs += b.n;
    for (const Ins& di : t2.ins) {
        uint32_t sg = di.pc >> 24;
        if (sg != 0x80 && sg != 0xa0) continue;
        b.ram = true;
        uint32_t lo = (di.pc & 0xffffff) >> 10, hi = ((di.pc + di.len - 1) & 0xffffff) >> 10;
        for (uint32_t pg = lo; pg <= hi && pg < pageBlocks_.size(); ++pg) {
            auto& pv = pageBlocks_[pg];
            if (pv.empty() || pv.back() != id) pv.push_back(id);
            bus_.setCodeFlag(pg);
        }
    }
    bodies_.push_back(t2.finish());
    bodyIds_.push_back(id);
    bodyLoop_.push_back(loop);
#ifdef __wasm__
    // compilação síncrona (Node / Worker): o bloco vale já na próxima visita, sem esperar o fim do quadro
    if (sync && !inflight_) {
        buildModule();
        hs_jit_sync_cb(this);     // 0 = o loader não pode compilar síncrono este módulo: fica pendente e o caminho assíncrono assume
    }
#endif
    return &blocks_[id];
}

void Jit::maybeFinalize() {
    if (inflight_ || bodies_.empty()) return;
    ++age_;
    if (bodies_.size() >= 32 || age_ >= ageLimit) buildModule();
}

void Jit::buildModule() {
    age_ = 0;
    Buf m;
    const uint8_t hdr[] = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};
    m.b.assign(hdr, hdr + 8);
    auto section = [&](uint8_t id, const Buf& c) { m.u8(id); m.uleb((uint32_t)c.b.size()); m.append(c.b); };
    {   // tipos
        Buf s; s.uleb(6);
        s.u8(0x60); s.uleb(0); s.uleb(1); s.u8(0x7f);
        s.u8(0x60); s.uleb(3); s.u8(0x7f); s.u8(0x7f); s.u8(0x7f); s.uleb(1); s.u8(0x7f);
        s.u8(0x60); s.uleb(4); s.u8(0x7f); s.u8(0x7f); s.u8(0x7f); s.u8(0x7f); s.uleb(0);
        s.u8(0x60); s.uleb(3); s.u8(0x7f); s.u8(0x7f); s.u8(0x7f); s.uleb(0);
        s.u8(0x60); s.uleb(2); s.u8(0x7f); s.u8(0x7f); s.uleb(1); s.u8(0x7f);
        s.u8(0x60); s.uleb(1); s.u8(0x7f); s.uleb(1); s.u8(0x7f);       // tipo 5: bloco com laço (orçamento) -> próximo pc
        section(1, s);
    }
    {   // imports
        Buf s; s.uleb(5);
        auto name = [&](const char* n) { s.uleb((uint32_t)std::strlen(n)); for (const char* c = n; *c; ++c) s.u8((uint8_t)*c); };
        name("env"); name("mem"); s.u8(0x02); s.u8(0x00); s.uleb(1);
        name("env"); name("rd"); s.u8(0x00); s.uleb(1);
        name("env"); name("wr"); s.u8(0x00); s.uleb(2);
        name("env"); name("inv"); s.u8(0x00); s.uleb(3);
        name("env"); name("interp"); s.u8(0x00); s.uleb(4);
        section(2, s);
    }
    const uint32_t N = (uint32_t)bodies_.size();
    {   Buf s; s.uleb(N); for (uint32_t i = 0; i < N; ++i) s.uleb(bodyLoop_[i] ? 5 : 0); section(3, s); }
    {   Buf s; s.uleb(N);
        for (uint32_t i = 0; i < N; ++i) {
            char nm[16]; int l = std::snprintf(nm, sizeof nm, "b%u", i);
            s.uleb((uint32_t)l); for (int c = 0; c < l; ++c) s.u8((uint8_t)nm[c]);
            s.u8(0x00); s.uleb(F_IMPORTS + i);
        }
        section(7, s);
    }
    {   Buf s; s.uleb(N); for (auto& b : bodies_) s.append(b); section(10, s); }
    pending_ = std::move(m.b);
    pendingIds_ = std::move(bodyIds_);
    bodies_.clear(); bodyIds_.clear(); bodyLoop_.clear();
    inflight_ = true;
    ++statModules;
}

void Jit::install(uint32_t i, uint32_t tableIdx) {
    if (i >= pendingIds_.size()) return;
    uint32_t id = pendingIds_[i];
    if (id >= blocks_.size()) return;
    Block& b = blocks_[id];
    if (!b.valid) return;
    b.fn = tableIdx;
    ++statInstalled;
    if (tableIdx >= tableUsed_) tableUsed_ = tableIdx + 1;
}

void Jit::ack() { pending_.clear(); pendingIds_.clear(); inflight_ = false; }

void Jit::fail() { enabled = false; ack(); }

uint32_t Jit::rd(uint32_t a, uint32_t sz) { statIo += ((a >> 24) != 0xa0 && (a >> 24) != 0x80); return sz == 4 ? bus_.r32(a) : sz == 2 ? bus_.r16(a) : bus_.r8(a); }
void Jit::wr(uint32_t a, uint32_t v, uint32_t sz) { statIo += ((a >> 24) != 0xa0 && (a >> 24) != 0x80); if (sz == 4) bus_.w32(a, v); else if (sz == 2) bus_.w16(a, (uint16_t)v); else bus_.w8(a, (uint8_t)v); }
uint32_t Jit::interp(uint32_t pc) { return cpu_.interpretAt(pc); }

} // namespace hyperscan
