import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SWAN_LISTEN_PLAN, confirmedConditions, analyseSwanListening, swanListeningFiles } from '../dist/swan-listen-core.mjs';
import { listenSettings } from '../dist/listen-core.mjs';
import { b, concat } from '../dist/formats.mjs';

test('each speed has its own background, SEND and RECEIVE conditions; background never claims a watch mode', () => {
  for (const baud of [9600, 38400]) {
    const steps = SWAN_LISTEN_PLAN.filter(item => item.baud === baud);
    assert.deepEqual(steps.map(item => item.watchMode), [null, 'swan-send', 'swan-receive']);
    for (const step of steps) {
      const conditions = confirmedConditions(step, '2026-10-24T12:00:00.000Z');
      assert.equal(conditions.watchPresent, step.watchPresent);
      assert.equal(conditions.watchMode, step.watchMode);
      assert.equal(conditions.finalButtonPending, step.watchPresent);
      assert.equal(conditions.source, 'user-confirmation');
      assert.equal(listenSettings({ baud, watchMode: step.watchMode ?? 'background', durationMs: 2000 }).baud, baud);
    }
  }
  assert.throws(() => confirmedConditions({ baud: 9600 }, ''), RangeError);
});

test('real 20-byte FF capture remains twenty independent raw reads, not a decoded packet or identified peer', () => {
  const fixture = JSON.parse(readFileSync(new URL('./swan-passive-hardware-fixture.json', import.meta.url)));
  const { bytes, analysis } = analyseSwanListening(fixture.events);
  assert.deepEqual(bytes, new Uint8Array(20).fill(255));
  assert.equal(analysis.nonemptyReads, 20); assert.equal(analysis.bursts.length, 20);
  assert.equal(analysis.bursts[0].at, '2026-10-24T05:18:14.738Z');
  assert.equal(analysis.bursts.at(-1).at, '2026-10-24T05:18:15.688Z');
  assert.deepEqual(analysis.histogram, [{ hex: 'ff', count: 20 }]);
  assert.equal(analysis.bulkOutCalls, 0); assert.equal(analysis.markers.length, 1);
  assert.deepEqual(analysis.digimonPacketCandidates, []); assert.equal(analysis.origin, 'unverified');
});

test('export retains late USB completions, failed-read data, pending calls and empty reads', () => {
  const events = [
    { kind: 'usb-call', id: 1, operation: 'transferIn' },
    { kind: 'usb-result', id: 1, operation: 'transferIn', status: 'ok', data: { hex: '' } },
    { kind: 'usb-call', id: 2, operation: 'transferIn' },
    { kind: 'listen-finished' },
    { kind: 'usb-result', id: 2, operation: 'transferIn', status: 'ok', data: { hex: 'c1e123ff' } },
    { kind: 'usb-result', id: 3, operation: 'transferIn', status: 'stall', data: { hex: '55' } },
    { kind: 'usb-call', id: 4, operation: 'transferIn' },
  ];
  const original = structuredClone(events), attempt = { kind: 'listen', watchMode: null, watchPresent: false,
    conditions: confirmedConditions(SWAN_LISTEN_PLAN[0], 'now'), status: 'error' };
  const files = new Map(swanListeningFiles(attempt, events).map(item => [item.name, item.data]));
  const json = name => JSON.parse(new TextDecoder().decode(files.get(name)));
  assert.deepEqual(events, original); assert.deepEqual(files.get('usb-in.bin'), b(0xc1, 0xe1, 0x23, 255, 0x55));
  assert.deepEqual(analyseSwanListening(events).bytes, files.get('usb-in.bin'));
  assert.deepEqual(json('attempt.json').pendingUSBCalls, [4]); assert.deepEqual(json('analysis.json').pendingUSBCalls, [4]);
  assert.equal(json('analysis.json').failedReads, 1); assert.equal(json('analysis.json').emptyReads, 1);
  assert.equal(json('attempt.json').conditions.watchMode, null); assert.equal(files.get('usb-out-requested.bin').length, 0);
  assert.equal(new TextDecoder().decode(files.get('events.jsonl')).trim().split('\n').length, events.length);
});

test('a future accidental OUT is exposed by both the raw export and the summary', () => {
  const events = [{ kind: 'usb-call', id: 1, operation: 'transferOut', args: [1, { hex: '55aa010015' }] },
    { kind: 'usb-result', id: 1, operation: 'transferOut', status: 'ok', bytesWritten: 5 }];
  assert.equal(analyseSwanListening(events).analysis.bulkOutCalls, 1);
  const files = swanListeningFiles({ kind: 'listen' }, events);
  assert.deepEqual(files.find(item => item.name === 'usb-out-requested.bin').data, concat(b(0x55, 0xaa, 1, 0, 0x15)));
});
