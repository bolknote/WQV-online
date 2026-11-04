// Real C compilation, IndexedDB and runtime Workers; USB devices below are models.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';

function installUSBModel() {
  const bulkPending = [];
  const sig = { vendorId: 0x066f, productId: 0x4200, productName: 'IrDA/USB Bridge', opened: false,
    configurations: [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 0, interfaceProtocol: 0,
      endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 }, { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 }] }] }] }],
    calls: [], writes: [], registers: {},
    async open() { this.opened = true; this.configuration = this.configurations[0]; this.calls.push('open'); },
    async claimInterface() { this.calls.push('claim'); },
    async releaseInterface() { this.calls.push('release'); for (const resolve of bulkPending.splice(0)) resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) }); },
    async selectAlternateInterface() {}, async selectConfiguration() { this.configuration = this.configurations[0]; },
    async clearHalt() {}, async reset() { this.calls.push('reset'); },
    async close() { this.opened = false; await this.releaseInterface(); this.calls.push('close'); },
    async controlTransferOut(setup, data = new Uint8Array()) { this.calls.push(['out', setup.index, setup.value]); this.registers[setup.index] = setup.value; return { status: 'ok', bytesWritten: data.byteLength }; },
    async controlTransferIn(setup, length) { this.calls.push(['in', setup.index, length]); const bytes = new Uint8Array(length); if (setup.index === 5) bytes[0] = 4; else for (let i = 0; i < length; i++) bytes[i] = this.registers[setup.index + i] ?? 0; return { status: 'ok', data: new DataView(bytes.buffer) }; },
    transferIn() { return new Promise(resolve => bulkPending.push(resolve)); },
    async transferOut(endpoint, bytes) { this.writes.push(Array.from(bytes)); return { status: 'ok', bytesWritten: bytes.byteLength }; },
  };
  const king = { ...sig, vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA', calls: [],
    configurations: [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 0, interfaceProtocol: 0,
      endpoints: [{ endpointNumber: 1, direction: 'in', type: 'interrupt', packetSize: 8 }] }] }] }],
    async controlTransferIn() { await new Promise(resolve => setTimeout(resolve, 3)); return { status: 'ok', data: new DataView(new ArrayBuffer(0)) }; },
  };
  const usb = new EventTarget(); usb.requestDevice = async () => window.__selectedUSB;
  Object.defineProperty(navigator, 'usb', { configurable: true, value: usb });
  window.__sig = sig; window.__king = king; window.__selectedUSB = sig;
  window.__helper = { opened: false, writes: [], fail: false };
  const originalFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (!String(url).startsWith('http://127.0.0.1:8768/')) return originalFetch(url, options);
    const state = window.__helper, body = JSON.parse(options.body);
    if (state.fail) throw new TypeError('Helper unavailable');
    if (body.method === 'open') {
      if (state.opened) throw Error('Helper already held'); state.opened = true;
      return Response.json({ result: { session: 'fixture', vendorId: 0x07d0, productId: 0x4959, configuration: { configurationValue: 1 }, interfaceNumber: 0,
        alternate: king.configurations[0].interfaces[0].alternates[0] } });
    }
    if (body.session !== 'fixture') throw Error('Invalid test session');
    if (body.method === 'close') { state.opened = false; return Response.json({ result: {} }); }
    if (body.method === 'transfer') {
      const [request, bytes] = body.args;
      if (request.type & 128) { await new Promise(resolve => setTimeout(resolve, 3)); return Response.json({ result: { hex: '' } }); }
      state.writes.push({ request, hex: bytes }); return Response.json({ result: { written: (bytes || '').length / 2 } });
    }
    return Response.json({ result: {} });
  };
}

test('drivers install, survive reload, initialize through C and are chosen by watch applications', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true }); await context.addInitScript(installUSBModel);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto(new URL('drivers.html', base).href);
  await page.locator('#driver-empty').waitFor();
  assert.equal(await page.locator('#driver-rows tr').count(), 0);

  // Build all eight sources with the actual compiler and read their C ID tables.
  const matrix = await page.evaluate(async () => {
    const { DRIVER_PROFILES } = await import('./driver-catalog.mjs');
    const { compileDriver, referenceDriver } = await import('./driver-compiler.mjs');
    const { driverStore } = await import('./driver-store.mjs');
    const results = [];
    for (const profile of DRIVER_PROFILES) {
      const source = await referenceDriver(profile.id), record = await driverStore.saveSource(source);
      const artifact = await compileDriver(record);
      await driverStore.saveBuild(record.id, record.sha256, artifact);
      results.push({ profile: profile.id, bytes: artifact.bytes.byteLength, ids: artifact.usbMatches,
        sourcePreserved: record.sha256 === source.provenance.sha256 });
    }
    return results;
  });
  assert.equal(matrix.length, 8); assert.ok(matrix.every(result => result.bytes > 0 && result.ids.length && result.sourcePreserved));
  const classMatch = matrix.find(row => row.profile === 'irda-usb').ids.at(-1);
  assert.equal(classMatch.interfaceProtocol, null);
  assert.equal(matrix.find(row => row.profile === 'ir-usb').ids.at(-1).interfaceProtocol, 0);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#driver-rows tr').length === 8);
  assert.equal(await page.locator('.driver-state[data-build="built"]').count(), 8);
  const sourceCount = await page.evaluate(async () => (await (await import('./driver-store.mjs')).driverStore.list()).length);
  assert.equal(sourceCount, 8);

  // Real Worker, real Linux C initialization; the USB transport is a fixture.
  await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  await page.locator('[data-driver-action="check-auto"]').click();
  await page.waitForFunction(() => document.getElementById('check-direct-result').dataset.state === 'passed');
  assert.match(await page.locator('#check-direct-result').innerText(), /initialization passed/);
  assert.equal(await page.evaluate(() => window.__sig.opened), false);
  assert.equal(await page.evaluate(() => window.__sig.writes.length), 0, 'USB check must send no optical frame');
  const diag = await page.evaluate(() => window.__sig.calls);
  assert.ok(diag.includes('reset')); assert.ok(diag.some(call => Array.isArray(call) && call[0] === 'out'));

  // KS-959's nonexistent interface is detected before the control reaches USB.
  await page.evaluate(() => { window.__selectedUSB = window.__king; });
  await page.locator('[data-driver-action="choose"]').click(); await page.locator('[data-driver-action="check-auto"]').click();
  await page.waitForFunction(() => document.getElementById('check-helper-result').dataset.state === 'passed');
  assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'blocked');
  assert.equal(await page.evaluate(() => window.__helper.opened), false);
  assert.ok((await page.evaluate(() => window.__helper.writes)).some(item => item.request.index === 1 && item.hex === '8025000003000000'));

  // Source is saved even if it cannot compile; no fabricated ready state.
  await page.locator('#tab-drivers').click();
  await page.locator('#driver-files').setInputFiles({ name: 'broken.c', mimeType: 'text/plain', buffer: Buffer.from('struct stir_cb;\nthis is not C;') });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#driver-rows tr')).some(row => row.textContent.includes('broken.c') && row.querySelector('[data-build="error"]')));
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#driver-rows tr').length === 9);
  const failed = await page.evaluate(async () => (await (await import('./driver-store.mjs')).driverStore.list()).find(record => record.filename === 'broken.c'));
  assert.equal(failed.source, 'struct stir_cb;\nthis is not C;'); assert.equal(failed.artifact, null); assert.ok(failed.buildError);

  // Header revisions prevent a stale result from installing over edited input.
  const race = await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs');
    const original = (await driverStore.list()).find(record => record.profile === 'sigmatel' && record.artifact);
    const edited = await driverStore.saveSource({ ...original, files: { 'extra.h': '#define TEST 1' } });
    const accepted = await driverStore.saveBuild(edited.id, original.sha256, original.artifact);
    const restored = await driverStore.get(edited.id);
    return { accepted, artifact: restored.artifact, sameC: edited.sha256 === original.sha256 };
  });
  assert.equal(race.sameC, true); assert.equal(race.accepted, false); assert.equal(race.artifact, null);

  // Install the valid source again and verify automatic selection in WQV-3.
  await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs'); const { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const record = await driverStore.saveSource(await referenceDriver('sigmatel'));
    await driverStore.saveBuild(record.id, record.sha256, await compileDriver(record));
  });
  await page.goto(new URL('wqv3.html', base).href); await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === 'USB connected');
  const adapterInfo = await page.locator('#result-detail').count() ? await page.locator('#result-detail').textContent() : '';
  await page.locator('#disconnect').click(); await page.waitForFunction(() => !window.__sig.opened);

  // Installed C drivers use the new helper; built-in KS-959 keeps the old one.
  await page.goto(new URL('wqv3.html', base).href); await page.evaluate(() => { window.__selectedUSB = window.__king; });
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === 'USB connected');
  assert.match(await page.locator('#kingsun-help a').getAttribute('href'), /irda_usb_helper\.py$/);
  await page.locator('#disconnect').click(); await page.waitForFunction(() => !window.__helper.opened);

  // A compiled table, rather than the built-in manufacturer list, selects a new ID.
  await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs'); const { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const source = await referenceDriver('sigmatel'); source.source = source.source.replace('USB_DEVICE(0x066f, 0x4200)', 'USB_DEVICE(0x1234, 0x5678)');
    const record = await driverStore.saveSource(source); await driverStore.saveBuild(record.id, record.sha256, await compileDriver(record));
    window.__sig.vendorId = 0x1234; window.__sig.productId = 0x5678; window.__selectedUSB = window.__sig;
  });
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === 'USB connected');
  assert.match(await page.locator('#adapter-label').textContent(), /1234:5678/);
  await page.locator('#disconnect').click(); await page.waitForFunction(() => !window.__sig.opened);
  assert.ok((await page.evaluate(() => window.__sig.calls)).includes('reset'), 'installed C entry point must run');
  await page.goto(new URL('wqv2.html', base).href); await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connection-badge').textContent === 'USB connected');
  assert.ok((await page.evaluate(() => window.__sig.calls)).includes('reset'));
  await page.locator('#disconnect').click(); await page.waitForFunction(() => !window.__sig.opened);

  // The new utility remains available in all six desktop languages.
  await page.goto(new URL('drivers.html', base).href);
  for (const language of ['en', 'ru', 'ja', 'de', 'es', 'fi']) {
    await page.evaluate(async language => (await import('./i18n.mjs')).setLanguage(language), language);
    assert.equal(await page.locator('html').getAttribute('lang'), language);
    await page.locator('#tab-check').click();
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal clipping: ' + language + ' / ' + width);
    }
  }
  const artifacts = process.env.WQV_BROWSER_ARTIFACTS;
  if (artifacts) { await fs.mkdir(artifacts, { recursive: true }); await page.setViewportSize({ width: 1024, height: 1050 }); await page.screenshot({ path: path.join(artifacts, 'drivers.png'), fullPage: true }); }
  assert.deepEqual(errors, []);
});

test('all eight installed C modules execute receive, transmit and cleanup against USB models', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(new URL('drivers.html', base).href);
  const matrix = await page.evaluate(async () => {
    const { DRIVER_PROFILES } = await import('./driver-catalog.mjs');
    const { driverStore } = await import('./driver-store.mjs');
    const { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const { DriverWorkerClient } = await import('./driver-worker-client.mjs');
    const { encodeKingsun } = await import('./kingsun.mjs');
    const payload = Uint8Array.from({ length: 17 }, (_, i) => i * 73 & 255);
    const same = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
    const results = [];
    for (const profile of DRIVER_PROFILES) {
      const source = await driverStore.saveSource(await referenceDriver(profile.id)), artifact = await compileDriver(source);
      const chosenIndex = profile.id === 'ark3116' ? 1 : 0, match = artifact.usbMatches[chosenIndex];
      const input = [], output = [], received = [];
      let opened = false;
      const interrupt = ['kingsun', 'ksdazzle'].includes(profile.id);
      const backend = {
        async open() { opened = true; return { fields: [match.vendorId, match.productId, 0, 0, 129, 2, 131, interrupt ? 8 : 64, interrupt ? 8 : 64, 255, 0, 0, interrupt ? 3 : 2, chosenIndex], description: { name: profile.name, transport: 'fixture' } }; },
        async close() { opened = false; }, async cancel() {}, async rpc() { return {}; },
        async control(request, bytes) {
          await new Promise(resolve => setTimeout(resolve, 1));
          if (!opened) throw Error('USB model is closed');
          if (request.transfer || request.bulk) {
            if (request.type & 128) return { bytes: request.transfer === 'interrupt' && !interrupt ? new Uint8Array() : input.shift() || new Uint8Array() };
            output.push(bytes); return { written: bytes.length };
          }
          if (request.type & 128) {
            if (profile.id === 'ks959') return { bytes: input.shift() || new Uint8Array() };
            if (profile.id === 'ir-usb' || profile.id === 'irda-usb') return { bytes: Uint8Array.from([12,33,0,1,32,1,127,63,0,128,0,1]) };
            const data = new Uint8Array(request.length); if (profile.id === 'sigmatel') data[0] = 4; return { bytes: data };
          }
          if (profile.id === 'ks959' && request.index === 0) output.push(bytes);
          return { written: bytes.length };
        },
      };
      const client = new DriverWorkerClient(backend, { data: (bytes, packet) => received.push({ bytes, packet }) });
      try {
        await client.load(artifact.bytes, profile.id); await client.open(); await client.send(payload);
        let sent;
        if (profile.id === 'sigmatel') sent = same(output.at(-1), Uint8Array.of(85,170,17,0,...payload));
        else if (profile.id === 'ks959') sent = same(output.at(-1), encodeKingsun(payload)[0].data);
        else if (profile.id === 'ksdazzle') sent = same(Uint8Array.from(output.flatMap(bytes => [...bytes.slice(1, 1 + bytes[0] - 248)])), payload);
        else if (profile.id === 'mcs7780') sent = same(output.at(-1), Uint8Array.of(19,0,...payload));
        else if (profile.id === 'irda-usb' || profile.id === 'ir-usb') sent = same(output.at(-1).slice(1), payload);
        else sent = same(output.at(-1), payload);
        if (!sent) throw Error(profile.id + ': C transmit mismatch');
        if (profile.id === 'ks959') input.push(Uint8Array.from(payload, (byte, i) => byte ^ (i + 1) ^ 85));
        else if (profile.id === 'kingsun') for (let i = 0; i < payload.length; i += 7) { const part = payload.slice(i, i + 7), packet = new Uint8Array(8); packet[0] = part.length; packet.set(part, 1); input.push(packet); }
        else if (profile.id === 'ksdazzle') for (let i = 0; i < payload.length; i += 8) input.push(payload.slice(i, i + 8));
        else if (profile.id === 'irda-usb' || profile.id === 'ir-usb') input.push(Uint8Array.of(2, ...payload));
        else input.push(payload);
        const expected = profile.id === 'mcs7780' ? Uint8Array.of(192, ...payload, 193) : payload;
        const deadline = performance.now() + 3000;
        while (received.reduce((length, item) => length + item.bytes.length, 0) < expected.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        const rx = Uint8Array.from(received.flatMap(item => [...item.bytes]));
        if (!same(rx, expected)) throw Error(profile.id + ': C receive mismatch (' + rx.length + ')');
        await client.close(); if (opened) throw Error('USB model not released');
        results.push({ profile: profile.id, sent, received: rx.length, closed: !opened });
      } finally { await client.close(); }
    }
    return results;
  });
  assert.equal(matrix.length, 8); assert.ok(matrix.every(row => row.sent && row.received && row.closed));
});

test('cancelling the compiler leaves the saved source available after reload', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  let releaseCompiler;
  const gate = new Promise(resolve => { releaseCompiler = resolve; });
  await page.route('**/driver-runtime/compiler/usr/bin/cc', async route => { await gate; await route.abort().catch(() => {}); });
  await page.goto(new URL('drivers.html', base).href);
  const source = await page.evaluate(async () => (await (await import('./driver-compiler.mjs')).referenceDriver('sigmatel')).source);
  await page.locator('#driver-files').setInputFiles({ name: 'saved.c', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.locator('#driver-build-dialog').waitFor({ state: 'visible' });
  await page.locator('#driver-build-dialog [data-driver-action="stop"]').click();
  await page.locator('#driver-build-dialog').waitFor({ state: 'hidden' }); releaseCompiler();
  await page.reload(); await page.locator('#driver-rows tr').waitFor();
  const saved = await page.evaluate(async () => (await (await import('./driver-store.mjs')).driverStore.list())[0]);
  assert.equal(saved.source, source); assert.equal(saved.artifact, null); assert.equal(saved.buildError, null);
  assert.equal(await page.locator('.driver-state').textContent(), 'Saved');
});

test('a failed storage transaction does not start compilation or claim the source was saved', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drivers') throw new DOMException('Storage is full', 'QuotaExceededError');
      return original.apply(this, args);
    };
    const OriginalWorker = window.Worker; window.__workerCount = 0;
    window.Worker = class extends OriginalWorker { constructor(...args) { super(...args); window.__workerCount++; } };
  });
  await page.goto(new URL('drivers.html', base).href);
  await page.locator('#driver-files').setInputFiles({ name: 'driver.c', mimeType: 'text/plain', buffer: Buffer.from('struct stir_cb;') });
  await page.waitForFunction(() => document.getElementById('driver-operation').dataset.state === 'error');
  assert.equal(await page.locator('#driver-rows tr').count(), 0);
  assert.equal(await page.evaluate(() => window.__workerCount), 0);
  assert.match(await page.locator('#driver-status-note').textContent(), /Storage is full/);
});
