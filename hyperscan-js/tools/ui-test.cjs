const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8795', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8795/index.html'); await page.waitForTimeout(800);
  const vis = async sel => page.locator(sel).isVisible();
  const ok = (name, cond) => console.log((cond ? 'OK   ' : 'FALHA') + ' ' + name);
  // 1. engrenagem
  ok('painel começa fechado', !(await vis('#panel')));
  await page.click('#gear'); ok('engrenagem abre o painel', await vis('#panel'));
  ok('BIOS e disco estão dentro do painel', await page.locator('#panel #bios').count() === 1 && await page.locator('#panel #disc').count() === 1);
  await page.mouse.click(380, 700); ok('clique fora fecha o painel', !(await vis('#panel')));
  await page.click('#gear'); await page.click('#gear'); ok('engrenagem alterna (fecha)', !(await vis('#panel')));
  // 2. carregar arquivos pelo painel (inputs ocultos ainda funcionam)
  await page.click('#gear');
  await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin');
  await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin');
  await page.waitForTimeout(1500);
  const logTxt = await page.locator('#log').textContent();
  ok('BIOS e disco carregados pelo painel', logTxt.includes('disco:') && logTxt.includes('pc='));
  await page.evaluate(() => document.getElementById('welcome').classList.add('hide'));
  await page.click('#gear');
  // 3. controle virtual: padrão em desktop = oculto; ligar pelo painel mostra
  ok('controle virtual oculto no desktop por padrão', !(await vis('#pad')));
  await page.click('#gear'); await page.check('#vpad'); await page.click('#gear');
  ok('ligar controle virtual mostra o pad', await vis('#pad'));
  // 4. toque/mouse: Start
  const pick = async k => { if (!k.startsWith('Arrow')) { const bb = await page.locator(`#pad [data-k="${k}"]`).boundingBox(); return [bb.x + bb.width / 2, bb.y + bb.height / 2]; } const bb = await page.locator('#stick').boundingBox(); const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2, o = 40; const m = { ArrowRight: [cx + o, cy], ArrowLeft: [cx - o, cy], ArrowUp: [cx, cy - o], ArrowDown: [cx, cy + o] }; return m[k]; };
  const padIn = () => page.evaluate(() => window.__getM().io.padIn[0].slice());
  let [x, y] = await pick('Enter'); await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(100);
  const p1 = await padIn(); ok('Start virtual pressionado -> bit 0x02 em IN.0 (' + p1[0].toString(16) + ')', (p1[0] & 0x02) !== 0);
  await page.mouse.up(); await page.waitForTimeout(100);
  const p2 = await padIn(); ok('Start solto -> bit limpo', (p2[0] & 0x02) === 0);
  // 5. dpad direita -> analógico X = 0xff; esquerda -> 0x00
  [x, y] = await pick('ArrowRight'); await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(100);
  const pr = await padIn(); ok('analógico direita -> ax alto (' + pr[3].toString(16) + ')', pr[3] > 0xc0);
  await page.mouse.up(); await page.waitForTimeout(100);
  [x, y] = await pick('ArrowLeft'); await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(100);
  const pl = await padIn(); ok('analógico esquerda -> ax baixo (' + pl[3].toString(16) + ')', pl[3] < 0x40);
  await page.mouse.up(); await page.waitForTimeout(100);
  // 6. multitoque: Azul (v) + Verde (z) ao mesmo tempo
  [x, y] = await pick('v'); await page.mouse.move(x, y); await page.mouse.down();
  const [x2, y2] = await pick('z'); await page.mouse.move(x2, y2); await page.mouse.down(); await page.waitForTimeout(100);
  const both = await padIn(); ok('dois botões ao mesmo tempo (in0 azul=' + (both[0] & 1) + ', in1 verde=' + ((both[1] & 0x80) ? 1 : 0) + ')', (both[0] & 1) === 1 && (both[1] & 0x80) !== 0);
  await page.mouse.up(); await page.waitForTimeout(100);
  // 7. teclado continua funcionando
  await page.keyboard.down('Enter'); await page.waitForTimeout(100);
  const kb = await padIn(); ok('teclado Enter ainda funciona -> bit 0x02', (kb[0] & 0x02) !== 0);
  await page.keyboard.up('Enter');
  // 8. rodar e medir FPS
  await page.evaluate(() => document.getElementById('start').click()); await page.waitForTimeout(4000);
  const st = await page.locator('#stat').textContent(); ok('emulação roda (stat: ' + st + ')', st.includes('quadros/s'));
  ok('sem erros JavaScript', errs.length === 0); if (errs.length) console.log(errs.slice(0,3));
  await page.screenshot({ path: '/tmp/ui-mobile.png' });
  await browser.close(); srv.kill();
})();
