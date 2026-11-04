import {WASI, File, OpenFile, ConsoleStdout} from './vendor/wasi/package/dist/index.js';
export const hex = bytes => Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
export const unhex = text => Uint8Array.from(text.match(/../g) || [],x=>parseInt(x,16));
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
// URB completions need a later task, without the browser's nested-timer floor.
const defer = (()=>{
  if(typeof window==='undefined')return fn=>setTimeout(fn,0);
  const channel=new MessageChannel(),queue=[];
  channel.port1.onmessage=()=>queue.shift()?.();
  return fn=>{queue.push(fn);channel.port2.postMessage(null);};
})();

export class LinuxKingsun {
  constructor(backend,onEvent=()=>{}) {
    this.backend=backend;this.onEvent=onEvent;this.pending=new Map();this.events=[];
    this.raw=[];this.closing=false;this.opened=false;this.fault=null;this.sequence=0;
  }
  event(kind,fields={}) {
    const entry={seq:++this.sequence,at:new Date().toISOString(),kind,...fields};
    this.events.push(entry);this.onEvent(entry);
  }
  async load(bytes) {
    if(typeof WebAssembly.Suspending!=='function')throw new Error('This browser has no WebAssembly JSPI support.');
    this.module=await WebAssembly.compile(bytes);
    const wasi=new WASI([],[],[new OpenFile(new File([])),
      ConsoleStdout.lineBuffered(message=>this.event('stdout',{message})),
      ConsoleStdout.lineBuffered(message=>this.event('stderr',{message}))]);
    const env=this.imports();
    const instance=await WebAssembly.instantiate(this.module,{env,wasi_snapshot_preview1:wasi.wasiImport});
    wasi.initialize(instance);this.exports=instance.exports;
    this.event('module-loaded',{bytes:bytes.length,imports:WebAssembly.Module.imports(this.module)});
  }
  imports() {
    return {
      host_submit:(pointer,generation)=>this.submit(pointer,generation),
      host_cancel:new WebAssembly.Suspending((pointer,generation)=>this.cancel(pointer,generation)),
      host_raw_byte:value=>this.raw.push(value),
      host_milliseconds:()=>Math.floor(performance.now()),
      host_panic:code=>{throw new Error('Linux compatibility invariant '+code);},
    };
  }
  view() { return new Uint8Array(this.exports.memory.buffer); }
  request(pointer) {
    const e=this.exports, setup=e.lab_urb_info(pointer,0);
    const d=new DataView(e.memory.buffer);
    return {type:d.getUint8(setup),request:d.getUint8(setup+1),value:d.getUint16(setup+2,true),
      index:d.getUint16(setup+4,true),length:d.getUint16(setup+6,true),
      dataPointer:e.lab_urb_info(pointer,1),capacity:e.lab_urb_info(pointer,2)};
  }
  submit(pointer,generation) {
    if(this.closing)return -19;
    const request=this.request(pointer), input=Boolean(request.type&0x80);
    const bytes=input?null:this.view().slice(request.dataPointer,request.dataPointer+request.length);
    const kind=input?'rx':request.index===1?'speed':'tx';
    const task={pointer,generation,request,kind,bytes,cancelled:false,finished:false};
    task.key=pointer+':'+generation;
    this.pending.set(task.key,task);
    // A macrotask preserves usb_submit_urb's immediate-return contract.
    task.settled=new Promise(resolve=>{task.resolve=resolve;});
    defer(()=>this.perform(task));
    return 0;
  }
  async perform(task) {
    const {pointer,generation,request,bytes}=task;
    let status=0,count=0,reply=new Uint8Array();
    try {
      if(task.cancelled){status=-2;}
      else {
        this.event('usb-request',{urb:pointer,generation,request:{...request,dataPointer:undefined},
          dataHex:bytes?hex(bytes):null});
        const result=await this.backend.control(request,bytes);
        if(result.rxCounter!==undefined&&this.exports.lab_rx_counter)this.exports.lab_rx_counter(result.rxCounter);
        task.usbDurationMs=result.usbDurationMs;
        if(result.linuxStatus!==undefined)status=result.linuxStatus;
        reply=result.bytes || new Uint8Array();
        count=bytes?result.written:reply.length;
        if(!Number.isInteger(count)||count<0||count>request.capacity)throw new Error('Invalid USB transfer length');
        if(!bytes&&count>request.length)throw new Error('Oversized USB input');
      }
    } catch(error) {
      status=error.linuxStatus || -5;
      if(!task.cancelled){this.fault=String(error);this.event('usb-error',{message:String(error),status});}
    }
    if(task.cancelled)status=-2;
    try {
      this.event('usb-complete',{urb:pointer,generation,status,length:count,
        dataHex:bytes?null:hex(reply),cancelled:task.cancelled,usbDurationMs:task.usbDurationMs});
      if(this.exports.lab_urb_info(pointer,3)&&this.exports.lab_urb_info(pointer,4)===generation) {
        if(!bytes&&status===0)this.view().set(reply,request.dataPointer);
        const result=this.exports.lab_complete(pointer,generation,status,status===0?count:0);
        if(result<0)throw new Error('C completion rejected: '+result);
      }
    } catch(error) { this.fault=String(error);this.event('runtime-error',{message:String(error)}); }
    finally {task.finished=true;this.pending.delete(task.key);task.resolve();}
  }
  async cancel(pointer,generation) {
    const task=this.pending.get(pointer+':'+generation);
    if(!task)return;
    task.cancelled=true;
    if(this.backend.cancel)await this.backend.cancel(task.request);
    await task.settled;
  }
  async open() {
    this.closing=false;this.fault=null;
    await this.backend.open();
    try {
      const result=this.exports.lab_open();
      if(result<0)throw new Error('Original driver open: '+result);
      this.opened=true;await this.flushWrites();this.event('driver-opened',{baud:this.exports.lab_state(6)});
    } catch(error) { await this.close();throw error; }
  }
  async waitFor(predicate,timeout=4000) {
    const deadline=performance.now()+timeout;
    while(!predicate()) {
      if(this.fault)throw new Error(this.fault);
      if(performance.now()>deadline)throw new Error('Driver operation timed out');
      await delay(2);
    }
    if(this.fault)throw new Error(this.fault);
  }
  flushWrites() {return this.waitFor(()=>![...this.pending.values()].some(task=>task.kind!=='rx'));}
  async speed(baud) {
    await this.flushWrites();
    const result=this.exports.lab_speed(baud);
    if(result<0)throw new Error('Original driver speed: '+result);
    await this.flushWrites();this.event('speed-set',{baud});
  }
  async send(bytes) {
    if(!this.opened||this.closing)throw new Error('Driver closed');
    if(!bytes.length||bytes.length>2048)throw new Error('Original Linux driver buffer limit: 2048 framed bytes');
    await this.flushWrites();
    const pointer=this.exports.lab_alloc(bytes.length);
    if(!pointer)throw new Error('Driver allocation failed');
    try {
      this.view().set(bytes,pointer);
      const result=this.exports.lab_send(pointer,bytes.length);
      if(result<0)throw new Error('Original driver send: '+result);
    } finally {this.exports.lab_free(pointer);}
    await this.waitFor(()=>this.exports.lab_state(1)===1&&this.exports.lab_state(2)===0);
    await this.flushWrites();
  }
  async close() {
    this.closing=true;
    if(this.exports?.lab_state(0))await WebAssembly.promising(this.exports.lab_close)();
    await Promise.all([...this.pending.values()].map(task=>task.settled));
    await this.backend.close();this.opened=false;this.event('driver-closed');
  }
}

export class ReplayBackend {
  constructor(raw=new Uint8Array(),chunkBytes=37) {
    this.input=raw;this.position=0;this.chunkBytes=chunkBytes;this.requests=[];
  }
  async open() {this.opened=true;}
  async close() {this.opened=false;}
  async control(request,bytes) {
    await delay(1);
    if(!this.opened)throw new Error('Replay USB closed');
    if(request.type===0xa1&&request.request===1&&request.value===0x200&&request.index===0&&request.length===2048) {
      const data=this.input.slice(this.position,this.position+this.chunkBytes);this.position+=data.length;
      return {bytes:data};
    }
    if(request.type!==0x21||request.request!==9||!bytes)throw new Error('Unexpected USB control');
    this.requests.push({request:{...request},bytes:bytes.slice()});return {written:bytes.length};
  }
}

export class HelperBackend {
  constructor(url='http://127.0.0.1:8782/usb') {this.url=url;this.session=null;}
  async rpc(method,args=[]) {
    const response=await fetch(this.url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({method,args,session:this.session}),signal:AbortSignal.timeout(3500),cache:'no-store',credentials:'omit'});
    const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'Helper HTTP '+response.status);
    return data.result;
  }
  async open() { const info=await this.rpc('open');this.session=info.session; }
  async close() {if(this.session){try{await this.rpc('close');}finally{this.session=null;}}}
  async control(request,bytes) {
    const setup={requestType:'class',recipient:'interface',request:request.request,value:request.value,index:request.index};
    if(request.type===0xa1){const r=await this.rpc('controlTransferIn',[setup,request.length]);return {bytes:unhex(r.hex),usbDurationMs:r.usbDurationMs};}
    if(request.type!==0x21)throw new Error('Unsupported USB request type');
    const r=await this.rpc('controlTransferOut',[setup,{hex:hex(bytes)}]);return {written:r.bytesWritten};
  }
}
