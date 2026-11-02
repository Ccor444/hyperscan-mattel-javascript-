import fs from 'node:fs';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || 'bios.bin')), disc = new Uint8Array(fs.readFileSync(process.env.DISC || 'disc.bin'));
const w = await WS.create(bios, {}); w.insertDisc(disc);
let last=0;
for (let s=0;s<14;s++){ const f0=w.frames,c0=w.cycles,t=performance.now(); for(let i=0;i<40;i++){ w.run(1.5e6); await new Promise(r=>setImmediate(r)); } const dt=(performance.now()-t)/1000;
 console.log(`seg${s}: ${((w.frames-f0)/dt).toFixed(0)} fps emulados (60=tempo real), ${((w.cycles-c0)/dt/1e6).toFixed(0)} Mcycles/s, ${(60e6/(dt*1e6)).toFixed(0)} MIPS`); }
console.log('cycles/frame', (w.cycles/w.frames).toFixed(0));
