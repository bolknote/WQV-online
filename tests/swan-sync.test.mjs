import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fromHex, toHex, concat } from '../dist/formats.mjs';
import { captureUSB } from '../dist/research-core.mjs';
import { ManualSerialTrigger, probeSerialPacket } from '../dist/serial-core.mjs';
import { SWAN_SYNC_PLAN, SWAN_REPLAYS, ReplayTiming, canReplayNow, syncConditions, dataBitShiftMatches, signalBursts, analyseSwanSync, swanSyncFiles } from '../dist/swan-sync-core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./swan-signal-fixtures.json', import.meta.url)));
const rx = (hex, elapsedMs = 0) => ({ kind: 'usb-result', operation: 'transferIn', status: 'ok', elapsedMs,
  data: { hex, byteLength: hex.length / 2 } });
test('replay presets retain the exact original SEND/RECEIVE bytes and sources', () => {
  for (const [replayId, source] of [['send-66', 'swan-send'], ['receive-66', 'swan-receive']]) {
    const preset = SWAN_REPLAYS.find(item => item.id === replayId), capture = fixture.captures.find(item => item.id === preset.sourceAttempt);
    assert.equal(preset.hex, capture.rawHex); assert.equal(capture.watchMode, source);
    assert.equal(createHash('sha256').update(fromHex(preset.hex)).digest('hex'), capture.sha256);
    assert.equal(fromHex(preset.hex).length, 66);
  }
  for (const preset of SWAN_REPLAYS.filter(item => !item.sourceAttempt)) {
    assert.ok(fixture.captures.some(capture => capture.rawHex.includes(preset.hex)));
  }
  assert.ok(SWAN_SYNC_PLAN.every(step => step.baud === 9600));
  assert.equal(SWAN_SYNC_PLAN.find(step => step.id === 'replay-receive').replayTrigger, 'receive-mark');
  for (const step of SWAN_SYNC_PLAN) {
    const conditions = syncConditions(step, 'now');
    assert.equal(conditions.watchMode, step.watchPresent ? step.watchMode : null);
    assert.equal(conditions.opticalPath, step.watchPresent ? 'open' : 'watch-removed');
  }
});

test('the three physical captures produce 22 idle-separated bursts independent of USB fragmentation', () => {
  for (const capture of fixture.captures) {
    const events = capture.dataBearingUSBReads.map(c => rx(c.dataHex, c.elapsedMs)), original = structuredClone(events);
    const a = analyseSwanSync(events);
    assert.equal(a.rxBytes, 66); assert.equal(a.groupedBursts.length, 22);
    assert.ok(a.groupedBursts.every(group => group.bytes === 3));
    assert.equal(a.variants.reduce((sum, item) => sum + item.count, 0), 22);
    assert.equal(a.variants.find(item => item.hex === '7a06f0').count, capture.watchMode === 'swan-send' ? 17 : capture.id.startsWith('abae') ? 20 : 18);
    assert.equal(a.bulkOutCalls, 0); assert.equal(a.usbWriteCompleted, false);
    assert.deepEqual(events, original);
  }
  // A gap makes separate bursts even if concatenating them would make a triple.
  assert.equal(signalBursts([{ offset: 0, elapsedMs: 1, dataHex: '7a', bytes: 1 }, { offset: 1, elapsedMs: 100, dataHex: '06f0', bytes: 2 }]).length, 2);
});

test('bit-shift annotations do not claim UART recovery and never modify the data', () => {
  const bytes = fromHex('3d03f8'), original = bytes.slice();
  assert.deepEqual(dataBitShiftMatches(bytes), [{ shift: -1, fill: 1 }]);
  assert.deepEqual(dataBitShiftMatches(fromHex('7a06f0')), [{ shift: 0, fill: null }]);
  assert.deepEqual(dataBitShiftMatches(fromHex('f518c0')), []);
  assert.deepEqual(dataBitShiftMatches(fromHex('7b06f0')), []);
  assert.deepEqual(bytes, original);
});

test('photo selection, changes, transmission and optical path remain separate reported stages', () => {
  const events = [{ kind: 'physical-conditions-confirmed', opticalPath: 'open', elapsedMs: 0 },
    { kind: 'watch-send-mark', stage: 'image-selection', elapsedMs: 10 }, rx('01', 11),
    { kind: 'watch-picture-mark', changeNumber: 1, elapsedMs: 20 }, rx('02', 21),
    { kind: 'watch-send-mark', stage: 'transmitting', elapsedMs: 30 }, rx('7a06f0', 31),
    { kind: 'sync-path-mark', path: 'covered', elapsedMs: 50 }, rx('ff', 51),
    { kind: 'sync-path-mark', path: 'open', elapsedMs: 80 }, rx('7a06f0', 81),
    { kind: 'listen-finished', elapsedMs: 100 }];
  const a = analyseSwanSync(events);
  assert.equal(a.buttonPressCount, 2); assert.equal(a.pictureChangeCount, 1);
  assert.deepEqual(a.selectionPhasesByUSBCompletion.map(p => [p.stage, p.rxBytes]),
    [['before-first-mark', 0], ['image-selection', 1], ['image-selection', 1], ['transmitting', 7]]);
  assert.deepEqual(a.opticalPhasesByUSBCompletion.map(p => [p.path, p.rxBytes]), [['open', 5], ['covered', 1], ['open', 3]]);
});

test('late and failed-read bytes, pending USB calls and planned-only TX survive export', () => {
  const attempt = { kind: 'serial', format: 'wqv-swan-sync-v1', probeHex: '7a06f0', replay: { timing: 'contiguous-no-original-pauses' } };
  const events = [rx('7a06f0'), { kind: 'serial-tx-attempt', dataHex: attempt.probeHex },
    { kind: 'usb-call', id: 1, operation: 'transferOut', args: [1, { hex: '55aa03007a06f0' }] },
    { kind: 'usb-result', id: 1, operation: 'transferOut', status: 'stall' },
    { kind: 'serial-finished' }, { ...rx('3d03f8'), status: 'stall' },
    { kind: 'usb-call', id: 2, operation: 'transferIn' }];
  const files = new Map(swanSyncFiles(attempt, events).map(file => [file.name, file.data]));
  const json = name => JSON.parse(new TextDecoder().decode(files.get(name)));
  assert.equal(toHex(files.get('usb-in.bin')), '7a06f03d03f8');
  assert.equal(toHex(files.get('replay-planned.bin')), '7a06f0');
  assert.equal(toHex(files.get('serial-out-requested.bin')), '7a06f0');
  assert.equal(files.get('serial-out-completed.bin').length, 0);
  assert.deepEqual(json('analysis.json').exactMatchesAfterUSBWrite, []);
  assert.deepEqual(json('analysis.json').pendingUSBCalls, [2]);
  assert.equal(json('analysis.json').failedReads, 1);
});

test('RX matches before a successful USB write are not marked possible echo', () => {
  const events = [rx('7a06f0'), { kind: 'serial-tx-usb-complete', dataHex: '7a06f0' }, rx('7a06f0'), { kind: 'serial-tx-complete', dataHex: '7a06f0' }];
  const a = analyseSwanSync(events, '7a06f0');
  assert.equal(a.usbWriteCompleted, true); assert.equal(a.fifoDrainCompleted, true);
  assert.deepEqual(a.exactMatchesAfterUSBWrite, [{ offset: 3, bytes: 3, possibleEcho: true }]);
});

test('a silent watch never blocks manual replay; queued, used and closed triggers do', () => {
  const base = { running: true, transmit: true, triggerState: 'waiting' };
  assert.equal(canReplayNow({ ...base, rxBytes: 0 }), true);
  for (const change of [{ running: false }, { transmit: false }, { broken: true },
    { mode: 'rx' }, { mode: 'start' },
    ...['inactive', 'queued', 'used', 'closed'].map(triggerState => ({ triggerState }))]) {
    assert.equal(canReplayNow({ ...base, ...change }), false);
  }
});

test('a manual button cannot pre-empt the selected RX timing before any bytes arrive', () => {
  const trigger = new ManualSerialTrigger(); trigger.arm();
  const requests = [], timing = new ReplayTiming(trigger, 'rx', source => requests.push(source));
  assert.equal(timing.request('send-button'), false);
  assert.equal(trigger.state, 'waiting'); assert.deepEqual(requests, []); timing.close();
  const manual = new ReplayTiming(trigger, 'manual', source => requests.push(source));
  assert.equal(manual.request('send-button'), true);
  assert.deepEqual(requests, ['send-button']); manual.close();
});

test('the RECEIVE mark sends once only in its dedicated timing mode, even with no RX', () => {
  const trigger = new ManualSerialTrigger(), requests = []; trigger.arm();
  const timing = new ReplayTiming(trigger, 'receive-mark', source => requests.push(source));
  timing.start(); timing.received();
  assert.equal(trigger.state, 'waiting'); assert.deepEqual(requests, []);
  assert.equal(timing.request('send-button'), false);
  assert.equal(timing.receiveMark(), true); assert.equal(timing.receiveMark(), false);
  assert.deepEqual(requests, ['watch-receive-mark']); timing.close();
  for (const mode of ['start', 'rx', 'manual']) {
    const other = new ManualSerialTrigger(); other.arm();
    const schedule = new ReplayTiming(other, mode);
    assert.equal(schedule.receiveMark(), false);
    assert.equal(schedule.request('watch-receive-mark'), false);
    assert.equal(other.state, 'waiting'); schedule.close();
  }
  const closedTrigger = new ManualSerialTrigger(); closedTrigger.arm();
  const closed = new ReplayTiming(closedTrigger, 'receive-mark'); closed.close();
  assert.equal(closed.receiveMark(), false); assert.equal(closedTrigger.state, 'waiting');
});

test('the hardware replay sent before the first RX is not described as an RX-triggered response', () => {
  const events = [
    { kind: 'serial-manual-send-request', source: 'send-button', replayTrigger: 'rx', elapsedMs: 23842.90000000596 },
    { kind: 'serial-tx-usb-complete', dataHex: '7a06f0', elapsedMs: 23849.30000001192 },
    { kind: 'serial-tx-complete', dataHex: '7a06f0', elapsedMs: 23851.30000001192 },
    rx('7a06', 28171.30000001192), rx('f0', 28173.80000001192),
  ];
  const a = analyseSwanSync(events, '7a06f0');
  assert.equal(a.replayRequestSource, 'send-button'); assert.equal(a.rxBytesBeforeUSBWrite, 0);
  assert.equal(a.firstRXmsAfterUSBWrite, 4322);
});

test('RX scheduling waits for an idle gap between fragmented reads, sends once and cancels on close', async () => {
  const trigger = new ManualSerialTrigger(), requests = [];
  trigger.arm(); const timing = new ReplayTiming(trigger, 'rx', source => requests.push(source), 5);
  timing.start(); assert.deepEqual(requests, []);
  timing.received(); timing.received();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(requests, ['rx-quiet-window']); assert.equal(trigger.state, 'queued');
  timing.received(); timing.start(); assert.equal(timing.request('send-button'), false);
  timing.close();
  const another = new ManualSerialTrigger(); another.arm();
  const cancelled = new ReplayTiming(another, 'rx', source => requests.push(source), 5);
  cancelled.received(); cancelled.close();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(requests.length, 1); assert.equal(another.state, 'waiting');
});

for (const mode of ['start', 'rx', 'receive-mark']) test(`${mode} timing sends one raw replay ${mode === 'rx' ? 'after fragmented RX' : 'to a silent peer'}`, async () => {
  const events = [], writes = [], queue = mode === 'rx' ? [fromHex('7a'), fromHex('06f0')] : [];
  const controller = new AbortController(), trigger = new ManualSerialTrigger();
  let adapter, timing;
  const record = (kind, details = {}) => {
    events.push({ kind, ...details });
    if (kind === 'serial-start') timing.start();
    if (kind === 'serial-rx') timing.received();
    if (kind === 'serial-tx-complete') queueMicrotask(() => controller.abort());
    if (kind === 'serial-finished') timing.close();
  };
  timing = new ReplayTiming(trigger, mode, source => record('serial-manual-send-request', { source, dataHex: '7a06f0' }), 5);
  const device = { opened: true,
    async transferIn() { await new Promise(resolve => setTimeout(resolve, 2)); const bytes = queue.shift() ?? new Uint8Array(); return { status: 'ok', data: new DataView(bytes.buffer) }; },
    async transferOut(endpoint, packet) { assert.equal(adapter.readPending, false); writes.push(packet.slice()); return { status: 'ok', bytesWritten: packet.length }; },
    async close() { this.opened = false; },
  };
  adapter = { baud: 9600, configured: true, readerTask: null, readPending: false, rxBytes: 0, opened: true,
    device: captureUSB(device, record), assertOpen() { if (!this.opened) throw new Error('Closed'); },
    io: promise => promise, registers: async () => [0, 0, 0], close: async () => { adapter.opened = false; await adapter.device.close(); } };
  const recording = probeSerialPacket(adapter, { bytes: fromHex('7a06f0'), watchMode: 'swan-receive', durationMs: 2000 }, { record, signal: controller.signal, manualTrigger: trigger });
  if (mode === 'receive-mark') {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes.length, 0);
    record('watch-receive-mark', { markerSource: 'page-click' });
    assert.equal(timing.receiveMark(), true); assert.equal(timing.receiveMark(), false);
  }
  const result = await recording;
  await adapter.close();
  assert.deepEqual(writes, [fromHex('55aa03007a06f0')]);
  assert.equal(result.txCompleted, 1); assert.equal(result.rxBeforeProbe, mode === 'rx' ? 3 : 0);
  assert.equal(events.filter(event => event.kind === 'serial-manual-send-request').length, 1);
  if (mode === 'receive-mark') {
    assert.equal(events.find(event => event.kind === 'serial-manual-send-request').source, 'watch-receive-mark');
    assert.ok(events.findIndex(event => event.kind === 'watch-receive-mark') < events.findIndex(event => event.kind === 'serial-tx-usb-complete'));
  }
  assert.equal(timing.request('send-button'), false);
});

test('the manual replay sends exactly the observed bytes once through raw SIR, after early RX', async () => {
  const events = [], writes = [], queue = [fromHex('7a'), fromHex('06f0')], controller = new AbortController();
  const trigger = new ManualSerialTrigger();
  let adapter;
  const record = (kind, details = {}) => {
    events.push({ kind, ...details });
    if (kind === 'serial-rx' && details.afterProbe) queueMicrotask(() => controller.abort());
  };
  const device = { opened: true,
    async transferIn() { await new Promise(resolve => setTimeout(resolve, 2)); const bytes = queue.shift() ?? new Uint8Array(); return { status: 'ok', data: new DataView(bytes.buffer) }; },
    async transferOut(endpoint, packet) { writes.push(packet.slice()); queue.push(fromHex('3d03f8')); return { status: 'ok', bytesWritten: packet.length }; },
    async close() { this.opened = false; },
  };
  adapter = { baud: 9600, configured: true, readerTask: null, readPending: false, rxBytes: 0, opened: true,
    device: captureUSB(device, record), assertOpen() { if (!this.opened) throw new Error('Closed'); },
    io: promise => promise, registers: async () => [0, 0, 0], close: async () => { adapter.opened = false; await adapter.device.close(); } };
  const recording = probeSerialPacket(adapter, { bytes: fromHex(SWAN_REPLAYS[0].hex), watchMode: 'swan-receive', durationMs: 2000 }, { record, signal: controller.signal, manualTrigger: trigger });
  while (adapter.serialStats.rxBytes < 3) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes.length, 0); assert.equal(trigger.request(), true); assert.equal(trigger.request(), false);
  const result = await recording; await adapter.close();
  assert.equal(result.txCompleted, 1); assert.equal(result.txSerialBytes, 3);
  assert.deepEqual(writes, [fromHex('55aa03007a06f0')]);
  const files = new Map(swanSyncFiles({ kind: 'serial', probeHex: '7a06f0' }, events).map(file => [file.name, file.data]));
  assert.deepEqual(files.get('usb-in.bin'), concat(fromHex('7a06f0'), fromHex('3d03f8')));
  assert.equal(toHex(files.get('serial-out-completed.bin')), '7a06f0');
  assert.equal(trigger.request(), false);
});
