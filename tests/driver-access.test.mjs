import test from 'node:test';
import assert from 'node:assert/strict';
import { readDriverAccess, rememberDriverAccess, canTryUSBHelper } from '../dist/driver-access.mjs';
import { classifyDriverOpenFailure, DriverUSBError } from '../dist/driver-usb.mjs';
import { probeUSBHelper } from '../dist/usb-helper-help.mjs';

const driver = { profile:'ma620',inputSHA256:'source and headers',artifact:{builtAt:123} };
const device = {vendorId:0x0df7,productId:0x0620,serialNumber:'test-1'};
test('successful transport is scoped to the device, source, build and browser storage', () => {
 const values = new Map(), storage = {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const usb = {...device,serialNumber:'persist'};
 assert.equal(readDriverAccess(driver,usb,storage),'auto');
 rememberDriverAccess(driver,usb,'helper',storage);
 assert.equal(readDriverAccess(structuredClone(driver),{...usb},storage),'helper');
 for(const [record,other] of [[{...driver,inputSHA256:'edited'},usb],[{...driver,artifact:{builtAt:124}},usb],[driver,{...usb,serialNumber:'another'}],[driver,{...usb,productId:1}]])assert.equal(readDriverAccess(record,other,storage),'auto');
 rememberDriverAccess(driver,usb,'direct',storage);assert.equal(readDriverAccess(driver,usb,storage),'direct');
 assert.throws(()=>rememberDriverAccess(driver,usb,'auto',storage),/Unknown/);
});
test('blocked storage does not break connections or lose the working method within a page', () => {
 const storage = {getItem(){throw Error('denied')},setItem(){throw Error('denied')}};
 rememberDriverAccess(driver,device,'helper',storage);
 assert.equal(readDriverAccess(driver,device,storage),'helper');
});
test('USB initialization can try the helper after cleanup without relabeling permission, busy or cancellation', () => {
 assert.equal(canTryUSBHelper(classifyDriverOpenFailure(Error('Original network driver open: -1'),{})),true);
 assert.equal(canTryUSBHelper({code:'helper-needed'}),true);
 for(const code of ['busy','permission','cancelled','no-interfaces','short-write','transfer-failed']) {
  const reason=new DriverUSBError(code,'fixture');assert.equal(classifyDriverOpenFailure(Error('wrapped'),{lastError:reason}),reason);assert.equal(canTryUSBHelper(reason),false);
 }
 assert.equal(canTryUSBHelper(classifyDriverOpenFailure(new DOMException('Stopped','AbortError'),{})),false);
});
test('helper readiness only recognizes the expected service and never opens a USB session', async () => {
 const calls=[];
 for(const [reply,expected] of [[{helper:'WQV Link USB Helper',version:1},true],[{helper:'something else',version:1},false],[{helper:'WQV Link USB Helper',version:2},false]]) {
  assert.equal(await probeUSBHelper({fetcher:async(url,options)=>{calls.push({url,options});return Response.json(reply)}}),expected);
 }
 assert.ok(calls.every(call=>!call.options.body&&!call.options.method));
 assert.equal(await probeUSBHelper({fetcher:async()=>{throw Error('Offline')}}),false);
});

test('helper wait returns immediately for a running service without showing instructions', async () => {
 const {waitForUSBHelper}=await import('../dist/usb-helper-help.mjs');let count=0;
 await waitForUSBHelper({probe:async()=>{count++;return true},onWaiting:()=>assert.fail('running helper needs no window')});
 assert.equal(count,1);
});
test('helper wait polls sequentially and shows instructions once until ready', async () => {
 const {waitForUSBHelper}=await import('../dist/usb-helper-help.mjs');let calls=0,waiting=0,active=0;
 await waitForUSBHelper({interval:1,probe:async()=>{assert.equal(active++,0);await new Promise(resolve=>setTimeout(resolve,1));active--;return ++calls===3},onWaiting:()=>waiting++});
 assert.equal(calls,3);assert.equal(waiting,1);
});
test('cancelling helper wait during a probe discards a late successful response', async () => {
 const {waitForUSBHelper}=await import('../dist/usb-helper-help.mjs');const controller=new AbortController();let finish;
 const pending=waitForUSBHelper({signal:controller.signal,probe:()=>new Promise(resolve=>{finish=resolve}),onWaiting:()=>assert.fail('cancelled wait must not open a window')});
 controller.abort();finish(true);await assert.rejects(pending,{name:'AbortError'});
});
test('cancelling helper wait stops the polling timer', async () => {
 const {waitForUSBHelper}=await import('../dist/usb-helper-help.mjs');const controller=new AbortController();let calls=0;
 await assert.rejects(waitForUSBHelper({signal:controller.signal,interval:1,probe:async()=>{calls++;return false},onWaiting:()=>controller.abort()}),{name:'AbortError'});
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);
});
test('legacy KS-959 readiness checks its own service and port', async () => {
 let url;
 assert.equal(await probeUSBHelper({script:'kingsun_bridge.py',fetcher:async target=>{url=target;return Response.json({helper:'WQV Link / KingSun KS-959',version:1})}}),true);
 assert.equal(url,'http://127.0.0.1:8767/usb');
});
