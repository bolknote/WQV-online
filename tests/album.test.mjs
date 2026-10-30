import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { b, concat, fromHex as hx, jpegFromUPF, sha256, loadArchive, toHex } from '../dist/formats.mjs';
import { readableImage, newAlbumImage, imageFromFile, watchCaption, photoName, photoFilename } from '../dist/images.mjs';
import { collectionFiles } from '../dist/album.mjs';
import { othersImage } from '../dist/others-client.mjs';

const capture = JSON.parse(await readFile(new URL('./fixtures/wqv3-album-hardware.json', import.meta.url)));
const imageFile = record => new File([hx(capture.upfs[record.upfIndex])], record.filename);
const captureImages = () => Promise.all(capture.files.map(async record => newAlbumImage(await imageFromFile(imageFile(record)))));

test('the five captured watch files become five album entries, including both identical JPEG pairs', async () => {
  const images = await captureImages();
  assert.equal(images.length, 5); assert.equal(new Set(images.map(image => image.id)).size, 5);
  assert.equal(new Set(images.map(image => image.originalJPEGsha256)).size, 3);
  assert.deepEqual(images.map(image => image.originalJPEGsha256), capture.files.map(file => file.jpegSHA256));
  assert.deepEqual(images.map(photoFilename), capture.files.map(file => file.filename));
  assert.deepEqual(images.map(image => image.watchCaption), capture.files.map(file => file.caption));
  assert.equal(photoName(images[0]), '*  A   AAAB');
  assert.equal(photoName(images[1]), 'QW000001');
  assert.notEqual(images[1].id, images[1].originalJPEGsha256);
});

test('repeated imports and OTHERS transfers keep separate identities without changing the original UPF', async () => {
  const file = capture.files[0], bytes = hx(capture.upfs[file.upfIndex]), input = await imageFromFile(imageFile(file));
  const first = await newAlbumImage(input), second = await newAlbumImage(input);
  assert.notEqual(first.id, second.id); assert.equal(first.originalJPEGsha256, second.originalJPEGsha256);
  const fromOthers = await othersImage({ filename: file.filename, bytes });
  const others = await newAlbumImage(fromOthers);
  assert.notEqual(others.id, first.id); assert.deepEqual(others.upf, bytes);
  assert.equal(photoName(others), '*  A   AAAB');
});

test('reopening existing and legacy album records retains IDs while discovering watch captions', async () => {
  const image = await imageFromFile(imageFile(capture.files[0]));
  const legacy = await readableImage(image); assert.equal(legacy.id, image.id);
  assert.equal(legacy.watchCaption, '*  A   AAAB');
  const entry = await newAlbumImage(image), restored = await readableImage(entry);
  assert.equal(restored.id, entry.id); assert.equal(restored.originalJPEGsha256, capture.files[0].jpegSHA256);
});

test('caption parsing preserves meaningful spaces and ignores blank, unsupported and unrelated APP2 data', () => {
  const original = jpegFromUPF(hx(capture.upfs[0]));
  assert.equal(watchCaption(original), '*  A   AAAB');
  assert.equal(watchCaption(jpegFromUPF(hx(capture.upfs[1]))), null);
  const app2 = body => concat(b(255, 0xd8, 255, 0xe2, (body.length + 2) >> 8, (body.length + 2) & 255), body, b(255, 0xda));
  for (const fill of [0, 32, 255]) assert.equal(watchCaption(app2(concat(new Uint8Array(24).fill(fill), b(0, 1, 6, 18, 31)))), null);
  const unsupported = new Uint8Array(29).fill(32); unsupported[0] = 0x81;
  assert.equal(watchCaption(app2(unsupported)), null);
  assert.equal(watchCaption(app2(new TextEncoder().encode('ICC_PROFILE\0not a watch caption'))), null);
  for (const bad of [b(), b(255, 0xd8, 255, 0xe2, 0, 31, 65), b(255, 0xd8, 255, 0xe2, 0, 1)]) {
    assert.equal(watchCaption(bad), null);
  }
});

test('collection ZIP inputs retain all five entries, real checksums, captions and original WQV archives', async () => {
  const images = await captureImages(), files = await collectionFiles(images, '2026-10-30T14:39:25.701Z');
  assert.equal(files.length, 16); assert.equal(new Set(files.map(file => file.name)).size, 16);
  const manifest = JSON.parse(new TextDecoder().decode(files.find(file => file.name === 'collection.json').data));
  assert.equal(manifest.images.length, 5); assert.equal(manifest.images[0].caption, '*  A   AAAB');
  assert.equal(manifest.images[0].name, '*  A   AAAB');
  for (const [index, item] of manifest.images.entries()) {
    assert.equal(item.id, images[index].id); assert.equal(item.originalJPEGsha256, capture.files[index].jpegSHA256);
    assert.equal(item.sha256, await sha256(files.find(file => file.name === item.jpeg).data));
    const archive = JSON.parse(new TextDecoder().decode(files.find(file => file.name === item.archive).data));
    assert.deepEqual(await loadArchive(archive), hx(capture.upfs[capture.files[index].upfIndex]));
  }
});

test('preview repair never substitutes an album ID or preview checksum for the original JPEG checksum', async () => {
  const jpeg = new Uint8Array(await readFile(new URL('./fixtures/restart-row.jpg', import.meta.url)));
  const image = await newAlbumImage({ id: 'old-id', name: 'Restart', jpeg, upf: b(), archive: {} });
  const manifest = JSON.parse(new TextDecoder().decode((await collectionFiles([image])).at(-1).data)).images[0];
  assert.equal(manifest.originalJPEGsha256, await sha256(jpeg));
  assert.equal(manifest.sha256, await sha256(image.previewJPEG));
  assert.notEqual(manifest.originalJPEGsha256, manifest.sha256);
  assert.notEqual(manifest.originalJPEGsha256, image.id);
});

test('imported WQV archives show the watch caption and retain their original transfer filename', async () => {
  const fixture = capture.files[0], source = await imageFromFile(imageFile(fixture));
  source.archive.filename = 'QW000000.UPF';
  const image = await newAlbumImage(await imageFromFile(new File([JSON.stringify(source.archive)], 'transfer.wqv')));
  assert.equal(photoName(image), '*  A   AAAB'); assert.equal(photoFilename(image), 'QW000000.UPF');
  assert.equal(toHex(image.upf), capture.upfs[fixture.upfIndex]);
  const unnamed = await imageFromFile(imageFile(capture.files[1]));
  unnamed.archive.filename = capture.files[1].filename;
  const imported = await newAlbumImage(await imageFromFile(new File([JSON.stringify(unnamed.archive)], 'transfer.wqv')));
  assert.equal(photoName(imported), 'QW000001');
});
