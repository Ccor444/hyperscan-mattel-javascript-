const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8901', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://localhost:8901/index.html'); await page.waitForTimeout(600);
  await page.click('#helpOpen'); await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/help-phone.png' });
  await browser.close(); srv.kill();
})();
