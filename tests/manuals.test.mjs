import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../dist/manuals/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

test('both watches have complete English, Russian and Japanese manual documents', () => {
  assert.deepEqual(catalog.map(item => item.id).sort(),
    ['wqv2-en', 'wqv2-ja', 'wqv2-ru', 'wqv3-en', 'wqv3-ja', 'wqv3-ru']);
  for (const item of catalog) {
    const source = readFileSync(new URL(item.file, root), 'utf8');
    assert.match(source, new RegExp('<html lang="' + item.language + '"'));
    assert.equal([...source.matchAll(/class="source-page"/g)].length, item.pages, item.id);
    assert.equal([...source.matchAll(/<figure\b/g)].length, item.illustrations, item.id);
    assert.ok(item.illustrations > 0, item.id + ': original illustrations missing');
    assert.match(item.sourceSHA256, /^[a-f\d]{64}$/);
    assert.equal(new URL(item.sourceURL).protocol, 'https:');
    assert.ok(source.replace(/<[^>]*>/g, '').length > 10000, item.id + ': body text missing');
    assert.doesNotMatch(source, /<object|<embed|<script|onload=/i);
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, item.id + ': duplicate section ID');
    for (const match of source.matchAll(/<(?:use|image) href="([^"#]+)(?:#page)?"/g)) {
      const asset = new URL(match[1], root);
      assert.ok(existsSync(asset), item.id + ': missing illustration ' + match[1]);
      if (asset.pathname.endsWith('.png')) {
        assert.deepEqual([...readFileSync(asset).subarray(0,8)],[137,80,78,71,13,10,26,10]);
      } else {
        const svg = readFileSync(asset, 'utf8');
        assert.match(svg, /<svg id="page"/);
        assert.doesNotMatch(svg, /<script|<foreignObject|javascript:/i);
      }
    }
  }
});
