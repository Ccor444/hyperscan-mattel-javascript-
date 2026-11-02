// Save states (porta de src/savestate.js): estado completo da máquina em um único buffer binário.
// Salvo: CPU (registradores, PC, ciclos, flags), RAM, periféricos (IO, timers, PPU, I2C, pad), SPU (canais, FIFO, anel) e servo.
// Não salvo (reconstruídos): hooks de HLE, disco, BIOS e cartão virtual (a página carrega de novo).
// Formato: "HSST" | versão u32 | payload | FNV-1a(payload) u32. O mesmo código percorre os campos na gravação e na leitura,
// então os dois lados não saem de sincronia. A página comprime o resultado com gzip (a RAM é quase toda zeros).
#include "HyperScan.h"
#include "Jit.h"
#include "SPU.h"
#include <cstring>
#include <type_traits>

namespace hyperscan {

namespace {

constexpr uint32_t VERSION = 2;

struct Ar {
    bool writing;
    std::vector<uint8_t>* out = nullptr;
    const uint8_t* in = nullptr;
    size_t len = 0, pos = 0;
    bool ok = true;

    void raw(void* p, size_t n) {
        if (!ok) return;
        if (writing) { const uint8_t* b = (const uint8_t*)p; out->insert(out->end(), b, b + n); }
        else {
            if (n > len - pos) { ok = false; return; }
            std::memcpy(p, in + pos, n); pos += n;
        }
    }
    template <class T> void v(T& x) {
        static_assert(std::is_trivially_copyable<T>::value, "");
        raw(&x, sizeof(T));
    }
    void b(bool& x) { uint8_t t = x ? 1 : 0; v(t); x = t != 0; }
    template <class T, size_t N> void arr(std::array<T, N>& a) { raw(a.data(), sizeof(T) * N); }
    template <class T> void vec(std::vector<T>& a) { raw(a.data(), sizeof(T) * a.size()); }
    // vetor esparso (só entradas != 0)
    void sparse(std::vector<uint32_t>& a) {
        if (writing) {
            uint32_t n = 0; for (uint32_t x : a) if (x) ++n;
            v(n);
            for (uint32_t i = 0; i < a.size(); ++i) if (a[i]) { uint32_t k = i, x = a[i]; v(k); v(x); }
        } else {
            uint32_t n = 0; v(n);
            std::fill(a.begin(), a.end(), 0u);
            for (uint32_t j = 0; j < n && ok; ++j) { uint32_t k = 0, x = 0; v(k); v(x); if (ok && k < a.size()) a[k] = x; }
        }
    }
    template <class M> void map(M& m) {
        if (writing) {
            uint32_t n = (uint32_t)m.size(); v(n);
            for (auto& kv : m) { auto k = kv.first; auto x = kv.second; v(k); v(x); }
        } else {
            uint32_t n = 0; v(n); m.clear();
            for (uint32_t j = 0; j < n && ok; ++j) { typename M::key_type k{}; typename M::mapped_type x{}; v(k); v(x); if (ok) m[k] = x; }
        }
    }
    void str(std::string& s) {
        uint32_t n = (uint32_t)s.size(); v(n);
        if (writing) raw(s.data(), n);
        else { if (!ok || n > len - pos) { ok = false; return; } s.assign((const char*)in + pos, n); pos += n; }
    }
};

uint32_t fnv1a(const uint8_t* p, size_t n) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 16777619u; }
    return h;
}

void walk(Ar& ar, HyperScan& m) {
    SCore7& c = m.cpu_;
    IO& io = m.io_;
    SPU& spu = *io.spuChip;
    Servo& sv = io.servo;

    // CPU
    ar.arr(c.r); ar.arr(c.cr); ar.arr(c.sr);
    ar.v(c.cel); ar.v(c.ceh); ar.v(c.N); ar.v(c.Z); ar.v(c.C); ar.v(c.V); ar.v(c.T);
    ar.v(c.pc); ar.v(c.cycles); ar.b(c.sleeping);

    // RAM
    uint32_t ramLen = (uint32_t)m.bus_.ramSize(); ar.v(ramLen);
    if (!ar.writing && ramLen != m.bus_.ramSize()) { ar.ok = false; return; }
    ar.raw(m.bus_.ram(), ramLen);

    // IO
    ar.v(io.tveCtl); ar.v(io.tveFade); for (int i = 0; i < 3; ++i) ar.v(io.tvAddr[i]); ar.v(io.bufctl);
    ar.v(io.timerDiv);
    ar.arr(io.asserted); ar.arr(io.mask);
    ar.sparse(io.ppu); ar.v(io.ppuCtrl); ar.v(io.ppuStatus);
    for (auto& T : io.timers) { ar.v(T.ctrl); ar.v(T.ccp); ar.v(T.preload); ar.v(T.up); ar.v(T.rate); ar.b(T.wasEn); }
    ar.v(io.frameCycles); ar.v(io.frameLen); ar.v(io.rasterLines); ar.v(io.rasterVis); ar.v(io.vblankLines); ar.v(io.frames);
    ar.v(io.beat.en); ar.v(io.beat.sts); ar.v(io.beat.base); ar.v(io.beat.cnt); ar.v(io.beat.acc);
    ar.v(io.i2c.cr); ar.v(io.i2c.intr); ar.v(io.i2c.cvr); ar.v(io.i2c.id); ar.v(io.i2c.addr);
    ar.v(io.i2c.wdata); ar.v(io.i2c.rdata); ar.v(io.i2c.start); ar.v(io.i2c.busy);
    for (auto& p : io.padIn) ar.arr(p);
    for (auto& p : io.padLatch) ar.arr(p);
    ar.v(io._audioAcc);

    // SPU
    ar.sparse(spu.regs);
    for (auto& C : spu.ch) {
        ar.b(C.active); ar.v(C.waddr); ar.v(C.loop); ar.v(C.tone); ar.v(C.kind); ar.v(C.phaseAcc); ar.v(C.wp); ar.v(C.bp);
        ar.v(C.shift); ar.v(C.nib); ar.v(C.sig); ar.v(C.stepIdx); ar.v(C.hdr); ar.v(C.rem);
        ar.v(C.p0); ar.v(C.last); ar.v(C.prev); ar.v(C.acc); ar.v(C.envClk); ar.v(C.envAddr); ar.v(C.envAcc);
        ar.v(C.started); ar.v(C.samples);
    }
    ar.vec(spu.ring);
    ar.v(spu.rd); ar.v(spu.wr); ar.v(spu.count); ar.v(spu.pos);
    ar.v(spu.underruns); ar.v(spu.underrunRuns); ar.b(spu._underrunActive); ar.v(spu.holdL); ar.v(spu.holdR);
    ar.v(spu.done); ar.v(spu.mameAcc); ar.v(spu.frameAcc);
    ar.v(spu.xl); ar.v(spu.xr); ar.v(spu.yl); ar.v(spu.yr);
    ar.vec(spu.fifo);
    ar.v(spu.fHead); ar.v(spu.fTail); ar.v(spu.fFrac); ar.b(spu.dmaOn); ar.b(spu.dacStereo); ar.v(spu.dmaHalf);
    ar.v(spu.dmaLeft); ar.v(spu.halfFrames); ar.v(spu.dacRate);
    ar.v(spu.waveIn[0]); ar.v(spu.waveIn[1]);
    ar.v(spu.peak); ar.v(spu.samplesOut); ar.v(spu.starts); ar.b(spu.muted);

    // servo
    ar.arr(sv.reg); ar.v(sv.addr); ar.v(sv.data); ar.v(sv.ctrl);
    ar.vec(sv.im); ar.vec(sv.pm);
    ar.map(sv.other);

    // UART
    ar.str(m.uart_);
}

} // namespace

size_t HyperScan::saveState() {
    std::vector<uint8_t>& out = saveState_;
    out.clear();
    out.reserve(bus_.ramSize() + (3u << 20));
    const char magic[4] = {'H', 'S', 'S', 'T'};
    out.insert(out.end(), magic, magic + 4);
    uint32_t ver = VERSION;
    out.insert(out.end(), (const uint8_t*)&ver, (const uint8_t*)&ver + 4);
    size_t start = out.size();
    Ar ar; ar.writing = true; ar.out = &out;
    walk(ar, *this);
    uint32_t sum = fnv1a(out.data() + start, out.size() - start);
    out.insert(out.end(), (const uint8_t*)&sum, (const uint8_t*)&sum + 4);
    return out.size();
}

bool HyperScan::loadState(const uint8_t* data, size_t len) {
    if (len < 12 || std::memcmp(data, "HSST", 4) != 0) { stateError_ = "arquivo de save state inválido"; return false; }
    uint32_t ver; std::memcpy(&ver, data + 4, 4);
    if (ver != VERSION) { stateError_ = "versão de save state incompatível"; return false; }
    const uint8_t* payload = data + 8; size_t plen = len - 8 - 4;
    uint32_t sum; std::memcpy(&sum, data + len - 4, 4);
    if (fnv1a(payload, plen) != sum) { stateError_ = "save state corrompido ou truncado"; return false; }
    Ar ar; ar.writing = false; ar.in = payload; ar.len = plen;
    walk(ar, *this);
    cpu_.jit().flush();     // a RAM mudou: blocos traduzidos não valem mais
    if (!ar.ok || ar.pos != plen) { stateError_ = "save state incompatível com esta versão"; return false; }
    cpu_.error_code = 0; cpu_.error_msg.clear();
    error_.clear(); stateError_.clear();
    return true;
}

} // namespace hyperscan
