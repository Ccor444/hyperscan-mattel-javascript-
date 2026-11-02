const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8864', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  await page.goto('http://localhost:8864/index.html'); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(600); await page.click('#gear');
  await page.evaluate(() => document.getElementById('start').click());
  const t0 = Date.now();
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(10000);
    const s = await page.evaluate(() => { const m = window.__getM(); return { f: m.io.frames, st: m.bus.r32(0xa0154e30 - 14332), pc: m.cpu.pc.toString(16), stat: document.getElementById('stat').textContent }; });
    console.log(`${((Date.now()-t0)/1000).toFixed(0)}s quadros=${s.f} estado=${s.st} pc=${s.pc} | ${s.stat}`);
    if (s.st === 35) break;
  }
  await browser.close(); srv.kill();
})();
