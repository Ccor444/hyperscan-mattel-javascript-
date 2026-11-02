import fs from 'fs';
import { Bus } from '../src/bus.js';
import { SCore7 } from '../src/cpu.js';
import { IO } from '../src/io.js';
const bios = new Uint8Array(fs.readFileSync(process.argv[2] || '/mnt/user-data/uploads/hyperscan.bin'));
const bus = new Bus({ bios }), cpu = new SCore7(bus), io = new IO(); io.attach(bus);
const ev = [];
const orig = io.write.bind(io), origR = io.read.bind(io);
io.write = (o, v, sz) => { ev.push(`W 0x88${o.toString(16).padStart(6, '0')} = ${v.toString(16)}  pc=${cpu.pc.toString(16)}`); return orig(o, v, sz); };
io.read = (o, sz) => { const v = origR(o, sz); ev.push(`R 0x88${o.toString(16).padStart(6, '0')} -> ${(v >>> 0).toString(16)}  pc=${cpu.pc.toString(16)}`); return v; };
const setCR = cpu.setCR.bind(cpu); cpu.setCR = (i, v) => { ev.push(`mtcr cr${i} = ${(v >>> 0).toString(16)} pc=${cpu.pc.toString(16)}`); setCR(i, v); };
cpu.reset(0x9f000000);
for (let i = 0; i < (+process.env.MAXI || 3e6); i++) cpu.step();
const seen = new Set(); const out = [];
for (const e of ev) { const k = e.replace(/pc=.*/, '').replace(/->.*/, ''); if (!seen.has(e)) { seen.add(e); out.push(e); } }
console.log(out.slice(0, +process.env.N || 120).join('\n'));
