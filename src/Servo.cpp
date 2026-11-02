#include "Servo.h"
#include "SCore7.h"          // ← necessário: acessamos cpu->r[3]
#include <cstdio>

namespace hyperscan {

Servo::Servo() {
    reg[0x79] = 0xa0;
    r79[0xa002de34] = 0x20;
}

void Servo::note(const std::string& s) {
    if (trace && log.size() < logMax) log.push_back(s);
}

void Servo::mailbox(uint8_t cmd) {
    uint32_t a = ((uint32_t)reg[0x500] << 8) | reg[0x501];
    switch (cmd) {
        case 0x02: im[a & 0xffff] = reg[0x502] | (reg[0x503] << 8) | (reg[0x504] << 16); break;
        case 0x12: pm[a & 0xffff] = reg[0x502] | (reg[0x503] << 8); break;
        case 0x03: { uint32_t v = im[a & 0xffff]; reg[0x507] = v & 0xff; reg[0x508] = (v >> 8) & 0xff; reg[0x509] = (v >> 16) & 0xff; break; }
        case 0x13: { uint32_t v = pm[a & 0xffff]; reg[0x507] = v & 0xff; reg[0x508] = (v >> 8) & 0xff; reg[0x509] = 0; break; }
    }
}

void Servo::command(uint8_t v) {
    if (cmdLog.size() < 200) {
        char buf[128];
        std::snprintf(buf, sizeof(buf), "cmd 0x40d=%x p409=%x p40a=%x p40b=%x p40c=%x p40e=%x",
                      v, reg[0x409], reg[0x40a], reg[0x40b], reg[0x40c], reg[0x40e]);
        cmdLog.emplace_back(buf);
    }
}

uint32_t Servo::read(uint16_t off) {
    switch (off) {
        case 0x04: return addr;
        case 0x08: return data;
        case 0x0c: return ctrl;
    }
    auto it = other.find(off);
    uint32_t v = it != other.end() ? it->second : 0;
    if (trace) { char buf[64]; std::snprintf(buf, sizeof(buf), "R other +%x -> %x", off, v); note(buf); }
    return v;
}

void Servo::write(uint16_t off, uint32_t v) {
    switch (off) {
        case 0x04: addr = (uint16_t)(v & 0xfff); return;
        case 0x08: data = (uint8_t)(v & 0xff); return;
        case 0x0c: {
            if ((v & 0xff) == 0) {
                uint8_t old = reg[addr];
                uint8_t val = data;
                if (writeHook) { auto r = writeHook(addr, val, *this); if (r) val = *r; }
                reg[addr] = val;
                if (addr == 0x505) mailbox(val);
                if (addr == 0x40d && (val & 0x80)) { command(val); val &= 0x3f; reg[addr] = val; }
                if (trace) { char buf[64]; std::snprintf(buf, sizeof(buf), "W reg[%x] = %x (era %x)", addr, val, old); note(buf); }
            } else if ((v & 0xff) == 1) {
                uint8_t val = reg[addr];
                if (addr == 0x79 && cpu) {
                    auto it = r79.find((uint32_t)cpu->r[3]);
                    if (it != r79.end()) val = it->second;
                }
                if (addr == 0x7d && reg[0x30] == 2) val = 0x30;
                if (readHook) { auto r = readHook(addr, val, *this); if (r) val = *r; }
                data = val;
                if (trace) { char buf[64]; std::snprintf(buf, sizeof(buf), "R reg[%x] -> %x", addr, val); note(buf); }
            }
            ctrl = 0; return;
        }
    }
    other[off] = v;
    if (trace) { char buf[64]; std::snprintf(buf, sizeof(buf), "W other +%x = %x", off, v); note(buf); }
}

} // namespace hyperscan
