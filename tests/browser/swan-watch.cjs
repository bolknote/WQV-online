// Isolated browser, real SWAN/album code and captured packets. No real USB.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '../..');
const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-swan-browser');
const url = new URL('wqv3.html', process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
const mock = `
import { FrameDecoder } from './irda.mjs';
import { KingsunStream } from './kingsun.mjs';
import { WQV12Decoder } from './wqv12-formats.mjs';
import { fromHex as hx,toHex,concat,b } from './formats.mjs';
export const describeUSBDevice=()=>({label:window.__ks?'USB to IRDA · 07d0:4959':'IrDA/USB Bridge · 066f:4200',name:'Test adapter',
  usbId:window.__ks?'07d0:4959':'066f:4200',supported:true,driver:window.__ks?'KingSun KS-959':'SigmaTel STIr4200'});
export function createAdapter() {
  const queue=[],out=new WQV12Decoder();let fed=false,index=0,phase=117;
  const a={opened:false,configured:false,baud:9600,decoder:new FrameDecoder(),stream:new KingsunStream(),readerTask:null,readPending:false,
    txFrames:0,rxBytes:0,outEndpoint:1,inEndpoint:2,description:describeUSBDevice(),
    async open(){this.opened=true;return this.description;},assertOpen(){if(!this.opened)throw Error('Closed');},
    async close(){this.opened=false;},async pauseReader(){},async setupSIR(){this.configured=true;this.baud=9600;fed=false;index=0;queue.length=0;out.reset();},
    async setSIRSpeed(baud){this.baud=baud;},async io(promise){return promise;},
    async registers(start=1){return start===5?b(4,0,0):hx('2a1d00274400001500');},
    async sendFrame(){window.__primed++;}
  };
  const transmit=bytes=>{
    window.__wire.push(toHex(bytes));out.feed(bytes);
    for(const f of out.frames.splice(0)){
      const value={address:f.address,control:f.control,dataHex:toHex(f.data)};
      window.__frames.push(value);
      if(window.__direction==='send'){
        const expected=window.__sender[index];
        if(JSON.stringify(value)!==JSON.stringify(expected.tx))throw Error('Unexpected SWAN upload frame '+index);
        queue.push(hx(expected.rx));index++;
      }
    }
  };
  const input=async()=>{
    if(window.__hang)return new Promise(()=>{});
    if(!window.__allowWatch){await new Promise(r=>setTimeout(r,5));return b();}
    if(window.__direction==='receive'&&!fed){
      const wire=hx(window.__fixture.sirHex);
      queue.push(window.__ks?concat(hx('55ff00c0ffb301b2c1'),wire):wire);fed=true;
    }
    let bytes=queue.shift()??b();
    const limit=window.__ks?2048:64;
    if(bytes.length>limit){queue.unshift(bytes.slice(limit));bytes=bytes.slice(0,limit);}
    if(!bytes.length)await new Promise(r=>setTimeout(r,2));
    if(!window.__ks)return bytes;
    const raw=[];
    for(const v of bytes){phase=(phase+1)&255;if(!phase){raw.push(0x95^0x55);phase=1;}raw.push(v^phase^0x55);}
    return b(...raw);
  };
  const result=bytes=>({status:'ok',data:new DataView(bytes.buffer,bytes.byteOffset,bytes.length)});
  a.device={
    async transferIn(){return result(await input());},
    async transferOut(endpoint,packet){if(packet[0]!==0x55||packet[1]!==0xaa)throw Error('Bad SigmaTel envelope');
      if((packet[2]|packet[3]<<8)!==packet.length-4)throw Error('Bad length');transmit(packet.slice(4));return {status:'ok',bytesWritten:packet.length};},
    async controlTransferIn(){return result(await input());},
    async controlTransferOut(setup,packet){const mask=new TextEncoder().encode('wangshuofei19710')[(setup.value&15)^6]^0x55;
      transmit(Uint8Array.from(packet.slice(0,setup.value),v=>v^mask));return {status:'ok',bytesWritten:packet.length};}
  };
  window.__adapter=a;return a;
}`;
(async()=>{
  const fixture=JSON.parse(await fs.readFile(repo+'/tests/fixtures/wqv3-swan-hardware.json'));
  const {WQV12Decoder,encodeWQV12}=await import(pathToFileURL(repo+'/dist/wqv12-formats.mjs'));
  const {b,concat,fromHex:hx,toHex}=await import(pathToFileURL(repo+'/dist/formats.mjs'));
  const decoder=new WQV12Decoder();decoder.feed(hx(fixture.sirHex));
  const frames=decoder.frames,record=concat(...frames.filter(f=>!(f.control&1)&&f.data[0]===0x11).map(f=>f.data.slice(1)));
  const tx=frames.filter((_,i)=>i!==12).map(f=>({address:f.address,control:f.control,dataHex:toHex(f.data)}));
  const rx=fixture.expectedTransmissions.filter((_,i)=>i!==12).map(f=>concat(hx('55ff00'),encodeWQV12(f.address,f.control,hx(f.dataHex))));
  tx.splice(-1,0,{address:7,control:0x51,dataHex:''});rx.splice(-1,0,hx('55ff00c007410048c1'));
  const sender=tx.map((f,i)=>({tx:f,rx:toHex(rx[i])}));
  await fs.mkdir(artifacts,{recursive:true});const browser=await chromium.launch({headless:true});
  try{
    for(const ks of [false,true]){
      const context=await browser.newContext({viewport:{width:1280,height:1100}}),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await page.addInitScript(({fixture,sender,ks})=>{
        window.__fixture=fixture;window.__sender=sender;window.__ks=ks;window.__wire=[];window.__frames=[];window.__primed=0;
        window.__direction='receive';window.__allowWatch=false;
        const DateOriginal=Date;window.Date=class extends DateOriginal{constructor(...args){super(...(args.length?args:['2026-10-31T19:29:16.786']));}};
        const usb=new EventTarget();usb.requestDevice=async()=>({vendorId:ks?0x07d0:0x066f,productId:ks?0x4959:0x4200});
        Object.defineProperty(navigator,'usb',{configurable:true,value:usb});
      },{fixture,sender,ks});
      await page.route('**/adapters.mjs',route=>route.fulfill({contentType:'text/javascript',body:mock}));
      await page.goto(url);await page.locator('[data-mode=swan]').click();
      await page.waitForFunction(()=>document.querySelector('[data-mode=swan]').getAttribute('aria-pressed')==='true');
      assert.equal(await page.locator('#tab-clock').isVisible(),false);assert.equal(await page.locator('#tab-holidays').isVisible(),false);
      assert.equal(await page.locator('.filename-row').isVisible(),false);
      await page.locator('#connect').click();await page.waitForFunction(()=>!document.getElementById('receive-photo').disabled);
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      assert.equal(await page.locator('#transfer-path').innerText(),'IR → SWAN → SEND');
      assert.deepEqual(await page.evaluate(()=>[window.__primed,window.__wire.length]),[0,0]);
      await page.locator('#transfer-cancel').click();await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      await page.locator('#transfer-start').click();await page.waitForFunction(()=>window.__primed===1&&document.getElementById('transfer-status').textContent.includes('front button'));
      await page.evaluate(()=>window.__allowWatch=true);await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Photo received',await page.locator('#result-detail').innerText());
      assert.equal(await page.locator('#gallery .thumbnail').count(),1);assert.equal(await page.locator('#selected-name').innerText(),fixture.captionASCII);
      const expected=[...fixture.expectedTransmissions];if(ks)expected.splice(1,0,expected[0]);
      assert.deepEqual(await page.evaluate(()=>window.__frames),expected);
      assert.equal(await page.locator('#export-swan').getAttribute('hidden'),null);
      await page.locator('#export-format').selectOption('bin');const downloading=page.waitForEvent('download');await page.locator('#save-image').click();
      assert.deepEqual(await fs.readFile(await(await downloading).path()),Buffer.from(record));
      // Exact original pixels return to the watch; derived JPEG is not used.
      await page.evaluate(()=>{window.__direction='send';window.__allowWatch=false;window.__wire=[];window.__frames=[];});
      await page.locator('#upload-image').click();await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      assert.equal(await page.locator('#transfer-path').innerText(),'IR → SWAN → RECEIVE');
      await page.locator('#transfer-start').click();await page.evaluate(()=>window.__allowWatch=true);
      await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
      assert.equal(await page.locator('#result-heading').innerText(),'Photo sent');assert.deepEqual(await page.evaluate(()=>window.__frames),tx);
      // WQV backup/import retains the raw record and checksum, including duplicates.
      await page.locator('#export-format').selectOption('wqv');const backupWait=page.waitForEvent('download');await page.locator('#save-image').click();
      const backup=await fs.readFile(await(await backupWait).path());
      await page.locator('#image-files').setInputFiles({name:'backup.wqv',mimeType:'application/json',buffer:backup});
      await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===2&&!document.getElementById('import-images').disabled);
      const archive=JSON.parse(backup);assert.equal(archive.swan.recordHex,toHex(record));
      for(const lang of ['ru','ja','en']){
        await page.evaluate(async lang=>(await import('./i18n.mjs')).setLanguage(lang),lang);
        assert.equal(await page.locator('html').getAttribute('lang'),lang);
        await page.screenshot({path:artifacts+'/'+(ks?'ks959':'sigmatel')+'-'+lang+'.png',fullPage:true});
      }
      await page.locator('[data-mode=pc]').click();assert.equal(await page.locator('.filename-row').isVisible(),true);
      await page.locator('[data-mode=others]').click();assert.equal(await page.locator('#receive-photo').isVisible(),true);
      await page.locator('[data-mode=swan]').click();await page.reload();
      await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===2);
      assert.equal(await page.locator('[data-mode=swan]').getAttribute('aria-pressed'),'true');
      await page.locator('#connect').click();await page.locator('#receive-photo').click();
      await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
      await page.evaluate(()=>{window.__hang=true;window.__allowWatch=false;});
      await page.locator('#transfer-start').click();await page.waitForFunction(()=>document.getElementById('transfer-start').hidden);
      await page.locator('#transfer-cancel').click();await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open,{timeout:1500});
      await page.setViewportSize({width:360,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:artifacts+'/'+(ks?'ks959':'sigmatel')+'-mobile.png',fullPage:true});
      assert.deepEqual(errors,[]);await context.close();
      console.log('PASS '+(ks?'KS-959':'SigmaTel')+': captured receive/send, lossless BIN/WQV, shared album, three languages, cancel, persistence, mobile; no real USB');
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
