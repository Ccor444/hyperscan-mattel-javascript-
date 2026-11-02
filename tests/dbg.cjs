const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage(); 
  p.on('console', m => console.log('console', m.type(), m.text())); p.on('pageerror', e => console.log('pageerror', e.message));
  p.on('worker', w => console.log('worker criado'));
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#bios', '/home/claude/game/bios.bin');
  await p.setInputFiles('#disc', '/home/claude/game/Spider-Man (USA).bin');
  await p.waitForTimeout(1500); await p.evaluate(() => document.getElementById('start').click());
  await p.waitForTimeout(6000);
  console.log('stat:', await p.textContent('#stat'), '| err:', await p.textContent('#err'));
  await b.close();
})();
