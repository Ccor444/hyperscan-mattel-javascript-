const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8851', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  await page.goto('http://localhost:8851/index.html'); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(600); await page.click('#gear');
  await page.evaluate(() => document.getElementById('start').click());
  const phase = async (name, ms, act) => {
    await page.evaluate(() => { window.__getM().io.spuChip.peak = 0; });
    if (act) await act(); await page.waitForTimeout(ms);
    const pk = await page.evaluate(() => window.__getM().io.spuChip.peak);
    const f = await page.evaluate(() => window.__getM().io.frames);
    console.log(name.padEnd(12), 'pico do SPU=' + pk.toFixed(3), 'quadros=' + f);
  };
  await phase('boot+jingle', 4000);
  await page.waitForFunction(() => window.__getM().bus.r32(0xa0154e30 - 14332) === 35, null, { timeout: 120000, polling: 500 });
  await phase('menu', 3000);
  await phase('cursor', 2500, async () => { await page.keyboard.down('ArrowDown'); await page.waitForTimeout(400); await page.keyboard.up('ArrowDown'); });
  await phase('start', 5000, async () => { await page.keyboard.down('Enter'); await page.waitForTimeout(400); await page.keyboard.up('Enter'); });
  await browser.close(); srv.kill();
})();
