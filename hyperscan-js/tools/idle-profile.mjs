import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
m.run(2600e6);
const c = m.cpu, h = v => (v >>> 0).toString(16);
const calls = new Map(), ex32 = c.exec32.bind(c), ex16 = c.exec16.bind(c);
c.exec32 = (pc, P, n) => { const b = c.r[3]; const x = ex32(pc, P, n); if (c.r[3] !== b) calls.set(x >>> 0, (calls.get(x >>> 0) || 0) + 1); return x; };
c.exec16 = (pc, p, n) => { const b = c.r[3]; const x = ex16(pc, p, n); if (c.r[3] !== b) calls.set(x >>> 0, (calls.get(x >>> 0) || 0) + 1); return x; };
const reg = new Map();
for (let i = 0; i < 6000; i++) { m.run(1000); const k = h((c.pc >>> 0) & ~0xff); reg.set(k, (reg.get(k) || 0) + 1); }
console.log('regiões PC:', [...reg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e.join(':')).join(' '));
console.log('chamadas:', [...calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([a, n]) => h(a) + ':' + n).join(' '));
console.log('frames', m.io.frames, 'cr0', h(c.cr[0]), 'irq pend', String(m.io.irqSrc));
