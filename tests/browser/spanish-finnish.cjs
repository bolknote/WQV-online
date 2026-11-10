// Locale and manual checks only. No USB device is opened.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const output = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-spanish-finnish-browser');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [], checked = [];
  function observe(page) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(response.url() + ': ' + response.status()); });
  }
  async function selectLanguage(page, language) {
    await page.locator('#start-menu-button').click();
    await page.locator('#start-options').click(); await page.locator('#settings-language').click();
    assert.equal(await page.locator('input[name="display-language"]').count(), 6);
    await page.locator(`input[name="display-language"][value="${language}"]`).check();
    await page.locator('#options-accept').click();
    await page.waitForFunction(value => document.documentElement.lang === value, language);
  }
  async function fits(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, page.url());
  }
  try {
    for (const [language, label, photos, clock, tools, contents] of [
      ['es', 'Guía del usuario', 'Fotos', 'Reloj', 'Herramientas', 'Índice'],
      ['fi', 'Käyttöohje', 'Kuvat', 'Kello', 'Työkalut', 'Sisällys'],
    ]) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
      const page = await context.newPage(); observe(page);
      await page.goto(base, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      await selectLanguage(page, language);
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('lang'), language);
      assert.equal(await page.locator('[data-i18n="Tools"]').textContent(), tools);
      await page.screenshot({ path: path.join(output, language + '-programs.png'), fullPage: true });
      for (const model of ['wqv2', 'wqv3', 'wqv10']) {
        const translated = language === 'es' ? model !== 'wqv10' : model === 'wqv3';
        const edition = translated ? language : 'en';
        const guideLabel = translated ? label : 'User’s Guide';
        const guide = page.locator(`.document-icon[href="./manual.html?model=${model}"]`);
        assert.equal(await guide.locator('[data-i18n="User’s Guide"]').textContent(), guideLabel);
        if (!translated) assert.match(await guide.getAttribute('aria-label'), /User’s Guide$/);
        await guide.click();
        await page.waitForFunction(edition => document.querySelector('#document-frame').contentDocument?.documentElement?.lang === edition &&
          document.querySelector('#document-loading').hidden && !document.querySelector('#document-contents').disabled, edition);
        const frame = page.frames().find(frame => frame.url().includes('/manuals/'));
        assert.ok(frame.url().endsWith(model + '-' + edition + '.html'));
        assert.ok((await page.locator('#document-title').textContent()).endsWith(' — ' + guideLabel));
        assert.equal(await page.locator('#document-frame').getAttribute('title'), guideLabel);
        assert.equal(await page.locator('#document-contents option').first().textContent(), contents);
        assert.match(await page.locator('#original-pdf').getAttribute('href'), translated
          ? new RegExp(language === 'es' ? 'baroli.*' + (model === 'wqv2' ? '2220' : '2411') : 'perkko.*2411') : /_EN\.pdf$/);
        await page.locator('#document-size').selectOption('larger');
        assert.equal(await frame.locator('html').evaluate(root => getComputedStyle(root).fontSize), '20px');
        if (!translated) {
          await frame.evaluate(() => { window.fallbackSentinel = true; });
          await selectLanguage(page, 'en');
          await selectLanguage(page, language);
          assert.equal(await frame.evaluate(() => window.fallbackSentinel), true, 'English fallback must stay open while changing the UI language');
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await fits(page);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: path.join(output, `${model}-${language}-reader-mobile.png`), fullPage: true });
        await page.setViewportSize({ width: 1366, height: 1000 });
        await page.locator('.window-close:visible').click(); await page.waitForURL(base);
        const app = model === 'wqv2' ? './wqv2.html' : model === 'wqv3' ? './wqv3.html' : './wqv3.html?model=wqv10';
        await page.locator(`.program-icon[href="${app}"]`).click();
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('html').getAttribute('lang'), language);
        assert.equal((await page.locator('#tab-photos').textContent()).trim(), photos);
        await page.locator('#tab-clock').click();
        assert.equal((await page.locator('#tab-clock').textContent()).trim(), clock);
        if (model !== 'wqv2') {
          assert.equal(await page.locator('#watch-guide').textContent(), guideLabel);
          await page.locator('#tab-holidays').click();
          assert.equal((await page.locator('#calendar-month option').first().textContent()).trim(), language === 'es' ? 'Enero' : 'Tammikuu');
          assert.equal(await page.locator('.calendar-weekdays').innerText(), language === 'es' ? 'Lun\nMar\nMié\nJue\nVie\nSáb\nDom' : 'Ma\nTi\nKe\nTo\nPe\nLa\nSu');
        }
        await page.screenshot({ path: path.join(output, `${model}-${language}-app.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await fits(page);
        await page.locator('#tab-photos').click();
        await page.screenshot({ path: path.join(output, `${model}-${language}-app-mobile.png`), fullPage: true });
        await page.locator('#start-menu-button').click(); await page.locator('#start-options').click(); await page.locator('#settings-language').click();
        assert.equal(await page.locator(`input[value="${language}"]`).isChecked(), true);
        assert.equal(await page.locator('#settings-window').evaluate(node => node.scrollHeight <= node.clientHeight + 1), true);
        await page.screenshot({ path: path.join(output, `${model}-${language}-options-mobile.png`), fullPage: true });
        await page.locator('#options-cancel').click();
        await page.setViewportSize({ width: 1366, height: 1000 });
        await page.locator('.window-close:visible').click(); await page.waitForURL(base);
        checked.push(model + '-' + language + ' UI and ' + edition + ' manual');
      }
      // Every new source page is rendered at desktop and phone widths.
      for (const model of (language === 'es' ? ['wqv2', 'wqv3'] : ['wqv3'])) {
        const proof = await context.newPage(); observe(proof);
        await proof.setViewportSize({ width: 820, height: 1000 });
        await proof.goto(base + `manuals/${model}-${language}.html`, { waitUntil: 'networkidle' });
        for (const section of await proof.locator('.source-page').all()) {
          const n = (await section.getAttribute('data-page')).padStart(2, '0');
          await section.screenshot({ path: path.join(output, `${model}-${language}-page-${n}.png`) });
        }
        const ratios = await proof.locator('.illustration svg').evaluateAll(items => items.map(svg => {
          const box = svg.getBoundingClientRect(), viewport = svg.viewBox.baseVal;
          return (box.width / box.height) / (viewport.width / viewport.height);
        }));
        assert.ok(ratios.length > 30 && ratios.every(value => Math.abs(value - 1) < .015));
        assert.deepEqual(await proof.locator('.manual-index a').evaluateAll(links => links.filter(link => !document.getElementById(link.hash.slice(1))).map(link => link.hash)), []);
        await proof.setViewportSize({ width: 320, height: 844 });
        await fits(proof);
        assert.equal(await proof.locator('.illustration').evaluateAll(items => items.every(item => getComputedStyle(item).float === 'none')), true);
        assert.ok(await proof.locator('.diagram-viewport').evaluateAll(items => items.some(item => item.scrollWidth > item.clientWidth + 8)));
        for (const n of (language === 'es' ? model === 'wqv3' ? [3,4,5,6,8,11,13] : [2,5,8,11] : [3,7,8,11,16,18])) {
          await proof.locator('#page-' + n).screenshot({ path: path.join(output, `${model}-${language}-page-${n}-mobile.png`) });
        }
        await proof.close();
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', checked, newManualPages: 42, errors, hardwareUSBUsed: false }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
