// Storage and USB failure paths. All USB/helper/watch responses are simulated.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const url = new URL('wqv3.html', process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function mockHelper() {
  const usb = new EventTarget();
  window.__device = { vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA' };
  usb.requestDevice = async () => window.__device;
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });
  window.__helper = { held: false, calls: [], delayClose: false };
  const fetch = window.fetch;
  window.fetch = async (url, options) => {
    if (!String(url).startsWith('http://127.0.0.1:8767/')) return fetch(url, options);
    if (!options.method) return Response.json({ helper: 'WQV Link / KingSun KS-959', version: 1 });
    const call = JSON.parse(options.body), state = window.__helper;
    state.calls.push(call.method);
    if (call.method === 'open') {
      if (state.held) return Response.json({ error: 'KS-959 is already connected' }, { status: 400 });
      state.held = true;
      return Response.json({ result: { vendorId: 0x07d0, productId: 0x4959, session: 'test-session' } });
    }
    if (call.session !== 'test-session') throw Error('Invalid helper session');
    if (call.method === 'close') {
      if (state.delayClose) await new Promise(resolve => { window.__finishClose = resolve; });
      state.held = false;
    } else throw Error('Unexpected helper control: ' + call.method);
    return Response.json({ result: {} });
  };
}

const protocolModel = `
import { HolidayCalendar } from './calendar.mjs';
import { b } from './formats.mjs';
import { imageFromFile } from './images.mjs';
const original = new HolidayCalendar(); original.set(2026, 1, 1, true);
window.__watchCalendar = original.raw; window.__originalCalendar = original.backup();
window.__commands = []; window.__connections = 0;
export class WQVClient {
  constructor(adapter) { this.adapter = adapter; this.isPrimary = true; }
  async openPrimary() { this.connected = true; this.model = 3; window.__connections++; }
  async primaryExchange() {}
  async close() {
    if (window.__delayProtocolClose) await new Promise(resolve => { window.__finishProtocolClose = resolve; });
    this.connected = false;
  }
  async download({ onImage }) {
    const bytes = Uint8Array.from(window.__photoHex.match(/../g), value => parseInt(value, 16));
    const image = await imageFromFile(new File([bytes], 'received.jpg'));
    await onImage(image); this.disconnectConfirmed = true; return [image];
  }
  async control(command) {
    window.__commands.push(command[0]);
    if (window.__failCommand === command[0]) throw Error('Simulated infrared failure');
    if (command[0] === 9) return new HolidayCalendar(window.__watchCalendar);
    if (command[0] === 8) window.__watchCalendar = command.slice(3);
    return b(13);
  }
}
`;

async function pageFor(t, { protocol = false, backupFailure = false, photoFailure = false } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  t.after(() => context.close());
  await context.addInitScript(mockHelper);
  if (photoFailure) await context.addInitScript(hex => {
    window.__photoHex = hex; window.__photoFailure = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__photoFailure && this.name === 'images') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return put.apply(this, args);
    };
  }, (await fs.readFile(repo + '/tests/fixtures/restart-row.jpg')).toString('hex'));
  if (backupFailure) await context.addInitScript(mode => {
    window.__backupFailure = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__backupFailure && this.name === 'settings' && args[1] === 'holidayBackup') {
        if (mode === 'abort') {
          const request = put.apply(this, args), tx = this.transaction;
          request.addEventListener('success', () => tx.abort(), { once: true });
          return request;
        }
        throw new DOMException('Simulated full storage', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  }, backupFailure);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  t.after(() => assert.deepEqual(errors, []));
  page.setDefaultTimeout(5000);
  if (protocol) await page.route('**/protocol.mjs', route => route.fulfill({ contentType: 'text/javascript', body: protocolModel }));
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}
async function connect(page) {
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === 'USB connected');
}
const idle = page => page.waitForFunction(() => document.getElementById('stop').hidden);
const importCalendar = async page => {
  await page.locator('#tab-holidays').click();
  await page.locator('#holiday-file').setInputFiles({ name: 'calendar.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'casio-wqv-holidays-v1', data: 'ff'.repeat(1840) })) });
  await idle(page);
};
async function writeCalendar(page) {
  await page.locator('#send-holidays').click(); await page.locator('#dialog-accept').click(); await idle(page);
}
async function savedBackup(page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import('./images.mjs');
    const store = await new LocalStore().open();
    try { return await store.get('holidayBackup'); } finally { store.db.close(); }
  });
}

test('a failed durable backup blocks calendar overwrite; retry saves the original before writing', async t => {
  const page = await pageFor(t, { protocol: true, backupFailure: true });
  await connect(page); await importCalendar(page); await writeCalendar(page);
  assert.deepEqual(await page.evaluate(() => window.__commands), [9], 'no write command after a backup failure');
  assert.match(await page.locator('#result-detail').innerText(), /original calendar.*not.*saved|Could not save the original calendar/);
  assert.equal(await page.locator('#storage-label').innerText(), 'this tab only');
  assert.equal(await savedBackup(page), undefined);
  assert.equal(await page.locator('#original-backup').isEnabled(), true, 'the read original remains exportable from RAM');
  const download = page.waitForEvent('download'); await page.locator('#original-backup').click();
  const exported = JSON.parse(await fs.readFile(await (await download).path(), 'utf8'));
  assert.equal(exported.data, await page.evaluate(() => window.__originalCalendar.data));

  await page.evaluate(() => { window.__backupFailure = false; });
  await connect(page); await writeCalendar(page);
  assert.deepEqual(await page.evaluate(() => window.__commands), [9, 9, 8, 9]);
  assert.equal((await savedBackup(page)).data, exported.data);
  assert.equal(await page.locator('#result-heading').innerText(), 'Calendar written and verified');
});

test('read-only calendar reception keeps an exportable original when storage rejects its backup', async t => {
  const page = await pageFor(t, { protocol: true, backupFailure: true });
  await connect(page); await page.locator('#tab-holidays').click(); await page.locator('#read-holidays').click(); await idle(page);
  assert.deepEqual(await page.evaluate(() => window.__commands), [9]);
  assert.equal(await page.locator('#result-heading').innerText(), 'Calendar received');
  assert.match(await page.locator('#result-detail').innerText(), /this tab only/);
  assert.equal(await page.locator('#original-backup').isEnabled(), true);
  assert.equal(await page.locator('#export-holidays').isEnabled(), true);
});

test('calendar overwrite waits for the backup transaction to commit, not just for put success', async t => {
  const page = await pageFor(t, { protocol: true, backupFailure: 'abort' });
  await connect(page); await importCalendar(page); await writeCalendar(page);
  assert.deepEqual(await page.evaluate(() => window.__commands), [9]);
  assert.match(await page.locator('#result-detail').innerText(), /Nothing was written to the watch/);
  assert.equal(await savedBackup(page), undefined);
  assert.equal(await page.locator('#original-backup').isEnabled(), true);
});

test('unplugging KS-959 releases its helper session before allowing another connection', async t => {
  const page = await pageFor(t); await connect(page);
  await page.evaluate(() => {
    window.__helper.delayClose = true;
    const event = new Event('disconnect'); Object.defineProperty(event, 'device', { value: window.__device });
    navigator.usb.dispatchEvent(event);
  });
  await page.waitForFunction(() => window.__helper.calls.includes('close'), null, { timeout: 2000 });
  assert.equal(await page.locator('#connect').isDisabled(), true, 'wait for the old helper session to close');
  await page.evaluate(() => window.__finishClose());
  await page.waitForFunction(() => !document.getElementById('connect').disabled);
  await connect(page);
  assert.deepEqual(await page.evaluate(() => window.__helper.calls), ['open', 'close', 'open']);
});

test('album reopening under a write failure keeps one readable entry and reports temporary storage', async t => {
  const page = await pageFor(t);
  await page.locator('#image-files').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await fs.readFile(repo + '/tests/fixtures/restart-row.jpg') });
  await idle(page); assert.equal(await page.locator('#gallery .thumbnail').count(), 1);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'images') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#gallery .thumbnail').first().waitFor();
  assert.equal(await page.locator('#gallery .thumbnail').count(), 1);
  assert.equal(await page.locator('#storage-label').innerText(), 'this tab only');
  await connect(page);
  assert.equal(await page.locator('#upload-image').isEnabled(), true, 'a storage error is not a JPEG error');
  assert.equal(await page.locator('#preview').evaluate(img => img.naturalWidth), 176);
  await page.locator('#delete-local-image').click(); await page.locator('#dialog-accept').click();
  await page.waitForFunction(() => !document.querySelector('#gallery .thumbnail'));
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await page.locator('#gallery .thumbnail').count(), 0);
});

test('bad local imports and local cancellation preserve an established PC connection', async t => {
  const page = await pageFor(t, { protocol: true }); await connect(page);
  await page.locator('#tab-connection').click(); await page.locator('#find-watch').click(); await idle(page);
  await page.locator('#tab-photos').click();
  await page.locator('#image-files').setInputFiles({ name: 'invalid.wqv', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await idle(page);
  assert.equal(await page.locator('#result-detail').innerText(), 'Invalid WQV archive file.');
  assert.equal(await page.locator('#connection-badge').innerText(), 'USB connected');
  assert.equal(await page.locator('#title-connection').innerText(), 'WQV-3 connected');
  await page.locator('#holiday-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await idle(page);
  assert.equal(await page.locator('#connection-badge').innerText(), 'USB connected');
  await page.evaluate(() => {
    const text = File.prototype.text;
    File.prototype.text = function () {
      return this.name === 'slow.wqv' ? new Promise((_, reject) => { window.__finishImport = () => reject(new DOMException('Stopped read', 'AbortError')); }) : text.call(this);
    };
  });
  await page.locator('#image-files').setInputFiles({ name: 'slow.wqv', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.waitForFunction(() => Boolean(window.__finishImport)); await page.locator('#stop').click();
  await page.evaluate(() => window.__finishImport()); await idle(page);
  assert.equal(await page.locator('#connection-badge').innerText(), 'USB connected');
  assert.doesNotMatch(await page.locator('#result-detail').innerText(), /Reconnect USB/);
  await page.locator('#remote-forward').click(); await idle(page);
  assert.deepEqual(await page.evaluate(() => window.__commands), [2]);
  assert.equal(await page.evaluate(() => window.__connections), 1);
  assert.deepEqual(await page.evaluate(() => window.__helper.calls), ['open']);
});

test('an actual infrared-operation failure still closes the adapter and permits reconnection', async t => {
  const page = await pageFor(t, { protocol: true }); await connect(page);
  await page.evaluate(() => { window.__failCommand = 2; });
  await page.locator('#remote-forward').click(); await idle(page);
  assert.equal(await page.locator('#result-detail').innerText(), 'Simulated infrared failure');
  assert.equal(await page.locator('#connection-badge').innerText(), 'USB not connected');
  assert.deepEqual(await page.evaluate(() => window.__helper.calls), ['open', 'close']);
  await connect(page); assert.equal(await page.locator('#connection-badge').innerText(), 'USB connected');
});

test('a received photo that could not be persisted warns clearly and remains exportable', async t => {
  const page = await pageFor(t, { protocol: true, photoFailure: true });
  await connect(page); await page.evaluate(() => { window.__delayProtocolClose = true; });
  await page.locator('#download-current').click();
  await page.waitForFunction(() => Boolean(window.__finishProtocolClose));
  assert.equal(await page.locator('.operation-bar').getAttribute('data-state'), 'error');
  assert.equal(await page.locator('#result-heading').textContent(), 'Photos not saved');
  assert.match(await page.locator('#result-detail').textContent(), /Export.*before closing or reloading/);
  assert.equal(await page.locator('#gallery .thumbnail').count(), 1);
  const saved = await page.evaluate(async () => {
    const store = await new (await import('./images.mjs')).LocalStore().open();
    try { return (await store.images()).length; } finally { store.db.close(); }
  });
  assert.equal(saved, 0);
  const exportPhoto = page.waitForEvent('download'); await page.locator('#save-image').click();
  assert.ok((await fs.readFile(await (await exportPhoto).path())).length > 100);
  await page.evaluate(() => { window.__photoFailure = false; window.__delayProtocolClose = false; window.__finishProtocolClose(); });
  await idle(page);
  await page.locator('#download-current').click(); await idle(page);
  assert.equal(await page.locator('.operation-bar').getAttribute('data-state'), 'success');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#gallery .thumbnail').count(), 1, 'only the successfully saved reception survives');
});

test('WQV-1/2 BIN imports report storage failure while retaining the original for export', async t => {
  const page = await pageFor(t, { photoFailure: true });
  await page.goto(new URL('wqv2.html', url).href, { waitUntil: 'networkidle' });
  const bytes = Buffer.alloc(7229); bytes.fill(32, 0, 24); bytes.set([26, 11, 5, 12, 30], 24);
  await page.locator('#image-files').setInputFiles({ name: 'sample.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await idle(page);
  assert.equal(await page.locator('#result-heading').textContent(), 'Photos not saved');
  assert.match(await page.locator('#result-detail').textContent(), /Export.*before closing or reloading/);
  await page.locator('#export-format').selectOption('bin');
  const exported = page.waitForEvent('download'); await page.locator('#save-image').click();
  assert.deepEqual(await fs.readFile(await (await exported).path()), bytes);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#gallery .thumbnail').count(), 0);
});

test('WQV-1/2 reception reports a failed write and can save the same record on a later retry', async t => {
  const page = await pageFor(t, { photoFailure: true });
  await page.route('**/wqv2-adapter.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export function createWQV2Adapter() { return { opened:false,decoder:{badCRC:0},
      description:{driver:'fixture'},async open(){this.opened=true},async close(){this.opened=false},
      async prepareWQV2(){return {baud:115200}} }; }
  ` }));
  await page.route('**/wqv12-core.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export class WQV12Client { constructor(adapter,options){this.options=options;this.stats={};this.decoder={badChecksum:0};}
      async run(){const bytes=new Uint8Array(7229);bytes.fill(32,0,24);bytes.set([26,11,5,12,30],24);
        await this.options.onImage({bytes});return {complete:true,imageCount:1};} }
  ` }));
  await page.goto(new URL('wqv2.html', url).href, { waitUntil: 'networkidle' });
  await connect(page);
  const read = async () => { await page.locator('#download-current').click(); await page.locator('#transfer-start').click(); await idle(page); };
  await read(); assert.equal(await page.locator('#result-heading').textContent(), 'Photos not saved');
  assert.equal(await page.locator('#gallery .thumbnail').count(), 1);
  await page.evaluate(() => { window.__photoFailure = false; });
  await read(); assert.equal(await page.locator('.operation-bar').getAttribute('data-state'), 'success');
  assert.equal(await page.locator('#gallery .thumbnail').count(), 1, 'the same BIN is not duplicated');
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await page.locator('#gallery .thumbnail').count(), 1);
});

test('calendar changes need explicit discard before leaving WQV-3 or WQV-10', async t => {
  for (const model of [3, 10]) {
    const page = await pageFor(t);
    if (model === 10) await page.goto(new URL('wqv3.html?model=wqv10', url).href, { waitUntil: 'networkidle' });
    await page.locator('#tab-holidays').click();
    await page.locator('#holiday-file').setInputFiles({ name: 'calendar.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: model === 3 ? 'casio-wqv-holidays-v1' : 'casio-wqv10-calendar-v1', data: (model === 3 ? 'ff' : '00').repeat(model === 3 ? 1840 : 7305),
    })) });
    await idle(page);
    await page.locator('#calendar-year').selectOption('2026'); await page.locator('#calendar-month').selectOption('11');
    await page.locator('#calendar-grid [data-day="5"]').click();
    assert.equal(await page.locator('#holiday-state').textContent(), 'Unsaved changes');
    await page.locator('.screen > .titlebar .window-close').click();
    assert.equal(await page.locator('#dialog-title').textContent(), 'Unsaved calendar changes');
    await page.locator('#dialog-cancel').click();
    assert.equal(await page.locator('#calendar-grid [data-day="5"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    let nativeDialogs = 0; page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });
    await page.locator('.screen > .titlebar .window-close').click(); await page.locator('#dialog-accept').click();
    await page.waitForURL(new URL('./', url).href);
    assert.equal(nativeDialogs, 0, 'confirmed exit must not ask a second time');
    await page.locator(`.program-icon[href="./wqv3.html${model === 10 ? '?model=wqv10' : ''}"]`).click();
    await page.waitForLoadState('networkidle'); await page.locator('#tab-holidays').click();
    await page.locator('#calendar-year').selectOption('2026'); await page.locator('#calendar-month').selectOption('11');
    assert.equal(await page.locator('#calendar-grid [data-day="5"]').getAttribute('aria-pressed'), 'false');
  }
});
