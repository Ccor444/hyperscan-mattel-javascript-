const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8905', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8905/index.html'); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(400);
  await page.check('#vpad'); await page.click('#gear');
  await page.evaluate(() => document.getElementById('welcome').classList.add('hide'));
  await page.waitForTimeout(300); await page.screenshot({ path: '/tmp/ctrl-land.png' });
  console.log('erros:', errs.length ? errs[0] : 'nenhum');
  await browser.close(); srv.kill();
})();
