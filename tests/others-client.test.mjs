import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WATCH_MODE_KEY, readWatchMode, watchTabs, prepareOthers, transferOthers, othersImage, othersOutcome } from '../dist/others-client.mjs';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, fromHex as hx, toHex, sha256, loadArchive } from '../dist/formats.mjs';

const fixtures = JSON.parse(await readFile(new URL('./receiver-hardware-fixtures.json', import.meta.url)));

test('watch mode defaults to PC and OTHERS exposes only photo and connection tabs', () => {
  for (const value of [null, 'PC', '', 'pc']) assert.equal(readWatchMode({ getItem: () => value }), 'pc');
  assert.equal(readWatchMode({ getItem(key) { assert.equal(key, WATCH_MODE_KEY); return 'others'; } }), 'others');
  assert.equal(readWatchMode({ getItem() { throw new Error('blocked'); } }), 'pc');
  assert.equal(readWatchMode({ getItem: () => 'swan' }), 'swan');
  assert.deepEqual(watchTabs('swan'), ['photos', 'connection']);
  assert.deepEqual(watchTabs('others'), ['photos', 'connection']);
  assert.deepEqual(watchTabs('pc'), ['photos', 'clock', 'holidays', 'connection']);
});

test('USB preparation stops the PC reader and clears old frames without any infrared transmission', async () => {
  const calls = [], adapter = { decoder: new FrameDecoder(),
    async pauseReader() { calls.push('pause'); }, async setupSIR() { calls.push('setup'); }, assertOpen() { calls.push('open'); } };
  adapter.decoder.feed(encodeFrame(1, 0x11));
  await prepareOthers(adapter);
  assert.deepEqual(calls, ['pause', 'setup', 'open']); assert.deepEqual(adapter.decoder.frames, []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareOthers(adapter, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 3);
});

test('the album receives the original UPF and a normal WQV archive from an OTHERS file', async () => {
  const session = fixtures.sessions[0], bytes = hx(session.expectedUPFHex);
  const image = await othersImage({ filename: 'QW000000.UPF', bytes });
  assert.equal(image.source, 'watch'); assert.equal(image.protocol, 'others');
  assert.equal(image.name, 'QW000000'); assert.deepEqual(image.upf, bytes);
  assert.equal(image.id, await sha256(image.jpeg));
  assert.equal(image.archive.format, 'casio-wqv-transfer-v1');
  assert.equal(image.archive.filename, 'QW000000.UPF');
  assert.deepEqual(await loadArchive(image.archive), bytes);
});

test('normal receive uses the actual OTHERS SEND capture, preserving the file and all replies', async () => {
  const session = fixtures.sessions[0], decoder = new FrameDecoder({ recoverFrames: true });
  decoder.feed(hx(session.usbInHex));
  const images = []; let index = 0;
  const adapter = { decoder, opened: true, configured: true, baud: 9600, readerTask: null,
    rxBytes: 0, txFrames: 0, readPending: false, revision: 7,
    assertOpen() { assert.ok(this.opened); }, async setSIRSpeed(baud) { this.baud = baud; }, async close() { this.opened = false; },
    async sendFrame(address, control, data) {
      assert.deepEqual({ address, control, dataHex: toHex(data) }, session.expectedTransmissions[index++]); this.txFrames++;
    }, device: { transferIn() { throw new Error('Unexpected read'); } } };
  const summary = await transferOthers(adapter, { direction: 'receive', localID: hx(session.localID), durationMs: 2000,
    onFile: async file => images.push(await othersImage(file)) });
  assert.equal(othersOutcome(summary), 'received'); assert.equal(summary.negotiatedBaud, 115200);
  assert.equal(index, session.expectedTransmissions.length); assert.equal(images.length, 1);
  assert.equal(toHex(images[0].upf), session.expectedUPFHex);
  assert.equal(decoder.recoverFrames, true); assert.equal(Boolean(decoder.recoverBOF), false, 'restore PC decoder settings');
});

test('normal sender replays a recorded lost-frame session with one PUT and peer-sized packets', { timeout: 35000 }, async () => {
  const recorded = JSON.parse(await readFile(new URL('./link-recovery-hardware-fixtures.json', import.meta.url)));
  const session = recorded.sessions.find(s => s.scenario === 'bad-crc'), queued = [], events = [];
  let index = 0;
  const adapter = { opened: true, configured: true, baud: 9600, readerTask: null, revision: 7,
    decoder: new FrameDecoder({ recoverFrames: true }), rxBytes: 0, txFrames: 0, readPending: false,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; }, async setSIRSpeed(baud) { this.baud = baud; },
    device: { async transferIn() {
      const bytes = queued.shift() ?? b();
      return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
    } },
    async sendFrame(address, control, data) {
      const group = session.groups[index++]; assert.ok(group, 'No extra PUT or unexpected output');
      assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
      queued.push(...group.reads.map(hx)); this.txFrames++;
    } };
  const summary = await transferOthers(adapter, { direction: 'send', localID: hx(session.localID), durationMs: 30000,
    file: { filename: session.input.filename, bytes: hx(session.input.dataHex) }, record: (kind, data) => events.push({ kind, ...data }) });
  assert.equal(othersOutcome(summary), 'accepted', JSON.stringify(summary.error));
  assert.equal(summary.negotiatedBaud, 115200); assert.equal(summary.linkRecovery.enabled, true);
  assert.equal(summary.putRequests, 1); assert.equal(summary.putAccepted, 1); assert.equal(summary.putSegments, 3);
  assert.equal(index, session.groups.length); assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.ok(summary.retransmissions > 0); assert.equal(Boolean(adapter.decoder.recoverBOF), false);
});

test('an unfinished PUT is never presented as success or automatically safe to repeat', () => {
  const accepted = { direction: 'send', uploadOutcome: 'accepted', status: 'sent', complete: true, disconnected: true };
  assert.equal(othersOutcome(accepted), 'accepted');
  assert.equal(othersOutcome({ ...accepted, disconnected: false }), 'accepted-incomplete');
  assert.equal(othersOutcome({ ...accepted, status: 'error' }), 'accepted-incomplete');
  assert.equal(othersOutcome({ direction: 'send', putRequests: 1, status: 'error' }), 'unconfirmed');
  assert.equal(othersOutcome({ direction: 'send', putRequests: 1, status: 'interrupted' }), 'unconfirmed');
  assert.equal(othersOutcome({ direction: 'send', uploadOutcome: 'not-sent' }), 'not-sent');
  assert.equal(othersOutcome({ direction: 'send', uploadOutcome: 'rejected' }), 'rejected');
  assert.equal(othersOutcome({ fileCount: 1, status: 'error' }), 'received-incomplete');
  assert.equal(othersOutcome({ status: 'interrupted' }), 'cancelled');
});

test('cancellation ends a pending USB read even if the driver never settles it', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const adapter = { opened: true, configured: true, baud: 9600, readerTask: null, revision: 7,
    decoder: new FrameDecoder(), rxBytes: 0, txFrames: 0, readPending: false,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
    device: { transferIn() { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } } };
  const result = await transferOthers(adapter, { direction: 'receive', signal: controller.signal });
  assert.equal(result.status, 'interrupted'); assert.equal(othersOutcome(result), 'cancelled');
  assert.equal(adapter.opened, false);
});
