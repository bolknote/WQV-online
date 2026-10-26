import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IrTranPSender, csiPutPackets, parsePutReply, parseSendCapabilities } from '../dist/irtranp-send.mjs';
import { IAS_QUERIES, iasRequest } from '../dist/irtranp-ias.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { takeSCEP, compactSCEP, scepCommandEnds, IrTranPReceiver } from '../dist/irtranp-core.mjs';
import { b, concat, ascii, equal, fromHex as hx, toHex, parseCommand, putCommand, makeCommand, attribute, be16, unpackSCEP, u16, u32, sha256, jpegFromUPF } from '../dist/formats.mjs';
import { metadataUPF } from '../dist/irtranp-metadata.mjs';
import { attemptFiles } from '../dist/research-core.mjs';
import { analyseAttempt } from '../dist/irtranp-suite.mjs';
import { createFeatureFiles } from '../dist/irtranp-feature-images.mjs';
import { createSuite } from '../dist/irtranp-suite.mjs';
import { LinkFaults, FAULT_CASES } from '../dist/irtranp-faults.mjs';

const fixture = JSON.parse(await readFile(new URL('./csi-sender-fixture.json', import.meta.url)));
const originalTX = fixture.trace.filter(p => p.direction === 'tx-csi').map(p => hx(p.hex));
const originalRX = fixture.trace.filter(p => p.direction === 'rx-fixture').map(p => hx(p.hex));
const originalPUT = originalTX[4], command = parseCommand(originalPUT.slice(18));
const UPF = command.attributes.BDY0, CSI = command.source, WATCH = command.destination;
const LOCAL = hx('12345678'), PEER = hx('193666be');
// Historical captures and legacy protocol tests retain their original wire
// behavior explicitly. Recovery tests below exercise the current default.
const options = { sendFile: { bytes: UPF, filename: 'QW000000.UPF' }, localID: LOCAL, linkRecovery: false };
const decodeReply = packet => parseCommand(packet.slice(packet[3] === 255 ? 10 : 8));
const caps = Object.fromEntries(['RIMG', 'RINF', 'RCMD'].map((name, i) => [name, {
  reply: decodeReply(originalRX[i + 1]).reply,
  attributes: Object.fromEntries(Object.entries(decodeReply(originalRX[i + 1]).attributes).map(([k, v]) => [k, toHex(v)])),
}]));

test('PUT matches every byte emitted by the original CSI sender, including its single-segment 41 wrapper', async () => {
  const built = putCommand(UPF, 'QW000000.UPF', { id: 3, destination: WATCH, source: CSI });
  assert.equal(toHex(built), toHex(originalPUT.slice(18)));
  assert.deepEqual(csiPutPackets(built, 2048), [originalPUT]);
  assert.deepEqual(csiPutPackets(built, 512).map(toHex), fixture.variants['send-segmented-session'].putPackets);
  for (const [i, packet] of fixture.variants['send-two-session'].putPackets.entries()) {
    const next = putCommand(UPF, 'QW000000.UPF', { id: 3 + i, destination: WATCH, source: CSI });
    assert.equal(toHex(csiPutPackets(next, 2048)[0]), packet);
  }
  assert.equal(await sha256(UPF), fixture.upfSHA256);
  assert.equal(toHex(originalTX.at(-1)), '003020020001');
  assert.equal(parsePutReply(originalRX.at(-1).slice(8), { id: 3, destination: CSI, source: WATCH }).accepted, true);
  assert.equal(scepCommandEnds(originalPUT), true);
  assert.equal(toHex(unpackSCEP(originalPUT)), toHex(built));
});

test('capability parsing keeps the actual watch size discrepancy and decodes limits and multiple PUT', () => {
  const parsed = parseSendCapabilities(caps);
  assert.equal(parsed.multiplePUT, true); assert.equal(parsed.maxFileBytes, 0x1800 * 256);
  assert.deepEqual(parsed.originalSize, [2048, 1536]);
  assert.equal(parsed.acceptedSizes.some(([w, h]) => w === 176 && h === 144), false);
  assert.equal(parsed.memoryKiB, null); assert.equal(parsed.batteryMinutes, null);
  assert.equal(parsed.originalSampling, 0xc420); assert.deepEqual(parsed.acceptedSampling, [0xc420]);
  const broken = structuredClone(caps); broken.RCMD.attributes.BDY0 = '2000020001';
  assert.throws(() => parseSendCapabilities(broken), /function list/);
  broken.RCMD.attributes.BDY0 = '2000010001'; broken.RIMG.reply = 0x80;
  assert.throws(() => parseSendCapabilities(broken), /positive RIMG/);
});

class Peer {
  opened = true; configured = true; baud = 9600; revision = 7; readerTask = null; inEndpoint = 2;
  decoder = new FrameDecoder({ recoverFrames: true }); readPending = false; rxBytes = 0; txFrames = 0;
  queued = []; payloads = []; sent = []; uploads = []; putPackets = []; speeds = []; controls = [];
  ns = 0; nr = 0; stream = b(); commandParts = []; requests = 0; hostCredits = 0; grantAfter = 0;
  constructor(settings = {}) {
    this.settings = settings;
    this.device = { transferIn: async () => {
      if (this.hang) { queueMicrotask(() => settings.abort?.()); return new Promise(() => {}); }
      const bytes = this.queued.shift() ?? b();
      return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
    } };
  }
  assertOpen() { assert.ok(this.opened); }
  async close() { this.opened = false; }
  async setSIRSpeed(rate) { this.speeds.push(rate); this.baud = rate; }
  queue(address, control, data = b()) { this.queued.push(encodeFrame(address, control, data)); }
  respond() {
    if (this.payloads.length) {
      const payload = this.payloads.shift();
      if (payload.length > 3 && payload[0] === 9 && payload[1] === 3) assert.ok(this.hostCredits-- > 0, 'peer never exceeds granted receive credits');
      this.queue(0x70, (this.nr << 5) | 0x10 | (this.ns << 1), payload); this.ns = (this.ns + 1) & 7;
    } else this.queue(0x70, (this.nr << 5) | 0x11);
  }
  reply(packet) {
    // Split inside both SCEP and command headers; these are stream writes,
    // independent of the USB and IrLAP framing boundaries.
    for (const bytes of [packet.slice(0, 2), packet.slice(2, 17), packet.slice(17)]) this.payloads.push(concat(b(9, 3, 0, 0), bytes));
  }
  putReply(id) {
    if (this.settings.noReply) { this.hang = true; return; }
    const rejected = this.settings.reject;
    const body = makeCommand([attribute(rejected ? 'ERR0' : 'RPL0', rejected ? hx('0020') : ascii('MC000001.UPF'), !rejected)],
      { id: this.settings.wrongID ? id + 1 : id, reply: rejected ? 0x80 : 0x40, destination: CSI, source: WATCH });
    if (rejected && this.settings.abortError) body.set(hx('0031'), body.length - 2);
    if (this.settings.singleSegmentACK) this.reply(concat(hx('002003ff'), be16(body.length + 12), hx('1041'), be16(body.length), hx('0000000000000001'), body));
    else for (const packet of compactSCEP(body)) this.reply(packet);
  }
  application(packet) {
    if (packet[1] === 0x10) { assert.equal(toHex(packet), toHex(originalTX[0])); this.reply(originalRX[0]); return; }
    if (packet[1] === 0x30) { assert.equal(toHex(packet), '003020020001'); this.closedSCEP = true; return; }
    const p = packet[3] === 255 ? 6 : 4, flag = packet[p + 1];
    if (flag === 0xc2) {
      this.stopReceived = true; this.commandParts = []; return;
    }
    if (flag === 0xc1 && packet[p + 5] === 0xc0) {
      this.abortReceived = true;
      assert.equal(u16(packet, packet.length - 2), 3);
      if (this.settings.delayPUT) { this.settings.reject = true; this.settings.abortError = true; this.putReply(3); }
      return;
    }
    if (flag === 0xc1) {
      const req = parseCommand(packet.slice(p + 4)), name = new TextDecoder().decode(req.attributes.WHT0);
      assert.equal(name, ['RIMG', 'RINF', 'RCMD'][this.requests]);
      let reply = originalRX[++this.requests];
      if (name === 'RCMD' && this.settings.singlePUT) reply = compactSCEP(makeCommand([attribute('BDY0', hx('2000010000'))],
        { id: req.id, reply: 0x40, destination: CSI, source: WATCH }))[0];
      if (name === 'RIMG' && this.settings.smallLimit) reply = compactSCEP(makeCommand([attribute('BDY0', hx('0500000001'))],
        { id: req.id, reply: 0x40, destination: CSI, source: WATCH }))[0];
      this.reply(reply); return;
    }
    this.putPackets.push(packet); const seq = u32(packet, p + 4), rest = u32(packet, p + 8);
    assert.equal(seq, this.commandParts.length); this.commandParts.push(packet.slice(p + 12));
    if (this.settings.requestDisconnectAtSegment === seq + 1) {
      this.requestDisconnectOnPoll = true; this.payloads.push(b(9, 3, 1)); return;
    }
    if (this.settings.premature && seq === 0 && rest > 1) { this.putReply(3); return; }
    if (rest === 1) {
      assert.equal(flag, seq === 0 ? 0x41 : 0x81);
      const body = concat(...this.commandParts); this.commandParts = [];
      const req = parseCommand(body); assert.equal(toHex(req.attributes.CMD0), '00000000');
      assert.equal(toHex(req.attributes.BDY0), toHex(this.settings.expectedUPFs?.[this.uploads.length] ?? this.settings.expectedUPF ?? UPF));
      assert.equal(toHex(req.destination), toHex(WATCH)); assert.equal(toHex(req.source), toHex(CSI));
      this.uploads.push(req);
      if (this.settings.requestDisconnectAfterPUT === this.uploads.length) {
        this.requestDisconnectOnPoll = true; this.payloads.push(b(9, 3, 1));
      } else if (this.settings.replyAfterPoll) {
        // Observed watch shape: final data gets a TinyTP credit, not RPL0.
        // The application response can be fetched only on a later RR turn.
        this.pendingPutReply = req.id; this.payloads.push(b(9, 3, 1));
      } else if (!this.settings.delayPUT && !this.settings.dropLastDataAcknowledgement) this.putReply(req.id);
      if (this.settings.dropLastDataAcknowledgement) this.dropNextResponse = true;
    }
  }
  async sendFrame(address, control, data, bof, opts) {
    assert.equal(this.readPending, false); assert.equal(opts.receive, false);
    if (this.settings.validateNR && address === 0x71 && (control & 3) !== 3) {
      assert.equal((control >>> 5) & 7, this.ns, 'host acknowledges the last peer frame, including while piggybacking');
      if (!(control & 1)) assert.equal((control >>> 1) & 7, this.nr, 'the next outgoing sequence is not skipped or reused');
    }
    this.sent.push({ address, control, data: data.slice() }); this.txFrames++;
    if (control === 0x3f && data[10] === 2) this.queue(0xfe, 0xbf, concat(b(1), PEER, LOCAL, hx('0102008c0400'), ascii('CASIO WIC 2411/IR')));
    else if (control === 0x93) this.queue(0x70, 0x73, concat(PEER, LOCAL,
      hx(this.settings.uaParameters ?? '01013e82010183013f84010f85018086028003080104')));
    else if (control === 0x53) { this.closedLink = true; this.queue(0x70, 0x73); }
    else if (!(control & 1)) {
      this.nr = (((control >>> 1) & 7) + 1) & 7;
      if (equal(data, hx('80010100'))) this.payloads.push(hx('81008100'));
      else if (equal(data, iasRequest(IAS_QUERIES[0]))) this.payloads.push(hx('0100840000010001020003000107'));
      else if (equal(data, iasRequest(IAS_QUERIES[1]))) this.payloads.push(hx('01008400000100010100000003'));
      else if (equal(data, iasRequest(IAS_QUERIES[2]))) this.payloads.push(hx('010084020100000003'));
      else if (equal(data, hx('80010201'))) { /* IAS close */ }
      else if (data.length === 5 && equal(data.slice(0, 4), hx('83090100'))) {
        this.hostCredits = data[4]; assert.ok(this.hostCredits > 0 && this.hostCredits <= 127); this.payloads.push(hx('8903810002'));
      }
      else if (equal(data, hx('83090201'))) this.closedCOMM = true;
      else {
        assert.equal(data[0], 3); assert.equal(data[1], 9); this.hostCredits += data[2];
        if (data.length > 3) {
          if (this.settings.grantEachData) this.payloads.push(b(9, 3, 1));
          else if (++this.grantAfter % 5 === 0) this.payloads.push(b(9, 3, 5));
          const n = data[3];
          if (n) { this.controls.push(toHex(data.slice(4, 4 + n))); if (this.controls.length === 2) this.payloads.push(b(9, 3, 14)); }
          this.stream = concat(this.stream, data.slice(4 + n));
          let next;
          while ((next = takeSCEP(this.stream))) { this.stream = next.rest; this.application(next.packet); }
        }
      }
      if (this.dropNextResponse) { this.dropNextResponse = false; return; }
      this.respond();
    } else if ((control & 15) === 1) {
      if (this.requestDisconnectOnPoll) {
        this.requestDisconnectOnPoll = false; this.queue(0x70, 0x53); return;
      }
      if (this.pendingPutReply !== undefined) {
        if (this.settings.dropReplyPolls-- > 0) return;
        const id = this.pendingPutReply; delete this.pendingPutReply; this.putReply(id);
      }
      this.respond();
    }
  }
}
// A real stop-and-wait peer model for retries. Retain each unacknowledged
// response and reject duplicate host I frames before any TinyTP accounting.
class RecoveryPeer extends Peer {
  inputDecoder = new FrameDecoder(); peerDuplicates = 0; pendingPeer = null;
  respond() {
    if (this.pendingPeer) { this.queued.push(this.pendingPeer.slice()); return; }
    super.respond();
    const decoder = new FrameDecoder(); decoder.feed(this.queued.at(-1));
    if (decoder.frames.length && !(decoder.frames[0].control & 1)) this.pendingPeer = this.queued.at(-1).slice();
  }
  async sendFrame(address, control, data, bof, opts) {
    const wire = encodeFrame(address, control, data, bof);
    const canonical = Uint8Array.of(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
    const actual = this.settings.faults?.outgoing(canonical) ?? canonical;
    this.inputDecoder.feed(actual.slice(4));
    const received = this.inputDecoder.frames.shift();
    if (!received) {
      this.txFrames++;
      if (this.settings.rejectFaultWithRR) this.queue(0x70, (this.nr << 5) | 0x11);
      return;
    }
    ({ address, control, data } = received);
    if (address === 0x71 && (control & 3) !== 3) {
      const nr = (control >>> 5) & 7;
      if (nr === this.ns) this.pendingPeer = null;
      else assert.equal(nr, (this.ns + 7) & 7, 'only one peer frame can remain unacknowledged');
      if (!(control & 1)) {
        const ns = (control >>> 1) & 7;
        if (ns === ((this.nr + 7) & 7)) {
          this.peerDuplicates++; this.txFrames++; this.respond(); return;
        }
        assert.equal(ns, this.nr, 'fresh host frames retain their sequence');
      }
    }
    return super.sendFrame(address, control, data, bof, opts);
  }
}
async function run(settings = {}, extra = {}) {
  const adapter = settings.recoveryPeer ? new RecoveryPeer(settings) : new Peer(settings), events = [];
  const record = (kind, data) => {
    settings.faults?.observe(kind, data);
    events.push({ kind, ...data }); extra.record?.(kind, data, adapter);
  };
  if (settings.faults) settings.faults.record = record;
  const sender = new IrTranPSender(adapter, { ...options, ...extra, record });
  if (settings.faults) {
    const incoming = sender.frame.bind(sender);
    sender.frame = frame => settings.faults.discardIncoming(frame) ? Promise.resolve() : incoming(frame);
  }
  const result = await sender.run(60000); return { adapter, events, result, sender };
}

for (const scenario of FAULT_CASES) test('link recovery completes exactly one PUT after ' + scenario, { timeout: 12000 }, async () => {
  const faults = new LinkFaults(scenario), input = await createFeatureFiles('single-10', '0000');
  const { adapter, result, events } = await run({ recoveryPeer: true, faults, expectedUPF: input.files[0].bytes },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 1, sendPDU: 0, maxBaud: 115200, linkRecovery: undefined });
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.putAccepted, 1);
  assert.equal(result.linkRecovery.enabled, true);
  assert.equal(result.putRequests, 1); assert.equal(adapter.uploads.length, 1);
  assert.equal(faults.summary().exercised, true);
  assert.equal(events.filter(e => e.kind === 'fault-injected').length, faults.required);
  const retries = events.filter(e => e.kind === 'irlap-data-retry');
  assert.equal(retries.length, faults.required);
  assert.equal(result.retransmissions, faults.required);
  assert.ok(retries.every(e => e.newApplicationRequest === false && e.sendNS === retries[0].sendNS && e.dataHex === retries[0].dataHex));
  assert.deepEqual(adapter.uploads[0].attributes.BDY0, input.files[0].bytes);
  if (scenario === 'drop-ack') assert.equal(adapter.peerDuplicates, 1);
  assert.ok(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink);
  assert.equal(result.pendingOutputBytes, 0); assert.equal(result.pendingUSBRead, false);
});

test('link recovery repeats RR after an acknowledged file without replaying its data', { timeout: 9000 }, async () => {
  const { adapter, result, events } = await run({ recoveryPeer: true, replyAfterPoll: true, dropReplyPolls: 1 }, { linkRecovery: true });
  assert.equal(result.status, 'sent'); assert.equal(adapter.uploads.length, 1); assert.equal(result.putRequests, 1);
  assert.equal(result.retransmissions, 0); assert.equal(result.linkRecoveryPolls, 1);
  assert.equal(events.filter(e => e.kind === 'irlap-turn-retry').length, 1);
});

test('RR with the previous N(R) requests an immediate retry without waiting for the timer', async () => {
  const faults = new LinkFaults('bad-crc');
  const { result, events, adapter } = await run({ recoveryPeer: true, faults, rejectFaultWithRR: true }, { linkRecovery: true });
  assert.equal(result.status, 'sent'); assert.equal(result.retransmissions, 1); assert.equal(result.linkTimeouts, 0);
  assert.equal(events.find(e => e.kind === 'irlap-data-retry').reason, 'peer-missing-frame');
  assert.equal(adapter.uploads.length, 1); assert.equal(result.putRequests, 1);
});

test('permanently corrupted information frames stop after three retries without submitting another PUT', { timeout: 9000 }, async () => {
  const faults = new LinkFaults('bad-crc'); faults.required = 99;
  const { adapter, result, events } = await run({ recoveryPeer: true, faults }, { linkRecovery: true });
  assert.equal(result.status, 'error'); assert.match(result.error.message, /retry limit/);
  assert.equal(result.retransmissions, 3); assert.equal(adapter.uploads.length, 0); assert.equal(result.putRequests, 1);
  assert.equal(events.filter(e => e.kind === 'irlap-data-retry').length, 3);
  assert.equal(result.complete, false);
});

test('sender sends an unchanged watch UPF in four 512-byte SCEP PDUs, waits for RPL0 and closes all layers', async () => {
  const { adapter, events, result } = await run();
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.uploadOutcome, 'accepted');
  assert.equal(result.putAccepted, 1); assert.equal(result.putReplies[0].storedFilename, 'MC000001.UPF');
  assert.equal(result.putSegments, 4); assert.equal(adapter.uploads.length, 1); assert.equal(result.badCRC, 0);
  assert.equal(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink, true);
  const stages = events.filter(e => e.kind === 'irtranp-phase').map(e => e.phase);
  assert.ok(stages.indexOf('send-accepted') < stages.indexOf('csi-scep-disconnect'));
  assert.equal(result.pendingUSBRead, false); assert.equal(result.pendingOutputBytes, 0);
});

test('a lost final RR turn is recovered without repeating PUT, then RPL0 precedes normal disconnect', { timeout: 9000 }, async () => {
  const { adapter, events, result } = await run({ replyAfterPoll: true, dropReplyPolls: 1 });
  assert.equal(result.status, 'sent'); assert.equal(result.putAccepted, 1);
  assert.equal(result.finalPollRetries, 1); assert.equal(adapter.uploads.length, 1);
  assert.equal(result.putRequests, 1); assert.equal(result.putSegments, 4);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  const retry = events.find(e => e.kind === 'irlap-final-repoll');
  assert.equal(retry.applicationBytesRepeated, false);
  const poll = events.find(e => e.kind === 'tx-frame' && e.purpose === 'csi-final-repoll');
  assert.equal(poll.control & 0x1f, 0x11); assert.equal(poll.dataHex, '');
  const accepted = events.findIndex(e => e.kind === 'put-reply');
  const close = events.findIndex(e => e.kind === 'tx-frame' && e.purpose === 'csi-scep-disconnect');
  assert.ok(accepted >= 0 && close > accepted);
  assert.equal(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink, true);
});

test('a silent watch gets at most three final RR retries and no second PUT', { timeout: 9000 }, async () => {
  const { adapter, events, result } = await run({ replyAfterPoll: true, dropReplyPolls: 100 });
  assert.equal(result.status, 'error'); assert.match(result.error.message, /timed out/);
  assert.equal(result.finalPollRetries, 3); assert.equal(result.putAccepted, 0);
  assert.equal(result.uploadOutcome, 'unconfirmed'); assert.equal(adapter.uploads.length, 1);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.equal(events.filter(e => e.kind === 'irlap-final-repoll').length, 3);
  assert.equal(adapter.closedSCEP, undefined); assert.equal(result.pendingUSBRead, false);
});

test('without an IrLAP acknowledgement the sender does not poll as though the file were acknowledged', { timeout: 9000 }, async () => {
  const { adapter, result } = await run({ dropLastDataAcknowledgement: true });
  assert.equal(result.status, 'error'); assert.equal(result.finalPollRetries, 0);
  assert.equal(result.uploadOutcome, 'unconfirmed'); assert.equal(adapter.uploads.length, 1);
  assert.equal(result.putAccepted, 0); assert.equal(result.pendingUSBRead, false);
});

test('peer RD after PUT 2 is answered with DISC/UA and cannot confirm the second file', async () => {
  const { adapter, result, events } = await run({ requestDisconnectAfterPUT: 2 }, { copyCount: 2 });
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.complete, false);
  assert.equal(result.error, null); assert.equal(result.disconnected, true);
  assert.equal(result.peerRequestedDisconnect.phase, 'send-put');
  assert.equal(result.putRequests, 2); assert.equal(result.putAccepted, 1);
  assert.equal(result.putReplies.length, 1); assert.equal(result.uploadOutcome, 'unconfirmed');
  assert.equal(adapter.uploads.length, 2); assert.equal(adapter.closedLink, true);
  assert.equal(adapter.closedSCEP, undefined); assert.equal(result.withheldOutputBytes, 0);
  const rd = events.findIndex(e => e.kind === 'irlap-peer-disconnect-request');
  assert.ok(rd >= 0);
  const after = events.slice(rd + 1).filter(e => e.kind === 'tx-frame');
  assert.deepEqual(after.map(e => e.control), [0x53]); assert.equal(after[0].dataHex, '');
  assert.equal(events.filter(e => e.kind === 'put-started').length, 2);
  const report = await analyseAttempt({ id: 'rd-test', kind: 'irtranp', test: 'sender', status: result.status, result },
    [{ kind: 'receiver-manual-start', elapsedMs: 0 }, ...events]);
  assert.equal(report.verdict, 'incomplete');
});

test('peer RD during a segmented PUT withholds unsent bytes and closes only the link', async () => {
  const { adapter, result, events } = await run({ requestDisconnectAtSegment: 1 });
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.error, null);
  assert.equal(result.complete, false); assert.equal(result.disconnected, true);
  assert.equal(result.putAccepted, 0); assert.equal(result.uploadOutcome, 'unconfirmed');
  assert.ok(result.withheldOutputBytes > 0); assert.equal(result.pendingOutputBytes, 0);
  assert.equal(adapter.putPackets.length, 1); assert.equal(adapter.uploads.length, 0);
  assert.equal(adapter.closedLink, true); assert.equal(adapter.closedSCEP, undefined);
  const rd = events.findIndex(e => e.kind === 'irlap-peer-disconnect-request');
  assert.deepEqual(events.slice(rd + 1).filter(e => e.kind === 'tx-frame').map(e => e.control), [0x53]);
});

test('sender matches the original CSI one-segment PUT at the peer limit', async () => {
  const { adapter, result } = await run({}, { sendPDU: 0 });
  assert.equal(result.status, 'sent'); assert.equal(result.putSegments, 1);
  assert.equal(toHex(adapter.putPackets[0]), toHex(originalPUT));
});

test('two files at the negotiated size match CSI with the original watch CACK unchanged', { timeout: 12000 }, async () => {
  const csi = JSON.parse(await readFile(new URL('./csi-multiple-negotiated-fixture.json', import.meta.url)));
  const input = await createFeatureFiles('multiple-csi', 'FFFF'), suite = createSuite('multiple-csi');
  assert.equal(csi.syntheticNegotiation, null); assert.equal(csi.portOpens, 1);
  assert.equal(toHex(originalRX[0]), csi.peerCackHex);
  assert.deepEqual(input.files.map(file => ({ filename: file.filename, bytes: file.bytes.length, sha256: file.sha256 })), csi.files);
  assert.equal(input.reusedInput, true); assert.equal(input.nonce, '07FB');
  assert.equal(suite.steps.length, 3); assert.equal(suite.steps[0].test, 'sender');
  assert.equal(suite.steps[0].copyCount, 2); assert.equal(suite.steps[0].sendPDU, 0);
  assert.equal(suite.steps[0].maxBaud, 9600); assert.equal(suite.steps[0].watchMode, 'others-receive');
  assert.deepEqual(suite.steps.slice(1).map(step => [step.test, step.watchMode, step.feature.copyIndex]),
    [['receiver', 'others-send', 0], ['receiver', 'others-send', 1]]);
  const { adapter, result, events } = await run({ expectedUPFs: input.files.map(file => file.bytes) },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 2, sendPDU: 0, maxBaud: 9600 });
  assert.equal(result.status, 'sent'); assert.equal(result.putAccepted, 2);
  assert.equal(result.putSegments, 5); assert.equal(result.ircommConnections, 1);
  assert.deepEqual(adapter.putPackets.map(toHex), csi.putPackets);
  assert.deepEqual(adapter.putPackets.map(packet => packet.length), [2048, 2048, 172, 2048, 1820]);
  assert.deepEqual(adapter.uploads.map(request => request.id), [3, 4]);
  assert.deepEqual(events.filter(event => event.kind === 'put-started').map(event => event.scepMaxPDU), [2048, 2048]);
  assert.deepEqual([...new Set(adapter.speeds)], [9600]); assert.equal(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink, true);
});

test('CE 2.11 transport carries the same five original CSI packets in larger frames and one two-file session', { timeout: 12000 }, async () => {
  const csi = JSON.parse(await readFile(new URL('./csi-multiple-negotiated-fixture.json', import.meta.url)));
  const input = await createFeatureFiles('multiple-wince211', 'FFFF');
  assert.deepEqual(input.files.map(file => ({ filename: file.filename, bytes: file.bytes.length, sha256: file.sha256 })), csi.files);
  const { adapter, result, events } = await run({ expectedUPFs: input.files.map(file => file.bytes), grantEachData: true, validateNR: true,
    uaParameters: '01010282010183013f840101850180860103080107' },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 2, sendPDU: 0, maxBaud: 9600, transportProfile: 'wince211' });
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.putAccepted, 2);
  assert.equal(result.transportProfile, 'wince211'); assert.equal(result.linkQoS.dataBytes, 256);
  assert.equal(result.linkQoS.applicationChunkBytes, 251); assert.equal(result.linkQoS.minTurnUs, 5000);
  assert.equal(result.ircommConnections, 1); assert.deepEqual(adapter.putPackets.map(toHex), csi.putPackets);
  assert.deepEqual(adapter.controls, []); assert.deepEqual(adapter.uploads.map(req => req.id), [3, 4]);
  assert.equal(events.filter(e => e.kind === 'tx-frame' && e.dataHex === '8309010004').length, 1);
  const fragments = events.filter(e => e.kind === 'tx-frame' && e.purpose === 'csi-put');
  assert.ok(fragments.length < 50); assert.equal(Math.max(...fragments.map(e => e.dataHex.length / 2 - 4)), 251);
  assert.ok(adapter.sent.filter(f => !(f.control & 1)).every(f => f.data.length <= 256));
  assert.equal(events.some(e => e.kind === 'tx-frame' && e.purpose === 'ias-reply-ack'), false);
  assert.ok(events.some(e => e.kind === 'irlap-direct-advance'));
  assert.deepEqual([...new Set(adapter.speeds)], [9600]); assert.ok(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink);
  const report = await analyseAttempt({ id: 'ce-two-files', test: 'sender', status: result.status, result,
    transportProfile: 'wince211', upload: { files: input.files, copyCount: 2 } }, events);
  assert.equal(report.transportProfile, 'wince211'); assert.equal(report.applicationChunkBytes, 251);
  assert.equal(report.storageVerification.status, 'not-checked-in-this-attempt');
});

test('CE transport still reports incomplete if the watch closes after the second PUT', { timeout: 10000 }, async () => {
  const input = await createFeatureFiles('multiple-wince211', 'FFFF');
  const { adapter, result, events } = await run({ expectedUPFs: input.files.map(file => file.bytes), grantEachData: true,
    requestDisconnectAfterPUT: 2, validateNR: true },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 2, sendPDU: 0, maxBaud: 9600, transportProfile: 'wince211' });
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.complete, false); assert.equal(result.putAccepted, 1);
  assert.equal(result.putRequests, 2); assert.equal(adapter.uploads.length, 2);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 2);
  assert.equal(result.peerRequestedDisconnect.phase, 'send-put'); assert.equal(adapter.closedLink, true);
  assert.equal(result.pendingOutputBytes, 0);
});

test('two-second PUT gap keeps polling one connection without changing the five original CSI packets', { timeout: 12000 }, async () => {
  const csi = JSON.parse(await readFile(new URL('./csi-multiple-negotiated-fixture.json', import.meta.url)));
  const input = await createFeatureFiles('multiple-wince211', 'FFFF'), times = [];
  const { adapter, result, events } = await run({ expectedUPFs: input.files.map(file => file.bytes), grantEachData: true,
    validateNR: true, uaParameters: '01010282010183013f840101850180860103080107' },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 2, sendPDU: 0, maxBaud: 9600,
      transportProfile: 'wince211', interPutDelayMs: 2000,
      record: (kind, data) => times.push({ kind, ...data, atMs: performance.now() }) });
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.putAccepted, 2);
  assert.equal(result.interPutDelayMs, 2000); assert.equal(result.interPutGaps.length, 1);
  const gap = result.interPutGaps[0];
  assert.equal(gap.completed, true); assert.equal(gap.afterCommandID, 3); assert.equal(gap.nextCommandID, 4);
  assert.ok(gap.elapsedMs >= 2000 && gap.elapsedMs < 4000); assert.ok(gap.polls >= 5);
  const started = events.findIndex(e => e.kind === 'put-gap-started'), ended = events.findIndex(e => e.kind === 'put-gap-ended');
  const during = events.slice(started + 1, ended);
  assert.equal(during.some(e => e.kind === 'application-tx-queued' || e.kind === 'put-started'), false);
  const polls = during.filter(e => e.kind === 'tx-frame' && e.purpose === 'csi-poll');
  assert.equal(polls.length, gap.polls);
  assert.ok(polls.every(e => e.dataHex === '' && (e.control & 0x1f) === 0x11));
  const timedPolls = times.filter(e => e.kind === 'put-gap-poll');
  assert.ok(timedPolls.every((e, i) => i === 0 || e.atMs - timedPolls[i - 1].atMs < 500));
  assert.ok(times.find(e => e.kind === 'put-started' && e.id === 4).atMs -
    times.find(e => e.kind === 'put-reply' && e.id === 3).atMs >= 2000);
  assert.equal(result.ircommConnections, 1); assert.equal(result.connectionAttempts, 1);
  assert.equal(events.filter(e => e.kind === 'application-tx-queued' && e.purpose === 'csi-scep-connect').length, 1);
  assert.deepEqual(adapter.putPackets.map(toHex), csi.putPackets);
  assert.deepEqual(adapter.uploads.map(req => req.id), [3, 4]);
  assert.ok(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink);
});

test('peer RD during the PUT gap closes the link without sending a second file', { timeout: 6000 }, async () => {
  const { adapter, result, events } = await run({ grantEachData: true, validateNR: true },
    { copyCount: 2, maxBaud: 9600, transportProfile: 'wince211', interPutDelayMs: 2000,
      record: (kind, data, peer) => { if (kind === 'put-gap-started') peer.requestDisconnectOnPoll = true; } });
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.complete, false);
  assert.equal(result.putRequests, 1); assert.equal(result.putAccepted, 1); assert.equal(adapter.uploads.length, 1);
  assert.equal(result.interPutGaps[0].completed, false);
  assert.equal(result.peerRequestedDisconnect.phase, 'send-between-put'); assert.equal(adapter.closedLink, true);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.equal(events.some(e => e.kind === 'put-gap-ended'), false); assert.equal(result.pendingOutputBytes, 0);
});

test('Stop during the PUT gap leaves the second file unsent and retains the interrupted pause', { timeout: 6000 }, async () => {
  const controller = new AbortController();
  const { adapter, result, events } = await run({ grantEachData: true },
    { copyCount: 2, maxBaud: 9600, transportProfile: 'wince211', interPutDelayMs: 2000, signal: controller.signal,
      record: kind => { if (kind === 'put-gap-poll') controller.abort(); } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.complete, false);
  assert.equal(result.putRequests, 1); assert.equal(adapter.uploads.length, 1);
  assert.equal(result.interPutGaps[0].completed, false); assert.equal(result.interPutGaps[0].polls, 1);
  assert.equal(events.some(e => e.kind === 'put-gap-ended'), false); assert.equal(result.pendingOutputBytes, 0);
});

test('a rejected PUT never starts the inter-file pause or a second file', async () => {
  const { adapter, result, events } = await run({ reject: true }, { copyCount: 2, interPutDelayMs: 2000 });
  assert.equal(result.status, 'send-rejected'); assert.equal(result.putRequests, 1);
  assert.equal(adapter.uploads.length, 1); assert.deepEqual(result.interPutGaps, []);
  assert.equal(events.some(e => e.kind === 'put-gap-started'), false);
});

test('PUT pause configuration is bounded and requires a two-file request', () => {
  for (const interPutDelayMs of [-1, 5001, 0.5, '2000', NaN, Infinity]) {
    assert.throws(() => new IrTranPSender(new Peer(), { ...options, copyCount: 2, interPutDelayMs }), /pause/);
  }
  assert.throws(() => new IrTranPSender(new Peer(), { ...options, interPutDelayMs: 2000 }), /pause/);
});

test('sender also accepts a one-segment 41/RestNo=1 reply after full command validation', async () => {
  const { result } = await run({ singleSegmentACK: true });
  assert.equal(result.status, 'sent'); assert.equal(result.putAccepted, 1); assert.equal(result.pendingBytes, 0);
});

test('the standalone receiver processes CSI one-segment PUT instead of waiting for a nonexistent last segment', async () => {
  const adapter = new Peer(), received = [];
  const receiver = new IrTranPReceiver(adapter, { localID: LOCAL, onFile: async f => received.push(f) });
  receiver.peerSCEP = { primaryID: WATCH, maxPDU: 2048 }; receiver.chunkSize = 60;
  const body = putCommand(UPF, 'QW000000.UPF', { id: 3, destination: CSI, source: WATCH });
  const packet = csiPutPackets(body, 2048)[0];
  for (let i = 0; i < packet.length; i += 17) await receiver.applicationBytes(packet.slice(i, i + 17));
  assert.equal(received.length, 1); assert.deepEqual(received[0].bytes, UPF); assert.equal(receiver.partBytes, 0);
  assert.equal(receiver.application.length, 0); assert.equal(receiver.stats.files, 1);
});

test('two copies require RCMD support and use distinct command IDs in the same SCEP connection', async () => {
  const good = await run({}, { copyCount: 2 });
  assert.equal(good.result.status, 'sent'); assert.equal(good.result.putAccepted, 2);
  assert.deepEqual(good.adapter.uploads.map(r => r.id), [3, 4]);
  const blocked = await run({ singlePUT: true }, { copyCount: 2 });
  assert.equal(blocked.result.status, 'send-rejected'); assert.equal(blocked.result.uploadOutcome, 'rejected');
  assert.equal(blocked.adapter.uploads.length, 0); assert.equal(blocked.result.putRequests, 0);
  assert.match(blocked.result.policyRejection, /multiple PUT/); assert.equal(blocked.result.complete, true);
});

test('photo 10 alone closes SCEP after its sole acknowledgement, with no second PUT', async () => {
  const input = await createFeatureFiles('single-10', '0000');
  const { adapter, result, events } = await run({ expectedUPF: input.files[0].bytes },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 1, sendPDU: 512,
      maxBaud: 9600, transportProfile: 'current' });
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true);
  assert.equal(result.putRequests, 1); assert.equal(result.putAccepted, 1); assert.equal(result.requestedCopies, 1);
  assert.equal(adapter.uploads.length, 1); assert.equal(adapter.uploads[0].id, 3);
  assert.equal(new TextDecoder().decode(adapter.uploads[0].attributes.FIL0), 'IR000010.UPF');
  assert.deepEqual(adapter.uploads[0].attributes.BDY0, input.files[0].bytes);
  assert.ok(adapter.putPackets.every(packet => packet.length <= 512));
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.deepEqual(result.interPutGaps, []);
  const accepted = events.findIndex(e => e.kind === 'put-reply');
  const closing = events.findIndex(e => e.kind === 'application-tx-queued' && e.purpose === 'csi-scep-disconnect');
  assert.ok(accepted >= 0 && closing > accepted);
  assert.ok(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink);
  assert.equal(result.pendingOutputBytes, 0); assert.equal(result.pendingUSBRead, false);
});

test('photo 10 alone negotiates 115200 and uses the peer 2048-byte SCEP limit, then closes normally', async () => {
  const input = await createFeatureFiles('single-10', '0000');
  const csi = JSON.parse(await readFile(new URL('./csi-multiple-negotiated-fixture.json', import.meta.url)));
  const { adapter, result, events } = await run({ expectedUPF: input.files[0].bytes },
    { sendFile: input.files[0], sendFiles: input.files, copyCount: 1, sendPDU: 0,
      maxBaud: 115200, transportProfile: 'current' });
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.putAccepted, 1);
  assert.equal(result.putRequests, 1); assert.equal(result.putSegments, 3);
  assert.equal(events.find(e => e.kind === 'irlap-connected').baud, 115200);
  assert.ok(events.filter(e => e.kind === 'tx-frame' && e.purpose === 'csi-put').every(e => e.baud === 115200));
  assert.ok(events.filter(e => e.kind === 'tx-frame' && e.purpose === 'xid-search').every(e => e.baud === 9600));
  assert.equal(events.find(e => e.kind === 'put-started').scepMaxPDU, 2048);
  assert.deepEqual(adapter.putPackets.map(toHex), csi.putPackets.slice(0, 3));
  assert.deepEqual(adapter.uploads[0].attributes.BDY0, input.files[0].bytes);
  assert.deepEqual(adapter.speeds, [115200, 9600]);
  assert.ok(adapter.closedSCEP && adapter.closedCOMM && adapter.closedLink);
  assert.equal(result.pendingOutputBytes, 0); assert.equal(result.pendingUSBRead, false);
});

test('a 115200 speed limit still accepts a peer that only offers 9600', async () => {
  const { adapter, result, events } = await run({ uaParameters: '01010282010183013f84010f85018086028003080104' },
    { copyCount: 1, sendPDU: 0, maxBaud: 115200 });
  assert.equal(result.status, 'sent'); assert.equal(result.putRequests, 1);
  assert.equal(events.find(e => e.kind === 'irlap-connected').baud, 9600);
  assert.deepEqual([...new Set(adapter.speeds)], [9600]);
});

test('a peer file-size limit is enforced before the first PUT', async () => {
  const { result, adapter } = await run({ smallLimit: true });
  assert.equal(result.status, 'send-rejected'); assert.match(result.policyRejection, /receive limit/);
  assert.equal(adapter.putPackets.length, 0); assert.equal(result.complete, true);
});

test('NACK records the original error and closes without repeating PUT or sending copy two', async () => {
  const { result, adapter } = await run({ reject: true }, { copyCount: 2 });
  assert.equal(result.status, 'send-rejected'); assert.equal(result.putReplies[0].errorCode, 0x20);
  assert.equal(result.putRejected, 1); assert.equal(result.putAccepted, 0); assert.equal(adapter.uploads.length, 1);
  assert.equal(result.complete, true); assert.equal(adapter.closedSCEP && adapter.closedLink, true);
});

test('unrelated or premature ACK cannot mark an upload successful', async () => {
  for (const settings of [{ wrongID: true }, { premature: true }]) {
    const { result } = await run(settings);
    assert.equal(result.status, 'error'); assert.equal(result.putAccepted, 0); assert.equal(result.uploadOutcome, 'unconfirmed');
    assert.match(result.error.message, /identity|Premature/);
  }
});

test('Stop during a pending USB read after PUT keeps the outcome unconfirmed and never retries', { timeout: 2500 }, async () => {
  const controller = new AbortController();
  const { result, adapter } = await run({ noReply: true, abort: () => controller.abort() }, { signal: controller.signal });
  assert.equal(result.status, 'interrupted'); assert.equal(result.uploadOutcome, 'unconfirmed');
  assert.equal(result.putAccepted, 0); assert.equal(adapter.uploads.length, 1); assert.equal(adapter.opened, false);
  assert.equal(result.pendingUSBRead, true);
});

test('a synthetic 64 KiB UPF body crosses many sequence and credit windows without changing bytes', { timeout: 20000 }, async () => {
  // Original image header and JPEG, followed by synthetic padding; transport
  // stress fixture only. This file is never selected for a hardware test.
  const padded = concat(UPF, new Uint8Array(65536));
  const { result, adapter } = await run({ expectedUPF: padded }, { sendFile: { bytes: padded, filename: 'QW000000.UPF' } });
  assert.equal(result.status, 'sent'); assert.equal(result.putAccepted, 1); assert.ok(result.putSegments > 128);
  assert.equal(await sha256(adapter.uploads[0].attributes.BDY0), await sha256(padded));
  assert.equal(result.pendingOutputBytes, 0);
});

test('PUT reply needs matching bFTP PID, stored-filename type and original command ID', () => {
  const reply = makeCommand([attribute('RPL0', ascii('MC000001.UPF'), true)], { id: 3, reply: 0x40, destination: CSI, source: WATCH });
  const badType = reply.slice(); badType[38] = 0;
  assert.throws(() => parsePutReply(badType, { id: 3, destination: CSI, source: WATCH }), /attribute type/);
  const badPID = reply.slice(); badPID[23] = 9;
  assert.throws(() => parsePutReply(badPID, { id: 3, destination: CSI, source: WATCH }), /identifier/);
});

test('ZIP keeps the selected upload bytes separately; analysis cannot confuse a file selection with a confirmed write', async () => {
  const { result, events } = await run();
  const attempt = { id: 'send-test', kind: 'irtranp', test: 'sender', status: 'sent', startedAt: '2026-10-24T00:00:00Z', result,
    upload: { filename: 'QW000000.UPF', sha256: await sha256(UPF), copyCount: 1 } };
  const recorded = [{ kind: 'receiver-manual-start', elapsedMs: 0 },
    { kind: 'irtranp-upload-file', filename: 'QW000000.UPF', dataHex: toHex(UPF) }, ...events];
  const files = new Map(attemptFiles(attempt, recorded).map(f => [f.name, f.data]));
  assert.deepEqual(files.get('upload-input/000-QW000000.UPF'), UPF);
  assert.equal([...files.keys()].some(k => k.startsWith('files/')), false);
  assert.match(new TextDecoder().decode(files.get('README.txt')), /WRITES/);
  const report = await analyseAttempt(attempt, recorded);
  assert.equal(report.verdict, 'passed'); assert.equal(report.uploads[0].upfSHA256, attempt.upload.sha256);
  assert.deepEqual(report.storageVerification, { status: 'not-checked-in-this-attempt', protocolAcknowledged: true, requiredReadbackPhotos: 1 });
  assert.equal(report.files.length, 0); assert.equal(report.putReplies[0].accepted, true);
  const noReply = await analyseAttempt(attempt, recorded.filter(e => e.kind !== 'put-reply'));
  assert.equal(noReply.verdict, 'incomplete');
  assert.equal(noReply.storageVerification.status, 'not-checked-in-this-attempt');
  assert.equal(noReply.storageVerification.protocolAcknowledged, false);
  const badHash = await analyseAttempt({ ...attempt, upload: { ...attempt.upload, sha256: 'bad' } }, recorded);
  assert.equal(badHash.verdict, 'incomplete');
});

test('the successful OTHERS RECEIVE upload replays original USB chunks and all 112 transmitted frames', { timeout: 16000 }, async () => {
  const captured = JSON.parse(await readFile(new URL('./sender-hardware-fixture.json', import.meta.url)));
  const adapter = new Peer(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, transportOptions) => {
    assert.equal(adapter.readPending, false); assert.equal(transportOptions.receive, false);
    const group = captured.groups[groupIndex++]; assert.ok(group, 'No extra transmission after clean close');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.txFrames++; adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const result = await new IrTranPSender(adapter, { ...options, localID: hx(captured.localID), maxBaud: 9600,
    frameRecovery: 'pad5-bof', sendPDU: 512, record: (kind, detail) => events.push({ kind, ...detail }) }).run(15000);
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.disconnected, true);
  assert.equal(groupIndex, 112); assert.equal(result.validFrames, 106); assert.equal(result.rxBytes, 1259);
  assert.equal(result.badCRC, 0); assert.equal(result.recoveredBOF, 8); assert.equal(result.recoveredFrames, 8);
  assert.equal(result.putAccepted, 1); assert.equal(result.putSegments, 4);
  assert.deepEqual(result.putReplies, captured.result.putReplies);
  assert.equal(result.pendingUSBRead, false); assert.equal(result.pendingBytes, 0); assert.equal(result.pendingOutputBytes, 0);
  assert.equal(events.filter(e => e.kind === 'put-reply').length, 1);
});

test('real numbered-image upload recovers one lost RR turn, receives RPL0 and replays all 198 frames', { timeout: 16000 }, async () => {
  const captured = JSON.parse(await readFile(new URL('./sender-final-repoll-hardware-fixture.json', import.meta.url)));
  const adapter = new Peer(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, transportOptions) => {
    assert.equal(adapter.readPending, false); assert.equal(transportOptions.receive, false);
    const group = captured.groups[groupIndex++]; assert.ok(group, 'No extra frame or duplicate upload');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.txFrames++; adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const input = hx(captured.input.dataHex);
  assert.equal(await sha256(input), captured.input.sha256);
  const result = await new IrTranPSender(adapter, { ...options, sendFile: { bytes: input, filename: captured.input.filename },
    localID: hx(captured.localID), maxBaud: 9600, frameRecovery: 'pad5-bof', sendPDU: 512,
    record: (kind, detail) => events.push({ kind, ...detail }) }).run(15000);
  assert.equal(result.status, 'sent'); assert.equal(result.complete, true); assert.equal(result.disconnected, true);
  assert.equal(groupIndex, 198); assert.equal(result.validFrames, 194); assert.equal(result.rxBytes, 1920);
  assert.equal(result.badCRC, 0); assert.equal(result.recoveredFrames, 22); assert.equal(result.recoveredBOF, 22);
  assert.equal(result.putRequests, 1); assert.equal(result.putSegments, 9); assert.equal(result.putAccepted, 1);
  assert.equal(result.finalPollRetries, 1); assert.deepEqual(result.putReplies, captured.result.putReplies);
  assert.equal(events.filter(e => e.kind === 'irlap-final-repoll').length, 1);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.equal(result.pendingUSBRead, false); assert.equal(result.pendingOutputBytes, 0);
});

test('real two-file NG capture closes RD with DISC/UA but remains incomplete after only one PUT reply', { timeout: 22000 }, async () => {
  const captured = JSON.parse(await readFile(new URL('./multiple-rd-hardware-fixture.json', import.meta.url)));
  const adapter = new Peer(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, transportOptions) => {
    assert.equal(adapter.readPending, false); assert.equal(transportOptions.receive, false);
    const group = captured.groups[groupIndex++]; assert.ok(group, 'No extra frame or repeated PUT');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.txFrames++; adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const files = captured.inputs.map(file => ({ filename: file.filename, bytes: hx(file.dataHex) }));
  const result = await new IrTranPSender(adapter, { ...options, sendFile: files[0], sendFiles: files, copyCount: 2,
    localID: hx(captured.localID), maxBaud: 9600, frameRecovery: 'pad5-bof', sendPDU: 512,
    record: (kind, detail) => events.push({ kind, ...detail }) }).run(20000);
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.complete, false); assert.equal(result.error, null);
  assert.equal(result.disconnected, true); assert.equal(result.putAccepted, 1); assert.equal(result.putRequests, 2);
  assert.equal(result.uploadOutcome, 'unconfirmed'); assert.equal(result.peerRequestedDisconnect.phase, 'send-put');
  assert.equal(groupIndex, 336); assert.equal(result.validFrames, 331); assert.equal(result.rxBytes, 2948);
  assert.equal(result.badCRC, 0); assert.equal(result.recoveredBOF, 45); assert.equal(result.finalPollRetries, 1);
  assert.deepEqual(result.putReplies, captured.result.putReplies);
  const report = await analyseAttempt({ id: 'hardware-ng', kind: 'irtranp', test: 'sender', status: result.status,
    result, upload: { copyCount: 2 } }, [{ kind: 'receiver-manual-start', elapsedMs: 0 }, ...events]);
  assert.equal(report.verdict, 'incomplete'); assert.equal(report.cleanDisconnect, true);
  assert.equal(report.storageVerification.protocolAcknowledged, false);
});

test('real CE 2.11 transport capture replays all 74 frames and retains the incomplete two-PUT outcome', { timeout: 22000 }, async () => {
  const captured = JSON.parse(await readFile(new URL('./wince211-hardware-fixture.json', import.meta.url)));
  const adapter = new Peer(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, transportOptions) => {
    assert.equal(adapter.readPending, false); assert.equal(transportOptions.receive, false);
    const group = captured.groups[groupIndex++]; assert.ok(group, 'No extra frame or repeated PUT');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.txFrames++; adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const files = await Promise.all(captured.inputs.map(async file => {
    const bytes = hx(file.dataHex); assert.equal(await sha256(bytes), file.sha256);
    return { filename: file.filename, bytes };
  }));
  const result = await new IrTranPSender(adapter, { ...options, sendFile: files[0], sendFiles: files, copyCount: 2,
    localID: hx(captured.localID), maxBaud: 9600, frameRecovery: 'pad5-bof', sendPDU: 0, transportProfile: 'wince211',
    record: (kind, detail) => events.push({ kind, ...detail }) }).run(20000);
  assert.equal(result.status, 'send-incomplete'); assert.equal(result.complete, false); assert.equal(result.error, null);
  assert.equal(result.disconnected, true); assert.equal(result.putAccepted, 1); assert.equal(result.putRequests, 2);
  assert.equal(result.uploadOutcome, 'unconfirmed'); assert.equal(result.peerRequestedDisconnect.phase, 'send-put');
  assert.equal(groupIndex, 74); assert.equal(result.validFrames, 55); assert.equal(result.rxBytes, 944);
  assert.equal(result.badCRC, 0); assert.equal(result.recoveredBOF, 8); assert.equal(result.finalPollRetries, 0);
  assert.equal(result.transportProfile, 'wince211'); assert.deepEqual(result.linkQoS, captured.result.linkQoS);
  assert.deepEqual(result.putReplies, captured.result.putReplies);
  const report = await analyseAttempt({ id: 'ce-hardware', kind: 'irtranp', test: 'sender', status: result.status,
    result, transportProfile: 'wince211', upload: { copyCount: 2 } }, [{ kind: 'receiver-manual-start', elapsedMs: 0 }, ...events]);
  assert.equal(report.verdict, 'incomplete'); assert.equal(report.cleanDisconnect, true);
  assert.equal(report.storageVerification.protocolAcknowledged, false);
});

test('optional file attributes and UPF metadata reach the peer with the exact selected body', async () => {
  const body = metadataUPF(jpegFromUPF(UPF), { title: 'TITLE', comment: 'COMMENT' });
  const { result, adapter } = await run({ expectedUPF: body }, { sendFile: { bytes: body, filename: 'IR000007.UPF',
    transferMetadata: { time: '20010203040506', longName: 'A long name.UPF' } } });
  assert.equal(result.status, 'sent');
  assert.equal(new TextDecoder().decode(adapter.uploads[0].attributes.TIM0), '20010203040506');
  assert.equal(new TextDecoder().decode(adapter.uploads[0].attributes.LFL0), 'A long name.UPF');
});

test('two PUTs can carry two distinct saved bodies and filenames in one connection', async () => {
  const first = metadataUPF(jpegFromUPF(UPF), { title: 'FIRST' }), second = metadataUPF(jpegFromUPF(UPF), { title: 'SECOND' });
  const { result, adapter, events } = await run({ expectedUPFs: [first, second] }, { copyCount: 2,
    sendFiles: [{ filename: 'IR000010.UPF', bytes: first }, { filename: 'IR000011.UPF', bytes: second }] });
  assert.equal(result.putAccepted, 2); assert.equal(result.complete, true);
  assert.deepEqual(adapter.uploads.map(req => new TextDecoder().decode(req.attributes.FIL0)), ['IR000010.UPF', 'IR000011.UPF']);
  const inputs = [first, second], hashes = await Promise.all(inputs.map(sha256));
  const attempt = { id: 'two-files', kind: 'irtranp', test: 'sender', status: 'sent', result,
    upload: { copyCount: 2, files: hashes.map(sha256 => ({ sha256 })) } };
  const recorded = [{ kind: 'receiver-manual-start' }, ...inputs.map((bytes, index) => ({ kind: 'irtranp-upload-file',
    filename: index ? 'IR000011.UPF' : 'IR000010.UPF', dataHex: toHex(bytes) })), ...events];
  assert.equal((await analyseAttempt(attempt, recorded)).verdict, 'passed');
  attempt.upload.files[1].sha256 = 'wrong';
  assert.equal((await analyseAttempt(attempt, recorded)).verdict, 'incomplete');
});

test('SCEP Stop sends only the first segment, discards the remaining PUT output and closes normally', async () => {
  const { result, adapter, events } = await run({}, { abortMode: 'stp' });
  assert.equal(result.status, 'cancel-observed'); assert.equal(result.complete, true);
  assert.equal(adapter.stopReceived, true); assert.equal(adapter.putPackets.length, 1); assert.equal(adapter.uploads.length, 0);
  assert.equal(result.putAccepted, 0); assert.equal(result.pendingOutputBytes, 0);
  assert.equal(result.cancellation.sent, true); assert.equal(result.cancellation.totalSegments, 4);
  assert.equal(events.filter(e => e.kind === 'scep-cancel-transmitted').length, 1);
  assert.equal(adapter.closedCOMM && adapter.closedSCEP && adapter.closedLink, true);
});

test('an unexpected positive response to a partial request cannot confirm a stopped upload', async () => {
  const { result, adapter } = await run({ premature: true }, { abortMode: 'stp' });
  assert.equal(result.status, 'cancel-observed'); assert.equal(result.putAccepted, 0);
  assert.equal(adapter.uploads.length, 0); assert.equal(result.cancellation.responses[0].accepted, true);
});

test('SCEP Abort targets the completed PUT request and keeps the peer abort error separately', async () => {
  const { result, adapter } = await run({ delayPUT: true }, { abortMode: 'abt' });
  assert.equal(result.status, 'cancel-observed'); assert.equal(result.complete, true);
  assert.equal(adapter.abortReceived, true); assert.equal(result.cancellation.sent, true);
  assert.equal(result.cancellation.responses[0].errorCode, 0x31); assert.equal(result.putAccepted, 0);
  assert.equal(adapter.uploads.length, 1, 'Abort does not roll back a stored file in the test peer');
});

test('a PUT reply arriving before Abort is recorded as too late and cancellation is not claimed', async () => {
  const { result, adapter, events } = await run({}, { abortMode: 'abt' });
  assert.equal(result.status, 'sent'); assert.equal(result.putAccepted, 1);
  assert.equal(result.cancellation.skipped, true); assert.equal(result.cancellation.sent, false);
  assert.equal(adapter.abortReceived, undefined); assert.equal(events.filter(e => e.kind === 'scep-cancel-too-late').length, 1);
});
