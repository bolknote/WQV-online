import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IrTranPActiveReceiver } from '../dist/irtranp-active.mjs';
import { IMAGE_CAPABILITIES, CSI_PROFILE, csiCommand, compactSCEP, takeSCEP } from '../dist/irtranp-core.mjs';
import { IAS_QUERIES, iasRequest } from '../dist/irtranp-ias.mjs';
import { b, concat, ascii, fromHex as hx, toHex, equal, unpackSCEP, parseCommand, putCommand } from '../dist/formats.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { attemptFiles } from '../dist/research-core.mjs';

const csi = JSON.parse(await readFile(new URL('./csi-fixtures.json', import.meta.url)));
const nokia = JSON.parse(await readFile(new URL('./nokia-capability-fixture.json', import.meta.url)));
const native = JSON.parse(await readFile(new URL('./native-fixtures.json', import.meta.url)));
const LOCAL = hx('12345678'), PEER = hx('193666be');
const UA_PARAMS = hx('01013e82010183013f84010f85018086028003080104');
const rimg = hx(csi.session.find(row => row.direction === 'rx-fixture' && row.hex.endsWith('52494d47')).hex);

test('the Nokia image capability branch changes RIMG while retaining CSI identity and bounded capture', () => {
  const reply = parseCommand(csiCommand(unpackSCEP(rimg), IMAGE_CAPABILITIES['nokia-original']).reply);
  assert.equal(toHex(reply.attributes.BDY0), nokia.RIMG);
  assert.equal(toHex(reply.source), csi.csiMachineID);
  assert.equal(IMAGE_CAPABILITIES['nokia-original'].RINF, nokia.RINF);
  assert.equal(IMAGE_CAPABILITIES['nokia-original'].RCMD, nokia.RCMD);
  assert.equal(CSI_PROFILE.maxFile, 128 * 1024);
  assert.equal(toHex(parseCommand(csiCommand(unpackSCEP(rimg)).reply).attributes.BDY0), CSI_PROFILE.capabilities.RIMG);
});

// Independent synthetic peer. It starts SCEP only after serial negotiation,
// splits the stream across arbitrary IrCOMM boundaries and obeys credits.
class Adapter {
  opened = true; configured = true; baud = 9600; revision = 7; readerTask = null; inEndpoint = 2;
  decoder = new FrameDecoder({ recoverFrames: true }); readPending = false; rxBytes = 0; txFrames = 0;
  sent = []; speeds = []; queued = []; payloads = []; ns = 0; nr = 0; stream = b();
  applications = []; controls = []; peerCredits = 0; clientCredits = 0;
  constructor(options = {}) {
    this.options = options; this.sap = options.sap ?? 12;
    this.device = { transferIn: async () => {
      if (this.hang) { queueMicrotask(() => this.options.abort?.()); return new Promise(() => {}); }
      const bytes = this.queued.shift() ?? b();
      return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
    } };
  }
  assertOpen() { if (!this.opened) throw new Error('USB closed'); }
  async close() { this.opened = false; }
  async setSIRSpeed(rate) { this.speeds.push(rate); this.baud = rate; }
  queue(control, data = b(), address = 0x70) { this.queued.push(encodeFrame(address, control, data)); }
  respond() {
    if (!this.payloads.length) { this.queue((this.nr << 5) | 0x11); return; }
    const next = this.payloads[0];
    if (next[0] === 9 && next[1] === this.sap && next.length > 3 && !this.peerCredits) {
      this.queue((this.nr << 5) | 0x11); return;
    }
    const payload = this.payloads.shift();
    if (payload[0] === 9 && payload[1] === this.sap && payload.length > 3) {
      assert.ok(this.peerCredits-- > 0, 'peer has a receive credit');
      const grant = this.clientCredits <= 2 ? 6 : 0;
      payload[2] = grant; this.clientCredits += grant;
    }
    this.queue((this.nr << 5) | 0x10 | (this.ns << 1), payload); this.ns = (this.ns + 1) & 7;
  }
  streamReply(bytes) {
    for (let p = 0; p < bytes.length;) {
      const size = p === 0 ? 2 : p === 2 ? 7 : 45;
      this.payloads.push(concat(b(9, this.sap, 0, 0), bytes.slice(p, p + size))); p += size;
    }
  }
  async sendFrame(address, control, data, bof, options) {
    assert.equal(this.readPending, false); assert.equal(options.receive, false);
    this.sent.push({ address, control, data: data.slice() }); this.txFrames++;
    if (control === 0x3f && data[10] === 2) {
      this.queue(0xbf, concat(b(1), PEER, LOCAL, hx('0102008c0400'), ascii('CASIO WIC 2411/IR')), 0xfe);
    } else if (control === 0x93) this.queue(0x73, concat(PEER, LOCAL, UA_PARAMS));
    else if (control === 0x53) this.queue(0x73);
    else if (!(control & 1)) {
      this.nr = (((control >>> 1) & 7) + 1) & 7;
      if (equal(data, hx('80010100'))) this.payloads.push(hx('81008100'));
      else if (equal(data, iasRequest(IAS_QUERIES[0]))) this.payloads.push(hx('0100840000010001020003000107'));
      else if (equal(data, iasRequest(IAS_QUERIES[1]))) this.payloads.push(concat(hx('010084000001000101000000'), b(this.sap)));
      else if (equal(data, iasRequest(IAS_QUERIES[2]))) this.payloads.push(hx('010084020100000003'));
      else if (equal(data, hx('80010201'))) { /* IAS disconnect. */ }
      else if (equal(data, b(0x80 | this.sap, 9, 1, 0, 14))) {
        this.peerCredits = 14; this.clientCredits = 4; this.payloads.push(b(0x89, this.sap, 0x81, 0, 4));
      } else if (equal(data, b(0x80 | this.sap, 9, 2, 1))) { /* IrCOMM disconnect. */ }
      else {
        assert.equal(data[0], this.sap); assert.equal(data[1], 9); this.peerCredits += data[2];
        if (data.length > 3) {
          assert.ok(this.clientCredits-- > 0, 'client has a transmit credit');
          const length = data[3];
          if (length) {
            this.controls.push(toHex(data.slice(4, 4 + length)));
            if (this.controls.length === 2) {
              if (this.options.hang) { this.hang = true; return; }
              if (!this.options.idle) this.streamReply(hx(csi.session[0].hex));
              this.options.onControls?.();
            }
          }
          this.stream = concat(this.stream, data.slice(4 + length));
          let next;
          while ((next = takeSCEP(this.stream))) {
            this.stream = next.rest; const packet = next.packet; this.applications.push(packet);
            if (packet[1] === 0x11) this.streamReply(rimg);
            else if (packet[1] === 0x20) {
              const command = parseCommand(unpackSCEP(packet));
              assert.equal(command.reply, 0x40, 'client sends only replies');
              if (command.attributes.BDY0) {
                assert.equal(toHex(command.attributes.BDY0), IMAGE_CAPABILITIES[this.options.imageProfile ?? 'csi'].RIMG);
                const source = hx(csi.peerMachineID), destination = hx(csi.csiMachineID);
                this.streamReply(concat(...compactSCEP(putCommand(hx(native.upf), 'MC000001.UPF', { source, destination }), 512)));
              } else {
                assert.equal(toHex(command.attributes.RPL0), toHex(ascii('MC000001.UPF')));
                this.streamReply(hx('0030200100'));
              }
            } else assert.equal(toHex(packet), '0030200100');
          }
        }
      }
      this.respond();
    } else if ((control & 15) === 1) this.respond();
  }
}

for (const imageProfile of ['csi', 'nokia-original']) {
  test(`active receiver connects, waits for peer SCEP and receives a fragmented image (${imageProfile})`, { timeout: 8000 }, async () => {
    const adapter = new Adapter({ imageProfile }), events = [], files = [];
    const result = await new IrTranPActiveReceiver(adapter, { localID: LOCAL, imageProfile,
      onFile: async file => files.push(file), record: (kind, details) => events.push({ kind, ...details }) }).run(7000);
    assert.equal(result.status, 'received', JSON.stringify(result.error)); assert.equal(result.complete, true);
    assert.equal(result.peerSAP, 12); assert.equal(result.ircommConnections, 1); assert.equal(result.applicationCommands, 0);
    assert.equal(result.capabilityResponses, 1); assert.equal(result.fileCount, 1); assert.equal(result.disconnected, true);
    assert.equal(result.pendingOutputBytes, 0); assert.equal(result.pendingBytes, 0);
    assert.deepEqual(files[0].bytes, hx(native.upf)); assert.deepEqual(adapter.speeds, [115200, 9600]);
    assert.equal(adapter.applications.some(packet => packet[1] === 0x10), false);
    assert.deepEqual(adapter.controls, ['000104', '10040000258011010320010c']);
    assert.equal(events.filter(e => e.kind === 'irtranp-file').length, 1);
    const exported = new Map(attemptFiles({ kind: 'irtranp', test: 'active-receiver', imageProfile }, events).map(file => [file.name, file.data]));
    assert.deepEqual(exported.get('files/000-MC000001.UPF'), hx(native.upf));
    assert.match(new TextDecoder().decode(exported.get('README.txt')), /ACTIVE IRTRAN-P IMAGE RECEIVER/);
  });
}

test('idle after opening IrCOMM closes the link without sending SCEP Connect or image commands', async () => {
  let receiver;
  const adapter = new Adapter({ idle: true, onControls: () => { receiver.csiDeadline = performance.now() - 1; } });
  receiver = new IrTranPActiveReceiver(adapter, { localID: LOCAL });
  const result = await receiver.run(5000);
  assert.equal(result.status, 'receiver-no-image', JSON.stringify(result.error));
  assert.equal(result.idleTimeout, true); assert.equal(result.disconnected, true);
  assert.equal(result.applicationCommands, 0); assert.equal(result.fileCount, 0); assert.equal(result.complete, true);
  assert.deepEqual(adapter.applications, []);
});

test('Stop still completes when USB IN hangs after IrCOMM opens', { timeout: 2000 }, async () => {
  const controller = new AbortController(), adapter = new Adapter({ hang: true, abort: () => controller.abort() });
  const result = await new IrTranPActiveReceiver(adapter, { localID: LOCAL, signal: controller.signal }).run(60000);
  assert.equal(result.status, 'interrupted'); assert.equal(result.ircommConnections, 1);
  assert.equal(result.applicationCommands, 0); assert.equal(result.pendingUSBRead, true); assert.equal(adapter.opened, false);
});
