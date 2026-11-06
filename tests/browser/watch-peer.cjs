// Isolated browser; production WATCH client and recorded WQV-3 exchanges.
// The adapter boundary is simulated. No physical USB is opened.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const url = new URL('wqv3.html', process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'wqv-watch-browser');
const mock = `
import { FrameDecoder } from './irda.mjs';
import { KingsunStream } from './kingsun.mjs';
import { fromHex as hx,toHex,b,concat } from './formats.mjs';
export const describeUSBDevice=()=>({label:window.__ks?'USB to IRDA · 07d0:4959':'IrDA/USB Bridge · 066f:4200',
  name:'Test adapter',usbId:window.__ks?'07d0:4959':'066f:4200',supported:true,driver:window.__ks?'KingSun KS-959':'SigmaTel STIr4200'});
export function createAdapter(){
  let queue=[],fed=false,index=0,prime=false,phase=window.__fixture.download.initialCounter;
  const a={opened:false,configured:false,baud:9600,decoder:new FrameDecoder(),stream:new KingsunStream(),
    readerTask:null,readPending:false,rxBytes:0,txFrames:0,outEndpoint:1,inEndpoint:2,revision:null,description:describeUSBDevice(),
    assertOpen(){if(!this.opened)throw Error('Closed');},async open(){this.opened=true;return this.description;},
    async close(){this.opened=false;},async pauseReader(){},
    async setupSIR(){this.configured=true;this.baud=9600;queue=[];fed=false;index=0;prime=false;},
    async setSIRSpeed(rate){if(![9600,115200].includes(rate))throw Error('Unexpected WATCH speed');this.baud=rate;},
    async sendFrame(address,control,data){
      const row={address,control,dataHex:toHex(data)};
      if(window.__direction==='receive'&&!prime){
        if(address!==255||control!==0x3f)throw Error('Expected one receiver prime');prime=true;window.__primed++;
      }else{
        const expected=window.__direction==='receive'?window.__fixture.download.expectedHostFrames[index]:window.__fixture.upload.groups[index]?.tx;
        if(JSON.stringify(row)!==JSON.stringify(expected))throw Error('WATCH '+window.__direction+' frame mismatch at '+index);
        if(window.__direction==='send')queue.push(...window.__fixture.upload.groups[index].reads.map(hx));index++;
      }
      if(address===255&&control===0x3f&&data.length>=12)this.stream.expectDiscovery(data.slice(1,5));
      window.__frames.push(row);this.txFrames++;
    },
    async readRaw(){
      if(window.__hang)return new Promise(()=>{});
      if(!window.__allowWatch){await new Promise(r=>setTimeout(r,3));return {status:'ok',data:new DataView(b().buffer)};}
      if(window.__direction==='receive'&&!fed){queue.push(hx(window.__fixture.download.sirHex));fed=true;}
      let clear=queue.shift()??b();
      if(clear.length>2048){queue.unshift(clear.slice(2048));clear=clear.slice(0,2048);}
      if(window.__ks&&clear.length){
        const raw=[];for(const v of clear){phase=(phase+1)&255;if(!phase){raw.push(0xc0);phase=1;}raw.push(v^phase^0x55);}
        clear=this.stream.feed(b(...raw));
      }
      if(!clear.length)await new Promise(r=>setTimeout(r,2));
      return {status:'ok',data:new DataView(clear.buffer,clear.byteOffset,clear.length)};
    }};
  window.__adapter=a;return a;
}`;

(async()=>{
  const original=JSON.parse(await fs.readFile(path.join(repo,'tests/fixtures/wqv3-watch-hardware.json')));
  const fixture={...original,download:original.download115200,upload:original.upload115200,upfHex:original.upf115200Hex};
  await fs.mkdir(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true});
  try{
    for(const ks of [true,false]){
      const context=await browser.newContext({viewport:{width:1280,height:1050}}),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await page.addInitScript(({fixture,ks})=>{
        window.__fixture=fixture;window.__ks=ks;window.__direction='receive';window.__allowWatch=false;
        window.__localID=fixture.download.localID;window.__primed=0;window.__frames=[];
        const random=crypto.getRandomValues.bind(crypto);
        crypto.getRandomValues=values=>{if(values.length===4){values.set(window.__localID.match(/../g).map(s=>parseInt(s,16)));return values;}return random(values);};
        const usb=new EventTarget();usb.requestDevice=async()=>({vendorId:ks?0x07d0:0x066f,productId:ks?0x4959:0x4200});
        Object.defineProperty(navigator,'usb',{configurable:true,value:usb});
      },{fixture,ks});
      await page.route('**/adapters.mjs',route=>route.fulfill({contentType:'text/javascript',body:mock}));
      await page.goto(url);await page.locator('[data-mode=watch]').click();
      await page.waitForFunction(()=>document.querySelector('[data-mode=watch]').getAttribute('aria-pressed')==='true');
      assert.equal(await page.locator('#tab-clock').isVisible(),false);
      assert.equal(await page.locator('#tab-holidays').isVisible(),false);
      assert.equal(await page.locator('#download-all').isVisible(),false);
      assert.equal(await page.locator('.remote-strip').isVisible(),false);
      await page.locator('#tab-connection').click();
      assert.equal(await page.locator('#transfer-protocol').innerText(),'WATCH / IrTran-P');
      assert.equal(await page.locator('[data-watch-only]').innerText(),'Speed\nAutomatic · up to 115200 bit/s');
      await page.locator('#tab-photos').click();
      await page.locator('#connect').click();await page.waitForFunction(()=>!document.getElementById('receive-photo').disabled);
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      assert.equal(await page.locator('#transfer-path').innerText(),'IR → WATCH → SEND');
      assert.match(await page.locator('#transfer-instructions').innerText(),/once.*side buttons/);
      assert.deepEqual(await page.evaluate(()=>[window.__primed,window.__frames.length]),[0,0]);
      await page.locator('#transfer-cancel').click();await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#gallery .thumbnail').count(),0);
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      await page.locator('#transfer-start').click();
      await page.waitForFunction(()=>window.__primed===1&&document.getElementById('transfer-status').textContent.includes('front button'));
      assert.equal(await page.locator('[data-mode=pc]').isEnabled(),false);
      await page.evaluate(()=>window.__allowWatch=true);
      await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Photo received',await page.locator('#result-detail').innerText());
      assert.equal(await page.locator('#gallery .thumbnail').count(),1);
      await page.locator('#export-format').selectOption('upf');
      const download=page.waitForEvent('download');await page.locator('#save-image').click();
      assert.deepEqual(await fs.readFile(await(await download).path()),Buffer.from(fixture.upfHex,'hex'));
      await page.evaluate(()=>{window.__direction='send';window.__allowWatch=false;window.__localID=window.__fixture.upload.localID;window.__frames=[];});
      await page.locator('#upload-name').fill('QW000000.UPF');
      await page.locator('#upload-image').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      assert.equal(await page.locator('#transfer-path').innerText(),'IR → WATCH → RECEIVE');
      assert.deepEqual(await page.evaluate(()=>window.__frames),[]);
      await page.locator('#transfer-start').click();await page.evaluate(()=>window.__allowWatch=true);
      await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Photo sent',await page.locator('#result-detail').innerText());
      assert.deepEqual(await page.evaluate(()=>window.__frames),fixture.upload.groups.map(g=>g.tx));
      assert.equal(await page.locator('#gallery .thumbnail').count(),1);
      // SCEP closes and the photo is complete, but the final IrLAP DISC is
      // missing. Keep the photo, warn about the session and release USB.
      await page.evaluate(async()=>{
        const {FrameDecoder,encodeFrame}=await import('./irda.mjs');
        const {fromHex,toHex,concat}=await import('./formats.mjs');
        const decoder=new FrameDecoder();decoder.feed(fromHex(window.__fixture.download.sirHex));
        const frames=decoder.frames.filter(f=>f.address!==0x71||f.control!==0x53);
        window.__fixture.download.sirHex=toHex(concat(...frames.map(f=>encodeFrame(f.address,f.control,f.data))));
        window.__fixture.download.expectedHostFrames.pop();
        window.__direction='receive';window.__allowWatch=false;window.__localID=window.__fixture.download.localID;
      });
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      await page.locator('#transfer-start').click();await page.evaluate(()=>window.__allowWatch=true);
      await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Photo received; connection did not close normally');
      assert.equal(await page.locator('#gallery .thumbnail').count(),2);
      assert.equal(await page.evaluate(()=>window.__adapter.opened),false);
      // Both modes share the same original local photo, and WATCH persists.
      await page.locator('[data-mode=pc]').click();assert.equal(await page.locator('#gallery .thumbnail').count(),2);
      await page.locator('[data-mode=watch]').click();await page.reload();
      await page.waitForFunction(()=>document.querySelector('[data-mode=watch]').getAttribute('aria-pressed')==='true');
      assert.equal(await page.locator('#gallery .thumbnail').count(),2);
      for(const [language,heading] of [['ru','Режим WATCH'],['ja','WATCHモード'],['en','WATCH mode']]){
        await page.evaluate(async lang=>(await import('./i18n.mjs')).setLanguage(lang),language);
        await page.locator('[data-mode=pc]').click();await page.locator('[data-mode=watch]').click();
        assert.equal(await page.locator('#result-heading').innerText(),heading);
      }
      await page.screenshot({path:path.join(artifacts,(ks?'ks959':'sigmatel')+'-watch.png')});
      await page.setViewportSize({width:360,height:800});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(artifacts,(ks?'ks959':'sigmatel')+'-watch-mobile.png')});
      await page.goto(url+'?model=wqv10');
      assert.equal(await page.locator('[data-mode=watch]').isVisible(),false);
      assert.equal(await page.locator('[data-mode=pc]').getAttribute('aria-pressed'),'true');
      assert.deepEqual(errors,[]);await context.close();
    }
    console.log('PASS: WATCH physical receive/upload replay, missing link close preserves photo and releases USB, one PUT, no TX before Start, exact UPF export, shared album, persistence, translations, mobile, WQV-10 exclusion');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
