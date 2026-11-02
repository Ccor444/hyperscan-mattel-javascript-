import fs from 'fs';
import crypto from 'crypto';
import { HyperScan } from '/mnt/user-data/outputs/hyperscan-js/src/hyperscan.js';
import { serialize, deserialize } from '/mnt/user-data/outputs/hyperscan-js/src/savestate.js';
const BIOS = new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/hyperscan.bin')), DISC = new Uint8Array(fs.readFileSync('/mnt/user-data/uploads/Spider-Man__USA_.bin'));
const mk = () => { const m = new HyperScan(BIOS, { fastPaths: false }); m.insertDisc(DISC); return m; };
const st = m => m.bus.r32(0xa0154e30 - 14332);
const until = (m, p, max) => { while (!p() && m.cpu.cycles < max && !m.error) m.run(1e6); };
const frames = (m, n) => { const f = m.io.frames + n; while (m.io.frames < f && !m.error) m.run(100000); };
const hash = m => { const h = crypto.createHash('md5'); h.update(m.bus.ram); h.update(Buffer.from(m.cpu.r.buffer)); h.update(Buffer.from(String([m.cpu.pc, m.cpu.cycles, m.io.frames, m.io.spuChip.count]))); return h.digest('hex').slice(0, 12); };
// 1) roda até a fase, salva, continua 300 quadros e guarda o hash
const A = mk(); until(A, () => st(A) === 35, 4000e6); frames(A, 120); A.setPad(0, { in0: 2 }); frames(A, 30); A.setPad(0, { in0: 0 });
until(A, () => st(A) === 15, 4000e6); frames(A, 60); A.insertCard(5, 1); frames(A, 90); A.removeCard(); until(A, () => st(A) === 29, 4000e6); frames(A, 100);
const t0 = Date.now(); const bytes = await serialize(A); const tS = Date.now() - t0;
console.log(`save: ${(bytes.length/1024/1024).toFixed(2)} MB comprimido, ${tS} ms, quadro ${A.io.frames}`);
frames(A, 300); const hA = hash(A); console.log('continuação original, hash:', hA, 'quadro', A.io.frames);
// 2) máquina nova, carrega o save e roda os mesmos 300 quadros
const B = mk(); const t1 = Date.now(); await deserialize(bytes, B); console.log(`load: ${Date.now() - t1} ms, quadro ${B.io.frames}`);
frames(B, 300); const hB = hash(B); console.log('após carregar, hash:', hB, 'quadro', B.io.frames);
console.log(hA === hB ? 'OK   save state reproduz exatamente a execução' : 'FALHA hashes diferentes');
