const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const run = async (name, ctxOpts) => {
    const c = await b.newContext(ctxOpts), p = await c.newPage();
    await p.goto('http://localhost:8765/index.html');
    await p.setInputFiles('#bios', '/home/claude/game/bios.bin');
    await p.setInputFiles('#disc', '/home/claude/game/Spider-Man (USA).bin');
    await p.waitForTimeout(1200); await p.evaluate(() => document.getElementById('start').click()); await p.waitForTimeout(6000);
    const r = await p.evaluate(() => ({ show: document.getElementById('pad').classList.contains('show'), chk: document.getElementById('vpad').checked,
      mid: JSON.parse(JSON.stringify(document.getElementById('mid').getBoundingClientRect())), sl: document.getElementById('sl').getBoundingClientRect().top, gh: getComputedStyle(document.getElementById('pad')).getPropertyValue('--gh'), vw: innerWidth, vh: innerHeight }));
    console.log(name, JSON.stringify({ show: r.show, chk: r.chk, midTop: Math.round(r.mid.top), midH: Math.round(r.mid.height), midW: Math.round(r.mid.width), slTop: Math.round(r.sl), gh: r.gh, vw: r.vw, vh: r.vh }));
    await p.screenshot({ path: `/tmp/pad_${name}.png` }); await c.close();
  };
  await run('desktop', { viewport: { width: 1200, height: 800 } });
  await run('phone_land', { ...devices['Pixel 7'], viewport: { width: 915, height: 412 } });
  await run('phone_port', { ...devices['Pixel 7'] });
  await b.close();
})();
