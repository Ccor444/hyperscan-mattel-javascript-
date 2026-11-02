import { HyperScan as JS } from './jsref/hyperscan.js';
import { HyperScan as WS } from '../wasm/hyperscan-wasm.js';
import { makeBios } from './gen.mjs';
const seeds = +process.argv[2] || 60, chunks = +process.argv[3] || 20, per = 1000;
let bad = 0, totalI = 0, errs = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const bios = makeBios(seed);
  const j = new JS(bios, {}), w = await WS.create(bios, {});
  j.cpu.useJit = (seed % 2 === 0);
  for (let c = 0; c < chunks; c++) {
    j.run(per); w.run(per); totalI += per;
    if (j.error && w.error) { const a=/@([0-9a-f]+)/.exec(j.error)[1], b=/@([0-9a-f]+)/.exec(w.error)[1]; if (a!==b) { console.log('seed',seed,'error pc differs',j.error,w.error); bad++; } errs++; break; }
    const jc = j.cpu, wx = w.x, h = w.h; const diffs = [];
    for (let i = 0; i < 32; i++) { if (jc.r[i] !== wx.hs_dbg_cpu(h, 0, i)) diffs.push('r' + i); if (jc.cr[i] !== wx.hs_dbg_cpu(h, 1, i)) diffs.push('cr' + i); if (jc.sr[i] !== wx.hs_dbg_cpu(h, 2, i)) diffs.push('sr' + i); }
    if ((jc.cel | 0) !== (wx.hs_dbg_cpu(h, 3, 0) | 0)) diffs.push('cel'); if ((jc.ceh | 0) !== (wx.hs_dbg_cpu(h, 4, 0) | 0)) diffs.push('ceh');
    const fl = jc.N | jc.Z << 1 | jc.C << 2 | jc.V << 3 | jc.T << 4; if (fl !== wx.hs_dbg_cpu(h, 5, 0)) diffs.push('flags');
    if (jc.pc !== wx.hs_dbg_cpu(h, 6, 0)) diffs.push('pc ' + jc.pc.toString(16) + ' vs ' + wx.hs_dbg_cpu(h, 6, 0).toString(16));
    if (jc.cycles !== wx.hs_dbg_cpu(h, 7, 0)) diffs.push('cycles ' + jc.cycles + ' vs ' + wx.hs_dbg_cpu(h, 7, 0));
    if (!!j.error !== !!w.error) diffs.push('error ' + j.error + ' | ' + w.error);
    if (j.uart !== w.uart) diffs.push('uart');
    if (diffs.length) { diffs.push('JSerr='+j.error+' WSerr='+w.error); console.log(`seed ${seed} chunk ${c}:`, diffs.slice(0, 8).join(', ')); bad++; break; }
    if (j.error) { errs++; break; }
  }
  w.destroy();
}
console.log(`seeds=${seeds} instr~${totalI} diverged=${bad} stoppedByUnknownOp=${errs}`);
