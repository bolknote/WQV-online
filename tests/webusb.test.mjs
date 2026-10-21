import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, encodeFrame, FrameDecoder, identifyWatch } from '../dist/irda.mjs';
import { SigmaTel, withTimeout } from '../dist/sigmatel.mjs';
import { WQVClient } from '../dist/protocol.mjs';

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
  events = []; pending = null; claimed = false; registerValues = new Map([[4, 7]]);
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
    return { status: 'ok', data: new DataView(Uint8Array.from({ length: count }, (_, i) => this.registerValues.get(setup.index + i) || 0).buffer) };
  }
  async controlTransferOut(setup) {
    assert.equal(setup.request, 3); assert.equal(setup.requestType, 'vendor');
    this.events.push(`register-${setup.index}`);
    const value = setup.index === 4 ? (setup.value & ~7) | (this.registerValues.get(4) & 7) : setup.value;
    this.registerValues.set(setup.index, value);
    return { status: 'ok', bytesWritten: 0 };
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

async function deliverRead(device, data = new Uint8Array(), status = 'ok') {
  const pending = device.pending; device.pending = null;
  assert.ok(pending, 'A USB IN request is pending');
  pending.resolve({ status, data: new DataView(data.buffer, data.byteOffset, data.byteLength) });
  await Promise.resolve(); await Promise.resolve();
}

test('SigmaTel idle completion matches the original PAD-5 revision/rate traces', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pad5-idle.json', import.meta.url), 'utf8'));
  for (const row of fixture.cases) {
    const device = new FakeDevice(); device.registerValues.set(4, row.revision);
    const messages = [], adapter = new SigmaTel(device, { rawLog: true, log: (...args) => messages.push(args) });
    await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(row.baud);
    assert.equal(adapter.revision, row.revision); adapter.startReader();
    for (const chunk of row.reads) {
      if (!device.pending) break; // A recovered final frame has already handed back the turn.
      await deliverRead(device, bytes(chunk));
    }
    const accepted = adapter.decoder.frames.map(frame => Buffer.from([frame.address, frame.control, ...frame.data]).toString('hex'));
    const context = `${row.name}, rev ${row.revision}, ${row.baud} bit/s`;
    assert.deepEqual(accepted, row.accepted, context);
    assert.equal(adapter.decoder.recoveredFrames, row.recovered, context);
    assert.equal(adapter.decoder.badCRC, row.badCRC, context);
    assert.equal(adapter.baud, row.baud);
    assert.equal(device.registerValues.get(1), 0x2a, 'Recovery preserves MODE');
    if (row.recovered) {
      assert.ok(messages.some(([kind, text]) => kind === 'info' && String(text).includes('Frames recovered')), context);
      assert.ok(messages.some(([kind, text]) => kind === 'usb-rx' && String(text).startsWith('0 bytes:')), context);
      assert.equal(adapter.readPending, false, 'Final/poll stops the reader after an idle recovery');
    }
    await adapter.close();
  }
});

test('a recovered final reply allows transmission without cancelling another read', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  adapter.startReader();
  const data = bytes('c0 c1 7d 43 41 53 49 4f'), wire = encodeFrame(0xfe, 0x10, data);
  wire[wire.length - 1] = 0xe1;
  await deliverRead(device, wire); await deliverRead(device);
  assert.equal(adapter.decoder.frames.length, 0, 'One empty read cannot finish a revision-7 frame');
  await deliverRead(device);
  assert.deepEqual(await adapter.receiveFrame(), { address: 0xfe, control: 0x10, data });
  assert.equal(adapter.readerTask, null); assert.equal(device.pending, null);
  device.releaseInterface = async () => { throw new Error('Pending read cannot be cancelled'); };
  await adapter.sendFrame(0xff, 0x10, bytes('83 04 01 00 0e'));
  assert.equal(adapter.txFrames, 1); assert.equal(adapter.readPending, true);
  await adapter.close();
});

test('non-final idle recovery keeps reading, and new data restarts the empty-read count', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  adapter.startReader();
  const data = bytes('43 41 53 49 4f'), wire = encodeFrame(0xfe, 0x20, data, 1);
  wire[wire.length - 1] = 0xe1;
  await deliverRead(device, wire.slice(0, 4)); await deliverRead(device);
  await deliverRead(device, wire.slice(4)); await deliverRead(device);
  assert.equal(adapter.decoder.frames.length, 0);
  await deliverRead(device);
  assert.deepEqual(await adapter.receiveFrame(), { address: 0xfe, control: 0x20, data });
  assert.equal(adapter.readPending, true, 'A non-final recovery must not take the peer\'s turn');
  assert.equal(adapter.decoder.recoveredFrames, 1);
  await deliverRead(device, encodeFrame(0xfe, 0x51));
  assert.equal((await adapter.receiveFrame()).control, 0x51);
  assert.equal(adapter.readPending, false); assert.equal(adapter.decoder.recoveredFrames, 1);
  await adapter.close();
});

test('an unresolved, missing-data or failed USB result cannot stand in for an empty read', async () => {
  for (const mode of ['pending', 'missing-data', 'stall', 'rejected']) {
    const device = new FakeDevice(), adapter = new SigmaTel(device);
    await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
    adapter.startReader();
    const wire = encodeFrame(0xfe, 0x10, bytes('43 41 53'));
    await deliverRead(device, wire.slice(0, -1)); await deliverRead(device);
    if (mode === 'missing-data') {
      const pending = device.pending; device.pending = null;
      pending.resolve({ status: 'ok' });
      await Promise.resolve(); await Promise.resolve();
    } else if (mode === 'stall') await deliverRead(device, new Uint8Array(), 'stall');
    else if (mode === 'rejected') {
      const pending = device.pending; device.pending = null;
      pending.reject(new Error('USB pipe failed'));
      await Promise.resolve(); await Promise.resolve();
    }
    if (mode === 'pending' || mode === 'missing-data') assert.equal(await adapter.receiveFrame(5), null);
    else await assert.rejects(adapter.receiveFrame(), /USB IN: stall|USB pipe failed/);
    assert.equal(adapter.decoder.frames.length, 0, mode);
    assert.equal(adapter.decoder.recoveredFrames, 0, mode);
    assert.equal(adapter.decoder.badCRC, 0, mode);
    await adapter.close();
  }
});

test('stopping the receiver ignores a cancelled read returned as an empty success', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  adapter.startReader();
  const wire = encodeFrame(0xfe, 0x10, bytes('43 41 53'));
  await deliverRead(device, wire.slice(0, -1)); await deliverRead(device);
  device.releaseInterface = async () => {
    device.claimed = false;
    const pending = device.pending; device.pending = null;
    pending.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) });
  };
  await adapter.pauseReader();
  assert.equal(adapter.decoder.frames.length, 0); assert.equal(adapter.decoder.recoveredFrames, 0);
  adapter.startReader(); await deliverRead(device);
  assert.equal(adapter.decoder.frames.length, 0, 'A fresh reader cannot reuse an old idle-read count');
  await deliverRead(device, bytes('c1'));
  assert.equal((await adapter.receiveFrame()).control, 0x10);
  assert.equal(adapter.decoder.recoveredFrames, 0); assert.equal(adapter.readError, null);
  await adapter.close();
});

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

test('SigmaTel stops the reader for a speed change and uses the documented SIR clock values', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR(); adapter.startReader();
  device.events.length = 0;
  for (const [baud, clock] of [[115200, 0x09], [57600, 0x13], [38400, 0x1d], [19200, 0x3b], [9600, 0x77]]) {
    await adapter.setSIRSpeed(baud);
    assert.equal(adapter.baud, baud);
    assert.equal(device.registerValues.get(2), clock);
    assert.equal(adapter.readPending, true);
  }
  assert.ok(device.events.indexOf('release') < device.events.indexOf('register-2'));
  const before = device.events.slice();
  await assert.rejects(adapter.setSIRSpeed(48000), RangeError);
  assert.deepEqual(device.events, before, 'Unsupported rates must not touch the device');
  await adapter.close();
});

test('a failed clock-register readback does not advertise a configured adapter', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR();
  const read = device.controlTransferIn.bind(device);
  device.controlTransferIn = async (setup, count) => setup.index === 2 ?
    { status: 'ok', data: new DataView(Uint8Array.of(0x77).buffer) } : read(setup, count);
  await assert.rejects(adapter.setSIRSpeed(115200), /register did not accept/);
  assert.equal(adapter.configured, false); assert.equal(adapter.baud, null);
  await adapter.close();
});

test('a final frame stops reception without resubmitting a read that release might not cancel', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); adapter.startReader();
  const pending = device.pending; device.pending = null;
  const wire = encodeFrame(0xfe, 0x51);
  pending.resolve({ status: 'ok', data: new DataView(wire.buffer) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(adapter.readPending, false);
  assert.equal(adapter.readerTask, null);
  assert.equal(device.pending, null, 'No new USB read after the peer gives back the turn');
  assert.equal((await adapter.receiveFrame()).control, 0x51);
  // Reproduce the Chromium cancellation failure: this method must not be
  // needed at all between a complete final reply and the following transmit.
  device.releaseInterface = async () => { throw new Error('Pending read cannot be cancelled'); };
  await adapter.sendFrame(0xff, 0x10, bytes('83 04 01 00 0e'));
  assert.equal(adapter.txFrames, 1);
  assert.equal(adapter.readPending, true, 'The next transmit restarts reception');
  await adapter.close();
});

test('non-final frames keep reception running, and another receive can restart it after a final frame', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); adapter.startReader();
  for (const control of [0x20, 0x32]) {
    const pending = device.pending; device.pending = null;
    const wire = encodeFrame(0xfe, control, bytes('01 02 03'));
    pending.resolve({ status: 'ok', data: new DataView(wire.buffer) });
    await Promise.resolve(); await Promise.resolve();
    assert.equal((await adapter.receiveFrame()).control, control);
    assert.equal(adapter.readPending, control === 0x20);
  }
  assert.equal(await adapter.receiveFrame(5), null);
  assert.equal(adapter.readPending, true);
  await adapter.close();
});

function stuckFIFO(device, { failClear = false, stillBusy = false } = {}) {
  const read = device.controlTransferIn.bind(device), write = device.controlTransferOut.bind(device);
  let poll = 0, cleared = false;
  const writes = [];
  device.controlTransferIn = async (setup, count) => {
    if (setup.index !== 5) return read(setup, count);
    const data = cleared ? stillBusy ? [0x10, 1, 0] : [0xc4, 0, 0] : [0x10, ++poll === 1 ? 20 : 21, 0];
    return { status: 'ok', data: new DataView(Uint8Array.from(data).buffer) };
  };
  device.controlTransferOut = async setup => {
    assert.equal(device.pending, null, 'Stop USB IN before touching FIFO controls');
    writes.push([setup.index, setup.value]);
    if (setup.index === 5) {
      assert.ok(device.registerValues.get(3) & 8, 'Demodulator must be powered down during FIFO clear');
      if (setup.value === 8 && failClear) throw new Error('FIFO clear USB write failed');
      if (setup.value === 0) cleared = true;
    }
    return write(setup);
  };
  return writes;
}

test('FIFO growth triggers PAD-5 recovery, discards stale replies and ends the old session', async () => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  device.registerValues.set(3, 0x46); // Preserve RXSLOW and TX power bits.
  adapter.decoder.frames.push({ address: 0xfe, control: 0x51, data: new Uint8Array() });
  adapter.decoder.feed(bytes('c0 fe 10 7d'));
  adapter.startReader();
  const originalRead = device.controlTransferIn, originalWrite = device.controlTransferOut;
  const writes = stuckFIFO(device), client = new WQVClient(adapter);
  client.connected = true;
  await assert.rejects(client.send(bytes('01 02')), /FIFO was cleared/);
  assert.deepEqual(writes, [[3, 0x4e], [5, 8], [5, 0], [3, 0x46]]);
  assert.equal(adapter.fifoRecoveries, 1); assert.equal(adapter.configured, false); assert.equal(adapter.baud, null);
  assert.equal(adapter.decoder.frames.length, 0); assert.equal(adapter.decoder.body, null);
  assert.equal(adapter.readPending, false); assert.equal(device.pending, null);
  // Recovery never changes the baud divider or MODE, and never replays OUT.
  assert.equal(device.registerValues.get(2), 9); assert.equal(device.registerValues.get(1), 0x2a);
  const count = device.events.filter(e => e === 'write').length;
  await assert.rejects(adapter.sendFrame(0xff, 0x3f, bytes('01')), /FIFO was cleared/);
  await assert.rejects(adapter.receiveFrame(), /FIFO was cleared/);
  await client.close(); assert.equal(client.connected, false);
  assert.equal(device.events.filter(e => e === 'write').length, count);
  await adapter.close();
  // Reopening creates a fresh transport; normal setup still starts at9600.
  device.controlTransferIn = originalRead; device.controlTransferOut = originalWrite;
  const next = new SigmaTel(device); await next.open(); await next.setupSIR();
  await next.sendFrame(0xff, 0x3f, bytes('01'));
  assert.equal(next.baud, 9600); assert.equal(device.registerValues.get(1), 0x2a);
  await next.close();
});

test('a FIFO drain timeout recovers even when its byte count does not grow', async t => {
  const device = new FakeDevice(), adapter = new SigmaTel(device);
  await adapter.open(); await adapter.setupSIR();
  const writes = stuckFIFO(device);
  const now = performance.now(); let tick = 0;
  t.mock.method(performance, 'now', () => now + tick++ * 2000);
  await assert.rejects(adapter.sendFrame(0xff, 0x3f, bytes('01')), /FIFO was cleared/);
  assert.deepEqual(writes, [[3, 8], [5, 8], [5, 0], [3, 0]]);
  assert.equal(adapter.fifoRecoveries, 1); await adapter.close();
});

test('failed FIFO clears restore RX and remain failed instead of reporting recovery', async () => {
  for (const options of [{ failClear: true }, { stillBusy: true }]) {
    const device = new FakeDevice(), adapter = new SigmaTel(device);
    await adapter.open(); await adapter.setupSIR(); device.registerValues.set(3, 0x42);
    const writes = stuckFIFO(device, options);
    await assert.rejects(adapter.sendFrame(0xff, 0x3f, bytes('01')), /FIFO recovery failed/);
    assert.deepEqual(writes, [[3, 0x4a], [5, 8], [5, 0], [3, 0x42]]);
    assert.equal(device.registerValues.get(3), 0x42);
    assert.equal(adapter.fifoRecoveries, 0); assert.equal(adapter.configured, false);
    await assert.rejects(adapter.receiveFrame(), /FIFO recovery failed/);
    await adapter.close();
  }
});
