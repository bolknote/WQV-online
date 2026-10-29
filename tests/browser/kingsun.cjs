// Isolated browser, simulated USB/helper only. Never opens a physical adapter.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const appURL = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-kingsun-browser');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1150 } });
  const calls = [], errors = []; let online = false;
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const device = { vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA', manufacturerName: 'Kingsun CO.',
      open() { throw new Error('The browser must not claim KS-959.'); } };
    Object.defineProperty(navigator, 'usb', { value: { requestDevice: async () => device, addEventListener() {} } });
  });
  // Intercept every helper request, including preflight, before opening the app.
  await page.route('http://127.0.0.1:8767/**', async route => {
    if (!online) { await route.abort(); return; }
    const headers = { 'Access-Control-Allow-Origin': new URL(appURL).origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Private-Network': 'true' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const call = route.request().postDataJSON(); calls.push(call);
    const result = call.method === 'open' ? { vendorId: 0x07d0, productId: 0x4959, session: 'owned-browser-session' } :
      call.method === 'controlTransferIn' ? { status: 'ok', hex: '' } :
      call.method === 'controlTransferOut' ? { status: 'ok', bytesWritten: call.args[1].hex.length / 2 } : {};
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ result }) });
  });
  try {
    await page.goto(appURL); await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelector('#result-detail').textContent.includes('Cannot reach the KS-959 USB helper'));
    assert.equal(await page.locator('#kingsun-help').isVisible(), true);
    assert.match(await page.locator('#kingsun-help').innerText(), /python3 kingsun_bridge.py/);
    assert.equal(await page.locator('#connect').isEnabled(), true);
    online = true;
    await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelector('#connection-badge').textContent === 'USB connected');
    await page.locator('#tab-connection').click();
    assert.equal(await page.locator('#adapter-label').innerText(), 'USB to IRDA · 07d0:4959');
    assert.equal(await page.locator('#endpoints').innerText(), 'Control endpoint 0');
    assert.equal(await page.locator('#registers').isVisible(), false);
    await page.locator('#test-usb').click();
    await page.waitForFunction(() => document.querySelector('#result-heading').textContent === 'USB communication is working');
    assert.ok(calls.some(c => c.method === 'controlTransferIn'));
    const speeds = calls.filter(c => c.method === 'controlTransferOut');
    assert.equal(speeds.length, 3); assert.ok(speeds.every(c => c.args[0].index === 1 && c.args[1].hex === '8025000003000000'));
    await page.screenshot({ path: (await fs.mkdir(artifacts, { recursive: true }), path.join(artifacts, 'ks959-connected.png')), fullPage: true });
    await page.locator('#disconnect').click();
    await page.waitForFunction(() => document.querySelector('#connection-badge').textContent === 'USB not connected');
    assert.equal(calls.at(-1).method, 'close');
    assert.deepEqual(errors, []);
    console.log('KS-959 browser: helper instructions, connection, USB test, control endpoint and clean close passed.');
    console.log('Screenshot:', path.join(artifacts, 'ks959-connected.png'));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
