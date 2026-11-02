import fs from 'node:fs';
import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || 'bios.bin')), disc = new Uint8Array(fs.readFileSync(process.env.DISC || 'disc.bin'));
const j = new JS(bios, {}), w = await WS.create(bios, {}); j.insertDisc(disc); w.insertDisc(disc);
const both = (n) => { for (let i = 0; i < n; i += 1.5e6) { j.run(1.5e6); w.run(1.5e6); } };
const cmp = (tag) => { const ok = j.cpu.pc === w.pc && j.cpu.cycles === w.cycles && j.uart === w.uart && [...Array(32).keys()].every(i => j.cpu.r[i] === w.reg(i)); console.log(tag, ok ? 'igual' : 'DIVERGE'); return ok; };
const frame = (m) => { const [W, H] = m.screenSize(); const d = { data: new Uint8ClampedArray(W * H * 4) }; m.renderTo(d); return [W, H, d.data]; };
both(1700e6); cmp('boot');
for (const [name, act] of [['Start', (m, p) => m.setPad(0, { in0: 0x02, in1: 0, ax: 0x7f, ay: 0x7f })], ['solta', m => m.setPad(0, { in0: 0, in1: 0, ax: 0x7f, ay: 0x7f })], ['cartão', m => m.insertCard(5, 1)], ['sem cartão', m => m.removeCard()], ['Verde', m => m.setPad(0, { in0: 0, in1: 0x80, ax: 0x7f, ay: 0x7f })], ['solta', m => m.setPad(0, { in0: 0, in1: 0, ax: 0xff, ay: 0x7f })]]) {
  act(j); act(w); both(150e6); cmp(name);
  const [W, H, a] = frame(j), [, , b] = frame(w); let nd = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) nd++; console.log('  quadro:', W + 'x' + H, nd, 'bytes diferentes', 'frames', w.frames);
}
// save state no jogo real: salva, avança, recarrega, deve repetir exatamente
const st = await w.saveState(); console.log('save state do jogo:', (st.length / 1024).toFixed(0), 'KB gz');
w.run(30e6); const ref = [w.pc, w.cycles, w.frames, w.reg(4)], fr1 = frame(w)[2];
await w.loadState(st); w.run(30e6); const got = [w.pc, w.cycles, w.frames, w.reg(4)], fr2 = frame(w)[2];
let nd = 0; for (let i = 0; i < fr1.length; i++) if (fr1[i] !== fr2[i]) nd++;
console.log('load/replay:', JSON.stringify(ref) === JSON.stringify(got) && nd === 0 ? 'determinístico, quadro idêntico' : `DIFERE ${ref} ${got} ${nd}`);
const [W, H, a] = frame(w); fs.writeFileSync('/tmp/play.rgba', Buffer.from(a.buffer)); fs.writeFileSync('/tmp/play.dim', `${W} ${H}`);
