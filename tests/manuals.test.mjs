import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../dist/manuals/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

test('manual catalog includes three original languages and both available German editions', () => {
  assert.deepEqual(catalog.map(item => item.id).sort(),
    ['wqv10-de', 'wqv10-en', 'wqv10-ja', 'wqv10-ru', 'wqv2-de', 'wqv2-en', 'wqv2-ja', 'wqv2-ru', 'wqv3-en', 'wqv3-ja', 'wqv3-ru']);
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

test('German scan corrections are reviewed and the missing WQV-2 sheet has explicit provenance', () => {
  const review = JSON.parse(readFileSync(new URL('../docs/manuals/german-proofreading.json', import.meta.url), 'utf8'));
  for (const [id, pages] of [['wqv2-de',11], ['wqv10-de',27]]) {
    const item = catalog.find(item => item.id === id), record = review[id];
    assert.equal(item.sourceSHA256, record.sourceSHA256);
    assert.equal(item.pages, pages);
    assert.equal(Object.keys(record.pages).length, pages);
    assert.ok(Object.values(record.pages).every(page => page.reviewed && page.notes.length));
    const source = readFileSync(new URL(item.file, root), 'utf8');
    assert.doesNotMatch(source, /Arbeitsfassung|noch nicht vollständig geprüft|Knopf\s*[©®@&]/);
    assert.match(source, /±15 Sekunden pro Monat/);
    assert.match(source, /2000 bis 2039/);
    assert.match(source, /115\.200 bps/);
  }
  const english = catalog.find(item => item.id === 'wqv2-en');
  const german = catalog.find(item => item.id === 'wqv2-de');
  assert.equal(german.supplement.sha256, english.sourceSHA256);
  assert.equal(german.supplement.page, 3);
  assert.deepEqual(german.missingOriginalPages, ['G-12','G-13','G-14','G-15']);
  const source = readFileSync(new URL(german.file, root), 'utf8');
  assert.match(source, /class="editorial-note">Aus dem englischen Original ergänzt · 2220-3/);
  for (const text of ['B (dunkler) und E (heller)', '15 Helligkeitsstufen', 'Stufe 8',
    'Innenbeleuchtung 50 Hz', 'Innenbeleuchtung 60 Hz', 'Mischmodus', 'Kunstmodus']) assert.ok(source.includes(text), text);
  assert.equal(existsSync(new URL('wqv3-de.html', root)), false);
  const color = readFileSync(new URL('wqv10-de.html', root), 'utf8');
  assert.match(color, /CNT1 bis CNT9/);
  assert.match(color, /Vorgabepegel beträgt ±0/);
  assert.match(color, /3\. Drücken Sie den Knopf \(F\), um das DELETE-Menü/);
  assert.match(color, /class="manual-table"/);
  assert.match(color, /Automatische Stromsparfunktion/);
  assert.match(color, /ENDANWENDER-LIZENZVEREINBARUNG/);
});

test('German illustration crops include source callouts at the edges', () => {
  const review = JSON.parse(readFileSync(new URL('../docs/manuals/german-proofreading.json', import.meta.url), 'utf8'));
  // Independently read label bounds in PDF points, including the trailing
  // alignment distance and the captions on the separate power-save insert.
  const labels = [
    ['wqv2-de',2,[406,808,416,816]],
    ['wqv2-de',5,[274,534,308,541]], // full Kalendertag label
    ['wqv2-de',3,[132,516,170,523]], // complete Objektiv caption
    ['wqv2-de',6,[343,338,396,344]], // Alarm-Ein-Indikator
    ['wqv2-de',7,[282,628,313,641]], // Maximal 30 Grad
    ['wqv2-de',8,[353,602,409,608]],
    ['wqv2-de',9,[385,369,427,374]],
    ['wqv2-de',4,[370,374,410,382]],
    ['wqv10-de',6,[327,476,368,505]], // leftmost watch and its time
    ['wqv10-de',8,[328,376,374,383]],
    ['wqv10-de',9,[348,293,400,300]],
    ['wqv10-de',10,[36,413,89,428]],
    ['wqv10-de',10,[381,278,415,295]],
    ['wqv10-de',11,[19,243,27,253]], // complete circled A callout
    ['wqv10-de',12,[25,353,33,363]],
    ['wqv10-de',13,[450,501,497,507]],
    ['wqv10-de',26,[282,626,327,632]],
    ['wqv10-de',26,[355,626,399,632]],
  ];
  for (const [id,page,[x0,y0,x1,y1]] of labels) {
    assert.ok(review[id].pages[page].figures.some(([left,top,right,bottom]) =>
      left <= x0 && top <= y0 && right >= x1 && bottom >= y1), id + ': clipped source callout on page ' + page);
  }
});

test('German text completes clipped words and preserves grammatical hyphens', () => {
  const mono = readFileSync(new URL('wqv2-de.html', root), 'utf8');
  const color = readFileSync(new URL('wqv10-de.html', root), 'utf8');
  for (const source of [mono,color]) {
    assert.match(source, /ein- oder/);
    assert.doesNotMatch(source, /einoder|Stundenund|Alarmund|Oberund|Bildaufnahmeund|BMP-oder/);
    assert.match(source, /class="reconstructed-label"/);
    assert.match(source, />Restliche Zeitdauer<\/text>/);
    assert.match(source, />des Rastintervalls<\/text>/);
    assert.match(source, /class="illustration-repair-note">Beschriftung ergänzt/);
  }
  assert.match(mono, /zwischen der Wochentagsanzeige und der Monatsanzeige umgeschaltet\./);
  assert.doesNotMatch(mono, /umgeschal-<\/p>|<p>tet\.<\/p>/);
  assert.match(color, /Sie können kein Bild aufnehmen, während/);
  assert.match(color, /Die Batterie kann nicht richtig eingesetzt werden, wenn sich die Dichtung nicht an der richtigen Stelle befindet\./);
  for (const label of ['Beleuch-', 'tungstyp', 'Speicherkapazität', 'Abgelaufene Zeit', 'Zwischenzeit', 'Zwei Endzeiten']) {
    assert.ok(color.includes('>' + label + '</text>'), label);
  }
  assert.match(color, /<figcaption>Der Ein\/Aus-Status jedes Alarms wird hier angezeigt\.<\/figcaption>/);
});

test('German guides keep complete procedure paragraphs and readable tables', () => {
  for (const [id,page] of [['wqv2',10],['wqv10',23]]) {
    const source = readFileSync(new URL(id + '-de.html', root), 'utf8');
    const specs = source.match(new RegExp('<section class="source-page" id="page-' + page + '"[\\s\\S]*?</section>'))[0];
    for (const field of ['Ganggenauigkeit bei Normaltemperatur:', 'Infrarot-Kommunikation:', 'Batterie:', 'Ungefähre Batterielebensdauer:']) {
      assert.ok(specs.includes('<p>' + field), id + ': specification lost its paragraph: ' + field);
    }
    assert.equal((source.match(/<table\b/g) || []).length, (source.match(/class="manual-table-wrap(?: wide-table)?"/g) || []).length);
    assert.match(source, /<td>WATER RESISTANT<\/td>/);
    assert.match(source, /<td>MEMORY FULL<\/td>|<td>PLAY 100 FULL<\/td>/);
    assert.doesNotMatch(source, /<p>Januar 2000 begonnen\.<\/p>|<p>können eine spezielle|<p>Pixel:|<p>Bedingungen:<\/p>/);
  }
  const color = readFileSync(new URL('wqv10-de.html', root), 'utf8');
  assert.match(color, /1\. Januar 2000 begonnen\./);
  assert.match(color, /bevor Sie die Bilder in Schritt 6 tatsächlich löschen/);
  assert.match(color, /<td>REC ERROR<\/td>/);
  const mono = readFileSync(new URL('wqv2-de.html', root), 'utf8');
  for (const label of ['Dunkler','Heller','Erstes','Zweites']) assert.ok(mono.includes('>' + label + '</text>'));
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
  const wqv10 = readFileSync(new URL('wqv10-ja.html', root), 'utf8');
  assert.match(wqv10, /通信モードを除く/);
  for (const button of ['A','B','C','D','E','F']) assert.ok(wqv10.includes(button + 'ボタン') || wqv10.includes(button + ' ボタン'), 'WQV-10: missing button ' + button);
  assert.doesNotMatch(wqv10, /MASSON LEON|At 582 Am/);
});

test('Japanese guide text has readable contents, button names and model-specific instructions', () => {
  for (const model of ['wqv2','wqv3','wqv10']) {
    const source = readFileSync(new URL(model + '-ja.html', root), 'utf8');
    assert.doesNotMatch(source, /[©®④⑤⑥⑧@€]\s*ボタン|通言|通佶|通偪|時効セット|山謦告/);
    assert.match(source, /極性（＋と－の向き）/);
    assert.match(source, /精度：平均月差±15秒以内/);
    assert.match(source, /共通機能<\//);
    assert.doesNotMatch(source, /共通信機能/);
    const contents = source.match(/<section class="source-page" id="page-6"[\s\S]*?<\/section>/)[0];
    assert.match(contents, /時計同士のデータ通信 — \d+/);
    assert.match(contents, /電池交換のしかた — \d+/);
    assert.doesNotMatch(contents, /2112222117|21470猪|・。。a/);
    const entry = catalog.find(item => item.id === model + '-ja');
    for (const heading of entry.headings) {
      assert.ok(source.includes('id="' + heading.id + '"'), model + ': stale contents anchor');
      const escaped = heading.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
      assert.ok(source.includes('>' + escaped + '</h'), model + ': stale contents text');
    }
  }
  const mono = readFileSync(new URL('wqv2-ja.html', root), 'utf8');
  assert.match(mono, /Bボタンを押して「SEND」（送信）、またはEボタンを押して「RECEIVE」（受信）を選び、Fボタンを押します/);
  assert.match(mono, /1\/100秒単位/);
  const wqv3 = readFileSync(new URL('wqv3-ja.html', root), 'utf8');
  assert.match(wqv3, /含む16画像のサムネール画面になります/);
  assert.match(wqv3, /Fボタンを押します。→選択画像が大きく表示されます/);
  const color = readFileSync(new URL('wqv10-ja.html', root), 'utf8');
  assert.match(color, /含む4画像のサムネール画面になります/);
  assert.match(color, /Cボタンを押します。→ 選択画像が大きく表示されます/);
});
