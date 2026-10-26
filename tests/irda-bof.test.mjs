import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { b, concat, fromHex as hx } from '../dist/formats.mjs';

// Original USB reply from WQV-IrTranP-2026-10-24T06-00-49-310Z.zip.
const RAW = hx('e070520100840000010001020003000107a83dc1');
const ANSWER = { address: 0x70, control: 0x52, data: hx('0100840000010001020003000107') };
const decoder = () => new FrameDecoder({ recoverFrames: true, recoverBOF: true });

test('the recorded E0-started IAS reply is recovered only with its original CRC and a real EOF, across every split', () => {
  for (let split = 0; split <= RAW.length; split++) {
    const d = decoder(); d.feed(RAW.slice(0, split)); d.feed(RAW.slice(split));
    assert.deepEqual(d.frames, [ANSWER]); assert.equal(d.recoveredBOF, 1); assert.equal(d.recoveredFrames, 1);
    assert.equal(d.badCRC, 0); assert.equal(d.rejectedBOF, 0);
  }
  const d = decoder(); for (const byte of RAW) d.feed(b(byte));
  assert.deepEqual(d.frames, [ANSWER]);
});

test('the three later IAS recordings with marker 81 recover their unchanged Parameters reply', () => {
  // Original body and FCS recur in the 08:08, 08:09 and 08:10 captures.
  const raw = hx('8170520100840000010001020003000107a83dc1');
  for (let split = 0; split <= raw.length; split++) {
    const d = decoder(); d.feed(raw.slice(0, split)); d.feed(raw.slice(split));
    assert.deepEqual(d.frames, [ANSWER]); assert.equal(d.recoveredBOF, 1);
  }
  const strict = new FrameDecoder({ recoverFrames: true }); strict.feed(raw);
  assert.deepEqual(strict.frames, []);
  const data = hx('8101817d81'), inside = decoder(); inside.feed(encodeFrame(0x70, 0x52, data));
  assert.deepEqual(inside.frames, [{ address: 0x70, control: 0x52, data }]); assert.equal(inside.recoveredBOF, 0);
  for (const damaged of [concat(raw.slice(0, 1), b(0x23), raw.slice(1)), concat(raw.slice(0, -1), b(0x23), raw.slice(-1))]) {
    const d = decoder(); d.feed(damaged); assert.deepEqual(d.frames, []); assert.equal(d.rejectedBOF, 1);
  }
  const corrupt = raw.slice(); corrupt[4] ^= 1;
  const d = decoder(); d.feed(corrupt); assert.deepEqual(d.frames, []); assert.equal(d.rejectedBOF, 1);
});

test('BOF recovery requires separate opt-in and never changes E0 inside a valid frame', () => {
  for (const options of [{}, { recoverFrames: true }, { recoverBOF: true }]) {
    const d = new FrameDecoder(options); d.feed(RAW); assert.equal(d.frames.length, 0); assert.equal(d.recoveredBOF, 0);
  }
  const d = decoder(), data = hx('e001e07de0'); d.feed(encodeFrame(0x70, 0x52, data));
  assert.deepEqual(d.frames, [{ address: 0x70, control: 0x52, data }]); assert.equal(d.recoveredFrames, 0);
});

test('a speculative BOF cannot combine with data repair, edge-byte removal or altered FCS', () => {
  const badData = RAW.slice(); badData[4] ^= 1;
  const badFCS = RAW.slice(); badFCS[RAW.length - 2] ^= 1;
  const extraLeading = concat(RAW.slice(0, 1), b(0x23), RAW.slice(1));
  const extraTrailing = concat(RAW.slice(0, -1), b(0x23), RAW.slice(-1));
  for (const raw of [badData, badFCS, extraLeading, extraTrailing]) {
    const d = decoder(); d.feed(raw);
    assert.equal(d.frames.length, 0); assert.equal(d.recoveredFrames, 0); assert.equal(d.rejectedBOF, 1);
  }
});

test('idle reads cannot finish a speculative BOF and reset/real BOF discard the candidate', () => {
  const d = decoder(); d.feed(RAW.slice(0, -1));
  for (let i = 0; i < 5; i++) d.emptyRead(2);
  assert.equal(d.frames.length, 0); d.feed(b(0xc1)); assert.deepEqual(d.frames, [ANSWER]);
  const reset = decoder(); reset.feed(RAW.slice(0, 8)); reset.reset(); reset.feed(RAW.slice(8));
  assert.equal(reset.frames.length, 0);
  const normal = decoder(); normal.feed(RAW.slice(0, 8)); normal.feed(encodeFrame(0x70, 0x31));
  assert.deepEqual(normal.frames, [{ address: 0x70, control: 0x31, data: b() }]); assert.equal(normal.recoveredBOF, 0);
  const huge = decoder(); huge.feed(concat(b(0xe0), new Uint8Array(4097)));
  assert.equal(huge.body, null); assert.equal(huge.bofCandidate, false);
});
