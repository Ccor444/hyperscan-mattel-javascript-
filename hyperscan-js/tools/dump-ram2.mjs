import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')));
m.run(+process.env.WARM || 150e6);
fs.writeFileSync(process.env.OUT || '/tmp/ram.bin', m.bus.ram);
console.log('pc', m.cpu.pc.toString(16), 'salvo', m.bus.ram.length);
