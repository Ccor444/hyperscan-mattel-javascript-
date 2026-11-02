const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1000, height: 800 } }); const errs = [];
  p.on('pageerror', e => errs.push('pageerror ' + e.message)); p.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ' ' + m.text()); });
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#bios', '/home/claude/game/bios.bin');
  await p.setInputFiles('#disc', '/home/claude/game/Spider-Man (USA).bin');
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.getElementById('start').click());
  for (let i = 0; i < 5; i++) { await p.waitForTimeout(8000); console.log(i, 'stat:', (await p.textContent('#stat')).replace(/\s+/g, ' ')); }
  await p.screenshot({ path: '/tmp/browser.png' });
  console.log('erros:', errs.length ? errs.slice(0, 5) : 'nenhum');
  await b.close();
})();
