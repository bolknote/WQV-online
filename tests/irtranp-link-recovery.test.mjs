import test from 'node:test';
import assert from 'node:assert/strict';
import { IrTranPCSIProbe } from '../dist/irtranp-csi.mjs';
import { LinkFaults, decodeUSBFrame } from '../dist/irtranp-faults.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, toHex } from '../dist/formats.mjs';
import { captureUSB } from '../dist/research-core.mjs';

function client() {
  const sent = [], events = [], adapter = { baud: 9600, decoder: new FrameDecoder(), assertOpen() {},
    async sendFrame(address, control, data) { sent.push({ address, control, data: data.slice() }); } };
  const probe = new IrTranPCSIProbe(adapter, { linkRecovery: true, record: (kind, data) => events.push({ kind, ...data }) });
  Object.assign(probe, { csiActive: true, clientState: 'csi', csiState: 'await-put', linkAccepted: true,
    ircommConnected: true, peerSAP: 3, linkAddress: 0x70, vs: 7, vr: 0, txCredits: 0, rxCredits: 4,
    csiDeadline: performance.now() + 6000 });
  return { probe, sent, events, adapter };
}

test('duplicate peer I frames do not add TinyTP credits twice', async () => {
  const { probe, events } = client();
  await probe.beginTransaction(b(3, 9, 0, 0, 1), 'csi-put', false);
  const reply = { address: 0x70, control: 0x10, data: b(9, 3, 2) };
  await probe.frame(reply); await probe.frame(reply);
  assert.equal(probe.txCredits, 2); assert.equal(probe.vr, 1); assert.equal(probe.stats.duplicates, 1);
  assert.equal(events.filter(e => e.kind === 'application-rx').length, 0);
});

test('RNR prevents data retries; RR with a missing acknowledgement resumes the same I frame', async () => {
  const { probe, sent } = client();
  await probe.beginTransaction(b(3, 9, 0, 0, 4), 'csi-put', false);
  await probe.frame({ address: 0x70, control: 0xf5, data: b() });
  assert.equal(probe.peerBusy, true);
  await probe.poll('busy');
  await probe.recoverLink(probe.transaction.recoveryAt + 1);
  assert.equal(sent.filter(f => !(f.control & 1)).length, 1);
  await probe.frame({ address: 0x70, control: 0xf1, data: b() });
  assert.equal(probe.peerBusy, false); assert.equal(probe.stats.retransmissions, 1);
  assert.equal(probe.vs, 0); assert.equal((sent.at(-1).control >>> 1) & 7, 7);
  assert.deepEqual(sent.at(-1).data, sent[0].data);
});

test('REJ and SREJ retransmit only the outstanding sequence across modulo-eight wrap', async () => {
  for (const control of [0xf9, 0xfd]) {
    const { probe, sent } = client();
    await probe.beginTransaction(b(3, 9, 0, 0, 5), 'csi-put', false);
    await probe.frame({ address: 0x70, control, data: b() });
    assert.equal(probe.stats.retransmissions, 1); assert.equal(probe.vs, 0);
    assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  }
});

test('an incomplete incoming frame delays timeout recovery once, without an unbounded wait', async () => {
  const { probe, sent, adapter } = client();
  await probe.beginTransaction(b(3, 9, 0, 0, 6), 'csi-put', false);
  adapter.decoder.body = [0x70]; probe.lastRX = performance.now();
  const now = performance.now(); probe.transaction.recoveryAt = now;
  await probe.recoverLink(now);
  assert.equal(sent.length, 1); assert.equal(probe.transaction.extendedReceive, true);
  await probe.recoverLink(now + 301); assert.equal(sent.length, 2);
});

test('the recorded damaged RINF credit frame triggers a data retry and a valid retransmission adds credit only once', async () => {
  const { probe, sent, adapter } = client(); probe.vs = 4; probe.vr = 5;
  await probe.beginTransaction(b(3, 9, 0, 0, 1, 0, 0x52, 0x49, 0x4e, 0x46), 'csi-RINF', false);
  adapter.decoder.feed(Uint8Array.from(Buffer.from('c070ba09030149dfe0c1', 'hex')));
  assert.equal(adapter.decoder.badCRC, 1); assert.equal(adapter.decoder.frames.length, 0);
  await probe.recoverLink(probe.transaction.recoveryAt + 1);
  assert.equal((sent.at(-1).control >>> 1) & 7, 4); assert.equal(probe.vs, 5);
  // Synthetic replacement of the missing link reply, not a hardware result.
  const recovered = { address: 0x70, control: 0xba, data: b(9, 3, 1) };
  await probe.frame(recovered); await probe.frame(recovered);
  assert.equal(probe.txCredits, 1); assert.equal(probe.stats.duplicates, 1);
});

test('a requested disconnect removes the transaction and prevents later information retries', async () => {
  const { probe, sent } = client();
  await probe.beginTransaction(b(3, 9, 0, 0, 7), 'csi-put', false);
  await probe.frame({ address: 0x70, control: 0x53, data: b() });
  assert.equal(probe.transaction, null); assert.equal(probe.csiActive, false);
  assert.equal(await probe.recoverLink(performance.now() + 10000), false);
  assert.equal(sent.at(-1).control, 0x53); assert.equal(sent.length, 2);
});

const packet = () => {
  const wire = encodeFrame(0x71, 0x10, b(3, 9, 0, 0, 1, 2, 3), 11);
  return b(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
};

test('wire faults retain valid USB lengths, leave data unchanged for CRC tests and truncate before EOF', () => {
  const original = packet(), intended = decodeUSBFrame(original);
  for (const scenario of ['bad-crc', 'crc-burst', 'truncated']) {
    const fault = new LinkFaults(scenario, () => {}, { at: 1 }); fault.observe('frame-send-attempt', { purpose: 'csi-put' });
    const wire = fault.outgoing(original);
    assert.equal(wire[2] | wire[3] << 8, wire.length - 4);
    const decoder = new FrameDecoder(); decoder.feed(wire.slice(4));
    assert.equal(decoder.frames.length, 0);
    if (scenario !== 'truncated') assert.deepEqual(decodeUSBFrame(wire).data, intended.data);
    else assert.notEqual(wire.at(-1), 0xc1);
    assert.deepEqual(decodeUSBFrame(original).data, intended.data);
    for (let i = 1; i < fault.required; i++) fault.outgoing(original);
    assert.equal(fault.outgoing(original), original, 'a later recovery attempt is untouched');
  }
});

test('the actual shortened wire buffer and count are recorded below the logical adapter shim', async () => {
  const events = [], original = packet(), rawWrites = [];
  const captured = captureUSB({ async transferOut(endpoint, bytes) {
    rawWrites.push(bytes.slice()); return { status: 'ok', bytesWritten: bytes.length };
  } }, (kind, data) => events.push({ kind, ...data }));
  const fault = new LinkFaults('truncated', () => {}, { at: 1 }); fault.observe('frame-send-attempt', { purpose: 'csi-put' });
  const result = await fault.wrapUSB(captured).transferOut(1, original);
  assert.equal(result.bytesWritten, original.length); assert.ok(rawWrites[0].length < original.length);
  assert.equal(events.find(e => e.kind === 'usb-call').args[1].hex, toHex(rawWrites[0]));
  assert.equal(events.find(e => e.kind === 'usb-result').bytesWritten, rawWrites[0].length);
});
