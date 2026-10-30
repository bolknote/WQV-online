import test from 'node:test';
import assert from 'node:assert/strict';
import { b, toHex } from '../dist/formats.mjs';
import { WQVClient } from '../dist/protocol.mjs';

class Link {
  constructor(reply = 0x0d) {
    this.opened = true; this.sent = []; this.decoder = { badCRC: 0 };
    this.frames = [{ address: 0x71, control: 0x10, data: b(9, 3, 0, 0, reply) },
      { address: 0x71, control: 0x51, data: b() }, { address: 0x71, control: 0x73, data: b() }];
  }
  assertOpen() {}
  async sendFrame(address, control, data) { this.sent.push({ address, control, data }); }
  async receiveFrame() { assert.ok(this.frames.length, 'No extra link request'); return this.frames.shift(); }
}
function connectedClient(adapter) {
  const client = new WQVClient(adapter);
  Object.assign(client, { connected: true, isPrimary: true, session: 9, ourPort: 0x70, watchPort: 0x71 });
  return client;
}

test('quit REMOTE sends 0C, acknowledges the 0D reply, then closes IrLAP', async () => {
  const adapter = new Link(), client = connectedClient(adapter);
  await client.quitRemote();
  assert.deepEqual(adapter.sent.map(frame => frame.control), [0x12, 0x31, 0x53]);
  assert.deepEqual(adapter.sent.map(frame => toHex(frame.data)), ['030900000c', '', '']);
  assert.equal(client.disconnectConfirmed, true); assert.equal(client.connected, false);
});

test('a refused quit is not reported as an acknowledgement or a confirmed close', async () => {
  const adapter = new Link(0x0e), client = connectedClient(adapter);
  await assert.rejects(client.quitRemote(), /did not acknowledge/);
  assert.equal(client.disconnectConfirmed, false);
  assert.ok(!adapter.sent.some(frame => frame.control === 0x53));
});

test('five-photo navigation waits for each ordinary command and stops at a failure', async () => {
  for (const [direction, opcode] of [['forward', '02'], ['back', '03']]) {
    const client = new WQVClient({}), calls = [];
    client.control = async command => { calls.push(toHex(command)); };
    await client.stepPhotos(direction, 5); assert.deepEqual(calls, Array(5).fill(opcode));
    calls.length = 0;
    client.control = async command => { calls.push(toHex(command)); if (calls.length === 2) throw new Error('Rejected'); };
    await assert.rejects(client.stepPhotos(direction, 5), /Rejected/); assert.equal(calls.length, 2);
    await assert.rejects(client.stepPhotos(direction, 6), /1–5/);
  }
});

test('held browsing sends start once and stop on release or a link error', async () => {
  const client = connectedClient({ opened: true }), commands = []; let turns = 0;
  client.control = async command => { commands.push(toHex(command)); };
  client.primaryExchange = async () => { turns++; };
  assert.equal(await client.fastScroll('forward', { duration: 30000, stop: () => turns === 2 }), true);
  assert.deepEqual(commands, ['04', '06']);
  commands.length = 0;
  client.primaryExchange = async () => { throw new Error('Link error'); };
  await assert.rejects(client.fastScroll('back'), /Link error/);
  assert.deepEqual(commands, ['05', '06']);
  commands.length = 0;
  assert.equal(await client.fastScroll('forward', { stop: () => true }), false); assert.deepEqual(commands, []);
});
