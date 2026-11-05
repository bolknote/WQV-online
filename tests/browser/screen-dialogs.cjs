const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';

test('native dialogs, focus and shading stay within the visible LCD after resize', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const file of ['index.html', 'wqv2.html', 'wqv3.html', 'drivers.html']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL(file, base).href);
    await page.locator('#help-top').click();
    await page.locator('#message-dialog.screen-dialog[open]').waitFor();
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 700 }, { width: 320, height: 480 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const d = document.getElementById('message-dialog').getBoundingClientRect(), s = document.querySelector('.screen').getBoundingClientRect();
        return d.left >= Math.max(s.left, 0) && d.right <= Math.min(s.right, innerWidth) && d.top >= Math.max(s.top, 0) && d.bottom <= Math.min(s.bottom, innerHeight);
      });
      assert.equal(await page.locator('#message-dialog').evaluate(dialog => dialog.contains(document.activeElement)), true, file + ': focus');
      assert.equal(await page.locator('#message-dialog').evaluate(dialog => getComputedStyle(dialog, '::backdrop').backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await page.locator('.screen').evaluate(screen => getComputedStyle(screen, '::after').content), '""');
      assert.ok(await page.locator('#message-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), file + ': dialog width');
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.screen').classList.contains('screen-modal-open'));
    assert.equal(await page.locator('#message-dialog').isVisible(), false);
    // A page stored in the back/forward cache must keep its dialog observers.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.locator('#help-top').click();
    await page.locator('#message-dialog.screen-dialog[open]').waitFor();
    assert.equal(await page.locator('.screen').evaluate(screen => screen.classList.contains('screen-modal-open')), true);
    await page.locator('#dialog-accept').click();
  }
  assert.deepEqual(errors, []);
});
