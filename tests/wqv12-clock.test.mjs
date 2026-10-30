import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { b, fromHex, toHex } from '../dist/formats.mjs';
import { encodeWQV12, WQV12Decoder } from '../dist/wqv12-formats.mjs';
import { wqv12ClockPayload } from '../dist/wqv12-clock.mjs';
import { WQV12Client } from '../dist/wqv12-core.mjs';

const original = JSON.parse(readFileSync(new URL('./fixtures/wqv12-clock-palm.json', import.meta.url)));

class ClockWatch {
  opened = true; configured = true; baud = 115200; readerTask = null; readPending = false;
  txFrames = 0; rxBytes = 0; sent = []; queue = []; clockRequests = 0; polls = 0;
  constructor(options = {}) { this.options = options; }
  assertOpen() { assert.ok(this.opened); }
  async close() { this.opened = false; }
  reply(control, data = b(), address = 2) { this.queue.push(encodeWQV12(address, control, data)); }
  async readSIR() { return this.queue.shift() || b(); }
  async writeSIR(wire) {
    const decoder = new WQV12Decoder(); decoder.feed(wire);
    assert.equal(decoder.frames.length, 1); const frame = decoder.frames[0];
    this.sent.push({ ...frame, wireHex: toHex(wire) });
    const { address, control, data } = frame;
    if (address === 255 && control === 0xb3) this.reply(0xa3, b(12, 34, 56, 128), 255);
    else if (address === 255 && control === 0x93) this.reply(0x63);
    else if (control === 0x11 && !this.clockRequests) this.reply(1);
    else if (control === 0x10) {
      assert.equal(data[0], 0x0d); assert.equal(data.length, 7);
      this.clockRequests++; this.reply(0x21);
    } else if (control === 0x11) {
      this.polls++;
      if (!this.options.silent && !(this.options.dropFirstReply && this.polls === 1)) this.reply(0x20, this.options.reply || b(6));
    } else if (control === 0x32) {
      assert.deepEqual(data, b(8, 0));
      if (!this.options.noFinish) this.reply(0x41);
    } else if (control === 0x53) this.reply(0x63);
    else throw new Error('Unexpected clock exchange frame: ' + toHex(wire));
    return { status: 'ok', bytesWritten: wire.length };
  }
}

test('clock fields and completion bytes match the original Palm 68k program, including leap day and unchanged seconds', () => {
  assert.equal(original.cases.length, 8);
  for (const item of original.cases) {
    const payload = wqv12ClockPayload(item.dateTime);
    assert.equal(toHex(payload), item.payloadHex);
    assert.equal(toHex(encodeWQV12(2, 0x10, payload)), item.wireHex);
    assert.equal(toHex(encodeWQV12(2, 0x32, b(8, 0))), item.acknowledgement.completionWireHex);
    assert.equal(item.acknowledgement.completionPayloadHex, '0800');
    assert.equal(item.acknowledgement.nextApplicationState, 5);
  }
  assert.equal(original.cases[0].payloadHex, original.cases[1].payloadHex, 'input seconds never enter the request');
  assert.equal(original.cases[0].payloadHex, '0d000101000006');
});

test('clock setting needs an application ACK, then sends the original completion and disconnects without any photo request', async () => {
  const watch = new ClockWatch(), events = [];
  const result = await new WQV12Client(watch, { turnaroundMs: 0, record: (kind, details) => events.push({ kind, ...details }) })
    .run({ mode: 'set-clock', clockValue: '2026-10-30T12:34' });
  assert.equal(result.status, 'clock-set'); assert.equal(result.complete, true);
  assert.deepEqual(result.clockUpdate, { requested: '2026-10-30T12:34', payloadHex: '0d1a0a1e0c2205',
    secondsChanged: false, outcome: 'accepted', replyHex: '06' });
  assert.equal(result.clockHex, '0c223880', 'greeting clock is not replaced by a fabricated readback');
  assert.deepEqual(watch.sent.map(f => f.control), [0xb3, 0x93, 0x11, 0x10, 0x11, 0x32, 0x53]);
  assert.equal(events.find(e => e.kind === 'wqv12-start').readOnly, false);
  assert.equal(watch.clockRequests, 1); assert.equal(result.imageCount, 0);
});

test('a lost application reply repeats the same poll rather than submitting another clock command', async () => {
  const watch = new ClockWatch({ dropFirstReply: true });
  const result = await new WQV12Client(watch, { turnaroundMs: 0, replyMs: 5 }).run({ mode: 'set-clock', clockValue: '2026-10-30T12:34' });
  assert.equal(result.complete, true); assert.equal(result.retries, 1);
  assert.equal(watch.clockRequests, 1); assert.equal(watch.polls, 2);
});

test('a rejected or missing clock acknowledgement is never reported as a completed update', async () => {
  for (const options of [{ reply: b(8, 2) }, { reply: b(7, 0xfa, 0x1c, 0x3d, 1) }, { silent: true }]) {
    const watch = new ClockWatch(options);
    const result = await new WQV12Client(watch, { turnaroundMs: 0, replyMs: 4, retries: 2 })
      .run({ mode: 'set-clock', clockValue: '2026-10-30T12:34' });
    assert.equal(result.complete, false); assert.equal(result.status, 'error');
    assert.notEqual(result.clockUpdate.outcome, 'accepted');
    assert.equal(watch.sent.some(f => f.control === 0x32), false);
    assert.equal(watch.clockRequests, 1);
  }
});

test('losing completion after the clock ACK retains accepted state and does not send another date', async () => {
  const watch = new ClockWatch({ noFinish: true });
  const result = await new WQV12Client(watch, { turnaroundMs: 0, replyMs: 4, retries: 2 })
    .run({ mode: 'set-clock', clockValue: '2026-10-30T12:34' });
  assert.equal(result.complete, false); assert.equal(result.clockUpdate.outcome, 'accepted');
  assert.equal(watch.clockRequests, 1); assert.equal(watch.sent.filter(f => f.control === 0x32).length, 2);
});

test('invalid dates and sub-minute input are rejected before the first infrared transmission', async () => {
  for (const value of ['2026-02-29T12:34', '1999-12-31T23:59', '2040-01-01T00:00',
    '2026-10-30T24:00', '2026-10-30T12:60', '2026-10-30T12:34:56', '', undefined]) {
    const watch = new ClockWatch();
    await assert.rejects(new WQV12Client(watch).run({ mode: 'set-clock', clockValue: value }));
    assert.equal(watch.sent.length, 0);
  }
});

test('reading the greeting time stays read-only and never transmits the clock opcode', async () => {
  const watch = new ClockWatch(), events = [];
  const result = await new WQV12Client(watch, { turnaroundMs: 0, record: (kind, details) => events.push({ kind, ...details }) }).run();
  assert.equal(result.complete, true); assert.equal(result.clockHex, '0c223880');
  assert.equal(result.clockUpdate, null); assert.equal(watch.clockRequests, 0);
  assert.equal(events.find(e => e.kind === 'wqv12-start').readOnly, true);
});
