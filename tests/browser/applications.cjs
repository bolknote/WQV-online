// Uses generated photos and fake USB devices; never opens a real adapter.
const {chromium}=require(process.env.WQV_PLAYWRIGHT || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=new URL('./',process.env.WQV_APP_URL || 'http://127.0.0.1:8765/').href;
const output=process.env.WQV_BROWSER_ARTIFACTS || path.join(require('node:os').tmpdir(),'wqv-applications-browser');

function syntheticRecord(number=0) {
  const bytes=new Uint8Array(7229);bytes.fill(32,0,24);
  bytes.set(new TextEncoder().encode('Sample '+(number+1)),0);bytes.set([26,10,30,1,number],24);
  for(let i=29;i<bytes.length;i++)bytes[i]=((i+number)&15)|(((i+number+5)&15)<<4);
  return bytes;
}

function mockUSB(kind) {
  const records=[0,1,2].map(number=>{
    const bytes=new Uint8Array(7229);bytes.fill(32,0,24);
    bytes.set(new TextEncoder().encode('Sample '+(number+1)),0);bytes.set([26,10,30,1,number],24);
    for(let i=29;i<bytes.length;i++)bytes[i]=((i+number)&15)|(((i+number+5)&15)<<4);
    return bytes;
  });
  const concat=(...parts)=>Uint8Array.from(parts.flatMap(p=>[...p]));
  function encode(address,control,data=new Uint8Array()) {
    const body=[address,control,...data];const sum=body.reduce((a,b)=>(a+b)&65535,0);body.push(sum>>8,sum&255);
    const out=[192];for(const v of body)if([192,193,125].includes(v))out.push(125,v^32);else out.push(v);
    out.push(193);return Uint8Array.from(out);
  }
  function decode(wire) {
    const body=[];let escaped=false;
    for(const v of wire.slice(1,-1)){if(escaped){body.push(v^32);escaped=false;}else if(v===125)escaped=true;else body.push(v);}
    const check=body.slice(0,-2).reduce((a,b)=>(a+b)&65535,0);
    if(check!==((body.at(-2)<<8)|body.at(-1)))throw Error('Outgoing SUM16 mismatch');
    return {address:body[0],control:body[1],data:Uint8Array.from(body.slice(2,-2))};
  }
  const state={kind,records,tx:[],registerWrites:[],closed:0,queue:[],stage:'idle',phase:137,index:0,dump:null,mode:'pc',lastHost:null,lastReply:null};
  const reply=(address,control,data)=>{const wire=encode(address,control,data);state.queue.push(wire);state.lastReply=wire;};
  function nextOther() {
    if(state.index*128>=records[2].length){state.stage='other-finish';reply(96,49);return;}
    reply(96,[50,52,54,56,58,60,62,48][state.index%8],concat([5],records[2].slice(state.index*128,(state.index+1)*128)));
  }
  function respond(wire) {
    const f=decode(wire),{address,control,data}=f;state.tx.push({address,control,data:[...data]});
    if(state.mode==='others'){
      const key=JSON.stringify([address,control,[...data]]);
      if(key===state.lastHost && state.lastReply){state.queue.push(state.lastReply);return;}
      state.lastHost=key;
      if(state.stage==='other-hello'){
        if(address!==255||control!==163)throw Error('OTHERS must answer A3, not start discovery');
        state.stage='other-connect';reply(255,147,concat(data,[96]));return;
      }
      if(state.stage==='other-connect'){if(control!==99)throw Error('expected 63');state.stage='other-ready';reply(96,17);return;}
      if(state.stage==='other-ready'){if(control!==1)throw Error('expected 01');state.stage='other-header';reply(96,16,Uint8Array.from([4,250,28,61]));return;}
      if(state.stage==='other-header'){if(control!==33)throw Error('expected 21');state.stage='other-poll';reply(96,17);return;}
      if(state.stage==='other-poll'){if(control!==32)throw Error('expected 20');state.stage='other-photos';state.index=0;nextOther();return;}
      if(state.stage==='other-photos'){
        if(control!==[65,97,129,161,193,225,1,33][state.index%8])throw Error('wrong image acknowledgement');
        state.index++;nextOther();return;
      }
      if(state.stage==='other-finish'){if(control!==66)throw Error('expected 42');state.stage='other-close';reply(96,83);return;}
      if(state.stage==='other-close'){if(control!==99)throw Error('expected final 63');state.stage='closed';return;}
      throw Error('Unexpected OTHERS stage '+state.stage);
    }
    if(address===255&&control===179){reply(255,163,Uint8Array.from([13,20,30,40]));state.stage='hello';return;}
    if(address===255&&control===147){reply(2,99);state.stage='connect';return;}
    if(control===83){reply(2,99);state.stage='closed';return;}
    if(state.stage==='connect'&&control===17){reply(2,1);state.stage='connected';return;}
    if(control===16){state.dump=data[0]===0?records[0]:concat(records[0],records[1]);state.count=data[0]===0?1:2;reply(2,33);state.stage='header';return;}
    if(state.stage==='header'&&control===17){reply(2,32,Uint8Array.from([7,250,28,61,state.count]));return;}
    if(state.stage==='header'&&control===50){state.stage='photos';state.index=0;reply(2,65);return;}
    if(state.stage==='photos'&&(control&31)===17){reply(2,64|(((state.index+1)&7)<<1),concat([5],state.dump.slice(state.index*128,(state.index+1)*128)));state.index++;return;}
    if((control&31)===20){reply(2,65);state.stage='finish';return;}
    throw Error('Unexpected PC request '+control+' at '+state.stage);
  }
  const regs=Uint8Array.from([42,119,0,39,196,0,0,21,0]);
  const device={vendorId:kind==='kingsun'?0x07d0:0x066f,productId:kind==='kingsun'?0x4959:0x4200,
    productName:kind==='kingsun'?'QA KingSun IrDA':'QA SigmaTel IrDA',opened:false,
    configuration:{configurationValue:1,interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,interfaceClass:255,endpoints:[{direction:'in',type:'bulk',endpointNumber:2,packetSize:64},{direction:'out',type:'bulk',endpointNumber:1,packetSize:64}]}]}]},
    async open(){this.opened=true;},async claimInterface(){},async selectConfiguration(){},async clearHalt(){},
    async close(){if(this.opened){this.opened=false;state.closed++;await window.recordMockClose?.();}},
    async controlTransferOut(setup){state.registerWrites.push([setup.index,setup.value]);regs[setup.index-1]=setup.value|(setup.index===4?7:0);return{status:'ok',bytesWritten:0};},
    async controlTransferIn(setup,n){return{status:'ok',data:new DataView(regs.slice(setup.index-1,setup.index-1+n).buffer)};},
    async transferOut(endpoint,packet){const data=new Uint8Array(packet.buffer,packet.byteOffset,packet.byteLength);respond(data.slice(4));return{status:'ok',bytesWritten:data.length};},
    async transferIn(){
      if(!this.opened)throw new DOMException('USB closed','AbortError');
      if(!state.queue.length){await new Promise(resolve=>setTimeout(resolve,2));return{status:'ok',data:new DataView(new ArrayBuffer(0))};}
      const head=state.queue.shift(),data=head.slice(0,64);if(head.length>64)state.queue.unshift(head.slice(64));
      return{status:'ok',data:new DataView(data.buffer)};
    },
  };
  state.startPC=()=>{state.mode='pc';state.queue=[];state.stage='idle';state.lastHost=null;};
  state.startOthers=()=>{state.mode='others';state.queue=[];state.stage='other-hello';state.index=0;state.lastHost=null;state.lastReply=null;reply(255,179);if(kind==='kingsun')reply(255,179);};
  window.__mock=state;
  Object.defineProperty(navigator,'usb',{configurable:true,value:{requestDevice:async()=>device,addEventListener(){}}});
  if(kind==='kingsun'){
    const realFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(!String(url).startsWith('http://127.0.0.1:8767/'))return realFetch(url,options);
      const request=JSON.parse(options.body);let result;
      if(request.method==='open'){device.opened=true;result={vendorId:0x07d0,productId:0x4959,session:'mock-only'};}
      else if(request.method==='close'){await device.close();result={};}
      else if(request.method==='controlTransferOut'){
        const[setup,payload]=request.args;const data=Uint8Array.from(payload.hex.match(/../g)||[],s=>parseInt(s,16));
        if(setup.index===0){const key=new TextEncoder().encode('wangshuofei19710');const mask=key[(setup.value&15)^6]^85;respond(Uint8Array.from(data.slice(0,setup.value),b=>b^mask));}
        else if(setup.index!==1||setup.value!==512||data.length!==8)throw Error('Unexpected helper command');
        result={status:'ok',bytesWritten:data.length};
      }else if(request.method==='controlTransferIn'){
        if(!state.queue.length)await new Promise(resolve=>setTimeout(resolve,2));
        const clear=state.queue.shift()||new Uint8Array();const raw=[];
        for(const b of clear){if(state.phase===255){raw.push(149^85);state.phase=0;}state.phase++;raw.push(b^state.phase^85);}
        result={status:'ok',hex:raw.map(n=>n.toString(16).padStart(2,'0')).join('')};
      }else throw Error('Unexpected helper RPC '+request.method);
      return new Response(JSON.stringify({result}),{headers:{'content-type':'application/json'}});
    };
  }
}

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true});const errors=[],checks=[];
  try{
    const context=await browser.newContext({viewport:{width:1366,height:1000},acceptDownloads:true});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base,{waitUntil:'networkidle'});assert.equal(await page.locator('.program-icon').count(),2);
    await page.locator('.program-icon[href="./wqv2.html"]').click();await page.waitForLoadState('networkidle');
    await page.locator('#image-files').setInputFiles({name:'sample.bin',mimeType:'application/octet-stream',buffer:Buffer.from(syntheticRecord())});
    await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===1);
    assert.equal(await page.locator('#preview').evaluate(e=>e.naturalWidth),120);
    const pngDownload=page.waitForEvent('download');await page.locator('#save-image').click();
    const png=await pngDownload;const pngBytes=await fs.readFile(await png.path());assert.equal(pngBytes.readUInt32BE(16),120);
    await page.locator('#export-format').selectOption('bin');const binDownload=page.waitForEvent('download');await page.locator('#save-image').click();
    const bin=await binDownload;assert.deepEqual(await fs.readFile(await bin.path()),Buffer.from(syntheticRecord()));
    await page.locator('.window-close').click();await page.waitForURL(base);
    await page.locator('.program-icon[href="./wqv3.html"]').click();await page.waitForLoadState('networkidle');assert.equal(await page.locator('#gallery .thumbnail').count(),0);
    await page.locator('.window-close').click();await page.waitForURL(base);
    await page.locator('.program-icon[href="./wqv2.html"]').click();await page.waitForLoadState('networkidle');assert.equal(await page.locator('#gallery .thumbnail').count(),1);
    await page.locator('#start-menu-button').click();await page.locator('#start-options').click();await page.locator('input[value="ru"]').check();await page.locator('#options-accept').click();
    assert.equal((await page.locator('#tab-photos').textContent()).trim(),'Снимки');
    await page.locator('[data-mode="others"]').click();assert.equal(await page.locator('#download-current').isVisible(),false);assert.equal(await page.locator('#receive-photo').isVisible(),true);
    await page.screenshot({path:output+'/wqv2-ru.png',fullPage:true});
    await page.locator('.window-close').click();await page.waitForURL(base);assert.match(await page.title(),/Программы/);
    await page.screenshot({path:output+'/programs-ru.png',fullPage:true});
    await page.locator('.program-icon[href="./wqv2.html"]').click();await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('[data-mode="others"]').getAttribute('aria-pressed'),'true');
    await page.locator('#delete-local-image').click();await page.locator('#dialog-accept').click();await page.waitForFunction(()=>!document.querySelector('#gallery .thumbnail'));
    await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('#gallery .thumbnail').count(),0);
    checks.push('launcher, separate albums, BIN import/export, PNG export, persistence, delete, shared Russian language, PC/OTHERS controls');
    const mobile=await context.newPage();await mobile.setViewportSize({width:390,height:844});
    mobile.on('pageerror',e=>errors.push(e.message));await mobile.goto(base,{waitUntil:'networkidle'});
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mobile.screenshot({path:output+'/programs-mobile.png',fullPage:true});
    await mobile.locator('.program-icon[href="./wqv2.html"]').click();await mobile.waitForLoadState('networkidle');
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mobile.screenshot({path:output+'/wqv2-mobile.png',fullPage:true});
    await context.close();

    for(const kind of ['sigmatel','kingsun']){
      const context=await browser.newContext({viewport:{width:1366,height:1000}});let closed=0;
      await context.exposeFunction('recordMockClose',()=>{closed++;});await context.addInitScript(mockUSB,kind);
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base+'wqv2.html',{waitUntil:'networkidle'});await page.locator('#connect').click();await page.waitForFunction(()=>!document.querySelector('#download-all').disabled);
      if(kind==='sigmatel'){
        await page.locator('#download-all').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);
        assert.equal(await page.evaluate(()=>window.__mock.tx.length),0);
        assert.equal(await page.evaluate(()=>window.__mock.registerWrites.some(([r,v])=>r===4&&v===192)),true);
        await page.locator('#transfer-start').click();await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===2&&!document.querySelector('#transfer-dialog').open);
      }
      await page.locator('[data-mode="others"]').click();const before=await page.evaluate(()=>window.__mock.tx.length);
      await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);
      assert.equal(await page.evaluate(()=>window.__mock.tx.length),before);
      await page.locator('#transfer-start').click();await page.waitForTimeout(60);assert.equal(await page.evaluate(()=>window.__mock.tx.length),before);
      await page.evaluate(()=>window.__mock.startOthers());
      const wanted=kind==='sigmatel'?3:1;await page.waitForFunction(n=>document.querySelectorAll('#gallery .thumbnail').length===n&&!document.querySelector('#transfer-dialog').open,wanted);
      if(kind==='kingsun'){
        await page.locator('[data-mode="pc"]').click();await page.evaluate(()=>window.__mock.startPC());
        await page.locator('#download-all').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);await page.locator('#transfer-start').click();
        await page.waitForFunction(()=>document.querySelectorAll('#gallery .thumbnail').length===3&&!document.querySelector('#transfer-dialog').open);
      }
      assert.match(await page.locator('#result-heading').textContent(),/Received:/);
      await page.screenshot({path:output+'/wqv2-'+kind+'-simulated.png',fullPage:true});
      await page.locator('[data-mode="others"]').click();await page.locator('#receive-photo').click();await page.waitForFunction(()=>!document.querySelector('#transfer-start').disabled);await page.locator('#transfer-start').click();
      await page.locator('#transfer-cancel').click();await page.waitForFunction(()=>!document.querySelector('#transfer-dialog').open);
      assert.equal(await page.locator('#gallery .thumbnail').count(),3);assert.equal(closed,1);
      await page.locator('#connect').click();await page.waitForFunction(()=>!document.querySelector('#disconnect').disabled);
      await page.locator('.window-close').click();await page.waitForURL(base);assert.equal(closed,2);
      checks.push(kind+': simulated PC and OTHERS wire exchanges, no transmission before Start/SEND, stop preserves photos, navigation releases USB');
      await context.close();
    }
    assert.deepEqual(errors,[]);await fs.writeFile(output+'/ui-report.json',JSON.stringify({status:'passed',checks,errors,hardwareUSBUsed:false},null,2));
    console.log(JSON.stringify({status:'passed',checks,errors,hardwareUSBUsed:false},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
