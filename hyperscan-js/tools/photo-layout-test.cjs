const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8910', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ok = (n, c) => console.log((c ? 'OK   ' : 'FALHA') + ' ' + n);
  await page.goto('http://localhost:8910/index.html'); await page.waitForTimeout(600);
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(400); await page.check('#vpad'); await page.click('#gear');
  await page.evaluate(() => document.getElementById('welcome').classList.add('hide')); await page.waitForTimeout(200);
  const box = async sel => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };
  // posições do losango (foto: vermelho em cima, amarelo à esquerda, azul à direita, verde embaixo)
  const f = { x: await box('#face .fx'), y: await box('#face .fy'), v: await box('#face .fv'), z: await box('#face .fz') };
  ok('losango: vermelho em cima', f.x.y < f.y.y && f.x.y < f.z.y && Math.abs(f.x.x - f.z.x) < 2);
  ok('losango: amarelo à esquerda', f.y.x < f.x.x && Math.abs(f.y.y - f.v.y) < 2);
  ok('losango: azul à direita', f.v.x > f.x.x && Math.abs(f.v.y - f.y.y) < 2);
  ok('losango: verde embaixo', f.z.y > f.y.y && Math.abs(f.z.x - f.x.x) < 2);
  const st = await box('#mid [data-k=Enter]'), se = await box('#mid [data-k=Shift]');
  ok('START acima de SELECT (como na foto)', st.y < se.y && Math.abs(st.x - se.x) < 4);
  const sl = await box('#sl .vb'), sr = await box('#sr .vb');
  ok('um ombro de cada lado (L à esquerda, R à direita)', sl.x < 422 && sr.x > 422);
  ok('sem LT/RT na tela', (await page.locator('[data-k=q],[data-k=w]').count()) === 0);
  ok('sem D-pad de setas na tela', (await page.locator('#dp').count()) === 0);
  // analógico: arrastar nas quatro direções
  const pad = () => page.evaluate(() => window.__getM().io.padIn[0].slice());
  const sc = await box('#stick');
  const drag = async (dx, dy) => { await page.mouse.move(sc.x, sc.y); await page.mouse.down(); await page.mouse.move(sc.x + dx, sc.y + dy, { steps: 4 }); await page.waitForTimeout(80); const p = await pad(); await page.mouse.up(); await page.waitForTimeout(60); return p; };
  let p = await drag(40, 0); ok('analógico direita -> ax alto (' + p[3].toString(16) + ')', p[3] > 0xc0 && p[2] > 0x60 && p[2] < 0x9f);
  p = await drag(-40, 0); ok('analógico esquerda -> ax baixo (' + p[3].toString(16) + ')', p[3] < 0x40);
  p = await drag(0, -40); ok('analógico cima -> ay baixo (' + p[2].toString(16) + ')', p[2] < 0x40);
  p = await drag(0, 40); ok('analógico baixo -> ay alto (' + p[2].toString(16) + ')', p[2] > 0xc0);
  p = await pad(); ok('solto volta ao centro (ax=' + p[3].toString(16) + ')', p[3] === 0x7f && p[2] === 0x7f);
  // botões do losango e START pela cor/rótulo
  const tap = async sel => { const b = await box(sel); await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.waitForTimeout(80); const q = await pad(); await page.mouse.up(); await page.waitForTimeout(60); return q; };
  p = await tap('#face .fx'); ok('vermelho (em cima) -> IN.1 0x40', (p[1] & 0x40) !== 0);
  p = await tap('#face .fv'); ok('azul (à direita) -> IN.0 0x01', (p[0] & 0x01) !== 0);
  p = await tap('#face .fz'); ok('verde (embaixo) -> IN.1 0x80', (p[1] & 0x80) !== 0);
  p = await tap('#face .fy'); ok('amarelo (à esquerda) -> IN.1 0x20', (p[1] & 0x20) !== 0);
  p = await tap('#mid [data-k=Enter]'); ok('START -> 0x02', (p[0] & 0x02) !== 0);
  p = await tap('#mid [data-k=Shift]'); ok('SELECT -> 0x04', (p[0] & 0x04) !== 0);
  // teclado segue funcionando
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(80); p = await pad(); await page.keyboard.up('ArrowRight');
  ok('teclado: seta direita -> ax alto', p[3] > 0xc0);
  ok('sem erros JavaScript', errs.length === 0); if (errs.length) console.log(errs.slice(0,2));
  await page.screenshot({ path: '/tmp/photo-layout.png' });
  await browser.close(); srv.kill();
})().catch(e => { console.log('falhou:', e.message.split('\n')[0]); process.exit(0); });
