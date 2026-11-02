import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { makeBios } from './gen.mjs';
let bad = 0; const ok = (c, m) => { if (!c) { console.log('FALHA:', m); bad++; } };
for (const seed of [3, 5, 8]) {
  const bios = makeBios(seed);
  const a = await WS.create(bios, {}), b = await WS.create(bios, {});
  // configura SPU/PPU/timers via bus para ter estado não trivial
  for (const [ad, v, sz] of [[0x88051000, 0, 4], [0x88050004, 0x4000, 4], [0x88050800, 5000, 4], [0x8805000c, 0x7f40, 4], [0x88050014, 0x7f7f, 4], [0x88051000, 1, 4], [0x88160000, 0x80000000, 4], [0x88160008, 0x400, 4], [0x880a0020, 0, 4], [0x88010000, 0x1000, 4], [0x88011000, 0x1234, 4]]) { a.x.hs_dbg_bus_write(a.h, ad, v, sz); }
  a.run(30000);
  const s1 = await a.saveState();
  a.run(20000);
  const s2 = await b.loadState(s1).then(() => b.saveState());
  // b (carregado) deve continuar exatamente como a após o mesmo trecho: reload em a
  const refAfter = []; refAfter.push(a.pc, a.cycles, a.frames, a.reg(1), a.reg(2));
  await a.loadState(s1);          // volta ao ponto salvo
  a.run(20000); b.run(20000);
  const cmp = [a.pc, a.cycles, a.frames, a.reg(1), a.reg(2)];
  ok(JSON.stringify(cmp) === JSON.stringify(refAfter), `seed ${seed}: continuação difere ${cmp} vs ${refAfter}`);
  ok(JSON.stringify([b.pc, b.cycles, b.reg(1)]) === JSON.stringify([a.pc, a.cycles, a.reg(1)]), 'b != a');
  const pa = a.pullAudio(800, 1), pb = b.pullAudio(800, 1); let same = true; for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) same = false; ok(same, 'áudio após load');
  console.log(`seed ${seed}: estado ${s1.length} bytes (gzip)`);
  // estado inválido
  const err0 = b.error;
  let threw = false; try { await b.loadState(new Uint8Array(s1.subarray(0, 50))); } catch (e) { threw = true; } ok(threw, 'estado truncado deveria falhar');
  const bad2 = await (async () => { const raw = await import('node:zlib').then(z => z.gunzipSync(s1)); raw[100] ^= 1; return new Uint8Array((await import('node:zlib')).gzipSync(raw)); })();
  threw = false; try { await b.loadState(bad2); } catch (e) { threw = true; } ok(threw, 'estado corrompido deveria falhar');
  ok(b.error === err0, 'máquina intacta após falha');
}
console.log(bad ? bad + ' falhas' : 'save state: ok');
