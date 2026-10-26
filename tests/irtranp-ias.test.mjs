import test from 'node:test';
import assert from 'node:assert/strict';
import { IrTranPIASProbe, IAS_QUERIES, iasRequest, parseIAS } from '../dist/irtranp-ias.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, concat, ascii, fromHex as hx, toHex, equal } from '../dist/formats.mjs';
import { attemptFiles } from '../dist/research-core.mjs';

const LOCAL = hx('12345678'), PEER = hx('193666be');
// IAS values and the watch identity are independent wire-format fixtures.
const PARAMS = hx('0100840000010005020006000106010101');
const SELECTOR = hx('01008400000100050100000003');
const MISSING = hx('010084020000');
const UA_PARAMS = hx('01013e82010183013f84010f85018086028003080104');

test('IAS requests use GetValueByClass and response values retain types, status and raw bytes', () => {
  assert.equal(toHex(iasRequest('Parameters')), '0001840b497244413a4972434f4d4d0a506172616d6574657273');
  assert.equal(toHex(iasRequest('IrDA:TinyTP:LsapSel')), '0001840b497244413a4972434f4d4d13497244413a54696e7954503a4c73617053656c');
  assert.equal(parseIAS(PARAMS).values[0].hex, '000106010101');
  assert.equal(parseIAS(SELECTOR).values[0].integer, 3);
  assert.equal(parseIAS(MISSING).found, false); assert.equal(parseIAS(MISSING).code, 2);
  assert.equal(parseIAS(MISSING).rawHex, toHex(MISSING));
  const named = parseIAS(hx('010084000001001503000849725472616e2d50'));
  assert.equal(named.values[0].objectID, 21); assert.equal(named.values[0].text, 'IrTran-P');
  assert.throws(() => iasRequest('Other'), /Unsupported/);
  for (const raw of ['', '010084', '0100840000010005010000', '010084000001000502000400', '01008400000100050300', toHex(SELECTOR) + 'ff']) {
    assert.throws(() => parseIAS(hx(raw)), /IAS/);
  }
});

class Adapter {
  opened = true; configured = true; baud = 9600; revision = 7; readerTask = null; inEndpoint = 2;
  decoder = new FrameDecoder({ recoverFrames: true }); readPending = false; rxBytes = 0; txFrames = 0;
  sent = []; speeds = []; queued = []; ns = 0; nr = 0; finalSent = false;
  device = { transferIn: async () => {
    const bytes = this.queued.shift() ?? b();
    return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
  } };
  constructor(options = {}) { this.options = options; }
  assertOpen() { if (!this.opened) throw new Error('USB closed'); }
  async close() { this.opened = false; }
  async setSIRSpeed(rate) { this.speeds.push(rate); this.baud = rate; }
  queue(address, control, data = b()) { this.queued.push(encodeFrame(address, control, data)); }
  async sendFrame(address, control, data, bof, options) {
    assert.equal(this.readPending, false); assert.equal(options.receive, false);
    this.sent.push({ address, control, data: data.slice() }); this.txFrames++;
    if (control === 0x3f && data[10] === 2) {
      this.queue(0xfe, 0xbf, concat(b(1), PEER, LOCAL, hx('0102008c0400'), ascii('CASIO WIC 2411/IR')));
    } else if (control === 0x3f && data[10] === 255) this.finalSent = true;
    else if (control === 0x93) {
      assert.equal(this.finalSent, true, 'final XID precedes SNRM');
      assert.deepEqual(data.slice(0, 9), concat(LOCAL, PEER, b(0x70)));
      if (!this.options.noUA) this.queue(0x70, 0x73, concat(PEER, LOCAL, UA_PARAMS));
    } else if (control === 0x53) this.queue(0x70, 0x73);
    else if (!(control & 1)) {
      this.nr = (((control >>> 1) & 7) + 1) & 7;
      let response;
      if (equal(data, hx('80010100'))) response = hx('81008100');
      else if (equal(data, hx('80010201'))) { this.queue(0x70, (this.nr << 5) | 0x11); return; }
      else if (equal(data, iasRequest(IAS_QUERIES[0]))) response = this.options.invalidIAS ? hx('01008400000100050100') : PARAMS;
      else if (equal(data, iasRequest(IAS_QUERIES[1]))) response = SELECTOR;
      else if (equal(data, iasRequest(IAS_QUERIES[2]))) response = MISSING;
      else assert.fail('Unexpected IrCOMM or application request: ' + toHex(data));
      const ctl = (this.nr << 5) | 0x10 | (this.ns << 1);
      this.queue(0x70, ctl, response);
      if (this.options.duplicate && this.ns === 1) this.queue(0x70, ctl, response);
      this.ns = (this.ns + 1) & 7;
    } else if ((control & 15) === 1) this.queue(0x70, (this.nr << 5) | 0x11);
  }
}
async function run(options = {}) {
  const adapter = new Adapter(options), events = [];
  const probe = new IrTranPIASProbe(adapter, { localID: LOCAL, record: (kind, details) => events.push({ kind, ...details }) });
  const result = await probe.run(options.durationMs ?? 3000);
  return { adapter, probe, events, result };
}

test('a full WebUSB-style session leaves discovery, reads the three IAS entries and closes without IrCOMM', async () => {
  const { adapter, events, result } = await run();
  assert.equal(result.status, 'ias-complete'); assert.equal(result.complete, true);
  assert.equal(result.connectionAttempts, 1); assert.equal(result.linkAccepted, true); assert.equal(result.disconnected, true);
  assert.equal(result.iasQueries, 3); assert.equal(result.iasResponses, 3);
  assert.equal(result.ias['IrDA:TinyTP:LsapSel'].values[0].integer, 3);
  assert.equal(result.ias['IrDA:IrLMP:InstanceName'].code, 2);
  assert.equal(result.applicationCommands, 0); assert.equal(result.ircommConnections, 0);
  assert.deepEqual(adapter.speeds, [115200, 9600]);
  const requests = adapter.sent.filter(frame => !(frame.control & 1));
  assert.deepEqual(requests.map(frame => toHex(frame.data)), ['80010100', ...IAS_QUERIES.map(name => toHex(iasRequest(name))), '80010201']);
  const start = events.find(e => e.kind === 'irtranp-start');
  assert.equal(start.initiateConnection, true); assert.equal(start.acceptingConnections, false);
  assert.equal(start.maxBaud, 115200); assert.equal(start.localBaudMask, 0x3e);
  assert.equal(events.find(e => e.kind === 'irtranp-finished').status, 'ias-complete');
});

test('a repeated I-frame is acknowledged once more without repeating its IAS request', async () => {
  const { result, adapter } = await run({ duplicate: true });
  assert.equal(result.status, 'ias-complete'); assert.equal(result.duplicates, 1);
  assert.equal(adapter.sent.filter(f => equal(f.data, iasRequest('Parameters'))).length, 1);
});

test('malformed IAS stops the test with raw frames and no further service or application request', async () => {
  const { result, adapter, events } = await run({ invalidIAS: true });
  assert.equal(result.status, 'error'); assert.match(result.error.message, /Truncated IAS/);
  assert.equal(result.iasQueries, 1); assert.equal(result.iasResponses, 0);
  assert.equal(adapter.sent.filter(f => equal(f.data, iasRequest('IrDA:TinyTP:LsapSel'))).length, 0);
  assert.ok(events.some(e => e.kind === 'rx-frame' && e.dataHex === '01008400000100050100'));
});

test('an unanswered SNRM is not retried and a bounded capture never queries IAS before UA', async () => {
  const { result, adapter } = await run({ noUA: true, durationMs: 2000 });
  assert.equal(result.status, 'session-timeout'); assert.equal(result.linkAccepted, false);
  assert.equal(result.connectionAttempts, 1); assert.equal(result.iasQueries, 0);
  assert.equal(adapter.sent.filter(f => f.control === 0x93).length, 1);
  assert.equal(adapter.sent.filter(f => !(f.control & 1)).length, 0);
});

test('IAS Stop also finishes when USB close leaves the current read unresolved', { timeout: 1000 }, async () => {
  const adapter = new Adapter(), controller = new AbortController();
  adapter.device.transferIn = () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
  const probe = new IrTranPIASProbe(adapter, { signal: controller.signal, localID: LOCAL });
  const result = await probe.run(60000);
  assert.equal(result.status, 'interrupted'); assert.equal(result.pendingUSBRead, true);
  assert.equal(adapter.opened, false); assert.equal(adapter.sent.length, 0);
});

test('IAS ZIP describes the client probe and preserves every received frame independently of application bytes', () => {
  const events = [{ kind: 'usb-result', id: 1, operation: 'transferIn', data: { hex: 'ffffc0' } },
    { kind: 'rx-frame', address: 0xfe, control: 0xbf, dataHex: '0102' }];
  const files = new Map(attemptFiles({ kind: 'irtranp', test: 'ias' }, events).map(file => [file.name, file.data]));
  const readme = new TextDecoder().decode(files.get('README.txt'));
  assert.match(readme, /READ-ONLY IRLAP\/IAS CLIENT/); assert.match(readme, /No IrCOMM\/TinyTP channel/);
  assert.equal(toHex(files.get('usb-in.bin')), 'ffffc0');
  assert.equal(files.get('application-in.bin').length, 0);
});

test('the original USB chunks with damaged BOF reach the IAS client and preserve Parameters 00 01 07', { timeout: 6500 }, async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./ias-hardware-fixture.json', import.meta.url)));
  const adapter = new Adapter(), controller = new AbortController(), used = new Set(), events = [];
  adapter.sendFrame = async (address, control, data, bof, options) => {
    assert.equal(adapter.readPending, false); assert.equal(options.receive, false);
    adapter.sent.push({ address, control, data: data.slice() }); adapter.txFrames++;
    const i = fixture.responseGroups.findIndex((g, i) => !used.has(i) && g.tx.address === address &&
      g.tx.control === control && g.tx.dataHex === toHex(data));
    if (i >= 0) {
      used.add(i); adapter.queued.push(...fixture.responseGroups[i].usbInChunks.map(hx));
    } else if (control === 0x51 && !data.length) {
      // The old capture ended before this ACK. This RR is a synthetic peer
      // acknowledgement, solely to let the client commit the recorded value.
      adapter.queue(0x70, 0x51);
    } else if (equal(data, iasRequest('IrDA:TinyTP:LsapSel'))) queueMicrotask(() => controller.abort());
    else assert.equal(control, 0x3f, 'No unexplained data command during replay');
  };
  const probe = new IrTranPIASProbe(adapter, { signal: controller.signal, localID: hx(fixture.localID),
    record: (kind, details) => events.push({ kind, ...details }) });
  const result = await probe.run(60000);
  assert.equal(result.status, 'interrupted'); assert.equal(result.iasResponses, 1);
  assert.equal(result.ias.Parameters.values[0].hex, '000107');
  assert.equal(result.ias.Parameters.values[0].objectID, 1);
  assert.equal(result.recoveredBOF, 1); assert.equal(result.recoveredFrames, 1); assert.equal(result.badCRC, 0);
  assert.equal(used.size, fixture.responseGroups.length);
  assert.ok(events.some(e => e.kind === 'rx-frame' && e.control === 0x52 && e.dataHex === '0100840000010001020003000107'));
  assert.equal(adapter.sent.filter(f => equal(f.data, iasRequest('Parameters'))).length, 1);
});

test('the complete successful watch transcript replays its original USB reads, service replies and disconnect', { timeout: 10000 }, async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./ias-complete-hardware-fixture.json', import.meta.url)));
  const adapter = new Adapter(), events = []; let groupIndex = 0;
  adapter.sendFrame = async (address, control, data, bof, options) => {
    assert.equal(adapter.readPending, false); assert.equal(options.receive, false);
    const group = fixture.groups[groupIndex++];
    assert.ok(group, 'No transmission after the original session closed');
    assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
    adapter.sent.push({ address, control, data: data.slice() }); adapter.txFrames++;
    adapter.queued.push(...group.reads.map(read => hx(read.hex)));
  };
  const result = await new IrTranPIASProbe(adapter, { localID: hx(fixture.localID),
    record: (kind, details) => events.push({ kind, ...details }) }).run(10000);
  assert.equal(result.status, 'ias-complete'); assert.equal(result.complete, true);
  assert.equal(groupIndex, fixture.groups.length); assert.equal(result.iasResponses, 3);
  assert.deepEqual(result.ias, fixture.result.ias);
  assert.equal(result.recoveredFrames, 1); assert.equal(result.recoveredBOF, 0);
  assert.equal(result.badCRC, 0); assert.equal(result.disconnected, true);
  assert.equal(result.applicationCommands, 0); assert.equal(result.ircommConnections, 0);
});
