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

test('a damaged EOF is removed after two consecutive empty reads, with the original FCS', () => {
  // Original PAD-5 0x132fa -> 0x136b4, revision 7 at 115200.
  // C1 -> E1 or 81 changes one bit without inserting a wire byte.
  for (const eof of [0xe1, 0x81]) {
    const raw = wire(golden); raw[raw.length - 1] = eof;
    const d = decode(raw);
    d.emptyRead(2); assert.equal(d.frames.length, 0);
    d.emptyRead(2);
    assert.deepEqual(d.frames, [expected]);
    assert.equal(d.recoveredFrames, 1); assert.equal(d.badCRC, 0);
    assert.equal(d.body, null); assert.equal(d.emptyReads, 0);
  }
});

test('a missing EOF with valid CRC keeps every data byte and is counted as recovery once', () => {
  const d = decode(wire(golden).slice(0, -1));
  d.emptyRead(2); d.emptyRead(2);
  assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 1);
  d.emptyRead(2); d.feed(bytes('c1')); // A late EOF cannot duplicate the frame.
  assert.equal(d.frames.length, 1); assert.equal(d.recoveredFrames, 1);
  d.feed(wire(golden));
  assert.deepEqual(d.frames, [expected, expected]); assert.equal(d.recoveredFrames, 1);
});

test('idle completion checks only the trailing edge and rejects corrupt data and FCS', () => {
  for (const body of [
    '23' + golden, // Removing the first byte would pass, but is not the idle rule.
    'fe10c0c07d434153494f9681e1',
    golden.slice(0, -2) + '80e1',
    golden + '23e1',
  ]) {
    const d = decode(wire(body).slice(0, -1));
    d.emptyRead(2); d.emptyRead(2);
    assert.equal(d.frames.length, 0); assert.equal(d.badCRC, 1);
    assert.equal(d.recoveredFrames, 0); assert.equal(d.body, null);
    d.feed(wire('e0' + golden));
    assert.deepEqual(d.frames, [expected], 'No stale trailing-edge flag leaks into the next frame');
  }
});

test('the idle rule can select the trailing candidate when the two edges would disagree', () => {
  // Both edge candidates pass CRC (see the normal-EOF ambiguity fixture above).
  const d = decode(wire('30100042af5417').slice(0, -1));
  d.emptyRead(2); d.emptyRead(2);
  assert.deepEqual(d.frames, [{ address: 0x30, control: 0x10, data: bytes('0042') }]);
  assert.equal(d.recoveredFrames, 1); assert.equal(d.badCRC, 0);
});

test('one idle read at every USB split preserves a complete frame without recovery', () => {
  const raw = wire(golden);
  for (let split = 1; split < raw.length; split++) {
    const d = decode(raw.slice(0, split));
    d.emptyRead(2); d.feed(raw.slice(split));
    assert.deepEqual(d.frames, [expected], `USB split ${split}`);
    assert.equal(d.recoveredFrames, 0); assert.equal(d.badCRC, 0);
  }
  const damaged = raw.slice(); damaged[damaged.length - 1] = 0xe1;
  const split = 5, d = decode(damaged.slice(0, split));
  d.emptyRead(2); d.feed(damaged.slice(split)); d.emptyRead(2);
  assert.equal(d.frames.length, 0, 'Nonempty reads restart the two-read count');
  d.emptyRead(2); assert.deepEqual(d.frames, [expected]);
});

test('an unfinished escape or a BOF never becomes an idle-completed frame', () => {
  const data = bytes('434153494f7d'), raw = encodeFrame(0xfe, 0x10, data, 1);
  const split = raw.indexOf(0x7d) + 1, d = decode(raw.slice(0, split));
  const pending = d.body.slice();
  for (let i = 0; i < 4; i++) d.emptyRead(2);
  assert.deepEqual(d.body, pending); assert.equal(d.escaped, true);
  assert.equal(d.badCRC, 0); assert.equal(d.emptyReads, 0);
  d.feed(raw.slice(split));
  assert.deepEqual(d.frames, [{ address: 0xfe, control: 0x10, data }]);
  assert.equal(d.recoveredFrames, 0);
  const bof = decode(bytes('c0c0'));
  for (let i = 0; i < 4; i++) bof.emptyRead(2);
  assert.deepEqual(bof.body, []); assert.equal(bof.frames.length, 0);
});

test('idle completion requires recovery opt-in and an enabled transport rule', () => {
  const raw = wire(golden).slice(0, -1);
  for (const [enabled, requiredReads] of [[false, 2], [true, 0]]) {
    const d = decode(raw, enabled);
    for (let i = 0; i < 4; i++) d.emptyRead(requiredReads);
    assert.equal(d.frames.length, 0); assert.equal(d.body.length, golden.length / 2);
    assert.equal(d.badCRC, 0); assert.equal(d.recoveredFrames, 0);
    d.feed(bytes('c1')); assert.deepEqual(d.frames, [expected]);
    assert.equal(d.recoveredFrames, 0);
  }
  const d = decode(raw);
  d.feed(new Uint8Array()); d.feed(new Uint8Array());
  assert.equal(d.emptyReads, 0, 'Only the transport reports a successful empty read');
  d.emptyRead(2); d.reset(); d.feed(raw); d.emptyRead(2);
  assert.equal(d.frames.length, 0, 'A decoder reset clears the previous idle-read count');
  d.emptyRead(2); assert.deepEqual(d.frames, [expected]);
});

test('PAD-5 alternative escapes can be combined with a damaged EOF after idle', () => {
  const raw = wire(golden, true); raw[raw.length - 1] = 0xe1;
  const d = decode(raw);
  d.emptyRead(2); d.emptyRead(2);
  assert.deepEqual(d.frames, [expected]); assert.equal(d.recoveredFrames, 1);
  assert.equal(d.badCRC, 0);
});
