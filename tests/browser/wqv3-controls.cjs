// Isolated browser with fake USB and protocol boundaries. No physical adapter.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const url = new URL('wqv3.html', process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv3-controls-browser');

const adapterModule = `
export const describeUSBDevice = () => ({label:'Mock IrDA · 066f:4200', name:'Mock IrDA',usbId:'066f:4200',supported:true,driver:'SigmaTel STIr4200'});
export function createAdapter() {
  return {opened:false, configured:false,baud:9600,decoder:{badCRC:0,frames:[],reset(){}},
    async open(){this.opened=true;return describeUSBDevice();},
    async close(){this.opened=false;},async pauseReader(){},async setupSIR(){this.configured=true;},
    assertOpen(){if(!this.opened)throw Error('Closed');}};
}`;

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const fixture = JSON.parse(await fs.readFile(path.join(repo, 'tests/fixtures/wqv3-album-hardware.json')));
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.__calls = []; window.__uploads = [];
      Object.defineProperty(navigator, 'usb', { configurable: true, value: { addEventListener() {},
        async requestDevice() { return { vendorId: 0x066f, productId: 0x4200, productName: 'Mock IrDA' }; } } });
    });
    await page.route('**/adapters.mjs', route => route.fulfill({ contentType: 'text/javascript', body: adapterModule }));
    const others = await fs.readFile(path.join(repo, 'dist/others-client.mjs'), 'utf8');
    await page.route('**/others-client.mjs', route => route.fulfill({ contentType: 'text/javascript',
      body: others.replace('export async function transferOthers(', 'async function realTransferOthers(') + `
export async function transferOthers(adapter, {file, direction}) {
  const {jpegFromUPF,toHex}=await import('./formats.mjs');
  window.__uploads.push({mode:'others',filename:file.filename,jpeg:toHex(jpegFromUPF(file.bytes))});
  return {direction,complete:true,putReplies:[{accepted:true,storedFilename:file.filename}],uploadOutcome:'accepted'};
}` }));
    await page.goto(url);
    await page.evaluate(async () => {
      const { WQVClient } = await import('./protocol.mjs');
      const { jpegFromUPF, toHex, b } = await import('./formats.mjs');
      WQVClient.prototype.openPrimary = async function () {
        window.__calls.push('connect');
        if (window.__delayConnect) await new Promise(resolve => setTimeout(resolve, 500));
        this.connected = true; this.isPrimary = true; this.model = 3;
      };
      WQVClient.prototype.primaryExchange = async function () { await new Promise(resolve => setTimeout(resolve, 5)); };
      WQVClient.prototype.control = async function (command) {
        window.__calls.push(toHex(command)); return b(13);
      };
      WQVClient.prototype.disconnect = async function () {
        window.__calls.push('disconnect'); this.disconnectConfirmed = true; this.connected = false;
      };
      WQVClient.prototype.close = async function () { this.connected = false; };
      WQVClient.prototype.upload = async function (upf, filename) {
        window.__uploads.push({ mode: 'pc', filename, jpeg: toHex(jpegFromUPF(upf)) });
        this.connected = false; return filename;
      };
    });
    await page.locator('#connect').click();
    await page.waitForFunction(() => !document.getElementById('find-watch').disabled);
    await page.locator('#image-files').setInputFiles({ name: 'QW000000.UPF', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.upfs[0], 'hex') });
    await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 1 && !document.getElementById('upload-image').disabled);
    const originalName = await page.locator('#selected-name').innerText();
    await page.locator('.photo-details summary').click();
    assert.equal(await page.locator('#upload-caption').inputValue(), '*  A   AAAB');
    assert.equal(await page.locator('#upload-caption').isEnabled(), false);
    await page.locator('#upload-edit-details').check();
    await page.locator('#upload-caption').fill('WEBUSB / TEST');
    await page.locator('#upload-date').fill('2026-10-30T14:15');
    await page.locator('#upload-image').click();
    await page.waitForFunction(() => window.__uploads.length === 1 && !document.getElementById('upload-image').disabled);
    assert.equal(await page.locator('#selected-name').innerText(), originalName);
    assert.equal(await page.locator('#result-heading').innerText(), 'Photo sent');
    // The same selected bytes and edited metadata go through either protocol.
    await page.locator('[data-mode=others]').click();
    await page.locator('#upload-image').click();
    await page.waitForFunction(() => !document.getElementById('transfer-start').disabled);
    assert.equal(await page.locator('#upload-caption').isEnabled(), false, 'Freeze details once a transfer is prepared');
    await page.locator('#transfer-start').click();
    await page.waitForFunction(() => window.__uploads.length === 2 && !document.getElementById('transfer-dialog').open);
    const uploads = await page.evaluate(() => window.__uploads);
    assert.equal(uploads[0].jpeg, uploads[1].jpeg);
    const data = await page.evaluate(async hex => {
      const { fromHex } = await import('./formats.mjs'); const { watchPhotoDetails } = await import('./wqv3-photo-details.mjs');
      return watchPhotoDetails(fromHex(hex));
    }, uploads[0].jpeg);
    assert.deepEqual(data, { caption: 'WEBUSB / TEST', recordedAt: '2026-10-30T14:15' });
    assert.equal(await page.locator('#quit-remote').isVisible(), false);
    // Reject unsupported captions before opening a watch session or sending.
    await page.locator('#upload-caption').fill('Привет');
    const countBefore = await page.evaluate(() => window.__uploads.length);
    await page.locator('#upload-image').click();
    await page.locator('#message-dialog[open]').waitFor();
    assert.match(await page.locator('#dialog-message').innerText(), /24 ASCII/);
    assert.equal(await page.evaluate(() => window.__uploads.length), countBefore);
    await page.locator('#dialog-accept').click();
    await page.locator('#upload-edit-details').uncheck();
    // Keep drafts when changing language; reset them when a different photo is selected.
    for (const language of ['ru', 'ja', 'en']) {
      await page.evaluate(async language => (await import('./i18n.mjs')).setLanguage(language), language);
      assert.equal(await page.locator('html').getAttribute('lang'), language);
      assert.equal(await page.locator('#upload-caption').inputValue(), 'Привет');
      assert.notEqual(await page.locator('.photo-details summary').innerText(), language === 'en' ? '' : 'Photo details');
    }
    await page.locator('[data-mode=pc]').click();
    await page.locator('#remote-fast-forward').click();
    await page.waitForFunction(() => window.__calls.filter(c => c === '02').length === 5 && !document.getElementById('remote-back').disabled);
    assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => ['02', '04', '06'].includes(c))), Array(5).fill('02'));
    // Keyboard activation must also step exactly five, without a hold command.
    await page.locator('#remote-fast-back').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__calls.filter(c => c === '03').length === 5 && !document.getElementById('remote-back').disabled);
    const button = page.locator('#remote-fast-forward'), box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.waitForFunction(() => window.__calls.includes('04'));
    await page.mouse.move(20, 20); await page.mouse.up();
    await page.waitForFunction(() => window.__calls.includes('06') && !document.getElementById('remote-back').disabled);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c === '04').length), 1);
    const stopped = await page.evaluate(() => window.__calls.filter(c => c === '06').length);
    await page.locator('#remote-fast-back').dispatchEvent('pointerdown', { button: 0, pointerId: 10 });
    await page.waitForFunction(() => window.__calls.includes('05'));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(n => window.__calls.filter(c => c === '06').length > n && !document.getElementById('remote-back').disabled, stopped);
    const stoppedAgain = await page.evaluate(() => window.__calls.filter(c => c === '06').length);
    await page.locator('#remote-fast-back').dispatchEvent('pointerdown', { button: 0, pointerId: 11 });
    await page.waitForFunction(() => window.__calls.filter(c => c === '05').length === 2);
    await page.locator('#stop').click();
    await page.waitForFunction(n => window.__calls.filter(c => c === '06').length > n && !document.getElementById('remote-back').disabled, stoppedAgain);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11 })));
    assert.equal(await page.locator('#connect').isEnabled(), false, 'Cancel stops browsing without closing USB');
    // A cancelled gesture and a release during connection setup must not start browsing later.
    await page.locator('#tab-connection').click(); await page.locator('#quit-remote').click();
    await page.waitForFunction(() => document.getElementById('result-heading').textContent === 'REMOTE exit acknowledged');
    const quit = await page.evaluate(() => window.__calls.slice(-2)); assert.deepEqual(quit, ['0c', 'disconnect']);
    await page.locator('#tab-photos').click(); await page.evaluate(() => { window.__delayConnect = true; window.__calls = []; });
    await page.locator('#remote-fast-forward').dispatchEvent('pointerdown', { button: 0, pointerId: 12 });
    await page.waitForFunction(() => window.__calls.includes('connect'));
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 12 })));
    await page.waitForFunction(() => !document.getElementById('remote-back').disabled);
    assert.ok(!await page.evaluate(() => window.__calls.includes('04')));
    await page.locator('#remote-fast-back').dispatchEvent('pointerdown', { button: 0, pointerId: 13 });
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 13 })));
    assert.ok(!await page.evaluate(() => window.__calls.includes('03')));
    await page.locator('#image-files').setInputFiles({ name: 'QW000001.UPF', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.upfs[1], 'hex') });
    await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 2 && !document.getElementById('import-images').disabled);
    assert.equal(await page.locator('#upload-edit-details').isChecked(), false);
    assert.notEqual(await page.locator('#upload-caption').inputValue(), 'Привет');
    for (const language of ['en', 'ru', 'ja']) {
      await page.evaluate(async language => (await import('./i18n.mjs')).setLanguage(language), language);
      await page.screenshot({ path: path.join(artifacts, language + '-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('PASS: PC/OTHERS metadata, original preservation, validation, tap/hold/release/cancel, quit, three languages and mobile');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
