import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { negotiateCE211, ce211LinkParameters } from '../dist/irtranp-wince211.mjs';
import { IrTranPCSIProbe } from '../dist/irtranp-csi.mjs';
import { FrameDecoder } from '../dist/irda.mjs';
import { b, fromHex as hx, toHex } from '../dist/formats.mjs';
import { createSuite, bindAttempt } from '../dist/irtranp-suite.mjs';
import { featureInstructions } from '../dist/irtranp-presentation.mjs';
import { SUITE_RU } from '../dist/irtranp-suite-ui.mjs';

const fixture = JSON.parse(await readFile(new URL('./wince211-stack-fixture.json', import.meta.url)));
const parameters = values => Uint8Array.from(values.flatMap((value, i) =>
  [[1, 0x82, 0x83, 0x84, 0x85, 0x86, 8][i], value > 255 ? 2 : 1, value & 255, ...(value > 255 ? [value >>> 8] : [])]));

test('CE 2.11 frame limits reproduce the independently executed original QoS function', () => {
  for (const { localMasks, remoteMasks, result } of fixture.qos.cases) {
    const qos = negotiateCE211(parameters(remoteMasks), localMasks[0], parameters(localMasks));
    assert.deepEqual(qos.selectedParameterMasks, result.selectedParameterMasks);
    assert.equal(qos.baud, result.baud); assert.equal(qos.dataBytes, result.remoteDataBytes);
    assert.equal(qos.windowSize, result.remoteWindow); assert.equal(qos.maxTurnMs, result.remoteMaxTurnMilliseconds);
    assert.equal(qos.minTurnUs, result.remoteMinTurnMicroseconds); assert.equal(qos.negotiatedBOFs, result.boFsIncludingStart);
    assert.equal(qos.disconnectSeconds, result.disconnectSeconds); assert.equal(qos.applicationChunkBytes, qos.dataBytes - 5);
  }
  assert.equal(negotiateCE211(parameters(fixture.qos.cases[0].remoteMasks), 2).applicationChunkBytes, 251);
  assert.match(toHex(ce211LinkParameters(2)), /840101/);
});

test('incomplete, contradictory or infeasible QoS offers never start a large transfer', () => {
  const masks = fixture.qos.cases[0].remoteMasks;
  for (const bytes of [b(1), b(1, 2, 2), b(1, 0), Uint8Array.from([...parameters(masks), 0x83, 1, 1])]) {
    assert.throws(() => negotiateCE211(bytes, 2), /IrLAP/);
  }
  const infeasible = [...masks]; infeasible[1] = 8;
  assert.throws(() => negotiateCE211(parameters(infeasible), 2), /line capacity/);
  const noData = [...masks]; noData[2] = 0;
  assert.throws(() => negotiateCE211(parameters(noData), 2), /data size/);
});

function probe(profile = 'wince211') {
  const sent = [], events = [], adapter = { opened: true, baud: 9600, decoder: new FrameDecoder(),
    assertOpen() {}, async sendFrame(address, control, data) { sent.push({ address, control, data }); } };
  const client = new IrTranPCSIProbe(adapter, { transportProfile: profile, record: (kind, data) => events.push({ kind, ...data }) });
  Object.assign(client, { csiActive: true, clientState: 'csi', csiState: 'await-capability', csiDeadline: performance.now() + 6000,
    linkAccepted: true, ircommConnected: true, peerSAP: 3, linkAddress: 0x70, vs: 3, vr: 6, rxCredits: 4, txCredits: 0 });
  client.transaction = { purpose: 'previous-data', wantsReply: false, response: null, polls: 0, deadline: performance.now() + 4000 };
  return { client, sent, events };
}

test('an acknowledged I(F) credit reply advances queued data, carrying the new N(R) without a preceding RR', async () => {
  const { client, sent, events } = probe();
  client.csiQueue.push({ bytes: hx('0010000101'), controls: b(), purpose: 'next-data' });
  await client.frame({ address: 0x70, control: (3 << 5) | (6 << 1) | 0x10, data: b(9, 3, 1) });
  assert.equal(sent.length, 1); assert.equal(sent[0].control & 1, 0); assert.equal(sent[0].control >>> 5, 7);
  assert.equal((sent[0].control >>> 1) & 7, 3); assert.equal(sent[0].control & 0x10, 0x10);
  assert.equal(toHex(sent[0].data), '030900000010000101');
  assert.equal(client.txCredits, 0); assert.equal(client.transaction.purpose, 'next-data');
  assert.equal(client.transaction.linkAcknowledged, false, 'acknowledgement of the old frame cannot acknowledge the new one');
  assert.equal(events.some(e => e.kind === 'irlap-direct-advance'), true);
});

test('a stale N(R), busy peer or current profile retains the RR path and the queued bytes', async () => {
  for (const options of [{ nr: 2 }, { nr: 3, busy: true }, { nr: 3, profile: 'current' }]) {
    const { client, sent } = probe(options.profile); client.peerBusy = Boolean(options.busy);
    client.csiQueue.push({ bytes: b(1), controls: b(), purpose: 'must-wait' });
    await client.frame({ address: 0x70, control: (options.nr << 5) | (6 << 1) | 0x10, data: b(9, 3, 1) });
    assert.equal(sent.length, 1); assert.equal(sent[0].control & 0x1f, 0x11);
    assert.equal(sent[0].data.length, 0); assert.equal(client.csiQueue.length, 1);
  }
});

test('CE credit-only replenishment matches the original builder and consumes no transmit credit', async () => {
  const { client, sent } = probe(); client.transaction = null; client.rxCredits = 0;
  await client.advanceCSI();
  assert.equal(toHex(sent[0].data), fixture.tinytp.cases[2].send.headerHex);
  assert.equal(client.txCredits, 0); assert.equal(client.rxCredits, 4);
});

test('an actual RNR holds the next data frame until RR clears peer busy', async () => {
  const { client, sent } = probe(); client.txCredits = 1;
  client.csiQueue.push({ bytes: b(7, 8), controls: b(), purpose: 'after-busy' });
  await client.frame({ address: 0x70, control: (3 << 5) | 0x15, data: b() });
  assert.equal(client.peerBusy, true); assert.equal(sent.length, 0); assert.equal(client.csiQueue.length, 1);
  await client.poll('busy-poll');
  assert.equal(sent[0].control & 0x1f, 0x11);
  await client.frame({ address: 0x70, control: (3 << 5) | 0x11, data: b() });
  assert.equal(client.peerBusy, false); assert.equal(sent.length, 2);
  assert.equal(sent[1].control & 1, 0); assert.equal(toHex(sent[1].data), '030900000708');
  assert.equal(client.csiQueue.length, 0);
});

test('the new manual plan binds the CE transport and the two-file write separately from read-back steps', () => {
  const suite = createSuite('multiple-wince211'), selected = suite.steps[0];
  assert.equal(suite.steps.length, 3); assert.equal(suite.automaticNextStep, false);
  assert.equal(selected.copyCount, 2); assert.equal(selected.sendPDU, 0); assert.equal(selected.maxBaud, 9600);
  assert.equal(selected.transportProfile, 'wince211'); assert.equal(selected.watchMode, 'others-receive');
  assert.ok(suite.steps.slice(1).every(s => s.test === 'receiver' && s.watchMode === 'others-send' && !s.transportProfile));
  const { id, ...attempt } = selected; attempt.id = 'ce-attempt';
  bindAttempt(suite, attempt);
  assert.throws(() => bindAttempt(suite, { ...attempt, id: 'wrong-profile', transportProfile: 'current' }), /transport profile/);
  assert.match(featureInstructions(selected.feature, s => SUITE_RU[s] ?? s), /Windows CE 2.11/);
});
