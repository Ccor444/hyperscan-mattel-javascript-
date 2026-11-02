#include "SPU.h"
#include "Bus.h"
#include "IO.h"
#include "SCore7.h"
#include <algorithm>
#include <cmath>

namespace hyperscan {

static constexpr uint32_t WAVE_BASE = 0xa0800000u;
static constexpr double DAC_CLOCK = 54000000.0;                 // homebrew: 54 MHz (o Flick usa 27 MHz)
static constexpr double MAME_FRAME_HZ = 70312.5;
static constexpr double WAVE_INC = 281250.0 * 65536.0 / (524288.0 * (double)SPU::AUDIO_RATE);   // fase Q16 por unidade de `phase`
static const int ENV_CLK_FRAMES[16] = {4,8,16,32,64,128,256,512,1024,2048,4096,8192,8192,8192,8192,8192};
static const double VOLSEL[4] = {1.0 / 32, 1.0 / 8, 1.0 / 2, 1.0};
static const int IMA_STEPS[89] = {
    7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,
    253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,
    3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,
    22385,24623,27086,29794,32767
};
static const int IMA_INDEX[8] = {-1,-1,-1,-1,2,4,6,8};

static inline int clamp16(int v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
static inline int16_t s16(uint32_t v) { return (int16_t)(uint16_t)v; }

SPU::SPU(IO& io, Bus& bus) : io_(io), bus_(bus) {
    ring.assign((size_t)AUDIO_RATE * 2 * 2, 0.0f);
    fifo.assign((size_t)RING * 2, 0);
    regs[0x1054] = 0x3f;   // ENV_MODE: bit = manual
    regs[0x1050] = 0x3f;   // REPEAT
    regs[0x1004] = 0x7f;   // volume principal
}

uint32_t SPU::fiqEnable() const { return reg(0x1008) | (reg(0x1408) << 16); }
uint32_t SPU::busyBits() const {
    uint32_t b = 0;
    for (int c = 0; c < 24; ++c) if (ch[c].active) b |= 1u << c;
    return b;
}

uint32_t SPU::read(uint16_t off) {
    if (off == 0x103c) return busyBits() & 0xffff;
    if (off == 0x143c) return busyBits() >> 16;
    return reg(off);
}

void SPU::write(uint16_t off, uint32_t v) {
    if (off == 0x1000 || off == 0x1400) {                      // ChEn: borda de subida inicia, descida para
        sync();
        int base = off == 0x1400 ? 16 : 0;
        uint32_t old = reg(off) & 0xffff, nv = v & 0xffff;
        setReg(off, nv);
        for (int b = 0; b < 16; ++b) {
            uint32_t was = (old >> b) & 1, now = (nv >> b) & 1;
            int c = base + b;
            if (now && !was) startChannel(c);
            else if (!now && was) stopChannel(c, false);
        }
        updateIrq(); return;
    }
    if (off == 0x102c || off == 0x142c) {                      // flags de parada: escrever 1 limpa
        sync();
        setReg(off, reg(off) & ~(v & 0xffff));
        updateIrq(); return;
    }
    if (off == 0x1004) { sync(); setReg(off, v & 0x7f); return; }
    if (off == 0x1034) { sync(); setReg(off, v & 0xffff); return; }
    if (off == 0x1040) { sync(); waveIn[0] = s16(v); setReg(off, v & 0xffff); return; }
    if (off == 0x1044) { sync(); waveIn[1] = s16(v); setReg(off, v & 0xffff); return; }
    if (off == 0x1064) {                                       // relógio de amostra do DAC
        sync(); setReg(off, v & 0xffff);
        configDac();
        if ((reg(0x1088) & 0x4000) && !dmaOn) startDma();
        return;
    }
    if (off == 0x1080) { sync(); setReg(off, v); return; }     // endereço base do FIFO (32 bits)
    if (off == 0x1084) { setReg(off, v & 0xffff); return; }
    if (off == 0x1088) {                                       // controle do DAC / status de IRQ
        sync();
        uint32_t was = reg(off);
        bool pend = (was & 0x8000) && !(v & 0x8000);           // escrever 1 em bit 15 = reconhece o IRQ
        uint32_t ctrl = ((v & 0x7fff) | (pend ? 0x8000u : 0u)) & 0xffff;
        setReg(off, ctrl);
        if (!(was & 0x4000) && (ctrl & 0x4000)) { configDac(); startDma(); }
        else if ((was & 0x4000) && !(ctrl & 0x4000)) stopDma();
        updateIrq(); return;
    }
    setReg(off, v & 0xffff);
}

void SPU::configDac() {
    uint32_t ctrl = reg(0x1088), phase = reg(0x1064);
    dacStereo = (ctrl & 4) != 0;
    double bytes = (double)(1024 << (ctrl & 3));
    halfFrames = (bytes / 2) / (dacStereo ? 2 : 1) / 2;
    dacRate = phase ? DAC_CLOCK / ((double)phase + 1) : 0;
}

// Pré-enche as duas metades antes de liberar o playback (ver [FIX 2] em spu.js).
void SPU::startDma() {
    configDac();
    if (!dacRate || !halfFrames) return;
    dmaOn = true; dmaHalf = 0; fHead = 0; fTail = 0; fFrac = 0;
    fetchHalf(0);
    fetchHalf(1);
    dmaLeft = halfFrames * AUDIO_RATE / dacRate;
}

// lê uma metade do buffer do FIFO (palavras sem sinal, XOR 0x8000) para o anel do DAC
void SPU::fetchHalf(int h) {
    uint32_t base = reg(0x1080);
    int frames = (int)halfFrames;
    uint32_t words = (uint32_t)frames * (dacStereo ? 2 : 1);
    uint32_t addr = base + (uint32_t)h * words * 2;
    for (int f = 0; f < frames; ++f) {
        int16_t l = s16(bus_.r16(addr) ^ 0x8000u); addr += 2;
        int16_t r = l;
        if (dacStereo) { r = s16(bus_.r16(addr) ^ 0x8000u); addr += 2; }
        size_t slot = (size_t)((fHead + (uint64_t)f) % RING) * 2;
        fifo[slot] = l; fifo[slot + 1] = r;
    }
    fHead += (uint64_t)frames;
}

// FIQ (fonte 0): pendente no FIFO (bit 15) ou parada de canal com a FIQ habilitada
void SPU::updateIrq() {
    bool pend = (reg(0x1088) & 0x8000) != 0 || ((reg(0x102c) | (reg(0x142c) << 16)) & fiqEnable()) != 0;
    io_.setSrc(0, pend);
}

void SPU::startChannel(int c) {
    uint32_t a = attrBase(c);
    Channel& C = ch[c];
    uint32_t mode = reg(a + 4), sel = reg(a + 0x34);
    C.waddr = ((mode & 0x3f) << 16) | reg(a);
    C.loop = (((mode >> 6) & 0x3f) << 16) | reg(a + 8);
    C.tone = (mode >> 12) & 3;
    C.kind = ((mode >> 15) & 1) ? (((sel >> 15) & 1) ? A36 : IMA) : (((mode >> 14) & 1) ? PCM16 : PCM8);
    C.wp = C.waddr; C.bp = C.waddr * 2; C.shift = 0; C.nib = 0; C.sig = 0; C.stepIdx = 0; C.hdr = 0; C.rem = 0; C.p0 = 0;
    C.last = 0; C.prev = 0; C.acc = 0; C.phaseAcc = 0; C.samples = 0; C.active = true; C.started = C.waddr;
    C.envAddr = ((reg(a + 0x1c) & 0x3f) << 16) | reg(a + 0x20);
    setReg(a + 0x14, (reg(a + 0x14) & 0x00ff) | ((reg(a + 0x18) & 0xff) << 8));   // contagem = carga
    ++starts;
}

void SPU::stopChannel(int c, bool natural) {
    Channel& C = ch[c];
    C.active = false; C.started = -1;
    uint32_t en = c < 16 ? 0x1000u : 0x1400u, bit = c & 15;
    setReg(en, reg(en) & ~(1u << bit));
    if (natural) {
        uint32_t sf = c < 16 ? 0x102cu : 0x142cu;
        setReg(sf, reg(sf) | (1u << bit));
        updateIrq();
    }
}

uint16_t SPU::wordAt(uint32_t waddr) { return bus_.r16(WAVE_BASE + waddr * 2); }

// Loop tone 2: reset do decoder inteiro (ver [FIX 1] em spu.js)
bool SPU::endOrLoop(int c) {
    Channel& C = ch[c];
    if (C.tone == 2) {
        C.wp = C.loop; C.bp = C.loop * 2;
        C.nib = 0; C.shift = 0; C.rem = 0;
        C.sig = 0; C.stepIdx = 0;
        C.hdr = 0; C.p0 = 0;
        return true;
    }
    return false;
}

// avança o decodificador do canal uma amostra de onda. false = fim da onda.
bool SPU::fetch(int c) {
    Channel& C = ch[c];
    if (C.kind == A36 && C.rem == 0 && C.tone != 0) { C.hdr = wordAt(C.wp); C.rem = 8; C.wp++; }
    uint32_t w = C.tone == 0 ? (reg(attrBase(c) + 0x2c) & 0xffff) : wordAt(C.wp);
    if (C.tone != 0 && w == 0xffff) {
        if (C.kind == PCM16 || ((C.kind == IMA || C.kind == A36) && C.nib == 0)) return endOrLoop(c);
    }
    switch (C.kind) {
        case PCM8: {
            uint32_t b = C.tone == 0 ? (w & 0xff) : bus_.r8(WAVE_BASE + C.bp);
            if (C.tone != 0 && b == 0xff) return endOrLoop(c);
            C.prev = C.last; C.last = ((int)b - 0x80) * 256;
            if (C.tone != 0) C.bp++;
            return true;
        }
        case PCM16: {
            C.prev = C.last; C.last = s16(w ^ 0x8000u); C.wp++;
            return true;
        }
        case IMA: {
            int nib = (int)((w >> (C.nib * 4)) & 15);
            int step = IMA_STEPS[C.stepIdx], d = step >> 3;
            if (nib & 4) d += step;
            if (nib & 2) d += step >> 1;
            if (nib & 1) d += step >> 2;
            if (nib & 8) d = -d;
            C.sig = clamp16(C.sig + d);
            C.stepIdx = std::max(0, std::min(88, C.stepIdx + IMA_INDEX[nib & 7]));
            C.prev = C.last; C.last = C.sig;
            if (++C.nib >= 4) { C.nib = 0; C.wp++; }
            return true;
        }
        case A36: {
            int shift = C.hdr & 15, filter = (C.hdr >> 4) & 0x3f, f0 = (filter & 0x20) ? filter - 64 : filter;
            int nib = (int)((w >> (C.nib * 4)) & 15);
            int sd = (int16_t)(uint16_t)(nib << 12);
            sd = (sd >> shift) + (((C.p0 * f0) + 32) >> 12);
            sd = (int16_t)(uint16_t)sd;
            C.p0 = sd; C.prev = C.last; C.last = sd;
            if (++C.nib >= 4) { C.nib = 0; C.wp++; C.rem--; }
            return true;
        }
    }
    return true;
}

// envelope automático (MAME audio_envelope_tick)
void SPU::tickEnvelope(int c) {
    uint32_t a = attrBase(c);
    Channel& C = ch[c];
    int d0 = (int)reg(a + 0x14), e0 = (int)reg(a + 0x10), e1 = (int)reg(a + 0x18), lc = (int)reg(a + 0x28);
    int count = (d0 >> 8) & 0xff, edd = d0 & 0x7f;
    int inc = e0 & 0x7f, target = (e0 >> 8) & 0x7f;
    bool sign = (e0 & 0x80) != 0;
    auto setCount = [&](int k) { setReg(a + 0x14, (reg(a + 0x14) & 0x00ffu) | ((uint32_t)k << 8)); };
    auto setEdd   = [&](int k) { setReg(a + 0x14, (reg(a + 0x14) & 0xff80u) | (uint32_t)k); };
    auto load     = [&]() { return (int)(reg(a + 0x18) & 0xff); };
    if (count > 0) { count--; setCount(count); }
    if (count != 0) return;
    int ne = edd;
    if (ne != target) {
        if (sign) {
            ne -= inc; if (ne > edd) ne = 0; else if (ne < target) ne = target;
            if (ne == 0) { setEdd(0); stopChannel(c, true); return; }
        } else { ne += inc; if (ne >= target) ne = target; }
    }
    if (ne == target) {
        if (e1 & 0x100) {
            int rc = ((e1 >> 9) & 0x7f) - 1;
            if (rc == 0) {
                uint32_t base = ((reg(a + 0x1c) & 0x3f) << 16) | reg(a + 0x20);
                setReg(a + 0x10, wordAt(base)); setReg(a + 0x18, wordAt(base + 1)); setReg(a + 0x28, wordAt(base + 2));
                C.envAddr = base + (uint32_t)(lc & 0x1ff);
            } else setReg(a + 0x18, ((uint32_t)e1 & ~0xfe00u) | ((uint32_t)rc << 9));
        } else {
            setReg(a + 0x10, wordAt(C.envAddr)); setReg(a + 0x18, wordAt(C.envAddr + 1));
            C.envAddr = C.envAddr + 2;
        }
        setCount(load());
    } else setCount(load());
    setEdd(ne);
}

int SPU::envClkFor(int c) {
    uint32_t nib;
    if (c < 4) nib = (reg(0x1018) >> (c * 4)) & 0xf;
    else if (c < 8) nib = (reg(0x101c) >> ((c - 4) * 4)) & 0xf;
    else if (c < 12) nib = (reg(0x1020) >> ((c - 8) * 4)) & 0xf;
    else nib = (reg(0x1024) >> ((c - 12) * 4)) & 0xf;
    return ENV_CLK_FRAMES[nib];
}

// sync() derivado do quadro emulado: usa io.frameLen (ver [FIX 5] em spu.js)
void SPU::sync() {
    SCore7* cpu = io_.cpu;
    if (!cpu) return;
    double ips = (io_.frameLen != 0 ? io_.frameLen : 1500000.0) * 59.94;
    double target = std::floor(cpu->cycles * AUDIO_RATE / ips);
    if (target > done) { render((uint32_t)(target - done)); done = target; }
}

void SPU::render(uint32_t n) {
    const double volsel = VOLSEL[(reg(0x1034) >> 6) & 3];
    const bool noint = (reg(0x1034) & 0x200) != 0;
    const double master = (double)(reg(0x1004) & 0x7f) / 127.0;
    const uint32_t envMode = reg(0x1054);
    const bool fifoOn = (reg(0x1034) & 0x1000) != 0 && dmaOn && dacRate > 0;
    const uint32_t fStep = fifoOn ? (uint32_t)std::floor(dacRate * 65536.0 / AUDIO_RATE) : 0;
    const double frameStep = MAME_FRAME_HZ / AUDIO_RATE;
    for (uint32_t s = 0; s < n; ++s) {
        double mixL = 0, mixR = 0, dacL = 0, dacR = 0;
        // envelope automático (relógio do MAME, 70312,5 Hz)
        mameAcc += frameStep;
        while (mameAcc >= 1) {
            mameAcc -= 1;
            for (int c = 0; c < 16; ++c) {
                Channel& C = ch[c];
                if (!C.active || ((envMode >> c) & 1)) continue;
                if (C.envClk > 0) C.envClk--;
                if (C.envClk == 0) { tickEnvelope(c); C.envClk = envClkFor(c); }
            }
        }
        // FIFO do DAC
        if (fifoOn) {
            uint64_t p = fTail + (fFrac >> 16);
            if (p >= fHead) p = fHead ? fHead - 1 : 0;
            size_t slot = (size_t)(p % RING) * 2;
            dacL = fifo[slot]; dacR = fifo[slot + 1];
            fFrac += fStep;
        } else { mixL += waveIn[0]; mixR += waveIn[1]; }
        // canais
        for (int c = 0; c < 24; ++c) {
            Channel& C = ch[c];
            if (!C.active) continue;
            uint32_t a = attrBase(c);
            uint32_t phase = reg(phaseBase(c)) & 0x7ffff;
            if (!phase) continue;
            C.phaseAcc += phase * WAVE_INC;                   // acumulador em Q16, sem truncar a fração (ver [FIX 3])
            bool alive = true;
            while (C.phaseAcc >= 0x10000) {
                C.phaseAcc -= 0x10000;
                if (!fetch(c)) { alive = false; break; }
            }
            if (!alive) { C.active = false; C.started = -1; stopChannel(c, true); continue; }
            int sm = C.last;
            if (!noint) { int lf = (int)((uint32_t)C.phaseAcc >> 8); sm = ((C.last * lf) >> 8) + ((C.prev * (256 - lf)) >> 8); }
            uint32_t w3 = reg(a + 0xc);
            int vol = (int)(w3 & 0x7f), pan = (int)((w3 >> 8) & 0x7f);
            int edd = (int)(reg(a + 0x14) & 0x7f);
            int v = (int)((int64_t)sm * vol * edd / (127 * 127));          // s = last * ch_volume * edd / 127²
            int pl, pr;
            if (pan < 64) { pl = 127; pr = pan * 2; } else { pl = (127 - pan) * 2; pr = 127; }
            mixL += (v * pl) >> 7; mixR += (v * pr) >> 7;
        }
        // FIFO: avanço do DMA (uma metade por halfFrames/dacRate segundos)
        if (dmaOn) {
            fTail += fFrac >> 16; fFrac &= 0xffff;
            if (fTail > fHead) fTail = fHead;
            dmaLeft -= 1;
            if (dmaLeft <= 0) {
                dmaHalf ^= 1; fetchHalf(dmaHalf);
                setReg(0x1088, reg(0x1088) | 0x8000u);
                dmaLeft += halfFrames * AUDIO_RATE / dacRate;
                updateIrq();
            }
        }
        // saída: master, VOLSEL, clipping
        auto clampD = [](double v) { return v > 32767.0 ? 32767.0 : v < -32768.0 ? -32768.0 : v; };
        double oL = clampD(std::trunc((mixL * master + dacL) * volsel)), oR = clampD(std::trunc((mixR * master + dacR) * volsel));
        double lo = oL / 32768, ro = oR / 32768;
        double nyl = lo - xl + 0.9990 * yl, nyr = ro - xr + 0.9990 * yr;
        xl = lo; xr = ro; yl = nyl; yr = nyr;
        lo = std::max(-1.0, std::min(1.0, nyl)); ro = std::max(-1.0, std::min(1.0, nyr));
        peak = std::max(peak, std::max(std::fabs(lo), std::fabs(ro)));
        if (count + 2 > ring.size()) { rd = (rd + 2) % ring.size(); count -= 2; }
        ring[wr] = muted ? 0.0f : (float)lo; ring[wr + 1] = muted ? 0.0f : (float)ro;
        wr = (wr + 2) % ring.size(); count += 2; ++samplesOut;
    }
}

// Saída para a placa (sem relógio de parede). Sem amostra suficiente, repete a última e a faz decair (~3 ms) — [FIX 7].
void SPU::pull(uint32_t n, double ratio) {
    out.assign((size_t)n * 2, 0.0f);
    const size_t cap = ring.size();
    for (uint32_t i = 0; i < n; ++i) {
        if (count < 4) {
            if (!_underrunActive) { _underrunActive = true; ++underrunRuns; }
            ++underruns;
            holdL *= 0.9965; holdR *= 0.9965;                      // decai ~3 ms até o silêncio
            out[2 * i] = (float)holdL; out[2 * i + 1] = (float)holdR;
            continue;
        }
        _underrunActive = false;
        size_t r1 = (rd + 2) % cap;
        double f = pos;
        double l = (double)ring[rd] * (1 - f) + (double)ring[r1] * f;
        double r = (double)ring[rd + 1] * (1 - f) + (double)ring[r1 + 1] * f;
        out[2 * i] = (float)l; out[2 * i + 1] = (float)r; holdL = l; holdR = r;
        pos += ratio;
        while (pos >= 1 && count >= 4) { pos -= 1; rd = (rd + 2) % cap; count -= 2; }
    }
}

} // namespace hyperscan
