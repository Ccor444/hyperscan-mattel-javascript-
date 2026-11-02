import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { rng, word } from './gen.mjs';
// código que se reescreve sem parar: a tabela de funções não pode crescer sem limite
const BASE = 0xa0100000;
const m = await WS.create(new Uint8Array(4096), { jit: true, jitThreshold: 1, idleSkip: false });
const R = rng(12345); const tbl = m.x.__indirect_function_table; const t0 = tbl.length;
for (let round = 0; round < 3000; round++) {
  for (let i = 0; i < 128; i++) m.x.hs_dbg_bus_write(m.h, BASE + i * 4, word(R), 4);
  for (let i = 0; i < 32; i++) m.x.hs_dbg_set_reg(m.h, i, BASE + (R() % 512));
  m.x.hs_dbg_set_pc(m.h, BASE); m.run(4000); if (m.error) { m.reset(); m.x.hs_dbg_set_pc(m.h, BASE); }
}
console.log('tabela:', t0, '->', tbl.length, JSON.stringify(m.jitStats()));
