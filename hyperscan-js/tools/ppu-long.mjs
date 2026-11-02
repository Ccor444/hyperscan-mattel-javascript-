import fs from 'fs';
import { HyperScan } from '/mnt/user-data/outputs/hyperscan-js/src/hyperscan.js';
import * as NEW from '/mnt/user-data/outputs/hyperscan-js/src/ppu.js';
import * as OLD from '/tmp/ppu.old.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const io = m.io, st = () => m.bus.r32(0xa0154e30 - 14332);
const until = (p, max) => { while (!p() && m.cpu.cycles < max && !m.error) m.run(1e6); };
const frames = n => { const f = io.frames + n; while (io.frames < f && !m.error) m.run(100000); };
until(() => st() === 35, 4000e6); frames(120); m.setPad(0, { in0: 2 }); frames(30); m.setPad(0, { in0: 0 });
until(() => st() === 15, 4000e6); frames(60); m.insertCard(5, 1); frames(90); m.removeCard(); until(() => st() === 29, 4000e6);
let diffFrames = 0, checks = 0, first = null;
for (let k = 0; k < 60; k++) {
  frames(15);
  const [W, H] = NEW.ppuSize(m); const a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4);
  OLD.renderPPU(m, a); NEW.renderPPU(m, b); checks++;
  let d = 0, mx = -1; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { d++; if (mx < 0) mx = i; }
  if (d) { diffFrames++; if (!first) first = `q${io.frames} px=${(mx>>2)%W},${Math.floor((mx>>2)/W)} bytes=${d}`; }
}
console.log(`verificações=${checks} quadros com diferença=${diffFrames} primeira: ${first || 'nenhuma'}`);
