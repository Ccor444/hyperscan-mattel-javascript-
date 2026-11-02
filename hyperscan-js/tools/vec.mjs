import fs from 'fs';
import { Bus } from '../src/bus.js'; import { SCore7 } from '../src/cpu.js'; import { IO } from '../src/io.js';
const bios = new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin'));
const bus = new Bus({ bios }), cpu = new SCore7(bus); new IO().attach(bus); cpu.reset(0x9f000000);
for (let i = 0; i < 5e6; i++) cpu.step();
const dv = bus.dv; const out = [];
for (let v = 0; v < 256; v++) {
  const w = dv.getUint32(v * 4, true), P = (((w >>> 16) & 0x7fff) << 15 | (w & 0x7fff)) >>> 0;
  if ((w & 0x8000) && (P >>> 25) === 4) {
    let d = (((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe); d = (d << 12) >> 12;
    out.push(`vec ${v} (0x${(v*4).toString(16)}): b -> 0x${((v * 4 + d) >>> 0).toString(16)}`);
  } else if (w !== 0x80008000 && w !== 0) out.push(`vec ${v}: raw ${w.toString(16)}`);
}
console.log(out.join('\n'));
