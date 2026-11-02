import fs from 'fs';
import { HyperScan } from '/mnt/user-data/outputs/hyperscan-js/src/hyperscan.js';
import * as NEW from '/mnt/user-data/outputs/hyperscan-js/src/ppu.js';
import * as OLD from './ppu_reference.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const st = () => m.bus.r32(0xa0154e30 - 14332);
const until = (p, max) => { while (!p() && m.cpu.cycles < max) m.run(1e6); };
let fails = 0, cases = 0;
function cmp(tag) {
  const [W, H] = NEW.ppuSize(m); const a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4);
  const ra = OLD.renderPPU(m, a), rb = NEW.renderPPU(m, b); cases++;
  let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  console.log(`${tag.padEnd(14)} ${W}x${H} bytes diferentes=${diff} (drew old=${ra} new=${rb})`); if (diff) fails++;
}
until(() => st() === 35, 4000e6); cmp('menu');
let f0 = m.io.frames; while (m.io.frames < f0 + 60) m.run(100000); cmp('menu+60q');
m.setPad(0, { in0: 2 }); f0 = m.io.frames; while (m.io.frames < f0 + 20) m.run(100000); m.setPad(0, { in0: 0 });
until(() => st() === 15, 4000e6); cmp('scan card');
m.insertCard(5, 1); f0 = m.io.frames; while (m.io.frames < f0 + 90) m.run(100000); m.removeCard();
until(() => st() === 29, 4000e6); f0 = m.io.frames; while (m.io.frames < f0 + 100) m.run(100000); cmp('fase');
for (let k = 0; k < 3; k++) { f0 = m.io.frames; while (m.io.frames < f0 + 7) m.run(100000); cmp('fase +7q #' + k); }
console.log(fails === 0 ? `OK   ${cases} comparações idênticas` : `FALHA ${fails} de ${cases} diferem`);
