import fs from 'fs';
import { Bus } from '../src/bus.js';
import { SCore7 } from '../src/cpu.js';
import { IO } from '../src/io.js';
const bios = new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin'));
const bus = new Bus({ bios }), cpu = new SCore7(bus), io = new IO(); io.attach(bus, cpu);
cpu.reset(0x9f000000);
const N = +(process.env.MAXI || 20e6), FRAME = +(process.env.FRAME || 300000);
io.frameLen = FRAME; for (let i = 0; i < N; i++) { cpu.step(); if ((i & 255) === 255) io.tick(256); }
fs.writeFileSync(process.argv[2] || '/tmp/ram.bin', bus.ram);
console.log('pc', cpu.pc.toString(16), 'ram salvo');
