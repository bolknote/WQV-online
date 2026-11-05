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

async function fixDate(page, instant) {
  // Leave the renderer's native timers and paint measurements untouched.
  await page.addInitScript(instant => {
    const SystemDate = Date;
    let now = SystemDate.parse(instant);
    window.Date = class extends SystemDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    window.__setTestTime = instant => { now = SystemDate.parse(instant); };
  }, instant);
}

// Keep the application's entire import graph out of the first paint. A fast
// local connection otherwise conceals the English HTML shown before startup.
async function holdApplication(page, entry) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/' + entry, async route => { await gate; await route.continue(); });
  return release;
}

test('saved display languages and local time are applied before first paint, independently of application loading', { timeout: 90000 }, async t => {
  const { languages, setLanguage, tr, locale } = await import('../../dist/i18n.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const instant = '2026-11-05T08:09:30Z', timeZone = 'Europe/Moscow';
  for (const language of languages) {
    const context = await browser.newContext({ timezoneId: timeZone });
    await context.addInitScript(language => localStorage.setItem('wqv-online.language', language), language);
    setLanguage(language, { persist: false });
    for (const [file, entry] of pages) {
      const page = await context.newPage(), release = await holdApplication(page, entry);
      try {
        await fixDate(page, instant);
        await page.goto(new URL(file, base).href, { waitUntil: 'commit' });
        await firstPaint(page);
        assert.equal(await page.locator('html').getAttribute('lang'), language, file);
        assert.equal(await page.locator('#pc-clock').textContent(), new Date(instant).toLocaleTimeString(locale(), {
          hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
        }), language + ' / ' + file + ' / local time');
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

test('the title clock keeps ticking while the application loads and follows later locale changes', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' }), page = await context.newPage();
  await fixDate(page, '2026-11-05T08:09:30Z');
  const release = await holdApplication(page, 'app.mjs');
  try {
    await page.goto(new URL('wqv3.html', base).href, { waitUntil: 'commit' }); await firstPaint(page);
    assert.equal(await page.locator('#pc-clock').textContent(), '17:09');
    await page.evaluate(() => window.__setTestTime('2026-11-05T08:10:30Z'));
    await page.waitForFunction(() => document.getElementById('pc-clock').textContent === '17:10');
    release(); await page.waitForLoadState('load');
    assert.equal(await page.locator('#pc-clock').textContent(), '17:10');
    await page.evaluate(() => window.__setTestTime('2026-11-05T08:11:30Z'));
    await page.waitForFunction(() => document.getElementById('pc-clock').textContent === '17:11');
    await page.evaluate(async () => (await import('./i18n.mjs')).setLanguage('fi'));
    assert.equal(await page.locator('#pc-clock').textContent(), '17.11');
  } finally { release(); await context.close(); }
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
