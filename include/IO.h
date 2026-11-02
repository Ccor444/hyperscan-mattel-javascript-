#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "Servo.h"

namespace hyperscan {

class Bus;
class SCore7;
class SPU;

class IO {
public:
    IO();
    ~IO();

    void attach(Bus& bus, SCore7& cpu);

    uint32_t read(uint32_t off, int sz);
    void     write(uint32_t off, uint32_t v, int sz);

    void    tick(double cycles);
    double  nextEventCycles() const;

    std::function<void()> onFrame;

    std::vector<uint8_t> uartOut;
    std::function<void(uint8_t)> onUartChar;

    uint16_t tveCtl  = 0;
    uint16_t tveFade = 0;
    uint32_t tvAddr[3] = {0, 0, 0};
    uint8_t  bufctl = 3;

    SCore7* cpu = nullptr;
    Servo   servo;

    int timerDiv = 64;

    std::array<uint32_t, 2> asserted{{0, 0}};
    std::array<uint32_t, 2> mask{{0xffffffffu, 0xffffffffu}};

    std::vector<uint32_t> ppu = std::vector<uint32_t>(0x10000, 0);   // registradores do PPU (offset -> valor), como o Map do JS
    uint32_t ppuCtrl = 0;
    uint32_t ppuStatus = 0;

    struct Timer {
        uint32_t ctrl = 0, ccp = 0, preload = 0;
        double   up = 0.0;
        uint32_t rate = 0;
        bool     wasEn = false;
    };
    std::array<Timer, 6> timers;

    double   frameCycles = 0.0;
    double   frameLen = 1500000.0;
    uint32_t rasterLines = 525, rasterVis = 240, vblankLines = 0;
    uint64_t frames = 0;

    struct { uint32_t en = 0, sts = 0, base = 0, cnt = 0; double acc = 0; } beat;

    struct {
        uint32_t cr = 0, intr = 0, cvr = 0, id = 0, addr = 0, wdata = 0, rdata = 0;
        uint32_t start = 0;
        double   busy = 0;
    } i2c;

    std::array<std::array<uint8_t, 4>, 2> padIn{};
    std::array<std::array<uint8_t, 4>, 2> padLatch{};

    std::unique_ptr<SPU> spuChip;

    // acessos a registradores não modelados: chave = offset | (escrita ? 0x80000000 : 0)
    std::unordered_map<uint32_t, int> unmodeled;


    // Helpers
    uint32_t intcRead(uint16_t off);
    void     intcWrite(uint16_t off, uint32_t v);
    uint32_t ppuRead(uint16_t off);
    void     ppuWrite(uint16_t off, uint32_t v);
    uint32_t timerRead(uint16_t off);
    void     timerWrite(uint16_t off, uint32_t v);
    uint32_t i2cRead(uint16_t off);
    void     i2cWrite(uint16_t off, uint32_t v);
    uint32_t uartRead(uint16_t off);
    void     uartWrite(uint16_t off, uint32_t v);
    uint32_t spuRead(uint16_t off);
    void     spuWrite(uint16_t off, uint32_t v);

    void setSrc(int n, bool on);
    int  firstPending() const;      // -1 se nada; senão 0..39

    double _audioAcc = 0.0;

private:
    void note(uint32_t o, bool write);
    uint16_t i2cSlaveRead(uint16_t addr);
};

} // namespace hyperscan
