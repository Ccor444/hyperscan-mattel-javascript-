// Busca gulosa das regras de leitura do reg 0x79 do servo, por ponto de chamada (lr). Progresso = nº de linhas únicas na UART.
import fs from 'fs';
import { HyperScan } from '../src/hyperscan.js';
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/hyperscan.bin'));
const MAXI = +process.env.MAXI || 600e6, VALUES = (process.env.VALS ? JSON.parse(process.env.VALS) : [0xa0, 0x20, 0x00, 0x80, 0x60, 0xe0, 0xff]);
function run(rules) {
  const m = new HyperScan(bios);
  for (const [k, v] of Object.entries(rules)) m.io.servo.r79[+k] = v;
  const sites = [];
  m.io.servo.hooks.read = (a) => { if (a === 0x79) { const lr = m.cpu.r[3] >>> 0; if (!sites.includes(lr)) sites.push(lr); } };
  m.run(MAXI);
  const lines = new Set(m.uart.replace(/\r/g, '').split('\n').filter(Boolean));
  return { score: lines.size, sites, uart: m.uart.replace(/\r/g, ''), pc: m.cpu.pc };
}
let rules = JSON.parse(process.env.RULES || '{}'), best = run(rules);
console.log('base score', best.score, 'sites', best.sites.map(x => x.toString(16)).join(','));
const tried = new Set();
for (let round = 0; round < (+process.env.ROUNDS || 12); round++) {
  const site = best.sites.find(s => !tried.has(s) && rules[s] === undefined);
  if (site === undefined) break;
  tried.add(site);
  let bv = null, bs = best;
  for (const v of VALUES) {
    const r = run({ ...rules, [site]: v });
    console.log(`  site ${site.toString(16)} = ${v.toString(16)} -> score ${r.score}`);
    if (r.score > bs.score) { bs = r; bv = v; }
  }
  if (bv !== null) { rules[site] = bv; best = bs; console.log(`ACEITO site ${site.toString(16)} = ${bv.toString(16)} score ${best.score}`); }
  else console.log(`sem ganho em ${site.toString(16)}`);
  fs.writeFileSync('/tmp/rules79.json', JSON.stringify(Object.fromEntries(Object.entries(rules).map(([k, v]) => [(+k).toString(16), v]))));
  fs.writeFileSync('/tmp/search.uart', best.uart);
}
console.log('FIM', JSON.stringify(rules), '\n', best.uart.slice(-400));
