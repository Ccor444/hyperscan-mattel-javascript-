// Renderizador do PPU do SPG290 — porta de src/ppu.js (que por sua vez vem do MAME spg290_ppu.cpp).
// Mantém a mesma ordem de camadas/sprites, a mesma mistura (blend) com saturação de Uint8ClampedArray e a mesma aritmética
// (inclusive o caso de 6 bits por pixel, onde o JS usa divisões em ponto flutuante).
#include "PPU.h"
#include "IO.h"
#include "Bus.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace hyperscan {

namespace {
struct Tables {
    uint8_t L5[32], L6[64];
    Tables() {
        for (int v = 0; v < 32; ++v) L5[v] = (uint8_t)((v << 3) | (v >> 2));
        for (int v = 0; v < 64; ++v) L6[v] = (uint8_t)((v << 2) | (v >> 4));
    }
};
const Tables T;

// M[l][v] = v*l/63 (divisão inteira, igual à do JS): a mistura vira duas consultas por canal
struct MulTab {
    uint8_t m[64][256];
    MulTab() { for (int l = 0; l < 64; ++l) for (int v = 0; v < 256; ++v) m[l][v] = (uint8_t)(v * l / 63); }
};
const MulTab MT;

// RGB565 / ARGB1555 -> RGBA (bytes R,G,B,255 em little-endian); transparência de 1555 (bit 15) é conferida fora
struct Luts {
    std::vector<uint32_t> l565, l1555;
    Luts() : l565(65536), l1555(32768) {
        for (uint32_t v = 0; v < 65536; ++v)
            l565[v] = 0xff000000u | ((uint32_t)T.L5[v & 31] << 16) | ((uint32_t)T.L6[(v >> 5) & 63] << 8) | T.L5[(v >> 11) & 31];
        for (uint32_t v = 0; v < 32768; ++v)
            l1555[v] = 0xff000000u | ((uint32_t)T.L5[v & 31] << 16) | ((uint32_t)T.L5[(v >> 5) & 31] << 8) | T.L5[(v >> 10) & 31];
    }
};
const Luts LUT;

inline int clamp255(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
// bus.rX(a) do JS faz `a >>>= 0`: um double (possivelmente fracionário) vira uint32 por truncamento + módulo 2^32
inline uint32_t u32(double d) { return (uint32_t)(uint64_t)(int64_t)d; }
}

void ppuSize(IO& io, int& w, int& h) {
    if (io.tveCtl) {
        uint32_t t = io.tveCtl & 0xc;
        if (t == 4) { w = 640; h = 480; return; }
        if (t == 8) { w = 640; h = 240; return; }
        w = 320; h = 240; return;
    }
    uint32_t r = io.ppu[0] & 3;
    if (r == 1) { w = 640; h = 480; }
    else if (r == 2) { w = 640; h = 240; }
    else { w = 320; h = 240; }
}

struct Layer { uint32_t x, y, attr, ctl, ptr, blend, buf; };
static const Layer TX[3] = {
    { 0x20, 0x24, 0x28, 0x2c, 0x30, 0x38, 0xa0 },
    { 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x54, 0xac },
    { 0x58, 0x5c, 0x60, 0x64, 0x68, 0x70, 0xb8 },
};

bool renderPPU(IO& io, Bus& bus, uint8_t* out) {
    const uint32_t* P = io.ppu.data();
    auto g = [&](uint32_t o) -> uint32_t { return P[o & 0xffff]; };
    int W, H; ppuSize(io, W, H);
    uint32_t* out32 = reinterpret_cast<uint32_t*>(out);
    std::fill(out32, out32 + (size_t)W * H, 0xff000000u);
    bool drew = false;
    const uint32_t ctrl = g(0), blendMode = g(0x0c), transrgb = g(0x10);
    const bool transOn = (transrgb & 0x10000) != 0;
    const uint32_t transV = transrgb & 0xffff;

    // paletas lidas uma vez por quadro
    uint16_t pal1[512], pal2[512];
    for (int i = 0; i < 512; ++i) { pal1[i] = (uint16_t)(g(0x1000 + 4 * i) & 0xffff); pal2[i] = (uint16_t)(g(0x1800 + 4 * i) & 0xffff); }

    // mistura: out = out*l0/63 ± pix*l1/63, saturando em 0..255
    auto putBlend = [&](int x, int y, int r, int gg, int b, int blend) {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        size_t o = ((size_t)y * W + x) * 4;
        const bool sub = (blendMode & 1) != 0;
        const uint8_t* A = MT.m[blend & 63];
        const uint8_t* B = MT.m[(63 - blend) & 63];
        int R  = A[out[o]]     + (sub ? -1 : 1) * B[r];
        int G  = A[out[o + 1]] + (sub ? -1 : 1) * B[gg];
        int Bv = A[out[o + 2]] + (sub ? -1 : 1) * B[b];
        out[o] = (uint8_t)clamp255(R); out[o + 1] = (uint8_t)clamp255(G); out[o + 2] = (uint8_t)clamp255(Bv);
        drew = true;
    };
    auto putPix = [&](int x, int y, int r, int gg, int b, int blend) {
        if (blend) { putBlend(x, y, r, gg, b, blend); return; }
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        size_t o = ((size_t)y * W + x) * 4;
        out[o] = (uint8_t)r; out[o + 1] = (uint8_t)gg; out[o + 2] = (uint8_t)b; out[o + 3] = 255;
        drew = true;
    };
    auto argb1555 = [&](int x, int y, uint32_t v, int blend) {
        if (v & 0x8000) return;                                  // bit15 = transparente
        putPix(x, y, T.L5[(v >> 10) & 31], T.L5[(v >> 5) & 31], T.L5[v & 31], blend);
    };
    auto rgb565 = [&](int x, int y, uint32_t v, int blend) {
        if (transOn && transV == v) return;
        putPix(x, y, T.L5[(v >> 11) & 31], T.L6[(v >> 5) & 63], T.L5[v & 31], blend);
    };
    auto pixel = [&](bool is565, int x, int y, uint32_t v, int blend) {
        if (is565) rgb565(x, y, v, blend); else argb1555(x, y, v, blend);
    };

    // ---- camada bitmap: o vetor de linhas guarda deslocamentos em unidades de 2 bytes ----
    auto blitBitmap = [&](const Layer& L, uint32_t ctl, int posy, int posx, int blend) {
        const uint32_t nptr = g(L.ptr), buf = g(L.buf);
        const int maxX = W + posx, maxY = H + posy;
        const bool is565 = (ctl & 0x1000) != 0;
        const uint32_t* lut = is565 ? LUT.l565.data() : LUT.l1555.data();
        for (int y = 0; y < maxY; ++y) {
            int dy = y - posy; if (dy < 0 || dy >= H) continue;
            uint32_t line = (ctl & 0x04) ? 0u : (uint32_t)y;
            uint32_t rowBase = buf + bus.r32(nptr + line * 4) * 2u;
            uint32_t* rowOut = out32 + (size_t)dy * W;
            for (int x = 0; x < maxX; x += 2) {
                uint32_t data = bus.r32(rowBase + (uint32_t)x * 2);
                for (int b = 0; b < 2; ++b) {
                    const int xp = x + b - posx;
                    if ((unsigned)xp >= (unsigned)W) continue;
                    const uint32_t v = (data >> (16 * b)) & 0xffff;
                    if (blend) { pixel(is565, xp, dy, v, blend); continue; }
                    if (is565) { if (transOn && transV == v) continue; rowOut[xp] = lut[v]; }
                    else { if (v & 0x8000) continue; rowOut[xp] = lut[v]; }
                    drew = true;
                }
            }
        }
    };

    // ---- camada de caracteres (porte direto do MAME) ----
    auto blitCharacter = [&](const Layer& L, uint32_t ctl, uint32_t attr, int posy, int posx, int blend) {
        const uint32_t nptr = g(L.ptr), buf = g(L.buf);
        const int hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3);
        const int bitPixel = (int)(((attr & 3) + 1) << 1), penBank = (int)(((attr >> 8) & 31) * 0x10);
        const int charsLine = 1024 / hsize, penMask = (1 << bitPixel) - 1;
        const double pixelWordD = 32.0 / bitPixel;               // 5,333… para 6 bpp (o JS não arredonda)
        const int pixelWordI = 32 / bitPixel;
        const int maxX = (int)std::floor((double)(W + posx) / vsize) + 1, maxY = (int)std::floor((double)(H + posy) / hsize) + 1;
        const bool is565 = (ctl & 0x1000) != 0;
        for (int y = 0; y <= maxY; ++y) for (int x = 0; x <= maxX; ++x) {
            uint32_t line = (ctl & 0x04) ? 0u : (uint32_t)y;
            uint32_t addr = line * (uint32_t)charsLine + (uint32_t)x;
            uint32_t charId = bus.r16(nptr + addr * 2);
            uint32_t charAddr = buf + charId * (uint32_t)(hsize * vsize);
            const int px0 = x * hsize - posx, py0 = y * vsize - posy;
            // intervalo visível do tile (o JS lê e descarta o resto; a leitura da RAM não tem efeito)
            const int cxLo = std::max(0, -px0), cxHi = std::min(hsize, W - px0);
            const int cyLo = std::max(0, -py0), cyHi = std::min(vsize, H - py0);
            for (int cy = cyLo; cy < cyHi; ++cy) {
                uint32_t lineAddr = charAddr + (uint32_t)(cy * hsize);
                const int py = py0 + cy;
                for (int cx = cxLo; cx < cxHi; ++cx) {
                    const int px = px0 + cx;
                    uint32_t data = bus.r32(lineAddr + (uint32_t)((cx * bitPixel) / 8));
                    uint32_t sh = bitPixel == 6 ? (uint32_t)(int64_t)(std::fmod((double)cx, pixelWordD) * bitPixel)
                                                : (uint32_t)((cx % pixelWordI) * bitPixel);
                    uint32_t pen = (data >> (sh & 31)) & (uint32_t)penMask;
                    const uint32_t v = pal1[(penBank + (int)pen) & 0x1ff];
                    if (blend) { pixel(is565, px, py, v, blend); continue; }
                    uint32_t* o = out32 + (size_t)py * W + px;
                    if (is565) { if (transOn && transV == v) continue; *o = LUT.l565[v]; }
                    else { if (v & 0x8000) continue; *o = LUT.l1555[v]; }
                    drew = true;
                }
            }
        }
    };

    // ---- sprites ----
    const uint32_t spBuf = g(0xd0);
    auto blitSprite = [&](uint32_t i) {
        const uint32_t control = g(0x4000 + 8 * i), attr = g(0x4004 + 8 * i);
        const uint32_t num = control & 0xffff; if (num == 0) return;
        int sx = (int)((control >> 16) & 0x3ff), sy = (int)((attr >> 16) & 0x3ff);
        const int hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3);
        const int bitPixel = (int)(((attr & 3) + 1) << 1), flip = (int)((attr >> 2) & 3);
        const int penBank = (int)(((attr >> 8) & 31) * 0x10);
        const int blend = (attr & 0x8000) ? 0x3f - (int)((attr >> 26) & 0x3f) : 0;
        const double pixelWord = 32.0 / bitPixel, pixelByte = 8.0 / bitPixel, wordLine = hsize / pixelWord;
        const int penMask = (1 << bitPixel) - 1;
        const uint32_t base = spBuf + num * (uint32_t)(hsize * vsize * bitPixel / 8);
        if (sx > W - 1) sx = (sx & 0x3ff) - 0x400;
        if (sy > H - 1) sy = (sy & 0x3ff) - 0x400;
        for (int y = 0; y < vsize; ++y) for (int x = 0; x < wordLine; ++x) {
            uint32_t data = bus.r32(u32(base + (y * wordLine + x) * 4));
            for (int k = 0; k < 4; ++k) {
                for (int b = 0; b < pixelByte; ++b) {
                    const double bitpos = k * pixelByte + b;
                    const uint32_t pen = (data >> ((uint32_t)(8 - (b + 1) * bitPixel) & 31)) & (uint32_t)penMask;
                    const double px = (flip & 1) ? sx + (hsize - (x * pixelWord + bitpos)) : sx + x * pixelWord + bitpos;
                    const double py = (flip & 2) ? sy + (vsize - y) : sy + y;
                    const uint32_t v = pal2[(penBank + (int)pen) & 0x1ff];
                    // 6 bpp: px/py são fracionários no JS. O índice do typed array é py*W+px (soma em double, que pode absorver
                    // diferenças de ~1e-15 e virar inteiro); índice não inteiro = escrita ignorada.
                    if (px >= 0 && py >= 0 && px < W && py < H) {
                        const double idx = py * (double)W + px;
                        if (idx != std::floor(idx)) { if (!(v & 0x8000)) drew = true; continue; }
                        argb1555((int)idx - (int)py * W, (int)py, v, blend);
                    } else argb1555(-1, -1, v, blend);
                }
                data >>= 8;
            }
        }
    };

    if (ctrl & 0x1000) {                                          // PPU habilitado
        const uint32_t spCtl = g(4), spMax = g(8) & 0x1ff;
        for (uint32_t depth = 0; depth < 4; ++depth) {
            for (int l = 0; l < 3; ++l) {
                const Layer& L = TX[l];
                const uint32_t ctl = g(L.ctl), attr = g(L.attr);
                if (!(ctl & 8) || ((attr >> 13) & 3) != depth) continue;
                const int blend = (ctl & 0x100) ? (int)(g(L.blend) & 0x3f) : 0;
                int posx = (int)(g(L.x) & 0x3ff); if (posx & 0x200) posx -= 0x400;
                int posy = (int)(g(L.y) & 0x1ff); if (posy & 0x100) posy -= 0x200;
                if (ctl & 1) blitBitmap(L, ctl, posy, posx, blend); else blitCharacter(L, ctl, attr, posy, posx, blend);
            }
            if (spCtl & 1) for (uint32_t i = 0; i <= spMax; ++i) if (((g(0x4004 + 8 * i) >> 13) & 3) == depth) blitSprite(i);
        }
    }

    // ---- buffer de quadro da TV (RGB565, linhas pares duplicadas sem entrelaçamento) e fade ----
    if (io.bufctl < 3 && io.tvAddr[io.bufctl]) {
        const uint32_t base = io.tvAddr[io.bufctl];
        const bool inter = (io.tveCtl & 1) != 0;
        const uint32_t seg = base >> 24, off0 = base & 0xffffff;
        const bool ramFast = (seg == 0xa0 || seg == 0x80) && !(base & 1) && (uint64_t)off0 + (uint64_t)W * H * 2 <= bus.ramSize();
        const uint32_t* l565 = LUT.l565.data();
        for (int y = 0; y < H; y += (inter ? 1 : 2)) {
            uint32_t* row = out32 + (size_t)y * W;
            if (ramFast) {
                const uint8_t* src = bus.ram() + off0 + (size_t)y * W * 2;
                for (int x = 0; x < W; ++x) { uint16_t v; std::memcpy(&v, src + 2 * x, 2); row[x] = l565[v]; }
            } else {
                for (int x = 0; x < W; ++x) row[x] = l565[bus.r16(base + ((uint32_t)y * W + x) * 2)];
            }
            if (!inter && y + 1 < H) std::memcpy(row + W, row, (size_t)W * 4);
        }
        drew = true;
    }
    if (io.tveFade) {
        const int f = 255 - (int)io.tveFade;
        uint8_t lut[256];
        // Uint8ClampedArray: arredonda para o mais próximo (empate → par). v*f/255 nunca cai em .5 exato.
        for (int v = 0; v < 256; ++v) lut[v] = (uint8_t)clamp255((int)std::nearbyint((double)v * f / 255.0));
        for (size_t i = 0, n = (size_t)W * H * 4; i < n; i += 4) { out[i] = lut[out[i]]; out[i + 1] = lut[out[i + 1]]; out[i + 2] = lut[out[i + 2]]; }
    }
    return drew;
}

} // namespace hyperscan
