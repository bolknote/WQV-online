import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bindApplicationNavigation } from '../dist/application-navigation.mjs';
import { LocalStore } from '../dist/images.mjs';
import { wqv2Image, wqv2Files } from '../dist/wqv2-images.mjs';
import { russian } from '../dist/translations.mjs';
import { japanese } from '../dist/translations-ja.mjs';

function record() {
  const bytes = new Uint8Array(7229).fill(0x20, 0, 24);
  bytes.set([26, 10, 29, 13, 37], 24);
  for (let i = 29; i < bytes.length; i++) bytes[i] = i & 255;
  return bytes;
}

test('WQV-2 backups preserve their original bytes and metadata with a distinct model and PNG preview', async () => {
  const original = record(), saved = original.slice(), image = await wqv2Image(original);
  assert.equal(image.model, 'WQV-2'); assert.equal(image.id, createHash('sha256').update(saved).digest('hex'));
  original.fill(0); assert.deepEqual(image.record, saved);
  const files = wqv2Files(image);
  assert.deepEqual(files.map(f => f.name.slice(-4)), ['.bin', '.png', 'json']);
  assert.deepEqual(files[0].data, saved);
  const header = new DataView(files[1].data.buffer, files[1].data.byteOffset);
  assert.equal(header.getUint32(16), 120); assert.equal(header.getUint32(20), 120);
  const metadata = JSON.parse(new TextDecoder().decode(files[2].data));
  assert.equal(metadata.dateHex, '1a0a1d0d25'); assert.equal(metadata.dateInterpretationConfirmed, false);
  assert.equal(metadata.sha256, image.id);
  await assert.rejects(wqv2Image(saved.slice(1)), /7229/);
});

test('the existing WQV-3 album keeps its database while WQV-2 uses its own', () => {
  assert.equal(new LocalStore().name, 'casio-wqv-webusb');
  assert.equal(new LocalStore({ name: 'casio-wqv2-webusb' }).name, 'casio-wqv2-webusb');
});

test('returning to Programs waits for USB release and refuses navigation during an operation', async () => {
  let busy = true, click, release;
  const events = [], attributes = {};
  const link = { href: 'http://example.test/', setAttribute(k, v) { attributes[k] = v; }, addEventListener(name, fn) { click = fn; } };
  const update = bindApplicationNavigation({ root: { querySelectorAll: () => [link] }, isBusy: () => busy,
    close: () => { events.push('close'); return new Promise(resolve => { release = resolve; }); },
    navigate: href => events.push(href) });
  const event = () => ({ button: 0, preventDefault() {} });
  await click(event()); assert.deepEqual(events, []); assert.equal(attributes['aria-disabled'], 'true');
  busy = false; update(); assert.equal(attributes['aria-disabled'], 'false');
  const pending = click(event()); await click(event());
  assert.deepEqual(events, ['close']); release(); await pending;
  assert.deepEqual(events, ['close', link.href]);
});

test('program and document pages have unique IDs, valid local assets and translated visible labels', () => {
  for (const file of ['index.html', 'wqv2.html', 'wqv3.html', 'manual.html']) {
    const source = readFileSync(new URL('../dist/' + file, import.meta.url), 'utf8');
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, file + ': duplicate element ID');
    for (const match of source.matchAll(/(?:href|src)="(\.\/[^"#]*)(?:#[^"]*)?"/g)) {
      assert.ok(existsSync(new URL('../dist/' + match[1], import.meta.url)), file + ': ' + match[1]);
    }
    for (const match of source.matchAll(/data-i18n(?:-title|-alt|-aria-label)?="([^"]+)"/g)) {
      const message = match[1].replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
      assert.ok(Object.hasOwn(russian, message), file + ': missing Russian label ' + message);
      assert.ok(Object.hasOwn(japanese, message), file + ': missing Japanese label ' + message);
    }
  }
});
