// Reads only local HTML and SVG files; never opens a USB adapter.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const output = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-manuals-browser');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true }), errors = [], checked = [];
  try {
    for (const language of ['en', 'ru', 'ja']) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 1050 } });
      await context.addInitScript(language => localStorage.setItem('wqv-online.language', language), language);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400) errors.push(response.url() + ': ' + response.status()); });
      await page.goto(base, { waitUntil: 'networkidle' });
      assert.deepEqual(await page.locator('.programs-grid>a').evaluateAll(items => items.map(item => item.getAttribute('href'))),
        ['./wqv2.html', './wqv3.html', './manual.html?model=wqv2', './manual.html?model=wqv3']);
      const desktop = await page.locator('.programs-grid>a').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
      assert.ok(desktop.every(top => Math.abs(top - desktop[0]) < 1));
      for (const model of ['wqv2', 'wqv3']) {
        await page.locator('.document-icon[href="./manual.html?model=' + model + '"]').click();
        await page.waitForLoadState('networkidle');
        await page.waitForFunction(language => document.querySelector('#document-frame').contentDocument?.querySelector('article[data-pages]') &&
          document.querySelector('#document-frame').contentDocument.documentElement.lang === language, language);
        const frame = page.frames().find(frame => frame.url().includes('/manuals/'));
        assert.ok(frame);
        assert.ok((await frame.locator('article').textContent()).length > 10000);
        assert.ok(await frame.locator('.illustration svg use,.illustration svg image').count() > 0);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.locator('#document-size').selectOption('large');
        assert.equal(await frame.locator('html').evaluate(root => getComputedStyle(root).fontSize), '18px');
        const heading = await page.locator('#document-contents option').nth(1).getAttribute('value');
        await page.locator('#document-contents').selectOption(heading);
        assert.ok(await frame.locator('#' + heading).evaluate(node => node.getBoundingClientRect().top < 10));
        assert.match(await page.locator('#original-pdf').getAttribute('href'), new RegExp(model === 'wqv2' ? '2220' : '2411'));
        await frame.locator('#page-' + (language === 'ja' ? 16 : 6)).evaluate(node => node.scrollIntoView());
        await page.screenshot({ path: path.join(output, model + '-' + language + '.png'), fullPage: true });
        if (language === 'ja') {
          await frame.locator('#page-7').evaluate(node => node.scrollIntoView());
          await page.screenshot({ path: path.join(output, model + '-ja-annotations.png'), fullPage: true });
        }
        await page.locator('.window-close').click(); await page.waitForURL(base);
        checked.push(model + '-' + language);
      }
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: 'networkidle' });
      const mobile = await page.locator('.programs-grid>a').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
      assert.ok(mobile.every(top => Math.abs(top - mobile[0]) < 1));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, 'programs-' + language + '-mobile.png'), fullPage: true });
      await page.locator('.document-icon').last().click(); await page.waitForLoadState('networkidle');
      const frame = page.frames().find(frame => frame.url().includes('/manuals/'));
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: path.join(output, 'reader-' + language + '-mobile.png'), fullPage: true });
      if (language === 'en') {
        await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
        await page.locator('input[value="ru"]').check(); await page.locator('#options-accept').click();
        await page.waitForFunction(() => document.querySelector('#document-frame').contentDocument?.documentElement.lang === 'ru');
        assert.match(await page.title(), /Руководство/);
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', checked, errors, hardwareUSBUsed: false }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
