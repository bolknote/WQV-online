import {LinuxKingsun} from '../runtime.mjs';
import {LinuxSigmaTel} from '../sigmatel/runtime.mjs';
export class LinuxNetwork extends LinuxSigmaTel {
  imports(){return {...super.imports(),
    host_packet:(pointer,length)=>{this.packets??=[];this.packets.push(this.view().slice(pointer,pointer+length));},
    host_work:pointer=>this.scheduleWork(pointer),
    host_cancel_work:new WebAssembly.Suspending(pointer=>this.cancelWork(pointer)),
    host_set_interface:new WebAssembly.Suspending((number,alternate)=>this.usbService('setInterface',[number,alternate])),
    host_timer:(pointer,ms)=>this.scheduleTimer(pointer,ms),
    host_cancel_timer:pointer=>this.cancelTimer(pointer),
    host_tty_byte:(value,flag)=>{this.raw.push(value);this.ttyFlags??=[];this.ttyFlags.push(flag);},
  };}
  request(pointer){
    const e=this.exports,pipe=e.lab_urb_info(pointer,5);
    if(pipe&0x300)return {transfer:pipe&0x200?'interrupt':'bulk',type:pipe&128,index:pipe&15,
      length:e.lab_urb_info(pointer,2),capacity:e.lab_urb_info(pointer,2),dataPointer:e.lab_urb_info(pointer,1),flags:e.lab_urb_info(pointer,6)};
    return LinuxKingsun.prototype.request.call(this,pointer);
  }
  async open(){
    this.closing=false;this.stopRequested=false;this.fault=null;this.works=new Map();this.timers=new Map();
    await this.backend.open();
    try{
      const result=await WebAssembly.promising(this.exports.lab_open)();if(result<0)throw new Error('Original network driver open: '+result);
      this.opened=true;await this.flushWrites();this.event('driver-opened');
    }catch(error){await this.close();throw error;}
  }
  async speed(baud){
    await this.flushWrites();const result=await WebAssembly.promising(this.exports.lab_speed)(baud);
    if(result<0)throw new Error('Original speed request: '+result);await this.flushWrites();
  }
  send(bytes){return LinuxKingsun.prototype.send.call(this,bytes);}
  scheduleWork(pointer){
    if(this.works.has(pointer))return 0;
    const task={cancelled:false};task.promise=new Promise(resolve=>{task.resolve=resolve;});this.works.set(pointer,task);
    setTimeout(async()=>{
      try{if(!task.cancelled)await WebAssembly.promising(this.exports.lab_dispatch_work)(pointer);}
      catch(error){this.fault=String(error);this.event('runtime-error',{message:String(error)});}
      finally{this.works.delete(pointer);task.resolve();}
    },0);return 1;
  }
  async cancelWork(pointer){const task=this.works.get(pointer);if(task){task.cancelled=true;await task.promise;}}
  scheduleTimer(pointer,ms){
    this.cancelTimer(pointer);
    this.event('kernel-timer-started',{pointer,ms});
    const id=setTimeout(()=>{this.timers.delete(pointer);this.event('kernel-timer-fired',{pointer});try{this.exports.lab_dispatch_timer(pointer);}catch(error){this.fault=String(error);}},Math.min(ms,60000));
    this.timers.set(pointer,id);return 0;
  }
  cancelTimer(pointer){const id=this.timers?.get(pointer);if(id){clearTimeout(id);this.timers.delete(pointer);return 1;}return 0;}
}
