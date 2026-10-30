// Exercises the reader only. PDF navigation is intercepted; no USB or external download.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const catalog = JSON.parse(fs.readFileSync(new URL('../../dist/manuals/manifest.json', 'file://' + __filename), 'utf8'));

async function earlyPDF(browser, manual) {
  const context = await browser.newContext();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  try {
    await context.addInitScript(language => localStorage.setItem('wqv-online.language', language), manual.language);
    await context.route('**/manuals/' + manual.file, async route => {
      const response = await route.fetch();
      await blocked;
      await route.fulfill({ response }).catch(() => {});
    });
    await context.route(manual.sourceURL, route => route.fulfill({ contentType: 'text/plain', body: 'Original PDF test' }));
    const page = await context.newPage();
    await page.goto(base + 'manual.html?model=' + manual.id.split('-')[0], { waitUntil: 'domcontentloaded' });
    await page.locator('.menubar details.menu summary').first().click();
    assert.equal(await page.locator('#document-loading').isVisible(), true);
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 3000 }),
      page.locator('#original-pdf').click({ timeout: 3000 }),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), manual.sourceURL, 'opening the PDF during loading must not reopen the reader');
    await popup.close();
    await page.bringToFront();
    release();
    await page.waitForFunction(() => document.querySelector('#document-loading').hidden);
  } finally {
    release();
    await context.close();
  }
}

async function followsScroll(browser, manual) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  try {
    await context.addInitScript(language => localStorage.setItem('wqv-online.language', language), manual.language);
    const page = await context.newPage();
    await page.goto(base + 'manual.html?model=' + manual.id.split('-')[0], { waitUntil: 'networkidle' });
    await page.bringToFront();
    const selected = async (id, step) => {
      try {
        await page.waitForFunction(id => document.querySelector('#document-contents').value === id, id, { timeout: 5000 });
      } catch {
        const actual = await page.evaluate(() => ({
          selected: document.querySelector('#document-contents').value,
          headings: [...document.querySelector('#document-frame').contentDocument.querySelectorAll('h2[id],h3[id]')]
            .map(node => ({ id: node.id, top: node.getBoundingClientRect().top })).filter(node => node.top > -100 && node.top < 100),
        }));
        throw new Error(step + ': expected ' + id + '; ' + JSON.stringify(actual));
      }
    };
    const frame = page.frames().find(frame => frame.url().includes('/manuals/'));
    assert.ok(frame);
    const ids = await frame.locator('h2[id],h3[id]').evaluateAll(nodes => nodes.map(node => node.id));
    assert.ok(ids.length > 2);
    const middle = ids[Math.floor(ids.length / 2)];
    await frame.locator('#' + middle).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await selected(middle, 'scroll to a section');
    await frame.evaluate(() => window.scrollTo(0, 0));
    await selected('', 'return to the start');
    await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await selected(ids.at(-1), 'reach the end');
    await page.locator('#document-contents').selectOption(middle);
    assert.ok(await frame.locator('#' + middle).evaluate(node => Math.abs(node.getBoundingClientRect().top) < 2));
    await page.locator('#document-size').selectOption('larger');
    await page.setViewportSize({ width: 390, height: 844 });
    await frame.locator('#' + middle).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await selected(middle, 'scroll after text and viewport resize');
    // Reloading the language must bind the menu to the replacement document.
    await page.locator('.menubar details.menu summary').nth(1).click();
    await page.locator('#menu-options').click();
    const nextLanguage = manual.language === 'en' ? 'ru' : 'en';
    await page.locator('input[value="' + nextLanguage + '"]').check();
    await page.locator('#options-accept').click();
    await page.waitForFunction(language => document.querySelector('#document-frame').contentDocument?.documentElement?.lang === language &&
      document.querySelector('#document-loading').hidden, nextLanguage);
    const replacement = page.frames().find(frame => frame.url().includes('/manuals/'));
    const newIDs = await replacement.locator('h2[id],h3[id]').evaluateAll(nodes => nodes.map(node => node.id));
    const next = newIDs[Math.floor(newIDs.length / 2)];
    await replacement.locator('#' + next).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await selected(next, 'scroll after changing language');
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failures = [], passed = [];
  try {
    for (const manual of catalog) {
      for (const [name, check] of [['PDF while loading', earlyPDF], ['contents follow scrolling', followsScroll]]) {
        const label = manual.id + ': ' + name;
        try { await check(browser, manual); passed.push(label); }
        catch (error) { failures.push({ test: label, error: error.message }); }
      }
    }
    console.log(JSON.stringify({ passed, failures, hardwareUSBUsed: false }, null, 2));
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
