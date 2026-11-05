// Model-profile and calendar UI checks with an in-memory watch; no physical USB.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = new URL('./', process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
const output = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv10-browser');
const adapter = `export const describeUSBDevice = () => ({label:'Mock SigmaTel',name:'Mock SigmaTel',usbId:'066f:4200',supported:true,driver:'SigmaTel STIr4200'});
export function createAdapter(){return {opened:false,configured:true,baud:115200,decoder:{badCRC:0},
 async open(){this.opened=true;return describeUSBDevice();},async close(){this.opened=false;},async pauseReader(){}};}`;
const protocol = `import { ColourCalendar } from './calendar.mjs';
import { fromHex } from './formats.mjs';
export class WQVClient {
 constructor(adapter,options){this.model=options.expectedModel;this.isPrimary=true;window.__expectedModel=this.model;}
 async openPrimary(){this.connected=true;}
 async close(){this.connected=false;}
 async primaryExchange(){}
 async control(command){
  window.__commands.push([...command]);
  if(command[0]===8){window.__calendar=command.slice(3);return Uint8Array.of(13);}
  if(command[0]===9)return new ColourCalendar(window.__calendar||fromHex(window.__initialCalendar));
  throw Error('Unexpected test command');
 }
}`;
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = JSON.parse(await fs.readFile(path.resolve(__dirname, '../fixtures/wqv10-calendar-original.json')));
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    for (const language of ['en', 'ru', 'ja']) {
      const context = await browser.newContext({viewport:{width:1366,height:1100}});
      await context.addInitScript(({language,hex}) => {
        localStorage.setItem('wqv-online.language', language);
        localStorage.setItem('wqv-online.watch-mode', 'pc');
        window.__commands=[];window.__initialCalendar=hex;
        Object.defineProperty(navigator, 'usb', {configurable:true,value:{addEventListener(){},async requestDevice(){return {vendorId:0x066f,productId:0x4200};}}});
      }, {language,hex:fixture.dataHex});
      await context.route('**/adapters.mjs', route => route.fulfill({contentType:'text/javascript',body:adapter}));
      await context.route('**/protocol.mjs', route => route.fulfill({contentType:'text/javascript',body:protocol}));
      const page = await context.newPage(); page.on('pageerror',error=>errors.push(String(error)));
      await page.goto(base,{waitUntil:'networkidle'});
      if (language === 'en') await page.screenshot({path:path.join(output,'programs.png'),fullPage:true});
      await page.locator('.program-icon[href="./wqv3.html?model=wqv10"]').click();
      await page.waitForLoadState('networkidle');
      assert.match(await page.title(), /^WQV-10/);
      assert.equal(await page.locator('.screen > .titlebar .app-title').innerText(), 'WQV-10');
      assert.equal(await page.locator('[data-watch-icon]').getAttribute('href'),'./watches.svg#wqv10');
      assert.match(await page.locator('.menubar-note').innerText(), /2412/);
      assert.match(await page.locator('.upload-box legend').innerText(), /WQV-10/);
      assert.doesNotMatch(await page.locator('#gallery').innerText(), /WQV-3/);
      assert.equal(await page.locator('#watch-guide').getAttribute('href'),'./manual.html?model=wqv10');
      await page.locator('#connect').click();
      await page.waitForFunction(()=>!document.querySelector('#read-holidays').disabled);
      await page.locator('#tab-holidays').click(); await page.locator('#read-holidays').click();
      await page.waitForFunction(()=>!document.querySelector('#holiday-edit').disabled);
      assert.equal(await page.evaluate(()=>window.__expectedModel),10);
      await page.locator('#calendar-year').selectOption('2000'); await page.locator('#calendar-month').selectOption('1');
      assert.equal(await page.locator('#calendar-grid [data-day="1"]').getAttribute('class'),'date-blue');
      await page.locator('#calendar-colour').selectOption('2'); await page.locator('#calendar-grid [data-day="2"]').click();
      assert.match(await page.locator('#calendar-grid [data-day="2"]').getAttribute('class'),/date-red/);
      await page.locator('#calendar-colour').selectOption('3'); await page.locator('#calendar-grid [data-day="3"]').click();
      assert.match(await page.locator('#calendar-grid [data-day="3"]').getAttribute('class'),/date-green/);
      await page.locator('#calendar-colour').selectOption('0'); await page.locator('#calendar-grid [data-day="1"]').click();
      assert.equal(await page.locator('#calendar-grid [data-day="1"]').getAttribute('aria-pressed'),'false');
      await page.locator('#send-holidays').click(); await page.locator('#dialog-accept').click();
      await page.waitForFunction(()=>document.querySelector('.operation-bar').dataset.state==='success'&&!document.querySelector('#holiday-edit').disabled);
      const writes = await page.evaluate(()=>window.__commands.filter(c=>c[0]===8));
      assert.equal(writes.length,1); assert.equal(writes[0].length,7308); assert.deepEqual(writes[0].slice(0,3),[8,28,137]);
      assert.equal(writes[0][3]&15,0); assert.equal(writes[0][4]&15,2); assert.equal(writes[0][5]&15,3);
      assert.equal(await page.evaluate(()=>window.__commands.filter(c=>c[0]===9).length),3);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:path.join(output,'wqv10-calendar-'+language+'.png'),fullPage:true});
      // Photo albums must remain separate when opening the same engine for WQV-3.
      await page.locator('#tab-photos').click();
      const png = await page.evaluate(()=>{const c=document.createElement('canvas');c.width=176;c.height=144;const x=c.getContext('2d');x.fillStyle='#698d52';x.fillRect(0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1];});
      await page.locator('#image-files').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===1);
      await page.locator('#export-format').selectOption('wqv');
      const exported = page.waitForEvent('download'); await page.locator('#save-image').click();
      const archive = JSON.parse(await fs.readFile(await (await exported).path(),'utf8'));
      assert.equal(archive.model,10);
      await page.locator('.window-close:visible').click(); await page.waitForURL(base);
      await page.locator('.program-icon[href="./wqv3.html"]').click(); await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#gallery .thumbnail').count(),0);
      await page.locator('#tab-holidays').click(); assert.equal(await page.locator('.calendar-colour-choice').isVisible(),false);
      await page.locator('.window-close:visible').click(); await page.waitForURL(base);
      await page.locator('.program-icon[href="./wqv3.html?model=wqv10"]').click(); await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#gallery .thumbnail').count(),1);
      await page.locator('#tab-holidays').click();
      await page.locator('#calendar-year').selectOption('2000'); await page.locator('#calendar-month').selectOption('1');
      await page.waitForFunction(()=>!document.querySelector('#holiday-edit').disabled);
      assert.match(await page.locator('#calendar-grid [data-day="2"]').getAttribute('class'),/date-red/);
      await context.close();
    }
    assert.deepEqual(errors,[]); console.log('WQV-10: three languages, model identity, colour editing, backup/write/readback and separate persisted albums passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
