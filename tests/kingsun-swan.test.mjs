import test from 'node:test';
import assert from 'node:assert/strict';
import { b, concat } from '../dist/formats.mjs';
import { KingsunCounter } from '../dist/kingsun.mjs';
import { WQV12Decoder, encodeWQV12 } from '../dist/wqv12-formats.mjs';
import { transferSwan } from '../dist/swan-watch-client.mjs';
import { SWAN_PREFIX, SWAN_RECORD_BYTES } from '../dist/swan-watch-formats.mjs';

// Decode the actual 240-byte USB fragments, and act as a window-one SWAN
// receiver. No adapter or watch is opened by this test.
function receivingWatch() {
  const decoder = new WQV12Decoder(), queue = [], blocks = [], fragments = [];
  const key = new TextEncoder().encode('wangshuofei19710');
  let phase = 137, next = 1, largestWire = 0;
  const reply = (control, data = b(), address = 7) => queue.push(concat(SWAN_PREFIX, encodeWQV12(address, control, data)));
  const a = { opened: true, configured: true, baud: 38400, readerTask: null, readPending: false,
    description: { driver: 'KingSun KS-959' }, stream: { counter: new KingsunCounter(phase) },
    decoder: { reset() {}, frames: [] }, rxBytes: 0, txFrames: 0,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
    async io(promise) { return promise; }, async setSIRSpeed(baud) { this.baud = baud; },
    async sendFrame(address, control) { assert.equal(this.baud, 9600); assert.equal(address, 255); assert.equal(control, 0x3f); },
  };
  a.device = {
    async controlTransferOut(setup, encoded) {
      assert.equal(setup.index, 0); assert.ok(setup.value > 0 && setup.value <= 240);
      assert.equal(encoded.length, Math.ceil(setup.value / 8) * 8 + 16);
      assert.ok(encoded.subarray(setup.value).every(v => v === 0));
      const mask = key[(setup.value & 15) ^ 6] ^ 0x55;
      const clear = Uint8Array.from(encoded.subarray(0, setup.value), v => v ^ mask);
      fragments.push(clear); decoder.feed(clear);
      for (const f of decoder.frames.splice(0)) {
        largestWire = Math.max(largestWire, SWAN_PREFIX.length + encodeWQV12(f.address, f.control, f.data).length);
        if (f.address === 255 && f.control === 0xb3) reply(0xa3, b(1, 2, 3, 4), 255);
        else if (f.address === 255 && f.control === 0x93) reply(0x63);
        else if (f.control === 0x11) reply(blocks.length ? 0x21 : 1);
        else if (f.control === 0x10) reply(0x20, b(0x0d));
        else if (f.data[0] === 0x11) {
          assert.equal((f.control >>> 1) & 7, next);
          blocks.push(f.data.slice(1)); next = (next + 1) & 7; reply((next << 5) | 1);
        } else if (f.control === 0x31) reply((next << 5) | 2, b(0x0d));
        else if (f.control === 0x51) reply((next << 5) | 1);
        else if (f.control === 0x53) reply(0x63);
        else assert.fail('Unexpected SWAN frame: ' + f.control);
      }
      return { status: 'ok', bytesWritten: encoded.length };
    },
    async controlTransferIn() {
      const raw = [];
      for (const v of queue.shift() ?? b()) {
        phase = (phase + 1) & 255;
        if (!phase) { raw.push(0x95 ^ 0x55); phase = 1; }
        raw.push(v ^ phase ^ 0x55);
      }
      const bytes = b(...raw);
      return { status: 'ok', data: new DataView(bytes.buffer) };
    },
  };
  return { adapter: a, blocks, fragments, largestWire: () => largestWire };
}

test('KS-959 sends complete SWAN photos even when escaping doubles every pixel byte', { timeout: 15000 }, async () => {
  for (const value of [0xc0, 0xc1, 0x7d]) {
    const photo = new Uint8Array(SWAN_RECORD_BYTES).fill(value);
    photo.fill(32, 0, 24); photo.set([26, 10, 31, 12, 0], 24);
    const watch = receivingWatch();
    const result = await transferSwan(watch.adapter, { direction: 'send', bytes: photo, durationMs: 4000 });
    assert.equal(result.complete, true, JSON.stringify(result.error));
    assert.equal(result.finalAccepted, true); assert.equal(result.imageBlocks, 25);
    assert.deepEqual(concat(...watch.blocks), photo);
    assert.ok(watch.largestWire() > 2048, 'exercise the escaped-wire boundary');
    assert.ok(watch.fragments.every(part => part.length <= 240));
  }
});
