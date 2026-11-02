import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
m.run(+process.env.MAXI || 400e6);
console.log('instr', m.cpu.cycles, 'pc', m.cpu.pc.toString(16), m.error || '');
console.log(m.uart.slice(0, +process.env.NCH || 3000).replace(/\r/g, ''));
