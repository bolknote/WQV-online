// Uses an isolated browser and captured packets; never accesses a real USB adapter.
const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const appURL = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';
const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(), 'wqv-others-browser');
const mockModule = `
import { FrameDecoder } from './irda.mjs';
import { fromHex, toHex } from './formats.mjs';
export const describeUSBDevice = device => ({ label:'IrDA/USB Bridge · 066f:4200',name:'IrDA/USB Bridge',usbId:'066f:4200',supported:true });
const dataHexContainsPhoto = hex => hex.includes('5353532056313030');
export function createAdapter(device) {
  const adapter = { opened:false, configured:false, baud:null, revision:7, readerTask:null, inEndpoint:2,outEndpoint:1,
    decoder:new FrameDecoder({recoverFrames:true}),txFrames:0,rxBytes:0,switches:0,fifoRecoveries:0,readPending:false,
    async open(){this.opened=true;window.__calls.push('open');return describeUSBDevice(device);},
    assertOpen(){if(!this.opened)throw new DOMException('closed','AbortError');},
    async close(){this.opened=false;this.configured=false;window.__calls.push('close');},
    async pauseReader(){window.__calls.push('pause');},
    async setupSIR(){this.configured=true;this.baud=9600;this.index=0;this.fed=false;this.queued=[];window.__calls.push('setup');},
    async setSIRSpeed(baud){this.baud=baud;},
    async sendFrame(address,control,data){
      const tx={address,control,dataHex:toHex(data)};window.__wire.push(tx);this.txFrames++;
      if(window.__hang)return;
      const f=window.__direction==='send'?window.__sender:window.__receiver;
      const expected=window.__direction==='send'?f.groups[this.index]:f.expectedTransmissions[this.index];
      const wanted=expected?.tx??expected;
      if(JSON.stringify(tx)!==JSON.stringify(wanted))throw new Error('Unexpected frame '+this.index+': '+JSON.stringify(tx)+' wanted '+JSON.stringify(wanted));
      this.index++;
      if(window.__stopDuringPUT && dataHexContainsPhoto(tx.dataHex)){window.__hang=true;window.__midPUT=true;}
      if(window.__direction==='send')this.queued.push(...expected.reads.map(fromHex));
    }
  };
  adapter.device={async transferIn(){
    if(window.__hang)return new Promise(()=>{});
    if(!window.__allowWatch){await new Promise(r=>setTimeout(r,8));return {status:'ok',data:new DataView(new ArrayBuffer(0))};}
    let bytes;
    if(window.__direction==='send')bytes=adapter.queued.shift()??new Uint8Array();
    else {bytes=adapter.fed?new Uint8Array():fromHex(window.__receiver.usbInHex);adapter.fed=true;}
    return {status:'ok',data:new DataView(bytes.buffer,bytes.byteOffset,bytes.length)};
  }};
  window.__adapter=adapter;return adapter;
}`;
(async()=>{
  const receive=JSON.parse(await fs.readFile(repo+'/tests/receiver-hardware-fixtures.json')).sessions[0];
  const send=JSON.parse(await fs.readFile(repo+'/tests/link-recovery-hardware-fixtures.json')).sessions.find(s=>s.scenario==='bad-crc');
  await fs.mkdir(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1100}});
    page.on('pageerror',e=>errors.push(String(e)));
    await page.addInitScript(({receive,send})=>{
      window.__receiver=receive;window.__sender=send;window.__direction='receive';window.__calls=[];window.__wire=[];window.__allowWatch=false;
      window.__selectedDevice={vendorId:0x066f,productId:0x4200,productName:'IrDA/USB Bridge'};
      window.__usb=new EventTarget();window.__usb.requestDevice=async()=>window.__selectedDevice;
      Object.defineProperty(navigator,'usb',{value:window.__usb,configurable:true});
      const original=crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues=data=>{
        if(data instanceof Uint8Array&&data.length===4){const id=window.__direction==='send'?send.localID:receive.localID;data.set(id.match(/../g).map(v=>parseInt(v,16)));return data;}
        return original(data);
      };
    },{receive,send});
    await page.route('**/adapters.mjs',route=>route.fulfill({contentType:'text/javascript',body:mockModule}));
    await page.goto(appURL);
    await page.locator('[data-mode=others]').waitFor();
    assert.equal(await page.locator('[data-mode=pc]').getAttribute('aria-pressed'),'true');
    await page.locator('#tab-clock').click();
    await page.locator('[data-mode=others]').click();
    await page.waitForFunction(()=>document.querySelector('[data-mode=others]').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#tab-clock').isVisible(),false);
    assert.equal(await page.locator('#tab-holidays').isVisible(),false);
    assert.equal(await page.locator('#panel-photos').isVisible(),true);
    assert.equal(await page.locator('#download-all').isVisible(),false);
    assert.equal(await page.locator('.remote-strip').isVisible(),false);
    await page.locator('#tab-photos').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-connection').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#find-watch').isVisible(),false);
    assert.equal(await page.locator('#capabilities').isVisible(),false);
    await page.locator('#tab-photos').click();
    await page.locator('#connect').click();
    await page.waitForFunction(()=>!document.getElementById('receive-photo').disabled);
    await page.locator('#receive-photo').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    assert.equal(await page.locator('#transfer-path').innerText(),'IR → OTHERS → SEND');
    assert.match(await page.locator('#transfer-instructions').innerText(),/once.*side buttons/);
    assert.deepEqual(await page.evaluate(()=>window.__wire),[],'USB preparation has no infrared output');
    await page.locator('#transfer-cancel').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
    assert.equal(await page.locator('#receive-photo').isEnabled(),true);
    await page.locator('#receive-photo').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    await page.locator('#transfer-start').click();
    await page.waitForFunction(()=>document.getElementById('transfer-status').textContent.includes('front button'));
    assert.equal(await page.locator('[data-mode=pc]').isEnabled(),false);
    await page.evaluate(()=>window.__allowWatch=true);
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
    assert.equal(await page.locator('#result-heading').innerText(),'Photo received');
    assert.equal(await page.locator('#gallery .thumbnail').count(),1);
    assert.equal(await page.evaluate(()=>window.__adapter.index),receive.expectedTransmissions.length);
    await page.locator('[data-mode=pc]').click();
    await page.waitForFunction(()=>document.getElementById('tab-clock').hidden===false);
    assert.equal(await page.locator('#gallery .thumbnail').count(),1);
    assert.equal(await page.locator('#download-all').isVisible(),true);
    // PC session ownership and keepalive stop before entering OTHERS.
    await page.locator('#tab-connection').click();
    await page.evaluate(async()=>{
      const {WQVClient}=await import('./protocol.mjs');
      WQVClient.prototype.openPrimary=async function(){this.connected=true;this.isPrimary=true;this.model=3;window.__calls.push('PC-open');};
      WQVClient.prototype.primaryExchange=async function(){window.__calls.push('PC-keepalive');};
      WQVClient.prototype.close=async function(){this.connected=false;window.__calls.push('PC-close');};
    });
    await page.locator('#find-watch').click();
    await page.waitForFunction(()=>window.__calls.includes('PC-open')&&!document.querySelector('[data-mode=others]').disabled);
    await page.locator('[data-mode=others]').click();
    await page.waitForFunction(()=>document.getElementById('tab-clock').hidden===true);
    assert.ok(await page.evaluate(()=>window.__calls.includes('PC-close')));
    await page.locator('#tab-photos').click();
    await page.locator('#image-files').setInputFiles({name:'IR000010.UPF',mimeType:'application/octet-stream',buffer:Buffer.from(send.input.dataHex,'hex')});
    await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===2&&!document.getElementById('upload-image').disabled);
    await page.locator('#upload-name').fill(send.input.filename);
    await page.evaluate(()=>{window.__direction='send';window.__allowWatch=false;window.__wire=[];});
    await page.locator('#upload-image').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    assert.equal(await page.locator('#transfer-path').innerText(),'IR → OTHERS → RECEIVE');
    assert.deepEqual(await page.evaluate(()=>window.__wire),[]);
    await page.locator('#transfer-start').click();await page.evaluate(()=>window.__allowWatch=true);
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open,{timeout:30000});
    assert.equal(await page.locator('#result-heading').innerText(),'Photo sent');
    assert.equal(await page.evaluate(()=>window.__adapter.index),send.groups.length);
    assert.ok(+await page.locator('#retry-count').innerText()>0);
    await page.locator('.menubar details').nth(2).locator('summary').click();
    await page.locator('#menu-options').click();
    await page.locator('input[name=display-language][value=ru]').check();await page.locator('#options-accept').click();
    assert.equal(await page.locator('#receive-photo').innerText(),'↓ Принять снимок…');
    await page.screenshot({path:artifacts+'/cassiopeia-others-main.png',fullPage:true});
    // A physical unplug while waiting for the user's Start must not leave a pending modal.
    await page.locator('#receive-photo').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    await page.evaluate(()=>{const event=new Event('disconnect');event.device=window.__selectedDevice;window.__usb.dispatchEvent(event);});
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open);
    await page.locator('#connect').click();
    await page.waitForFunction(()=>!document.getElementById('receive-photo').disabled);
    await page.evaluate(()=>{window.__direction='receive';window.__allowWatch=false;window.__hang=true;});
    await page.locator('#receive-photo').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    await page.screenshot({path:artifacts+'/cassiopeia-others-dialog.png',fullPage:true});
    await page.locator('#transfer-start').click();
    await page.waitForFunction(()=>document.getElementById('transfer-start').hidden);
    await page.locator('#transfer-cancel').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open,{timeout:1500});
    // Cancelling after PUT starts keeps an unconfirmed-upload result, not a success.
    await page.locator('#connect').click();
    await page.waitForFunction(()=>!document.getElementById('receive-photo').disabled);
    await page.evaluate(()=>{window.__direction='send';window.__hang=false;window.__stopDuringPUT=true;window.__allowWatch=false;});
    await page.locator('#upload-image').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-start').disabled);
    await page.locator('#transfer-start').click();await page.evaluate(()=>window.__allowWatch=true);
    await page.waitForFunction(()=>window.__midPUT,{timeout:15000});
    await page.locator('#transfer-cancel').click();
    await page.waitForFunction(()=>!document.getElementById('transfer-dialog').open,{timeout:1500});
    assert.equal(await page.locator('#result-heading').innerText(),'Передача не подтверждена');
    await page.reload();
    await page.locator('[data-mode=others]').waitFor();
    assert.equal(await page.locator('[data-mode=others]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#receive-photo').innerText(),'↓ Принять снимок…');
    await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===2);
    await page.setViewportSize({width:360,height:1100});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:artifacts+'/cassiopeia-others-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({PCAndOTHERS:true,modePersistence:true,hiddenPCControls:true,keyboardTabs:true,sharedAlbum:true,
      exactCapturedReceive:true,exactCapturedUploadWithRecovery:true,prepareBeforeWatch:true,cancelBeforeSend:true,
      unplugBeforeStart:true,cancelPendingUSB:true,cancelledPUTUnconfirmed:true,PCSessionClosed:true,EnglishAndRussian:true,mobileOverflow:false,realUSBAccess:false,errors},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
