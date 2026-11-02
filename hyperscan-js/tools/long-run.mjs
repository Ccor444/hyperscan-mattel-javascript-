import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const str = (p) => { let s = ''; for (let i = 0; i < 70; i++) { const c = m.bus.r8(p + i); if (!c) break; s += String.fromCharCode(c); } return s; };
const opens = [];
const prev = m.cpu.hooks.get(0xa0025f44);
m.cpu.addHook(0xa0025f44, (c) => { if (c.r[4]) opens.push(`${(c.cycles / 1e6) | 0}M ${str(c.r[4] >>> 0)}`); return prev(c); });
const T = (process.env.AT || '1800e6,2400e6').split(',').map(Number); let k = 0;
for (const t of T) {
  m.run(t - m.cpu.cycles);
  const [W, H] = m.screenSize(); const out = new Uint8ClampedArray(W * H * 4); m.renderTo({ data: out });
  let nz = 0; for (let i = 0; i < out.length; i += 4) if (out[i] | out[i + 1] | out[i + 2]) nz++;
  const rgb = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) { rgb[i * 3] = out[i * 4]; rgb[i * 3 + 1] = out[i * 4 + 1]; rgb[i * 3 + 2] = out[i * 4 + 2]; }
  fs.writeFileSync(`/tmp/long${k}.ppm`, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), rgb]));
  console.log(`t=${t / 1e6}M ${W}x${H} px=${nz} pc=${m.cpu.pc.toString(16)} ctrl=${(m.io.ppu.get(0) || 0).toString(16)} T1ctl=${(m.io.ppu.get(0x2c) || 0).toString(16)} T2ctl=${(m.io.ppu.get(0x48) || 0).toString(16)} T3ctl=${(m.io.ppu.get(0x64) || 0).toString(16)} spmax=${m.io.ppu.get(8)}`);
  k++;
}
console.log('aberturas de arquivo:\n' + opens.join('\n'));
