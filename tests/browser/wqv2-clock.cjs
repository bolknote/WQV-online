// All USB operations below use mockUSB; this test never opens hardware.
const {chromium}=require(process.env.WQV_PLAYWRIGHT||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {mockUSB}=require('./applications.cjs');
const base=process.env.WQV_APP_URL||'http://127.0.0.1:8765/';
const artifacts=process.env.WQV_BROWSER_ARTIFACTS||path.join(require('node:os').tmpdir(),'wqv2-clock-browser');

(async()=>{
  await fs.mkdir(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true}),errors=[];
  try{
    for(const kind of ['sigmatel','kingsun']){
      const context=await browser.newContext({viewport:{width:1280,height:1000}});
      await context.addInitScript(mockUSB,kind);
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(new URL('wqv2.html',base).href);
      await page.locator('#tab-clock').click();
      assert.equal(await page.locator('#panel-clock').isVisible(),true);
      assert.equal(await page.locator('#set-clock').isEnabled(),false);
      await page.locator('#connect').click();await page.waitForFunction(()=>!document.querySelector('#set-clock').disabled);
      await page.locator('#clock-date').fill('2024-02-29');await page.locator('#clock-time').fill('23:59');
      await page.locator('#set-clock').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);
      assert.equal(await page.locator('#transfer-title').innerText(),'Set date and time');
      assert.match(await page.locator('#transfer-detail').innerText(),/Seconds will stay unchanged/);
      assert.equal(await page.evaluate(()=>window.__mock.tx.length),0);
      assert.equal(await page.locator('#clock-date').isEnabled(),false);
      await page.locator('#transfer-start').click();await page.waitForFunction(()=>!document.querySelector('#transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Date and time updated');
      assert.deepEqual(await page.evaluate(()=>window.__mock.clockWrites),[[13,24,2,29,23,59,4]]);
      assert.equal(await page.locator('#clock-watch-time').innerText(),'13:20:30');
      assert.match(await page.locator('#clock-snapshot-note').innerText(),/before the clock update/);
      assert.equal(await page.locator('#gallery .thumbnail').count(),0);
      await page.evaluate(()=>window.__mock.startPC());
      await page.locator('#read-clock').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);
      await page.locator('#transfer-start').click();await page.waitForFunction(()=>!document.querySelector('#transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Watch time read');
      assert.equal(await page.evaluate(()=>window.__mock.clockWrites.length),1);
      assert.doesNotMatch(await page.locator('#clock-snapshot-note').innerText(),/before the clock update/);
      await page.locator('#tab-clock').focus();await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#tab-connection').getAttribute('aria-selected'),'true');
      await page.locator('#tab-clock').click();await page.locator('[data-mode=others]').click();
      assert.equal(await page.locator('#tab-clock').isVisible(),false);assert.equal(await page.locator('#panel-clock').isVisible(),false);
      assert.equal(await page.locator('#panel-photos').isVisible(),true);
      await page.locator('[data-mode=pc]').click();await page.locator('#tab-clock').click();
      await page.locator('#start-menu-button').click();await page.locator('#start-options').click();
      await page.locator('input[value=ru]').check();await page.locator('#options-accept').click();
      assert.equal(await page.locator('#read-clock').innerText(),'Прочитать время часов');
      await page.screenshot({path:path.join(artifacts,kind+'-clock-ru.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(artifacts,kind+'-clock-mobile.png'),fullPage:true});
      await page.locator('#start-menu-button').click();await page.locator('#start-options').click();
      await page.locator('input[value=ja]').check();await page.locator('#options-accept').click();
      assert.equal(await page.locator('#read-clock').innerText(),'腕時計の時刻を読み取る');
      await page.screenshot({path:path.join(artifacts,kind+'-clock-ja.png'),fullPage:true});
      // Cancel after a request was sent, while its application ACK is missing.
      await page.evaluate(()=>{window.__mock.startPC();window.__mock.dropClockReply=true;});
      await page.locator('#set-clock').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);
      await page.locator('#transfer-start').click();await page.waitForFunction(()=>window.__mock.clockWrites.length===2);
      await page.locator('#transfer-cancel').click();await page.waitForFunction(()=>!document.querySelector('#transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'日時の設定を確認できませんでした');
      assert.equal(await page.evaluate(()=>window.__mock.clockWrites.length),2);
      await context.close();
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',adapters:['SigmaTel','KS-959 helper'],languages:['en','ru','ja'],
      noWriteBeforeStart:true,originalClockAndCompletionBytes:true,readTimeWithoutSetting:true,
      uncertainCancellation:true,hiddenInOTHERS:true,mobileOverflow:false,hardwareUSBUsed:false,errors}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
