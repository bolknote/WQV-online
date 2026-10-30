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

test('Japanese watch diagrams retain their button letters and time-display callouts', () => {
  // Bounds of lettering checked on the full 2400 × 1692 source-page renders.
  // These are label bounds, not copies of the generator's crop rectangles.
  const labels = {
    'wqv2-ja': [
      [185,419,321,457], [544,412,677,447], [412,607,548,645],
      [150,1273,275,1333], [342,1148,460,1176], [306,1444,450,1480],
      [774,1148,844,1179], [1929,408,2058,551], [1803,607,1939,642],
      [1929,1064,2062,1207], [1807,1263,1936,1294],
    ],
    'wqv3-ja': [
      [195,495,314,530], [628,498,747,530], [401,752,538,791],
      [855,506,1060,733], [324,1277,450,1334], [565,1172,691,1197],
      [774,1277,847,1350], [576,1483,687,1511],
    ],
  };
  for (const [id, regions] of Object.entries(labels)) {
    const source = readFileSync(new URL(id + '.html', root), 'utf8');
    const page = source.match(/<section class="source-page" id="page-7"[\s\S]*?<\/section>/)?.[0];
    assert.ok(page, id + ': operation overview missing');
    const crops = [...page.matchAll(/viewBox="([\d. -]+)"[^>]*><image[^>]*transform="matrix\(([\d. -]+)\)"/g)]
      .map(([, viewport, matrix]) => {
        const [x,y,width,height] = viewport.split(' ').map(Number);
        const [a,,,d,e,f] = matrix.split(' ').map(Number);
        return [(x-e)*2400/a, (y-f)*1692/d, (x+width-e)*2400/a, (y+height-f)*1692/d];
      });
    for (const [x0,y0,x1,y1] of regions) {
      assert.ok(crops.some(([left,top,right,bottom]) =>
        left <= x0 && top <= y0 && right >= x1 && bottom >= y1),
      id + ': clipped annotation ' + [x0,y0,x1,y1]);
    }
    assert.doesNotMatch(page, /<p>(?:午後マーク|Bボタン|秒)<\/p>/,
      id + ': diagram annotations should stay attached to their original drawings');
    assert.match(page, /使うモードへの切り替え方は10ページをご覧ください。/,
      id + ': surrounding body text must remain selectable HTML');
  }
});
