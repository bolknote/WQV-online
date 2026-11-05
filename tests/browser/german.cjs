// Language and reader checks only; no USB access or infrared traffic.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const output = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-german-browser');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1050 } });
  const page = await context.newPage(), errors = [], requests = [], checked = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(response.url() + ': ' + response.status()); });
  page.on('request', request => requests.push(request.url()));
  async function language(value) {
    await page.locator('#start-menu-button').click();
    await page.locator('#start-options').click(); await page.locator('#settings-language').click();
    await page.locator('input[name="display-language"][value="' + value + '"]').check();
    await page.locator('#options-accept').click();
    await page.waitForFunction(value => document.documentElement.lang === value, value);
  }
  async function loaded(language) {
    await page.waitForFunction(language => document.querySelector('#document-frame').contentDocument?.querySelector('article[data-pages]') &&
      document.querySelector('#document-frame').contentDocument.documentElement.lang === language &&
      document.querySelector('#document-loading').hidden && !document.querySelector('#document-contents').disabled, language);
    return page.frames().find(frame => frame.url().includes('/manuals/'));
  }
  async function fits() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await language('de');
    assert.equal(await page.evaluate(() => localStorage.getItem('wqv-online.language')), 'de');
    assert.equal(await page.locator('[data-i18n="Tools"]').textContent(), 'Extras');
    assert.equal(await page.locator('[data-i18n="Programs"]').first().textContent(), 'Programme');
    for (const model of ['wqv2', 'wqv3', 'wqv10']) {
      const icon = page.locator('.document-icon[href="./manual.html?model=' + model + '"]');
      assert.equal(await icon.locator('[data-i18n="User’s Guide"]').textContent(), model === 'wqv3' ? 'User’s Guide' : 'Bedienungsanleitung');
      if (model === 'wqv3') assert.equal(await icon.getAttribute('aria-label'), 'WQV-3 User’s Guide');
    }
    await page.screenshot({ path: path.join(output, 'programs-de.png'), fullPage: true });
    for (const model of ['wqv2', 'wqv3', 'wqv10']) {
      await page.locator('.document-icon[href="./manual.html?model=' + model + '"]').click();
      const edition = model === 'wqv3' ? 'en' : 'de', frame = await loaded(edition);
      assert.ok(frame.url().endsWith(model + '-' + edition + '.html'));
      assert.match(await page.locator('#original-pdf').getAttribute('href'), new RegExp('_' + edition.toUpperCase() + '\\.pdf$'));
      assert.equal(await page.locator('#document-title').textContent(), (model === 'wqv2' ? 'WQV-1/2' : model.toUpperCase().replace('WQV','WQV-')) + ' — ' + (model === 'wqv3' ? 'User’s Guide' : 'Bedienungsanleitung'));
      assert.match(await page.locator('#document-status').textContent(), /Seiten$/);
      assert.equal(await page.locator('#document-contents option').first().textContent(), 'Inhalt');
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const headings = await page.locator('#document-contents option').count();
      assert.ok(headings > 10);
      const heading = await page.locator('#document-contents option').nth(3).getAttribute('value');
      await page.locator('#document-contents').selectOption(heading);
      assert.ok(await frame.locator('#' + heading).evaluate(node => node.getBoundingClientRect().top < 10));
      if (model === 'wqv3') {
        const documentURL = frame.url();
        await frame.evaluate(() => { window.readerLanguageSentinel = true; });
        await language('en');
        assert.equal(await page.locator('#document-contents option').first().textContent(), 'Contents');
        await language('de');
        assert.equal(await page.locator('#document-contents option').first().textContent(), 'Inhalt');
        assert.equal(frame.url(), documentURL);
        assert.equal(await frame.evaluate(() => window.readerLanguageSentinel), true, 'English guide must not reload on en/de switches');
      } else {
        // Render the documents directly: screenshots of an oversized element
        // inside a scrolling iframe only capture the currently visible slice.
        const proof = await context.newPage();
        await proof.setViewportSize({ width: 820, height: 1000 });
        proof.on('pageerror', error => errors.push(error.message));
        proof.on('response', response => { if (response.status() >= 400) errors.push(response.url() + ': ' + response.status()); });
        await proof.goto(frame.url(), { waitUntil: 'networkidle' });
        const clippedLabels = await proof.locator('.reconstructed-label').evaluateAll(labels => labels.flatMap(label => {
          const area = label.querySelector('rect').getBBox();
          return [...label.querySelectorAll('text')].filter(text => {
            const box = text.getBBox(), slack = 2;
            return box.x < area.x - slack || box.y < area.y - slack ||
              box.x + box.width > area.x + area.width + slack || box.y + box.height > area.y + area.height + slack;
          }).map(text => {
            const box = text.getBBox();
            return { text: text.textContent, bounds: [box.x,box.y,box.width,box.height], area: [area.x,area.y,area.width,area.height] };
          });
        }));
        assert.deepEqual(clippedLabels, [], model + ': restored German labels must fit their recorded area: ' + JSON.stringify(clippedLabels));
        assert.ok(await proof.locator('.reconstructed-label').count() > 0);
        assert.deepEqual(await proof.locator('.illustration-repair-note').first().evaluate(n => {
          const s = getComputedStyle(n); return [s.fontSize,s.color,s.writingMode];
        }), ['9.6px','rgb(119, 119, 119)','vertical-rl']);
        let restoredIndex = 0;
        for (const figure of await proof.locator('.restored-figure').all()) {
          await figure.screenshot({ path: path.join(output, model + '-restored-labels-' + (++restoredIndex) + '.png') });
        }
        const overlappingFigures = await proof.locator('.booklet-panel').evaluateAll(panels => panels.flatMap(panel => {
          const figures = [...panel.querySelectorAll('.illustration')];
          return figures.flatMap((figure,index) => figures.slice(index+1).filter(other => {
            const a = figure.getBoundingClientRect(), b = other.getBoundingClientRect();
            return Math.min(a.right,b.right)-Math.max(a.left,b.left) > 2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) > 2;
          }).map(other => [figure.dataset.figure,other.dataset.figure]));
        }));
        assert.deepEqual(overlappingFigures, [], 'Wide diagrams must clear earlier floating illustrations');
        const listOverlap = await proof.locator('.editorial-supplement').evaluateAll(sections => sections.some(section => {
          const figures = [...section.querySelectorAll('.illustration')];
          return [...section.querySelectorAll('ol,ul')].some(list => figures.some(figure => {
            const a = list.getBoundingClientRect(), b = figure.getBoundingClientRect();
            return Math.min(a.right,b.right)-Math.max(a.left,b.left) > 2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) > 2;
          }));
        }));
        assert.equal(listOverlap, false, 'List numbers and bullets must not paint over the supplemental diagrams');
        for (const section of await proof.locator('.source-page').all()) {
          const number = await section.getAttribute('data-page');
          assert.ok((await section.innerText()).length > 80, model + ': empty page ' + number);
          await section.screenshot({ path: path.join(output, model + '-de-page-' + number.padStart(2,'0') + '.png') });
        }
        await fs.mkdir(path.join(output, 'figures'), { recursive: true });
        let figureIndex = 0;
        for (const figure of await proof.locator('.illustration').all()) {
          const key = await figure.getAttribute('data-figure') || 'supplement-' + (++figureIndex);
          await figure.screenshot({ path: path.join(output, 'figures', model + '-' + key + '.png') });
          const ratio = await figure.locator('svg').evaluate(svg => {
            const box = svg.getBoundingClientRect(), viewport = svg.viewBox.baseVal;
            return (box.width / box.height) / (viewport.width / viewport.height);
          });
          assert.ok(Math.abs(ratio - 1) < .015, model + ': distorted illustration ' + key);
        }
        if (model === 'wqv2') await proof.locator('#supplement-g12-g15').screenshot({ path: path.join(output, 'wqv2-de-supplement.png') });
        await proof.setViewportSize({ width: 320, height: 844 });
        assert.equal(await proof.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await proof.locator('.illustration').evaluateAll(figures => figures.every(figure => getComputedStyle(figure).float === 'none')), true,
          'Small-screen figures must not squeeze the surrounding German text');
        const wideDiagrams = await proof.locator('.diagram-viewport').evaluateAll(items => items.filter(item => item.scrollWidth > item.clientWidth + 8).map(item => {
          const svg = item.querySelector('svg');
          return { scrollable: getComputedStyle(item).overflowX === 'auto', scale: svg.getBoundingClientRect().width / Number(svg.getAttribute('width')) };
        }));
        assert.ok(wideDiagrams.length > 0);
        assert.ok(wideDiagrams.every(item => item.scrollable && Math.abs(item.scale - 1) < .015),
          'Wide diagrams must scroll at their readable size rather than shrink');
        assert.equal(await proof.locator('.manual-table-wrap').evaluateAll(items => items.every(item => getComputedStyle(item).overflowX === 'auto')), true);
        for (const number of (model === 'wqv2' ? [3,4,8,10] : [7,10,18,22,24])) {
          await proof.locator('#page-' + number).screenshot({ path: path.join(output, model + '-mobile-page-' + number + '.png') });
        }
        await proof.close();
      }
      if (model === 'wqv2') {
        const note = frame.locator('.editorial-note');
        assert.equal(await note.textContent(), 'Aus dem englischen Original ergänzt · 2220-3');
        assert.deepEqual(await note.evaluate(n => { const s=getComputedStyle(n);return [s.fontSize,s.color,s.writingMode]; }), ['10.4px','rgb(119, 119, 119)','vertical-rl']);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await fits();
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      if (model === 'wqv2') await frame.locator('#supplement-g12-g15').evaluate(n => n.scrollIntoView());
      await page.screenshot({ path: path.join(output, model + '-de-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1366, height: 1050 });
      await page.locator('.window-close').click();
      await page.waitForURL(base); checked.push(model);
    }
    for (const [file, label] of [['wqv2.html','Bedienungsanleitung'],['wqv3.html','User’s Guide'],['wqv3.html?model=wqv10','Bedienungsanleitung']]) {
      await page.goto(new URL(file, base).href, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('lang'), 'de');
      if (file === 'wqv2.html') {
        assert.equal(await page.locator('#module-label').textContent(), 'WQV-1/2 / Modul 2220');
        await language('en');
        assert.equal(await page.locator('#module-label').textContent(), 'WQV-1/2 / module 2220');
        await language('de');
        assert.equal(await page.locator('#module-label').textContent(), 'WQV-1/2 / Modul 2220');
      }
      await page.locator('#start-menu-button').click();
      if (file !== 'wqv2.html') assert.equal(await page.locator('#watch-guide').textContent(), label);
      await page.locator('#start-menu-button').click();
      await page.screenshot({ path: path.join(output, file.includes('wqv10') ? 'wqv10-app-de.png' : file.replace('.html','-app-de.png')), fullPage: true });
      const model = file.includes('wqv10') ? 'wqv10' : file.replace('.html','');
      if (file !== 'wqv2.html') {
        await page.locator('.photo-details').evaluate(element => { element.open = true; });
        await page.locator('.prepare-options').evaluate(element => { element.open = true; });
        await page.setViewportSize({ width: 390, height: 844 }); await fits();
        await page.screenshot({ path: path.join(output, model + '-photo-options-de.png'), fullPage: true });
        await page.setViewportSize({ width: 1366, height: 1050 });
        await page.locator('#tab-holidays').click();
        const backup = await page.evaluate(async colour => {
          const { HolidayCalendar, ColourCalendar } = await import('./calendar.mjs');
          return (colour ? new ColourCalendar() : new HolidayCalendar()).backup();
        }, file.includes('wqv10'));
        await page.locator('#holiday-file').setInputFiles({ name: 'calendar.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        const writeLabel = await page.locator('#send-holidays').textContent();
        await page.waitForFunction(text => document.querySelector('#result-detail').textContent.includes('„' + text + '“'), writeLabel);
      }
      const tabs = file === 'wqv2.html' ? ['clock','connection','photos'] : ['holidays','clock','connection','photos'];
      for (const tab of tabs) {
        await page.locator('#tab-' + tab).click();
        for (const width of [1366,390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1050 }); await fits();
          const clippedControls = await page.locator('button,select').evaluateAll(elements => elements.filter(element =>
            element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => element.id || element.textContent));
          assert.deepEqual(clippedControls, [], model + ': German controls must fit at ' + width);
        }
        await page.screenshot({ path: path.join(output, model + '-' + tab + '-de-mobile.png'), fullPage: true });
      }
      await page.locator('#help-top').click();
      await page.screenshot({ path: path.join(output, model + '-help-de-mobile.png'), fullPage: true });
      await page.locator('#dialog-accept').click();
      await page.setViewportSize({ width: 1366, height: 1050 });
    }
    await page.goto(base, { waitUntil: 'networkidle' }); await page.setViewportSize({ width: 390, height: 844 });
    await fits(); await page.screenshot({ path: path.join(output, 'programs-de-mobile.png'), fullPage: true });
    assert.equal(requests.some(url => url.endsWith('wqv3-de.html')), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', checked, errors, hardwareUSBUsed: false }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
