import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IrTranPCSIProbe, CSI_QUERIES, csiConnect, csiCapabilityQuery, ircommServiceTypes, parseCSICack } from '../dist/irtranp-csi.mjs';
import { IAS_QUERIES, iasRequest } from '../dist/irtranp-ias.mjs';
import { compactSCEP, takeSCEP } from '../dist/irtranp-core.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, concat, ascii, fromHex as hx, toHex, equal } from '../dist/formats.mjs';
import { attemptFiles } from '../dist/research-core.mjs';

const fixture = JSON.parse(await readFile(new URL('./csi-fixtures.json', import.meta.url)));
const LOCAL = hx('12345678'), PEER = hx('193666be'), CSI = hx(fixture.csiMachineID), WATCH = hx(fixture.peerMachineID);
const PARAMS = hx('0100840000010001020003000107'), MISSING = hx('010084020100000003');
const UA_PARAMS = hx('01013e82010183013f84010f85018086028003080104');
function cack() {
  const packet = hx(fixture.session[1].hex); packet.set(CSI, 6); packet.set(WATCH, 14); return packet;
}
function capabilityReply(index) {
  const packet = hx(fixture.session[3 + 2 * index].hex);
  // Original CSI receiver reply, with the explicit synthetic peer identities
  // reversed for this outgoing client. This is not a watch capture.
  packet.set(CSI, 14); packet.set(WATCH, 22); return packet;
}

test('CSI Connect and all three outgoing queries match the original DLL packets', () => {
  assert.equal(toHex(csiConnect()), fixture.senderConnect);
  for (const [i, name] of CSI_QUERIES.entries()) {
    assert.equal(toHex(compactSCEP(csiCapabilityQuery(name, WATCH))[0]), fixture.sendQueries[i].hex);
  }
  assert.throws(() => csiCapabilityQuery('PUT', WATCH), /Invalid/);
  assert.equal(ircommServiceTypes(hx('000107')), 7);
  assert.equal(ircommServiceTypes(hx('000106010101')), 6);
  for (const raw of ['00', '0002ff', '000104000104', '010101']) assert.throws(() => ircommServiceTypes(hx(raw)), /IrCOMM/);
  assert.equal(parseCSICack(cack()).maxPDU, 4096);
  assert.deepEqual(parseCSICack(cack()).secondaryID, WATCH);
  const invalid = cack(); invalid[6] ^= 1;
  assert.throws(() => parseCSICack(invalid), /CACK/);
});

class Adapter {
  opened = true; configured = true; baud = 9600; revision = 7; readerTask = null; inEndpoint = 2;
  decoder = new FrameDecoder({ recoverFrames: true }); readPending = false; rxBytes = 0; txFrames = 0;
  sent = []; speeds = []; queued = []; payloads = []; ns = 0; nr = 0; finalSent = false; stream = b();
  requests = []; controls = []; connected = false; receiveCredits = 0;
  constructor(options = {}) {
    this.options = options; this.sap = options.sap ?? 3;
    this.device = { transferIn: async () => {
      if (this.hang) { queueMicrotask(() => this.options.abort?.()); return new Promise(() => {}); }
      const bytes = this.queued.shift() ?? b();
      return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
    } };
  }
  assertOpen() { if (!this.opened) throw new Error('USB closed'); }
  async close() { this.opened = false; }
  async setSIRSpeed(rate) { this.speeds.push(rate); this.baud = rate; }
  queue(address, control, data = b()) { this.queued.push(encodeFrame(address, control, data)); }
  respond() {
    if (this.payloads.length) {
      this.queue(0x70, (this.nr << 5) | 0x10 | (this.ns << 1), this.payloads.shift());
      this.ns = (this.ns + 1) & 7;
    } else this.queue(0x70, (this.nr << 5) | 0x11);
  }
  streamReply(packet) {
    for (const bytes of [packet.slice(0, 2), packet.slice(2, 9), packet.slice(9)]) {
      assert.ok(this.receiveCredits-- > 0, 'synthetic peer respects client receive credits');
      this.payloads.push(concat(b(9, this.sap, 0, 0), bytes));
    }
  }
  async sendFrame(address, control, data, bof, options) {
    assert.equal(this.readPending, false); assert.equal(options.receive, false);
    this.sent.push({ address, control, data: data.slice() }); this.txFrames++;
    if (control === 0x3f && data[10] === 2) {
      this.queue(0xfe, 0xbf, concat(b(1), PEER, LOCAL, hx('0102008c0400'), ascii('CASIO WIC 2411/IR')));
    } else if (control === 0x3f && data[10] === 255) this.finalSent = true;
    else if (control === 0x93) {
      assert.equal(this.finalSent, true); this.queue(0x70, 0x73, concat(PEER, LOCAL, UA_PARAMS));
    } else if (control === 0x53) this.queue(0x70, 0x73);
    else if (!(control & 1)) {
      this.nr = (((control >>> 1) & 7) + 1) & 7;
      if (equal(data, hx('80010100'))) this.payloads.push(hx('81008100'));
      else if (equal(data, iasRequest(IAS_QUERIES[0]))) {
        const params = PARAMS.slice(); if (this.options.no9wire) params[params.length - 1] = 1; this.payloads.push(params);
      } else if (equal(data, iasRequest(IAS_QUERIES[1]))) this.payloads.push(concat(hx('010084000001000101000000'), b(this.sap)));
      else if (equal(data, iasRequest(IAS_QUERIES[2]))) this.payloads.push(MISSING);
      else if (equal(data, hx('80010201'))) { /* IAS closed. */ }
      else if (equal(data, b(0x80 | this.sap, 9, 1, 0, 14))) {
        this.connected = true; this.receiveCredits = 14; this.payloads.push(b(0x89, this.sap, 0x81, 0, 2));
      } else if (equal(data, b(0x80 | this.sap, 9, 2, 1))) { /* IrCOMM closed. */ }
      else {
        assert.equal(this.connected, true); assert.equal(data[0], this.sap); assert.equal(data[1], 9);
        this.receiveCredits += data[2];
        if (data.length > 3) {
          const length = data[3];
          if (length) {
            this.controls.push(toHex(data.slice(4, 4 + length)));
            if (this.controls.length === 2) this.payloads.push(b(9, this.sap, 14));
          }
          this.stream = concat(this.stream, data.slice(4 + length));
          let next;
          while ((next = takeSCEP(this.stream))) {
            this.stream = next.rest; const packet = next.packet;
            if (packet[1] === 0x10) {
              assert.equal(toHex(packet), fixture.senderConnect);
              if (this.options.hangAfterConnect) { this.hang = true; return; }
              this.streamReply(cack());
            } else if (packet[1] === 0x20) {
              const i = this.requests.length; this.requests.push(toHex(packet));
              assert.equal(toHex(packet), fixture.sendQueries[i].hex);
              const reply = capabilityReply(i);
              if (this.options.wrongReplyID) reply[35] ^= 1;
              this.streamReply(reply);
            } else assert.equal(toHex(packet), '0030200100');
          }
        }
      }
      this.respond();
    } else if ((control & 15) === 1) this.respond();
  }
}
async function run(options = {}) {
  const adapter = new Adapter(options), events = [];
  const probe = new IrTranPCSIProbe(adapter, { localID: LOCAL, signal: options.signal,
    record: (kind, details) => events.push({ kind, ...details }) });
  const result = await probe.run(5000); return { adapter, probe, result, events };
}

test('outgoing CSI probe reads the advertised IrCOMM service, queries capabilities and disconnects', async () => {
  const { adapter, result, events } = await run();
  assert.equal(result.status, 'csi-complete'); assert.equal(result.complete, true);
  assert.equal(result.iasResponses, 3); assert.equal(result.ircommConnections, 1); assert.equal(result.scepConnected, true);
  assert.equal(result.capabilityResponses, 3); assert.equal(result.applicationCommands, 3); assert.equal(result.disconnected, true);
  assert.equal(result.files.length, 0); assert.equal(result.badCRC, 0); assert.equal(result.pendingOutputBytes, 0);
  assert.deepEqual(Object.keys(result.capabilities), CSI_QUERIES);
  assert.equal(result.capabilities.RIMG.attributes.BDY0, '00010101028001e003c4200500000200');
  assert.deepEqual(adapter.speeds, [115200, 9600]);
  assert.deepEqual(adapter.controls, ['000104', '10040000258011010320010c']);
  assert.equal(adapter.requests.length, 3);
  assert.equal(events.filter(e => e.kind === 'bftp-result').length, 3);
  const applications = events.filter(e => e.kind === 'application-tx-queued').map(e => e.dataHex);
  assert.equal(applications[0], fixture.senderConnect); assert.equal(applications.at(-1), '0030200100');
});

test('CSI uses the returned selector instead of assuming 3, and requires 9-wire before opening it', async () => {
  const alternate = await run({ sap: 12 });
  assert.equal(alternate.result.status, 'csi-complete'); assert.equal(alternate.result.peerSAP, 12);
  const missing = await run({ no9wire: true });
  assert.equal(missing.result.status, 'error'); assert.match(missing.result.error.message, /9-wire/);
  assert.equal(missing.result.ircommConnections, 0); assert.equal(missing.result.applicationCommands, 0);
  assert.equal(missing.adapter.connected, false);
});

test('CSI rejects an unrelated capability reply and never repeats its request', async () => {
  const { result, adapter } = await run({ wrongReplyID: true });
  assert.equal(result.status, 'error'); assert.match(result.error.message, /identity/);
  assert.equal(result.capabilityResponses, 0); assert.equal(adapter.requests.length, 1);
});

test('CSI can grant receive credits while its application output waits for transmit credits', async () => {
  const adapter = new Adapter();
  adapter.sendFrame = async (address, control, data) => { adapter.sent.push({ address, control, data }); };
  const probe = new IrTranPCSIProbe(adapter, { localID: LOCAL });
  Object.assign(probe, { csiActive: true, clientState: 'csi', csiState: 'await-capability', csiDeadline: performance.now() + 6000,
    peerSAP: 3, linkAddress: 0x70, rxCredits: 6, txCredits: 0 });
  probe.csiQueue.push({ bytes: b(1, 2), controls: b(), purpose: 'pending-query' });
  await probe.advanceCSI();
  assert.equal(toHex(adapter.sent[0].data), '030906'); assert.equal(probe.txCredits, 0);
  assert.equal(probe.rxCredits, 12); assert.equal(probe.csiQueue.length, 1);
});

test('CSI Stop finishes during an unresolved read after opening IrCOMM', { timeout: 2500 }, async () => {
  const controller = new AbortController();
  const { result, adapter } = await run({ hangAfterConnect: true, signal: controller.signal, abort: () => controller.abort() });
  assert.equal(result.status, 'interrupted'); assert.equal(result.ircommConnections, 1);
  assert.equal(result.applicationCommands, 0); assert.equal(result.pendingUSBRead, true); assert.equal(adapter.opened, false);
});

test('CSI ZIP identifies outgoing capability requests and keeps original USB/application streams', () => {
  const events = [{ kind: 'usb-result', operation: 'transferIn', id: 1, data: { hex: 'ffe0c1' } },
    { kind: 'application-rx', dataHex: '0011' }, { kind: 'application-tx-queued', dataHex: fixture.senderConnect }];
  const files = new Map(attemptFiles({ kind: 'irtranp', test: 'csi' }, events).map(file => [file.name, file.data]));
  const readme = new TextDecoder().decode(files.get('README.txt'));
  assert.match(readme, /READ-ONLY CSI CAPABILITY CLIENT/); assert.match(readme, /No PUT/);
  assert.equal(toHex(files.get('usb-in.bin')), 'ffe0c1'); assert.equal(toHex(files.get('application-in.bin')), '0011');
  assert.equal(toHex(files.get('application-out-queued.bin')), fixture.senderConnect);
});

test('the complete OTHERS RECEIVE hardware session replays all 49 transmissions and original USB chunks', { timeout: 12000 }, async () => {
  const recorded = JSON.parse(await readFile(new URL('./csi-hardware-fixture.json', import.meta.url)));
  const adapter = new Adapter(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, options) => {
    assert.equal(adapter.readPending, false); assert.equal(options.receive, false);
    const group = recorded.groups[groupIndex++];
    assert.ok(group, 'No extra transmission after the recorded disconnect');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.sent.push({ address, control, data: data.slice() }); adapter.txFrames++;
    adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const result = await new IrTranPCSIProbe(adapter, { localID: hx(recorded.localID),
    record: (kind, details) => events.push({ kind, ...details }) }).run(12000);
  assert.equal(result.status, 'csi-complete'); assert.equal(result.complete, true);
  assert.equal(groupIndex, recorded.groups.length); assert.equal(result.validFrames, 39);
  assert.equal(result.rxBytes, 693); assert.equal(result.recoveredFrames, 6); assert.equal(result.recoveredBOF, 4);
  assert.equal(result.rejectedBOF, 0); assert.equal(result.badCRC, 0);
  assert.deepEqual(result.ias, recorded.result.ias); assert.deepEqual(result.capabilities, recorded.result.capabilities);
  assert.equal(result.applicationCommands, 3); assert.equal(result.ircommConnections, 1); assert.equal(result.disconnected, true);
  assert.equal(result.peerSAP, 3); assert.deepEqual(adapter.speeds, [115200, 9600]);
  assert.equal(events.filter(e => e.kind === 'bftp-result').length, 3);
});
