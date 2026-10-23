import test from 'node:test';
import assert from 'node:assert/strict';
import { serialSettings, sendSerialBytes, probeSerial, finishSerialCapture, xmodemCandidates } from '../dist/serial-core.mjs';
import { captureUSB, attemptFiles } from '../dist/research-core.mjs';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { b, concat, fromHex, toHex } from '../dist/formats.mjs';
import { sleep } from '../dist/irda.mjs';

const settings = { probe: 'nak', watchMode: 'swan-send', durationMs: 2000 };
const block = (sequence, data = Uint8Array.from({ length: 128 }, (_, i) => i)) =>
  concat(b(1, sequence, sequence ^ 255), data, b(data.reduce((sum, value) => (sum + value) & 255, 0)));

class SerialUSB {
  vendorId = 0x066f; productId = 0x4200; opened = false;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
    alternateSetting: 0, endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 2, packetSize: 64 },
      { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 },
    ],
  }] }] };
  registers = new Map([[4, 7]]); queue = []; writes = []; pending = null;
  blocked = false; onTransmit = () => {}; releases = 0; status = 4;
  async open() { this.opened = true; }
  async claimInterface() {}
  async clearHalt() {}
  async controlTransferIn(setup, count) {
    return { status: 'ok', data: new DataView(Uint8Array.from({ length: count }, (_, i) =>
      setup.index + i === 5 ? this.status : this.registers.get(setup.index + i) ?? 0).buffer) };
  }
  async controlTransferOut(setup) {
    this.registers.set(setup.index, setup.index === 4 ? setup.value | 7 : setup.value);
    return { status: 'ok' };
  }
  async transferOut(endpoint, bytes) {
    assert.equal(endpoint, 1); assert.equal(this.pending, null, 'Never cancel or overlap a pending read to send');
    this.writes.push({ bytes: bytes.slice(), at: performance.now() }); this.onTransmit(bytes.slice(4));
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
    for (let offset = 0; offset < bytes.length; offset += 64) this.queue.push(bytes.slice(offset, offset + 64));
    this.pending?.deliver();
  }
  async releaseInterface() { this.releases++; throw new Error('Raw serial must not use release/claim'); }
  async close() {
    this.opened = false;
    if (this.pending) {
      const { reject, timer } = this.pending; this.pending = null; clearTimeout(timer);
      reject(new DOMException('Closed', 'AbortError'));
    }
  }
}

async function prepare({ passive = false } = {}) {
  const device = new SerialUSB(), events = [], usbStats = { readCount: 0, emptyReads: 0, nonemptyReads: 0, rxBytes: 0 };
  const record = (kind, details) => events.push({ kind, ...details });
  const adapter = new SigmaTel(captureUSB(device, record, () => ({ baud: adapter?.baud }), { receiveOnly: passive, counters: usbStats }));
  adapter.usbStats = usbStats;
  await adapter.open(); await adapter.setupSIR();
  assert.equal(device.writes.length, 0); assert.equal(usbStats.readCount, 0);
  return { device, adapter, record, events };
}

test('serial probes require a valid preset, watch mode and idle 9600 receiver before touching data endpoints', async () => {
  assert.equal(serialSettings(settings).probeHex, '15');
  assert.equal(serialSettings({ ...settings, probe: 'cr' }).repeatMs, 0);
  for (const bad of [{ probe: 'aa' }, { watchMode: 'pc-remote' }, { watchMode: 'swan-receive' }, { durationMs: 0 }, { durationMs: NaN }, { durationMs: 120001 }]) {
    assert.throws(() => serialSettings({ ...settings, ...bad }), RangeError);
  }
  const { device, adapter, record } = await prepare();
  await adapter.setSIRSpeed(115200);
  await assert.rejects(probeSerial(adapter, settings), /9600/);
  await adapter.setSIRSpeed(9600);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeSerial(adapter, settings, { record, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(device.writes.length, 0); assert.equal(adapter.usbStats.readCount, 0);
  await adapter.close();
});

test('raw SIR adds only the SigmaTel USB header and never escapes data, appends CRC or starts a background reader', async () => {
  const { device, adapter, record, events } = await prepare();
  const payload = fromHex('150dc0c17d00ff');
  assert.equal(await sendSerialBytes(adapter, payload, { record }), true);
  assert.deepEqual(device.writes[0].bytes, concat(fromHex('55aa0700'), payload));
  assert.equal(adapter.txFrames, 0); assert.equal(adapter.readerTask, null); assert.equal(device.releases, 0);
  assert.ok(events.some(event => event.kind === 'serial-tx-usb-complete' && event.dataHex === toHex(payload)));
  adapter.readPending = true;
  await assert.rejects(sendSerialBytes(adapter, b(0x15)), /idle/);
  adapter.readPending = false;
  await assert.rejects(sendSerialBytes(adapter, b()), RangeError);
  await adapter.close();
});

test('NAK repeats only while silent, with confirmed USB/FIFO completions and no speed switch', async () => {
  const { adapter, device, record } = await prepare();
  const result = await probeSerial(adapter, { ...settings, durationMs: 3000 }, { record });
  await adapter.close();
  assert.equal(result.status, 'no-data'); assert.equal(result.txAttempts, 2); assert.equal(result.txCompleted, 2);
  assert.equal(result.txSerialBytes, 2); assert.equal(result.rxBytes, 0);
  assert.ok(device.writes[1].at - device.writes[0].at >= 1990);
  assert.ok(device.writes.every(write => toHex(write.bytes) === '55aa010015'));
  assert.equal(device.registers.get(2), 0x77); assert.equal(device.releases, 0); assert.equal(result.automaticAcknowledgements, false);
});

test('fragmented XMODEM data and a possible NAK echo stop retransmission without ACKs; exact bytes survive export', async () => {
  const { adapter, device, events, record } = await prepare();
  const received = concat(fromHex('1523e1'), block(1));
  device.onTransmit = () => device.enqueue(received);
  const result = await probeSerial(adapter, { ...settings, durationMs: 3000 }, { record }); await adapter.close();
  assert.equal(result.status, 'captured'); assert.equal(result.txCompleted, 1); assert.equal(result.probePausedByRX, true);
  assert.equal(result.rxBeforeProbe, 0); assert.equal(result.rxAfterProbe, received.length);
  assert.equal(result.xmodemCandidates.length, 1); assert.equal(result.xmodemCandidates[0].offset, 3);
  assert.equal(result.xmodemCandidates[0].sequence, 1);
  assert.deepEqual(device.writes.map(write => toHex(write.bytes)), ['55aa010015']);
  const files = new Map(attemptFiles({ kind: 'serial', result }, events).map(file => [file.name, file.data]));
  assert.deepEqual(files.get('usb-in.bin'), received);
  assert.deepEqual(files.get('serial-out-requested.bin'), b(0x15));
  assert.deepEqual(files.get('serial-out-completed.bin'), b(0x15));
  assert.equal(files.get('frames.jsonl').length, 0); assert.equal(files.get('response.bin').length, 0);
  assert.match(new TextDecoder().decode(files.get('README.txt')), /No IrLAP/);
  assert.equal(JSON.parse(new TextDecoder().decode(files.get('attempt.json'))).pendingUSBCalls.length, 0);
});

test('unsolicited bytes before the probe prevent any transmission; unknown bytes are retained', async () => {
  const { adapter, device, events, record } = await prepare();
  const received = fromHex('c1e1230006'); device.enqueue(received);
  const result = await probeSerial(adapter, settings, { record }); await adapter.close();
  assert.equal(result.status, 'captured'); assert.equal(result.rxBeforeProbe, received.length);
  assert.equal(result.rxAfterProbe, 0); assert.equal(result.txAttempts, 0); assert.equal(device.writes.length, 0);
  assert.deepEqual(attemptFiles({ kind: 'serial' }, events).find(file => file.name === 'usb-in.bin').data, received);
});

test('Enter is sent exactly once even when no reply arrives', async () => {
  const { adapter, device, record } = await prepare();
  const result = await probeSerial(adapter, { ...settings, probe: 'cr', durationMs: 3000 }, { record }); await adapter.close();
  assert.equal(result.status, 'no-data'); assert.equal(result.txCompleted, 1);
  assert.deepEqual(device.writes.map(write => toHex(write.bytes)), ['55aa01000d']);
});

test('listen-only blocks bulk OUT and Stop closes a pending read without inventing a reply', async () => {
  const { adapter, device, events, record } = await prepare({ passive: true });
  await assert.rejects(adapter.device.transferOut(1, b(0x15)), /disabled/);
  device.blocked = true;
  const controller = new AbortController();
  const run = probeSerial(adapter, { ...settings, probe: 'listen' }, { record, signal: controller.signal });
  while (!device.pending) await sleep(2);
  controller.abort(); const result = await run; await adapter.close();
  assert.equal(result.status, 'interrupted'); assert.equal(result.txAttempts, 0);
  assert.equal(device.pending, null); assert.equal(device.writes.length, 0);
  assert.ok(events.some(event => event.kind === 'usb-error' && event.operation === 'transferIn'));
});

test('a read that never completes produces probe-not-sent instead of a negative watch response', async () => {
  const { adapter, device, events, record } = await prepare(); device.blocked = true;
  const result = await probeSerial(adapter, settings, { record }); await adapter.close();
  assert.equal(result.status, 'probe-not-sent'); assert.equal(result.txCompleted, 0); assert.equal(result.readCount, 0);
  assert.equal(device.pending, null); assert.equal(device.writes.length, 0);
  assert.equal(JSON.parse(new TextDecoder().decode(attemptFiles({ kind: 'serial' }, events)[0].data)).pendingUSBCalls.length, 0);
});

test('failed and short writes are retained as requests, never as confirmed serial bytes', async () => {
  for (const response of [{ status: 'stall', bytesWritten: 0 }, { status: 'ok', bytesWritten: 4 }]) {
    const { adapter, device, events, record } = await prepare();
    device.transferOut = async () => response;
    const result = await probeSerial(adapter, settings, { record }); await adapter.close();
    assert.equal(result.status, 'error'); assert.equal(result.txAttempts, 1); assert.equal(result.txCompleted, 0);
    assert.match(result.error.message, /USB OUT/);
    const files = new Map(attemptFiles({ kind: 'serial' }, events).map(file => [file.name, file.data]));
    assert.deepEqual(files.get('serial-out-requested.bin'), b(0x15));
    assert.equal(files.get('serial-out-completed.bin').length, 0);
  }
});

test('a pending transmit at the deadline is an error and close cancels it', async () => {
  const { adapter, device, record } = await prepare();
  let cancel;
  device.transferOut = () => new Promise((_, reject) => { cancel = reject; });
  const close = device.close.bind(device);
  device.close = async () => { await close(); cancel?.(new DOMException('Closed', 'AbortError')); };
  const result = await probeSerial(adapter, settings, { record }); await adapter.close();
  assert.equal(result.status, 'error'); assert.equal(result.error.name, 'USBTransmitTimeout'); assert.equal(result.txCompleted, 0);
});

test('a busy FIFO invokes the existing recovery and does not claim a drained transmit', async () => {
  const { adapter, device, events, record } = await prepare(); device.status = 0x10;
  let recovery = 0;
  adapter.abortFIFO = async () => { recovery++; throw new Error('FIFO recovery ended the attempt'); };
  const result = await probeSerial(adapter, settings, { record }); await adapter.close();
  assert.equal(result.status, 'error'); assert.equal(recovery, 1); assert.equal(result.txCompleted, 0);
  assert.ok(events.some(event => event.kind === 'serial-tx-usb-complete'));
  assert.ok(!events.some(event => event.kind === 'serial-tx-complete'));
});

test('XMODEM candidates require sequence complement and a valid 128-byte checksum; truncation and corrupt sums are rejected', () => {
  const valid = block(255), invalid = valid.slice(); invalid[131] ^= 1;
  const badSequence = valid.slice(); badSequence[2] ^= 1;
  assert.deepEqual(xmodemCandidates(concat(invalid, badSequence, valid.slice(0, 131))), []);
  const found = xmodemCandidates(concat(b(0x23), valid, block(0)));
  assert.deepEqual(found.map(item => [item.offset, item.sequence]), [[1, 255], [133, 0]]);
  assert.equal(xmodemCandidates(concat(...Array.from({ length: 40 }, () => block(1)))).length, 32);
});

test('reads completing during close are included in final counters, raw stream and checksum-block detection', () => {
  const received = block(1);
  const events = [{ kind: 'serial-tx-complete', dataHex: '15' }, { kind: 'serial-ending', reason: 'deadline' },
    { kind: 'usb-result', operation: 'transferIn', status: 'ok', data: { hex: toHex(received), byteLength: received.length } }];
  const result = finishSerialCapture({ status: 'no-data', txCompleted: 1, rxBytes: 0 }, events);
  assert.equal(result.status, 'captured'); assert.equal(result.processedWindowRxBytes, 0);
  assert.equal(result.rxBytes, received.length); assert.equal(result.rxAfterProbe, received.length);
  assert.equal(result.readCount, 1); assert.equal(result.xmodemCandidates.length, 1);
  assert.deepEqual(attemptFiles({ kind: 'serial' }, events).find(file => file.name === 'usb-in.bin').data, received);
});
