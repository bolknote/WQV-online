import test from 'node:test';
import assert from 'node:assert/strict';
import { listen, listenSettings, LISTEN_RATES } from '../dist/listen-core.mjs';
import { captureUSB, attemptFiles } from '../dist/research-core.mjs';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { b, fromHex } from '../dist/formats.mjs';
import { encodeFrame, sleep } from '../dist/irda.mjs';

class Receiver {
  vendorId = 0x066f; productId = 0x4200; opened = false;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
    alternateSetting: 0, endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 2, packetSize: 64 },
      { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 },
    ],
  }] }] };
  registers = new Map([[4, 7]]); calls = []; pending = null;
  async open() { this.opened = true; }
  async claimInterface() {}
  async clearHalt() {}
  async controlTransferIn(setup, count) {
    return { status: 'ok', data: new DataView(Uint8Array.from({ length: count }, (_, i) => this.registers.get(setup.index + i) ?? 0).buffer) };
  }
  async controlTransferOut(setup) {
    this.registers.set(setup.index, setup.index === 4 ? setup.value | 7 : setup.value);
    return { status: 'ok' };
  }
  async transferOut() { this.calls.push('out'); return { status: 'ok' }; }
  transferIn(endpoint, size) {
    assert.equal(endpoint, 2); assert.equal(size, 64); assert.equal(this.pending, null);
    this.calls.push('in');
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  async close() {
    this.opened = false; this.pending?.reject(new DOMException('Closed', 'AbortError')); this.pending = null;
  }
  async deliver(bytes = b(), status = 'ok') {
    const deadline = performance.now() + 1000;
    while (!this.pending && performance.now() < deadline) await sleep(2);
    assert.ok(this.pending, 'Passive capture keeps reading after a poll/final frame');
    const pending = this.pending; this.pending = null;
    pending.resolve({ status, data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
    await sleep(5);
  }
}

const settings = (baud = 9600) => ({ baud, watchMode: 'swan-send', durationMs: 2000 });
async function prepare(baud = 9600) {
  const device = new Receiver(), events = [];
  const record = (kind, details) => events.push({ kind, ...details });
  const adapter = new SigmaTel(captureUSB(device, record, () => ({ baud: adapter?.baud }), { receiveOnly: true }));
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(baud);
  assert.equal(device.calls.length, 0, 'Preparing USB never reads or transmits watch data');
  return { device, adapter, events, record };
}

test('passive capture validates the mode, fixed speed and bounded window before touching USB', async () => {
  for (const invalid of [{ baud: 19200 }, { watchMode: 'pc-remote' }, { durationMs: 1999 }, { durationMs: 120001 }, { durationMs: NaN }]) {
    assert.throws(() => listenSettings({ ...settings(), ...invalid }), RangeError);
  }
  const { device, adapter } = await prepare();
  await assert.rejects(listen(adapter, settings(38400)), /selected speed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listen(adapter, settings(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(device.calls.length, 0); await adapter.close();
});

test('each listening rate configures only the receiver and blocks all bulk OUT calls', async () => {
  for (const [index, baud] of LISTEN_RATES.entries()) {
    const { device, adapter, events } = await prepare(baud);
    assert.equal(device.registers.get(2), [0x77, 0x1d, 0x09][index]);
    await assert.rejects(adapter.device.transferOut(1, b(0x55, 0xaa, 1, 0, 0xc0)), /disabled in listen mode/);
    assert.equal(device.calls.length, 0);
    assert.equal(events.at(-1).kind, 'usb-error');
    await adapter.close();
  }
});

test('SWAN RECEIVE captures possible receiver invitations without sending a byte or losing unknown data', async () => {
  const { device, adapter, events, record } = await prepare(), controller = new AbortController();
  const setup = { ...settings(), watchMode: 'swan-receive' };
  assert.deepEqual(listenSettings(setup), setup);
  const run = listen(adapter, setup, { signal: controller.signal, record });
  const incoming = fromHex('15 43 0d c1 e1');
  await device.deliver(incoming.slice(0, 2)); await device.deliver(incoming.slice(2));
  controller.abort(); const result = await run; await adapter.close();
  assert.equal(result.watchMode, 'swan-receive'); assert.equal(result.rxBytes, incoming.length);
  assert.equal(result.txFrames, 0); assert.ok(device.calls.every(call => call === 'in'));
  assert.ok(events.some(event => event.kind === 'listen-start' && event.watchMode === 'swan-receive' && !event.transmitting));
  assert.deepEqual(attemptFiles({ kind: 'listen', watchMode: 'swan-receive' }, events).find(file => file.name === 'usb-in.bin').data, incoming);
});

test('a background control at 38400 records only raw input and keeps its own background label', async () => {
  const { device, adapter, events, record } = await prepare(38400), controller = new AbortController();
  const run = listen(adapter, { ...settings(38400), watchMode: 'background' }, { signal: controller.signal, record });
  await device.deliver(fromHex('ff23e1c0')); await device.deliver();
  controller.abort(); const result = await run; await adapter.close();
  assert.equal(result.watchMode, 'background'); assert.equal(result.baud, 38400); assert.equal(result.rxBytes, 4);
  assert.equal(result.txFrames, 0); assert.ok(device.calls.every(call => call === 'in'));
  assert.deepEqual(attemptFiles({ kind: 'listen', watchMode: null, watchPresent: false }, events).find(file => file.name === 'usb-in.bin').data, fromHex('ff23e1c0'));
  assert.ok(events.some(event => event.kind === 'listen-start' && event.watchMode === 'background' && event.transmitting === false));
});

test('passive capture keeps unknown bytes, split frames and bad CRC, without answering poll frames or repairing EOF', async () => {
  const { device, adapter, events, record } = await prepare(115200), controller = new AbortController();
  const run = listen(adapter, settings(115200), { signal: controller.signal, record });
  const first = encodeFrame(0xff, 0x3f, b(0x11, 0x22), 1);
  const second = encodeFrame(0x71, 0x10, b(0xc0, 0xc1, 0x7d), 1);
  const invalid = encodeFrame(0x71, 0x20, b(0x11), 1); invalid[2] ^= 1;
  const damaged = encodeFrame(0x71, 0x10, b(0x33), 1); damaged[damaged.length - 1] = 0xe1;
  const backing = b(0xaa, 0x23, 0xe1, 0xbb), unknown = backing.subarray(1, 3);
  for (const chunk of [unknown, first.slice(0, 3), first.slice(3), second, invalid, damaged, b(), b()]) await device.deliver(chunk);
  controller.abort(); const result = await run;
  assert.equal(result.status, 'interrupted'); assert.equal(result.validFrames, 2);
  assert.equal(result.badCRC, 1); assert.equal(result.emptyReads, 2); assert.equal(result.recoveredFrames, 0);
  assert.equal(result.readCount, 8); assert.equal(result.txFrames, 0);
  assert.ok(device.calls.every(call => call === 'in'));
  const frames = events.filter(e => e.kind === 'rx-frame');
  assert.deepEqual(frames.map(e => e.dataHex), ['1122', 'c0c17d']);
  await adapter.close(); await sleep(0);
  const files = new Map(attemptFiles({ kind: 'listen' }, events).map(f => [f.name, f.data]));
  assert.deepEqual(files.get('usb-in.bin'), b(...unknown, ...first, ...second, ...invalid, ...damaged));
  assert.equal(files.get('usb-out-requested.bin').length, 0);
  assert.equal(files.get('response.bin').length, 0);
  assert.match(new TextDecoder().decode(files.get('README.txt')), /No CRC recovery/);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('attempt.json'))).pendingUSBCalls, []);
});

test('Stop returns with a read pending; USB close cancels it and preserves the captured bytes', async () => {
  const { device, adapter, events, record } = await prepare(), controller = new AbortController();
  const run = listen(adapter, settings(), { signal: controller.signal, record });
  await device.deliver(fromHex('23e1ff'));
  while (!device.pending) await sleep(2);
  controller.abort(); const result = await run;
  assert.equal(result.status, 'interrupted'); assert.equal(result.rxBytes, 3);
  assert.ok(device.pending, 'Only USB close cancels the underlying browser transfer');
  await adapter.close(); await sleep(0);
  assert.equal(device.pending, null); assert.ok(events.some(e => e.kind === 'usb-error' && e.operation === 'transferIn'));
});

test('the capture deadline finishes even if the USB endpoint never completes a read', async () => {
  const { device, adapter, events, record } = await prepare();
  const result = await listen(adapter, settings(), { record });
  assert.equal(result.status, 'no-data'); assert.equal(result.readCount, 0);
  assert.equal(device.calls.length, 1); assert.ok(device.pending);
  const files = attemptFiles({ kind: 'listen' }, events);
  assert.equal(JSON.parse(new TextDecoder().decode(files[0].data)).pendingUSBCalls.length, 1);
  await adapter.close();
});

test('USB errors end the capture with earlier raw bytes and no command transmission', async () => {
  const { device, adapter, events, record } = await prepare();
  const run = listen(adapter, settings(), { record });
  await device.deliver(fromHex('998877')); await device.deliver(b(), 'stall');
  const result = await run;
  assert.equal(result.status, 'error'); assert.match(result.error.message, /stall/); assert.equal(result.rxBytes, 3);
  assert.deepEqual(attemptFiles({ kind: 'listen' }, events).find(f => f.name === 'usb-in.bin').data, fromHex('998877'));
  assert.ok(device.calls.every(call => call === 'in')); await adapter.close();
});
