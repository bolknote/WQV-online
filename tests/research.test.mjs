import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_PLAN, ManualSteps, ResearchClient, ProbeTimeout, captureUSB, attemptFiles } from '../dist/research-core.mjs';
import { Journal } from '../dist/research-store.mjs';
import { b, fromHex as hx } from '../dist/formats.mjs';

test('research steps advance only on an explicit next/skip, and every retry starts idle', () => {
  const plan = new ManualSteps();
  assert.deepEqual(PROBE_PLAN.map(s => s.code), [0xaa, 0xad, 0x0b, 0xab, 0xac, 0xae, 0xaf, 0xa8, 0xa9, 0xb0]);
  assert.throws(() => plan.next());
  plan.begin(); assert.throws(() => plan.next(true)); assert.throws(() => plan.retry());
  plan.finish(); assert.equal(plan.index, 0); assert.equal(plan.state, 'done');
  plan.next(); assert.equal(plan.step.code, 0xad); assert.equal(plan.state, 'idle');
  plan.begin(); plan.finish(); plan.retry(); assert.equal(plan.index, 1); assert.equal(plan.state, 'idle');
});

test('USB capture keeps exact view offsets, statuses, empty reads, control replies and original method binding', async () => {
  const events = [], backing = b(0xff, 0xc0, 0xe1, 0xfe);
  const device = {
    vendorId: 0x066f,
    async transferIn() { assert.equal(this, device); return { status: 'ok', data: new DataView(backing.buffer, 1, 2) }; },
    async transferOut(ep, data) { assert.equal(this, device); return { status: 'stall', bytesWritten: 1 }; },
    async controlTransferIn() { return { status: 'ok', data: new DataView(new ArrayBuffer(0)) }; },
    async releaseInterface() { throw new DOMException('Disconnected', 'NetworkError'); },
  };
  const proxy = captureUSB(device, (kind, data) => events.push({ kind, ...data }), () => ({ baud: 115200 }));
  const reply = await proxy.transferIn(2, 64);
  assert.equal(reply.data.getUint8(1), 0xe1);
  backing.fill(0);
  const output = b(0xff, 0x55, 0xaa, 0xfe);
  await proxy.transferOut(1, output.subarray(1, 3)); output.fill(0);
  await proxy.controlTransferIn({ request: 1 }, 0);
  await assert.rejects(proxy.releaseInterface(0));
  assert.equal(events[1].data.hex, 'c0e1'); assert.equal(events[1].data.byteLength, 2);
  assert.equal(events[2].args[1].hex, '55aa'); assert.equal(events[3].status, 'stall');
  assert.equal(events[3].bytesWritten, 1);
  assert.deepEqual(events[5].data, { hex: '', byteLength: 0 });
  assert.equal(events[7].kind, 'usb-error'); assert.equal(events[7].name, 'NetworkError');
  assert.ok(events.every(e => e.baud === 115200));
});

class Frames {
  constructor(frames = []) { this.frames = frames; this.sent = []; this.opened = true; this.decoder = { badCRC: 0 }; }
  assertOpen() {}
  async sendFrame(address, control, data) { this.sent.push({ address, control, data: data.slice() }); }
  async receiveFrame() {
    if (this.frames.length) return this.frames.shift();
    await new Promise(resolve => setTimeout(resolve, 1)); return null;
  }
}
function readyClient(adapter, record = () => {}) {
  const client = new ResearchClient(adapter, { record });
  Object.assign(client, { connected: true, isPrimary: true, model: 3, session: 9, watchPort: 0x71, ourPort: 0x70, lastRX: -100 });
  return client;
}
const incoming = (control, data = b()) => ({ address: 0x71, control, data });

test('an unanswered unknown command is sent once, with no application retransmission', async () => {
  const adapter = new Frames(), events = [], client = readyClient(adapter, (kind, data) => events.push({ kind, ...data }));
  const result = await client.probe(0xab, 35);
  assert.equal(result.status, 'no-response'); assert.equal(result.error.name, 'ProbeTimeout');
  assert.equal(result.commandSent, true); assert.equal(adapter.sent.length, 1);
  assert.deepEqual(adapter.sent[0].data, b(3, 9, 0, 0, 0xab));
  await assert.rejects(client.send(b(3, 9, 0, 0, 0xab)), /never be retransmitted/);
  assert.equal(adapter.sent.length, 1);
});

test('the probe preserves long, fragmented, non-0D replies and continues after an initial acknowledgement', async () => {
  const first = b(0x7e, ...new Uint8Array(800).fill(0x23)), second = b(0x0d, 0x24, 0x50, 0xff);
  const adapter = new Frames([
    incoming(0x10, b(9, 3, 0, 0, ...first)), incoming(0x51),
    incoming(0x12, b(9, 3, 0, 0, ...second)), incoming(0x51),
  ]);
  const events = [], client = readyClient(adapter, (kind, data) => events.push({ kind, ...data }));
  const result = await client.probe(0xad, 150);
  assert.equal(result.status, 'response'); assert.equal(result.responseBytes, first.length + second.length);
  assert.deepEqual(hx(result.responseHex), b(...first, ...second));
  assert.equal(events.filter(e => e.kind === 'application-rx').length, 2);
  assert.equal(adapter.sent.filter(frame => frame.data.length).length, 1);
  assert.ok(adapter.sent.filter(frame => !frame.data.length).length >= 2);
});

test('a failed transmit cannot be retried and is distinguished from completed transmission', async () => {
  const adapter = new Frames(); adapter.sendFrame = async () => { throw new Error('FIFO failed'); };
  const client = readyClient(adapter), result = await client.probe(0x0b, 35);
  assert.equal(result.commandAttempted, true); assert.equal(result.commandSent, false); assert.equal(result.status, 'error');
  await assert.rejects(client.send(b(3, 9, 0, 0, 0x0b)), /never be retransmitted/);
});

test('unsolicited data while waiting for credits cannot be mistaken for a probe response', async () => {
  const adapter = new Frames([incoming(0x10, b(9, 3, 1, 0, 0x0d)), incoming(0x31)]);
  const events = [], client = readyClient(adapter, (kind, data) => events.push({ kind, ...data }));
  client.txCredits = 0;
  const result = await client.probe(0xad, 100);
  assert.equal(result.commandAttempted, false); assert.equal(result.responseBytes, 0);
  assert.match(result.error.message, /before the command/);
  assert.equal(adapter.sent.filter(frame => frame.data.length).length, 0);
  assert.equal(events.find(e => e.kind === 'application-before-command').dataHex, '0d');
  assert.deepEqual(attemptFiles({}, events).find(f => f.name === 'before-command.bin').data, b(0x0d));
});

test('a protocol error keeps the partial reply and captures later frames passively without transmitting', async () => {
  const adapter = new Frames([
    incoming(0x10, b(9, 3, 0, 0, 0x0d)), incoming(0x53),
    incoming(0x30, b(0x99, 0x88, 0x77)),
  ]);
  const events = [], client = readyClient(adapter, (kind, data) => events.push({ kind, ...data }));
  const result = await client.probe(0xad, 50);
  assert.equal(result.status, 'error'); assert.equal(result.responseHex, '0d');
  const frame = events.find(e => e.phase === 'passive-after-error');
  assert.equal(frame.dataHex, '998877');
  assert.equal(adapter.sent.length, 2); // one command, one ACK, nothing during passive capture
  assert.equal(adapter.sent.filter(f => f.data.length).length, 1);
});

test('only the explicit plan and a fresh WQV-3 session can be probed', async () => {
  const client = readyClient(new Frames());
  await assert.rejects(client.probe(0x07), /research plan/);
  client.model = 10; await assert.rejects(client.probe(0xad), /WQV-3/);
  client.model = 3; client.appBuffer = b(0x0d); await assert.rejects(client.probe(0xad), /fresh session/);
});

test('ZIP binary streams retain rejected USB bytes and partial writes independently of decoded frames', () => {
  const events = [
    { kind: 'usb-call', id: 1, operation: 'transferOut', args: [1, { hex: '55aa010023' }] },
    { kind: 'usb-result', id: 1, operation: 'transferOut', status: 'stall', bytesWritten: 2 },
    { kind: 'usb-result', id: 2, operation: 'transferIn', data: { hex: 'c023e1' }, status: 'ok' },
    { kind: 'usb-result', id: 3, operation: 'transferIn', data: { hex: '' }, status: 'ok' },
    { kind: 'application-rx', dataHex: '0d' },
    { kind: 'application-rx', dataHex: '2450' },
    { kind: 'usb-call', id: 4, operation: 'transferIn', args: [2, 64] },
  ];
  const files = new Map(attemptFiles({ commandHex: 'ad' }, events).map(file => [file.name, file.data]));
  assert.deepEqual(files.get('usb-in.bin'), hx('c023e1'));
  assert.deepEqual(files.get('usb-out-requested.bin'), hx('55aa010023'));
  assert.deepEqual(files.get('response.bin'), hx('0d2450'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('attempt.json'))).pendingUSBCalls, [4]);
  assert.equal(new TextDecoder().decode(files.get('events.jsonl')).trim().split('\n').length, events.length);
});

test('large numbers of empty reads export without argument-spread limits', () => {
  const events = Array.from({ length: 150000 }, (_, id) => ({ kind: 'usb-result', id, operation: 'transferIn', data: { hex: '' } }));
  const files = attemptFiles({}, events);
  assert.equal(files.find(f => f.name === 'usb-in.bin').data.length, 0);
});

test('journal batching keeps events arriving during a write, and preserves failed batches in memory', async () => {
  const written = []; let release;
  const store = { write: async (name, batch) => { await new Promise(resolve => { release = resolve; }); written.push(...batch); } };
  const journal = new Journal(store, { id: 'test' });
  journal.record('first'); const pending = journal.flush(); journal.record('second');
  release(); await pending; assert.equal(journal.saved, 1);
  const next = journal.flush(); release(); await next;
  assert.deepEqual(written.map(e => e.kind), ['first', 'second']);
  let failure;
  const broken = new Journal({ write: async () => { throw new Error('QuotaExceededError'); } }, { id: 'broken' }, error => { failure = error; });
  broken.record('raw', { dataHex: 'c0e1' });
  await assert.rejects(broken.flush(), /QuotaExceededError/);
  assert.equal(broken.saved, 0); assert.equal(broken.events[0].dataHex, 'c0e1'); assert.equal(failure.message, 'QuotaExceededError');
});
