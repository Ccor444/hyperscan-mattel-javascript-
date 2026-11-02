import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { rng } from './gen.mjs';
const seeds = +process.argv[2] || 60;
const B = 0x88010000; let bad = 0, nzT = 0, blendRuns = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const R = rng(seed * 104729), bios = new Uint8Array(1 << 20);
  const j = new JS(bios, {}), w = await WS.create(bios, {});
  const wr = (a, v, sz = 4) => { j.bus.write(a, v >>> 0, sz); w.x.hs_dbg_bus_write(w.h, a, v >>> 0, sz); };
  const rbpp = () => (R() % 7 === 0 ? 2 : R() % 4);               // inclui 6 bpp (attr&3 == 2) com frequência
  // RAM: dados com bastante entropia + vetores de ponteiros pequenos
  for (let i = 0; i < 0x80000; i += 4) wr(0xa0300000 + i, R() & (R() % 3 ? 0xffffffff : 0x7fff7fff));
  for (let i = 0; i < 0x4000; i += 4) wr(0xa0380000 + i, (R() % 0x20000) & ~1);
  const tvmode = R() % 3; wr(0x88030000, [0, 0x1105, 0x1100, 0x1108][R() % 4], 4);
  if (R() % 3 === 0) { wr(0x88030000 + 0xc, R() % 40); }
  if (R() % 3 === 0) { wr(0x88070000, 0xa0300000); wr(0x88090020, 0); }
  wr(B + 0, 0x1000 | (R() & 3), 4); wr(B + 0xc, R() & 1); wr(B + 0x10, (R() % 2 ? 0x10000 : 0) | (R() & 0xffff));
  for (let i = 0; i < 512; i++) { wr(B + 0x1000 + 4 * i, R() & 0xffff); wr(B + 0x1800 + 4 * i, R() & 0xffff); }
  for (const [x, y, attr, ctl, ptr, bl, buf] of [[0x20, 0x24, 0x28, 0x2c, 0x30, 0x38, 0xa0], [0x3c, 0x40, 0x44, 0x48, 0x4c, 0x54, 0xac], [0x58, 0x5c, 0x60, 0x64, 0x68, 0x70, 0xb8]]) {
    wr(B + x, R() & 0x3ff); wr(B + y, R() & 0x1ff);
    wr(B + attr, (R() & 0xffff & ~3) | rbpp() | ((R() & 3) << 13 & 0x6000));
    wr(B + ctl, [0x8, 0x9, 0x8 | 0x1000, 0x9 | 0x1000, 0x108, 0x109 | 0x1000, 0xc, 0xd][R() % 8]);
    wr(B + ptr, 0xa0380000 + ((R() % 0x1000) & ~3)); wr(B + bl, R() & 0x3f); wr(B + buf, 0xa0300000 + (R() % 0x40000));
  }
  wr(B + 4, 1); wr(B + 8, R() % 40); wr(B + 0xd0, 0xa0300000 + (R() % 0x40000));
  for (let i = 0; i < 48; i++) { wr(B + 0x4000 + 8 * i, ((R() % 0x400) << 16) | (R() % 600)); wr(B + 0x4004 + 8 * i, ((R() % 0x400) << 16) | (R() & 0xffff & ~3) | rbpp() | ((R() & 3) << 13 & 0x6000)); }
  const [W, H] = j.screenSize(), [W2, H2] = w.screenSize();
  if (W !== W2 || H !== H2) { console.log('size', seed); bad++; continue; }
  const ja = { data: new Uint8ClampedArray(W * H * 4) }, wa = { data: new Uint8ClampedArray(W * H * 4) };
  j.renderTo(ja); w.renderTo(wa);
  let nd = 0, first = -1, nz = 0; for (let i = 0; i < ja.data.length; i++) { if (ja.data[i] !== wa.data[i]) { nd++; if (first < 0) first = i; } if (i % 4 < 3 && ja.data[i]) nz++; }
  nzT += nz; if (nd) { bad++; console.log(`seed ${seed}: ${nd} bytes diferem (1º em ${first}: js=${ja.data[first]} wasm=${wa.data[first]}) ${W}x${H} nz=${nz}`); }
  w.destroy();
}
console.log(`seeds=${seeds} diverged=${bad} nonblackChannels=${nzT}`);
