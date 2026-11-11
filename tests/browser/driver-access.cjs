const { chromium } = require(process.env.WQV_PLAYWRIGHT || 'playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WQV_APP_URL || 'http://127.0.0.1:8765/';

function usbModel() {
 const alternate = {alternateSetting:0,interfaceClass:255,interfaceSubclass:0,interfaceProtocol:0,endpoints:[
  {endpointNumber:1,direction:'in',type:'interrupt',packetSize:10},{endpointNumber:2,direction:'out',type:'bulk',packetSize:64},{endpointNumber:3,direction:'in',type:'bulk',packetSize:64}]};
 window.__usb = {vendorId:0x0df7,productId:0x0620,productName:'USB-Serial Controller',serialNumber:'access-fixture',opened:false,
  configurations:[{configurationValue:1,interfaces:[{interfaceNumber:0,alternate,alternates:[alternate]}]}],
  async open(){this.opened=true;window.__directOpens=(window.__directOpens||0)+1;this.configuration=this.configurations[0]},
  async close(){this.opened=false},async claimInterface(){},async releaseInterface(){},async selectAlternateInterface(){},
  async controlTransferOut(setup,bytes){return {status:'ok',bytesWritten:bytes.length}}
 };
 const usb=new EventTarget();usb.requestDevice=async()=>window.__usb;Object.defineProperty(navigator,'usb',{value:usb});
 window.__helper={held:false,opens:0,pings:0,online:true};
 const fetchOriginal=window.fetch.bind(window);
 window.fetch=async(url,options={})=>{
  if(!String(url).startsWith('http://127.0.0.1:8768/'))return fetchOriginal(url,options);
  if(!options.method){window.__helper.pings++;if(!window.__helper.online)throw Error('Offline');return Response.json({helper:'WQV Link USB Helper',version:1})}
  const body=JSON.parse(options.body), state=window.__helper;
  if(!state.online)throw Error('Offline');
  if(body.method==='open'){state.opens++;state.held=true;return Response.json({result:{session:'fixture',vendorId:0x0df7,productId:0x0620,configuration:{configurationValue:1},interfaceNumber:0,alternate}})}
  if(body.method==='close'){state.held=false;return Response.json({result:{}})}
  if(body.method==='transfer')return Response.json({result:{written:body.args[1].length/2}});
  throw Error('Unexpected helper operation');
 };
}
const clientFixture = `export class DriverWorkerClient {
 constructor(backend,options={}){this.backend=backend;this.event=options.event||(()=>{});}
 async load(){this.event({kind:'module-loaded'});}
 async open(){const result=await this.backend.open();await this.backend.control({type:0x40,request:1,value:0,index:0,length:0},new Uint8Array());
  if(this.backend.transport==='direct'&&window.__delayDirect)await new Promise(resolve=>{window.__resumeDirect=resolve});
  if(this.backend.transport==='direct'&&!window.__directWorks)throw Error('Original network driver open: -1');
  return result.description;}
 async speed(){} async close(){await this.backend.close();if(window.__cleanupFail&&this.backend.transport==='direct')throw Error('Cleanup failed');}
 async abort(){await this.close();} async send(){throw Error('USB initialization must not send a watch frame');}
}`;
async function setup(t) {
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.addInitScript(usbModel);
 await page.route('**/driver-worker-client.mjs',route=>route.fulfill({contentType:'text/javascript',body:clientFixture}));
 await page.goto(new URL('drivers.html',base).href);
 await page.evaluate(async()=>{
  const {driverStore}=await import('./driver-store.mjs'),{referenceDriver,compileDriver}=await import('./driver-compiler.mjs');
  const record=await driverStore.saveSource(await referenceDriver('ma620'));await driverStore.saveBuild(record.id,record.sha256,await compileDriver(record));
 });
 await page.reload();await page.locator('[data-build="built"]').waitFor();return page;
}

test('automatic check discovers helper after a C initialization failure and watch applications reuse it after reload', {timeout:30000},async t=>{
 const page=await setup(t);await page.locator('#tab-check').click();await page.locator('[data-driver-action="choose"]').click();
 await page.locator('#check-run').click();await page.waitForFunction(()=>document.getElementById('check-helper-result').dataset.state==='passed');
 assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'),'failed');
 assert.match(await page.locator('#remembered-access').textContent(),/USB Helper/);
 assert.equal(await page.evaluate(()=>window.__usb.opened||window.__helper.held),false);
 const choice=await page.evaluate(()=>JSON.parse(Object.entries(localStorage).find(([key])=>key.startsWith('wqv-online.driver-access.'))[0].slice('wqv-online.driver-access.'.length)));
 assert.ok(choice.includes('ma620'));
 for(const app of ['wqv2.html','wqv3.html']){
  await page.goto(new URL(app,base).href);await page.locator('#connect').click();
  await page.waitForFunction(()=>document.getElementById('connection-badge').textContent==='USB connected');
  assert.equal(await page.evaluate(()=>window.__directOpens||0),0,'remembered helper must bypass the failing direct path');
  assert.equal(await page.evaluate(()=>window.__helper.held),true);
  await page.locator('#disconnect').click();await page.waitForFunction(()=>!window.__helper.held);
 }
 await page.goto(new URL('drivers.html',base).href);await page.locator('#tab-check').click();await page.locator('[data-driver-action="choose"]').click();
 await page.locator('#check-run').click();await page.waitForFunction(()=>document.getElementById('check-helper-result').dataset.state==='passed');
 assert.equal(await page.locator('#check-direct-result').getAttribute('data-state'),'untested');
 await page.evaluate(()=>{window.__directWorks=true});await page.locator('#check-method').selectOption('direct');await page.locator('#check-run').click();
 await page.waitForFunction(()=>document.getElementById('check-direct-result').dataset.state==='passed');
 assert.match(await page.locator('#remembered-access').textContent(),/WebUSB/);
});

test('failed cleanup blocks helper fallback and never stores a successful access method', {timeout:15000},async t=>{
 const page=await setup(t);await page.evaluate(()=>{window.__cleanupFail=true});
 await page.locator('#tab-check').click();await page.locator('[data-driver-action="choose"]').click();await page.locator('#check-run').click();
 await page.waitForFunction(()=>!document.getElementById('check-run').disabled);
 assert.equal(await page.evaluate(()=>window.__helper.opens),0);
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('wqv-online.driver-access.'))),false);
 assert.equal(await page.locator('#check-helper-result').getAttribute('data-state'),'untested');
});

test('closing an adapter during initialization cannot reopen it through the helper afterwards', {timeout:15000},async t=>{
 const page=await setup(t);
 const result=await page.evaluate(async()=>{
  const {driverStore}=await import('./driver-store.mjs'),{chooseInstalledDriver}=await import('./driver-catalog.mjs');
  const {InstalledDriverAdapter}=await import('./installed-adapter.mjs');
  const adapter=new InstalledDriverAdapter(window.__usb,chooseInstalledDriver(await driverStore.list(),window.__usb));
  window.__delayDirect=true;const pending=adapter.open().catch(error=>error.message);
  while(!window.__resumeDirect)await new Promise(resolve=>setTimeout(resolve,1));
  await adapter.close();window.__resumeDirect();await pending;
  return {helperOpens:window.__helper.opens,opened:adapter.opened,remembered:Object.keys(localStorage).some(key=>key.startsWith('wqv-online.driver-access.'))};
 });
 assert.deepEqual(result,{helperOpens:0,opened:false,remembered:false});
});

test('helper instructions are available before checking, detect an existing process, and provide download and portable startup steps', {timeout:30000},async t=>{
 const page=await setup(t);await page.locator('#tab-check').click();await page.locator('#check-method').selectOption('helper');
 assert.equal(await page.locator('#helper-instructions').isVisible(),true);
 await page.locator('#helper-instructions [data-usb-helper-help]').click();
 await page.waitForFunction(()=>document.querySelector('[data-helper-state]').dataset.state==='running');
 assert.equal(await page.locator('[data-helper-steps]').getAttribute('open'),null);
 assert.equal(await page.evaluate(()=>window.__helper.opens),0,'readiness only pings the helper');
 await page.evaluate(()=>{window.__helper.online=false});await page.locator('[data-helper-probe]').click();
 await page.waitForFunction(()=>document.querySelector('[data-helper-state]').dataset.state==='unavailable');
 assert.equal(await page.locator('[data-helper-steps]').evaluate(node=>node.open),true);
 assert.equal(await page.locator('[data-helper-command]').textContent(),'python3 irda_usb_helper.py');
 assert.equal(await page.locator('[data-helper-download]').getAttribute('download'),'irda_usb_helper.py');
 const downloading=page.waitForEvent('download');await page.locator('[data-helper-download]').click();
 const downloaded=await downloading;assert.equal(downloaded.suggestedFilename(),'irda_usb_helper.py');
 assert.equal(await fs.readFile(await downloaded.path(),'utf8'),await fs.readFile(path.join(__dirname,'../../dist/irda_usb_helper.py'),'utf8'));
 for(const language of ['ru','ja','de','es','fi','en']){
  await page.evaluate(async lang=>(await import('./i18n.mjs')).setLanguage(lang),language);
  for(const width of [420,1280]){
   await page.setViewportSize({width,height:950});
   await page.waitForFunction(()=>{const r=document.getElementById('usb-helper-dialog').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight});
   const rect=await page.locator('#usb-helper-dialog').boundingBox();
   assert.ok(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=950,JSON.stringify({language,width,rect}));
  }
 }
 if(process.env.WQV_BROWSER_ARTIFACTS){await fs.mkdir(process.env.WQV_BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.WQV_BROWSER_ARTIFACTS,'helper-dialog.png'),fullPage:true})}
 await page.locator('[data-helper-close]').last().click();
 for(const app of ['wqv2.html','wqv3.html']){await page.goto(new URL(app,base).href);await page.locator('#tab-connection').click();await page.locator('#panel-connection [data-usb-helper-help]').click();await page.locator('#usb-helper-dialog').waitFor({state:'visible'});await page.locator('[data-helper-close]').last().click()}
});
