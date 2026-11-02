// Fuzz diferencial: o mesmo programa aleatório (em RAM, com laços e escritas no próprio código) roda com e sem JIT; o estado tem que bater.
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { rng, word } from './gen.mjs';
const seeds = +process.argv[2] || 100, rounds = +process.argv[3] || 40, thr = +process.argv[4] || 1;
const BASE = 0xa0100000, SPAN = 0x800;
let bad = 0, jitIns = 0, errs = 0, inval = 0;
const bios = new Uint8Array(4096);
function gen(R, pc) {
  let w = word(R);
  if (w & 0x8000) {                       // 32 bits: restringe alvos de salto/desvio à região
    const hi = (w >>> 16) & 0x7fff, lo = w & 0x7fff; let P = ((hi << 15) | lo) >>> 0; const op = P >>> 25;
    if (op === 4) { const r = R(); const off = (r % 128) - 32; const o20 = (off * 2) & 0xfffff; P = ((P & ~((0x3ff << 15) | 0x3fe)) | ((((o20 >> 10) & 0x3ff)) << 15) | (o20 & 0x3fe)) >>> 0; }
    if (op === 2) { const t = (BASE + (R() % SPAN & ~1)) >>> 0; P = ((P & ~0x1fffffe) | (t & 0x1fffffe)) >>> 0; }
    const lo2 = P & 0x7fff, hi2 = (P >>> 15) & 0x7fff;
    return ((w & 0x80000000) | (hi2 << 16) | 0x8000 | lo2) >>> 0;
  }
  return w;
}
for (let seed = 1; seed <= seeds; seed++) {
  const R = rng(seed * 7919);
  const a = await WS.create(bios, { jit: false, idleSkip: false }), b = await WS.create(bios, { jit: true, jitThreshold: thr, idleSkip: false });
  for (const m of [a, b]) m.x.hs_dbg_set_pc(m.h, BASE);
  const words = []; for (let i = 0; i < SPAN / 4; i++) words.push(gen(R, BASE + i * 4));
  const regs = []; for (let i = 0; i < 32; i++) regs.push((R() % 3 === 0) ? R() : (BASE + (R() % SPAN)) | 0);
  for (const m of [a, b]) {
    words.forEach((w, i) => m.x.hs_dbg_bus_write(m.h, BASE + i * 4, w, 4));
    regs.forEach((v, i) => m.x.hs_dbg_set_reg(m.h, i, v));
    m.x.hs_dbg_set_pc(m.h, BASE);
  }
  let ok = true;
  for (let r = 0; r < rounds && ok; r++) {
    const n = [1, 7, 37, 500, 1500, 3000][R() % 6];
    a.run(n); b.run(n);
    const d = [];
    const g = (m, w, i) => m.x.hs_dbg_cpu(m.h, w, i);
    for (let i = 0; i < 32; i++) { if (g(a, 0, i) !== g(b, 0, i)) d.push('r' + i); if (g(a, 1, i) !== g(b, 1, i)) d.push('cr' + i); if (g(a, 2, i) !== g(b, 2, i)) d.push('sr' + i); }
    for (const [w, nm] of [[3, 'cel'], [4, 'ceh'], [5, 'flags'], [6, 'pc'], [7, 'cycles']]) if (g(a, w, 0) !== g(b, w, 0)) d.push(nm + ' ' + g(a, w, 0) + ' vs ' + g(b, w, 0));
    if ((a.error || '') !== (b.error || '')) d.push('error ' + a.error + ' | ' + b.error);
    // memória (região de código + alguns endereços)
    for (let i = 0; i < SPAN / 4 + 16; i++) if (a.x.hs_dbg_bus_read(a.h, BASE + i * 4, 4) !== b.x.hs_dbg_bus_read(b.h, BASE + i * 4, 4)) { d.push('mem@' + (BASE + i * 4).toString(16)); break; }
    if (d.length) { console.log(`seed ${seed} round ${r} n=${n}:`, d.slice(0, 8).join(', ')); bad++; ok = false; }
    if (a.error) { errs++; break; }
  }
  const s = b.jitStats(); jitIns += s.jitInstrs; inval += s.invalidations;
  a.destroy(); b.destroy();
}
console.log(`seeds=${seeds} thr=${thr} divergiu=${bad} paradasPorOpDesconhecido=${errs} instrEmJIT=${jitIns} invalidacoes=${inval}`);
