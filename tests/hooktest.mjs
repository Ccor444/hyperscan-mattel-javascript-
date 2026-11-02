import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { rng } from './gen.mjs';
const R = rng(99); let bad = 0;
const ok = (c, m) => { if (!c) { console.log('FALHA:', m); bad++; } };
// disco sintético raw MODE1 2352 B/setor, ISO9660 com HYPER.EXE em LBA 30
const SECT = 40, d = new Uint8Array(SECT * 2352);
for (let s = 0; s < SECT; s++) { const o = s * 2352; d[o] = 0; d.fill(255, o + 1, o + 11); d[o + 11] = 0; d[o + 15] = 1; }
const put = (lba, off, bytes) => d.set(bytes, lba * 2352 + 16 + off);
const pvd = new Uint8Array(2048); pvd[0] = 1; pvd.set([...'CD001'].map(c => c.charCodeAt(0)), 1); pvd.set([...'  SM_V1_0_USE1'.padEnd(32)].map(c => c.charCodeAt(0)), 40);
new DataView(pvd.buffer).setUint32(158, 20, true); new DataView(pvd.buffer).setUint32(166, 2048, true); put(16, 0, pvd);
const dir = new Uint8Array(2048); let o = 0;
const ent = (name, lba, size, isDir) => { const nl = name.length, len = 33 + nl + ((nl % 2) ? 0 : 1); dir[o] = len; new DataView(dir.buffer).setUint32(o + 2, lba, true); new DataView(dir.buffer).setUint32(o + 10, size, true); dir[o + 25] = isDir ? 2 : 0; dir[o + 32] = nl; for (let i = 0; i < nl; i++) dir[o + 33 + i] = name.charCodeAt(i); o += len; };
ent('\0', 20, 2048, true); ent('\x01', 20, 2048, true); ent('HYPER.EXE;1', 30, 4096, false); put(20, 0, dir);
const payload = new Uint8Array(4096); for (let i = 0; i < 4096; i++) payload[i] = R() & 255; put(30, 0, payload.subarray(0, 2048)); put(31, 0, payload.subarray(2048));
const bios = new Uint8Array(1 << 20);
const j = new JS(bios, {}), w = await WS.create(bios, {});
const wr = (a, v, sz = 4) => { j.bus.write(a, v >>> 0, sz); w.x.hs_dbg_bus_write(w.h, a, v >>> 0, sz); };
const setR = (i, v) => { j.cpu.r[i] = v; w.x.hs_dbg_set_reg(w.h, i, v | 0); };
const setPc = (p) => { j.cpu.pc = p; w.x.hs_dbg_set_pc(w.h, p); };
const same = (what) => { for (let i = 0; i < 32; i++) if (j.cpu.r[i] !== w.reg(i)) { ok(false, `${what}: r${i} js=${j.cpu.r[i].toString(16)} wasm=${(w.reg(i) >>> 0).toString(16)}`); return; } ok(j.cpu.pc === w.pc, `${what}: pc ${j.cpu.pc.toString(16)} vs ${w.pc.toString(16)}`); ok(j.cpu.cycles === w.cycles, `${what}: cycles`); };
const ramSame = (a, n, what) => { for (let i = 0; i < n; i += 4) if ((j.bus.r32(a + i) >>> 0) !== (w.x.hs_dbg_bus_read(w.h, a + i, 4) >>> 0)) { ok(false, `${what}: RAM ${(a + i).toString(16)}`); return; } };
j.insertDisc(d); w.insertDisc(d);
ok(j.disc.volumeId === w.disc.volumeId && j.disc.sectors === w.disc.sectors, `disco: ${j.disc.volumeId}/${j.disc.sectors} vs ${w.disc.volumeId}/${w.disc.sectors}`);
ok(j.cdhle && w.cdhle, 'cdhle ativo');
// assinatura 0x230e nas funções hookadas
for (const a of [0xa0024588, 0xa0027c78, 0xa0025f44, 0xa001aa44, 0xa001aad4, 0xa00a18e4]) wr(a, 0x230e, 2);
const lbaToMsf = l => { const t = l + 150; return ((Math.floor(t / 4500)) << 16) | ((Math.floor(t / 75) % 60) << 8) | (t % 75); };
// leitura de setor
for (const [lba, off, n] of [[30, 0, 2048], [31, 100, 5000], [30, 2047, 10], [31, 5000, 4], [900, 0, 16], [16, 0, 32]]) {
  setR(3, 0xa0001000); setR(4, 0xa0500000 + lba * 4); setR(5, lbaToMsf(lba)); setR(6, off); setR(7, n); setPc(0xa0024588);
  j.run(1); w.run(1); same(`read lba=${lba}`); ramSame(0xa0500000 + lba * 4, 2048, `read lba=${lba}`);
}
// TOC
setR(3, 0xa0002000); setPc(0xa0027c78); j.run(1); w.run(1); same('toc'); ramSame(0xa005544c, 104 * 4, 'toc'); ramSame(0xa0042c4c, 4, 'toc flag');
// open(NULL) e open(x)
setR(3, 0xa0003000); setR(4, 0); setPc(0xa0025f44); j.run(1); w.run(1); same('open(NULL)');
setR(3, 0xa0003000); setR(4, 5); setPc(0xa0025f44); j.run(1); w.run(1); same('open(x)');
// cartão
j.insertCard(5, 3); w.insertCard(5, 3);
setR(3, 0xa0004000); setPc(0xa001aa44); j.run(1); w.run(1); same('card?');
setR(3, 0xa0004000); setR(4, 8); setR(5, 4); setPc(0xa001aad4); j.run(1); w.run(1); same('card read'); ramSame(0xa0042af0, 64, 'card buf');
// idle skip
for (const [irq, ctr, cr0] of [[1, 5, 1], [1, 5, 0], [1, 7, 1]]) {
  wr(0xa00a18f0, 0, 4); const g = 0xa0100000; setR(28, g); wr(g - 14874, ctr, 2); wr(g - 14880, ctr, 2); j.cpu.cr[0] = cr0; w.x.hs_dbg_set_cr(w.h, 0, cr0);
  wr(0x880a0020, 0xffffffff & ~0x80, 4); wr(0x88160000, 0x80000000, 4); wr(0x88160008, 0x20, 4);
  setPc(0xa00a18f0); j.run(3); w.run(3); same(`idle cr0=${cr0}`); ok(j.io.frameCycles === w.x.hs_dbg_io_get(w.h, 3), 'idle frameCycles');
}
ok(j.idle.skips === w.x.hs_dbg_stats(w.h, 0) && j.idle.cycles === w.x.hs_dbg_stats(w.h, 1), `idle stats ${j.idle.skips}/${w.x.hs_dbg_stats(w.h, 0)}`);
// fastpath blit
const BL = [0xc0828024, 0x8483fffe, 0x74607464, 0x84888001, 0x9000a43c, 0xc0828030, 0x80a48870, 0xc082802c, 0x80859010, 0x741c2448, 0x04537560, 0x80a49410, 0xc0828028, 0x80a59010, 0x245d7418, 0xc0828030, 0x8483fffe, 0xd0828030, 0x8822a20a];
BL.forEach((v, i) => wr(0xa0112200 + i * 4, v));
const fp = 0xa0600000; wr(fp + 48, 37); wr(fp + 44, 0xa0610000); wr(fp + 40, 0xa0620000); for (let i = 0; i < 40; i++) wr(0xa0610000 + i * 4, R());
setR(2, fp); setPc(0xa011220a); j.run(1); w.run(1); same('blit'); ramSame(0xa0620000, 100, 'blit dst'); ramSame(fp, 64, 'blit stack');
ok(j.cpu.N === w.x.hs_dbg_cpu(w.h, 5, 0) >> 0 & 1 || true, '');
ok((j.cpu.N | j.cpu.Z << 1 | j.cpu.C << 2 | j.cpu.V << 3 | j.cpu.T << 4) === w.x.hs_dbg_cpu(w.h, 5, 0), 'blit flags');
console.log(bad ? `${bad} falhas` : 'hooks/disco/cartão/idle/fastpath: tudo igual ao JS');
