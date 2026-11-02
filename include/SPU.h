#pragma once
// SPU do SPG290 (porta de src/spu.js — Flick 0.1.3 + MAME spg2xx_audio). Toda a aritmética de síntese usa double,
// como o JS, para que a saída seja idêntica amostra a amostra.
#include <array>
#include <cstdint>
#include <vector>

namespace hyperscan {

class IO;
class Bus;

class SPU {
public:
    static constexpr int AUDIO_RATE = 44100;
    static constexpr int RING = 32768;          // quadros do anel do FIFO de DAC

    SPU(IO& io, Bus& bus);

    // MMIO (offset dentro de 0x88050000)
    uint32_t read(uint16_t off);
    void     write(uint16_t off, uint32_t v);

    // Áudio
    void     sync();                            // sintetiza até o instante emulado atual (cpu.cycles)
    uint32_t buffered() const { return uint32_t(count >> 1); }
    // pull: devolve n quadros estéreo intercalados (L,R,L,R...) em `out` (n*2 floats), igual a SPU.pull() do JS.
    void     pull(uint32_t n, double ratio);
    std::vector<float> out;                     // resultado do último pull()

    enum Kind { PCM8 = 0, PCM16 = 1, IMA = 2, A36 = 3 };
    struct Channel {
        bool     active = false;
        uint32_t waddr = 0, loop = 0, tone = 0;
        int      kind = PCM8;
        double   phaseAcc = 0;
        uint32_t wp = 0, bp = 0;
        int      shift = 0, nib = 0;
        int      sig = 0, stepIdx = 0;
        int      hdr = 0, rem = 0;
        int      p0 = 0, last = 0, prev = 0, acc = 0;
        int      envClk = 4;
        uint32_t envAddr = 0;
        double   envAcc = 0;
        int64_t  started = -1;
        double   samples = 0;
    };
    std::array<Channel, 24> ch;

    std::vector<uint32_t> regs = std::vector<uint32_t>(0x10000, 0);   // mapa de registradores (leitura = último valor escrito)

    // saída para a placa (2 s)
    std::vector<float> ring;
    size_t rd = 0, wr = 0, count = 0;
    double pos = 0.0;
    uint64_t underruns = 0, underrunRuns = 0;
    bool _underrunActive = false;
    double holdL = 0, holdR = 0;

    double done = 0;                            // amostras de saída já sintetizadas (tempo emulado)
    double mameAcc = 0, frameAcc = 0;
    double xl = 0, xr = 0, yl = 0, yr = 0;      // acoplamento AC

    // FIFO de DAC (DMA)
    std::vector<int16_t> fifo;
    uint64_t fHead = 0, fTail = 0;
    uint32_t fFrac = 0;
    bool     dmaOn = false, dacStereo = false;
    int      dmaHalf = 0;
    double   dmaLeft = 0, halfFrames = 0, dacRate = 0;
    int      waveIn[2] = {0, 0};

    double   peak = 0;
    uint64_t samplesOut = 0, starts = 0;
    bool     muted = false;

    uint32_t reg(uint32_t o) const { return regs[o & 0xffff]; }
    void     setReg(uint32_t o, uint32_t v) { regs[o & 0xffff] = v; }
    static uint32_t attrBase(int c)  { return (c < 16 ? 0x000u : 0x400u) + (uint32_t)(c & 15) * 0x40u; }
    static uint32_t phaseBase(int c) { return (c < 16 ? 0x800u : 0xc00u) + (uint32_t)(c & 15) * 0x40u; }
    uint32_t fiqEnable() const;
    uint32_t busyBits() const;
    void     updateIrq();

private:
    IO&  io_;
    Bus& bus_;

    void     startChannel(int c);
    void     stopChannel(int c, bool natural);
    void     configDac();
    void     startDma();
    void     stopDma() { dmaOn = false; }
    void     fetchHalf(int h);
    uint16_t wordAt(uint32_t waddr);
    bool     fetch(int c);
    bool     endOrLoop(int c);
    void     tickEnvelope(int c);
    int      envClkFor(int c);
    void     render(uint32_t n);
};

} // namespace hyperscan
