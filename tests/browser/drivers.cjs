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
    async releaseInterface() { this.calls.push('release'); if (window.__releaseCancelsReads !== false) for (const resolve of bulkPending.splice(0)) resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) }); },
    async selectAlternateInterface() {}, async selectConfiguration() { this.configuration = this.configurations[0]; },
    async clearHalt() {}, async reset() { this.calls.push('reset'); },
    async close() { this.opened = false; await this.releaseInterface(); for (const resolve of bulkPending.splice(0)) resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) }); this.calls.push('close'); },
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

test('a driver check belongs to its exact source and headers, never a replacement driver', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.addInitScript(installUSBModel);
  page.setDefaultTimeout(5000);
  await page.route('**/driver-compiler.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function compileDriver(record) { return { abi: 1, sourceSHA256: record.sha256, inputSHA256: record.inputSHA256,
      bytes: new Uint8Array([1]), usbMatches: [{vendorId:0x066f,productId:0x4200}],compileMs:1 }; }
    export async function referenceDriver() { throw Error('Not used'); }
  ` }));
  await page.route('**/driver-usb.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function checkInstalledDriver(record) {
      (window.__checkedDrivers ??= []).push({ id:record.id,inputSHA256:record.inputSHA256 });
      return { driver:{id:record.id,sha256:record.sha256,inputSHA256:record.inputSHA256},
        direct:{status:'passed'},helper:{status:'untested'} };
    }
  ` }));
  await page.goto(new URL('drivers.html', base).href);
  const add = async name => {
    await page.locator('#driver-files').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('struct stir_cb { int fixture; };') });
    await page.waitForFunction(name => [...document.querySelectorAll('#driver-rows tr')].some(row => row.textContent.includes(name) && row.querySelector('[data-build="built"]')), name);
    await page.waitForFunction(() => !document.querySelector('[data-driver-action="import"]').disabled);
  };
  const check = async () => { await page.locator('#check-run').click(); await page.waitForFunction(() => document.getElementById('check-direct-result').dataset.state === 'passed'); };
  const untested = async () => {
    assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'untested');
    assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'), 'untested');
    assert.equal(await page.locator('#save-report').isDisabled(), true);
    assert.equal(await page.locator('#diagnostic-date').textContent(), '');
  };
  await add('first.c'); await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  await check();
  await page.locator('#tab-drivers').click(); await add('second.c'); await page.locator('#tab-check').click();
  assert.match(await page.locator('#check-driver').textContent(), /second\.c/); await untested();
  assert.equal(await page.evaluate(() => window.__checkedDrivers.length), 1);
  await check();
  await page.locator('#tab-drivers').click();
  await page.locator('#driver-files').setInputFiles({ name: 'extra.h', mimeType: 'text/plain', buffer: Buffer.from('#define REVISION 2') });
  await page.waitForFunction(() => !document.querySelector('[data-driver-action="import"]').disabled);
  await page.locator('#tab-check').click(); await untested();
  await check();
  const checked = await page.evaluate(() => window.__checkedDrivers);
  assert.equal(checked[1].id, checked[2].id); assert.notEqual(checked[1].inputSHA256, checked[2].inputSHA256);
  await page.locator('#tab-drivers').click(); await page.locator('[data-driver-action="remove"]:visible').click();
  await page.locator('#dialog-accept').click();
  await page.waitForFunction(() => document.querySelectorAll('#driver-rows tr').length === 1);
  await page.locator('#tab-check').click(); assert.match(await page.locator('#check-driver').textContent(), /first\.c/); await untested();
});

test('each driver check clears the other access method instead of carrying an old success into UI or JSON', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true }); await page.addInitScript(installUSBModel);
  await page.route('**/driver-compiler.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function compileDriver(record) { return { abi:1,sourceSHA256:record.sha256,inputSHA256:record.inputSHA256,
      bytes:new Uint8Array([1]),usbMatches:[{vendorId:0x066f,productId:0x4200}],compileMs:1 }; }
    export async function referenceDriver() { throw Error('Not used'); }
  ` }));
  await page.route('**/driver-usb.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function checkInstalledDriver(record, match, device, { method }) {
      if(window.__bothFail) return {driver:{id:record.id,sha256:record.sha256,inputSHA256:record.inputSHA256},complete:true,
        direct:{status:'blocked'},helper:{status:'failed'}};
      return { driver:{id:record.id,sha256:record.sha256,inputSHA256:record.inputSHA256},complete:true,
        direct:{status:method==='helper'?'untested':window.__fail?'failed':'passed'},
        helper:{status:method==='helper'?window.__fail?'failed':'passed':'untested'} };
    }
  ` }));
  await page.goto(new URL('drivers.html', base).href);
  await page.locator('#driver-files').setInputFiles({ name: 'fixture.c', mimeType: 'text/plain', buffer: Buffer.from('struct stir_cb { int fixture; };') });
  await page.locator('[data-build="built"]').waitFor();
  await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  const run = async method => {
    await page.locator('#check-method').selectOption(method); await page.locator('#check-run').click();
    await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  };
  const report = async () => {
    const download = page.waitForEvent('download'); await page.locator('#save-report').click();
    return JSON.parse(await fs.readFile(await (await download).path(), 'utf8'));
  };
  await run('helper'); assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'), 'passed');
  await page.evaluate(() => { window.__fail = true; }); await run('auto');
  assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'), 'untested');
  assert.equal(await page.locator('#check-heading').textContent(), 'USB check failed');
  assert.equal(await page.locator('#driver-status').textContent(), 'USB check failed');
  assert.equal((await report()).helper.status, 'untested');
  await page.evaluate(() => { window.__fail = false; }); await run('direct');
  await page.evaluate(() => { window.__fail = true; }); await run('helper');
  const last = await report(); assert.equal(last.direct.status, 'untested'); assert.equal(last.helper.status, 'failed');
  assert.equal(await page.locator('#check-heading').textContent(), 'USB check failed');
  await page.evaluate(() => { window.__bothFail = true; }); await run('auto');
  assert.equal(await page.locator('#check-heading').textContent(), 'USB check failed');
});

test('Stop preserves a native cleanup failure in both the screen and the downloadable report', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.addInitScript(installUSBModel);
  await page.goto(new URL('drivers.html', base).href);
  await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs'), { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const record = await driverStore.saveSource(await referenceDriver('ark3116'));
    await driverStore.saveBuild(record.id, record.sha256, await compileDriver(record));
  });
  await page.reload(); await page.locator('[data-build="built"]').waitFor();
  await page.evaluate(() => {
    Object.assign(window.__sig, { vendorId:0x18ec,productId:0x3118,
      controlTransferIn() { window.__blocked = true; return new Promise(() => {}); },
      async close() { throw Error('Native close refused after Stop'); },
    });
  });
  await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  await page.locator('#check-run').click(); await page.waitForFunction(() => window.__blocked);
  await page.locator('#check-stop').click(); await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'failed');
  assert.equal(await page.locator('#driver-status').textContent(), 'USB check failed');
  assert.match(await page.locator('#check-note').textContent(), /Native close refused after Stop/);
  const download = page.waitForEvent('download'); await page.locator('#save-report').click();
  const report = JSON.parse(await fs.readFile(await (await download).path(), 'utf8'));
  assert.equal(report.cancelled, true); assert.equal(report.complete, false);
  assert.match(report.direct.cleanupError, /Native close refused after Stop/);
  assert.equal(report.log.some(event => event.kind === 'usb-released'), false);
  assert.ok(report.log.some(event => event.kind === 'check-cleanup-failed'));
  assert.deepEqual(errors, []);
});

test('real C ARK rejects a short write and C SigmaTel cancels live WinUSB reads while switching to TX', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.addInitScript(installUSBModel);
  await page.goto(new URL('drivers.html', base).href);
  const result = await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs'), { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const { DriverWorkerClient } = await import('./driver-worker-client.mjs');
    const record = await driverStore.saveSource(await referenceDriver('ark3116')), artifact = await compileDriver(record);
    const reads = [], writes = []; let opened = false, shortError;
    const backend = { async open() { opened=true; return {fields:[0x18ec,0x3118,0,0,0x82,2,0x81,64,64,255,0,0,2,1],description:{}}; },
      async control(request,bytes) {
        if(request.type&128) { if(request.transfer)return new Promise(resolve=>reads.push(resolve)); return {bytes:new Uint8Array(request.length)}; }
        if(request.transfer) { writes.push(bytes.length); return {written:bytes.length-1}; }
        return {written:bytes.length};
      }, async cancel() { for(const resolve of reads.splice(0))resolve({bytes:new Uint8Array()}); },
      async close() { opened=false; await this.cancel(); }, async rpc() {},
    };
    const client = new DriverWorkerClient(backend);
    try { await client.load(artifact.bytes,'ark3116'); await client.open(); try { await client.send(Uint8Array.of(1,2,3,4)); } catch(error) { shortError=error.message; } }
    finally { await client.close(); }
    const sig = await driverStore.saveSource(await referenceDriver('sigmatel'));
    await driverStore.saveBuild(sig.id,sig.sha256,await compileDriver(sig));
    window.__releaseCancelsReads=false;
    const events=[], { findInstalledAdapter } = await import('./installed-adapter.mjs');
    const adapter=await findInstalledAdapter(window.__sig,{record:(kind,event)=>events.push({kind,...event})});
    try { await adapter.open(); await adapter.setSIRSpeed(115200); await adapter.writeSIR(Uint8Array.of(1,2,3,4)); await adapter.writeSIR(Uint8Array.of(5,6)); }
    finally { await adapter.close(); }
    return {shortError,writes,arkClosed:!opened,sigmaClosed:!window.__sig.opened,
      liveCancellations:events.filter(event=>event.kind==='usb-cancel-started').length,
      sigmaOutput:window.__sig.writes.map(bytes=>bytes.slice(4)),faults:events.filter(event=>['usb-error','runtime-error'].includes(event.kind))};
  });
  assert.match(result.shortError, /Short USB write: 3 of 4/); assert.deepEqual(result.writes, [4]); assert.equal(result.arkClosed,true);
  assert.equal(result.sigmaClosed,true); assert.ok(result.liveCancellations>=2);
  assert.deepEqual(result.sigmaOutput, [[1,2,3,4],[5,6]]); assert.deepEqual(result.faults, []);
});

test('SWAN uses the installed KS-959 C worker for both directions and restores PC counter discovery', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(new URL('drivers.html', base).href);
  const result = await page.evaluate(async () => {
    const { compileDriver, referenceDriver } = await import('./driver-compiler.mjs');
    const { driverStore } = await import('./driver-store.mjs');
    const { InstalledDriverAdapter } = await import('./installed-adapter.mjs');
    const { DriverWorkerClient } = await import('./driver-worker-client.mjs');
    const { prepareSwan, transferSwan } = await import('./swan-watch-client.mjs');
    const { WQV12Decoder, encodeWQV12 } = await import('./wqv12-formats.mjs');
    const { encodeFrame } = await import('./irda.mjs');
    const { concat, b, sha256 } = await import('./formats.mjs');
    const { SWAN_PREFIX, SWAN_RECORD_BYTES } = await import('./swan-watch-formats.mjs');
    const record = await driverStore.saveSource(await referenceDriver('ks959')), artifact = await compileDriver(record);
    const device = {
      controlTransferIn() { throw Error('SWAN bypassed the selected C driver'); },
      controlTransferOut() { throw Error('SWAN bypassed the selected C driver'); },
      transferIn() { throw Error('SWAN bypassed the selected C driver'); },
      transferOut() { throw Error('SWAN bypassed the selected C driver'); },
    };
    const adapter = new InstalledDriverAdapter(device, { record });
    const decoder = new WQV12Decoder(), input = [], blocks = [];
    const key = new TextEncoder().encode('wangshuofei19710');
    let opened = false, phase = 137, next = 1, writes = 0;
    const inject = wire => {
      const raw = [];
      for (const byte of wire) {
        phase = (phase + 1) & 255;
        if (!phase) { raw.push(0x95 ^ 0x55); phase = 1; }
        raw.push(byte ^ phase ^ 0x55);
      }
      input.push(Uint8Array.from(raw));
    };
    const reply = (control, data = b(), address = 7) => inject(concat(SWAN_PREFIX, encodeWQV12(address, control, data)));
    const backend = {
      async open() { opened = true; return { fields: [0x07d0,0x4959,0,0,129,0,129,8,0,255,0,0,3,0], description: {} }; },
      async cancel() {}, async close() { opened = false; }, async rpc() {},
      async control(request, bytes) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (!opened) throw Error('USB model closed');
        if (request.type & 128) return adapter.calibration.input({ bytes: input.shift() ?? b() });
        if (request.index === 0) {
          writes++;
          const mask = key[(request.value & 15) ^ 6] ^ 0x55;
          decoder.feed(Uint8Array.from(bytes.slice(0, request.value), byte => byte ^ mask));
          for (const frame of decoder.frames.splice(0)) {
            if (frame.address === 255 && frame.control === 0xb3) reply(0xa3, b(1,2,3,4), 255);
            else if (frame.address === 255 && frame.control === 0x93) reply(0x63);
            else if (frame.control === 0x11) reply(blocks.length ? 0x21 : 1);
            else if (frame.control === 0x10) reply(0x20, b(13));
            else if (frame.data[0] === 0x11) {
              if (((frame.control >>> 1) & 7) !== next) throw Error('Duplicate application block');
              blocks.push(frame.data.slice(1)); next = (next + 1) & 7; reply((next << 5) | 1);
            } else if (frame.control === 0x31) reply((next << 5) | 2, b(13));
            else if (frame.control === 0x51) reply((next << 5) | 1);
            else if (frame.control === 0x53) reply(0x63);
          }
        }
        return { written: bytes.length };
      },
    };
    adapter.client = new DriverWorkerClient(backend, { data: (bytes, packet) => adapter.input(bytes, packet) });
    await adapter.client.load(artifact.bytes, 'ks959');
    // The real C driver starts polling immediately, just as it does after open().
    adapter.setReceiveStream(new (await import('./kingsun.mjs')).KingsunStream());
    await adapter.client.open();
    Object.assign(adapter, { claimed: true, configured: true, baud: 9600, description: { driver: 'KingSun KS-959 · C' } });
    const photo = new Uint8Array(SWAN_RECORD_BYTES); photo.fill(32,0,24); photo.set([26,11,5,12,30],24);
    for (let i = 29; i < photo.length; i++) photo[i] = i * 73 & 255;
    try {
      await prepareSwan(adapter);
      const summary = await transferSwan(adapter, { direction: 'send', bytes: photo, durationMs: 15000 });
      inject(concat(encodeFrame(0xfe, 0xbf, b(1,2,3)), encodeFrame(0xfe, 0x73, b(9))));
      const pcFrame = await adapter.receiveFrame(2000); await adapter.pauseReader();
      return { complete: summary.complete, error: summary.error, bytesSent: concat(...blocks).length,
        same: await sha256(photo) === await sha256(concat(...blocks)), writes,
        counterRestored: adapter.swanReceive === false && adapter.calibration.stream.constructor.name === 'KingsunStream',
        pcFrame: pcFrame && { address: pcFrame.address, control: pcFrame.control, data: [...pcFrame.data] } };
    } finally { await adapter.close(); }
  });
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.same, true); assert.equal(result.bytesSent, 25373); assert.ok(result.writes > 100);
  assert.equal(result.counterRestored, true);
  assert.deepEqual(result.pcFrame, { address: 0xfe, control: 0xbf, data: [1,2,3] });
});

test('drivers install, survive reload, initialize through C and are chosen by watch applications', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true }); await context.addInitScript(installUSBModel);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto(new URL('drivers.html', base).href);
  await page.locator('#driver-library').waitFor();
  await page.waitForFunction(() => document.getElementById('driver-status').textContent === 'No drivers installed');
  assert.equal(await page.locator('#driver-rows tr').count(), 0);
  assert.equal(await page.locator('#driver-selected').isVisible(), false);
  assert.equal(await page.locator('.desktop-footer').count(), 0);

  // Build all ten sources with the actual compiler and read their C ID tables.
  const matrix = await page.evaluate(async () => {
    const { DRIVER_PROFILES } = await import('./driver-catalog.mjs');
    const { compileDriver, referenceDriver } = await import('./driver-compiler.mjs');
    const { driverStore } = await import('./driver-store.mjs');
    const results = [];
    const manifest = await (await fetch('./driver-runtime/corpus/sources.json')).json();
    for (const profile of DRIVER_PROFILES) {
      const source = await referenceDriver(profile.id), record = await driverStore.saveSource(source);
      const artifact = await compileDriver(record);
      await driverStore.saveBuild(record.id, record.sha256, artifact);
      results.push({ profile: profile.id, bytes: artifact.bytes.byteLength, ids: artifact.usbMatches,
        expectedIDs: manifest.files[profile.id].usbMatches, sourcePreserved: record.sha256 === source.provenance.sha256 });
    }
    return results;
  });
  assert.equal(matrix.length, 10); assert.ok(matrix.every(result => result.bytes > 0 && result.ids.length && result.sourcePreserved));
  for (const row of matrix) assert.deepEqual(row.ids, row.expectedIDs, row.profile + ': catalogue labels come from the compiled C table');
  const classMatch = matrix.find(row => row.profile === 'irda-usb').ids.at(-1);
  assert.equal(classMatch.interfaceProtocol, null);
  assert.equal(matrix.find(row => row.profile === 'ir-usb').ids.at(-1).interfaceProtocol, 0);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#driver-rows tr').length === 10);
  assert.equal(await page.locator('.driver-state[data-build="built"]').count(), 10);
  const sourceCount = await page.evaluate(async () => (await (await import('./driver-store.mjs')).driverStore.list()).length);
  assert.equal(sourceCount, 10);
  await page.locator('.driver-select').first().click();
  assert.equal(await page.locator('#driver-rows tr.selected .icon').count(), 1);
  await page.waitForFunction(() => document.querySelector('#driver-rows tr.selected .icon').getBBox().width > 0);
  assert.equal(await page.locator('#driver-rows tr.selected').evaluate(row => getComputedStyle(row).backgroundColor), 'rgb(11, 49, 108)');
  assert.equal(await page.locator('#driver-rows tr.selected td').first().evaluate(cell => getComputedStyle(cell).color), 'rgb(255, 255, 255)');

  // Real Worker, real Linux C initialization; the USB transport is a fixture.
  await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  await page.locator('#check-method').selectOption('direct'); await page.locator('#check-run').click();
  await page.waitForFunction(() => document.getElementById('check-direct-result').dataset.state === 'passed');
  assert.match(await page.locator('#check-direct-result').innerText(), /initialization passed/);
  assert.equal(await page.evaluate(() => window.__sig.opened), false);
  assert.equal(await page.evaluate(() => window.__sig.writes.length), 0, 'USB check must send no optical frame');
  const diag = await page.evaluate(() => window.__sig.calls);
  assert.ok(diag.includes('reset')); assert.ok(diag.some(call => Array.isArray(call) && call[0] === 'out'));
  assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'), 'untested');
  assert.match(await page.locator('#driver-log').textContent(), /Driver loaded\./);
  assert.match(await page.locator('#driver-log').textContent(), /USB released\./);
  assert.doesNotMatch(await page.locator('#driver-log').textContent(), /host_submit|"imports"|dataHex/);
  const reportDownload = page.waitForEvent('download'); await page.locator('#save-report').click();
  const exportedReport = JSON.parse(await fs.readFile(await (await reportDownload).path(), 'utf8'));
  assert.ok(exportedReport.log.some(event => event.kind === 'module-loaded' && Array.isArray(event.imports)));
  assert.ok(exportedReport.log.some(event => event.request && typeof event.dataHex === 'string'));
  assert.equal(exportedReport.device.descriptors.configurations[0].configurationValue, 1);
  assert.ok(exportedReport.log.some(event => event.kind === 'usb-descriptors' && event.opened));
  assert.match(exportedReport.environment.userAgent, /Chrome/);

  // KS-959's nonexistent interface is detected before the control reaches USB.
  await page.evaluate(() => { window.__selectedUSB = window.__king; });
  await page.locator('[data-driver-action="choose"]').click(); await page.locator('#check-method').selectOption('auto'); await page.locator('#check-run').click();
  await page.waitForFunction(() => document.getElementById('check-helper-result').dataset.state === 'passed');
  assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'blocked');
  assert.equal(await page.evaluate(() => window.__helper.opened), false);
  assert.ok((await page.evaluate(() => window.__helper.writes)).some(item => item.request.index === 1 && item.hex === '8025000003000000'));
  await page.locator('#check-method').selectOption('helper'); await page.locator('#check-run').click();
  await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'), 'passed');
  assert.equal(await page.evaluate(() => window.__helper.opened), false);

  // Source is saved even if it cannot compile; no fabricated ready state.
  await page.locator('#tab-drivers').click();
  await page.locator('#driver-files').setInputFiles({ name: 'broken.c', mimeType: 'text/plain', buffer: Buffer.from('struct stir_cb;\nthis is not C;') });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#driver-rows tr')).some(row => row.textContent.includes('broken.c') && row.querySelector('[data-build="error"]')));
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#driver-rows tr').length === 11);
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

test('ARK configuration zero closes idle WinUSB reads and exports evidence on a genuinely missing interface', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true }); await page.addInitScript(installUSBModel);
  await page.goto(new URL('drivers.html', base).href);
  await page.evaluate(async () => {
    const { driverStore } = await import('./driver-store.mjs');
    const { referenceDriver, compileDriver } = await import('./driver-compiler.mjs');
    const record = await driverStore.saveSource(await referenceDriver('ark3116'));
    await driverStore.saveBuild(record.id, record.sha256, await compileDriver(record));
  });
  await page.reload(); await page.locator('[data-build="built"]').waitFor();
  await page.evaluate(() => {
    // WinUSB keeps pending bulk/interrupt reads alive after releaseInterface.
    // Only close aborts them. No watch traffic is needed to exercise shutdown.
    window.__releaseCancelsReads = false;
    window.__ark = { ...window.__sig, vendorId: 0x18ec, productId: 0x3118, productName: 'USB TO IRDA ',
      calls: [], writes: [], registers: {},
      configurations: [{ configurationValue: 0, interfaces: [{ interfaceNumber: 0, alternates: [{
        alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 0, interfaceProtocol: 0,
        endpoints: [{ endpointNumber: 1, direction: 'in', type: 'interrupt', packetSize: 4 },
          { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
          { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 }],
      }] }] }],
    };
    window.__selectedUSB = window.__ark;
  });
  await page.locator('#tab-check').click(); await page.locator('[data-driver-action="choose"]').click();
  await page.locator('#check-run').click();
  await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'passed');
  const downloadReport = async () => {
    const download = page.waitForEvent('download'); await page.locator('#save-report').click();
    return JSON.parse(await fs.readFile(await (await download).path(), 'utf8'));
  };
  const passed = await downloadReport();
  assert.equal(passed.direct.description.configuration, 0);
  assert.ok(passed.direct.completedTransfers > 0);
  const descriptors = passed.log.find(event => event.kind === 'usb-descriptors');
  assert.equal(descriptors.activeConfiguration.configurationValue, 0);
  assert.equal(descriptors.configurations[0].interfaces[0].alternates[0].endpoints.length, 3);
  assert.equal(await page.evaluate(() => window.__ark.opened), false);
  assert.equal(await page.evaluate(() => window.__ark.writes.length), 0);
  assert.ok(passed.log.some(event => event.kind === 'driver-closed'));
  assert.equal(passed.direct.cleanupError, undefined);
  assert.ok(passed.log.some(event => event.kind === 'usb-cancel-started' && event.strategy === 'close-reopen'));
  assert.ok(passed.log.some(event => event.kind === 'usb-cancel-complete' && event.reconnected));
  assert.equal(passed.log.some(event => event.kind === 'usb-error' || event.kind === 'runtime-error'), false);
  // A second check must be able to reclaim the same device without unplugging.
  await page.locator('#check-run').click(); await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'), 'passed');
  assert.equal(await page.evaluate(() => window.__ark.opened), false);
  // A real native-close failure must still overturn an initialization pass.
  await page.evaluate(() => {
    window.__ark.nativeClose = window.__ark.close;
    window.__ark.close = async () => { throw Error('Native WinUSB close failed'); };
  });
  await page.locator('#check-run').click(); await page.waitForFunction(() => !document.getElementById('check-run').disabled);
  const closeFailure = await downloadReport();
  assert.equal(closeFailure.direct.status, 'failed');
  assert.match(closeFailure.direct.cleanupError, /Native WinUSB close failed/);
  await page.evaluate(async () => { window.__ark.close = window.__ark.nativeClose; await window.__ark.close(); });
  await page.evaluate(() => { window.__ark.configurations[0].interfaces = []; });
  await page.locator('[data-driver-action="choose"]').click(); await page.locator('#check-run').click();
  await page.waitForFunction(() => document.getElementById('check-direct-result').dataset.state === 'failed');
  const failed = await downloadReport();
  assert.equal(failed.direct.code, 'no-interfaces');
  assert.equal(failed.helper.status, 'untested');
  assert.deepEqual(failed.log.find(event => event.kind === 'usb-descriptors').configurations[0].interfaces, []);
  assert.equal(await page.evaluate(() => window.__ark.opened), false);
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
    for (const profile of DRIVER_PROFILES.filter(profile => !['pl2303','ma620'].includes(profile.id))) {
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
