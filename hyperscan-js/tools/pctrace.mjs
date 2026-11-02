// Imprime os próximos N PCs executados após WARM instruções (use com a listagem /tmp/bios.dis).
import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
m.run(+process.env.WARM || 100e6);
const out = [];
for (let i = 0; i < (+process.env.N || 120); i++) { out.push((m.cpu.pc >>> 0).toString(16)); m.cpu.step(); }
console.log(out.join(' '));
const c = m.cpu; console.log('r1', (c.r[1]>>>0).toString(16), 'r4', (c.r[4]>>>0).toString(16), 'r5', (c.r[5]>>>0).toString(16), 'sp', (c.r[0]>>>0).toString(16), 'cr0', c.cr[0].toString(16));
