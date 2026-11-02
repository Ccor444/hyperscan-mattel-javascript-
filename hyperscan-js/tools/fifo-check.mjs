import fs from 'fs';
import { HyperScan } from '/mnt/user-data/outputs/hyperscan-js/src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const io = m.io, chip = io.spuChip;
let irqs = 0, lastPend = 0; const origSet = io.setSrc.bind(io);
io.setSrc = (n, on) => { if (n === 0 && on && !lastPend) irqs++; lastPend = n === 0 ? on : lastPend; return origSet(n, on); };
let t0 = 0, peakWin = 0, nzWin = 0;
const pulled = []; 
for (let t = 0; t < 520e6; t += 10e6) {
  m.run(10e6);
  if (t >= 180e6) { const before = chip.peak; }
  if (chip.dmaOn && !t0) { t0 = m.cpu.cycles; console.log('DMA ligado em', (m.cpu.cycles/1e6).toFixed(0), 'M; taxa', chip.dacRate.toFixed(1), 'Hz; metade', chip.halfFrames, 'quadros'); }
}
console.log('dmaOn', chip.dmaOn, 'fHead', chip.fHead, 'fTail', chip.fTail, 'IRQs de FIQ por DMA ~', irqs, 'pico', chip.peak.toFixed(4));
console.log('FIFO ctrl 0x1088', (io.spu.get(0x1088)||0).toString(16), 'relogio 0x1064', (io.spu.get(0x1064)||0).toString(16), 'endereco 0x1080', (io.spu.get(0x1080)||0).toString(16));
console.log('UART:', JSON.stringify(m.uart.slice(-80)));
