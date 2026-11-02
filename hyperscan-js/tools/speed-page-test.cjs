const { chromium } = require('playwright');
const { spawn } = require('child_process');
const dir = process.argv[2], port = process.argv[3];
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', port, '--directory', dir], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(600); await page.click('#gear');
  await page.click('#run');
  const samples = [];
  for (let i = 0; i < 9; i++) { await page.waitForTimeout(5000); samples.push(await page.evaluate(() => document.getElementById('stat').textContent)); }
  const q = samples.map(s => +(s.match(/([\d.]+) quadros/) || [])[1] || 0), mi = samples.map(s => +(s.match(/([\d.]+) MIPS/) || [])[1] || 0);
  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  console.log(`${dir.split('/').pop().padEnd(8)} média quadros/s=${avg(q)} MIPS=${avg(mi)} | amostras: ${samples.slice(-3).join(' / ')} | erros=${errs.length}`);
  await browser.close(); srv.kill();
})();
