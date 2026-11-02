const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8865', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  await page.goto('http://localhost:8865/index.html'); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(600); await page.click('#gear');
  await page.evaluate(() => document.getElementById('start').click());
  await page.waitForTimeout(6000);
  await page.evaluate(() => { window.__emu = 0; window.__ins = 0; window.__rafs = 0; window.__brk = 0; });
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => ({ rafs: window.__rafs, emu: window.__emu, ins: window.__ins, brk: window.__brk, lvl: window.__lvl, f: window.__getM().io.frames }));
  console.log(`rAF=${r.rafs} | tempo de emulação por rAF=${(r.emu/r.rafs).toFixed(1)} ms | paradas por áudio=${r.brk} | nível de áudio agora=${r.lvl.toFixed(3)} s | MIPS dentro do laço=${(r.ins/(r.emu/1000)/1e6).toFixed(1)}`);
  await browser.close(); srv.kill();
})();
