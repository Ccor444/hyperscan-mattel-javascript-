#include "Bus.h"
#include "IO.h"
#include "Jit.h"

namespace hyperscan {

Bus::Bus(size_t ramSize) : ramSize_(ramSize), ram_(ramSize + 8, 0) {
    ramp_ = ram_.data();
}

void Bus::setBios(const uint8_t* data, size_t len) {
    bios_.assign(data, data + len);
    biosp_ = bios_.data();
    biosLen_ = bios_.size();
}

void Bus::codeWrite(uint32_t off, int sz) { if (jit_) jit_->invalidateRange(off, (uint32_t)sz); }
void Bus::invalidateCode(uint32_t off, uint32_t len) { if (jit_) jit_->invalidateRange(off, len); }

uint32_t Bus::miss(uint32_t a, bool w) {
    if (unmapped_.size() < 2000) ++unmapped_[a | (w ? 0x80000000u : 0u)];
    return 0;
}

uint32_t Bus::read(uint32_t a, int sz) {
    uint32_t s = a >> 24;
    if (s == 0xa0 || s == 0x80) {
        const uint8_t* p = ramp_ + (a & 0xffffff);
        return sz == 4 ? busdetail::ld32(p) : sz == 2 ? busdetail::ld16(p) : p[0];
    }
    if (s == 0x9f || s == 0x9e) {
        uint32_t o = a & 0xffffff;
        if (o + (uint32_t)sz > biosLen_) return 0;
        const uint8_t* p = biosp_ + o;
        return sz == 4 ? busdetail::ld32(p) : sz == 2 ? busdetail::ld16(p) : p[0];
    }
    if (io_ && (s == 0x08 || s == 0x88)) return io_->read(a & 0x00ffffff, sz);   // offset dentro da janela de 16 MiB (como o JS)
    return miss(a, false);
}

void Bus::write(uint32_t a, uint32_t v, int sz) {
    uint32_t s = a >> 24;
    if (s == 0xa0 || s == 0x80) {
        uint8_t* p = ramp_ + (a & 0xffffff);
        if (sz == 4) busdetail::st32(p, v);
        else if (sz == 2) busdetail::st16(p, (uint16_t)v);
        else p[0] = (uint8_t)v;
        uint32_t o = a & 0xffffff;
        if (codeFlags_[o >> 10] | codeFlags_[(o + sz - 1) >> 10]) codeWrite(o, sz);
        return;
    }
    if (io_ && (s == 0x08 || s == 0x88)) { io_->write(a & 0x00ffffff, v, sz); return; }
    miss(a, true);
}

} // namespace hyperscan
