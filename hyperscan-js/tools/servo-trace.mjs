import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
m.io.servo.trace = true; m.io.servo.logMax = +process.env.NLOG || 300;
m.run(+process.env.MAXI || 120e6);
console.log('instr', m.cpu.cycles, 'quadros', m.io.frames, 'pc', m.cpu.pc.toString(16), m.error || '');
console.log('UART (resumo):', JSON.stringify(m.uart.slice(0, 160)), '... total', m.uart.length, 'chars; fim:', JSON.stringify(m.uart.slice(-80)));
console.log(m.io.servo.log.join('\n'));

if (m.io.servo.cmdLog) console.log('--- comandos do servo:\n' + m.io.servo.cmdLog.join('\n'));
