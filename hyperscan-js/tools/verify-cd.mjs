// Verifica que a cópia direta de setores (copyToBus) produz exatamente a mesma memória que a cópia byte a byte (bus.w8), inclusive
// quando o destino cobre código traduzido pelo JIT (deve invalidar os blocos).
import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const disc = new Uint8Array(fs.readFileSync(process.env.DISC || '/mnt/user-data/uploads/Spider-Man__USA_.bin'));
function run(fast) {
  const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')), { fastPaths: false });
  m.insertDisc(new Uint8Array(disc));
  const c = m.cpu, bus = m.bus, hook = c.hooks.get(0xa0024588);
  const msf = (lba) => { const l = lba + 150; return ((Math.floor(l / 4500) & 0xff) << 16) | ((Math.floor(l / 75) % 60) << 8) | (l % 75); };
  bus.r16 = ((orig) => (a) => (a === 0xa0024588 ? 0x230e : orig.call(bus, a)))(bus.r16.bind(bus));
  const dests = [0xa0500000, 0xa0000100, 0xa0003f00, 0xa03fff00];   // o meio de página, a borda de 4 KiB e o fim da RAM
  for (const dst of dests) for (let i = 0; i < 60; i++) { c.r[4] = dst + i * 2048; c.r[5] = msf(18304 + i); c.r[6] = 0; c.r[7] = 2048; hook(c); }
  // também escreve parcial (offset != 0)
  c.r[4] = 0xa0200000 + 7; c.r[5] = msf(18400); c.r[6] = 13; c.r[7] = 1000; hook(c);
  return bus.ram;
}
const a = run(true);
// referência: mesma sequência, mas forçando a cópia byte a byte (desliga o caminho direto)
const orig = fs.readFileSync(new URL('../src/cdhle.js', import.meta.url), 'utf8');
globalThis.__forceSlowCopy = true;
const b = run(false);
let diff = 0, first = -1; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff++; if (first < 0) first = i; }
console.log(`bytes diferentes entre cópia direta e byte a byte: ${diff}${diff ? ' (primeiro em 0x' + first.toString(16) + ')' : ''}`);
