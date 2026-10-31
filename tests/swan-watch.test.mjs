import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { b, concat, equal, fromHex as hx, toHex, sha256 } from '../dist/formats.mjs';
import { WQV12Decoder, encodeWQV12 } from '../dist/wqv12-formats.mjs';
import { SwanWatchClient } from '../dist/swan-watch-core.mjs';
import { SwanKingsunStream, prepareSwan, transferSwan, swanOutcome } from '../dist/swan-watch-client.mjs';
import { swanArchiveRecord, swanSendRecord } from '../dist/swan-watch-images.mjs';
import { swanDetails, swanRGBA, swanFromRGBA, withSwanDetails, SWAN_PREFIX, SWAN_RECORD_BYTES } from '../dist/swan-watch-formats.mjs';

const capture = JSON.parse(await readFile(new URL('./fixtures/wqv3-swan-hardware.json', import.meta.url)));
const closeCapture = JSON.parse(await readFile(new URL('./fixtures/wqv3-swan-close-hardware.json', import.meta.url)));
const decode = bytes => { const d = new WQV12Decoder(); d.feed(bytes); return d.frames; };
const incoming = decode(hx(capture.sirHex));
const expected = capture.expectedTransmissions.map(f => ({ ...f, data: hx(f.dataHex) }));
const record = concat(...incoming.filter(f => !(f.control & 1) && f.data[0] === 0x11).map(f => f.data.slice(1)));
const wire = f => concat(SWAN_PREFIX, encodeWQV12(f.address, f.control, f.data));
function adapter(reads = []) {
  return { configured: true, opened: true, baud: 38400, readerTask: null, readPending: false, txFrames: 0, rxBytes: 0,
    writes: [], assertOpen() { assert.ok(this.opened); },
    async close() { this.opened = false; }, async readSIR() { return reads.shift() ?? b(); },
    async writeSIR(bytes) { this.writes.push(bytes); return { status: 'ok', bytesWritten: bytes.length }; } };
}

test('SWAN named record has exact captured pixels, caption and date; RGB332 conversion is lossless', async () => {
  assert.equal(record.length, SWAN_RECORD_BYTES);
  assert.equal(await sha256(record), capture.recordSHA256);
  assert.equal(await sha256(record.slice(29)), capture.pixelDataSHA256);
  assert.deepEqual(swanDetails(record), { caption: '*  A   AAAB', recordedAt: '2000-01-06T18:31' });
  const rgba = swanRGBA(record), rebuilt = swanFromRGBA(rgba, swanDetails(record));
  assert.deepEqual(rebuilt, record);
  const changed = withSwanDetails(record, { caption: 'SWAN WEB', recordedAt: '2026-10-31T11:22' });
  assert.equal(swanDetails(changed).caption, 'SWAN WEB');
  assert.deepEqual(changed.slice(29), record.slice(29));
  assert.equal(await sha256(record), capture.recordSHA256);
  assert.throws(() => withSwanDetails(record, { caption: 'Привет', recordedAt: '2026-10-31T11:22' }), /ASCII/);
  assert.throws(() => swanRGBA(record.slice(1)), /25373/);
});
test('a stored SWAN record bypasses JPEG decoding; archive import checks its original SHA-256', async () => {
  const copy = await swanSendRecord({ swanRecord: record });
  assert.deepEqual(copy, record); assert.notEqual(copy, record);
  const archive = { swan: { format: 'casio-wqv-swan-record-v1', recordHex: toHex(record), sha256: capture.recordSHA256 } };
  assert.deepEqual(await swanArchiveRecord(archive), record);
  archive.swan.recordHex = 'ff' + archive.swan.recordHex.slice(2);
  await assert.rejects(swanArchiveRecord(archive), /checksum/);
});
test('invalid SWAN uploads fail before USB or infrared preparation', async () => {
  await assert.rejects(transferSwan({}, { direction: 'send', bytes: b() }), /25373/);
  await assert.rejects(transferSwan({}, { direction: 'unknown' }), /direction/);
});

test('receiver replays the complete real SWAN SEND capture and every exact host reply', async () => {
  const a = adapter([hx(capture.sirHex)]);
  const result = await new SwanWatchClient(a, { challenge: hx(capture.challengeHex), turnaroundMs: 0 }).run({ direction: 'receive', durationMs: 2000 });
  assert.equal(result.status, 'received', JSON.stringify(result.error));
  assert.equal(result.complete, true); assert.equal(result.linkCloseConfirmed, true);
  assert.equal(result.imageBlocks, 25); assert.equal(result.badChecksum, 0);
  assert.equal(await sha256(result.file), capture.recordSHA256);
  assert.deepEqual(a.writes, expected.map(wire));
  assert.equal(swanOutcome(result), 'received');
});

test('receiver does not append a repeated numbered block twice', async () => {
  const frames = [...incoming]; frames.splice(6, 0, incoming[5]);
  const a = adapter([concat(...frames.map(wire))]);
  const result = await new SwanWatchClient(a, { challenge: hx(capture.challengeHex), turnaroundMs: 0 }).run({ direction: 'receive', durationMs: 2000 });
  assert.equal(result.complete, true, JSON.stringify(result.error));
  assert.equal(result.duplicates, 1); assert.equal(result.imageBlocks, 25);
  assert.deepEqual(result.file, record);
  const replies = expected.map(wire); replies.splice(6, 0, replies[5]);
  assert.deepEqual(a.writes, replies);
});

test('a damaged SUM16 block is dropped and its valid repeat supplies the original pixels', async () => {
  const damaged = wire(incoming[5]).slice(); damaged[damaged.length - 2] ^= 1;
  const frames = incoming.map(wire); frames.splice(5, 0, damaged);
  const a = adapter([concat(...frames)]);
  const result = await new SwanWatchClient(a, { challenge: hx(capture.challengeHex), turnaroundMs: 0 }).run({ direction: 'receive', durationMs: 2000 });
  assert.equal(result.complete, true); assert.equal(result.badChecksum, 1);
  assert.deepEqual(result.file, record); assert.deepEqual(a.writes, expected.map(wire));
});

function senderAdapter({ closeReply = true, loseAck = false, headerReply = null } = {}) {
  // The successful watch SEND used an extra idle RR turn after seven data
  // blocks. Omit that idle turn to compare the native nominal sender, then
  // add its independently captured explicit final RR51 / RR41 turn.
  const sent = incoming.filter((_, i) => i !== 12).map(f => ({ ...f }));
  const replies = expected.filter((_, i) => i !== 12).map(f => ({ ...f }));
  sent.splice(-1, 0, { address: 7, control: 0x51, data: b() });
  replies.splice(-1, 0, { address: 7, control: 0x41, data: b() });
  const actualEnding = decode(hx(closeCapture.sirHex)).slice(-2);
  assert.equal(actualEnding[0].control, 0x42); assert.equal(actualEnding[1].control, 0x41);
  replies.splice(-3, 2, ...actualEnding);
  const reads = [], a = adapter(reads); let index = 0, dropped = false;
  a.writeSIR = async bytes => {
    a.writes.push(bytes);
    if (!closeReply && equal(bytes, wire({ address: 7, control: 0x53, data: b() }))) return { status: 'ok', bytesWritten: bytes.length };
    assert.deepEqual(bytes, wire(sent[index]), 'exact captured sender frame ' + index);
    if (loseAck && !dropped && index === 7) { dropped = true; return { status: 'ok', bytesWritten: bytes.length }; }
    reads.push(wire(index === 4 && headerReply ? { ...replies[index], data: headerReply } : replies[index])); index++;
    return { status: 'ok', bytesWritten: bytes.length };
  };
  return a;
}
test('sender preserves every byte and the native ack-first ending, with one offer and 25 blocks', async () => {
  const a = senderAdapter(), client = new SwanWatchClient(a, { turnaroundMs: 0 });
  const result = await client.run({ direction: 'send', bytes: record, durationMs: 2000 });
  assert.equal(result.complete, true, JSON.stringify(result.error));
  assert.equal(result.finalAccepted, true); assert.equal(result.photoTransferComplete, true);
  assert.equal(result.bytesAcknowledged, 25373); assert.equal(result.imageBlocks, 25);
  assert.equal(result.watchStorageVerified, false); assert.equal(swanOutcome(result), 'accepted');
});
test('a lost block ACK repeats exactly the same frame without repeating the image offer', async () => {
  const a = senderAdapter({ loseAck: true }), client = new SwanWatchClient(a, { turnaroundMs: 0 }); client.replyMs = 2;
  const result = await client.run({ direction: 'send', bytes: record, durationMs: 2000 });
  assert.equal(result.complete, true, JSON.stringify(result.error)); assert.equal(result.retries, 1);
  assert.deepEqual(a.writes[7], a.writes[8]);
  assert.equal(a.writes.filter(w => decode(w)[0].data[0] === 0x10).length, 1);
});
test('the actual missing-UA ending retains a confirmed photo without claiming a confirmed close', async () => {
  const a = senderAdapter({ closeReply: false }), client = new SwanWatchClient(a, { turnaroundMs: 0 }); client.replyMs = 2;
  const result = await client.run({ direction: 'send', bytes: record, durationMs: 2000 });
  assert.equal(result.status, 'sent', JSON.stringify(result.error));
  assert.equal(result.complete, false); assert.equal(result.linkCloseConfirmed, false);
  assert.equal(result.photoTransferComplete, true); assert.equal(result.finalAccepted, true);
  assert.equal(result.uploadOutcome, 'accepted'); assert.equal(swanOutcome(result), 'accepted');
  assert.match(result.closeError, /53/);
});
test('receiver rejects changed record size and sends no image acceptance for it', async () => {
  const frames = incoming.slice(0, 4).map(f => ({ ...f })); frames[3].data = hx('10fa631c');
  const a = adapter([concat(...frames.map(wire))]);
  const r = await new SwanWatchClient(a, { challenge: hx(capture.challengeHex), turnaroundMs: 0 }).run({ direction: 'receive', durationMs: 2000 });
  assert.equal(r.photoTransferComplete, false); assert.equal(r.fileCount, 0);
  assert.equal(a.writes.length, 3); assert.match(r.error.message, /header/);
});
test('a rejected offer stops before image data and never starts another upload', async () => {
  const a = senderAdapter({ headerReply: hx('0f02') }), client = new SwanWatchClient(a, { turnaroundMs: 0 });
  const r = await client.run({ direction: 'send', bytes: record, durationMs: 2000 });
  assert.equal(r.imageBlocks, 0); assert.equal(r.finalAccepted, false);
  assert.equal(a.writes.length, 5); assert.equal(swanOutcome(r), 'rejected');
});
test('cancel and deadline end a USB promise which never resolves', { timeout: 1000 }, async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(), a = adapter();
    a.readSIR = () => { if (cancel) queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
    const result = await new SwanWatchClient(a, { signal: controller.signal, turnaroundMs: 0 }).run({ direction: 'receive', durationMs: 20 });
    assert.equal(a.opened, false); assert.equal(result.complete, false);
    assert.equal(result.status, cancel ? 'interrupted' : 'error');
    assert.equal(swanOutcome(result), cancel ? 'cancelled' : 'error');
  }
});
test('USB preparation chooses 38400 without sending IR and retains the measured SigmaTel receiver', async () => {
  const calls = [], a = { decoder: { reset() {}, frames: [1] },
    async pauseReader() { calls.push('pause'); }, async setupSIR() { calls.push('setup'); },
    async setSIRSpeed(rate) { calls.push(rate); }, assertOpen() {},
    async registers() { return hx('2a1d00274400001500'); } };
  await prepareSwan(a); assert.deepEqual(calls, ['pause', 'setup', 38400]); assert.deepEqual(a.decoder.frames, []);
});
test('KS counter synchronization accepts SWAN challenges and two B3 greetings from every phase', () => {
  for (const phase of [0, 1, 55, 128, 254, 255]) for (const sendMode of [false, true]) {
    const original = sendMode ? concat(...incoming.slice(0, 1).map(wire), ...incoming.slice(0, 1).map(wire)) : wire({ address: 255, control: 0xa3, data: hx('feedcafe') });
    let counter = phase; const masked = [];
    for (const byte of original) {
      counter = (counter + 1) & 255;
      if (!counter) { masked.push(0x95 ^ 0x55); counter = 1; }
      masked.push(byte ^ counter ^ 0x55);
    }
    const stream = new SwanKingsunStream();
    const clear = concat(stream.feed(b(...masked.slice(0, 3))), stream.feed(b(...masked.slice(3))));
    assert.deepEqual(clear, original); assert.ok(stream.counter);
  }
});
