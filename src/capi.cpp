// API C do módulo WASM (sem Embind/Emscripten): funciona com wasi-sdk, clang --target=wasm32 ou emcc (-sSTANDALONE_WASM).
// O JS (wasm/hyperscan-wasm.js) chama estas funções; ponteiros são offsets na memória linear do módulo.
#include "HyperScan.h"
#include "Disc.h"
#include "SPU.h"
#include "Jit.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>

using namespace hyperscan;

#define HS_EXPORT(name) extern "C" __attribute__((used, visibility("default"), export_name(#name)))

static inline HyperScan* M(uintptr_t h) { return reinterpret_cast<HyperScan*>(h); }

// ---- memória ----------------------------------------------------------------------------------------------------
HS_EXPORT(hs_malloc) uint32_t hs_malloc(uint32_t n) { return (uint32_t)(uintptr_t)std::malloc(n ? n : 1); }
HS_EXPORT(hs_free)   void     hs_free(uint32_t p)   { std::free((void*)(uintptr_t)p); }

// ---- ciclo de vida ----------------------------------------------------------------------------------------------
HS_EXPORT(hs_create) uint32_t hs_create(uint32_t bios, uint32_t len, int fastBoot, int idleSkip, int fastPaths) {
    return (uint32_t)(uintptr_t)new HyperScan((const uint8_t*)(uintptr_t)bios, len, fastBoot != 0, idleSkip != 0, fastPaths != 0);
}
HS_EXPORT(hs_destroy) void hs_destroy(uint32_t h) { delete M(h); }
HS_EXPORT(hs_reset)   void hs_reset(uint32_t h)   { M(h)->reset(); }
HS_EXPORT(hs_run)     void hs_run(uint32_t h, int n) { M(h)->run(n); }

// ---- disco ------------------------------------------------------------------------------------------------------
HS_EXPORT(hs_disc_buffer) uint32_t hs_disc_buffer(uint32_t h, uint32_t len) { return (uint32_t)(uintptr_t)M(h)->discBuffer(len); }
HS_EXPORT(hs_disc_commit) void     hs_disc_commit(uint32_t h) { M(h)->discCommit(); }
HS_EXPORT(hs_disc_insert) void     hs_disc_insert(uint32_t h, uint32_t p, uint32_t len) { M(h)->insertDisc((const uint8_t*)(uintptr_t)p, len); }
HS_EXPORT(hs_has_disc)    int      hs_has_disc(uint32_t h) { return M(h)->hasDisc(); }
HS_EXPORT(hs_disc_sectors) uint32_t hs_disc_sectors(uint32_t h) { return M(h)->discSectors(); }
HS_EXPORT(hs_disc_volume_ptr) uint32_t hs_disc_volume_ptr(uint32_t h) { return (uint32_t)(uintptr_t)M(h)->discVolumeId().data(); }
HS_EXPORT(hs_disc_volume_len) uint32_t hs_disc_volume_len(uint32_t h) { return (uint32_t)M(h)->discVolumeId().size(); }
HS_EXPORT(hs_cdhle_active) int     hs_cdhle_active(uint32_t h) { return M(h)->cdHleActive(); }
HS_EXPORT(hs_cd_reads)    double   hs_cd_reads(uint32_t h) { return M(h)->cdReads(); }
HS_EXPORT(hs_cd_bytes)    double   hs_cd_bytes(uint32_t h) { return M(h)->cdBytes(); }

// ---- vídeo / entrada --------------------------------------------------------------------------------------------
HS_EXPORT(hs_render)   uint32_t hs_render(uint32_t h) { return M(h)->render(); }
HS_EXPORT(hs_screen_w) int hs_screen_w(uint32_t h) { return M(h)->screenWidth(); }
HS_EXPORT(hs_screen_h) int hs_screen_h(uint32_t h) { return M(h)->screenHeight(); }
HS_EXPORT(hs_set_pad)  void hs_set_pad(uint32_t h, int port, int in0, int in1, int ax, int ay) { M(h)->setPad(port, in0, in1, ax, ay); }
HS_EXPORT(hs_insert_card) void hs_insert_card(uint32_t h, int set, int num) { M(h)->insertCard(set, num); }
HS_EXPORT(hs_remove_card) void hs_remove_card(uint32_t h) { M(h)->removeCard(); }

// ---- status -----------------------------------------------------------------------------------------------------
HS_EXPORT(hs_pc)      uint32_t hs_pc(uint32_t h) { return M(h)->pc(); }
HS_EXPORT(hs_cycles)  double   hs_cycles(uint32_t h) { return M(h)->cycles(); }
HS_EXPORT(hs_frames)  double   hs_frames(uint32_t h) { return M(h)->frames(); }
HS_EXPORT(hs_reg)     int32_t  hs_reg(uint32_t h, int i) { return M(h)->reg(i); }
HS_EXPORT(hs_error_ptr)  uint32_t hs_error_ptr(uint32_t h) { return (uint32_t)(uintptr_t)M(h)->error().data(); }
HS_EXPORT(hs_error_len)  uint32_t hs_error_len(uint32_t h) { return (uint32_t)M(h)->error().size(); }
HS_EXPORT(hs_uart_ptr)   uint32_t hs_uart_ptr(uint32_t h) { return (uint32_t)(uintptr_t)M(h)->uart().data(); }
HS_EXPORT(hs_uart_len)   uint32_t hs_uart_len(uint32_t h) { return (uint32_t)M(h)->uart().size(); }

// ---- save state -------------------------------------------------------------------------------------------------
HS_EXPORT(hs_state_save)  uint32_t hs_state_save(uint32_t h) { return (uint32_t)M(h)->saveState(); }
HS_EXPORT(hs_state_ptr)   uint32_t hs_state_ptr(uint32_t h) { return M(h)->saveStatePtr(); }
HS_EXPORT(hs_state_free)  void     hs_state_free(uint32_t h) { M(h)->saveStateFree(); }
HS_EXPORT(hs_state_load)  int      hs_state_load(uint32_t h, uint32_t p, uint32_t len) { return M(h)->loadState((const uint8_t*)(uintptr_t)p, len); }
HS_EXPORT(hs_state_error_ptr) uint32_t hs_state_error_ptr(uint32_t h) { return (uint32_t)(uintptr_t)M(h)->stateError().data(); }
HS_EXPORT(hs_state_error_len) uint32_t hs_state_error_len(uint32_t h) { return (uint32_t)M(h)->stateError().size(); }

// ---- áudio ------------------------------------------------------------------------------------------------------
HS_EXPORT(hs_audio_buffered) int hs_audio_buffered(uint32_t h) { return M(h)->audioBuffered(); }
HS_EXPORT(hs_audio_pull)     int hs_audio_pull(uint32_t h, int n, double ratio) { return M(h)->pullAudio(n, ratio); }
HS_EXPORT(hs_audio_ptr)      uint32_t hs_audio_ptr(uint32_t h) { return M(h)->audioPtr(); }

// ---- diagnóstico (usado pelos testes de equivalência JS x WASM) -------------------------------------------------
HS_EXPORT(hs_dbg_bus_read)  uint32_t hs_dbg_bus_read(uint32_t h, uint32_t a, int sz) { return M(h)->bus_.read(a, sz); }
HS_EXPORT(hs_dbg_bus_write) void hs_dbg_bus_write(uint32_t h, uint32_t a, uint32_t v, int sz) { M(h)->bus_.write(a, v, sz); }
HS_EXPORT(hs_dbg_set_reg)   void hs_dbg_set_reg(uint32_t h, int i, int32_t v) { M(h)->cpu_.r[i & 31] = v; }
HS_EXPORT(hs_dbg_set_pc)    void hs_dbg_set_pc(uint32_t h, uint32_t pc) { M(h)->cpu_.pc = pc; }
HS_EXPORT(hs_dbg_cpu)       double hs_dbg_cpu(uint32_t h, int what, int i) {
    SCore7& c = M(h)->cpu_;
    switch (what) {
        case 0: return c.r[i & 31];
        case 1: return c.cr[i & 31];
        case 2: return c.sr[i & 31];
        case 3: return c.cel;
        case 4: return c.ceh;
        case 5: return c.N | (c.Z << 1) | (c.C << 2) | (c.V << 3) | (c.T << 4);
        case 6: return c.pc;
        case 7: return c.cycles;
    }
    return 0;
}
HS_EXPORT(hs_dbg_set_cr)    void hs_dbg_set_cr(uint32_t h, int i, uint32_t v) { M(h)->cpu_.cr[i & 31] = v; }
HS_EXPORT(hs_dbg_io_tick)   void hs_dbg_io_tick(uint32_t h, double cycles) { M(h)->io_.tick(cycles); }
HS_EXPORT(hs_dbg_io_get)    double hs_dbg_io_get(uint32_t h, int what) {
    IO& io = M(h)->io_;
    switch (what) {
        case 0: return io.asserted[0];
        case 1: return io.asserted[1];
        case 2: return io.mask[0];
        case 3: return io.frameCycles;
        case 4: return (double)io.frames;
        case 5: return io.frameLen;
        case 6: return io.ppuStatus;
        case 7: return io.i2c.busy;
    }
    return 0;
}
HS_EXPORT(hs_dbg_set_frame_len) void hs_dbg_set_frame_len(uint32_t h, double v) { M(h)->io_.frameLen = v; }
HS_EXPORT(hs_dbg_stats)     double hs_dbg_stats(uint32_t h, int what) {
    HyperScan* m = M(h);
    switch (what) {
        case 0: return (double)m->idle_.skips;
        case 1: return (double)m->idle_.cycles;
        case 2: return (double)m->fast_.blits;
        case 3: return (double)m->cdhle_.toc;
        case 4: return (double)m->cdhle_.miss;
        case 5: return (double)m->cdhle_.nullOpen;
        case 6: return (double)m->cdhle_.cardReads;
    }
    return 0;
}
HS_EXPORT(hs_dbg_spu_sync)  void hs_dbg_spu_sync(uint32_t h) { M(h)->io_.spuChip->sync(); }
HS_EXPORT(hs_dbg_spu_peak)  double hs_dbg_spu_peak(uint32_t h) { return M(h)->io_.spuChip->peak; }

// ---- JIT (protocolo com o loader JS) -----------------------------------------------------------------------------
// config: enable (0/1), threshold (execuções de um alvo de desvio antes de traduzir)
HS_EXPORT(hs_jit_config)  void hs_jit_config(uint32_t h, int enable, int threshold, int sync) {
    Jit& j = M(h)->cpu_.jit();
    j.sync = sync != 0;
    j.enabled = enable != 0 && sizeof(void*) == 4;
    if (threshold > 0) j.threshold = (uint32_t)threshold;
    if (!enable) j.flush();
}
HS_EXPORT(hs_jit_pending_ptr)    uint32_t hs_jit_pending_ptr(uint32_t h)    { return (uint32_t)(uintptr_t)M(h)->cpu_.jit().pendingPtr(); }
HS_EXPORT(hs_jit_pending_len)    uint32_t hs_jit_pending_len(uint32_t h)    { return M(h)->cpu_.jit().pendingLen(); }
HS_EXPORT(hs_jit_pending_blocks) uint32_t hs_jit_pending_blocks(uint32_t h) { return M(h)->cpu_.jit().pendingBlocks(); }
HS_EXPORT(hs_jit_install) void hs_jit_install(uint32_t h, uint32_t i, uint32_t tableIdx) { M(h)->cpu_.jit().install(i, tableIdx); }
HS_EXPORT(hs_jit_ack)     void hs_jit_ack(uint32_t h)  { M(h)->cpu_.jit().ack(); }
HS_EXPORT(hs_jit_fail)    void hs_jit_fail(uint32_t h) { M(h)->cpu_.jit().fail(); }
HS_EXPORT(hs_jit_stat)    double hs_jit_stat(uint32_t h, int what) {
    Jit& j = M(h)->cpu_.jit();
    switch (what) {
        case 0: return j.statBlocks;  case 1: return j.statInstrs;  case 2: return j.statModules; case 3: return j.statInstalled;
        case 11: return (double)j.statIo; case 9: return (double)j.statBudget; case 10: return (double)j.statNoFn; case 7: return (double)j.statJitIns; case 8: return (double)j.statJitCalls; case 4: return j.statInval;   case 5: return j.enabled;     case 6: return j.pendingLen();
    }
    return 0;
}
// pares (chave, contagem) das instruções que caem no interpretador: devolve a i-ésima chave (ordenada por contagem) ou -1
HS_EXPORT(hs_jit_fallback) double hs_jit_fallback(uint32_t h, int i, int wantCount) {
    Jit& j = M(h)->cpu_.jit();
    std::vector<std::pair<uint32_t, uint32_t>> v(j.fallbackOps.begin(), j.fallbackOps.end());
    std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.second > b.second; });
    if (i < 0 || (size_t)i >= v.size()) return -1;
    return wantCount ? (double)v[i].second : (double)v[i].first;
}
// chamadas feitas pelo wasm gerado (ctx = ponteiro do Jit)
HS_EXPORT(hs_jit_rd)     uint32_t hs_jit_rd(uint32_t ctx, uint32_t a, uint32_t sz) { return reinterpret_cast<Jit*>(ctx)->rd(a, sz); }
HS_EXPORT(hs_jit_wr)     void hs_jit_wr(uint32_t ctx, uint32_t a, uint32_t v, uint32_t sz) { reinterpret_cast<Jit*>(ctx)->wr(a, v, sz); }
HS_EXPORT(hs_jit_inv)    void hs_jit_inv(uint32_t ctx, uint32_t off, uint32_t sz) { reinterpret_cast<Jit*>(ctx)->invalidateRange(off, sz); }
HS_EXPORT(hs_jit_interp) uint32_t hs_jit_interp(uint32_t ctx, uint32_t pc) { return reinterpret_cast<Jit*>(ctx)->interp(pc); }
// blocos mais pesados (execuções x instruções) desde o último reset: i-ésimo; what 0=pc 1=peso 2=n
HS_EXPORT(hs_jit_top) double hs_jit_top(uint32_t h, int i, int what) {
    Jit& j = M(h)->cpu_.jit();
    std::vector<std::pair<double, uint32_t>> v;
    const auto& bl = j.allBlocks();
    for (uint32_t k = 0; k < bl.size(); ++k) if (bl[k].hits) v.push_back({(double)bl[k].hits * bl[k].n, k});
    std::partial_sort(v.begin(), v.begin() + std::min<size_t>(v.size(), (size_t)i + 1), v.end(), [](auto& a, auto& b) { return a.first > b.first; });
    if (i < 0 || (size_t)i >= v.size()) return -1;
    const auto& b = bl[v[i].second];
    return what == 0 ? (double)b.pc : what == 1 ? v[i].first : (double)b.n;
}
HS_EXPORT(hs_jit_top_reset) void hs_jit_top_reset(uint32_t h) { M(h)->cpu_.jit().resetHits(); }
HS_EXPORT(hs_jit_profile) void hs_jit_profile(uint32_t h, int on) { M(h)->cpu_.jit().profile = on != 0; }
HS_EXPORT(hs_jit_hist) double hs_jit_hist(uint32_t h, int i, int wantCount) {
    Jit& j = M(h)->cpu_.jit();
    std::vector<std::pair<uint32_t, uint32_t>> v(j.hist.begin(), j.hist.end());
    std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.second > b.second; });
    if (i < 0 || (size_t)i >= v.size()) return -1;
    return wantCount ? (double)v[i].second : (double)v[i].first;
}
HS_EXPORT(hs_jit_probe) int hs_jit_probe(uint32_t h, uint32_t pc) {
    Jit& j = M(h)->cpu_.jit();
    auto* b = j.find(pc);
    if (!b) return 0;
    if (b->n == 0) return 1;
    return b->fn ? 3 : 2;
}
HS_EXPORT(hs_jit_dbg) void hs_jit_dbg(uint32_t m) { g_jitDbg = m; }
HS_EXPORT(hs_jit_free_slot) uint32_t hs_jit_free_slot(uint32_t h) { return M(h)->cpu_.jit().takeFreeSlot(); }
