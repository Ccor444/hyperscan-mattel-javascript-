import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')), { fastPaths: false });   // interpretador executa o laço original
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const bus = m.bus, io = m.io, st = () => bus.r32(0xa0154e30 - 14332);
let pending = null, checked = 0, bad = 0, firstBad = null, entered = 0, exits = 0;
m.cpu.addHook(0xa011220a, (c) => {                                      // antes do laço: aplica a versão nativa, guarda o resultado e RESTAURA a memória
  entered++; if (pending) return false;
  const fp = c.r[2] >>> 0, x0 = bus.r32(fp + 48) | 0;
  if (x0 < 0 || x0 > 4096) return false;
  const tab = bus.r32(fp + 44), dst = bus.r32(fp + 40), n = 2 * (x0 + 1);
  const before = Array.from({ length: n }, (_, i) => bus.r8(dst + i)), v12 = bus.r32(fp + 12), v48 = bus.r32(fp + 48);
  let val = 0;
  for (let x = x0; x >= 0; x--) { val = bus.r32(tab + x * 4); bus.w16(dst + 2 * x, val & 0xffff); }          // mesma lógica de fastpaths.js (sequencial)
  const after = Array.from({ length: n }, (_, i) => bus.r8(dst + i));
  for (let i = 0; i < n; i++) bus.w8(dst + i, before[i]);                  // restaura: o interpretador vai executar o laço original
  bus.w32(fp + 12, v12); bus.w32(fp + 48, v48);
  pending = { fp, x0, dst, n, after, lastVal: val }; return false;
});
m.cpu.addHook(0xa011224c, (c) => {                                      // depois do laço original: compara com o resultado nativo
  exits++; if (!pending) return false; const p = pending; pending = null; checked++;
  let ok = true, why = '';
  for (let i = 0; i < p.n; i++) if (bus.r8(p.dst + i) !== p.after[i]) { ok = false; why = `byte ${(p.dst + i).toString(16)} tem ${bus.r8(p.dst + i).toString(16)} esperado ${p.after[i].toString(16)}`; break; }
  if (ok && (bus.r32(p.fp + 48) | 0) !== -1) { ok = false; why = 'var48 != -1'; }
  if (ok && (bus.r32(p.fp + 12) >>> 0) !== (p.lastVal >>> 0)) { ok = false; why = `var12 ${bus.r32(p.fp + 12).toString(16)} != ${p.lastVal.toString(16)}`; }
  if (ok && ((c.r[4] | 0) !== -1)) { ok = false; why = 'r4=' + c.r[4]; }
  if (!ok) { bad++; if (!firstBad) firstBad = `chamada ${checked}: ${why} (x0=${p.x0})`; }
  return false;
});
const frames = (n) => { const f = io.frames + n; while (io.frames < f && !m.error) m.run(100000); };
const until = (pred, max) => { while (!pred() && m.cpu.cycles < max) m.run(1e6); };
until(() => st() === 35, 4000e6); frames(120); m.setPad(0, { in0: 2 }); frames(30); m.setPad(0, { in0: 0 });
until(() => st() === 15, 4000e6); frames(60); m.insertCard(5, 1); frames(90); m.removeCard(); until(() => st() === 29, 4000e6); frames(100);
m.setPad(0, { ax: 255 }); frames(150); m.setPad(0, { ax: 0 }); frames(150); m.setPad(0, { ay: 0 }); frames(100); m.setPad(0, { in1: 0x80 }); frames(30);
console.log(`entradas=${entered} saídas=${exits}`); console.log(`laços verificados: ${checked}, divergências: ${bad}${firstBad ? ' — primeira: ' + firstBad : ''}`);
