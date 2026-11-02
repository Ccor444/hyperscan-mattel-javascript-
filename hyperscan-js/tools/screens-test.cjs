const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8798', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  for (const [name, vp] of [['land', { width: 844, height: 390 }], ['port', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true });
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(e.message));
    await page.goto('http://localhost:8798/index.html'); await page.waitForTimeout(600);
    await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(800); await page.click('#gear');
    await page.click('#run'); await page.waitForTimeout(32000);
    const st = await page.locator('#stat').textContent();
    await page.screenshot({ path: `/tmp/shot-${name}.png` });
    console.log(name, 'stat:', st, 'classe portrait:', await page.evaluate(() => document.body.className));
    await ctx.close();
  }
  console.log(errs.length === 0 ? 'OK   sem erros JavaScript' : 'FALHA ' + errs.slice(0,2).join(' | '));
  await browser.close(); srv.kill();
})();
