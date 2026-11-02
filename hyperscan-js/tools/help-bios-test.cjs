const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8900', '--directory', '/tmp/uitest'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ok = (n, c) => console.log((c ? 'OK   ' : 'FALHA') + ' ' + n);
  await page.goto('http://localhost:8900/index.html'); await page.waitForTimeout(700);
  ok('Rodar desabilitado sem BIOS (primeira visita)', await page.locator('#start').isDisabled());
  await page.click('#gear'); await page.setInputFiles('#bios', '/mnt/user-data/uploads/hyperscan.bin'); await page.waitForTimeout(500); await page.click('#gear');
  // recarrega: a BIOS deve voltar do cache
  await page.reload(); await page.waitForTimeout(1200);
  ok('BIOS lembrada após recarregar (Rodar habilitado)', !(await page.locator('#start').isDisabled()));
  ok('disco NÃO é lembrado', (await page.locator('#stDisc').textContent()).includes('Nenhum'));
  // ajuda
  ok('ajuda fechada no início', !(await page.locator('#help').evaluate(e => e.classList.contains('open'))));
  await page.click('#helpOpen'); await page.waitForTimeout(200);
  ok('ajuda abre pela tela inicial', await page.locator('#help').evaluate(e => e.classList.contains('open')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ok('Esc fecha a ajuda', !(await page.locator('#help').evaluate(e => e.classList.contains('open'))));
  await page.click('#gear'); await page.click('#helpBtn'); await page.waitForTimeout(150);
  ok('ajuda abre pelo painel (⚙ → Ajuda)', await page.locator('#help').evaluate(e => e.classList.contains('open')));
  await page.click('#helpClose'); await page.waitForTimeout(150);
  // esquecer
  await page.click('#gear'); await page.click('#forgetBios'); await page.waitForTimeout(400); await page.click('#gear');
  await page.reload(); await page.waitForTimeout(1200);
  ok('Esquecer BIOS apaga o cache (Rodar desabilitado após recarregar)', await page.locator('#start').isDisabled());
  ok('sem erros JavaScript', errs.length === 0); if (errs.length) console.log(errs.slice(0,2));
  await browser.close(); srv.kill();
})().catch(e => { console.log('falhou:', e.message.split('\n')[0]); process.exit(0); });
