#pragma once
// Barramento do SPG290 (porta de src/bus.js).
//  - RAM 16 MiB nos segmentos 0x80/0xa0 (espelhados), BIOS nos segmentos 0x9e/0x9f.
//  - Janelas de periféricos 0x08xxxxxx / 0x88xxxxxx vão direto para o IO (sem std::function).
//  - Acessos às regiões RAM/BIOS são inline (caminho quente da CPU); o resto é out-of-line.
// O JIT/cache de código do JS (codeWords/onCodeWrite) não existe aqui: o interpretador C++ lê a RAM a cada instrução.
#include <cstdint>
#include <algorithm>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace hyperscan {

class IO;
class Jit;

namespace busdetail {
inline uint16_t ld16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return v; }
inline uint32_t ld32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
inline void     st16(uint8_t* p, uint16_t v) { std::memcpy(p, &v, 2); }
inline void     st32(uint8_t* p, uint32_t v) { std::memcpy(p, &v, 4); }
} // namespace busdetail

class Bus {
public:
    explicit Bus(size_t ramSize = size_t(16) << 20);
    ~Bus() = default;
    Bus(const Bus&) = delete;
    Bus& operator=(const Bus&) = delete;

    void setBios(const uint8_t* data, size_t len);
    void setIOHandler(IO* io) { io_ = io; }

    // Genéricos (sz = 1, 2 ou 4)
    uint32_t read(uint32_t a, int sz);
    void     write(uint32_t a, uint32_t v, int sz);

    inline uint8_t r8(uint32_t a) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) return ramp_[a & 0xffffff];
        if (s == 0x9f || s == 0x9e) { uint32_t o = a & 0xffffff; return o < biosLen_ ? biosp_[o] : 0; }
        return (uint8_t)read(a, 1);
    }
    inline uint16_t r16(uint32_t a) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) return busdetail::ld16(ramp_ + (a & 0xffffff));
        if (s == 0x9f || s == 0x9e) { uint32_t o = a & 0xffffff; return o + 2 <= biosLen_ ? busdetail::ld16(biosp_ + o) : 0; }
        return (uint16_t)read(a, 2);
    }
    inline uint32_t r32(uint32_t a) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) return busdetail::ld32(ramp_ + (a & 0xffffff));
        if (s == 0x9f || s == 0x9e) { uint32_t o = a & 0xffffff; return o + 4 <= biosLen_ ? busdetail::ld32(biosp_ + o) : 0; }
        return read(a, 4);
    }
    inline void w8(uint32_t a, uint8_t v) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) { uint32_t o = a & 0xffffff; ramp_[o] = v; if (codeFlags_[o >> 10]) codeWrite(o, 1); return; }
        write(a, v, 1);
    }
    inline void w16(uint32_t a, uint16_t v) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) { uint32_t o = a & 0xffffff; busdetail::st16(ramp_ + o, v); if (codeFlags_[o >> 10] | codeFlags_[(o + 1) >> 10]) codeWrite(o, 2); return; }
        write(a, v, 2);
    }
    inline void w32(uint32_t a, uint32_t v) {
        uint32_t s = a >> 24;
        if (s == 0xa0 || s == 0x80) { uint32_t o = a & 0xffffff; busdetail::st32(ramp_ + o, v); if (codeFlags_[o >> 10] | codeFlags_[(o + 3) >> 10]) codeWrite(o, 4); return; }
        write(a, v, 4);
    }

    // Páginas (1 KiB) da RAM que contêm código traduzido pelo JIT: escrita nelas invalida os blocos.
    uint8_t* codeFlags() { return codeFlags_.data(); }
    void setCodeFlag(uint32_t pg) { codeFlags_[pg] = 1; }
    void clearCodeFlag(uint32_t pg) { codeFlags_[pg] = 0; }
    void clearCodeFlags() { std::fill(codeFlags_.begin(), codeFlags_.end(), 0); }
    void setJit(Jit* j) { jit_ = j; }
    void invalidateCode(uint32_t off, uint32_t len);   // para escritas diretas na RAM (memcpy, load state)

    uint8_t*       ram()       { return ramp_; }
    const uint8_t* ram() const { return ramp_; }
    size_t         ramSize() const { return ramSize_; }
    const uint8_t* bios() const { return biosp_; }
    size_t         biosSize() const { return biosLen_; }

    const std::unordered_map<uint32_t, int>& unmapped() const { return unmapped_; }

private:
    uint32_t miss(uint32_t a, bool w);
    void codeWrite(uint32_t off, int sz);
    std::vector<uint8_t> codeFlags_ = std::vector<uint8_t>(16384 + 2, 0);
    Jit* jit_ = nullptr;

    IO* io_ = nullptr;
    size_t ramSize_;
    std::vector<uint8_t> ram_;      // +8 bytes de folga: acesso de 32 bits em 0x..fffffd não sai do vetor (o JS lançaria RangeError)
    std::vector<uint8_t> bios_;
    uint8_t* ramp_ = nullptr;
    const uint8_t* biosp_ = nullptr;
    size_t biosLen_ = 0;
    std::unordered_map<uint32_t, int> unmapped_;
};

} // namespace hyperscan
