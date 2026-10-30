import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { b, concat, fromHex, toHex, jpegFromUPF, sha256, checkWatchJPEG } from '../dist/formats.mjs';
import { watchPhotoDetails, withWatchPhotoDetails, photoUpload } from '../dist/wqv3-photo-details.mjs';
import { jpegImageFingerprint } from '../dist/irtranp-metadata.mjs';

const palm = JSON.parse(await readFile(new URL('./fixtures/wqv3-photo-details-palm.json', import.meta.url)));
const hardware = JSON.parse(await readFile(new URL('./fixtures/wqv3-album-hardware.json', import.meta.url)));
const upf = fromHex(hardware.upfs[0]), jpeg = jpegFromUPF(upf);
const details = { caption: 'CASIO WQV', recordedAt: '2024-02-29T23:59' };
function app2(body) { return concat(b(255, 0xe2, (body.length + 2) >> 8, (body.length + 2) & 255), body); }
function markerBodies(bytes) {
  const result = [];
  for (let pos = 2; pos + 4 < bytes.length;) {
    const marker = bytes[pos + 1], size = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (marker === 0xda) break;
    if (marker === 0xe2 && size === 31) result.push(bytes.slice(pos + 4, pos + 2 + size));
    pos += 2 + size;
  }
  return result;
}

test('caption and recording date match the executed Casio Palm builder byte for byte', () => {
  assert.equal(palm.programSHA256, '670d7a00eecb5df732825d2452b59cf834f3bda827c87c694ab9210c48e43e50');
  for (const item of palm.cases) {
    const output = withWatchPhotoDetails(jpeg, item), markers = markerBodies(output);
    assert.equal(markers.length, 1);
    assert.equal(toHex(markers[0]), item.app2DataHex);
    assert.deepEqual(watchPhotoDetails(output), { caption: item.caption || null, recordedAt: item.recordedAt });
  }
});

test('changing metadata preserves compressed image content and every original input byte', async () => {
  const before = jpeg.slice(), output = withWatchPhotoDetails(jpeg, details);
  assert.notEqual(await sha256(output), await sha256(jpeg));
  assert.equal(await jpegImageFingerprint(output), await jpegImageFingerprint(jpeg));
  assert.deepEqual(jpeg, before); checkWatchJPEG(output);
  const input = { jpeg, upf, previewJPEG: null };
  assert.equal(photoUpload(input), upf, 'Unchecked details retain the original container');
  const edited = photoUpload(input, details);
  assert.deepEqual(watchPhotoDetails(jpegFromUPF(edited)), details);
  assert.deepEqual(input.upf, fromHex(hardware.upfs[0]));
});

test('a JPEG without a watch marker gets one; ICC profiles and scan bytes are retained', async () => {
  const source = new Uint8Array(await readFile(new URL('./fixtures/restart-row.jpg', import.meta.url)));
  const iccBody = new Uint8Array(29); iccBody.set(new TextEncoder().encode('ICC_PROFILE\0'));
  const icc = app2(iccBody), input = concat(source.slice(0, 2), icc, source.slice(2));
  assert.deepEqual(watchPhotoDetails(input), { caption: null, recordedAt: null });
  const output = withWatchPhotoDetails(input, details);
  assert.deepEqual(output.slice(35, 35 + icc.length), icc);
  assert.deepEqual(watchPhotoDetails(output), details);
  assert.equal(await jpegImageFingerprint(output), await jpegImageFingerprint(source));
});

test('duplicate old watch markers cannot override the new metadata', () => {
  const first = app2(fromHex(palm.cases[0].app2DataHex)), second = app2(fromHex(palm.cases[1].app2DataHex));
  const input = concat(jpeg.slice(0, 2), first, second, jpeg.slice(2));
  const edited = withWatchPhotoDetails(input, details);
  assert.equal(markerBodies(edited).length, 1);
  assert.deepEqual(watchPhotoDetails(edited), details);
});

test('invalid captions and impossible dates are rejected before forming an upload', () => {
  for (const caption of ['A'.repeat(25), 'Привет', 'a\nb', 'a\0b', 'a\u007fb']) {
    assert.throws(() => photoUpload({ jpeg, upf }, { ...details, caption }), /24 ASCII/);
  }
  for (const recordedAt of ['', '1999-12-31T12:00', '2040-01-01T00:00', '2025-02-29T12:00', '2024-02-29T24:00', '2024-02-29T23:60']) {
    assert.throws(() => photoUpload({ jpeg, upf }, { ...details, recordedAt }));
  }
  assert.throws(() => withWatchPhotoDetails(b(255, 0xd8, 255), details));
});

test('undefined watch dates stay blank; repaired previews are the transmitted image', async () => {
  const marker = app2(concat(new Uint8Array(24).fill(255), new Uint8Array(5).fill(255)));
  assert.deepEqual(watchPhotoDetails(concat(b(255, 0xd8), marker, b(255, 0xda))), { caption: null, recordedAt: null });
  const previewJPEG = withWatchPhotoDetails(jpeg, palm.cases[2]);
  assert.deepEqual(jpegFromUPF(photoUpload({ jpeg, upf, previewJPEG })), previewJPEG);
  const output = photoUpload({ jpeg, upf, previewJPEG }, details);
  assert.deepEqual(watchPhotoDetails(jpegFromUPF(output)), details);
  assert.equal(await jpegImageFingerprint(jpegFromUPF(output)), await jpegImageFingerprint(previewJPEG));
});
