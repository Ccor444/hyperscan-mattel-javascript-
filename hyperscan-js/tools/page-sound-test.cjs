const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8790', '--directory', ''+require('path').resolve(__dirname,'..')+''], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  // medidor: intercepta a propriedade onaudioprocess; mede o buffer DEPOIS que a página o preenche
  await page.addInitScript(() => {
    window.__w = { win: 'idle', stats: {} };
    const orig = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function (...a) {
      const node = orig.apply(this, a);
      // listener registrado ANTES do handler da página: lê o buffer num setTimeout, depois que todos os handlers do evento rodaram
      node.addEventListener('audioprocess', (ev) => {
        const ob = ev.outputBuffer;
        setTimeout(() => {
          const d = ob.getChannelData(0), e = ob.getChannelData(1);
          let p = 0, nz = 0; for (let i = 0; i < d.length; i++) { const v = Math.max(Math.abs(d[i]), Math.abs(e[i])); if (v > p) p = v; if (v > 0.001) nz++; }
          const s = window.__w.stats[window.__w.win] || (window.__w.stats[window.__w.win] = { cb: 0, nzCb: 0, peak: 0, nzSamples: 0 });
          s.cb++; if (nz > 0) s.nzCb++; s.nzSamples += nz; if (p > s.peak) s.peak = p;
        }, 0);
      });
      return node;
    };
  });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8790/index.html');
  await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin');
  await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin');
  await page.waitForTimeout(800);
  await page.click('#run');
  const phase = async (name, ms, action) => { await page.evaluate(n => { window.__w.win = n; }, name); if (action) await action(); await page.waitForTimeout(ms); };
  await phase('boot', 30000);                                   // aguarda o menu (~25-30 s na página)
  await phase('menu_idle', 3000);
  await phase('cursor', 3000, async () => { await page.keyboard.down('ArrowDown'); await page.waitForTimeout(400); await page.keyboard.up('ArrowDown'); });
  await phase('start', 6000, async () => { await page.keyboard.down('Enter'); await page.waitForTimeout(400); await page.keyboard.up('Enter'); });
  const res = await page.evaluate(() => window.__w.stats);
  const q = await page.evaluate(() => document.getElementById('log').textContent.split('\n')[0]);
  console.log('estado final:', q);
  for (const [k, s] of Object.entries(res)) console.log(`${k.padEnd(10)} callbacks=${s.cb} com_som=${s.nzCb} amostras_audiveis=${s.nzSamples} pico=${s.peak.toFixed(3)}`);
  console.log('erros JS:', errs.slice(0, 3));
  await browser.close(); srv.kill();
})();
