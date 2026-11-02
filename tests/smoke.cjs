const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push('pageerror ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#bios', '/tmp/zero.bin');
  await p.waitForTimeout(800);
  await p.evaluate(() => document.getElementById('start').click());
  await p.waitForTimeout(2500);
  console.log('stat:', await p.textContent('#stat'));
  console.log('log:', (await p.textContent('#log')).split('\n')[0]);
  console.log('erros:', errs.length ? errs : 'nenhum');
  await b.close();
})();
