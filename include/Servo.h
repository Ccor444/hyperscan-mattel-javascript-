#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace hyperscan {

class SCore7; // fwd

class Servo {
public:
    Servo();

    // read/write recebem o valor/offset completos do barramento, como no JS (ADDR tem 12 bits; `other` guarda o valor escrito inteiro).
    uint32_t read(uint16_t off);
    void     write(uint16_t off, uint32_t v);

    using HookRead  = std::function<std::optional<uint8_t>(uint16_t addr, uint8_t val, Servo&)>;
    using HookWrite = std::function<std::optional<uint8_t>(uint16_t addr, uint8_t val, Servo&)>;
    HookRead  readHook;
    HookWrite writeHook;

    // Estado de registradores
    // addr é 12 bits (0..0xfff), como no JS (`this.addr = v & 0xfff`).
    std::array<uint8_t, 0x1000> reg{};
    uint16_t addr = 0;
    uint8_t  data = 0;
    uint8_t  ctrl = 0;

    SCore7* cpu = nullptr;

    // Regra: byte lido em reg 0x79 depende do endereço de retorno do driver.
    std::unordered_map<uint32_t, uint8_t> r79;
    // Outros registradores não mapeados
    std::unordered_map<uint16_t, uint32_t> other;

    // Memórias do DSP do servo (IM 24 bits / PM 16 bits)
    std::vector<uint32_t> im = std::vector<uint32_t>(0x10000, 0);
    std::vector<uint32_t> pm = std::vector<uint32_t>(0x10000, 0);

    // Diagnóstico
    std::vector<std::string> log;
    std::size_t logMax = 400;
    bool trace = false;
    std::vector<std::string> cmdLog;

private:
    void mailbox(uint8_t cmd);
    void command(uint8_t v);
    void note(const std::string& s);
};

} // namespace hyperscan
