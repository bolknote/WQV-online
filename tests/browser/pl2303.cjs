// Real Linux PL2303 + MA600 C, real compiler/runtime Workers; modeled USB.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';

test('PL2303 and MA-620 execute their original initialization, speed control, data and error cleanup', { timeout: 90000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(new URL('drivers.html', base).href);
  const hardware = JSON.parse(await fs.readFile(path.join(__dirname, '../fixtures/ma620-usb-hardware.json'), 'utf8'));
  const result = await page.evaluate(async () => {
    const { compileDriver, referenceDriver } = await import('./driver-compiler.mjs');
    const { driverStore } = await import('./driver-store.mjs');
    const { DriverWorkerClient } = await import('./driver-worker-client.mjs');
    const { chooseInstalledDriver } = await import('./driver-catalog.mjs');
    const records = {};
    for (const id of ['pl2303', 'ma620']) {
      const source = await driverStore.saveSource(await referenceDriver(id)), artifact = await compileDriver(source);
      await driverStore.saveBuild(source.id, source.sha256, artifact); records[id] = { ...source, artifact };
    }
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    function model(profile, options = {}) {
      const isMA = profile === 'ma620', vendorId = isMA ? 0x0df7 : 0x067b, productId = isMA ? 0x0620 : 0x2303;
      const state = { opened: false, calls: [], output: [], input: [], received: [], lines: 0, line: Uint8Array.of(128,37,0,0,0,0,8), commandBytes: [] };
      const backend = {
        async open() { state.opened = true; return { fields: [vendorId, productId, 0, 0, options.noBulk ? 0 : 131, 2, options.noIRQ ? 0 : 129, 64, 64, 255, 0, 0, 2, 0], description: { transport: 'model' } }; },
        async close() { state.opened = false; }, async cancel() {}, async rpc(method) { state.calls.push({ method }); },
        async control(request, bytes) {
          await delay(request.transfer ? 3 : 0);
          if (!state.opened) throw Error('USB model is closed');
          const input = Boolean(request.type & 128);
          if (request.transfer || request.bulk) {
            if (input) return { bytes: request.index === 3 ? state.input.shift() ?? new Uint8Array() : new Uint8Array() };
            const data = [...bytes]; state.output.push({ lines: state.lines, data });
            if (isMA && state.lines === 1) {
              if (new DataView(state.line.buffer).getUint32(0, true) !== 9600) throw Error('MA600 command sent at the wrong UART rate');
              state.commandBytes.push(...data);
              if (options.shortCommand) return { written: 0 };
              if (!options.missingEcho) state.input.push(Uint8Array.of(options.badEcho ? 255 : bytes[0]));
            }
            return { written: bytes.length };
          }
          state.calls.push({ type: request.type, request: request.request, value: request.value, index: request.index, data: bytes && [...bytes] });
          if (request.type === 0x80 && request.request === 6) {
            const data = Uint8Array.of(18,1,16,1,options.legacy ? 2 : 0,0,0,options.legacy ? 8 : 64,
              vendorId & 255,vendorId >> 8,productId & 255,productId >> 8,0,3,1,2,0,1);
            return { bytes: options.shortDescriptor ? data.slice(0, 8) : data };
          }
          if (request.type === 0xa1 && request.request === 0x21) return { bytes: options.shortLine ? state.line.slice(0, 3) : state.line.slice() };
          if (options.shortVendor && request.type === 0xc0) return { bytes: new Uint8Array() };
          if (input) return { bytes: new Uint8Array(request.length) };
          if (request.type === 0x21 && request.request === 0x20) state.line = bytes.slice();
          if (request.type === 0x21 && request.request === 0x22) {
            if (options.badLines && request.value === 1) throw Error('Control-line write failed');
            state.lines = request.value;
          }
          return { written: bytes.length };
        },
      };
      const client = new DriverWorkerClient(backend, { data: bytes => state.received.push(...bytes) });
      return { state, client };
    }
    const outcomes = [];
    for (const options of [{}, { legacy: true }]) {
      const { state, client } = model('pl2303', options);
      try {
        await client.load(records.pl2303.artifact.bytes, 'pl2303'); await client.open(); await client.speed(115200);
        await client.send(Uint8Array.of(192,255,179,193)); state.input.push(Uint8Array.of(192,2,1,193));
        for (let i = 0; i < 100 && state.received.length < 4; i++) await delay(5);
        await client.close();
        outcomes.push({ profile: 'pl2303', legacy: Boolean(options.legacy), calls: state.calls, output: state.output,
          received: state.received, lines: state.lines, closed: !state.opened });
      } finally { await client.close(); }
    }
    {
      const { state, client } = model('ma620');
      try {
        await client.load(records.ma620.artifact.bytes, 'ma620'); await client.open();
        for (const speed of [115200,57600,38400,19200,9600,9600]) await client.speed(speed);
        await client.send(Uint8Array.of(192,255,179,193)); state.input.push(Uint8Array.of(192,2,1,193));
        for (let i = 0; i < 100 && state.received.length < 4; i++) await delay(5);
        await client.close();
        outcomes.push({ profile: 'ma620', calls: state.calls, commandBytes: state.commandBytes,
          output: state.output, received: state.received, lines: state.lines, closed: !state.opened });
      } finally { await client.close(); }
    }
    const failures = [];
    for (const option of ['badEcho','missingEcho','shortCommand','badLines','noIRQ','noBulk','shortDescriptor','shortLine','shortVendor']) {
      const { state, client } = model('ma620', { [option]: true }); let error;
      try { await client.load(records.ma620.artifact.bytes, 'ma620'); await client.open(); }
      catch (reason) { error = reason.message; }
      finally { await client.close(); }
      failures.push({ option, error, closed: !state.opened, lines: state.lines, output: state.output, calls: state.calls });
    }
    // The complete infrared driver wins even if the USB-only driver is newer.
    const candidates = [records.ma620, { ...records.pl2303, updatedAt: Date.now() + 10000 }];
    const preferred = chooseInstalledDriver(candidates, { vendorId:0x0df7, productId:0x0620, configurations:[] }).record.profile;
    return { outcomes, failures, preferred, ids: { pl2303: records.pl2303.artifact.usbMatches, ma620: records.ma620.artifact.usbMatches },
      dependencies: Object.keys(records.ma620.files) };
  });
  assert.equal(result.ids.pl2303.length, 57);
  assert.deepEqual(result.ids.ma620.map(id => [id.vendorId,id.productId]), [[0x0df7,0x0620]]);
  assert.deepEqual(result.dependencies.sort(), ['pl2303.c', 'pl2303.h']); assert.equal(result.preferred, 'ma620');
  for (const run of result.outcomes) {
    assert.deepEqual(run.received, [192,2,1,193], 'command echoes never reach the watch protocol');
    assert.equal(run.closed, true); assert.equal(run.lines, 0);
    const vendor = run.calls.filter(call => call.type === 0x40);
    assert.ok(vendor.some(call => call.value === 2 && call.index === (run.legacy ? 0x24 : 0x44)));
    const rates = run.calls.filter(call => call.type === 0x21 && call.request === 0x20)
      .map(call => call.data.slice(0, 4).reduce((rate, byte, i) => rate + byte * 2 ** (8 * i), 0));
    assert.ok(rates.includes(9600)); assert.ok(rates.includes(115200));
    if (run.profile === 'ma620') {
      assert.deepEqual(run.commandBytes, hardware.commandHex.map(hex => parseInt(hex, 16)));
      assert.deepEqual(run.calls.filter(call => call.type === 0x21 && call.request === 0x22).map(call => call.value), hardware.controlLines);
      assert.deepEqual(run.calls.filter(call => call.type === 0x21 && call.request === 0x20).map(call => call.data.map(n => n.toString(16).padStart(2,'0')).join('')), hardware.lineSettingsHex);
      assert.equal(run.output.filter(write => write.lines === 3).length, 1);
    } else assert.deepEqual(run.output, [{ lines: 3, data: [192,255,179,193] }]);
  }
  for (const failure of result.failures) {
    assert.ok(failure.error, failure.option + ' must fail'); assert.equal(failure.closed, true, failure.option);
    assert.equal(failure.lines, 0, failure.option + ' powers off');
    if (['badLines','noIRQ','noBulk','shortDescriptor','shortLine','shortVendor'].includes(failure.option)) assert.equal(failure.output.length, 0, failure.option);
  }
});

test('reference sources show USB IDs and the helper uses a real Window.fetch', { timeout: 15000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:8768/usb', route => route.fulfill({ contentType:'application/json',
    headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({result:{helper:'reachable'}}) }));
  await page.goto(new URL('drivers.html', base).href);
  const response = await page.evaluate(async () => {
    const { HelperDriverBackend } = await import('./driver-usb.mjs'); return new HelperDriverBackend({}).call('fixture');
  });
  assert.deepEqual(response, { helper: 'reachable' });
  await page.locator('[data-driver-action="reference"]:visible').click();
  await page.waitForFunction(() => document.querySelector('#reference-source option[value="ma620"]').textContent.includes('0df7:0620'));
  assert.match(await page.locator('#reference-source option[value="pl2303"]').textContent(), /067b:2303/);
  assert.match(await page.locator('#reference-source option[value="sigmatel"]').textContent(), /066f:4200/);
  await page.locator('#reference-source').selectOption('pl2303');
  const full = await page.locator('#reference-usb-ids').textContent();
  assert.equal(await page.locator('#reference-usb-ids').isVisible(), true);
  assert.ok(full.includes('0df7:0620')); assert.ok(full.split(', ').length >= 57);
  await page.locator('#reference-source').selectOption('ma620');
  assert.equal(await page.locator('#reference-usb-ids').textContent(), '0df7:0620');
  assert.equal(await page.locator('#reference-usb-ids').isVisible(), false);
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator('#reference-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'the dialog fits the viewport');
    assert.ok(await page.locator('#reference-source').evaluate(select => select.clientWidth <= select.parentElement.clientWidth));
  }
  if (process.env.WQV_BROWSER_ARTIFACTS) {
    await fs.mkdir(process.env.WQV_BROWSER_ARTIFACTS, { recursive: true });
    await page.setViewportSize({ width:1280,height:900 });
    await page.screenshot({ path:path.join(process.env.WQV_BROWSER_ARTIFACTS, 'reference-ma620.png'), fullPage:true });
  }
});
