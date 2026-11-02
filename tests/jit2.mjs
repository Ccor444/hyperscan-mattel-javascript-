import fs from 'node:fs';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || 'bios.bin')), disc = new Uint8Array(fs.readFileSync(process.env.DISC || 'disc.bin'));
const b = await WS.create(bios, { jit: true, jitThreshold: +process.argv[3] || 20 }); b.insertDisc(disc);
const N = +process.argv[2] || 600e6; const t = performance.now();
for (let i = 0; i < N; i += 1.5e6) { b.run(1.5e6); await new Promise(r => setImmediate(r)); }
const dt = (performance.now() - t) / 1000, s = b.jitStats();
console.log(`${dt.toFixed(1)}s ${(N / dt / 1e6).toFixed(0)} MIPS efetivos; ${(100 * s.jitInstrs / N).toFixed(1)}% das instr em JIT; média ${(s.jitInstrs / s.jitCalls).toFixed(1)} instr/bloco`, JSON.stringify(s));
