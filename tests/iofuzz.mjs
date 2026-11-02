import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { rng } from './gen.mjs';
const seeds = +process.argv[2] || 20, ops = +process.argv[3] || 300;
const B = 0x88000000;
let nzAudio = 0, nzPix = 0, blendUsed = 0, bad = 0, audioCmp = 0, frames = 0;
const spuRegs = [];
for (const c0 of [0, 0x400]) for (let c = 0; c < (c0 ? 8 : 16); c++) { const a = c0 + c * 0x40; for (const o of [0, 4, 8, 0xc, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x28, 0x2c, 0x34]) spuRegs.push(0x50000 + a + o); }
for (let c = 0; c < 24; c++) spuRegs.push(0x50000 + (c < 16 ? 0x800 + c * 0x40 : 0xc00 + (c - 16) * 0x40));
for (const o of [0x1004, 0x1008, 0x1408, 0x1018, 0x101c, 0x1020, 0x1024, 0x1034, 0x1040, 0x1044, 0x1054, 0x1064, 0x1080, 0x1084, 0x1088, 0x1010, 0x1014, 0x102c, 0x142c]) spuRegs.push(0x50000 + o);
const ppuRegs = [0, 4, 8, 0xc, 0x10, 0x20, 0x24, 0x28, 0x2c, 0x30, 0x38, 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x54, 0x58, 0x5c, 0x60, 0x64, 0x68, 0x70, 0x80, 0x84, 0xa0, 0xac, 0xb8, 0xd0].map(o => 0x10000 + o);
const other = [0xa0000, 0xa0020, 0xa0024, 0x130020, 0x130024, 0x130028, 0x13002c, 0x130030, 0x130034, 0x60004, 0x60008, 0x6000c, 0x30000, 0x3000c, 0x70000, 0x70004, 0x70008, 0x90020, 0x150000, 0x200014];
for (let t = 0; t < 6; t++) for (const o of [0, 4, 8]) other.push(0x160000 + t * 0x1000 + o);
const readables = [...other, 0xa0000, 0xa0004, 0x10080, 0x10084, 0x10094, 0x50000 + 0x103c, 0x50000 + 0x143c, 0x160010, 0x161010, 0x130038, 0x60004, 0x60008];
function cmpFloat(a, b) { for (let i = 0; i < a.length; i++) if (Object.is(a[i], b[i]) === false && !(a[i] === b[i])) return i; return -1; }
for (let seed = 1; seed <= seeds; seed++) {
  const R = rng(seed * 7919), bios = new Uint8Array(1 << 20);   // BIOS de zeros = nops
  const j = new JS(bios, { fastBoot: seed % 2 === 0 }), w = await WS.create(bios, { fastBoot: seed % 2 === 0 });
  const wr = (a, v, sz) => { j.bus.write(a, v, sz); w.x.hs_dbg_bus_write(w.h, a, v >>> 0, sz); };
  const fail = (m) => { console.log(`seed ${seed}: ${m}`); bad++; };
  // dados de onda
  for (let i = 0; i < 0x4000; i += 4) { const v = (R() * 2654435761) >>> 0; wr(0xa0800000 + i, v, 4); }
  for (let i = 0; i < 0x2000; i += 4) { const v = (R() >>> 3); wr(0xa0900000 + i, v, 4); wr(0xa0300000 + i, v, 4); wr(0xa0310000 + i, v & 0xffff7fff | (R() & 0x80008000), 4); }
  let ok = true;
  for (let n = 0; n < ops && ok; n++) {
    const k = R() % 10;
    if (k < 5) {
      const addr = B + (k < 3 ? spuRegs[R() % spuRegs.length] : (R() % 3 ? ppuRegs[R() % ppuRegs.length] : other[R() % other.length]));
      let v = R();
      const kind = R() % 6;
      if (addr - B === 0x51000 || addr - B === 0x51400) v = R() & 0xffff;                 // ChEn
      if (kind === 0) v &= 0xff; else if (kind === 1) v &= 0xffff;
      if (kind === 2 && (addr - B) >= 0x50000 && (addr - B) < 0x58000) v = R() % 0x80000;
      const sz = [4, 4, 4, 2, 1][R() % 5];
      wr(addr, v >>> 0, sz);
    } else if (k < 6) {                                   // sprites/paleta/char data (ppu mem)
      const base = [0x14000, 0x11000, 0x11800, 0x12000][R() % 4], o = (R() % 0x200) * 4;
      wr(B + base + o, R(), 4);
    } else if (k < 9) {
      const nn = R() % 12000 + 1; j.run(nn); w.run(nn);
    } else {
      const nn = R() % 500 + 1, ra = 1.0 + (R() % 3) * 0.01; const a = j.io.spuChip.pull(nn, ra); const b = w.pullAudio(nn, ra); const d = cmpFloat(a, b); if (d >= 0) { fail(`pull sample ${d}`); ok = false; }
    }
    // compara leituras
    for (const o of readables) { const a = j.bus.read(B + o, 4) >>> 0, b = w.x.hs_dbg_bus_read(w.h, B + o, 4) >>> 0; if (a !== b) { fail(`op ${n} leitura +${o.toString(16)} js=${a.toString(16)} wasm=${b.toString(16)}`); ok = false; break; } }
    if (j.cpu.cycles !== w.cycles) { fail('cycles'); ok = false; }
    if (j.io.frames !== w.frames) { fail('frames'); ok = false; }
  }
  if (ok) {
    // áudio: mesma sequência de pulls (recria máquinas não: compara anel via pull idêntico)
    j.run(5000); w.run(5000);
    const a = j.io.spuChip.pull(1500, 1), b = w.pullAudio(1500, 1); audioCmp += 1500;
    for (const v of a) if (v) nzAudio++; const d = cmpFloat(a, b); if (d >= 0) { fail(`audio sample ${d}: ${a[d]} vs ${b[d]}`); ok = false; }
    // vídeo
    const [W, H] = j.screenSize(); const [W2, H2] = w.screenSize();
    if (W !== W2 || H !== H2) fail('size'); else {
      const ja = { data: new Uint8ClampedArray(W * H * 4) }, wa = { data: new Uint8ClampedArray(W * H * 4) };
      j.renderTo(ja); w.renderTo(wa);
      let nd = 0, first = -1, nz = 0; for (let i = 0; i < ja.data.length; i++) { if (ja.data[i] !== wa.data[i]) { nd++; if (first < 0) first = i; } if (i % 4 < 3 && ja.data[i]) nz++; }
      nzPix += nz; frames++; if (nd) fail(`render: ${nd} bytes diferem (1º em ${first}, js=${ja.data[first]} wasm=${wa.data[first]}), pixels não-pretos=${nz}`);
    }
    // servo / uart
    if (j.uart !== w.uart) fail('uart');
  }
  w.destroy();
}
console.log(`seeds=${seeds} ops=${ops} diverged=${bad} audioSamplesCompared=${audioCmp} renders=${frames} nonzeroAudio=${nzAudio} nonblackPixelChannels=${nzPix}`);
