// Benchmark determinístico: roda N instruções (padrão 400M) com BIOS+disco e imprime MIPS e uma assinatura do estado (pc, registradores, hash da RAM).
// A assinatura deve ser IDÊNTICA antes e depois de otimizações (o emulador é determinístico).
import fs from 'fs';
import crypto from 'crypto';
import { HyperScan } from '../src/hyperscan.js';
const N = +process.env.N || 400e6;
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')), { idleSkip: process.env.IDLE !== '0', fastPaths: process.env.FAST !== '0' });
m.insertDisc(new Uint8Array(fs.readFileSync(process.env.DISC || '/mnt/user-data/uploads/Spider-Man__USA_.bin')));
if (process.env.PAD) { /* reservado */ }
m.cpu.useJit = process.env.JIT !== '0';
const t0 = process.hrtime.bigint();
m.run(N);
const dt = Number(process.hrtime.bigint() - t0) / 1e9;
const h = crypto.createHash('md5').update(m.bus.ram).digest('hex').slice(0, 12);
console.log(`instr=${(m.cpu.cycles / 1e6).toFixed(1)}M tempo=${dt.toFixed(2)}s  ${(m.cpu.cycles / dt / 1e6).toFixed(1)} MIPS  quadros=${m.io.frames}  pc=${m.cpu.pc.toString(16)}  estado=${m.bus.r32(0xa0154e30 - 14332)}`);
console.log(`ASSINATURA ram=${h} regs=${[...m.cpu.r].map(v => (v >>> 0).toString(16)).join(',')} cr0=${m.cpu.cr[0].toString(16)} uart=${m.uart.length}`);
