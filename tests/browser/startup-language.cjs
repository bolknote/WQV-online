const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const pages = [
  ['index.html', 'programs.mjs'],
  ['wqv2.html', 'wqv2.mjs'],
  ['wqv3.html', 'app.mjs'],
  ['wqv3.html?model=wqv10', 'app.mjs'],
  ['drivers.html', 'drivers.mjs'],
  ['manual.html?model=wqv3', 'manual.mjs'],
];

async function firstPaint(page) {
  await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
}

// Keep the application's entire import graph out of the first paint. A fast
// local connection otherwise conceals the English HTML shown before startup.
async function holdApplication(page, entry) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/' + entry, async route => { await gate; await route.continue(); });
  return release;
}

test('saved display languages are applied before first paint, independently of application loading', { timeout: 90000 }, async t => {
  const { languages, setLanguage, tr } = await import('../../dist/i18n.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const language of languages) {
    const context = await browser.newContext();
    await context.addInitScript(language => localStorage.setItem('wqv-online.language', language), language);
    setLanguage(language, { persist: false });
    for (const [file, entry] of pages) {
      const page = await context.newPage(), release = await holdApplication(page, entry);
      try {
        await page.goto(new URL(file, base).href, { waitUntil: 'commit' });
        await firstPaint(page);
        assert.equal(await page.locator('html').getAttribute('lang'), language, file);
        const translated = await page.locator('[data-i18n]').evaluateAll(elements => elements.map(element => ({
          key: element.dataset.i18n,
          text: [...element.childNodes].find(node => node.nodeType === 3 && node.nodeValue.trim())?.nodeValue.trim() ?? '',
        })));
        for (const { key, text } of translated) assert.equal(text, String(tr(key)), language + ' / ' + file + ' / ' + key);
        assert.equal(await page.locator('#start-menu-button').getAttribute('aria-label'), String(tr('Open the application menu')));
      } finally { release(); await page.close(); }
    }
    await context.close();
  }
});

test('slow translation downloads cannot expose the default language', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('wqv-online.language', 'ru'));
  const releaseApp = await holdApplication(page, 'programs.mjs');
  let releaseDictionary;
  const dictionaryGate = new Promise(resolve => { releaseDictionary = resolve; });
  const requested = page.waitForRequest('**/translations.mjs');
  await page.route('**/translations.mjs', async route => { await dictionaryGate; await route.continue(); });
  try {
    await page.goto(base, { waitUntil: 'commit' });
    await requested;
    await page.waitForFunction(() => document.querySelector('.programs-desktop'));
    // Give the renderer several turns while both downloads remain blocked.
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => performance.getEntriesByName('first-contentful-paint').length), 0);
    releaseDictionary();
    await firstPaint(page);
    assert.equal(await page.locator('#start-menu-button').textContent(), 'Пуск');
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
  } finally { releaseDictionary(); releaseApp(); await page.close(); }
});

test('missing, invalid or inaccessible language preferences keep the English default at first paint', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const saved of [null, 'unsupported', 'blocked']) {
    const page = await browser.newPage();
    await page.addInitScript(saved => {
      if (saved === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
      else if (saved !== null) localStorage.setItem('wqv-online.language', saved);
    }, saved);
    const release = await holdApplication(page, 'programs.mjs');
    try {
      await page.goto(base, { waitUntil: 'commit' }); await firstPaint(page);
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(await page.locator('#start-menu-button').textContent(), 'Start');
    } finally { release(); await page.close(); }
  }
  const context = await browser.newContext({ javaScriptEnabled: false }), page = await context.newPage();
  await page.goto(base);
  assert.equal(await page.locator('.programs-desktop').isVisible(), true);
  assert.equal(await page.locator('#start-menu-button').textContent(), 'Start');
  await context.close();
});
