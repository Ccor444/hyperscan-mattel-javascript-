const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage();
  await p.route('**/wasm/hyperscan-wasm.js', r => r.fulfill({ status: 404, body: 'x' }));
  await p.goto('http://localhost:8765/index.html'); await p.waitForTimeout(2500);
  console.log((await p.textContent('#err')).trim()); await b.close();
})();
