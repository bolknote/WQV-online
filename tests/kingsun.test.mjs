import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Kingsun, KingsunCounter, KingsunStream, encodeKingsun } from '../dist/kingsun.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, fromHex as hx, toHex, concat, equal } from '../dist/formats.mjs';
import { readSIR } from '../dist/transport.mjs';
import { captureUSB, attemptFiles } from '../dist/research-core.mjs';
import { russian } from '../dist/translations.mjs';

const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8').then(JSON.parse);
const vectors = await fixture('kingsun-tx-vectors.json');
const hardware = await fixture('kingsun-hardware.json');
const view = data => new DataView(data.buffer, data.byteOffset, data.length);
const nonce = b(0x12, 0x34, 0x56, 0x78);
const xid = (source = nonce) => encodeFrame(0xfe, 0xbf, concat(b(1, 1, 2, 3, 4), source, b(1, 0, 0, 0x84, 0x25, 0), new TextEncoder().encode('CASIO WIC 2411/IR')));

// Synthetic wire source, including the device's extra counter-wrap slot.
function usbBytes(clear, phase) {
  const out = [];
  for (const byte of clear) {
    phase = (phase + 1) & 255;
    if (!phase) { out.push(0x95 ^ 0x55); phase = 1; }
    out.push(byte ^ phase ^ 0x55);
  }
  return Uint8Array.from(out);
}

test('KS-959 TX matches vectors produced by the original driver, including padding and 240-byte fragments', () => {
  for (const sample of vectors.cases) {
    assert.deepEqual(encodeKingsun(hx(sample.clearHex)).map(part => ({ validBytes: part.length, encodedHex: toHex(part.data) })), sample.fragments);
  }
});

test('a fresh browser finds every possible receive counter from an echoed discovery nonce and original CRC', () => {
  const wire = concat(xid(), encodeFrame(0x70, 0x73, Uint8Array.from({ length: 600 }, (_, i) => i)));
  for (let phase = 0; phase < 256; phase++) {
    const stream = new KingsunStream(); stream.expectDiscovery(nonce);
    const raw = usbBytes(wire, phase), clear = [];
    for (let p = 0; p < raw.length; p += 13) clear.push(stream.feed(raw.slice(p, p + 13)));
    assert.deepEqual(concat(...clear), wire, 'initial counter ' + phase);
    assert.ok(stream.counter); assert.equal(stream.counter.unexpectedMarkers, 0);
  }
});

test('without a discovery nonce, synchronization requires two CRC-valid frames', () => {
  const first = encodeFrame(0xff, 0x3f, b(1, 2, 3)), second = encodeFrame(0xff, 0x3f, b(4, 5, 6));
  const raw = usbBytes(concat(first, second), 217), stream = new KingsunStream();
  assert.equal(stream.feed(raw.slice(0, first.length)).length, 0); assert.equal(stream.counter, null);
  assert.deepEqual(stream.feed(raw.slice(first.length)), concat(first, second));
});

test('a wrong nonce or damaged CRC cannot synchronize a one-frame stream', () => {
  for (const wire of [xid(b(9, 9, 9, 9)), (() => { const v = xid(); v[15] ^= 1; return v; })()]) {
    const stream = new KingsunStream(); stream.expectDiscovery(nonce);
    assert.equal(stream.feed(usbBytes(wire, 98)).length, 0); assert.equal(stream.counter, null);
  }
  assert.throws(() => new KingsunCounter(-1), RangeError);
  assert.throws(() => new KingsunCounter(256), RangeError);
});

test('unknown-counter buffering is bounded, and a later discovery can still synchronize', () => {
  const stream = new KingsunStream(); stream.expectDiscovery(nonce);
  stream.feed(new Uint8Array(12000)); stream.feed(new Uint8Array(12000));
  assert.ok(stream.pendingBytes <= 16384);
  const wire = xid();
  const decoded = stream.feed(usbBytes(wire, 98));
  assert.ok(decoded.length >= wire.length); assert.ok(stream.counter);
  const decoder = new FrameDecoder(); decoder.feed(decoded);
  assert.ok(decoder.frames.some(frame => frame.control === 0xbf && equal(frame.data.slice(5, 9), nonce)));
});

test('the browser transport replays both real WQV-3 recordings byte for byte, with no framing repairs', () => {
  for (const session of hardware.sessions) {
    const stream = new KingsunStream();
    const search = session.frames.find(f => f.direction === 'TX' && f.control === 0x3f);
    stream.expectDiscovery(hx(search.data).slice(1, 5));
    const parts = session.reads.map(raw => stream.feed(hx(raw)));
    const clear = concat(...parts), decoder = new FrameDecoder(); decoder.feed(clear);
    assert.deepEqual(clear, hx(session.clearHex), session.capture);
    assert.equal(toHex(concat(...session.reads.map(hx))), session.rawHex);
    assert.equal(stream.counter.phase, (session.initialPhase + session.rawHex.length / 2) & 255);
    assert.equal(decoder.badCRC, 0); assert.equal(decoder.recoveredFrames, 0);
    assert.deepEqual(decoder.frames.map(f => ({ address: f.address, control: f.control, data: toHex(f.data) })),
      session.frames.filter(f => f.direction === 'RX').map(({ address, control, data }) => ({ address, control, data })));
  }
});

class USBDevice {
  vendorId = 0x07d0; productId = 0x4959; productName = 'USB to IRDA'; manufacturerName = 'Kingsun CO.';
  opened = false; configuration = null; calls = []; reads = [];
  async open() { this.opened = true; this.calls.push(['open']); }
  async selectConfiguration(number) {
    assert.equal(number, 1); this.calls.push(['configuration', number]);
    this.configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
      alternateSetting: 0, interfaceClass: 255, endpoints: [{ type: 'interrupt', direction: 'in', endpointNumber: 1, packetSize: 8 }],
    }] }] };
  }
  async claimInterface(number) { assert.equal(number, 0); this.calls.push(['claim', number]); }
  async controlTransferOut(setup, data) { this.calls.push(['out', setup, toHex(data)]); return { status: 'ok', bytesWritten: data.length }; }
  async controlTransferIn(setup, length) {
    this.calls.push(['in', setup, length]);
    assert.deepEqual(setup, { requestType: 'class', recipient: 'interface', request: 1, value: 0x200, index: 0 });
    assert.equal(length, 2048); return { status: 'ok', data: view(this.reads.shift() ?? b()) };
  }
  async transferIn() { throw new Error('The dummy interrupt endpoint must not be read.'); }
  async transferOut() { throw new Error('KS-959 has no bulk OUT endpoint.'); }
  async close() { this.opened = false; this.calls.push(['close']); }
}

test('WebUSB uses only class control transfers and preserves synchronization across speed changes', async () => {
  const device = new USBDevice(), adapter = new Kingsun(device);
  const description = await adapter.open(); await adapter.setupSIR();
  assert.equal(description.controlEndpoint, 0); assert.equal(description.driver, 'KingSun KS-959');
  device.reads.push(usbBytes(xid(), 98)); adapter.stream.expectDiscovery(nonce);
  const first = await readSIR(adapter); assert.deepEqual(new Uint8Array(first.data.buffer), xid());
  const before = adapter.stream.counter.phase;
  await adapter.setSIRSpeed(115200); assert.equal(adapter.stream.counter.phase, before);
  const frame = encodeFrame(0x70, 0x73, b(1, 2, 0xc1, 0x7d));
  device.reads.push(usbBytes(frame, before));
  const next = await readSIR(adapter); assert.deepEqual(new Uint8Array(next.data.buffer), frame);
  await adapter.sendFrame(0xff, 0x3f, concat(b(1), nonce, b(255, 255, 255, 255, 1, 0, 0)), 11, { receive: false });
  const rates = device.calls.filter(c => c[0] === 'out' && c[1].index === 1);
  assert.deepEqual(rates.map(c => c[2]), ['8025000003000000', '00c2010003000000']);
  const tx = device.calls.find(c => c[0] === 'out' && c[1].index === 0);
  const expected = encodeKingsun(encodeFrame(0xff, 0x3f, concat(b(1), nonce, b(255, 255, 255, 255, 1, 0, 0))))[0];
  assert.equal(tx[1].value, expected.length); assert.equal(tx[2], toHex(expected.data));
  assert.equal(adapter.decoder.recoverFrames, false); assert.equal(adapter.decoder.recoverBOF, false);
  await adapter.close(); assert.equal(adapter.opened, false);
});

test('short speed writes never mark the port configured', async () => {
  const device = new USBDevice(), adapter = new Kingsun(device); await adapter.open();
  device.controlTransferOut = async () => ({ status: 'ok', bytesWritten: 4 });
  await assert.rejects(adapter.setupSIR(), /did not complete/); assert.equal(adapter.configured, false);
  await adapter.close();
});

test('Stop closes a pending KS-959 control read without inventing received bytes', async () => {
  const device = new USBDevice(), adapter = new Kingsun(device); await adapter.open(); await adapter.setupSIR();
  let rejectRead;
  device.controlTransferIn = () => new Promise((_, reject) => { rejectRead = reject; });
  device.close = async () => { device.opened = false; rejectRead(new DOMException('USB closed', 'AbortError')); };
  adapter.startReader(); assert.equal(adapter.readPending, true);
  await adapter.close(); await adapter.readerTask;
  assert.equal(adapter.readPending, false); assert.equal(adapter.readTask, null);
  assert.equal(adapter.rxBytes, 0); assert.equal(adapter.rawRxBytes, 0); assert.equal(adapter.readError, null);
  assert.equal(adapter.decoder.frames.length, 0);
});

test('USB journals and listen-only guards recognize KS-959 control traffic', async () => {
  const device = new USBDevice(), events = [], counters = { readCount: 0, nonemptyReads: 0, emptyReads: 0, rxBytes: 0 };
  const record = (kind, details) => events.push({ kind, ...details });
  const adapter = new Kingsun(captureUSB(device, record, () => ({}), { receiveOnly: true, counters }));
  await adapter.open(); await adapter.setupSIR();
  device.reads.push(b(0x12, 0x34)); await adapter.readRaw();
  assert.equal(counters.rxBytes, 2); assert.equal(counters.nonemptyReads, 1);
  await assert.rejects(adapter.sendFrame(0xff, 0x3f, b()), /disabled in listen mode/);
  assert.equal(device.calls.filter(c => c[0] === 'out' && c[1].index === 0).length, 0);
  const exported = new Map(attemptFiles({ kind: 'irtranp' }, events).map(f => [f.name, f.data]));
  assert.equal(toHex(exported.get('usb-in.bin')), '1234');
  await adapter.close();
});

test('new adapter messages have Russian translations', async () => {
  const code = await readFile(new URL('../dist/kingsun.mjs', import.meta.url), 'utf8');
  for (const [, message] of code.matchAll(/tr\('([^']+)'/g)) assert.ok(russian[message], message);
});
