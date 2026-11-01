import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Kingsun, encodeKingsun } from '../dist/kingsun.mjs';
import { KingsunBridgeDevice } from '../dist/kingsun-bridge.mjs';
import { encodeFrame } from '../dist/irda.mjs';
import { fromHex, toHex } from '../dist/formats.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/ks959-chunk8-hardware.json', import.meta.url)));
const controlSetup = value => ({ requestType: 'class', recipient: 'interface', request: 9, value, index: 0 });

class Device {
  vendorId = 0x07d0; productId = 0x4959; productName = 'USB to IRDA';
  opened = false; writes = []; reads = 0;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0,
    alternates: [{ alternateSetting: 0, interfaceClass: 255 }] }] };
  async open() { this.opened = true; }
  async claimInterface(number) { assert.equal(number, 0); }
  async controlTransferOut(setup, data) {
    this.writes.push({ setup, value: setup.value, hex: toHex(data) });
    return { status: 'ok', bytesWritten: data.length };
  }
  async controlTransferIn() { this.reads++; throw new Error('Unexpected background USB read'); }
  async close() { this.opened = false; }
}

function bridgeDevice() {
  const writes = [], session = 'chunk8-helper-session';
  const device = new KingsunBridgeDevice({ vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA' }, {
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(url, 'http://127.0.0.1:8767/usb');
      if (request.method !== 'open') assert.equal(request.session, session);
      let result;
      if (request.method === 'open') result = { vendorId: 0x07d0, productId: 0x4959, session };
      else if (request.method === 'controlTransferOut') {
        writes.push({ setup: request.args[0], value: request.args[0].value, hex: request.args[1].hex });
        result = { status: 'ok', bytesWritten: request.args[1].hex.length / 2 };
      } else if (request.method === 'close') result = {};
      else throw new Error('Unexpected helper request: ' + request.method);
      return { ok: true, json: async () => ({ result }) };
    },
  });
  return { device, writes };
}

for (const backend of ['WebUSB controls', 'local helper RPC']) {
  test(`${backend} reproduces actual PC and OTHERS USB buffers, including one-byte tails and discovery`, async () => {
    const direct = new Device();
    const { device, writes } = backend === 'local helper RPC' ? bridgeDevice() : { device: direct, writes: direct.writes };
    const adapter = new Kingsun(device); await adapter.open(); await adapter.setupSIR();
    for (const sample of fixture.cases) {
      await adapter.setSIRSpeed(sample.baud);
      const start = writes.length;
      assert.equal(toHex(encodeFrame(sample.address, sample.control, fromHex(sample.dataHex), 11)), sample.wireHex);
      await adapter.sendFrame(sample.address, sample.control, fromHex(sample.dataHex), 11, { receive: false });
      const actual = writes.slice(start);
      assert.deepEqual(actual.map(({ value, hex }) => ({ value, hex })), sample.chunks,
        sample.protocol + ': ' + sample.covers.join(', '));
      for (const part of actual) assert.deepEqual(part.setup, controlSetup(part.value));
    }
    assert.equal(adapter.txFrames, fixture.cases.length);
    assert.equal(adapter.decoder.badCRC, 0);
    assert.equal(direct.reads, 0);
    await adapter.close();
  });
}

test('USB fragmentation follows the actual rate across reconnects; lower speeds keep 240-byte writes', async () => {
  const sample = fixture.cases.find(c => c.protocol === 'PC' && c.covers.includes('longest-data-frame'));
  const device = new Device(), adapter = new Kingsun(device);
  await adapter.open(); await adapter.setupSIR();
  for (const baud of [9600, 19200, 38400, 57600, 115200, 9600, 115200]) {
    await adapter.setSIRSpeed(baud); const start = device.writes.length;
    await adapter.sendFrame(sample.address, sample.control, fromHex(sample.dataHex), 11, { receive: false });
    const writes = device.writes.slice(start);
    assert.equal(Math.max(...writes.map(p => p.value)), baud === 115200 ? 8 : 240);
    // Decode the submitted requests independently of the encoder under test.
    const wire = writes.flatMap(part => {
      const mask = 'wangshuofei19710'.charCodeAt((part.value & 15) ^ 6) ^ 0x55;
      return Array.from(fromHex(part.hex).slice(0, part.value), value => value ^ mask);
    });
    assert.equal(toHex(Uint8Array.from(wire)), sample.wireHex);
  }
  await adapter.close();
});

test('a short write in a later eight-byte fragment stops TX without counting a complete frame or starting RX', async () => {
  const device = new Device(), adapter = new Kingsun(device);
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  const original = device.controlTransferOut.bind(device); let fragments = 0;
  device.controlTransferOut = async (setup, data) => {
    const result = await original(setup, data);
    if (setup.index === 0 && ++fragments === 2) result.bytesWritten--;
    return result;
  };
  await assert.rejects(adapter.sendFrame(0x71, 0x10, new Uint8Array(380)), /did not complete/);
  assert.equal(fragments, 2); assert.equal(adapter.txFrames, 0);
  assert.equal(adapter.readerTask, null); assert.equal(device.reads, 0);
  await adapter.close();
});

test('invalid USB fragment sizes are rejected before encoding', () => {
  for (const size of [0, -1, 241, 1.5, NaN]) assert.throws(() => encodeKingsun(fromHex('c00153c1'), size), RangeError);
});
