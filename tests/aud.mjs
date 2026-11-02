import fs from 'node:fs';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
const bios = new Uint8Array(fs.readFileSync('/home/claude/game/bios.bin')), disc = new Uint8Array(fs.readFileSync('/home/claude/game/Spider-Man (USA).bin'));
for (const jit of [true, false]) {
  const w = await WS.create(bios, { jit }); w.insertDisc(disc);
  let peak = 0, got = 0, nz = 0;
  for (let i = 0; i < 400; i++) {
    w.run(1.5e6);
    const n = Math.min(w.audioBuffered(), 4096);
    if (n > 0) { const d = w.pullAudio(n, 1); got += n; for (const v of d) { const a = Math.abs(v); if (a > peak) peak = a; if (a > 1e-4) nz++; } }
  }
  console.log('jit', jit, 'frames', w.frames, 'amostras', got, 'pico', peak.toFixed(4), 'nao-zero', nz);
}
