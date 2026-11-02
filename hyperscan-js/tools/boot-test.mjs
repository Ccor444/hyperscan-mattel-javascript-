import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.argv[2] || '/mnt/user-data/uploads/hyperscan.bin')));
let uart = ''; m.io.onUartChar = c => { uart += String.fromCharCode(c); };
const pcs = new Map(); const t0 = Date.now(); const N = +process.env.MAXI || 20e6; const step = 100000;
for (let done = 0; done < N && !m.error; done += step) { m.run(step); const k = m.cpu.pc >>> 8; pcs.set(k, (pcs.get(k) || 0) + 1); }
const c = m.cpu, gp = c.r[28] >>> 0;
console.log(`tempo ${(Date.now() - t0) / 1000}s instr=${c.cycles} quadros=${m.io.frames} pc=${c.pc.toString(16)} ${m.error ? 'ERRO: ' + m.error : ''}`);
console.log('UART:', JSON.stringify(uart));
console.log('tick [gp-15468]=', m.bus.r16(gp - 15468), ' [gp-15480]=', m.bus.r16(gp - 15480));
console.log('regiões de PC mais visitadas:', [...pcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => (k << 8).toString(16) + 'x' + v).join(' '));
const un = [...m.io.unmodeled.entries()].sort((a, b) => b[1] - a[1]);
console.log('regs não modelados:', un.length, un.slice(0, 40).map(e => e[0] + '×' + e[1]).join(' '));
