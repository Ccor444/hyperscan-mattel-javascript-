import fs from 'fs';
import { Disc } from '../src/disc.js';
const d = new Disc(new Uint8Array(fs.readFileSync(process.argv[2] || '/mnt/user-data/uploads/Spider-Man__USA_.bin')));
console.log(d.volumeId, d.sectors, 'setores de', d.sectorSize, 'B');
for (const e of d.list()) console.log(e.dir ? 'd' : '-', e.name.padEnd(14), 'LBA', e.lba, e.size);
const exe = d.readFile('HYPER.EXE'); console.log('HYPER.EXE', exe.length, 'bytes; primeira palavra', new DataView(exe.buffer, exe.byteOffset).getUint32(0, true).toString(16));
