import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
const total = +process.env.MAXI || 100e6, step = 5e6, pcs = [];
for (let d = 0; d < total && !m.error; d += step) { m.run(step); pcs.push(m.cpu.pc.toString(16)); }
console.log('instr', m.cpu.cycles, 'quadros', m.io.frames, 'pcs', pcs.join(' '));
if (m.error) console.log('PARADA:', m.error);
console.log('UART:', JSON.stringify(m.uart));
const r = [...m.io.unmodeled.entries()].sort((a, b) => b[1] - a[1]);
console.log('não modelados (leituras):', r.filter(e => e[0].endsWith('R')).slice(0, 15).map(e => e.join('=')).join(' '));
console.log('não modelados (escritas):', r.filter(e => e[0].endsWith('W')).length, 'endereços');
