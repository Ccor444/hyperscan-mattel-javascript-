#include "HyperScan.h"
#include "Bus.h"
#include "SCore7.h"
#include "Jit.h"
#include "IO.h"
#include "SPU.h"
#include "PPU.h"
#include "Disc.h"
#include "CDHLE.h"
#include <algorithm>
#include <cstring>

namespace hyperscan {

// ---- idle.js: avanço de tempo em esperas ociosas ---------------------------------------------------------------
// Laço do jogo Spider-Man: a00a18f0 `lhu r5,[gp-14874]; lhu r4,[gp-14880]; cmp; bne` espera o contador de quadros mudar.
void installIdleSkip(HyperScan& m) {
    HyperScan* mp = &m;
    m.cpu_.addHook(0xa00a18f0, [mp](SCore7& c) {
        Bus& bus = mp->bus_;
        if (!mp->idleSkipEnabled || bus.r16(0xa00a18e4) != 0x230e) return false;   // assinatura: push! r3 no início da função
        uint32_t g = (uint32_t)c.r[28];
        if (bus.r16(g - 14874) != bus.r16(g - 14880)) return false;                // contador já mudou: nada a esperar
        if (!(c.cr[0] & 1)) return false;                                          // interrupções desabilitadas: não adianta esperar
        uint32_t pc0 = c.pc;
        double n = mp->io_.nextEventCycles();
        mp->io_.tick(n);
        ++mp->idle_.skips; mp->idle_.cycles += (uint64_t)n;
        c.cycles += n;                                                             // o áudio (spu.sync) acompanha o pulo ocioso
        return c.pc != pc0;                                                        // interrupção entregue: este passo já foi consumido
    });
}

// ---- fastpaths.js: atalhos nativos de laços quentes do jogo ----------------------------------------------------
static const uint32_t BLIT_WORDS[] = {
    0xc0828024, 0x8483fffe, 0x74607464, 0x84888001, 0x9000a43c, 0xc0828030, 0x80a48870,
    0xc082802c, 0x80859010, 0x741c2448, 0x04537560, 0x80a49410, 0xc0828028, 0x80a59010,
    0x245d7418, 0xc0828030, 0x8483fffe, 0xd0828030, 0x8822a20a
};
static constexpr int BLIT_WORDS_N = (int)(sizeof(BLIT_WORDS) / sizeof(BLIT_WORDS[0]));

void installFastPaths(HyperScan& m) {
    HyperScan* mp = &m;
    // a011220a: for (x = [r2+48]; x >= 0; x--) *(u16*)([r2+40] + 2x) = (u16) *(u32*)([r2+44] + 4x)   (converte 32 -> 16 bits)
    m.cpu_.addHook(0xa011220a, [mp](SCore7& c) {
        Bus& bus = mp->bus_;
        if (!mp->fastPathsEnabled) return false;
        for (int i = 0; i < BLIT_WORDS_N; ++i)
            if (bus.r32(0xa0112200u + (uint32_t)i * 4) != BLIT_WORDS[i]) return false;     // assinatura do código
        uint32_t fp = (uint32_t)c.r[2];
        int32_t x0 = (int32_t)bus.r32(fp + 48);
        if (x0 < 0 || x0 > 4096) return false;
        uint32_t tab = bus.r32(fp + 44), dst = bus.r32(fp + 40);
        uint32_t val = 0;
        for (int32_t x = x0; x >= 0; --x) { val = bus.r32(tab + (uint32_t)x * 4); bus.w16(dst + (uint32_t)(2 * x), (uint16_t)val); }
        bus.w32(fp + 48, 0xffffffffu); bus.w32(fp + 12, val);          // variáveis da pilha como o laço as deixaria
        c.r[4] = -1; c.r[5] = (int32_t)dst;                            // r4 = x final, r5 = último endereço (x = 0)
        c.sub(-1, 0, true);                                            // flags do cmpi.c r4, 0 que encerra o laço
        c.pc = 0xa011224c;                                             // destino do blt (fim do laço)
        ++mp->fast_.blits; mp->fast_.pixels += (uint64_t)(x0 + 1);
        return true;
    });
}

// ---- HyperScan -----------------------------------------------------------------------------------------------
HyperScan::HyperScan(const uint8_t* bios, size_t biosLen, bool fastBoot, bool idleSkip, bool fastPaths)
    : bus_(size_t(16) << 20), cpu_(bus_), io_(),
      fastBootEnabled(fastBoot), idleSkipEnabled(idleSkip), fastPathsEnabled(fastPaths)
{
    bus_.setBios(bios, biosLen);
    io_.attach(bus_, cpu_);
    io_.servo.cpu = &cpu_;
    if (fastBoot) io_.timerDiv = 8;
    installIdleSkip(*this);
    installFastPaths(*this);
    io_.onUartChar = [this](uint8_t c) { uart_.push_back((char)c); };
    rgba_.assign((size_t)640 * 480 * 4, 0);
    reset();
}

HyperScan::~HyperScan() = default;

void HyperScan::reset() { cpu_.reset(0x9f000000); error_.clear(); }

void HyperScan::run(int n) {
    if (!error_.empty()) return;
    int i = 0;
    while (i < n) {
        // chunk de 1024: menos chamadas a io.tick por quadro (mesma semântica do JS)
        int chunk = std::min(1024, n - i);
        if (cpu_.sleeping) { io_.tick(chunk); i += chunk; continue; }
        cpu_.runN((uint64_t)chunk);
        if (cpu_.error_code) {
            error_ = cpu_.error_msg + " (instr " + std::to_string((long long)cpu_.cycles) + ")";
            return;
        }
        i += chunk;
        io_.tick((double)chunk);
    }
    cpu_.jit().maybeFinalize();
}

void HyperScan::insertDisc(const uint8_t* data, size_t len) {
    disc_ = std::make_unique<Disc>(std::vector<uint8_t>(data, data + len));
    if (!cdhleInstalled_) installCdHle(*this);
}

uint8_t* HyperScan::discBuffer(size_t len) {
    discBuf_.assign(len, 0);
    return discBuf_.data();
}
void HyperScan::discCommit() {
    disc_ = std::make_unique<Disc>(std::move(discBuf_));
    discBuf_ = std::vector<uint8_t>();
    if (!cdhleInstalled_) installCdHle(*this);
}

const std::string& HyperScan::discVolumeId() const {
    static const std::string kEmpty;
    return disc_ ? disc_->volumeId : kEmpty;
}
uint32_t HyperScan::discSectors() const { return disc_ ? disc_->sectors : 0; }

uint32_t HyperScan::render() {
    int w, h; ppuSize(io_, w, h);
    size_t need = (size_t)w * h * 4;
    if (rgba_.size() < need) rgba_.resize(need);
    renderPPU(io_, bus_, rgba_.data());
    return (uint32_t)(uintptr_t)rgba_.data();
}
int HyperScan::screenWidth()  { int w, h; ppuSize(io_, w, h); return w; }
int HyperScan::screenHeight() { int w, h; ppuSize(io_, w, h); return h; }

void HyperScan::setPad(int port, int in0, int in1, int ax, int ay) {
    auto& p = io_.padIn[port ? 1 : 0];
    p[0] = (uint8_t)(in0 & 255);
    p[1] = (uint8_t)(in1 & 255);
    p[2] = (uint8_t)(ay & 255);
    p[3] = (uint8_t)(ax & 255);
}

int HyperScan::pullAudio(int n, double ratio) {
    if (!io_.spuChip || n <= 0) return 0;
    io_.spuChip->pull((uint32_t)n, ratio);
    return n;
}

void HyperScan::insertCard(int set, int num) {
    Card c;
    c.set = set; c.num = num;
    c.mem.fill(0);
    c.mem[8] = (uint8_t)(set & 255);  c.mem[9] = (uint8_t)((set >> 8) & 255);
    c.mem[10] = (uint8_t)(num & 255); c.mem[11] = (uint8_t)((num >> 8) & 255);
    card_ = c;
}

} // namespace hyperscan
