#pragma once
// Máquina HyperScan: CPU + bus + periféricos (porta de src/hyperscan.js, idle.js, fastpaths.js, savestate.js).
// Um quadro = io.frameLen instruções (vblank do PPU).
#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "Bus.h"
#include "SCore7.h"
#include "IO.h"
#include "SPU.h"

namespace hyperscan {

class Disc;

// Leitor de cartões virtual (bytes 8..11 = conjunto/número, como no cdhle.js).
struct Card {
    int set = 5;
    int num = 1;
    std::array<uint8_t, 256> mem{};
};

struct FastStats  { uint64_t blits = 0, pixels = 0; };
struct IdleStats  { uint64_t skips = 0, cycles = 0; };
struct CdHleStats { uint64_t reads = 0, bytes = 0, toc = 0, miss = 0, nullOpen = 0, cardReads = 0; };

class HyperScan {
public:
    // fastBoot: timers 8x mais rápidos (encurta a calibração de atraso do BIOS: ~410M -> ~50M instruções)
    // idleSkip: avança o tempo em esperas ociosas (idle.js); fastPaths: atalhos nativos de laços quentes (fastpaths.js)
    HyperScan(const uint8_t* bios, size_t biosLen, bool fastBoot = true, bool idleSkip = true, bool fastPaths = true);
    ~HyperScan();
    HyperScan(const HyperScan&) = delete;
    HyperScan& operator=(const HyperScan&) = delete;

    // ---- Disco --------------------------------------------------------------
    void     insertDisc(const uint8_t* data, size_t len);        // copia
    uint8_t* discBuffer(size_t len);                              // aloca o buffer da imagem dentro do WASM (sem cópia extra)...
    void     discCommit();                                        // ...e a registra depois que o JS preencheu o buffer
    bool     hasDisc() const { return disc_ != nullptr; }
    const std::string& discVolumeId() const;
    uint32_t discSectors() const;

    // ---- Ciclo de vida ------------------------------------------------------
    void reset();
    void run(int n);                       // executa n instruções (em pedaços de 1024, com io.tick por pedaço)

    // ---- Vídeo --------------------------------------------------------------
    // Desenha o quadro atual; devolve ponteiro para o buffer RGBA (screenWidth()*screenHeight()*4 bytes).
    uint32_t render();
    int      screenWidth();
    int      screenHeight();

    // ---- Entrada ------------------------------------------------------------
    // in0/in1 = bytes de botões; ax/ay = analógico 0..255 (0x7f = centro); port 0/1.
    void setPad(int port, int in0, int in1, int ax, int ay);

    // ---- Status -------------------------------------------------------------
    uint32_t pc() const          { return cpu_.pc; }
    double   cycles() const      { return cpu_.cycles; }
    double   frames() const      { return (double)io_.frames; }
    int32_t  reg(int i) const    { return (i >= 0 && i < 32) ? cpu_.r[i] : 0; }
    const std::string& error() const { return error_; }
    const std::string& uart()  const { return uart_; }

    // ---- CD HLE -------------------------------------------------------------
    bool     cdHleActive() const { return cdhleInstalled_; }
    double   cdReads() const     { return (double)cdhle_.reads; }
    double   cdBytes() const     { return (double)cdhle_.bytes; }

    // ---- Save state ---------------------------------------------------------
    // Estado completo (CPU, RAM, periféricos, SPU, servo). Formato binário próprio ("HSST" v2); a página comprime com gzip.
    size_t   saveState();                  // serializa e devolve o tamanho; os bytes ficam em saveStatePtr() até saveStateFree()
    uint32_t saveStatePtr() const { return (uint32_t)(uintptr_t)saveState_.data(); }
    void     saveStateFree() { std::vector<uint8_t>().swap(saveState_); }
    bool     loadState(const uint8_t* data, size_t len);     // false (e stateError()) se inválido; a máquina continua como estava
    const std::string& stateError() const { return stateError_; }

    // ---- Áudio --------------------------------------------------------------
    int      audioBuffered() const { return io_.spuChip ? (int)io_.spuChip->buffered() : 0; }
    // Gera n quadros estéreo INTERCALADOS (L,R,...) em audioPtr(); devolve n.
    int      pullAudio(int n, double ratio);
    uint32_t audioPtr() const { return io_.spuChip ? (uint32_t)(uintptr_t)io_.spuChip->out.data() : 0; }

    // ---- Cartão -------------------------------------------------------------
    void insertCard(int set, int num);
    void removeCard() { card_.reset(); }

    // ---- Internos (públicos: usados pelos hooks, pela API C e pelos testes) ---
    Bus                       bus_;
    SCore7                    cpu_;
    IO                        io_;
    std::unique_ptr<Disc>     disc_;
    std::optional<Card>       card_;
    CdHleStats                cdhle_;
    FastStats                 fast_;
    IdleStats                 idle_;

    bool fastBootEnabled  = true;
    bool idleSkipEnabled  = true;
    bool fastPathsEnabled = true;

    std::vector<uint8_t> rgba_;
    std::vector<uint8_t> saveState_;
    std::vector<uint8_t> discBuf_;
    std::string error_;
    std::string stateError_;               // motivo da última falha em loadState() (não para a máquina)
    std::string uart_;
    bool cdhleInstalled_ = false;
};

// Instaladores dos hooks de HLE
void installCdHle(HyperScan& m);
void installFastPaths(HyperScan& m);
void installIdleSkip(HyperScan& m);

} // namespace hyperscan
