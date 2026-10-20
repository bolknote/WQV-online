import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
// Golden body/FCS from the original PAD-5 x86 CRC recovery routine:
// stirusb.sys 1.23 SHA256 7b75d5fb...18a225, functions 0x1092a / 0x1367e.
const golden = 'fe10c0c17d434153494f9681';
const expected = { address: 0xfe, control: 0x10, data: bytes('c0c17d434153494f') };
function wire(body, aliases = false) {
  const out = [0xc0];
  for (const byte of bytes(body)) {
    if ([0xc0, 0xc1, 0x7d].includes(byte)) out.push(0x7d, aliases && byte !== 0x7d ? byte === 0xc0 ? 0xf0 : 0xf8 : byte ^ 0x20);
    else out.push(byte);
  }
  return Uint8Array.of(...out, 0xc1);
}
function decode(input, enabled = true) {
  const decoder = new FrameDecoder({ recoverFrames: enabled });
  for (const byte of input) decoder.feed(Uint8Array.of(byte));
  return decoder;
}
test('a valid original PAD-5 frame needs no correction', () => {
  const d = decode(wire(golden));
  assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 0); assert.equal(d.badCRC, 0);
});
test('one stray edge byte is removed only after a successful CRC recheck', () => {
  for (const body of ['23' + golden, golden + '23']) {
    const d = decode(wire(body));
    assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 1); assert.equal(d.badCRC, 0);
    const strict = decode(wire(body), false);
    assert.equal(strict.frames.length, 0); assert.equal(strict.badCRC, 1);
  }
});
test('PAD-5 alternative escapes survive single-byte USB chunks and a stray edge', () => {
  for (const body of [golden, '23' + golden, golden + '23']) {
    const d = decode(wire(body, true));
    assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 1); assert.equal(d.badCRC, 0);
  }
  const strict = decode(wire(golden, true), false);
  assert.equal(strict.frames.length, 0); assert.equal(strict.badCRC, 1);
});
test('damaged data, damaged FCS and two stray edge bytes are never accepted', () => {
  for (const body of ['fe10c0c07d434153494f9681', golden.slice(0, -2) + '80', '23' + golden + '24']) {
    const d = decode(wire(body));
    assert.equal(d.frames.length, 0); assert.equal(d.badCRC, 1); assert.equal(d.recoveredFrames, 0);
  }
});
test('two different edge candidates with valid CRC are rejected as ambiguous', () => {
  // 30100042af54 and 100042af5417 each have a valid FCS.
  const d = decode(wire('30100042af5417'));
  assert.equal(d.frames.length, 0); assert.equal(d.badCRC, 1); assert.equal(d.recoveredFrames, 0);
});
test('an already valid frame wins over the alternative escape interpretation', () => {
  const raw = encodeFrame(0xfe, 0x10, bytes('d0d8'));
  const escaped = [];
  for (const byte of raw) escaped.push(...(byte === 0xd0 ? [0x7d, 0xf0] : byte === 0xd8 ? [0x7d, 0xf8] : [byte]));
  const d = decode(escaped);
  assert.deepEqual(d.frames, [{ address: 0xfe, control: 0x10, data: bytes('d0d8') }]);
  assert.equal(d.recoveredFrames, 0); assert.equal(d.badCRC, 0);
});
test('recovery cannot combine stale bytes across a reset or an oversized frame', () => {
  const d = new FrameDecoder({ recoverFrames: true }), raw = wire(golden, true);
  d.feed(raw.slice(0, 5)); d.reset(); d.feed(raw.slice(5));
  assert.equal(d.frames.length, 0);
  d.feed(Uint8Array.of(0xc0, ...new Array(4097).fill(0x12), 0xc1));
  assert.equal(d.body, null); assert.equal(d.pad5Escapes.length, 0);
  d.feed(wire(golden)); assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 0);
});
