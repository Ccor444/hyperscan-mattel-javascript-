// Perfil de PC por região (0x100 bytes) depois de um aquecimento: mostra onde o BIOS gasta tempo.
import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
const N = +process.env.MAXI || 60e6, h = new Map();
for (let d = 0; d < N && !m.error; d += 1000) { m.run(1000); const k = (m.cpu.pc >>> 0) & ~0xff; h.set(k, (h.get(k) || 0) + 1); }
console.log('instr', m.cpu.cycles, 'quadros', m.io.frames, m.error || '');
console.log([...h.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k.toString(16) + ':' + v).join(' '));
const gp = m.cpu.r[28] >>> 0;
console.log('gp', gp.toString(16), 'lhu[gp-15468]', m.bus.r16(gp - 15468), 'lhu[gp-15480]', m.bus.r16(gp - 15480));
