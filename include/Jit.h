#pragma once
// JIT para WebAssembly: blocos quentes da CPU S+core7 viram funções wasm.
// O C++ gera os bytes do módulo; o loader JS compila (assíncrono), instancia importando a memória do módulo principal
// e instala cada função na tabela indireta; daí o runN chama o bloco via call_indirect.
// Semântica idêntica ao interpretador (mesmo nº de instruções/ciclos, mesmas flags); o que não é traduzido
// vira chamada ao interpretador (instrução terminadora do bloco).
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace hyperscan {

extern uint32_t g_jitDbg;
class SCore7;
class Bus;

class Jit {
public:
    Jit(SCore7& cpu, Bus& bus);

    struct Block {
        uint32_t pc = 0, n = 0;
        uint32_t fn = 0;          // índice na tabela indireta (0 = ainda não instalado ou sem JIT)
        uint32_t pageLo = 0, pageHi = 0;
        bool valid = true;
        bool ram = false;
        bool loop = false;        // função recebe o orçamento restante (laço interno)
        uint32_t hits = 0;        // execuções desde o último reset do perfil
    };

    bool     enabled = false;
    uint32_t ageLimit = 1;
    bool     sync = false;      // compilar/instalar dentro de translate() (via import hs_jit_sync)
    uint32_t threshold = 20;
    uint32_t doneCell = 0;        // preenchido pelo bloco em saída antecipada (nº de instruções executadas)

    // ---- caminho quente (runN)
    Block* find(uint32_t pc) {
        FC& e = fc_[(pc >> 1) & (kFC - 1)];
        if (e.pc == pc && e.idx != kNone) return &blocks_[e.idx];
        return findSlow(pc);
    }
    bool touch(uint32_t pc) { return ++hot_[(pc >> 1) & 0xffff] >= threshold; }
    Block* translate(uint32_t pc);

    void invalidate(uint32_t pageLo, uint32_t pageHi);
    void flush();                 // descarta todos os blocos (RAM/hook mudou)
    void invalidateRange(uint32_t off, uint32_t len);

    // ---- protocolo com o JS
    void     maybeFinalize();     // fecha o módulo pendente quando há blocos suficientes / tempo suficiente
    const uint8_t* pendingPtr() const { return pending_.data(); }
    uint32_t pendingLen() const { return (uint32_t)pending_.size(); }
    uint32_t pendingBlocks() const { return (uint32_t)pendingIds_.size(); }
    void     install(uint32_t i, uint32_t tableIdx);
    void     ack();
    void     fail();

    // ---- chamados de dentro do wasm gerado
    uint32_t rd(uint32_t a, uint32_t sz);
    void     wr(uint32_t a, uint32_t v, uint32_t sz);
    uint32_t interp(uint32_t pc);

    // estatísticas
    bool profile = false;
    std::unordered_map<uint32_t, uint32_t> hist;
    uint64_t statBudget = 0, statNoFn = 0;
    uint64_t statJitIns = 0, statJitCalls = 0, statIo = 0;
    const std::vector<Block>& allBlocks() const { return blocks_; }
    void resetHits() { for (auto& b : blocks_) b.hits = 0; statIo = 0; }
    uint32_t statBlocks = 0, statInstrs = 0, statFallbacks = 0, statModules = 0, statInstalled = 0, statInval = 0;
    std::unordered_map<uint32_t, uint32_t> fallbackOps;   // opcode -> contagem (debug)

    uint32_t tableCount() const { return tableUsed_; }
    uint32_t takeFreeSlot() { if (freeSlots_.empty()) return 0; uint32_t s = freeSlots_.back(); freeSlots_.pop_back(); return s; }   // slot da tabela de blocos descartados (o JS reaproveita)

private:
    friend class Tr;
    static constexpr uint32_t kFC = 4096, kNone = 0xffffffffu;
    struct FC { uint32_t pc = 1; uint32_t idx = kNone; };

    Block* findSlow(uint32_t pc);
    void   buildModule();

    SCore7& cpu_;
    Bus& bus_;
    std::vector<Block> blocks_;
    std::unordered_map<uint32_t, uint32_t> byPc_;
    FC fc_[kFC];
    std::vector<uint16_t> hot_;
    std::vector<std::vector<uint32_t>> pageBlocks_;

    // módulo em construção
    std::vector<std::vector<uint8_t>> bodies_;
    std::vector<uint32_t> bodyIds_;
    std::vector<uint8_t> bodyLoop_;
    std::vector<uint8_t> pending_;
    std::vector<uint32_t> pendingIds_;
    bool inflight_ = false;
    uint32_t age_ = 0;
    uint32_t tableUsed_ = 0;
    std::vector<uint32_t> freeSlots_;
};

} // namespace hyperscan
