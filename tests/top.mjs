import fs from 'node:fs';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const w = await WS.create(new Uint8Array(fs.readFileSync('/home/claude/game/bios.bin')), {}); w.insertDisc(new Uint8Array(fs.readFileSync('/home/claude/game/Spider-Man (USA).bin')));
for (let i = 0; i < 100; i++) w.run(1.5e6);
w.jitTopReset(); const c0 = w.cycles; for (let i = 0; i < 20; i++) w.run(1.5e6);
const tot = w.cycles - c0; console.log('io', w.jitIo(), w.jitTop(5).map(b => b.pc.toString(16) + ' ' + (b.weight / tot * 100).toFixed(1) + '%'));
