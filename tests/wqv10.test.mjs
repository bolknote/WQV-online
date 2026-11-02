import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ColourCalendar, HolidayCalendar, DATE_COLOURS } from '../dist/calendar.mjs';
import { WATCH_MODELS, watchModel, colourWatchModel } from '../dist/watch-models.mjs';
import { WQVClient } from '../dist/protocol.mjs';
import { b, concat, ascii, fromHex, equal, packSCEP, putCommand, toHex, jpegFromUPF, sha256, loadArchive } from '../dist/formats.mjs';

const original = JSON.parse(readFileSync(new URL('./fixtures/wqv10-calendar-original.json', import.meta.url)));

test('WQV-10 photo archives import without changing the shared JPEG/UPF format', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/wqv3-album-hardware.json', import.meta.url)));
  const upf = fromHex(fixture.upfs[0]);
  const archive = { format: 'casio-wqv-transfer-v1', model: 10, filename: 'MC000010.UPF',
    jpeg_sha256: await sha256(jpegFromUPF(upf)), packets: packSCEP(putCommand(upf,'MC000010.UPF')).map(toHex) };
  assert.deepEqual(await loadArchive(archive), upf);
  await assert.rejects(loadArchive({...archive,model:2}));
  await assert.rejects(loadArchive({...archive,jpeg_sha256:'0'.repeat(64)}));
});

test('WQV-10 reuses the colour-camera application with a separate album and calendar format', () => {
  assert.equal(watchModel('wqv10').module, 2412);
  assert.equal(watchModel('wqv10').application, './wqv3.html?model=wqv10');
  assert.equal(watchModel(null), WATCH_MODELS.wqv3);
  assert.equal(watchModel('toString'), WATCH_MODELS.wqv3);
  assert.equal(colourWatchModel('wqv2'), WATCH_MODELS.wqv3);
  assert.equal(WATCH_MODELS.wqv3.album, 'casio-wqv-webusb');
  assert.equal(new Set(Object.values(WATCH_MODELS).map(p => p.album)).size, 3);
});

test('WQV-10 calendar matches the original Casio x86 encoder, including the 2019/2020 split', () => {
  const calendar = new ColourCalendar();
  for (const date of original.dates) calendar.set(...date);
  assert.deepEqual(calendar.raw, fromHex(original.dataHex));
  for (const [y, m, d, colour] of original.dates) assert.equal(calendar.get(y, m, d), colour);
  assert.equal(calendar.raw[0], 0x21);
  assert.equal(calendar.raw.at(-1), 0x13);
  assert.deepEqual(DATE_COLOURS.map(c => c.toLowerCase()), original.colourTable);
  assert.equal(calendar.command().length, 7308);
  assert.deepEqual(calendar.command().slice(0, 3), b(8, 0x1c, 0x89));
  assert.equal(calendar.count(), original.dates.length);
});

test('editing a WQV-10 date preserves its paired date, including unknown nibbles', () => {
  const calendar = new ColourCalendar(new Uint8Array(7305).fill(0xf9));
  calendar.set(2000, 1, 1, 2); assert.equal(calendar.raw[0], 0xf2);
  assert.equal(calendar.get(2020, 1, 1), 15);
  calendar.set(2020, 1, 1, 1); assert.equal(calendar.raw[0], 0x12);
  assert.throws(() => calendar.set(2000, 1, 1, 4), RangeError);
  assert.throws(() => calendar.set(2001, 2, 29, 1));
  assert.throws(() => calendar.get(2040, 1, 1));
});

test('WQV-10 weekdays and clearing use actual leap days without affecting another year', () => {
  const calendar = new ColourCalendar();
  calendar.markWeekdays(2026, [0, 6], 3);
  calendar.set(2000, 2, 29, 2);
  assert.equal(calendar.count(2026), 104);
  assert.equal(calendar.get(2026, 11, 1), 3);
  calendar.clear(2026);
  assert.equal(calendar.count(), 1);
  assert.equal(calendar.get(2000, 2, 29), 2);
  calendar.clear(); assert.equal(calendar.count(), 0);
});

test('calendar backups reject the other model and retain unedited WQV-10 bytes', () => {
  const calendar = new ColourCalendar(fromHex(original.dataHex));
  assert.deepEqual(ColourCalendar.fromBackup(calendar.backup()).raw, calendar.raw);
  assert.throws(() => HolidayCalendar.fromBackup(calendar.backup()));
  assert.throws(() => ColourCalendar.fromBackup(new HolidayCalendar().backup()));
  assert.throws(() => new ColourCalendar(new Uint8Array(1840)));
});

for (const [expectedModel, discovered] of [[3, 10], [10, 3]]) {
  test(`WQV-${expectedModel} application rejects WQV-${discovered} before IrLAP connection or writes`, async () => {
    const frames = [], sent = [];
    const adapter = { assertOpen() {}, async setupSIR() {},
      async sendFrame(address, control, data) {
        sent.push({ address, control, data });
        frames.push({ address: 0xfe, control: 0xbf,
          data: concat(b(1, 9, 8, 7, 6), data.slice(1, 5), fromHex('0102008c0400'), ascii('CASIO WIC ' + (discovered === 10 ? '2412' : '2411') + '/IR')) });
      }, async receiveFrame() { return frames.shift(); } };
    const client = new WQVClient(adapter, { expectedModel });
    await assert.rejects(client.openPrimary(), /Found WQV-/);
    assert.equal(client.connected, false);
    assert.deepEqual(sent.map(f => f.control), [0x3f]);
  });
}

for (const model of [3, 10]) {
  test(`PC calendar read/write uses the WQV-${model} payload and rejects the other model before sending`, async () => {
    const Type = model === 10 ? ColourCalendar : HolidayCalendar;
    const calendar = new Type(); calendar.set(2000, 1, 1, model === 10 ? 2 : true);
    const client = new WQVClient({ opened: true }, { expectedModel: model });
    client.connected = true; client.model = model;
    const chunks = [];
    client.primarySend = async data => {
      chunks.push(data);
      client.appBuffer = data[0] === 9 && data.length === 1 ? concat(b(0x0d, calendar.raw.length >> 8, calendar.raw.length & 255), calendar.raw) : b(0x0d);
    };
    const received = await client.control(b(9));
    assert.ok(received instanceof Type); assert.deepEqual(received.raw, calendar.raw);
    chunks.length = 0; await client.control(calendar.command());
    assert.ok(equal(concat(...chunks), calendar.command()));
    assert.ok(chunks.every(chunk => chunk.length <= 380));
    chunks.length = 0;
    await assert.rejects(client.control(new (model === 10 ? HolidayCalendar : ColourCalendar)().command()));
    assert.equal(chunks.length, 0);
  });
}
