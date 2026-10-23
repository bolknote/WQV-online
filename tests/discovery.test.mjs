import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverySettings, xidFrame, parseXID, discoverXID } from '../dist/discovery-core.mjs';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { captureUSB, attemptFiles } from '../dist/research-core.mjs';
import { b, concat, fromHex, toHex } from '../dist/formats.mjs';
import { FrameDecoder, encodeFrame, linkParameters, sleep } from '../dist/irda.mjs';

const LOCAL = fromHex('12345678'), PEER = fromHex('87654321');
const settings = { watchMode: 'others-send', durationMs: 2000 };
const wire = frame => encodeFrame(frame.address, frame.control, frame.data);

class DiscoveryUSB {
  vendorId = 0x066f; productId = 0x4200; opened = false;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
    alternateSetting: 0, endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 2, packetSize: 64 },
      { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 },
    ],
  }] }] };
  registers = new Map([[4, 7]]); frames = []; queue = []; pending = null; onTransmit = () => {}; blocked = false; releases = 0;
  async open() { this.opened = true; }
  async claimInterface() {}
  async clearHalt() {}
  async controlTransferIn(setup, count) {
    return { status: 'ok', data: new DataView(Uint8Array.from({ length: count }, (_, i) =>
      setup.index + i === 5 ? 4 : this.registers.get(setup.index + i) ?? 0).buffer) };
  }
  async controlTransferOut(setup) { this.registers.set(setup.index, setup.index === 4 ? setup.value | 7 : setup.value); return { status: 'ok' }; }
  async transferOut(endpoint, bytes) {
    assert.equal(this.pending, null, 'Discovery transmits between completed reads, without cancelling bulk IN');
    assert.equal(endpoint, 1); assert.deepEqual(bytes.slice(0, 2), b(0x55, 0xaa));
    assert.equal(bytes[2] | bytes[3] << 8, bytes.length - 4);
    const decoder = new FrameDecoder(); decoder.feed(bytes.slice(4));
    assert.equal(decoder.frames.length, 1); const frame = decoder.frames[0];
    this.frames.push(frame); this.onTransmit(frame);
    return { status: 'ok', bytesWritten: bytes.length };
  }
  transferIn(endpoint, size) {
    assert.equal(endpoint, 2); assert.equal(size, 64); assert.equal(this.pending, null);
    return new Promise((resolve, reject) => {
      const deliver = () => {
        clearTimeout(this.pending?.timer); this.pending = null;
        const bytes = this.queue.shift() ?? b();
        resolve({ status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
      };
      this.pending = { deliver, reject, timer: this.blocked ? null : setTimeout(deliver, 2) };
      if (this.queue.length) deliver();
    });
  }
  enqueue(bytes) {
    for (let start = 0; start < bytes.length; start += 64) this.queue.push(bytes.slice(start, start + 64));
    this.pending?.deliver();
  }
  cancel() {
    if (!this.pending) return;
    const { reject, timer } = this.pending; this.pending = null; clearTimeout(timer);
    reject(new DOMException('Cancelled', 'AbortError'));
  }
  async releaseInterface() { this.releases++; this.cancel(); }
  async close() { this.opened = false; this.cancel(); }
}

async function prepare() {
  const device = new DiscoveryUSB(), events = [], usbStats = { readCount: 0, emptyReads: 0, nonemptyReads: 0, rxBytes: 0 };
  const record = (kind, details) => events.push({ kind, ...details });
  const adapter = new SigmaTel(captureUSB(device, record, () => ({ baud: adapter?.baud }), { counters: usbStats }));
  adapter.usbStats = usbStats;
  await adapter.open(); await adapter.setupSIR();
  assert.equal(device.frames.length, 0); assert.equal(usbStats.readCount, 0);
  return { device, adapter, events, record };
}

test('XID encoding includes identity only in replies and the final search slot; parsing keeps arbitrary peer identities', () => {
  for (let slot = 0; slot < 6; slot++) assert.equal(xidFrame(LOCAL, { slot }).data.length, 12);
  const final = xidFrame(LOCAL, { slot: 255 });
  assert.equal(toHex(final.data), '0112345678ffffffff01ff008425005745422d575156');
  const response = xidFrame(PEER, { response: true, destination: LOCAL, slots: 16, slot: 12 });
  const parsed = parseXID(response);
  assert.equal(parsed.name, 'WEB-WQV'); assert.equal(parsed.hintsHex, '8425'); assert.equal(parsed.slots, 16);
  assert.deepEqual(parsed.source, PEER); assert.deepEqual(parsed.destination, LOCAL);
  const invalid = { ...response, data: response.data.slice() }; invalid.data[10] = 16;
  assert.equal(parseXID(invalid), null);
  assert.equal(parseXID({ ...final, data: final.data.slice(0, 12) }), null);
  assert.equal(parseXID({ ...final, control: 0x93 }), null);
  assert.throws(() => xidFrame(LOCAL, { slot: 6 }));
});

test('discovery validates setup and an already cancelled experiment before any USB traffic', async () => {
  assert.deepEqual(discoverySettings(settings), { ...settings, baud: 9600 });
  assert.equal(discoverySettings({ ...settings, watchMode: 'pc-remote' }).watchMode, 'pc-remote');
  for (const bad of [{ durationMs: 1999 }, { durationMs: NaN }, { durationMs: 120001 }, { watchMode: 'unknown' }]) {
    assert.throws(() => discoverySettings({ ...settings, ...bad }));
  }
  const { adapter, device, record } = await prepare();
  await adapter.setSIRSpeed(115200);
  await assert.rejects(discoverXID(adapter, settings, { record }), /9600/);
  await adapter.setSIRSpeed(9600);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverXID(adapter, settings, { record, signal: controller.signal }));
  assert.equal(device.frames.length, 0); assert.equal(adapter.usbStats.readCount, 0); await adapter.close();
});

test('an unanswered search completes six slots and FF, keeps 9600 and reports actual empty USB reads', async () => {
  const { adapter, device, events, record } = await prepare();
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL });
  await adapter.close();
  assert.equal(result.status, 'no-data'); assert.equal(result.completedCycles, 1); assert.equal(result.txFrames, 7);
  assert.equal(device.releases, 0, 'Discovery never uses release/claim to stop a background reader');
  assert.deepEqual(device.frames.map(frame => parseXID(frame).slot), [0, 1, 2, 3, 4, 5, 255]);
  assert.ok(device.frames.every(frame => frame.control === 0x3f && frame.address === 0xff));
  assert.ok(adapter.usbStats.readCount > 0); assert.equal(adapter.usbStats.nonemptyReads, 0);
  assert.equal(adapter.usbStats.emptyReads, adapter.usbStats.readCount); assert.equal(adapter.usbStats.rxBytes, 0);
  assert.equal(device.registers.get(2), 0x77);
  const files = new Map(attemptFiles({ kind: 'discovery' }, events).map(file => [file.name, file.data]));
  assert.equal(files.get('usb-in.bin').length, 0); assert.ok(files.get('usb-out-requested.bin').length > 0);
  assert.match(new TextDecoder().decode(files.get('README.txt')), /Only XID/);
  assert.equal(files.get('response.bin').length, 0);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('attempt.json'))).pendingUSBCalls, []);
});

test('a peer reply is recognized without a Casio name filter and the full search still finishes', async () => {
  const { adapter, device, record } = await prepare();
  device.onTransmit = frame => {
    const xid = parseXID(frame);
    if (xid.slot === 2) device.enqueue(wire(xidFrame(PEER, { response: true, destination: LOCAL, slot: 2 })));
  };
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'peer-found'); assert.equal(result.xidResponses, 1);
  assert.equal(result.peers[0].id, toHex(PEER)); assert.equal(result.peers[0].name, 'WEB-WQV');
  assert.equal(result.completedCycles, 1); assert.equal(result.recoveredFrames, 0);
  assert.equal(device.frames.length, 7); assert.ok(device.frames.every(parseXID));
});

test('incoming discovery is answered once per cycle in an allowed slot; SNRM ends capture without UA or application traffic', async () => {
  const { adapter, device, events, record } = await prepare();
  const first = wire(xidFrame(PEER, { slot: 2 }));
  const snrm = { address: 0xff, control: 0x93, data: concat(PEER, LOCAL, b(0x22), linkParameters(2)) };
  device.enqueue(first);
  device.onTransmit = frame => {
    assert.equal(frame.control, 0xbf);
    device.enqueue(concat(first, wire(xidFrame(PEER, { slot: 3 })), wire(xidFrame(PEER, { slot: 255 })), wire(snrm)));
  };
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'connection-request'); assert.equal(result.connectionRequests, 1);
  assert.equal(result.xidRepliesSent, 1); assert.equal(result.xidCommands, 4); assert.equal(result.completedCycles, 0);
  assert.equal(device.frames.length, 1); const reply = parseXID(device.frames[0]);
  assert.equal(reply.response, true); assert.equal(reply.slot, 2); assert.deepEqual(reply.destination, PEER);
  const files = new Map(attemptFiles({ kind: 'discovery' }, events).map(f => [f.name, f.data]));
  assert.deepEqual(files.get('usb-in.bin'), concat(first, first, wire(xidFrame(PEER, { slot: 3 })), wire(xidFrame(PEER, { slot: 255 })), wire(snrm)));
  assert.ok(events.some(event => event.kind === 'peer-connection-request' && event.accepted === false));
});

test('echoes, foreign destinations and corrupt frames stay in the raw trace and do not trigger replies; Stop cancels a pending read', async () => {
  const { adapter, device, events, record } = await prepare(), controller = new AbortController();
  const corrupt = wire(xidFrame(PEER)); corrupt[14] ^= 1;
  const bytes = concat(fromHex('23e1'), corrupt, wire(xidFrame(LOCAL)),
    wire(xidFrame(PEER, { destination: fromHex('11223344') })));
  device.blocked = true; device.enqueue(bytes);
  const run = discoverXID(adapter, settings, { record, localID: LOCAL, signal: controller.signal });
  while (!device.pending || device.queue.length) await sleep(2);
  await sleep(10); controller.abort(); const result = await run; await adapter.close();
  assert.equal(result.status, 'interrupted'); assert.equal(result.echoFrames, 1);
  assert.equal(result.badCRC, 1); assert.equal(result.peers.length, 0); assert.equal(device.frames.length, 0);
  assert.equal(device.pending, null); assert.equal(result.recoveredFrames, 0);
  assert.deepEqual(attemptFiles({ kind: 'discovery' }, events).find(f => f.name === 'usb-in.bin').data, bytes);
  assert.equal(adapter.usbStats.nonemptyReads + adapter.usbStats.emptyReads, adapter.usbStats.readCount);
});

test('a search from the peer interrupts our cycle and receives a reply instead of competing search slots', async () => {
  const { adapter, device, events, record } = await prepare();
  device.onTransmit = frame => {
    if (frame.control === 0x3f) device.enqueue(wire(xidFrame(PEER, { slot: 1 })));
    else device.enqueue(wire({ address: 0xff, control: 0x93, data: concat(PEER, LOCAL, b(0x22), linkParameters(2)) }));
  };
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'connection-request'); assert.equal(result.completedCycles, 0);
  assert.deepEqual(device.frames.map(frame => [frame.control, parseXID(frame).slot]), [[0x3f, 0], [0xbf, 1]]);
  assert.ok(events.some(event => event.kind === 'discovery-cycle-yielded'));
});

test('a failed XID USB write ends with an error and is not treated as a completed transmit', async () => {
  const { adapter, device, events, record } = await prepare();
  device.transferOut = async () => ({ status: 'stall', bytesWritten: 0 });
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'error'); assert.equal(result.txFrames, 0); assert.match(result.error.message, /USB OUT/);
  assert.ok(events.some(event => event.kind === 'usb-result' && event.operation === 'transferOut' && event.status === 'stall'));
  assert.equal(events.filter(event => event.kind === 'tx-frame').length, 0);
});

test('the deadline closes USB even when bulk IN never completes a read', async () => {
  const { adapter, device, events, record } = await prepare(); device.blocked = true;
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'no-data'); assert.equal(adapter.usbStats.readCount, 0);
  assert.equal(result.completedCycles, 0); assert.equal(result.txFrames, 0); assert.equal(device.pending, null);
  assert.equal(device.releases, 0);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(attemptFiles({ kind: 'discovery' }, events)[0].data)).pendingUSBCalls, []);
});

test('a pending USB transmit at the deadline is an error, not evidence of a silent watch', async () => {
  const { adapter, device, events, record } = await prepare();
  let cancelOut;
  device.transferOut = () => new Promise((_, reject) => { cancelOut = reject; });
  const close = device.close.bind(device);
  device.close = async () => { await close(); cancelOut?.(new DOMException('Cancelled', 'AbortError')); };
  const result = await discoverXID(adapter, settings, { record, localID: LOCAL }); await adapter.close();
  assert.equal(result.status, 'error'); assert.equal(result.error.name, 'USBTransmitTimeout');
  assert.equal(result.txFrames, 0); assert.equal(result.completedCycles, 0);
  assert.ok(events.some(event => event.kind === 'usb-error' && event.operation === 'transferOut'));
});
