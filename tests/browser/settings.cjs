const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';

async function openSetting(page, name) {
  await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
  await page.locator('#settings-' + name).click();
}
async function calendarColumn(page, day) {
  return page.locator('#calendar-grid').evaluate((grid, day) => [...grid.children].findIndex(cell => cell.dataset.day === String(day)) % 7, day);
}

test('Settings stays compact inside the LCD, closes with a titlebar cross and leaves the background usable', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const file of ['index.html', 'wqv2.html', 'wqv3.html', 'drivers.html', 'manual.html?model=wqv3']) {
    await page.goto(new URL(file, base).href);
    await page.evaluate(() => { window.__settingsClock = document.getElementById('pc-clock'); });
    const title = await page.title();
    await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
    assert.equal(await page.locator('#settings-window').isVisible(), true);
    assert.equal(await page.locator('#settings-home .dialog-actions').count(), 0);
    assert.equal(await page.locator('#settings-close.window-close').textContent(), '×');
    assert.equal(await page.locator('.screen-modal-open').count(), 0);
    assert.equal(await page.locator(':modal').count(), 0);
    assert.equal(await page.locator('#settings-window #start-menu-button').count(), 0);
    assert.equal(await page.evaluate(() => window.__settingsClock === document.querySelector('.screen > .titlebar #pc-clock')), true);
    assert.equal(await page.locator('.screen > [inert]').count(), 0);
    assert.equal(await page.locator('#settings-window').evaluate(node => node.getBoundingClientRect().width <= 430 && node.getBoundingClientRect().height < 300), true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => {
        const app = document.getElementById('settings-window').getBoundingClientRect(), screen = document.querySelector('.screen').getBoundingClientRect();
        return app.left >= Math.max(screen.left, 0) && app.right <= Math.min(screen.right, innerWidth) && app.top >= Math.max(screen.top, 0) && app.bottom <= Math.min(screen.bottom, innerHeight);
      });
    }
    await page.locator('#start-menu-button').click();
    assert.equal(await page.locator('#start-menu').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-window').isVisible(), true);
    assert.equal(await page.locator('#start-menu').isVisible(), false);
    await page.setViewportSize({ width: 320, height: 480 });
    await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
    assert.equal(await page.locator('#settings-window').isVisible(), true);
    await page.locator('#settings-close').click();
    assert.equal(await page.locator('#settings-window').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__settingsClock === document.querySelector('.screen > .titlebar #pc-clock')), true);
    assert.equal(await page.locator('.screen > [inert]').count(), 0);
    assert.equal(await page.title(), title);
  }
  await page.goto(new URL('wqv3.html', base).href);
  await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
  await page.locator('#start-menu-button').click(); await page.locator('#start-menu [data-tab="holidays"]').click();
  assert.equal(await page.locator('#settings-window').isVisible(), false);
  assert.equal(await page.locator('#tab-holidays').getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
});

test('system settings preserve app state, week order, dates and calendar bytes across pages and tabs', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await context.newPage(), errors = [];
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.settings-utility-icon').click();
  assert.equal(await page.locator('#settings-home').isVisible(), true);
  assert.equal(await page.locator('.system-setting').count(), 3);
  assert.equal(await page.locator('#options-title').textContent(), 'Settings');
  assert.equal(await page.locator('#start-menu a[href="./drivers.html"]').count(), 0);
  await page.locator('.system-setting[href="./drivers.html"]').click();
  await page.waitForURL(new URL('drivers.html', base).href);
  await openSetting(page, 'language'); await page.locator('input[value="ru"]').check(); await page.locator('#options-accept').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
  await openSetting(page, 'calendar'); await page.locator('input[name="week-start"][value="sun"]').check();
  assert.equal(await page.locator('#settings-week-preview span').first().textContent(), 'Вс');
  await page.locator('#week-start-cancel').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('wqv-online.week-start')), null);
  await openSetting(page, 'calendar'); assert.equal(await page.locator('input[name="week-start"][value="mon"]').isChecked(), true);
  await page.locator('input[name="week-start"][value="sun"]').check(); await page.locator('#week-start-accept').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('wqv-online.week-start')), 'sun');
  const original = await page.evaluate(async () => {
    const {LocalStore} = await import('./images.mjs'), {HolidayCalendar} = await import('./calendar.mjs');
    const calendar = new HolidayCalendar(); calendar.set(2024,2,29,true); calendar.set(2026,3,1,true);
    const store = new LocalStore(); await store.open(); const backup = calendar.backup(); await store.set('calendar', backup); return JSON.stringify(backup);
  });
  await page.goto(new URL('wqv3.html', base).href);
  await page.waitForFunction(() => document.getElementById('holiday-state').textContent === 'Локальная копия');
  await page.locator('#tab-holidays').click();
  await page.locator('#calendar-year').selectOption('2024'); await page.locator('#calendar-month').selectOption('2');
  assert.deepEqual(await page.locator('.calendar-weekdays span').evaluateAll(nodes => nodes.map(n => +n.dataset.weekday)), [0,1,2,3,4,5,6]);
  assert.deepEqual(await page.locator('.calendar-weekdays .weekend').evaluateAll(nodes => nodes.map(n => +n.dataset.weekday)), [0,6]);
  assert.equal(await calendarColumn(page,29), 4); assert.equal(await page.locator('[data-day="29"]').getAttribute('aria-pressed'), 'true');
  await openSetting(page, 'calendar'); await page.locator('input[name="week-start"][value="mon"]').check(); await page.locator('#week-start-accept').click();
  assert.equal(await page.locator('#tab-holidays').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#calendar-year').inputValue(), '2024'); assert.equal(await page.locator('#calendar-month').inputValue(), '2');
  assert.equal(await calendarColumn(page,29), 3);
  assert.deepEqual(await page.locator('.calendar-weekdays .weekend').evaluateAll(nodes => nodes.map(n => +n.dataset.weekday)), [6,0]);
  await openSetting(page, 'language'); await page.locator('input[value="ja"]').check(); await page.locator('#options-accept').click();
  assert.equal(await page.locator('.calendar-weekdays span').first().textContent(), '月');
  assert.equal(await page.evaluate(() => localStorage.getItem('wqv-online.week-start')), 'mon');
  const second = await context.newPage(); await second.goto(new URL('wqv3.html?model=wqv10', base).href);
  await openSetting(second, 'calendar'); await second.locator('input[name="week-start"][value="sun"]').check(); await second.locator('#week-start-accept').click();
  await page.waitForFunction(() => document.querySelector('.calendar-weekdays span').dataset.weekday === '0');
  assert.equal(await calendarColumn(page,29), 4);
  assert.equal(await page.evaluate(async () => { const store = new (await import('./images.mjs')).LocalStore(); await store.open(); return JSON.stringify(await store.get('calendar')); }), original);
  for (const language of ['en','ru','ja','de','es','fi']) {
    await page.evaluate(async language => (await import('./i18n.mjs')).setLanguage(language), language);
    for (const width of [1024,390,320]) {
      await page.setViewportSize({width,height:900});
      await page.locator('#start-menu-button').click(); await page.locator('#start-options').click();
      for (const panel of ['calendar','language']) {
        await page.locator('#settings-'+panel).click();
        assert.equal(await page.locator('#settings-window').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,language+' / '+width+' / '+panel);
        await page.locator('#settings-'+panel+'-panel [data-settings-back]').click();
      }
      await page.locator('#settings-close').click();
      const dimensions = await page.evaluate(() => ({ width: Math.max(innerWidth, parseFloat(getComputedStyle(document.body).minWidth)), content: document.documentElement.scrollWidth }));
      assert.equal(dimensions.content <= dimensions.width, true, language + ' / ' + width + ' / page ' + JSON.stringify(dimensions));
    }
  }
  const output=process.env.WQV_BROWSER_ARTIFACTS;
  if(output){
    await fs.mkdir(output,{recursive:true});await page.setViewportSize({width:1024,height:950});
    await page.evaluate(async()=> (await import('./i18n.mjs')).setLanguage('en'));
    await page.locator('#start-menu-button').click();await page.locator('#start-options').click();
    await page.screenshot({path:path.join(output,'settings.png'),fullPage:true});
    await page.locator('#settings-window').screenshot({path:path.join(output,'settings-window.png')});
    await page.locator('#settings-calendar').click();await page.screenshot({path:path.join(output,'calendar-settings.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
});
