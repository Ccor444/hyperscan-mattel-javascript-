// HLE do CD (porta de src/cdhle.js): em vez de emular o servo/CDDSP inteiro, intercepta funções do driver do BIOS.
// Cada hook confere a assinatura da função (push! r3 = 0x230e) antes de agir.
#include "CDHLE.h"
#include "HyperScan.h"
#include "SCore7.h"
#include "Bus.h"
#include "Disc.h"
#include <algorithm>
#include <cstring>

namespace hyperscan {

static constexpr uint16_t SIG = 0x230e;

static int64_t msfToLba(uint32_t pos) {
    int64_t m = (pos >> 16) & 0xff, s = (pos >> 8) & 0xff, f = pos & 0xff;
    return (m * 60 + s) * 75 + f - 150;
}

// Copia n bytes de src[off..] para a memória emulada. RAM (segmentos 0x80/0xa0) vai direto; o resto cai em bus.w8.
static void copyToBus(Bus& bus, uint32_t dest, const uint8_t* src, uint32_t off, uint32_t n) {
    uint32_t seg = dest >> 24, o0 = dest & 0xffffff;
    if ((seg == 0xa0 || seg == 0x80) && (uint64_t)o0 + n <= 0x1000000u) {
        std::memcpy(bus.ram() + o0, src + off, n);
        bus.invalidateCode(o0, n);
        return;
    }
    for (uint32_t i = 0; i < n; ++i) bus.w8(dest + i, src[off + i]);
}

// `ret(c, v)`: v opcional (como no JS: sem valor, r4 não é tocado); volta para o chamador (pc = r3)
static bool retv(SCore7& c, int32_t v) { c.r[4] = v; c.pc = (uint32_t)c.r[3]; return true; }
static bool ret(SCore7& c) { c.pc = (uint32_t)c.r[3]; return true; }

void installCdHle(HyperScan& m) {
    HyperScan* mp = &m;    // os hooks guardam só ponteiros/valores (nada de referências a locais desta função)

    // a0024588(dest, pos(MSF binário), offset, n): copia até n bytes do setor `pos` a partir de `offset`; retorna bytes copiados (0 = indisponível)
    m.cpu_.addHook(0xa0024588, [mp](SCore7& c) {
        Bus& bus = mp->bus_;
        if (bus.r16(0xa0024588) != SIG || !mp->disc_) return false;
        uint32_t dest = (uint32_t)c.r[4], pos = (uint32_t)c.r[5], off = (uint32_t)c.r[6], n = (uint32_t)c.r[7];
        int64_t lba = msfToLba(pos);
        const Disc& d = *mp->disc_;
        if (lba < 0 || lba >= (int64_t)d.sectors || off >= 2048) { ++mp->cdhle_.miss; return retv(c, 0); }
        uint32_t take = std::min(n, 2048u - off);
        copyToBus(bus, dest, d.readSector((uint32_t)lba), off, take);
        ++mp->cdhle_.reads; mp->cdhle_.bytes += take;
        return retv(c, (int32_t)take);
    });

    // a0027c78: ReadTOC. Marca "TOC pronto" (bit5 de a0042c4c) e preenche a tabela de trilhas (a005544c).
    m.cpu_.addHook(0xa0027c78, [mp](SCore7& c) {
        Bus& bus = mp->bus_;
        if (bus.r16(0xa0027c78) != SIG || !mp->disc_) return false;
        const uint32_t TOC = 0xa005544c;
        for (int i = 0; i < 104; ++i) bus.w32(TOC + (uint32_t)i * 4, 0xffffffffu);
        bus.w32(TOC + 1 * 4, 0x41000200);                      // trilha 1: dados (ctrl 0x41), início 00:02:00
        uint32_t total = mp->disc_->sectors + 150, mi = total / 4500, si = (total / 75) % 60, fi = total % 75;
        bus.w32(TOC + 0xa2 * 4, (0x01u << 24) | (mi << 16) | (si << 8) | fi);   // lead-out (índice provisório)
        bus.w8(0xa0042c4c, 0x20);                               // bit5 = TOC pronto
        ++mp->cdhle_.toc;
        return ret(c);
    });

    // a0025f44: open(path). Caminho nulo faz o normalizador do BIOS varrer a memória sem fim; devolve erro (-1).
    m.cpu_.addHook(0xa0025f44, [mp](SCore7& c) {
        if (mp->bus_.r16(0xa0025f44) != SIG || c.r[4] != 0) return false;
        ++mp->cdhle_.nullOpen;
        return retv(c, -1);
    });

    // ---- Leitor de cartões ----
    // a001aa44: há cartão? retorna 0x80000000|byte0 quando sim. a001aad4(offset, n): lê n bytes da memória do cartão
    // e devolve um ponteiro para o buffer a0042af0. Bytes 8..9 = conjunto (u16), 10..11 = número (u16).
    m.cpu_.addHook(0xa001aa44, [mp](SCore7& c) {
        if (!mp->card_ || mp->bus_.r16(0xa001aa44) != SIG) return false;
        return retv(c, (int32_t)(0x80000000u | mp->card_->mem[0]));
    });
    m.cpu_.addHook(0xa001aad4, [mp](SCore7& c) {
        if (!mp->card_ || mp->bus_.r16(0xa001aad4) != SIG) return false;
        uint32_t off = (uint32_t)c.r[4], n = (uint32_t)c.r[5];
        const uint32_t BUF = 0xa0042af0;
        for (uint32_t i = 0; i < n && i < 64; ++i) mp->bus_.w8(BUF + i, mp->card_->mem[(off + i) & 255]);
        ++mp->cdhle_.cardReads;
        return retv(c, (int32_t)BUF);
    });

    m.cdhleInstalled_ = true;
}

} // namespace hyperscan
