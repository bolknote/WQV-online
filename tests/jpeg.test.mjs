import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeWatchJPEG } from '../dist/jpeg.mjs';
const original = new Uint8Array(await readFile(new URL('./fixtures/restart-row.jpg', import.meta.url)));
function stripDRI(jpeg) {
  const result = [];
  for (let p = 0; p < jpeg.length; p++) {
    if (jpeg[p] === 255 && jpeg[p + 1] === 0xdd) { p += 5; continue; }
    result.push(jpeg[p]);
  }
  return Uint8Array.from(result);
}
test('restart JPEGs are transcoded without requantizing and validated through all 99 MCUs', () => {
  const result = normalizeWatchJPEG(original);
  assert.equal(result.mcus, 99); assert.equal(result.restartInterval, 11);
  assert.equal(result.repaired, false); assert.equal(result.changed, true);
  assert.deepEqual(normalizeWatchJPEG(result.jpeg).jpeg, result.jpeg);
  for (let i = 0; i < result.jpeg.length - 1; i++) {
    if (result.jpeg[i] === 255) assert.ok(![0xdd, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(result.jpeg[i + 1]));
  }
});
test('the exact WQV-3 failure (DRI dropped, RST retained) recovers the same complete image', () => {
  const result = normalizeWatchJPEG(stripDRI(original));
  assert.equal(result.repaired, true); assert.equal(result.restartInterval, 11);
  assert.deepEqual(result.jpeg, normalizeWatchJPEG(original).jpeg);
});
test('inconsistent restart intervals and out-of-order markers are rejected', () => {
  const badInterval = original.slice();
  for (let p = 0; p < badInterval.length - 6; p++) if (badInterval[p] === 255 && badInterval[p + 1] === 0xdd) { badInterval[p + 5] = 10; break; }
  assert.throws(() => normalizeWatchJPEG(badInterval), /интервал/);
  const badSequence = original.slice();
  for (let p = 0; p < badSequence.length - 1; p++) if (badSequence[p] === 255 && badSequence[p + 1] === 0xd0) { badSequence[p + 1] = 0xd2; break; }
  assert.throws(() => normalizeWatchJPEG(badSequence), /порядок/);
});
test('a complete JPEG header and EOI cannot hide truncated image data', () => {
  const valid = normalizeWatchJPEG(original).jpeg;
  const truncated = new Uint8Array(valid.length - 100);
  truncated.set(valid.slice(0, -102)); truncated.set([255, 0xd9], truncated.length - 2);
  assert.throws(() => normalizeWatchJPEG(truncated), /обрезано|оборваны|Хаффмана/);
});
