import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as f from '../dist/formats.mjs';
import { HolidayCalendar, clockPayload } from '../dist/calendar.mjs';
import { WQVClient } from '../dist/protocol.mjs';
import { crc32, zipFiles } from '../dist/zip.mjs';
const fixtures = JSON.parse(await readFile(new URL('./native-fixtures.json', import.meta.url)));
const { b, fromHex: hx, concat } = f;

test('browser UPF and SCEP encoders match the tested native implementation byte for byte', () => {
  assert.equal(f.toHex(f.makeUPF(hx(fixtures.jpeg))), fixtures.upf);
  assert.deepEqual(f.packSCEP(hx(fixtures.segmented)).map(f.toHex), fixtures.packets);
  assert.equal(f.toHex(f.unpackSCEP(concat(...fixtures.packets.map(hx)))), fixtures.segmented);
  for (const query of fixtures.query) {
    assert.equal(f.toHex(f.packSCEP(f.queryCommand(query.name))[0]), query.packet);
    assert.equal(f.toHex(f.queryResponse(hx(query.request))), query.response);
  }
});
test('out of order and truncated image segments are rejected before being published', () => {
  const parts = fixtures.packets.map(hx);
  assert.throws(() => f.unpackSCEP(concat(parts[1], parts[0], ...parts.slice(2))), /order/);
  assert.throws(() => f.unpackSCEP(concat(...parts.slice(0, -1))), /Incomplete/);
  assert.throws(() => f.jpegFromUPF(hx(fixtures.upf).slice(0, -3)), /Truncated/);
});
test('an image archive checksum is validated before upload', async () => {
  const upf = hx(fixtures.upf), jpeg = f.jpegFromUPF(upf);
  const archive = { format: 'casio-wqv-transfer-v1', model: 3, jpeg_sha256: await f.sha256(jpeg), packets: f.packSCEP(f.putCommand(upf, 'MC000001.UPF')).map(f.toHex) };
  assert.deepEqual(await f.loadArchive(archive), upf);
  await assert.rejects(f.loadArchive({ ...archive, jpeg_sha256: '0'.repeat(64) }), /checksum/);
});
test('clock command includes the sixth field with the correct weekday and validates real dates', () => {
  assert.deepEqual(clockPayload('2000-01-01T00:00'), b(7, 0, 1, 1, 0, 0, 6));
  assert.deepEqual(clockPayload('2026-10-19T23:15'), b(7, 26, 10, 19, 23, 15, 1));
  assert.deepEqual(clockPayload('2039-12-31T23:59'), b(7, 39, 12, 31, 23, 59, 6));
  for (const invalid of ['1999-12-31T12:00', '2040-01-01T00:00', '2025-02-29T12:00', '2026-10-19T24:00']) assert.throws(() => clockPayload(invalid));
});
test('holiday bits follow the native ordinal-day, active-low, 46-byte-per-year layout', () => {
  const calendar = new HolidayCalendar();
  calendar.set(2000, 1, 1, true); assert.equal(calendar.raw[0], 0x7f);
  calendar.set(2000, 2, 29, true); assert.equal(calendar.raw[7], 0xef);
  calendar.set(2000, 12, 31, true); assert.equal(calendar.raw[45], 0xfb);
  calendar.set(2001, 1, 1, true); assert.equal(calendar.raw[46], 0x7f);
  calendar.set(2039, 12, 31, true); assert.equal(calendar.raw[1839], 0xf7);
  assert.equal(calendar.count(), 5); assert.equal(calendar.command().length, 1843);
  assert.deepEqual(calendar.command().slice(0, 3), b(8, 7, 0x30));
  assert.deepEqual(HolidayCalendar.fromBackup(calendar.backup()).raw, calendar.raw);
});
test('editing holidays preserves all reserved bits and handles leap years', () => {
  const raw = new Uint8Array(1840).fill(0xa5), calendar = new HolidayCalendar(raw);
  calendar.clear();
  for (let year = 2000; year <= 2039; year++) {
    const paddingMask = year % 4 === 0 ? 3 : 7;
    assert.equal(calendar.raw[(year - 2000) * 46 + 45] & paddingMask, 0xa5 & paddingMask);
  }
  calendar.markWeekdays(2026, [0, 6]); assert.equal(calendar.count(2026), 104);
  assert.equal(calendar.get(2026, 10, 18), true); assert.equal(calendar.get(2026, 10, 19), false);
  assert.equal(calendar.count(2025), 0);
});

class Frames {
  constructor(frames = []) { this.frames = frames; this.sent = []; this.decoder = { badCRC: 0 }; this.opened = true; }
  assertOpen() {}
  async sendFrame(address, control, data) { this.sent.push({ address, control, data }); }
  async receiveFrame() { if (!this.frames.length) throw new Error('Fixture exhausted'); return this.frames.shift(); }
  async pauseReader() {}
}
const incoming = (control, data = b()) => ({ address: 0x71, control, data });
test('long receive replenishes TinyTP credits without overflowing the peer counter', async () => {
  const command = f.makeCommand([f.attribute('BDY0', new Uint8Array(24000).fill(65))]);
  const wire = concat(...f.packSCEP(command)), frames = [];
  for (let pos = 0; pos < wire.length; pos += 120) frames.push(incoming(0x10 | (((pos / 120) % 8) << 1), concat(b(9, 3, 0, 0), wire.slice(pos, pos + 120))));
  const adapter = new Frames(frames.slice(1)), client = new WQVClient(adapter);
  client.session = 9; client.watchPort = 0x71; client.ourPort = 0x70; client.isPrimary = false;
  const result = await client.receiveSCEPFile(frames[0]); assert.deepEqual(result.command, command);
  const grants = adapter.sent.reduce((n, p) => n + (p.data.length ? p.data[2] : 0), 0);
  assert.equal(client.rxCredits, 14 - frames.length + grants);
  assert.ok(client.rxCredits > 6 && client.rxCredits <= 12);
});
test('the browser acknowledges a primary service reply before sending new payload', async () => {
  const adapter = new Frames([incoming(0x10, b(9, 3, 0, 0, 0x0d)), incoming(0x51)]);
  const client = new WQVClient(adapter); client.session = 9; client.watchPort = 0x71; client.ourPort = 0x70;
  await client.primaryExchange(b(3, 9, 0, 0, 2));
  assert.equal(adapter.sent.length, 2); assert.equal(adapter.sent[1].data.length, 0);
  assert.deepEqual(client.appBuffer, b(0x0d));
});
test('secondary IrCOMM negotiation waits through empty RR polls for control parameters', async () => {
  const parameters = b(9, 3, 0, 3, 0, 1, 4);
  const adapter = new Frames([incoming(0x91), incoming(0x98, parameters)]), client = new WQVClient(adapter);
  client.watchPort = 0x71; client.ourPort = 0x70; client.isPrimary = false;
  client.upper = 9;
  const frame = await client.dataFrame();
  assert.deepEqual(client.expect(frame, { prefix: b(9, 3, 0, 3) }), parameters);
  assert.equal(adapter.sent.length, 1); assert.equal(adapter.sent[0].data.length, 0);
});
test('collection completion performs RD → DISC → UA and uses the native identity packet', async () => {
  const credit = b(9, 3, 1);
  const frames = [incoming(0x91), incoming(0x30, hx('09030000001000010100')), incoming(0x31), incoming(0x52, credit)];
  for (const query of fixtures.query) frames.push(incoming(0xb0, hx(query.request)), incoming(0xd2, credit));
  frames.push(incoming(0xf8, hx('090300000030200100')), incoming(0x53));
  const adapter = new Frames(frames), client = new WQVClient(adapter);
  client.session = 9; client.watchPort = 0x71; client.ourPort = 0x70; client.isPrimary = false; client.connected = true;
  assert.deepEqual(await client.receiveCollection(), []);
  assert.deepEqual(adapter.sent.slice(-2).map(frame => frame.control), [0x53, 0x73]);
  const nativeIdent = hx(fixtures.ident); nativeIdent[1] = 9;
  assert.ok(adapter.sent.some(frame => f.equal(frame.data, nativeIdent)), 'Receiver identity must match the working native program');
  assert.equal(client.connected, false);
});
test('ZIP export has interoperable UTF-8 stored headers and the standard CRC32', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const blob = zipFiles([{ name: 'снимок.jpg', data: hx(fixtures.jpeg) }]);
  const data = new Uint8Array(await blob.arrayBuffer()), view = new DataView(data.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50); assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint32(data.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(data.length - 14, true), 1);
});

test('secondary disconnection answers an intervening watch poll with RD before DISC → UA', async () => {
  const adapter = new Frames([incoming(0x71), incoming(0x53)]), client = new WQVClient(adapter);
  Object.assign(client, { watchPort: 0x71, ourPort: 0x70, isPrimary: false, connected: true });
  await client.disconnect();
  assert.deepEqual(adapter.sent.map(f => f.control), [0x53, 0x53, 0x73]);
  assert.equal(client.disconnectConfirmed, true); assert.equal(client.disconnectAttempts, 2);
});
test('three RR polls cannot be reported as a confirmed disconnection', async () => {
  const adapter = new Frames([incoming(0x71), incoming(0x71), incoming(0x71)]), client = new WQVClient(adapter);
  Object.assign(client, { watchPort: 0x71, ourPort: 0x70, isPrimary: false, connected: true });
  await client.disconnect();
  assert.equal(adapter.sent.length, 3); assert.equal(client.disconnectConfirmed, false);
  assert.equal(client.connected, false);
});
test('a primary closes on the watch UA acknowledgement', async () => {
  const adapter = new Frames([incoming(0x73)]), client = new WQVClient(adapter);
  Object.assign(client, { watchPort: 0x71, ourPort: 0x70, connected: true });
  await client.disconnect(); assert.equal(client.disconnectConfirmed, true); assert.equal(adapter.sent.length, 1);
});
