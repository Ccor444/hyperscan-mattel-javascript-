#include "SCore7.h"
#include "Bus.h"
#include "Jit.h"
#include <cstdint>
#include <cstdio>

namespace hyperscan {

static inline int32_t sx(int32_t v, int b) { int s = 32 - b; return (v << s) >> s; }
static inline int32_t i32add(int32_t a, int32_t b) { return (int32_t)((uint32_t)a + (uint32_t)b); }
static inline int32_t i32sub(int32_t a, int32_t b) { return (int32_t)((uint32_t)a - (uint32_t)b); }

// Instrução desconhecida: como o `throw UnknownOp` do JS, o PC e o contador de ciclos NÃO avançam (execOne confere error_code).
#define UNKNOWN(s) do { fail((s), pcVal, P); return nxt; } while (0)
#define UNKNOWN16(s) do { fail((s), pcVal, h); return nxt; } while (0)

// Ordem dos inicializadores casa com a ordem de declaração no header:
// hookMask_ (público, logo após hooks_) → bus_ (privado).
SCore7::SCore7(Bus& bus) : hookMask_(0x800000, 0), bus_(bus), jit_(new Jit(*this, bus)) {
    cr[29] = 0x20000000;
    bus_.setJit(jit_.get());
}
SCore7::~SCore7() { bus_.setJit(nullptr); }

// Igual ao reset() do JS: zera r/cr/flags/pc/cycles; sr, cel/ceh e `sleeping` não são tocados.
void SCore7::reset(uint32_t startPc) {
    r.fill(0); cr.fill(0);
    cr[29] = 0x20000000;
    N = Z = C = V = T = 0;
    pc = startPc; cycles = 0.0;
    error_code = 0; error_pc = 0; error_msg.clear();
}

void SCore7::fail(const char* what, uint32_t pcVal, uint32_t word) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "%s @%x P=%x", what, pcVal, word);
    error_code = 1; error_pc = pcVal; error_msg = buf;
}

void SCore7::addHook(uint32_t addr, HookFn fn, void* ctx) {
    hooks_.push_back({fn, ctx});
    uint32_t idx = (addr & 0xffffff) >> 1;
    if (idx < hookMask_.size()) hookMask_[idx] = (uint8_t)hooks_.size();
    jit_->flush();     // blocos já traduzidos podem cobrir este endereço
}

uint32_t SCore7::getCR(int i) const {
    if (i == 1) return (uint32_t)(V | (C << 1) | (Z << 2) | (N << 3) | (T << 4)) | (cr[1] & 0x3e0u);
    return cr[i];
}
void SCore7::setCR(int i, uint32_t v) {
    if (i == 1) { V = v & 1; C = (v >> 1) & 1; Z = (v >> 2) & 1; N = (v >> 3) & 1; T = (v >> 4) & 1; }
    cr[i] = v;
}
void SCore7::setNZ(uint32_t v) { N = v >> 31; Z = (v == 0) ? 1 : 0; }

int32_t SCore7::add(int32_t a, int32_t b, bool cu, int cin) {
    uint64_t full = (uint64_t)(uint32_t)a + (uint32_t)b + (uint32_t)cin;
    int32_t res = (int32_t)(uint32_t)full;
    if (cu) {
        setNZ((uint32_t)res);
        C = full > 0xffffffffull;
        V = (~((uint32_t)a ^ (uint32_t)b) & ((uint32_t)a ^ (uint32_t)res)) >> 31;
    }
    return res;
}
int32_t SCore7::sub(int32_t a, int32_t b, bool cu, int cin) {
    uint32_t ua = (uint32_t)a, ub = (uint32_t)b, bw = (uint32_t)(1 - cin);
    int32_t res = (int32_t)(ua - ub - bw);
    if (cu) {
        setNZ((uint32_t)res);
        C = ua >= ub + bw;
        V = ((ua ^ ub) & (ua ^ (uint32_t)res)) >> 31;
    }
    return res;
}
int32_t SCore7::logic(int32_t v, bool cu) { if (cu) setNZ((uint32_t)v); return v; }

bool SCore7::cond(int c, bool cnt) {
    switch (c) {
        case 0: return C == 1; case 1: return C == 0;
        case 2: return C == 1 && Z == 0; case 3: return C == 0 || Z == 1;
        case 4: return Z == 1; case 5: return Z == 0;
        case 6: return Z == 0 && N == V; case 7: return Z == 1 || N != V;
        case 8: return N == V; case 9: return N != V;
        case 10: return N == 1; case 11: return N == 0;
        case 12: return V == 1; case 13: return V == 0;
        case 14: { uint32_t n = sr[0]; if (cnt && n) sr[0] = n - 1; return n != 0; }
        case 15: return true;
    }
    return false;
}

void SCore7::exception(int code) {
    uint32_t f = getCR(1);
    cr[1] = (f & 0x1f) << 5;
    uint32_t psr = cr[0];
    cr[0] = (psr & ~0xfu) | ((psr & 1u) << 2) | ((psr & 2u) << 2);
    cr[2] = (cr[2] & ~0x00fc0000u) | ((uint32_t)(code & 0x3f) << 18);
    cr[5] = pc;
    pc = cr[3] + (uint32_t)code * 4;
    sleeping = false;
}
bool SCore7::interrupt(int src) {
    if (!(cr[0] & 1)) return false;
    exception((63 - src) + 128);
    return true;
}
uint32_t SCore7::rte() {
    uint32_t psr = cr[0];
    cr[0] = (psr & ~0x3u) | ((psr >> 2) & 1u) | (((psr >> 3) & 1u) << 1);
    uint32_t f = cr[1], c = (f >> 5) & 0x1f;
    V = c & 1; C = (c >> 1) & 1; Z = (c >> 2) & 1; N = (c >> 3) & 1; T = (c >> 4) & 1;
    return cr[5];
}

void SCore7::mem(int kind, int rD, uint32_t addr) {
    switch (kind) {
        case 0: r[rD] = (int32_t)bus_.r32(addr); break;
        case 1: r[rD] = (int32_t)(int16_t)bus_.r16(addr); break;
        case 2: r[rD] = (int32_t)bus_.r16(addr); break;
        case 3: r[rD] = (int32_t)(int8_t)bus_.r8(addr); break;
        case 4: bus_.w32(addr, (uint32_t)r[rD]); break;
        case 5: bus_.w16(addr, (uint16_t)r[rD]); break;
        case 6: r[rD] = (int32_t)bus_.r8(addr); break;
        case 7: bus_.w8(addr, (uint8_t)r[rD]); break;
    }
}

uint32_t SCore7::exec32(uint32_t P, uint32_t pcVal, uint32_t nxt) {
    const int op = (int)(P >> 25);
    const int rD = (P >> 20) & 31;
    const int rA = (P >> 15) & 31;
    const int rB = (P >> 10) & 31;
    const bool cu = (P & 1) != 0;
    switch (op) {
        case 0: {
            uint32_t f = P & 0x3ff;
            int32_t a = r[rA], bb = r[rB];
            switch (f) {
                case 0x000: case 0x002: case 0x004: case 0x006: case 0x00a: break;
                case 0x008: case 0x009: if (cond((P >> 10) & 15, true)) { if (f & 1) r[3] = (int32_t)nxt; nxt = (uint32_t)a; } break;
                case 0x00c: r[rD] = (int32_t)bus_.r32((uint32_t)a); break;
                case 0x00e: bus_.w32((uint32_t)a, (uint32_t)r[rD]); break;
                case 0x010: case 0x011: r[rD] = add(a, bb, f & 1); break;
                case 0x012: case 0x013: r[rD] = add(a, bb, f & 1, C); break;
                case 0x014: case 0x015: r[rD] = sub(a, bb, f & 1); break;
                case 0x016: case 0x017: r[rD] = sub(a, bb, f & 1, C); break;
                case 0x018: case 0x019: { sub(a, bb, true); int t = rD & 3; if (t == 0) T = (a == bb); else if (t == 1) T = N; break; }
                case 0x01a: case 0x01b: { sub(a, 0, true); int t = rD & 3; if (t == 0) T = (a == 0); else if (t == 1) T = N; break; }
                case 0x01e: case 0x01f: r[rD] = sub(0, bb, f & 1); break;
                case 0x020: case 0x021: r[rD] = logic(a & bb, f & 1); break;
                case 0x022: case 0x023: r[rD] = logic(a | bb, f & 1); break;
                case 0x024: case 0x025: r[rD] = logic(~a, f & 1); break;
                case 0x026: case 0x027: r[rD] = logic(a ^ bb, f & 1); break;
                case 0x029: r[rD] = logic(a & ~(1 << rB), true); break;
                case 0x02b: r[rD] = logic(a | (1 << rB), true); break;
                case 0x02d: { int32_t t = a & (1 << rB); Z = t ? 0 : 1; N = ((uint32_t)t) >> 31; break; }
                case 0x02f: r[rD] = logic(a ^ (1 << rB), true); break;
                case 0x030: case 0x031: r[rD] = logic(a << (bb & 31), f & 1); break;
                case 0x034: case 0x035: r[rD] = logic((int32_t)((uint32_t)a >> (bb & 31)), f & 1); break;
                case 0x036: case 0x037: r[rD] = logic(a >> (bb & 31), f & 1); break;
                case 0x038: case 0x039: { int s = bb & 31; uint32_t u = (uint32_t)a; r[rD] = logic((int32_t)(s ? ((u >> s) | (u << (32 - s))) : u), f & 1); break; }
                case 0x03c: case 0x03d: { int s = bb & 31; uint32_t u = (uint32_t)a; r[rD] = logic((int32_t)(s ? ((u << s) | (u >> (32 - s))) : u), f & 1); break; }
                case 0x040: case 0x041: { int64_t t = (int64_t)a * (int64_t)bb; cel = (uint32_t)t; ceh = (uint32_t)((uint64_t)t >> 32); break; }
                case 0x042: { uint64_t t = (uint64_t)(uint32_t)a * (uint64_t)(uint32_t)bb; cel = (uint32_t)t; ceh = (uint32_t)(t >> 32); break; }
                case 0x044: if (bb) { if (a == INT32_MIN && bb == -1) { cel = (uint32_t)INT32_MIN; ceh = 0; } else { cel = (uint32_t)(a / bb); ceh = (uint32_t)(a % bb); } } break;
                case 0x046: if (bb) { uint32_t ua = (uint32_t)a, ub = (uint32_t)bb; cel = ua / ub; ceh = ua % ub; } break;
                case 0x048: { uint32_t s = P & 0x7c00; if (s == 0x400) r[rD] = (int32_t)cel; else if (s == 0x800) r[rD] = (int32_t)ceh; else if (s == 0xc00) { r[rD] = (int32_t)cel; r[rA] = (int32_t)ceh; } else UNKNOWN("mfce"); break; }
                case 0x04a: { uint32_t s = P & 0x7c00; if (s == 0x400) cel = (uint32_t)r[rD]; else if (s == 0x800) ceh = (uint32_t)r[rD]; else if (s == 0xc00) { cel = (uint32_t)r[rD]; ceh = (uint32_t)r[rA]; } else UNKNOWN("mtce"); break; }
                case 0x050: r[rD] = (int32_t)sr[rB]; break;
                case 0x052: sr[rB] = (uint32_t)a; break;
                case 0x054: T = cond((P >> 10) & 15); break;
                case 0x056: if (cond((P >> 10) & 15)) r[rD] = a; break;
                case 0x058: case 0x059: r[rD] = logic((a << 24) >> 24, f & 1); break;
                case 0x05a: case 0x05b: r[rD] = logic((a << 16) >> 16, f & 1); break;
                case 0x05c: case 0x05d: r[rD] = logic((int32_t)((uint32_t)a & 0xff), f & 1); break;
                case 0x05e: case 0x05f: r[rD] = logic((int32_t)((uint32_t)a & 0xffff), f & 1); break;
                case 0x070: case 0x071: r[rD] = logic(a << rB, f & 1); break;
                case 0x074: case 0x075: r[rD] = logic((int32_t)((uint32_t)a >> rB), f & 1); break;
                case 0x076: case 0x077: r[rD] = logic(a >> rB, f & 1); break;
                case 0x078: case 0x079: { uint32_t s = rB & 31, u = (uint32_t)a; r[rD] = logic((int32_t)(s ? ((u >> s) | (u << (32 - s))) : u), f & 1); break; }
                case 0x07c: case 0x07d: { uint32_t s = rB & 31, u = (uint32_t)a; r[rD] = logic((int32_t)(s ? ((u << s) | (u >> (32 - s))) : u), f & 1); break; }
                default: UNKNOWN("op0");
            }
            break;
        }
        case 1: case 5: {
            int f3 = (P >> 17) & 7;
            uint32_t imm = (P >> 1) & 0xffff;
            int32_t s = (op == 5) ? (int32_t)(imm << 16) : sx((int32_t)imm, 16);
            uint32_t u = (op == 5) ? (imm << 16) : imm;
            switch (f3) {
                case 0: r[rD] = add(r[rD], s, cu); break;
                case 2: sub(r[rD], s, true); break;
                case 4: r[rD] = logic(r[rD] & (int32_t)u, cu); break;
                case 5: r[rD] = logic(r[rD] | (int32_t)u, cu); break;
                case 6: r[rD] = logic(s, cu); break;
                default: UNKNOWN("op1/5");
            }
            break;
        }
        case 2: if (cu) r[3] = (int32_t)nxt; nxt = (pcVal & 0xfe000000u) | (P & 0x01fffffeu); break;
        case 4: {
            int cc = (P >> 10) & 31;
            uint32_t t = pcVal + (uint32_t)sx((int32_t)((((P >> 15) & 0x3ff) << 10) | (P & 0x3fe)), 20);
            if (cond(cc, true)) { if (cu) r[3] = (int32_t)nxt; nxt = t; }
            break;
        }
        case 8:  r[rD] = add(r[rA], sx((int32_t)((P >> 1) & 0x3fff), 14), cu); break;
        case 12: r[rD] = logic(r[rA] & (int32_t)((P >> 1) & 0x3fff), cu); break;
        case 13: r[rD] = logic(r[rA] | (int32_t)((P >> 1) & 0x3fff), cu); break;
        case 16: case 17: case 18: case 19: case 20: case 21: case 22: case 23:
            mem(op & 7, rD, (uint32_t)(r[rA] + sx((int32_t)(P & 0x7fff), 15)));
            break;
        case 3: case 7: {
            int32_t imm = sx((int32_t)((P >> 3) & 0xfff), 12);
            int k = P & 7;
            if (op == 3) { int32_t a = i32add(r[rA], imm); r[rA] = a; mem(k, rD, (uint32_t)a); }
            else { uint32_t a = (uint32_t)r[rA]; mem(k, rD, a); r[rA] = i32add((int32_t)a, imm); }
            break;
        }
        case 6: {
            uint32_t f5 = P & 0x1f;
            if (f5 == 0) setCR(rA, (uint32_t)r[rD]);
            else if (f5 == 1) r[rD] = (int32_t)getCR(rA);
            else if ((P & 0x3ff) == 0x0c4) {}
            else if ((P & 0x3ff) == 0x084 || (P & 0x3ff) == 0x0a4) nxt = rte();
            else UNKNOWN("op6");
            break;
        }
        case 24: break;
        default: UNKNOWN("op32");
    }
    return nxt;
}

uint32_t SCore7::exec16(uint16_t h, uint32_t pcVal, uint32_t nxt) {
    int op = (h >> 12) & 7, rd = (h >> 8) & 15, ra = (h >> 4) & 15, fn = h & 15;
    switch (op) {
        case 0: switch (fn) {
            case 0: break;
            case 1: r[rd] = r[16 + (ra & 15)]; break;
            case 2: r[16 + rd] = r[ra]; break;
            case 3: r[rd] = r[ra]; break;
            case 4: if (cond(rd, true)) nxt = (uint32_t)r[ra]; break;
            case 5: T = cond(rd); break;
            case 8: r[rd] = logic(r[rd] << (r[ra] & 31), true); break;
            case 9: r[rd] = add(r[rd], r[ra], true, C); break;
            case 10: r[rd] = logic((int32_t)((uint32_t)r[rd] >> (r[ra] & 31)), true); break;
            case 11: r[rd] = logic(r[rd] >> (r[ra] & 31), true); break;
            case 12: if (cond(rd, true)) { r[3] = (int32_t)nxt; nxt = (uint32_t)r[ra]; } break;
            default: UNKNOWN16("op16/0");
        } break;
        case 1: switch (h & 0xf0f) {
            case 0x000: cel = (uint32_t)r[ra]; break;
            case 0x001: r[ra] = (int32_t)cel; break;
            case 0x100: ceh = (uint32_t)r[ra]; break;
            case 0x101: r[ra] = (int32_t)ceh; break;
            case 0x002: case 0x003: {
                bool u = fn == 3;
                uint64_t t = u ? (uint64_t)(uint32_t)r[rd] * (uint64_t)(uint32_t)r[ra]
                               : (uint64_t)((int64_t)r[rd] * (int64_t)r[ra]);
                cel = (uint32_t)t; ceh = (uint32_t)(t >> 32); break;
            }
            default: UNKNOWN16("op16/1");
        } break;
        case 2: {
            uint32_t a = (uint32_t)r[ra];
            switch (fn) {
                case 0: r[rd] = add(r[rd], r[ra], true); break;
                case 1: r[rd] = sub(r[rd], r[ra], true); break;
                case 2: r[rd] = sub(0, r[ra], true); break;
                case 3: sub(r[rd], r[ra], true); break;
                case 4: r[rd] = logic(r[rd] & r[ra], true); break;
                case 5: r[rd] = logic(r[rd] | r[ra], true); break;
                case 6: r[rd] = logic(~r[ra], true); break;
                case 7: r[rd] = logic(r[rd] ^ r[ra], true); break;
                case 8: r[rd] = (int32_t)bus_.r32(a); break;
                case 9: r[rd] = (int32_t)(int16_t)bus_.r16(a); break;
                case 11: r[rd] = (int32_t)bus_.r8(a); break;
                case 12: bus_.w32(a, (uint32_t)r[rd]); break;
                case 13: bus_.w16(a, (uint16_t)r[rd]); break;
                case 15: bus_.w8(a, (uint8_t)r[rd]); break;
                case 10: case 14: {
                    bool hi = (h & 0x80) != 0;
                    int d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra;
                    if (fn == 14) { r[base] = i32sub(r[base], 4); bus_.w32((uint32_t)r[base], (uint32_t)r[d]); }
                    else { r[d] = (int32_t)bus_.r32((uint32_t)r[base]); r[base] = i32add(r[base], 4); }
                    break;
                }
            }
            break;
        }
        case 3: if (h & 1) r[3] = (int32_t)nxt; nxt = (pcVal & 0xfffff000u) | (h & 0xffeu); break;
        case 4: if (cond(rd, true)) nxt = pcVal + (uint32_t)(sx((int32_t)(h & 0xff), 8) * 2); break;
        case 5: r[rd] = (int32_t)(h & 0xff); break;
        case 6: {
            int f3 = h & 7, i5 = (h >> 3) & 31;
            if ((h & 7) == 0) { int i4 = (h >> 3) & 15; r[rd] = (h & 0x80) ? sub(r[rd], i4, true) : add(r[rd], i4, true); }
            else if (f3 == 1) r[rd] = logic(r[rd] << i5, true);
            else if (f3 == 3) r[rd] = logic((int32_t)((uint32_t)r[rd] >> i5), true);
            else if (f3 == 4) r[rd] = logic(r[rd] & ~(1 << i5), true);
            else if (f3 == 5) r[rd] = logic(r[rd] | (1 << i5), true);
            else if (f3 == 6) { int32_t t = r[rd] & (1 << i5); Z = t ? 0 : 1; N = ((uint32_t)t) >> 31; }
            else if (f3 == 7) r[rd] = logic(r[rd] ^ (1 << i5), true);
            else UNKNOWN16("op16/6");
            break;
        }
        case 7: {
            int i5 = (h >> 3) & 31, k = h & 7; uint32_t base = (uint32_t)r[2];
            switch (k) {
                case 0: r[rd] = (int32_t)bus_.r32(base + (i5 << 2)); break;
                case 4: bus_.w32(base + (i5 << 2), (uint32_t)r[rd]); break;
                case 1: r[rd] = (int32_t)(int16_t)bus_.r16(base + (i5 << 1)); break;
                case 5: bus_.w16(base + (i5 << 1), (uint16_t)r[rd]); break;
                case 3: r[rd] = (int32_t)bus_.r8(base + i5); break;
                case 7: bus_.w8(base + i5, (uint8_t)r[rd]); break;
                default: UNKNOWN16("op16/7");
            }
            break;
        }
    }
    return nxt;
}

// Decodifica e executa a instrução em pcVal; devolve o próximo PC (em caso de erro, error_code != 0 e o retorno não vale).
inline uint32_t SCore7::execAt(uint32_t pcVal) {
    if (pcVal & 2) return exec16((uint16_t)(bus_.r16(pcVal) & 0x7fff), pcVal, pcVal + 2);
    uint32_t w = bus_.r32(pcVal);
    uint32_t lo = w & 0x7fff, hi = (w >> 16) & 0x7fff;
    if ((w >> 15) & 1) return exec32((hi << 15) | lo, pcVal, pcVal + 4);
    if (w >> 31)       return exec16((uint16_t)(T ? lo : hi), pcVal, pcVal + 4);   // par "paralelo": executa low se T, senão high
    return exec16((uint16_t)lo, pcVal, pcVal + 2);
}

void SCore7::execOne(uint32_t pcVal) {
    uint32_t next = execAt(pcVal);
    if (error_code) return;      // instrução desconhecida: PC e ciclos ficam como estavam
    pc = next;
    cycles += 1.0;
}

uint32_t SCore7::interpretAt(uint32_t p) { return execAt(p); }

// PC e contador de instruções ficam em locais durante o laço e só voltam aos membros antes de um hook, de um erro e no fim.
// Com o JIT ligado, nos alvos de desvio procura-se um bloco traduzido; ele só entra se couber no orçamento restante (contagem exata).
void SCore7::runN(uint64_t n) {
    const bool anyHook = !hooks_.empty();
    const uint8_t* hm = hookMask_.data();
    Jit& J = *jit_;
    const bool useJit = J.enabled;
    uint32_t p = pc;
    uint64_t done = 0, synced = 0;
    bool target = true;
    while (done < n) {
        Jit::Block* b = nullptr;
        if (useJit && target) {
            b = J.find(p);
            // bloco instalado => não há hook em p (blocos em endereços com hook nunca são instalados; addHook descarta tudo)
            if (b && b->fn && b->n <= n - done) {
                const uint32_t bn = b->n; ++b->hits;
                uint32_t next = b->loop ? reinterpret_cast<uint32_t (*)(uint32_t)>((uintptr_t)b->fn)((uint32_t)(n - done))
                                        : reinterpret_cast<uint32_t (*)()>((uintptr_t)b->fn)();
                uint32_t d = J.doneCell;
                if (d) J.doneCell = 0; else d = bn;
                if (__builtin_expect(error_code != 0, 0)) { done += bn - 1; pc = error_pc; cycles += (double)(done - synced); return; }
                done += d; p = next; J.statJitIns += d;
                continue;
            }
        }
        if (anyHook && (p >> 24) == 0xa0) {
            uint8_t h = hm[(p & 0xffffff) >> 1];
            if (h) {
                pc = p; cycles += (double)(done - synced); synced = done;
                auto& e = hooks_[h - 1];
                bool handled = e.fn(*this, e.ctx);
                p = pc;
                target = true;
                if (handled) { ++done; cycles += 1.0; ++synced; continue; }
                b = nullptr;
                if (useJit) b = J.find(p);
            }
        }
        if (useJit && target && !b && J.touch(p) && (p >> 24) != 0x08 && (p >> 24) != 0x88) J.translate(p);
        if (J.profile) ++J.hist[p];
        uint32_t next = execAt(p);
        if (error_code) { pc = p; cycles += (double)(done - synced); return; }
        uint32_t dd = next - p;
        target = (dd != 2 && dd != 4);
        p = next; ++done;
    }
    pc = p; cycles += (double)(done - synced);
}

void SCore7::step() { runN(1); }

} // namespace hyperscan
