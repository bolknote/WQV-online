import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, encodeFrame, FrameDecoder, identifyWatch } from '../dist/irda.mjs';
import { SigmaTel, withTimeout } from '../dist/sigmatel.mjs';

const bytes = s => Uint8Array.from(Buffer.from(s.replaceAll(' ', ''), 'hex'));
const actualReply = bytes('01 19 36 66 be 04 3a 18 38 01 02 00 8c 04 00 43 41 53 49 4f 20 57 49 43 20 32 34 31 31 2f 49 52');

test('CRC-16/X-25 uses the independent standard check value', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x906e);
});
test('SIR receives reserved bytes correctly across USB packet boundaries', () => {
  const data = bytes('c0 c1 7d 43 41 53 49 4f');
  const decoder = new FrameDecoder();
  for (const byte of encodeFrame(0xfe, 0xbf, data)) decoder.feed(Uint8Array.of(byte));
  assert.deepEqual(decoder.frames, [{ address: 0xfe, control: 0xbf, data }]);
});
test('damaged packets never identify a watch', () => {
  const wire = encodeFrame(0xfe, 0xbf, actualReply);
  wire[wire.length - 4] ^= 1;
  const decoder = new FrameDecoder(); decoder.feed(wire);
  assert.equal(decoder.badCRC, 1); assert.equal(decoder.frames.length, 0);
});
test('a recorded WQV-3 response must match this discovery request', () => {
  const frame = { address: 0xfe, control: 0xbf, data: actualReply };
  assert.deepEqual(identifyWatch(frame, bytes('04 3a 18 38')), {
    model: 'Casio WQV-3', module: 2411, peerId: '19 36 66 be',
  });
  assert.equal(identifyWatch(frame, bytes('10 20 30 00')), null);
  assert.equal(identifyWatch({ ...frame, address: 0xff }, bytes('04 3a 18 38')), null);
});

class FakeDevice {
  vendorId = 0x066f; productId = 0x4200; opened = false;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
    alternateSetting: 0, interfaceClass: 0, endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 2, packetSize: 64 },
      { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 },
    ],
  }] }] };
  events = []; pending = null; claimed = false;
  async open() { this.opened = true; this.events.push('open'); }
  async claimInterface(i) { assert.equal(i, 0); this.claimed = true; this.events.push('claim'); }
  async releaseInterface(i) {
    assert.equal(i, 0); this.events.push('release'); this.claimed = false;
    this.pending?.reject(new DOMException('Interface released', 'AbortError')); this.pending = null;
  }
  async controlTransferIn(setup, count) {
    assert.equal(setup.request, 1); assert.equal(setup.requestType, 'vendor');
    assert.ok(this.claimed);
    this.events.push('registers');
    return { status: 'ok', data: new DataView(new Uint8Array(count).buffer) };
  }
  async controlTransferOut(setup) {
    assert.equal(setup.request, 3); assert.equal(setup.requestType, 'vendor');
    this.events.push(`register-${setup.index}`); return { status: 'ok', bytesWritten: 0 };
  }
  async clearHalt() { this.events.push('clear'); }
  transferIn(endpoint, size) {
    assert.ok(this.claimed); assert.equal(endpoint, 2); assert.equal(size, 64);
    assert.equal(this.pending, null, 'Only one USB read may be outstanding');
    this.events.push('read');
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  async transferOut(endpoint, packet) {
    assert.equal(endpoint, 1);
    assert.equal(this.pending, null, 'Shared FIFO must not be read during transmission');
    assert.ok(this.claimed); this.events.push('write');
    assert.equal(packet[0], 0x55); assert.equal(packet[1], 0xaa);
    assert.equal(packet[2] | (packet[3] << 8), packet.length - 4);
    return { status: 'ok', bytesWritten: packet.length };
  }
  async close() {
    this.events.push('close'); this.opened = false; this.claimed = false;
    this.pending?.reject(new DOMException('Device closed', 'AbortError')); this.pending = null;
  }
}

test('WebUSB cancels the pending reader before touching the transmit FIFO', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open();
  adapter.startReader();
  await adapter.sendFrame(0xff, 0x3f, bytes('01 10 20 30 00 ff ff ff ff 01 00 00'));
  assert.ok(device.events.indexOf('release') < device.events.indexOf('write'));
  assert.equal(adapter.switches, 1); assert.equal(adapter.txFrames, 1);
  assert.equal(adapter.readPending, true, 'Receive must resume after transmission');
  await adapter.close();
  assert.equal(device.pending, null); assert.equal(adapter.opened, false);
});
test('short USB data is decoded even without polling the infrared FIFO count', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); adapter.startReader();
  const wire = encodeFrame(0xfe, 0xbf, actualReply);
  const pending = device.pending; device.pending = null;
  pending.resolve({ status: 'ok', data: new DataView(wire.buffer) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(adapter.rxBytes, wire.length);
  assert.deepEqual(adapter.decoder.frames[0].data, actualReply);
  assert.equal(device.events.filter(e => e === 'registers').length, 1);
  await adapter.pauseReader(); await adapter.close();
});
test('unexpected read failure propagates instead of reporting a successful test', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); adapter.startReader();
  const pending = device.pending; device.pending = null;
  pending.reject(new Error('USB pipe failed'));
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(adapter.pauseReader(), /USB pipe failed/);
  await adapter.close();
});
test('stopping an unfinished USB open also closes the eventually opened handle', async () => {
  const device = new FakeDevice(); let completeOpen;
  device.open = () => new Promise(resolve => { completeOpen = () => { device.opened = true; resolve(); }; });
  const adapter = new SigmaTel(device), opening = adapter.open();
  await adapter.close(); completeOpen();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(device.opened, false);
});
test('a hung browser operation has a bounded wait', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'test operation'), /Timeout/);
});
