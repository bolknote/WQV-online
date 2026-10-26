import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CSI_PROFILE, IrTranPReceiver, parseConnect, csiCack, compactSCEP, takeSCEP, csiIAS, csiCommand } from '../dist/irtranp-core.mjs';
import { b, ascii, concat, equal, fromHex as hx, toHex, makeCommand, attribute, packSCEP, unpackSCEP, parseCommand, putCommand } from '../dist/formats.mjs';
import { FrameDecoder, encodeFrame, linkParameters, baudMask } from '../dist/irda.mjs';
import { attemptFiles, captureUSB } from '../dist/research-core.mjs';
const fixture = JSON.parse(await readFile(new URL('./csi-fixtures.json', import.meta.url)));
const native = JSON.parse(await readFile(new URL('./native-fixtures.json', import.meta.url)));
const LOCAL = hx('12345678'), PEER = hx('87654321');
const request = name => hx(fixture.session.find((e, i) => e.direction === 'rx-fixture' && fixture.session[i + 1]?.direction === 'tx-csi' &&
  e.hex.endsWith(toHex(ascii(name))))?.hex ?? '');

test('standalone CACK and capability replies match the original CSI MIPS output byte for byte', () => {
  const connect = parseConnect(hx(fixture.session[0].hex));
  assert.equal(toHex(connect.primaryID), fixture.peerMachineID); assert.equal(connect.name, 'TEST WATCH'); assert.equal(connect.maxPDU, 512);
  assert.equal(toHex(csiCack(connect.primaryID)), fixture.session[1].hex);
  for (const name of ['RIMG', 'RINF', 'RCMD']) {
    const incoming = request(name), i = fixture.session.findIndex(e => e.hex === toHex(incoming));
    const result = csiCommand(unpackSCEP(incoming)); assert.equal(result.name, name);
    assert.equal(toHex(compactSCEP(result.reply)[0]), fixture.session[i + 1].hex);
  }
});

test('SCEP stream parsing survives every USB/IrCOMM split and keeps coalesced following packets', () => {
  for (const row of fixture.session) {
    const packet = hx(row.hex);
    for (let end = 0; end < packet.length; end++) assert.equal(takeSCEP(packet.slice(0, end)), null);
    assert.deepEqual(takeSCEP(concat(packet, b(0x12, 0x34))), { packet, rest: b(0x12, 0x34) });
  }
  assert.throws(() => parseConnect(hx(fixture.session[0].hex).slice(0, -1)), /Connect/);
  assert.throws(() => takeSCEP(hx('002003ff1001')), /size/);
});

const ias = (name, className = 'IrDA:IrCOMM') => concat(b(0, 1, 0x84, className.length), ascii(className), b(name.length), ascii(name));
test('IAS uses actual attribute names in any order, advertises selector 9 and rejects raw IrLMP service', () => {
  assert.equal(toHex(csiIAS(ias('Parameters')).reply), '0100840000010005020006000106010101');
  assert.equal(toHex(csiIAS(ias('IrDA:TinyTP:LsapSel')).reply), '01008400000100050100000009');
  assert.equal(csiIAS(ias('IrDA:IrLMP:InstanceName')).found, true);
  assert.equal(csiIAS(ias('IrDA:IrLMP:LsapSel')).found, false);
  assert.equal(csiIAS(ias('IrDA:TinyTP:LsapSel', 'Other')).found, false);
  assert.throws(() => csiIAS(ias('Parameters').slice(0, -1)), /Truncated/);
});

test('PUT replies preserve the original body and filename without generating an upload command', () => {
  const bytes = hx(native.upf), cmd = putCommand(bytes, 'MC000001.UPF', { source: hx(fixture.peerMachineID), destination: hx(fixture.csiMachineID) });
  const result = csiCommand(cmd), reply = parseCommand(result.reply);
  assert.deepEqual(result.file.bytes, bytes); assert.equal(result.file.filename, 'MC000001.UPF');
  assert.equal(reply.reply, 0x40); assert.deepEqual(reply.attributes.RPL0, ascii('MC000001.UPF'));
  assert.equal(reply.attributes.CMD0, undefined);
  const unsupported = makeCommand([attribute('CMD0', b(0xaa))], { source: hx(fixture.peerMachineID), destination: hx(fixture.csiMachineID) });
  assert.throws(() => csiCommand(unsupported), /Unsupported/);
});

class Adapter {
  opened = true; configured = true; baud = 9600; revision = 7; readerTask = null; decoder = new FrameDecoder({ recoverFrames: true });
  sent = []; rxBytes = 0; txFrames = 0; inEndpoint = 2; readPending = false;
  assertOpen() { if (!this.opened) throw new Error('Closed'); }
  async sendFrame(address, control, data, bof, options) {
    assert.equal(this.readPending, false); assert.equal(options.receive, false);
    this.sent.push({ address, control, data }); this.txFrames++;
  }
  async setSIRSpeed(rate) { this.baud = rate; }
  async close() { this.opened = false; this.cancel?.(); }
}
async function session() {
  const adapter = new Adapter(), events = [], files = [];
  const receiver = new IrTranPReceiver(adapter, { localID: LOCAL, record: (kind, details) => events.push({ kind, ...details }), onFile: async file => files.push(file) });
  await receiver.frame({ address: 255, control: 0x93, data: concat(PEER, LOCAL, b(0x70), linkParameters(baudMask(115200))) });
  let ns = 0;
  const incoming = async data => {
    await receiver.frame({ address: 0x71, control: (receiver.vs << 5) | 0x10 | (ns << 1), data }); ns = (ns + 1) & 7;
  };
  const app = bytes => incoming(concat(b(9, 0x23, 1, 0), bytes));
  const poll = () => receiver.frame({ address: 0x71, control: (receiver.vs << 5) | 0x11, data: b() });
  await incoming(hx('80010100'));
  await incoming(ias('Parameters')); await incoming(ias('IrDA:TinyTP:LsapSel'));
  await incoming(b(0x89, 0x23, 1, 0, 8));
  await app(hx(fixture.session[0].hex));
  return { adapter, receiver, events, files, incoming, app, poll };
}

test('a complete secondary session accepts dynamic peer SAP and reordered queries using CSI replies', async () => {
  const s = await session();
  assert.equal(s.adapter.baud, 115200); assert.equal(s.receiver.peerSAP, 0x23); assert.equal(s.receiver.stats.iasQueries, 2);
  for (const name of ['RCMD', 'RIMG', 'RINF']) await s.app(request(name));
  assert.equal(s.receiver.stats.queries, 3);
  const packets = s.adapter.sent.filter(f => f.data[0] === 0x23 && f.data[1] === 9 && f.data.length > 4).map(f => f.data.slice(4));
  assert.equal(toHex(packets[0]), fixture.session[1].hex);
  for (const [i, name] of ['RCMD', 'RIMG', 'RINF'].entries()) {
    const body = parseCommand(unpackSCEP(packets[i + 1])).attributes.BDY0;
    assert.equal(toHex(body), CSI_PROFILE.capabilities[name]);
  }
  await s.app(hx('003020020001')); await s.receiver.frame({ address: 0x71, control: 0x53, data: b() });
  assert.equal(s.receiver.closed, true); assert.equal(s.adapter.sent.at(-1).control, 0x73);
  assert.equal(s.files.length, 0);
});

test('TinyTP stream and segmented SCEP are reassembled once even when the peer retransmits a frame', async () => {
  const s = await session(), bytes = hx(native.upf);
  const command = putCommand(bytes, 'MC000001.UPF', { source: hx(fixture.peerMachineID), destination: hx(fixture.csiMachineID) });
  const stream = concat(...packSCEP(command, 128));
  for (let p = 0; p < stream.length; p += 47) await s.app(stream.slice(p, p + 47));
  assert.equal(s.files.length, 1); assert.deepEqual(s.files[0].bytes, bytes); assert.deepEqual(s.files[0].jpeg, hx(native.jpeg));
  const previous = s.events.filter(e => e.kind === 'rx-frame' && !(e.control & 1)).at(-1);
  await s.receiver.frame({ address: 0x71, control: previous.control, data: hx(previous.dataHex) });
  assert.equal(s.files.length, 1); assert.equal(s.receiver.stats.duplicates, 1);
  const raw = s.events.find(e => e.kind === 'irtranp-file'); assert.equal(raw.dataHex, native.upf);
});

test('credit grants bypass queued application data when no peer transmit credits remain', async () => {
  const s = await session();
  s.receiver.txCredits = 0; s.receiver.unacked = null; s.receiver.outgoing = [];
  s.receiver.rxCredits = 6;
  s.receiver.queueApplication(hx(fixture.session[1].hex));
  s.receiver.enqueue(b(0x23, 9, 6), { grant: 6 }); s.receiver.creditQueued = true;
  await s.poll();
  assert.deepEqual(s.adapter.sent.at(-1).data, b(0x23, 9, 6));
  assert.equal(s.receiver.rxCredits, 12); assert.equal(s.receiver.txCredits, 0);
});

test('a busy peer gets an RR response instead of queued data or an automatic retransmission', async () => {
  const s = await session(); s.receiver.queueApplication(hx(fixture.session[1].hex));
  const before = s.receiver.outgoing.length;
  await s.receiver.frame({ address: 0x71, control: (s.receiver.vs << 5) | 0x15, data: b() });
  assert.equal(s.adapter.sent.at(-1).data.length, 0); assert.equal(s.adapter.sent.at(-1).control & 15, 1);
  assert.equal(s.receiver.outgoing.length, before);
});

test('unsupported commands and identity mismatches stop before sending an application response', async () => {
  const s = await session();
  const cmd = makeCommand([attribute('CMD0', b(0xaa))], { source: hx(fixture.peerMachineID), destination: hx(fixture.csiMachineID) });
  const before = s.adapter.sent.length;
  await assert.rejects(s.app(packSCEP(cmd)[0]), /Unsupported/); assert.equal(s.adapter.sent.length, before);
  assert.ok(s.events.some(e => e.kind === 'application-rx' && e.dataHex === toHex(packSCEP(cmd)[0])));
});

test('deadline closes a blocked USB read and an aborted receiver transmits nothing', async () => {
  const a = new Adapter(); a.device = { transferIn: () => new Promise((_, reject) => { a.cancel = () => reject(new Error('USB closed')); }) };
  const receiver = new IrTranPReceiver(a, { localID: LOCAL });
  const result = await receiver.run(2000);
  assert.equal(result.status, 'usb-read-timeout'); assert.equal(a.opened, false); assert.equal(a.sent.length, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = new IrTranPReceiver(new Adapter(), { signal: controller.signal, localID: LOCAL });
  await assert.rejects(cancelled.run(2000), /abort/i);
});

test('deadline finishes even when USB close succeeds but the pending IN never settles', { timeout: 4000 }, async () => {
  const a = new Adapter(), events = [];
  let rejectRead;
  a.device = captureUSB({ transferIn: () => new Promise((resolve, reject) => { rejectRead = reject; }) },
    (kind, details) => events.push({ kind, ...details }));
  // Reproduce the captured Chromium behaviour: close resolves; IN stays pending.
  const receiver = new IrTranPReceiver(a, { localID: LOCAL, record: (kind, details) => events.push({ kind, ...details }) });
  const result = await receiver.run(2000);
  assert.equal(result.status, 'usb-read-timeout'); assert.equal(result.pendingUSBRead, true);
  assert.equal(a.opened, false); assert.equal(a.sent.length, 0);
  let files = new Map(attemptFiles({ kind: 'irtranp', result }, events).map(file => [file.name, file.data]));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('attempt.json'))).pendingUSBCalls, [1]);
  // A late rejection remains in the original trace, without restarting the loop.
  rejectRead(new Error('USB removed later')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.readPending, false); assert.equal(a.sent.length, 0);
  assert.equal(events.filter(e => e.kind === 'irtranp-finished').length, 1);
  assert.equal(events.at(-1).kind, 'usb-error');
});

test('manual Stop finishes without waiting for a stuck IN or a stuck USB close', { timeout: 1000 }, async () => {
  const a = new Adapter(), controller = new AbortController();
  a.device = { transferIn: () => {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } };
  a.close = () => { a.opened = false; return new Promise(() => {}); };
  const result = await new IrTranPReceiver(a, { signal: controller.signal, localID: LOCAL }).run(60000);
  assert.equal(result.status, 'interrupted'); assert.equal(result.pendingUSBRead, true);
  assert.equal(a.sent.length, 0); assert.equal(result.complete, false);
});

test('manual Stop during USB transmit cannot resume the session after a late completion', { timeout: 2000 }, async () => {
  const a = new Adapter(), controller = new AbortController(), events = [];
  let finishWrite;
  a.device = { transferIn: async () => ({ status: 'ok', data: new DataView(new ArrayBuffer(0)) }) };
  a.sendFrame = () => {
    queueMicrotask(() => controller.abort());
    return new Promise(resolve => { finishWrite = resolve; });
  };
  const receiver = new IrTranPReceiver(a, { signal: controller.signal, localID: LOCAL, record: (kind, details) => events.push({ kind, ...details }) });
  const result = await receiver.run(60000);
  assert.equal(result.status, 'interrupted'); assert.equal(a.opened, false);
  assert.equal(events.filter(e => e.kind === 'tx-frame').length, 0);
  finishWrite(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(e => e.kind === 'tx-frame').length, 0);
  assert.equal(events.filter(e => e.kind === 'frame-send-attempt').length, 1);
});

test('ZIP files preserve raw USB, application streams and received file bodies separately', () => {
  const events = [{ kind: 'usb-call', id: 1, operation: 'transferOut', args: [1, { hex: '55aa' }] },
    { kind: 'usb-result', id: 1, operation: 'transferOut', bytesWritten: 2, status: 'ok' },
    { kind: 'usb-result', id: 2, operation: 'transferIn', data: { hex: 'c0c1' } },
    { kind: 'application-rx', dataHex: '0010' }, { kind: 'application-tx-queued', dataHex: '0011' },
    { kind: 'irtranp-file', filename: 'MC000001.UPF', dataHex: '535353' }];
  const files = new Map(attemptFiles({ kind: 'irtranp' }, events).map(f => [f.name, f.data]));
  assert.equal(toHex(files.get('usb-in.bin')), 'c0c1'); assert.equal(toHex(files.get('application-in.bin')), '0010');
  assert.equal(toHex(files.get('application-out-queued.bin')), '0011');
  assert.equal(toHex(files.get('files/000-MC000001.UPF')), '535353');
  assert.match(new TextDecoder().decode(files.get('README.txt')), /does not prove delivery/);
});
