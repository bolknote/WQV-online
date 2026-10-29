import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { KingsunBridgeDevice } from '../dist/kingsun-bridge.mjs';
import { Kingsun } from '../dist/kingsun.mjs';
import { b, toHex } from '../dist/formats.mjs';

test('the local bridge carries the original USB speed request rejected by browser interface checks', async () => {
  const calls = [], session = 'test-owned-session';
  const fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8767/usb'); assert.equal(options.credentials, 'omit');
    const request = JSON.parse(options.body); calls.push(request);
    let result;
    switch (request.method) {
      case 'open': result = { session, vendorId: 0x07d0, productId: 0x4959 }; break;
      case 'controlTransferIn': result = { status: 'ok', hex: '1234' }; break;
      case 'controlTransferOut': result = { status: 'ok', bytesWritten: request.args[1].hex.length / 2 }; break;
      case 'close': result = {}; assert.equal(options.keepalive, true); break;
      default: throw new Error('Unexpected RPC');
    }
    if (request.method !== 'open') assert.equal(request.session, session);
    return { ok: true, json: async () => ({ result }) };
  };
  const device = new KingsunBridgeDevice({ vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA' }, { fetch });
  const adapter = new Kingsun(device); await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  await adapter.readRaw(); await adapter.sendFrame(0xff, 0x3f, b(), 11, { receive: false }); await adapter.close();
  const speeds = calls.filter(c => c.method === 'controlTransferOut' && c.args[0].index === 1);
  assert.deepEqual(speeds.map(c => c.args[0]), Array(2).fill({ requestType: 'class', recipient: 'interface', request: 9, value: 512, index: 1 }));
  assert.deepEqual(speeds.map(c => c.args[1].hex), ['8025000003000000', '00c2010003000000']);
  assert.equal(calls.at(-1).method, 'close'); assert.equal(device.opened, false);
});
test('an absent helper gives an actionable error and never marks USB open', async () => {
  const device = new KingsunBridgeDevice({ vendorId: 0x07d0, productId: 0x4959 }, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(device.open(), /Cannot reach the KS-959 USB helper: Failed to fetch/); assert.equal(device.opened, false);
});
test('fetch is called as a browser function, without binding it to the USB device', async () => {
  const device = new KingsunBridgeDevice({ vendorId: 0x07d0, productId: 0x4959 }, {
    fetch: async function () {
      assert.equal(this, undefined, 'Window.fetch rejects a USB-device receiver with Illegal invocation');
      return { ok: true, json: async () => ({ result: { vendorId: 0x07d0, productId: 0x4959, session: 'test' } }) };
    },
  });
  await device.open(); assert.equal(device.opened, true);
});
test('the Python helper restricts USB controls, sessions and browser origins', () => {
  const run = spawnSync('python3', [new URL('./kingsun_bridge_test.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
