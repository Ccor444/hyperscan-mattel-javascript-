import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(1 << 20), dv = new DataView(bios.buffer);
// laço: 16-bit pares:  addei! r4,1 | sw! r4,[r5] | lw! r6,[r5] | add! r6,r4 | and! r6,r4 | addei! r5,... | b! -N
const h = [0x6408, 0xe0 | (4 << 8) | 0x2c00 & 0, 0, 0];
const ops = [0x6408, 0x2c45, 0x2865, 0x2064, 0x2464, 0x6418, 0x2a63, 0x2961, 0x2165, 0x6508];
// op2 fn 12 = sw! rd,[ra]: (2<<12)|(rd<<8)|(ra<<4)|12 ; fn 8 = lw!
const prog = [0x6408, (2 << 12) | (4 << 8) | (5 << 4) | 12, (2 << 12) | (6 << 8) | (5 << 4) | 8, (2 << 12) | (6 << 8) | (4 << 4) | 0, (2 << 12) | (6 << 8) | (4 << 4) | 4, 0x6419, (2 << 12) | (7 << 8) | (6 << 4) | 5, 0x5301, (2 << 12) | (4 << 8) | (7 << 4) | 7];
prog.push((4 << 12) | (15 << 8) | ((-(prog.length)) & 0xff));  // b! volta ao início
for (let i = 0; i < prog.length; i += 2) dv.setUint32(i * 2, ((prog[i + 1] ?? 0) << 16 | prog[i]) >>> 0 & 0x7fffffff | 0, true);
const setup = (m, set) => { set(5, 0xa0100000); };
const j = new JS(bios, {}), w = await WS.create(bios, {});
j.cpu.r[5] = 0xa0100000; w.x.hs_dbg_set_reg(w.h, 5, 0xa0100000 | 0);
const N = 40e6, per = 1.5e6;
for (const [name, m] of [['JS (JIT)', j], ['WASM', w]]) {
  m.run(1e6); const t = performance.now(); let n = 0; while (n < N) { m.run(per); n += per; } const dt = performance.now() - t;
  console.log(`${name}: ${(N / dt / 1000).toFixed(1)} MIPS  erro=${m.error}`);
}
console.log('regs iguais:', j.cpu.r[4] === w.reg(4) || 'diferem (execuções de tamanho diferente)');
