import test from 'node:test';
import assert from 'node:assert/strict';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { captureUSB } from '../dist/research-core.mjs';
import { fromHex, toHex } from '../dist/formats.mjs';
import { listen } from '../dist/listen-core.mjs';
import { ManualSerialTrigger, probeSerialPacket } from '../dist/serial-core.mjs';
import { ReplayTiming, analyseSwanSync } from '../dist/swan-sync-core.mjs';
import { SWAN_PHYSICAL_PLAN, physicalSettings, applySwanPhysical, physicalConditions, swanPhysicalFiles } from '../dist/swan-physical-core.mjs';

function hardware({ receiveOnly = false, ignoreWrites = false, queue = [], onRead = () => {} } = {}) {
  const registers = new Uint8Array(16), writes = [], packets = [], events = [];
  registers[1] = 0x2a; registers[2] = 0x77; registers[4] = 0x27; registers[5] = 4; registers[8] = 0x15;
  const record = (kind, data = {}) => events.push({ kind, ...data });
  let adapter;
  const device = { vendorId: 0x066f, productId: 0x4200, opened: true,
    async controlTransferIn(request, count) {
      assert.equal(request.request, 1);
      return { status: 'ok', data: new DataView(registers.slice(request.index, request.index + count).buffer) };
    },
    async controlTransferOut(request) {
      assert.equal(request.request, 3); writes.push([request.index, request.value]);
      if (!ignoreWrites) registers[request.index] = request.index === 4 ? request.value & 0xe8 | registers[4] & 7 : request.value;
      return { status: 'ok' };
    },
    async transferIn() {
      await new Promise(resolve => setTimeout(resolve, 2));
      const bytes = queue.shift() ?? new Uint8Array();
      onRead(bytes); return { status: 'ok', data: new DataView(bytes.buffer) };
    },
    async transferOut(endpoint, packet) {
      assert.equal(adapter.readPending, false); packets.push(packet.slice());
      return { status: 'ok', bytesWritten: packet.length };
    },
    async close() { this.opened = false; },
  };
  adapter = new SigmaTel(captureUSB(device, record, () => ({}), { receiveOnly }));
  Object.assign(adapter, { claimed: true, configured: true, baud: 9600, inEndpoint: 2, outEndpoint: 1 });
  return { adapter, registers, writes, packets, events, record };
}

test('the plan compares TX first, then RX, with one changed parameter per phase', () => {
  const [short, long, ...receiver] = SWAN_PHYSICAL_PLAN;
  assert.deepEqual([physicalSettings(short).sensitivityRegister, physicalSettings(long).sensitivityRegister], [0x20, 0x28]);
  assert.equal(physicalSettings(long).txPulseUs, 19.53125);
  for (const step of [short, long]) {
    assert.equal(step.probeHex, '7a06f0'); assert.equal(step.replayTrigger, 'rx'); assert.equal(step.postRxQuietMs, 12);
    assert.equal(step.rxSensitivity, 1); assert.equal(step.transmit, true);
  }
  assert.deepEqual(receiver.map(step => physicalSettings(step).rxSamples), [8, 4, 12, 16, 20, 24, 28]);
  for (const step of receiver) { assert.equal(step.transmit, false); assert.equal(step.pulseWidth, 'short'); }
  for (const step of SWAN_PHYSICAL_PLAN) {
    assert.equal(step.baud, 9600); assert.equal(step.watchMode, 'swan-send'); assert.equal(step.seconds, 45);
    assert.equal(physicalConditions(step, 'now').samePhotoAndPlacement, true);
  }
  assert.throws(() => physicalSettings({ pulseWidth: 'short', rxSensitivity: 7 }), RangeError);
  assert.throws(() => physicalSettings({ pulseWidth: 'short', rxSensitivity: -1 }), RangeError);
  assert.throws(() => physicalSettings({ pulseWidth: 'short', rxSensitivity: 1.5 }), RangeError);
  assert.throws(() => physicalSettings({ pulseWidth: 'unknown', rxSensitivity: 1 }), RangeError);
});

test('each profile writes only register 4 and verifies a readback containing read-only chip ID bits', async () => {
  for (const step of SWAN_PHYSICAL_PLAN) {
    const h = hardware({ receiveOnly: !step.transmit }), before = h.registers.slice();
    const result = await applySwanPhysical(h.adapter, step, { record: h.record });
    const expected = physicalSettings(step).sensitivityRegister;
    assert.deepEqual(h.writes, [[4, expected]]); assert.equal(result.verified, true);
    assert.equal(result.before.sensitivity, 0x27); assert.equal(result.after.sensitivity, expected | 7);
    assert.equal(toHex(fromHex(result.after.rawHex)), toHex(h.registers.slice(1, 10)));
    for (let i = 0; i < 16; i++) if (i !== 4) assert.equal(h.registers[i], before[i]);
    assert.equal(h.packets.length, 0);
    assert.equal(h.events.filter(event => event.kind === 'usb-result' && event.operation === 'controlTransferIn').length, 2);
    await h.adapter.close();
  }
});

test('ignored settings, wrong clock, wrong polarity and an active reader cannot arm a comparison', async () => {
  const ignored = hardware({ ignoreWrites: true });
  await assert.rejects(applySwanPhysical(ignored.adapter, SWAN_PHYSICAL_PLAN[1], { record: ignored.record }), /readback/);
  assert.equal(ignored.events.find(event => event.kind === 'physical-settings-applied').verified, false);
  for (const [index, value] of [[1, 0xaa], [2, 0x1d], [3, 0x40], [9, 0x80]]) {
    const h = hardware(); h.registers[index] = value;
    await assert.rejects(applySwanPhysical(h.adapter, SWAN_PHYSICAL_PLAN[0]), /Unexpected/);
    assert.deepEqual(h.writes, []);
  }
  for (const changes of [{ baud: 38400 }, { readPending: true }, { readerTask: Promise.resolve() }]) {
    const h = hardware(); Object.assign(h.adapter, changes);
    await assert.rejects(applySwanPhysical(h.adapter, SWAN_PHYSICAL_PLAN[0]), /idle/);
    assert.deepEqual(h.events, []);
  }
});

for (const step of SWAN_PHYSICAL_PLAN.slice(0, 2)) test(`${step.id} keeps the reply bytes and RX trigger unchanged`, async () => {
  const h = hardware({ queue: [fromHex('7a06'), fromHex('f0')] });
  await applySwanPhysical(h.adapter, step, { record: h.record });
  const trigger = new ManualSerialTrigger(), controller = new AbortController();
  const timing = new ReplayTiming(trigger, step.replayTrigger, source => h.record('serial-manual-send-request', { source, dataHex: step.probeHex }), step.postRxQuietMs);
  const result = await probeSerialPacket(h.adapter, { bytes: fromHex(step.probeHex), watchMode: step.watchMode, durationMs: 2000 }, {
    manualTrigger: trigger, signal: controller.signal,
    record(kind, details) {
      h.record(kind, details);
      if (kind === 'serial-start') { assert.equal(h.packets.length, 0); timing.start(); }
      if (kind === 'serial-rx') timing.received();
      if (kind === 'serial-tx-complete') { timing.received(); queueMicrotask(() => controller.abort()); }
      if (kind === 'serial-finished') timing.close();
    },
  });
  await h.adapter.close();
  assert.equal(result.txCompleted, 1); assert.equal(result.rxBeforeProbe, 3);
  assert.deepEqual(h.packets, [fromHex('55aa03007a06f0')]);
  assert.equal(h.events.find(event => event.kind === 'serial-manual-send-request').source, 'rx-quiet-window');
  assert.equal(h.registers[4] & 0xf8, physicalSettings(step).sensitivityRegister);
});

test('receiver comparisons stay passive and retain every delivered byte in their export', async () => {
  const controller = new AbortController(); let count = 0;
  const h = hardware({ receiveOnly: true, queue: [fromHex('7a06f0'), fromHex('3d03f8')],
    onRead: () => { if (++count === 2) queueMicrotask(() => controller.abort()); } });
  const step = SWAN_PHYSICAL_PLAN.at(-1);
  const settings = await applySwanPhysical(h.adapter, step, { record: h.record });
  await listen(h.adapter, { baud: 9600, watchMode: step.watchMode, durationMs: 2000 }, { record: h.record, signal: controller.signal });
  await h.adapter.close();
  assert.equal(analyseSwanSync(h.events).bulkOutCalls, 0); assert.deepEqual(h.packets, []);
  const attempt = { kind: 'listen', format: 'wqv-swan-physical-v1', physicalPhase: step.phase, physicalSettings: settings };
  const files = new Map(swanPhysicalFiles(attempt, h.events).map(file => [file.name, file.data]));
  assert.equal(toHex(files.get('usb-in.bin')), '7a06f03d03f8');
  const exportedSettings = JSON.parse(new TextDecoder().decode(files.get('settings.json')));
  assert.equal(exportedSettings.settings.verified, true); assert.equal(exportedSettings.settings.after.sensitivity, 0xc7);
  assert.equal(files.get('replay-planned.bin').length, 0);
  assert.equal(new TextDecoder().decode(files.get('events.jsonl')).trim().split('\n').length, h.events.length);
});

test('a failed readback remains in the raw archive and is not exported as verified', async () => {
  const h = hardware({ ignoreWrites: true }), step = SWAN_PHYSICAL_PLAN[1];
  await assert.rejects(applySwanPhysical(h.adapter, step, { record: h.record }));
  const files = new Map(swanPhysicalFiles({ kind: 'serial', physicalPhase: 'pulse',
    physicalSettings: { requested: physicalSettings(step), verified: false } }, h.events).map(file => [file.name, file.data]));
  const settings = JSON.parse(new TextDecoder().decode(files.get('settings.json')));
  assert.equal(settings.settings.verified, false);
  assert.equal(settings.events.at(-1).after.sensitivity, 0x27);
  assert.equal(settings.events.at(-1).verified, false);
  assert.ok(h.events.some(event => event.kind === 'usb-result' && event.operation === 'controlTransferIn' && event.data.hex.includes('27')));
});
