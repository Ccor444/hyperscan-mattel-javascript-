// Benchmark da leitura de CD (HLE a0024588): lê todos os setores de um arquivo do disco pelo caminho da CPU e mede setores/s e MB/s.
import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')), { fastPaths: false });
m.insertDisc(new Uint8Array(fs.readFileSync(process.env.DISC || '/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const c = m.cpu, bus = m.bus, hook = c.hooks.get(0xa0024588);
// o guard confere a assinatura do código do BIOS (a chamada de teste não o executa): forçamos a assinatura para medir só a cópia
bus.r16 = ((orig) => (a) => (a === 0xa0024588 ? 0x230e : orig.call(bus, a)))(bus.r16.bind(bus));
const SIG_DUMMY = 0x230e;
const LBA0 = 18304, N = +process.env.SECT || 2000, DEST = 0xa0500000;      // HYPER.EXE (~386 setores), depois mais setores
// monta uma chamada de a0024588 com os registradores que o BIOS usaria: dest=r4, pos(MSF)=r5, off=r6, n=r7
const msf = (lba) => { const l = lba + 150; return ((Math.floor(l / 4500) & 0xff) << 16) | ((Math.floor(l / 75) % 60) << 8) | (l % 75); };
const t0 = process.hrtime.bigint(); let bytes = 0;
for (let i = 0; i < N; i++) {
  c.r[4] = DEST; c.r[5] = msf(LBA0 + i); c.r[6] = 0; c.r[7] = 2048;
  hook(c); bytes += 2048;
}
const dt = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`setores=${N} tempo=${dt.toFixed(3)}s  ${(N / dt).toFixed(0)} setores/s  ${(bytes / dt / 1e6).toFixed(1)} MB/s`);
