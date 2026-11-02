#include "IO.h"
#include "Bus.h"
#include "SCore7.h"
#include "SPU.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace hyperscan {

IO::IO() {
    padIn[0] = {0, 0, 0x7f, 0x7f};
    padIn[1] = {0, 0, 0x7f, 0x7f};
    padLatch[0] = {0, 0, 0, 0};
    padLatch[1] = {0, 0, 0, 0};
}
IO::~IO() = default;

void IO::attach(Bus& bus, SCore7& cpuRef) {
    cpu = &cpuRef;
    spuChip = std::make_unique<SPU>(*this, bus);
    bus.setIOHandler(this);
}

void IO::setSrc(int n, bool on) {
    uint32_t w = n >> 5, b = 1u << (n & 31);
    uint32_t cur = asserted[w];
    uint32_t nv = on ? (cur | b) : (cur & ~b);
    if (cur != nv) asserted[w] = nv;
}

int IO::firstPending() const {
    uint32_t p0 = asserted[0] & ~mask[0];
    uint32_t p1 = asserted[1] & ~mask[1];
    if (p0) return __builtin_ctz(p0);
    if (p1) return 32 + __builtin_ctz(p1);
    return -1;
}

double IO::nextEventCycles() const {
    double n = frameLen - frameCycles;
    for (int i = 0; i < 6; ++i) {
        const Timer& T = timers[i];
        if (T.ctrl & 0x80000000u) n = std::min(n, std::ceil((0x10000 - T.up) * timerDiv));
    }
    return std::max(1.0, std::min(n, 200000.0));
}

void IO::tick(double cycles) {
    frameCycles += cycles;
    if (frameCycles >= frameLen) { frameCycles -= frameLen; ++frames; ppuStatus |= 1; if (onFrame) onFrame(); }
    setSrc(10, (ppuStatus & 1) && (ppuCtrl & 1));

    bool t = false;
    for (int i = 0; i < 6; ++i) {
        Timer& T = timers[i];
        if (T.ctrl & 0x80000000u) {
            T.up += cycles / timerDiv;
            if (T.up >= 0x10000) { T.up = (double)(T.preload & 0xffff); T.ctrl |= 0x04000000u; }
        }
        if ((T.ctrl & 0x08000000u) && (T.ctrl & 0x04000000u)) t = true;
    }
    setSrc(7, t);

    _audioAcc += cycles;
    if (_audioAcc >= 8192) { _audioAcc = 0; if (spuChip) spuChip->sync(); }

    if (beat.en && beat.base * beat.cnt > 0) {
        beat.acc += cycles;
        double per = (double)beat.base * beat.cnt * 14.208 * frameLen / 16667.0;
        if (beat.acc >= per) { beat.acc -= per; beat.sts = 1; }
    }
    setSrc(1, beat.en && beat.sts);

    if (i2c.busy > 0) {
        i2c.busy -= cycles;
        if (i2c.busy <= 0) {
            i2c.busy = 0;
            if (i2c.cr & 0x40) i2c.rdata = i2cSlaveRead((uint16_t)i2c.addr);
            i2c.cr |= ((i2c.start & 1) ? 0x08u : 0u) | ((i2c.start & 2) ? 0x10u : 0u) | ((i2c.start & 4) ? 0x20u : 0u);
            i2c.intr |= 1;
        }
    }
    setSrc(24, (i2c.intr & 3) == 3);

    if (cpu) {
        int src = firstPending();
        if (src >= 0) { if (cpu->interrupt(src)) cpu->sleeping = false; }
    }
}

uint32_t IO::read(uint32_t o, int sz) {
    uint32_t seg = o >> 16, off = o & 0xffff;
    if (seg == 0x15) return uartRead((uint16_t)off);
    if (seg == 0x0a) return intcRead((uint16_t)off);
    if (seg == 0x01) return ppuRead((uint16_t)off);
    if (seg == 0x16) return timerRead((uint16_t)off);
    if (seg == 0x13) return i2cRead((uint16_t)off);
    if (seg == 0x05) return spuRead((uint16_t)off);
    if (seg == 0x06) return servo.read((uint16_t)off);
    if (seg == 0x03 && off == 0) return tveCtl;
    if (seg == 0x07 && off < 12) return tvAddr[off >> 2];
    note(o, false);
    return sz == 4 ? 0xffffffffu : sz == 2 ? 0xffffu : 0xffu;
}

void IO::write(uint32_t o, uint32_t v, int sz) {
    uint32_t seg = o >> 16, off = o & 0xffff;
    if (seg == 0x15) return uartWrite((uint16_t)off, v);
    if (seg == 0x0a) return intcWrite((uint16_t)off, v);
    if (seg == 0x01) return ppuWrite((uint16_t)off, v);
    if (seg == 0x16) return timerWrite((uint16_t)off, v);
    if (seg == 0x13) return i2cWrite((uint16_t)off, v);
    if (seg == 0x05) return spuWrite((uint16_t)off, v);
    if (seg == 0x06) { servo.write((uint16_t)off, v); return; }
    if (seg == 0x03) { if (off == 0) tveCtl = v & 0xffff; else if (off == 0x0c) tveFade = v & 0xff; }
    else if (seg == 0x07 && off < 12) tvAddr[off >> 2] = v;
    else if (seg == 0x09 && off == 0x20) bufctl = v & 3;
    note(o, true);
}

void IO::note(uint32_t o, bool write) {
    ++unmodeled[(o & 0x00ffffffu) | (write ? 0x80000000u : 0u)];
}

uint32_t IO::intcRead(uint16_t off) {
    // pendentes = asserted & ~mask; só as fontes 0..39 existem (o JS só varre n < 40)
    uint32_t lo = asserted[0] & ~mask[0];
    uint32_t hi = asserted[1] & ~mask[1] & 0xffu;
    switch (off) { case 0x00: return lo; case 0x04: return hi; case 0x20: return mask[0]; case 0x24: return mask[1]; }
    return 0;
}
void IO::intcWrite(uint16_t off, uint32_t v) {
    if (off == 0x20) mask[0] = v;
    else if (off == 0x24) mask[1] = v;
}

uint32_t IO::ppuRead(uint16_t off) {
    if (off == 0x80) return ppuCtrl;
    if (off == 0x84) return ppuStatus;
    if (off == 0x94) {
        double vpos = frameCycles * rasterLines / frameLen;
        return vblankLines + (uint32_t)std::floor(vpos) % rasterLines;
    }
    return ppu[off];
}
void IO::ppuWrite(uint16_t off, uint32_t v) {
    if (off == 0x80) { ppuCtrl = v & 7; return; }
    if (off == 0x84) { ppuStatus &= ~v; return; }
    ppu[off] = v;
}

uint32_t IO::timerRead(uint16_t off) {
    int n = off >> 12, r = off & 0xfff;
    if (n > 5) return 0;
    const Timer& T = timers[n];
    switch (r) {
        case 0: return T.ctrl;
        case 4: return T.ccp;
        case 8: return T.preload;
        case 0x10: return (uint32_t)std::floor(T.up);
    }
    return 0;
}
void IO::timerWrite(uint16_t off, uint32_t v) {
    int n = off >> 12, r = off & 0xfff;
    if (n > 5) return;
    Timer& T = timers[n];
    if (r == 0) {
        uint32_t F = 0x04000000u;
        T.ctrl = (v & ~F) | (T.ctrl & F & ~v);
        if ((v & 0x80000000u) && !T.wasEn) T.up = (double)(T.preload & 0xffff);
        T.wasEn = (v & 0x80000000u) != 0;
    } else if (r == 4) T.ccp = v;
    else if (r == 8) T.preload = v;
}

uint32_t IO::i2cRead(uint16_t off) {
    switch (off) {
        case 0x20: return i2c.cr;
        case 0x24: return i2c.intr;
        case 0x28: return i2c.cvr;
        case 0x2c: return i2c.id;
        case 0x30: return i2c.addr;
        case 0x34: return i2c.wdata;
        case 0x38: return i2c.rdata;
    }
    return 0;
}
void IO::i2cWrite(uint16_t off, uint32_t v) {
    switch (off) {
        case 0x20: i2c.cr = v & ~0x38u & ~0x7u; if (v & 7) { i2c.start = v & 7; i2c.busy = 2000; } break;
        case 0x24: i2c.intr = (v & 2) | ((i2c.intr & 1) & v); break;
        case 0x28: i2c.cvr = v; break;
        case 0x2c: i2c.id = v; break;
        case 0x30: i2c.addr = v; break;
        case 0x34: i2c.wdata = v; break;
    }
}

uint32_t IO::uartRead(uint16_t off) {
    switch (off) { case 0x00: case 0x04: case 0x08: case 0x0c: return 0; case 0x10: return 0x90; }
    return 0;
}
void IO::uartWrite(uint16_t off, uint32_t v) {
    if (off == 0) {
        uint8_t c = v & 0xff;
        uartOut.push_back(c);
        if (onUartChar) onUartChar(c);
    }
}

uint32_t IO::spuRead(uint16_t off) {
    if (off == 0x1014) return (beat.en << 15) | (beat.sts << 14) | (beat.cnt & 0x3fff);
    return spuChip->read(off);
}
void IO::spuWrite(uint16_t off, uint32_t v) {
    if (off == 0x1010) beat.base = v & 0x7ff;
    else if (off == 0x1014) { beat.en = (v >> 15) & 1; beat.cnt = v & 0x3fff; beat.acc = 0; if (!beat.en) beat.sts = 0; }
    spuChip->write(off, v);
}

uint16_t IO::i2cSlaveRead(uint16_t addr) {
    int port = (addr >> 4) & 15, a = addr & 15;
    if (port >= 2) return 0xffff;
    if (a < 4) { padLatch[port][a] = padIn[port][a]; return padLatch[port][a]; }
    auto& L = padLatch[port];
    return (uint16_t)(((L[0] + L[1] + L[2] + L[3]) << 2) | port);
}

} // namespace hyperscan
