const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8796', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8796/index.html'); await page.waitForTimeout(800);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('welcome').classList.add('hide'));
  await page.check('#vpad'); await page.click('#gear'); await page.waitForTimeout(200);   // painel já está aberto desde o passo anterior
  const center = async k => { const b = await page.locator(`#pad [data-k="${k}"]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const padIn = () => page.evaluate(() => window.__getM().io.padIn[0].slice());
  const cdp = await ctx.newCDPSession(page);
  const a = await center('v'), b = await center('z');   // Azul e Verde
  // dois dedos: touchStart com dois pontos (ids distintos) e depois soltar
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }, { x: b.x, y: b.y, id: 2 }] });
  await page.waitForTimeout(150);
  const both = await padIn();
  console.log((((both[0] & 1) === 1) && ((both[1] & 0x80) !== 0) ? 'OK   ' : 'FALHA') + ' multitoque: Azul=' + (both[0] & 1) + ' Verde=' + ((both[1] & 0x80) ? 1 : 0));
  // solta só um dedo (Azul): Verde deve continuar pressionado
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x, y: b.y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const after = await padIn();
  console.log(((after[0] & 1) === 0 && (after[1] & 0x80) === 0) ? 'OK   soltar tudo limpa os botões' : 'FALHA soltar tudo: ' + after.map(v => v.toString(16)).join(','));
  console.log(errs.length === 0 ? 'OK   sem erros JavaScript' : 'FALHA erros: ' + errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: '/tmp/ui-phone.png' });
  await browser.close(); srv.kill();
})();
