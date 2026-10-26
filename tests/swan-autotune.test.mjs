import test from 'node:test';
import assert from 'node:assert/strict';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { captureUSB } from '../dist/research-core.mjs';
import { fromHex, toHex } from '../dist/formats.mjs';
import { AutoTuneSchedule, AUTOTUNE_PROFILES, rankTuneProfiles, applyTuneProfile, listenAutotune, swanAutotuneFiles } from '../dist/swan-autotune-core.mjs';

const burst = (p, hex, phase = 'scan') => ({ profileId: p.id, hex, phase, eligible: true });
test('ranking has no fixed target, rejects flat noise and penalizes large bit deviations', () => {
  const profiles = AUTOTUNE_PROFILES.receiver;
  const samples = [burst(profiles[0], 'a55a3c'), burst(profiles[0], '3d03f8'),
    burst(profiles[1], 'a55a3c'), burst(profiles[1], 'a55a3d'),
    burst(profiles[2], 'ffffff'), burst(profiles[2], 'ffffff'),
    burst(profiles[3], '000000'), burst(profiles[3], '000000')];
  const original = structuredClone(samples), ranked = rankTuneProfiles(profiles, samples);
  assert.equal(ranked.rows[0].id, profiles[1].id);
  assert.equal(ranked.consensusHex, 'a55a3c');
  assert.equal(ranked.rows.find(p => p.id === profiles[1].id).meanDistanceToMode, 0.5);
  assert.deepEqual(samples, original);
});

test('a complete automatic schedule uses 14 scan bursts plus 6 verification bursts', () => {
  const schedule = new AutoTuneSchedule('receiver');
  while (schedule.phase === 'scan') {
    for (let i = 0; i < 2; i++) schedule.add(burst(schedule.current, i && schedule.current.rxSensitivity !== 5 ? 'a55a3d' : 'a55a3c'));
    assert.equal(schedule.windowComplete, true); schedule.advance('samples');
  }
  assert.equal(schedule.finalists.length, 2);
  while (schedule.phase === 'verify') {
    for (let i = 0; i < 3; i++) schedule.add(burst(schedule.current, schedule.current.rxSensitivity === 5 ? 'a55a3c' : i ? 'a55a3d' : 'a55a3c', 'verify'));
    schedule.advance('samples');
  }
  assert.equal(schedule.winnerId, AUTOTUNE_PROFILES.receiver.find(p => p.rxSensitivity === 5).id);
  assert.equal(schedule.summary().studiedBursts, 20); assert.equal(schedule.summary().referenceRequired, false);
  const raw = schedule.bursts.map(b => b.hex);
  assert.ok(!raw.includes('7a06f0')); assert.equal(schedule.summary().provisional, true);
});

test('silence or an incomplete repeat check cannot select a winner', () => {
  const empty = new AutoTuneSchedule('clock');
  for (let i = 0; i < 7; i++) empty.advance('timeout');
  assert.equal(empty.finished, true); assert.equal(empty.winnerId, null);
  const partial = new AutoTuneSchedule('receiver');
  for (let i = 0; i < 7; i++) { partial.add(burst(partial.current, 'aa55')); partial.add(burst(partial.current, 'aa55')); partial.advance('samples'); }
  partial.add(burst(partial.current, 'aa55', 'verify')); partial.advance('timeout');
  partial.add(burst(partial.current, 'aa55', 'verify')); partial.advance('timeout');
  assert.equal(partial.winnerId, null);
});

function hardware({ group = 'receiver', initialBuffered = false, ignoreWrites = false, blindDivisor = null, pulseLimit = 24 } = {}) {
  let time = 0, pulses = 0, nextPulse = 100, fragment = null, old = initialBuffered;
  const registers = new Uint8Array(16), events = [], writes = [];
  registers[1] = 0x2a; registers[2] = 119; registers[4] = 0x27; registers[5] = 4; registers[8] = 0x15;
  let adapter;
  const record = (kind, data = {}) => events.push({ kind, ...data, elapsedMs: time });
  const device = { vendorId: 0x066f, productId: 0x4200, opened: true,
    async controlTransferIn(request, count) { assert.equal(adapter.readPending, false); time += 0.1; return { status: 'ok', data: new DataView(registers.slice(request.index, request.index + count).buffer) }; },
    async controlTransferOut(request) {
      assert.equal(adapter.readPending, false); assert.ok([2, 4].includes(request.index));
      writes.push([request.index, request.value]); time += 0.1;
      if (!ignoreWrites) registers[request.index] = request.index === 4 ? request.value & 0xe8 | registers[4] & 7 : request.value;
      return { status: 'ok' };
    },
    async transferIn() {
      assert.equal(adapter.readPending, true); time += 5;
      let bytes = new Uint8Array();
      if (old) { old = false; bytes = fromHex('deadbeef'); }
      else if (fragment) { bytes = fragment; fragment = null; }
      else if (pulses < pulseLimit && time >= nextPulse) {
        pulses++; nextPulse += 50;
        if (registers[2] !== blindDivisor) {
          const best = group === 'receiver' ? registers[4] >> 5 === 5 : registers[2] === 118;
          const hex = best || pulses % 2 === 0 ? 'a55a3c' : 'a55a3d';
          const full = fromHex(hex); bytes = full.slice(0, 1); fragment = full.slice(1);
        }
      }
      return { status: 'ok', data: new DataView(bytes.buffer) };
    },
    async transferOut() { throw new Error('Must never send.'); },
    async close() { this.opened = false; },
  };
  adapter = new SigmaTel(captureUSB(device, record, () => ({ receiverProfile: adapter?.autotuneIO }), { receiveOnly: true }));
  Object.assign(adapter, { claimed: true, configured: true, baud: 9600, inEndpoint: 2, outEndpoint: 1 });
  return { adapter, events, writes, registers, record, now: () => time };
}

for (const group of ['receiver', 'clock']) test(`${group}: one incoming train switches live profiles, validates the winner and exports all raw bytes`, async () => {
  const h = hardware({ group, initialBuffered: true });
  const result = await listenAutotune(h.adapter, { group, durationMs: 2000 }, {
    record: h.record, now: h.now, quietMs: 8, settleMs: 4, warmupMs: 20, windowMs: 180, endQuietMs: 120,
  });
  await h.adapter.close();
  assert.equal(result.reason, 'complete'); assert.equal(result.autoTune.studiedBursts, 20);
  const winner = AUTOTUNE_PROFILES[group].find(p => p.id === result.autoTune.winnerId);
  assert.ok(winner); assert.equal(winner[group === 'clock' ? 'divisor' : 'rxSensitivity'], group === 'clock' ? 118 : 5);
  assert.equal(h.registers[2], winner.divisor); assert.equal(h.registers[4] >> 5, winner.rxSensitivity);
  assert.ok(result.autoTune.bursts.some(b => b.hex === 'deadbeef' && !b.eligible));
  assert.ok(result.autoTune.bursts.some(b => b.reads === 2 && b.hex === 'a55a3c'));
  assert.equal(h.events.filter(e => e.kind === 'usb-call' && e.operation === 'transferOut').length, 0);
  assert.ok(h.writes.every(([index]) => index === 2 || index === 4));
  const files = new Map(swanAutotuneFiles({ kind: 'listen', result }, h.events).map(f => [f.name, f.data]));
  const raw = h.events.filter(e => e.kind === 'usb-result' && e.operation === 'transferIn').map(e => e.data.hex).join('');
  assert.equal(toHex(files.get('usb-in.bin')), raw); assert.ok(raw.startsWith('deadbeef'));
  assert.equal(JSON.parse(new TextDecoder().decode(files.get('auto-tune.json'))).result.winnerId, winner.id);
  assert.equal(JSON.parse(new TextDecoder().decode(files.get('analysis.json'))).receiverSettingsVary, true);
});

test('a bad readback aborts the sweep before reading or changing another profile', async () => {
  const h = hardware({ ignoreWrites: true });
  await assert.rejects(applyTuneProfile(h.adapter, AUTOTUNE_PROFILES.clock[1], { record: h.record }), /readback/);
  assert.equal(h.events.filter(e => e.kind === 'autotune-profile-applied').at(-1).verified, false);
  assert.equal(h.events.filter(e => e.operation === 'transferIn').length, 0);
  await h.adapter.close();
});

test('one silent clock setting times out and the same capture continues with later profiles', async () => {
  const h = hardware({ group: 'clock', blindDivisor: 123, pulseLimit: 32 });
  const result = await listenAutotune(h.adapter, { group: 'clock', durationMs: 2000 }, {
    record: h.record, now: h.now, quietMs: 8, settleMs: 4, warmupMs: 20, windowMs: 180, endQuietMs: 120,
  });
  await h.adapter.close();
  assert.equal(result.reason, 'complete');
  assert.ok(result.autoTune.windows.some(w => w.profileId === AUTOTUNE_PROFILES.clock[4].id && w.reason === 'timeout'));
  assert.ok(result.autoTune.windows.some(w => w.profileId === AUTOTUNE_PROFILES.clock[5].id && w.reason === 'samples'));
  assert.equal(result.autoTune.winnerId, AUTOTUNE_PROFILES.clock[5].id);
});

test('Stop with a USB read pending cannot write more settings; late data survives export', async () => {
  const h = hardware(), controller = new AbortController(); let finishRead;
  const device = h.adapter.device;
  // Use a new logged device boundary to model a pending native USB read.
  const stalled = { vendorId: 0x066f, productId: 0x4200, opened: true,
    controlTransferIn: (...args) => device.controlTransferIn(...args),
    controlTransferOut: (...args) => device.controlTransferOut(...args),
    transferIn: () => new Promise(resolve => { finishRead = resolve; queueMicrotask(() => controller.abort()); }),
    async close() { this.opened = false; finishRead?.({ status: 'ok', data: new DataView(fromHex('1234').buffer) }); },
  };
  h.adapter.device = captureUSB(stalled, h.record, () => ({}), { receiveOnly: true });
  const result = await listenAutotune(h.adapter, { group: 'receiver', durationMs: 2000 }, { signal: controller.signal, record: h.record });
  await h.adapter.close(); await Promise.resolve();
  assert.equal(result.reason, 'interrupted'); assert.equal(result.autoTune.winnerId, null);
  assert.equal(h.events.filter(e => e.kind === 'autotune-profile-requested').length, 1);
  const files = new Map(swanAutotuneFiles({ kind: 'listen', result }, h.events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('usb-in.bin')), '1234');
});
