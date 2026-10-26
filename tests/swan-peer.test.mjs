import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { captureUSB } from '../dist/research-core.mjs';
import { fromHex, toHex } from '../dist/formats.mjs';
import { PEER_CADENCE, SWAN_PEER_PLAN, SWAN_PEER_VARIANT_PLAN, makePeerPayloadPlan, PeerSeries, PeerSeriesTrigger, replayPeer, swanPeerFiles } from '../dist/swan-peer-core.mjs';

test('the series preserves the original 22-burst USB cadence at fixed 9600/RX8', () => {
  const f = JSON.parse(readFileSync(new URL('./swan-peer-cadence-fixture.json', import.meta.url)));
  assert.equal(PEER_CADENCE.sourceAttempt, f.sourceAttempt);
  assert.equal(PEER_CADENCE.sourceArchiveSHA256, f.sourceArchiveSHA256);
  assert.deepEqual(PEER_CADENCE.offsetsMs, f.firstDataUSBCompletionMs.map(ms => Math.round((ms - f.firstDataUSBCompletionMs[0]) * 10) / 10));
  assert.equal(PEER_CADENCE.offsetsMs.length, 22); assert.equal(PEER_CADENCE.payloadHex, '7a06f0');
  for (const step of SWAN_PEER_PLAN) {
    assert.equal(step.baud, 9600); assert.equal(step.rxSensitivity, 1); assert.equal(step.watchMode, 'swan-receive');
    assert.equal(step.replayTrigger, 'receive-mark');
  }
});

test('a series starts once, uses absolute deadlines and skips late repeats without catch-up bursts', () => {
  const series = new PeerSeries([0, 500, 1000]);
  assert.equal(series.due(100), false); assert.equal(series.start(100), true); assert.equal(series.start(200), false);
  assert.equal(series.received(), false);
  const first = series.take(103); assert.equal(first.repetition, 1); first.state = 'fifo-complete'; first.usbCompleted = true;
  assert.equal(series.due(599), false);
  assert.equal(series.take(800).state, 'skipped-late');
  assert.equal(series.due(801), false);
  assert.equal(series.take(1100).state, 'requested');
  assert.equal(series.summary().skipped, 1); assert.equal(series.take(2000), null);
  assert.equal(series.received(), true); assert.equal(series.due(3000), false);
});

function hardware({ responseAfter = null, beforeMark = false, failWrite = false, mark = true, delayMarkReadMs = 0 } = {}) {
  let time = 0, writes = 0, readCount = 0;
  const events = [], packets = [], queue = beforeMark ? [fromHex('aa')] : [];
  const trigger = new PeerSeriesTrigger(() => time);
  let adapter;
  const record = (kind, data = {}) => events.push({ kind, ...data, elapsedMs: time });
  const device = { vendorId: 0x066f, productId: 0x4200, opened: true,
    async transferIn() {
      assert.equal(adapter.readPending, true); time += 5; readCount++;
      if (readCount === 3 && mark) { trigger.request(); time += delayMarkReadMs; }
      const bytes = queue.shift() ?? new Uint8Array();
      return { status: 'ok', data: new DataView(bytes.buffer) };
    },
    async transferOut(endpoint, packet) {
      assert.equal(adapter.readPending, false); writes++; packets.push(packet.slice());
      if (responseAfter === writes) queue.push(fromHex('7a'), fromHex('06f0'));
      return { status: failWrite ? 'stall' : 'ok', bytesWritten: failWrite ? 0 : packet.length };
    },
    async controlTransferIn(request, count) {
      assert.equal(adapter.readPending, false); assert.equal(request.index, 5); assert.equal(count, 3);
      return { status: 'ok', data: new DataView(Uint8Array.from([4, 0, 0]).buffer) };
    },
    async close() { this.opened = false; },
  };
  adapter = new SigmaTel(captureUSB(device, record));
  Object.assign(adapter, { claimed: true, configured: true, baud: 9600, inEndpoint: 2, outEndpoint: 1 });
  return { adapter, trigger, record, events, packets, now: () => time };
}

test('one RECEIVE mark sends exactly 22 separate triples with the captured gaps and retains their raw TX', async () => {
  const h = hardware();
  const result = await replayPeer(h.adapter, { durationMs: 20000 }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.status, 'no-data'); assert.equal(result.series.fifoCompleted, 22); assert.equal(result.series.skipped, 0);
  assert.equal(h.packets.length, 22); assert.ok(h.packets.every(p => toHex(p) === '55aa03007a06f0'));
  const entries = result.series.entries;
  assert.ok(entries.every(e => e.lateMs >= 0 && e.lateMs <= 5));
  assert.ok(entries.at(-1).requestedOffsetMs >= 14306.8);
  assert.equal(h.trigger.request(), false);
  const files = new Map(swanPeerFiles({ kind: 'serial', probeHex: '7a06f0', result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('serial-out-completed.bin')), '7a06f0'.repeat(22));
  assert.equal(files.get('replay-planned.bin').length, 66);
  assert.equal(JSON.parse(new TextDecoder().decode(files.get('peer-series.json'))).result.fifoCompleted, 22);
});

test('Start alone never transmits, even if bytes arrive before the RECEIVE mark', async () => {
  const h = hardware({ mark: false, beforeMark: true });
  const result = await replayPeer(h.adapter, { durationMs: 2000 }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.status, 'probe-not-sent'); assert.equal(result.rxBeforeProbe, 1);
  assert.equal(h.packets.length, 0); assert.equal(result.series.started, false);
});

test('RX before the mark is preserved; fragmented RX after TX pauses the series without echo removal', async () => {
  const h = hardware({ beforeMark: true, responseAfter: 3 });
  const result = await replayPeer(h.adapter, { durationMs: 2000 }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.status, 'captured'); assert.equal(result.series.fifoCompleted, 3); assert.equal(result.series.pausedByRX, true);
  assert.equal(result.rxBeforeProbe, 1); assert.equal(result.rxAfterProbe, 3); assert.equal(h.packets.length, 3);
  const files = new Map(swanPeerFiles({ kind: 'serial', probeHex: '7a06f0', result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('usb-in.bin')), 'aa7a06f0');
});

test('a delayed pending read cannot shift the entire series forward or cause catch-up writes', async () => {
  const h = hardware({ delayMarkReadMs: 800 });
  const result = await replayPeer(h.adapter, { durationMs: 2500 }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.status, 'series-incomplete'); assert.equal(result.series.entries[0].state, 'skipped-late');
  assert.ok(result.series.skipped >= 2);
  assert.ok(result.series.entries.filter(e => e.state === 'fifo-complete').every(e => e.lateMs <= 120));
  assert.equal(h.events.find(e => e.kind === 'peer-series-triggered').waitingForUSBms, 800);
});

test('a failed write is recorded once, stops the series and never becomes confirmed output', async () => {
  const h = hardware({ failWrite: true });
  const result = await replayPeer(h.adapter, { durationMs: 2000 }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.status, 'error'); assert.equal(h.packets.length, 1);
  assert.equal(result.series.fifoCompleted, 0);
  const files = new Map(swanPeerFiles({ kind: 'serial', probeHex: '7a06f0', result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('serial-out-requested.bin')), '7a06f0'); assert.equal(files.get('serial-out-completed.bin').length, 0);
});

test('Stop cancels a queued series behind a pending read and preserves its late USB result', async () => {
  const h = hardware({ mark: false }), controller = new AbortController(); let resolveRead;
  const stalled = { vendorId: 0x066f, productId: 0x4200, opened: true,
    transferIn: () => new Promise(resolve => { resolveRead = resolve; h.trigger.request(); queueMicrotask(() => controller.abort()); }),
    async close() { this.opened = false; resolveRead?.({ status: 'ok', data: new DataView(fromHex('ff').buffer) }); },
  };
  h.adapter.device = captureUSB(stalled, h.record);
  const result = await replayPeer(h.adapter, { durationMs: 2000 }, { manualTrigger: h.trigger, signal: controller.signal, record: h.record });
  await h.adapter.close(); await Promise.resolve();
  assert.equal(result.status, 'interrupted'); assert.equal(result.series.requested, 0);
  const files = new Map(swanPeerFiles({ kind: 'serial', probeHex: '7a06f0', result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('usb-in.bin')), 'ff');
});

function deterministicRandom() {
  let next = 0;
  return bytes => { for (let i = 0; i < bytes.length; i++) bytes[i] = next++ & 255; };
}

test('the five variant steps change payload only, with independent 0..255 bytes for each random slot', () => {
  assert.equal(SWAN_PEER_VARIANT_PLAN.length, 5);
  assert.ok(SWAN_PEER_VARIANT_PLAN.every(step => step.baud === 9600 && step.rxSensitivity === 1 && step.pulseWidth === 'short' && step.watchMode === 'swan-receive'));
  assert.deepEqual(makePeerPayloadPlan('reverse-bytes').packetsHex, Array(22).fill('f0067a'));
  const reversedBits = makePeerPayloadPlan('reverse-bits');
  assert.deepEqual(reversedBits.packetsHex, Array(22).fill('5e600f'));
  assert.equal(reversedBits.bitReversal, 'within-each-8-bit-byte');
  for (const [strategy, expected] of [['reverse-bytes-inverted', '0ff985'], ['reverse-bits-inverted', 'a19ff0']]) {
    const inverted = makePeerPayloadPlan(strategy);
    assert.deepEqual(inverted.packetsHex, Array(22).fill(expected));
    assert.equal(inverted.bitInversion, 'xor-ff-within-each-8-bit-byte');
    assert.equal(inverted.bitReversal, strategy === 'reverse-bits-inverted' ? 'within-each-8-bit-byte' : null);
  }
  const fillRandom = deterministicRandom(), random = makePeerPayloadPlan('random', { fillRandom });
  assert.deepEqual(random.packetsHex.slice(0, 3), ['000102', '030405', '060708']);
  assert.equal(random.packetsHex.at(-1), '3f4041');
  assert.equal(makePeerPayloadPlan('random', { fillRandom }).packetsHex[0], '424344');
  assert.throws(() => random.packetsHex.push('ffffff'), TypeError);
  const extreme = makePeerPayloadPlan('random', { count: 1, fillRandom: bytes => bytes.set([0, 128, 255]) });
  assert.equal(extreme.packetsHex[0], '0080ff');
});

for (const [strategy, fixed] of [['reverse-bytes', 'f0067a'], ['reverse-bits', '5e600f'], ['random', null], ['reverse-bytes-inverted', '0ff985'], ['reverse-bits-inverted', 'a19ff0']]) {
  test(`${strategy}: exact prepared triples reach USB without IrLAP framing and survive repeatable export`, async () => {
    const h = hardware(), payloadPlan = makePeerPayloadPlan(strategy, { fillRandom: deterministicRandom() });
    const result = await replayPeer(h.adapter, { durationMs: 20000, payloadPlan }, { manualTrigger: h.trigger, record: h.record, now: h.now });
    await h.adapter.close();
    assert.equal(result.status, 'no-data'); assert.equal(result.series.fifoCompleted, 22);
    assert.deepEqual(h.packets.map(p => toHex(p)), payloadPlan.packetsHex.map(hex => `55aa0300${hex}`));
    if (fixed) assert.ok(h.packets.every(p => toHex(p) === `55aa0300${fixed}`));
    assert.deepEqual(result.series.entries.map(entry => entry.dataHex), payloadPlan.packetsHex);
    assert.deepEqual(h.events.find(e => e.kind === 'serial-start').payloadPlan, payloadPlan);
    const attempt = { kind: 'serial', format: 'wqv-swan-peer-v2', peerPayloadPlan: payloadPlan, result };
    const first = new Map(swanPeerFiles(attempt, h.events).map(f => [f.name, f.data]));
    const second = new Map(swanPeerFiles(attempt, h.events).map(f => [f.name, f.data]));
    assert.equal(toHex(first.get('replay-planned.bin')), payloadPlan.packetsHex.join(''));
    assert.equal(toHex(first.get('serial-out-requested.bin')), payloadPlan.packetsHex.join(''));
    assert.equal(toHex(first.get('serial-out-completed.bin')), payloadPlan.packetsHex.join(''));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(first.get('payload-plan.json'))), payloadPlan);
    for (const [name, data] of first) assert.deepEqual(data, second.get(name), `Export regenerated ${name}`);
  });
}

test('random RX after the third slot pauses TX but retains the entire 22-slot plan and untouched RX', async () => {
  const h = hardware({ responseAfter: 3 }), payloadPlan = makePeerPayloadPlan('random', { fillRandom: deterministicRandom() });
  const result = await replayPeer(h.adapter, { durationMs: 2000, payloadPlan }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.series.pausedByRX, true); assert.equal(h.packets.length, 3);
  const files = new Map(swanPeerFiles({ kind: 'serial', format: 'wqv-swan-peer-v2', peerPayloadPlan: payloadPlan, result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('serial-out-completed.bin')), '000102030405060708');
  assert.equal(toHex(files.get('usb-in.bin')), '7a06f0');
  assert.equal(files.get('replay-planned.bin').length, 66);
});

test('late random slots retain their assigned triples instead of shifting bytes to the next slot', async () => {
  const h = hardware({ delayMarkReadMs: 800 }), payloadPlan = makePeerPayloadPlan('random', { fillRandom: deterministicRandom() });
  const result = await replayPeer(h.adapter, { durationMs: 2000, payloadPlan }, { manualTrigger: h.trigger, record: h.record, now: h.now });
  await h.adapter.close();
  assert.equal(result.series.entries[0].state, 'skipped-late');
  assert.equal(result.series.entries[0].dataHex, '000102');
  assert.equal(result.series.entries[1].state, 'skipped-late');
  assert.equal(toHex(h.packets[0]), '55aa0300060708');
});

test('invalid plans cannot start USB traffic and missing variant plans cannot invent export bytes', async () => {
  const h = hardware(), valid = makePeerPayloadPlan('reverse-bits');
  const malformed = [
    { ...valid, packetsHex: ['7a06f0', ...valid.packetsHex.slice(1)] },
    { ...valid, packetsHex: valid.packetsHex.slice(1) },
    { ...valid, strategy: 'unknown' },
    { ...valid, packetsHex: [null, ...valid.packetsHex.slice(1)] },
  ];
  for (const payloadPlan of malformed) await assert.rejects(replayPeer(h.adapter, { durationMs: 2000, payloadPlan }, { manualTrigger: h.trigger }));
  assert.equal(h.events.length, 0); assert.equal(h.packets.length, 0);
  assert.throws(() => swanPeerFiles({ kind: 'serial', format: 'wqv-swan-peer-v2' }, []), /Missing recorded payload plan/);
  await h.adapter.close();
});
