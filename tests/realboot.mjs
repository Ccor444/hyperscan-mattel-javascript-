import fs from 'node:fs';
import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || 'bios.bin')), disc = new Uint8Array(fs.readFileSync(process.env.DISC || 'disc.bin'));
const total = +process.argv[2] || 300e6, step = 1.5e6;
const j = new JS(bios, {}), w = await WS.create(bios, {});
j.insertDisc(disc); w.insertDisc(disc);
console.log('disco', j.disc.volumeId, j.disc.sectors, '|', w.disc.volumeId, w.disc.sectors);
let done = 0, tj = 0, tw = 0, bad = false, nextReport = 0;
while (done < total && !bad) {
  let t = performance.now(); j.run(step); tj += performance.now() - t;
  t = performance.now(); w.run(step); tw += performance.now() - t; done += step;
  const d = [];
  if (j.cpu.pc !== w.pc) d.push(`pc ${j.cpu.pc.toString(16)} vs ${w.pc.toString(16)}`);
  for (let i = 0; i < 32; i++) if (j.cpu.r[i] !== w.reg(i)) { d.push('r' + i); break; }
  if (j.cpu.cycles !== w.cycles) d.push(`cycles ${j.cpu.cycles} vs ${w.cycles}`);
  if (j.io.frames !== w.frames) d.push('frames');
  if (j.uart !== w.uart) d.push('uart');
  if (!!j.error !== !!w.error) d.push(`erro js=${j.error} wasm=${w.error}`);
  if (d.length) { console.log(`DIVERGIU em ~${(done / 1e6) | 0}M instr:`, d.join(', ')); bad = true; }
  if (done >= nextReport) { nextReport += 100e6; console.log(`${(done / 1e6) | 0}M ok  frames=${w.frames} CD reads=${w.cdhle?.reads}`); }
}
console.log(`tempo JS=${(tj / 1000).toFixed(1)}s WASM=${(tw / 1000).toFixed(1)}s`);
// vídeo e áudio ao final
const [W, H] = j.screenSize(), [W2, H2] = w.screenSize(); console.log('tela', W, H, W2, H2);
const ja = { data: new Uint8ClampedArray(W * H * 4) }, wa = { data: new Uint8ClampedArray(W2 * H2 * 4) };
j.renderTo(ja); w.renderTo(wa);
let nd = 0, nz = 0; for (let i = 0; i < ja.data.length; i++) { if (ja.data[i] !== wa.data[i]) nd++; if (i % 4 < 3 && ja.data[i]) nz++; }
console.log(`quadro final: ${nd} bytes diferentes (pixels não-pretos: ${nz})`);
const a = j.io.spuChip.pull(4000, 1), b = w.pullAudio(4000, 1); let ad = 0, an = 0; for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) ad++; if (a[i]) an++; }
console.log(`áudio: ${ad} amostras diferentes de ${a.length} (não-zero: ${an})`);
console.log('UART:', JSON.stringify(w.uart.slice(-120)));
fs.writeFileSync('/tmp/final_wasm.rgba', Buffer.from(wa.data.buffer)); fs.writeFileSync('/tmp/final_js.rgba', Buffer.from(ja.data.buffer)); fs.writeFileSync('/tmp/final.dim', `${W} ${H}`);
