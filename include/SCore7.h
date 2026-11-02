#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <type_traits>
#include <utility>
#include <memory>
#include <vector>

namespace hyperscan {

class Bus;
class Jit;

class SCore7 {
public:
    using HookFn = bool(*)(SCore7&, void*);

    explicit SCore7(Bus& bus);
    ~SCore7();

    // Estado observável
    std::array<int32_t, 32>  r{};
    std::array<uint32_t, 32> cr{};
    std::array<uint32_t, 32> sr{};
    uint32_t cel = 0, ceh = 0;
    int  N = 0, Z = 0, C = 0, V = 0, T = 0;
    uint32_t pc = 0;
    double   cycles = 0.0;
    bool     sleeping = false;

    // Erro (substitui throw UnknownOp)
    int         error_code = 0;
    uint32_t    error_pc   = 0;
    std::string error_msg;

    void reset(uint32_t startPc);
    void runN(uint64_t n);
    void step();
    uint32_t interpretAt(uint32_t p);          // executa a instrução em p (usado pelo JIT) e devolve o próximo PC
    Jit& jit() { return *jit_; }

    // Hooks (fn pointer + ctx)
    void addHook(uint32_t addr, HookFn fn, void* ctx);

    // Overload para lambdas (usa wrapper estático + heap).
    template <typename F>
    void addHook(uint32_t addr, F&& f) {
        using T = std::decay_t<F>;
        T* heap = new T(std::forward<F>(f));
        addHook(addr,
            [](SCore7& c, void* ctx) -> bool { return (*reinterpret_cast<T*>(ctx))(c); },
            heap);
    }

    // Interrupção / RTE  ← estes estavam faltando na cópia antiga
    bool     interrupt(int src);
    uint32_t rte();

    uint32_t getCR(int i) const;
    void     setCR(int i, uint32_t v);
    void     setNZ(uint32_t v);
    int32_t  add(int32_t a, int32_t b, bool cu, int cin = 0);
    int32_t  sub(int32_t a, int32_t b, bool cu, int cin = 1);
    int32_t  logic(int32_t v, bool cu);
    bool     cond(int c, bool cnt = false);
    Bus& bus() { return bus_; }

    struct HookEntry { HookFn fn; void* ctx; };
    std::vector<HookEntry> hooks_;
    std::vector<uint8_t>   hookMask_;

private:
    Bus& bus_;
    std::unique_ptr<Jit> jit_;

    void     execOne(uint32_t pcVal);
    inline uint32_t execAt(uint32_t pcVal);
    void     exception(int code);
    void     fail(const char* what, uint32_t pcVal, uint32_t word);
    uint32_t exec32(uint32_t P, uint32_t pcVal, uint32_t nxt);
    uint32_t exec16(uint16_t h, uint32_t pcVal, uint32_t nxt);
    void     mem(int kind, int rD, uint32_t addr);
};

} // namespace hyperscan
