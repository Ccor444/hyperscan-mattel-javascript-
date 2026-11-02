import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
import { installCdHle } from '../src/cdhle.js';
const m = new HyperScan(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin')));
m.insertDisc(new Uint8Array(fs.readFileSync(process.env.DISC || '/mnt/user-data/uploads/Spider-Man__USA_.bin')));
const lines = []; const lbas = []; const stats = installCdHle(m, { log: s => { const mm = /read lba=(\d+)/.exec(s); if (mm) { const l = +mm[1]; if (!lbas.length || l !== lbas[lbas.length - 1][1] + 1 && l !== lbas[lbas.length - 1][1]) lbas.push([l, l]); else lbas[lbas.length - 1][1] = l; } else if (lines.length < 60) lines.push(s); } });
try { m.run(+process.env.MAXI || 800e6); } catch (e) { console.log("EXCEÇÃO:", e.message, "pc", m.cpu.pc.toString(16), "lr", (m.cpu.r[3] >>> 0).toString(16)); }
console.log('instr', m.cpu.cycles, 'pc', m.cpu.pc.toString(16), m.error || '', JSON.stringify(stats));
const u = m.uart.replace(/\r/g, ''); const i = u.indexOf('SCMD:ReadTOC');
console.log(u.slice(Math.max(0, i - 20), i + +(process.env.NCH || 900)));
console.log(lines.join('\n'));
console.log('faixas de LBA lidas:', lbas.slice(0, 40).map(r => r[0] === r[1] ? r[0] : r[0] + '-' + r[1]).join(' '), '... total faixas', lbas.length);
