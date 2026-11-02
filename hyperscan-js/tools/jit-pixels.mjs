import fs from 'fs';
import crypto from 'crypto';
import { HyperScan } from '/mnt/user-data/outputs/hyperscan-js/src/hyperscan.js';
const mode = process.env.JIT === '0' ? 0 : 1;
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')), { fastPaths: false });
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
m.cpu.useJit = !!mode;
const io = m.io, st = () => m.bus.r32(0xa0154e30 - 14332);
const until = (p, max) => { while (!p() && m.cpu.cycles < max && !m.error) m.run(1e6); };
const frames = n => { const f = io.frames + n; while (io.frames < f && !m.error) m.run(100000); };
until(() => st() === 35, 4000e6); frames(120); m.setPad(0, { in0: 2 }); frames(30); m.setPad(0, { in0: 0 });
until(() => st() === 15, 4000e6); frames(60); m.insertCard(5, 1); frames(90); m.removeCard(); until(() => st() === 29, 4000e6);
const out = [];
for (let k = 0; k < 6; k++) {
  frames(200);
  const [W, H] = m.screenSize(), px = new Uint8ClampedArray(W * H * 4); m.renderTo({ data: px });
  out.push(`q${io.frames}:${crypto.createHash('md5').update(px).digest('hex').slice(0, 10)}`);
}
console.log(`JIT=${mode} estado=${st()} ${out.join(' ')} erro=${m.error || 'nenhum'}`);
