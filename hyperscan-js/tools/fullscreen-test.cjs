const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8797', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ok = (n, c) => console.log((c ? 'OK   ' : 'FALHA') + ' ' + n);
  await page.goto('http://localhost:8797/index.html'); await page.waitForTimeout(800);
  // 1. tela ocupa o viewport inteiro (paisagem)
  const cb = await page.locator('canvas').boundingBox(); const vp = page.viewportSize();
  ok(`canvas ocupa a tela inteira (${Math.round(cb.width)}x${Math.round(cb.height)} em ${vp.width}x${vp.height})`, Math.round(cb.width) === vp.width && Math.round(cb.height) === vp.height);
  ok('tela inicial com Rodar e engrenagem visíveis', await page.locator('#start').isVisible() && await page.locator('#gear').isVisible());
  // 2. carregar e ligar controle
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.setInputFiles('#disc', '/mnt/user-data/uploads/Spider-Man__USA_.bin'); await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('welcome').classList.add('hide'));
  await page.click('#gear'); await page.waitForTimeout(100);
  ok('controle virtual visível em toque', await page.locator('#pad').isVisible());
  // 3. rótulos dos botões de cor = cor emitida
  const lab = async k => (await page.locator(`#face [data-base="${k}"]`).textContent()).trim();
  const pos = await page.evaluate(() => ['fy','fx','fz','fv'].map(c => [c, document.querySelector('.' + c).dataset.base]));
  ok('rótulos padrão: Y(c), X(x), A(z), B(v)', (await lab('c')) === 'Y' && (await lab('x')) === 'X' && (await lab('z')) === 'A' && (await lab('v')) === 'B');
  const padIn = () => page.evaluate(() => window.__getM().io.padIn[0].slice());
  const tap = async sel => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(90); const p = await padIn(); await page.mouse.up(); await page.waitForTimeout(60); return p; };
  // 4. padrão: botão Verde (embaixo) emite bit 0x80 de IN.1
  let p = await tap('#face .fz'); ok('padrão: botão Verde (embaixo) -> IN.1 0x80', (p[1] & 0x80) !== 0);
  // 5. trocar Verde <-> Vermelho
  await page.click('#gear'); await page.check('#swVR'); await page.click('#gear'); await page.waitForTimeout(80);
  ok('com troca: rótulo de baixo vira "X"', (await lab('z')) === 'X');
  p = await tap('#face .fz'); ok('com troca: botão de baixo emite 0x40 (Vermelho)', (p[1] & 0x40) !== 0 && (p[1] & 0x80) === 0);
  // 6. trocar Amarelo <-> Azul
  await page.click('#gear'); await page.check('#swYB'); await page.click('#gear'); await page.waitForTimeout(80);
  p = await tap('#face .fv'); ok('com troca: botão da esquerda (rótulo Amarelo) emite 0x20', (p[1] & 0x20) !== 0 && (p[0] & 0x01) === 0);
  // 7. analógico vertical invertido
  await page.click('#gear'); await page.check('#invY'); await page.click('#gear');
  const sb0 = await page.locator('#stick').boundingBox(); const sb = { x: sb0.x + sb0.width / 2, y: sb0.y + sb0.height / 2 }; await page.mouse.move(sb.x, sb.y); await page.mouse.down(); await page.mouse.move(sb.x, sb.y - 40, { steps: 4 }); await page.waitForTimeout(80); const up = await padIn(); await page.mouse.up(); await page.waitForTimeout(60); ok('analógico invertido: cima -> ay alto', up[2] > 0xc0);
  await page.click('#gear'); await page.uncheck('#invY'); await page.uncheck('#swVR'); await page.uncheck('#swYB'); await page.click('#gear');
  await page.mouse.move(sb.x, sb.y); await page.mouse.down(); await page.mouse.move(sb.x, sb.y - 40, { steps: 4 }); await page.waitForTimeout(80); const up2 = await padIn(); await page.mouse.up(); await page.waitForTimeout(60); ok('desmarcar trocas volta ao padrão: cima -> ay baixo', up2[2] < 0x40);
  p = await tap('#face .fz'); ok('padrão restaurado: Verde -> 0x80', (p[1] & 0x80) !== 0);
  // 8. Start/Select de teclado e virtual
  p = await tap('#mid [data-k=Enter]'); ok('Start virtual -> 0x02', (p[0] & 2) !== 0);
  // 9. tela cheia pelo painel não quebra nada
  await page.click('#gear'); await page.click('#fsbtn').catch(()=>{}); await page.click('#gear').catch(()=>{}); await page.waitForTimeout(100);
  ok('sem erros JavaScript', errs.length === 0); if (errs.length) console.log(errs.slice(0,2));
  await page.screenshot({ path: '/tmp/fs-land.png' });
  await browser.close(); srv.kill();
})();
