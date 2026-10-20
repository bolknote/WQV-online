import test from 'node:test';
import assert from 'node:assert/strict';
import { baudMask, peerBaudRates, selectBaudRate, linkParameters } from '../dist/irda.mjs';
import { WQVClient } from '../dist/protocol.mjs';
import { b, fromHex as hx, concat, equal, ascii } from '../dist/formats.mjs';

// The WQV-3's recorded SNRM: all SIR rates, including 115200 (bit 5).
const watchParameters = hx('01013f82010183013f8401018501808601030801ff');
const peerID = hx('193666be');

test('IrLAP selects the fastest common SIR rate, including multi-byte little-endian offers', () => {
  assert.equal(baudMask(115200), 0x3e);
  assert.equal(baudMask(9600), 2);
  assert.deepEqual(selectBaudRate(watchParameters, baudMask(115200)), { baud: 115200, commonRates: 0x3e, peerRates: 0x3f });
  assert.equal(selectBaudRate(hx('01020201'), 0x3e).baud, 9600);
  assert.equal(selectBaudRate(watchParameters, baudMask(38400)).baud, 38400);
  assert.throws(() => selectBaudRate(hx('010101'), 0x3e), /No common/);
  assert.throws(() => baudMask(4000000), RangeError);
});

test('malformed or duplicate baud offers are rejected before a speed is selected', () => {
  for (const hex of ['', '01', '01023f', '010100', '0103020000', '010102010104', '0101028202ff']) {
    assert.throws(() => peerBaudRates(hx(hex)), /IrLAP/);
  }
  assert.equal(peerBaudRates(hx('770100010102')), 2, 'Unknown well-formed parameters can be skipped');
});

class LinkAdapter {
  opened = true; configured = true; baud = 9600;
  decoder = { badCRC: 0 }; frames = []; events = [];
  peerRates = 0x3e; badUA = false; reply = true; disconnectReply = 0x73;
  assertOpen() { assert.equal(this.opened, true); }
  async setupSIR() { this.baud = 9600; }
  async setSIRSpeed(baud) { this.events.push({ type: 'speed', baud }); this.baud = baud; }
  async pauseReader() {}
  async sendFrame(address, control, data) {
    this.events.push({ type: 'send', baud: this.baud, address, control, data });
    if (!this.reply) return;
    const receive = (c, d = b(), a = this.peerPort) => this.frames.push({ address: a, control: c, data: d });
    if (control === 0x3f) {
      receive(0xbf, concat(b(1), peerID, data.slice(1, 5), hx('0102008c0400'), ascii('CASIO WIC 2411/IR')), 0xfe);
    } else if (control === 0x93) {
      this.peerPort = data[8];
      receive(0x73, concat(peerID, data.slice(0, 4), linkParameters(this.peerRates)), this.badUA ? 0 : this.peerPort);
    } else if (control === 0x53) receive(this.disconnectReply);
    else if (control === 0x73) return;
    else if (equal(data, hx('80030100'))) receive(0x30, hx('83008100'));
    else if (equal(data, hx('80030201'))) receive(0x51);
    else if (data[0] === 0x83 && data[2] === 1) receive(0x72, b(0x80 | data[1], 3, 0x81, 0, 1));
    else receive(0x71);
  }
  async receiveFrame() {
    if (!this.frames.length) throw new Error('Fixture exhausted');
    return this.frames.shift();
  }
}

test('primary negotiation receives UA at 9600 and sends the first service frame at 115200', async () => {
  const adapter = new LinkAdapter(), client = new WQVClient(adapter);
  await client.openPrimary();
  const snrm = adapter.events.find(e => e.control === 0x93);
  assert.equal(snrm.baud, 9600);
  assert.equal(peerBaudRates(snrm.data.slice(9)), 0x3e);
  const service = adapter.events.find(e => e.type === 'send' && equal(e.data, hx('80030100')));
  assert.equal(service.baud, 115200);
  assert.equal(client.connected, true);
  await client.close();
  assert.equal(adapter.baud, 9600);
});

test('a peer restricted to 9600 stays at 9600, and an unrelated UA never changes speed', async () => {
  const adapter = new LinkAdapter(); adapter.peerRates = 2;
  const client = new WQVClient(adapter);
  await client.openPrimary();
  assert.equal(adapter.baud, 9600);
  assert.ok(adapter.events.filter(e => e.type === 'send').every(e => e.baud === 9600));
  await client.close();
  const wrong = new LinkAdapter(); wrong.badUA = true;
  await assert.rejects(new WQVClient(wrong).openPrimary(), /did not accept/);
  assert.equal(wrong.events.filter(e => e.type === 'speed').length, 0);
});

test('secondary negotiation sends the complete UA at 9600 before changing speed', async () => {
  const adapter = new LinkAdapter(); adapter.reply = false;
  const client = new WQVClient(adapter); client.isPrimary = false; client.peerID = peerID;
  const localID = hx('10203000');
  await client.acceptSecondaryLink({ control: 0x93, data: concat(peerID, localID, b(0x70), watchParameters) }, localID);
  assert.deepEqual(adapter.events.map(e => [e.type, e.baud]), [['send', 9600], ['speed', 115200]]);
  assert.equal(adapter.events[0].control, 0x73);
  assert.equal(peerBaudRates(adapter.events[0].data.slice(8)), 0x3e);
  assert.equal(client.connected, true);
  const other = new LinkAdapter(); other.reply = false;
  const wrong = new WQVClient(other); wrong.isPrimary = false; wrong.peerID = peerID;
  await assert.rejects(wrong.acceptSecondaryLink({ control: 0x93, data: concat(peerID, hx('00000000'), b(0x70), watchParameters) }, localID), /No connection parameters/);
  assert.deepEqual(other.events, []);
});

test('role changes and secondary disconnects return to 9600 only after the closing frames', async () => {
  const adapter = new LinkAdapter(), client = new WQVClient(adapter);
  adapter.peerPort = client.watchPort; adapter.baud = 115200; client.connected = true;
  await client.closeLink();
  assert.ok(adapter.events.filter(e => e.type === 'send').every(e => e.baud === 115200));
  assert.deepEqual(adapter.events.at(-1), { type: 'speed', baud: 9600 });
  adapter.events.length = 0; adapter.baud = 115200; adapter.disconnectReply = 0x53;
  client.isPrimary = false; client.connected = true;
  await client.disconnect();
  assert.deepEqual(adapter.events.filter(e => e.type === 'send').map(e => [e.control, e.baud]), [[0x53, 115200], [0x73, 115200]]);
  assert.equal(adapter.baud, 9600);
});

test('a failed disconnect still restores discovery speed', async () => {
  const adapter = new LinkAdapter(), client = new WQVClient(adapter);
  adapter.baud = 115200; client.connected = true;
  adapter.sendFrame = async () => { throw new Error('USB write failed'); };
  await assert.rejects(client.disconnect(), /USB write failed/);
  assert.equal(client.connected, false);
  assert.equal(adapter.baud, 9600);
});
