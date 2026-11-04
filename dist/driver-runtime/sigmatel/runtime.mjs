import {LinuxKingsun,hex,unhex} from '../runtime.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class LinuxSigmaTel extends LinuxKingsun {
  constructor(backend,onEvent=()=>{},options={}) {super(backend,onEvent);this.rxSensitivity=options.rxSensitivity??1;}
  imports() {
    const suspend=fn=>new WebAssembly.Suspending(fn);
    return {...super.imports(),
      host_control:suspend((type,request,value,index,pointer,length,timeout)=>this.control({type,request,value,index,pointer,length,timeout})),
      host_bulk:suspend((pipe,pointer,length,actual,timeout)=>this.bulk({pipe,pointer,length,actual,timeout})),
      host_clear_halt:suspend(pipe=>this.usbService('clearHalt',[pipe&255])),
      host_reset_configuration:suspend(()=>this.usbService('resetConfiguration',[])),
      host_sleep:suspend(ms=>sleep(Math.max(1,ms))),
      host_schedule:suspend(()=>this.schedule()),
      host_thread_start:()=>setTimeout(()=>this.startThread(),0),
      host_thread_stop:suspend(()=>this.stopThread()),
      host_thread_should_stop:()=>Number(Boolean(this.stopRequested)),
      host_wake:()=>this.wake(),
    };
  }
  async usbService(method,args) {
    try {this.event('usb-service',{method,args});await this.backend.rpc(method,args);return 0;}
    catch(error){this.fault=String(error);this.event('usb-error',{method,message:String(error)});return -5;}
  }
  async control(request) {
    const input=Boolean(request.type&0x80);
    const bytes=input?null:this.view().slice(request.pointer,request.pointer+request.length);
    this.event('sync-control-request',{request:{...request,pointer:undefined},dataHex:bytes?hex(bytes):null});
    try {
      const result=await this.backend.control(request,bytes);
      const data=result.bytes||new Uint8Array();
      const count=input?data.length:result.written;
      if(!Number.isInteger(count)||count<0||count>request.length)throw new Error('Invalid synchronous control length');
      if(input)this.view().set(data,request.pointer);
      this.event('sync-control-complete',{status:0,length:count,dataHex:input?hex(data):null});
      return count;
    }catch(error){this.fault=String(error);this.event('usb-error',{message:String(error)});return -5;}
  }
  async bulk(request) {
    const bytes=this.view().slice(request.pointer,request.pointer+request.length);
    this.event('sync-bulk-request',{request:{...request,pointer:undefined,actual:undefined},dataHex:hex(bytes)});
    try {
      const result=await this.backend.control({bulk:true,type:0,index:request.pipe&15,length:request.length,timeout:request.timeout},bytes);
      if(request.actual)new DataView(this.exports.memory.buffer).setInt32(request.actual,result.written,true);
      if(result.written!==bytes.length)throw new Error('Short synchronous bulk output');
      this.event('sync-bulk-complete',{status:0,length:result.written});return 0;
    }catch(error){this.fault=String(error);this.event('usb-error',{message:String(error)});return -5;}
  }
  request(pointer) {
    const e=this.exports,pipe=e.lab_urb_info(pointer,5);
    if(!(pipe&0x100))return super.request(pointer);
    return {bulk:true,type:pipe&0x80,index:pipe&15,length:e.lab_urb_info(pointer,2),
      capacity:e.lab_urb_info(pointer,2),dataPointer:e.lab_urb_info(pointer,1)};
  }
  wake() {
    this.threadIdle=false;
    if(this.wakeResolver){const resolve=this.wakeResolver;this.wakeResolver=null;resolve();}
    else this.wakePending=true;
  }
  async schedule() {
    this.threadIdle=true;
    if(this.stopRequested||this.wakePending){this.wakePending=false;this.threadIdle=false;return;}
    await new Promise(resolve=>{this.wakeResolver=resolve;});this.threadIdle=false;
  }
  startThread() {
    if(this.threadPromise||this.stopRequested)return;
    this.event('kernel-thread-started');
    this.threadPromise=WebAssembly.promising(this.exports.lab_thread)().then(result=>{
      this.event('kernel-thread-stopped',{result,requested:Boolean(this.stopRequested)});
      if(!this.stopRequested)this.fault=this.fault||'Original transmit thread exited unexpectedly';
    }).catch(error=>{this.fault=String(error);this.event('runtime-error',{message:String(error)});});
  }
  async stopThread() {
    this.stopRequested=true;this.wake();
    if(this.threadPromise)await this.threadPromise;
  }
  async open() {
    this.closing=false;this.stopRequested=false;this.fault=null;this.threadPromise=null;
    this.threadIdle=false;this.wakePending=false;this.wakeResolver=null;
    await this.backend.open();
    try {
      if(this.exports.lab_parameters(this.rxSensitivity)<0)throw new Error('Invalid SigmaTel module parameter');
      this.event('module-parameters',{rxSensitivity:this.rxSensitivity});
      const result=await WebAssembly.promising(this.exports.lab_open)();
      if(result<0)throw new Error('Original SigmaTel open: '+result);
      this.opened=true;
      await this.waitFor(()=>this.threadIdle&&this.exports.lab_state(3)===1);
      this.event('driver-opened',{baud:this.exports.lab_state(6)});
    }catch(error){await this.close();throw error;}
  }
  async speed(baud) {
    const result=this.exports.lab_speed(baud);
    if(result<0)throw new Error('Original SigmaTel speed: '+result);
    await this.waitFor(()=>this.threadIdle&&this.exports.lab_state(6)===baud);
    this.event('speed-set',{baud});
  }
  async send(bytes) {
    const before=this.exports.lab_state(4),errors=this.exports.lab_state(5);
    await super.send(bytes);
    await this.waitFor(()=>this.threadIdle&&this.exports.lab_state(3)===1&&this.exports.lab_state(4)>before,8000);
    if(this.exports.lab_state(5)!==errors)throw new Error('Original SigmaTel driver reports a TX error');
  }
  async close() {
    this.closing=true;await this.stopThread();
    await super.close();this.threadPromise=null;
  }
}

export class SigmaHelperBackend {
  constructor(url='http://127.0.0.1:8783/usb') {this.url=url;this.session=null;}
  async rpc(method,args=[]) {
    const response=await fetch(this.url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({method,args,session:this.session}),signal:AbortSignal.timeout(3500),cache:'no-store',credentials:'omit'});
    const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'Helper HTTP '+response.status);
    return data.result;
  }
  async open(){const info=await this.rpc('open');this.session=info.session;}
  async close(){if(this.session){try{await this.rpc('close');}finally{this.session=null;}}}
  async control(request,bytes) {
    if(request.bulk){
      const r=await this.rpc(bytes?'bulkOut':'bulkIn',[request.index,bytes?{hex:hex(bytes)}:request.length]);
      return bytes?{written:r.bytesWritten}:{bytes:unhex(r.hex)};
    }
    const r=await this.rpc('control',[{type:request.type,request:request.request,value:request.value,index:request.index},request.length]);
    return (request.type&0x80)?{bytes:unhex(r.hex)}:{written:r.bytesWritten};
  }
}
