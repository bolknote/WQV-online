// Desktop menus only; no adapter selection or infrared traffic.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const output = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-menus-browser');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('wqv-online.language', 'de'));
  const page = await context.newPage(), errors = [], checked = [];
  page.on('pageerror', error => errors.push(error.message));
  const openMenus = () => page.locator('.menubar details.menu').evaluateAll(menus => menus.flatMap((menu,index) => menu.open ? [index] : []));
  async function only(index) {
    assert.deepEqual(await openMenus(), index === null ? [] : [index]);
    assert.equal(await page.locator('#start-menu').isVisible(), false);
    assert.equal(await page.locator('#start-menu-button').getAttribute('aria-expanded'), 'false');
  }
  try {
    for (const file of ['','wqv2.html','wqv3.html','wqv3.html?model=wqv10','manual.html?model=wqv3']) {
      await page.goto(new URL(file, base).href, { waitUntil: 'networkidle' });
      const menus = page.locator('.menubar details.menu'), summaries = menus.locator('summary');
      const count = await menus.count(), second = count > 1 ? 1 : 0;
      assert.ok(count >= 1);
      if (count > 1) {
        await summaries.nth(0).click();
        assert.deepEqual(await openMenus(), [0]);
        await summaries.nth(1).click();
        await only(1);
        assert.equal(await menus.nth(0).locator('.menu-popup').isVisible(), false);
        assert.equal(await menus.nth(1).locator('.menu-popup').isVisible(), true);
        await page.screenshot({ path: path.join(output, file.replace(/[^a-z0-9-]/gi,'-') + '.png') });
        await summaries.nth(1).click(); await only(null);
      }

      await summaries.nth(0).focus(); await page.keyboard.press('Enter'); await only(0);
      if (count > 1) { await summaries.nth(1).focus(); await page.keyboard.press('Space'); await only(1); }
      await page.keyboard.press('Escape'); await only(null);

      await summaries.nth(0).click();
      await page.locator('#start-menu-button').click();
      assert.deepEqual(await openMenus(), []);
      assert.equal(await page.locator('#start-menu').isVisible(), true);
      assert.equal(await page.locator('#start-menu-button').getAttribute('aria-expanded'), 'true');
      // The Start popup can cover the menu bar; a focused summary can still
      // be opened from the keyboard and must dismiss Start.
      await summaries.nth(second).focus(); await page.keyboard.press('Enter'); await only(second);
      await page.locator('.case-brand').click(); await only(null);
      await page.locator('#start-menu-button').click();
      await page.keyboard.press('Escape'); await only(null);

      if (count > 1) {
        await menus.evaluateAll(menus => { menus[0].open = true; menus[1].open = true; });
        await only(1);
        await summaries.nth(1).click(); await only(null);
      }
      checked.push(file || 'Programs');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status:'passed', checked, pointer:true, keyboard:true, startMenuExclusive:true, outsideAndEscape:true, hardwareUSBUsed:false }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
