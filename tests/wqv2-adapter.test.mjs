import test from 'node:test';
import assert from 'node:assert/strict';
import { WQV2KingsunStream } from '../dist/wqv2-adapter.mjs';
import { WQV12Decoder, encodeWQV12, isWQV12ClockReply } from '../dist/wqv12-formats.mjs';
import { b, concat } from '../dist/formats.mjs';

function incoming(clear, phase) {
  const result = [];
  for (const value of clear) {
    if (phase === 255) { result.push(0x95 ^ 0x55); phase = 0; }
    phase++; result.push(value ^ phase ^ 0x55);
  }
  return Uint8Array.from(result);
}

test('KS-959 old-protocol synchronization accepts a unique SUM16 clock, at every starting counter', () => {
  const clock = encodeWQV12(255, 0xa3, b(22, 44, 12, 0xc0));
  const wire = concat(b(255, 255), clock, encodeWQV12(2, 0x63));
  for (let phase = 0; phase < 256; phase++) {
    const events = [], stream = new WQV2KingsunStream(e => events.push(e));
    const encoded = incoming(wire, phase), result = [];
    for (let offset = 0; offset < encoded.length; offset++) result.push(stream.feed(encoded.slice(offset, offset + 1)));
    assert.deepEqual(concat(...result), wire, 'initial phase ' + phase);
    assert.equal(events.length, 1); assert.equal(events[0].initialPhase, phase);
    assert.equal(stream.counter.phase, (phase + encoded.length) & 255);
  }
});

test('bad SUM16, nonclock frames and invalid clock fields do not qualify a receive counter', () => {
  const corrupt = encodeWQV12(255, 0xa3, b(12, 34, 56, 0)); corrupt[7] ^= 1;
  const prefix = concat(encodeWQV12(2, 0x63), corrupt,
    encodeWQV12(255, 0xa3, b(25, 34, 56, 0)), encodeWQV12(255, 0xa3, b(12, 61, 56, 0)));
  const good = encodeWQV12(255, 0xa3, b(12, 34, 56, 0)), wire = concat(prefix, good);
  const stream = new WQV2KingsunStream(), encoded = incoming(wire, 250);
  const prefixEncoded = incoming(prefix, 250);
  assert.equal(stream.feed(prefixEncoded).length, 0); assert.equal(stream.counter, null);
  const replay = stream.feed(encoded.slice(prefixEncoded.length));
  assert.deepEqual(replay, wire);
  const decoder = new WQV12Decoder(); decoder.feed(replay);
  assert.equal(decoder.frames.filter(isWQV12ClockReply).length, 1);
  assert.equal(decoder.badChecksum, 1);
});

test('the legacy counter search stays bounded while the watch is absent', () => {
  const stream = new WQV2KingsunStream();
  for (let i = 0; i < 12; i++) stream.feed(new Uint8Array(2048));
  assert.equal(stream.counter, null); assert.ok(stream.pendingBytes <= 16384);
});

test('OTHERS counter synchronization waits for two valid watch-initiated greetings without transmitting', () => {
  const hello = encodeWQV12(255, 0xb3), wire = concat(hello, hello);
  for (const phase of [0, 50, 137, 250, 255]) {
    const events = [], stream = new WQV2KingsunStream(e => events.push(e), 'others');
    const encoded = incoming(wire, phase), firstLength = incoming(hello, phase).length;
    assert.equal(stream.feed(encoded.slice(0, firstLength)).length, 0);
    assert.equal(stream.counter, null);
    assert.deepEqual(stream.feed(encoded.slice(firstLength)), wire);
    assert.equal(events.length, 1); assert.equal(events[0].qualification, 'two-valid-sum16-watch-greetings');
  }
});

test('a mode change preserves a known physical counter but replaces an unqualified search', () => {
  const stream = new WQV2KingsunStream();
  stream.setMode('others'); assert.equal(stream.mode, 'others');
  const hello = encodeWQV12(255, 0xb3), first = concat(hello, hello);
  assert.deepEqual(stream.feed(incoming(first, 20)), first);
  const counter = stream.counter;
  stream.setMode('pc'); assert.equal(stream.counter, counter);
  const clock = encodeWQV12(255, 0xa3, b(1, 2, 3, 4));
  assert.deepEqual(stream.feed(incoming(clock, counter.phase)), clock);
});
