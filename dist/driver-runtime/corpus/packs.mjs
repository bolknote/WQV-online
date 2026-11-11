export const NET_EXPORTS='lab_open,lab_close,lab_speed,lab_send,lab_alloc,lab_free,lab_urb_info,lab_complete,lab_state';
export async function makePack(name,read=async path=>{
  const r=await fetch(new URL(path,import.meta.url));if(!r.ok)throw new Error(path+': HTTP '+r.status);return r.text();
}) {
  const manifest=JSON.parse(await read('sources.json'));
  const spec=manifest.files[name];if(!spec||!spec.path.endsWith('.c'))throw new Error('Unknown C driver');
  const source=await read(spec.localPath),common=await read('../linux-compat.h');
  let compat=common,entry,localFiles={};
  if(name==='sigmatel'){
    compat+='\n'+await read('../sigmatel/extra-compat.h');entry=await read('../sigmatel/entry.c');
  }else if(name==='ks959')entry=await read('../entry.c');
  else {
    if(['mcs7780','irda-usb','ark3116','ir-usb','pl2303','ma620'].includes(name))compat+='\n#define netif_rx corpus_unused_fir_delivery\n'+await read('../sigmatel/extra-compat.h')+'\n#undef netif_rx\n';
    compat+='\n'+await read('compat.h');
    if(name==='mcs7780'||name==='irda-usb'){
      localFiles[name+'.h']=await read(manifest.files[name+'-header'].localPath);
    }
    if(['ark3116','ir-usb','pl2303','ma620'].includes(name)){
      const headers={'uart-header':'linux/serial_reg.h','usb-irda-header':'linux/usb/irda.h',
        'termbits-header':'asm/termbits.h','termios-header':'asm/termios.h','ioctls-header':'asm/ioctls.h','ioctl-header':'linux/ioctl.h'};
      for(const [key,path] of Object.entries(headers))localFiles['include/'+path]=await read(manifest.files[spec.headerOverrides?.[key]||key].localPath);
      localFiles['include/linux/posix_types.h']='#include <linux-compat.h>\n';
      compat+='\n#define LAB_SERIAL_ID_INDEX '+(name==='ark3116'?1:0)+'\n';
      compat+='\n#define LAB_SERIAL_MODULE_INIT '+(name==='ir-usb'?1:0)+'\n';
      compat+='\n#define LAB_PL2303 '+(['pl2303','ma620'].includes(name)?1:0)+'\n#define LAB_MA620 '+(name==='ma620'?1:0)+'\n';
      compat+='\n'+await read('serial-compat.h');
      entry=await read('serial-entry.c');
      if(name==='pl2303'||name==='ma620')localFiles['pl2303.h']=await read(manifest.files['pl2303-header'].localPath);
      if(name==='ma620'){
        compat+='\n'+await read('ma620-compat.h');
        localFiles['sir-dev.h']='#include <linux-compat.h>\n';
        localFiles['pl2303.c']=await read(manifest.files.pl2303.localPath);
        entry='#include "pl2303.c"\n'+entry+'\n'+await read('ma620-entry.c');
      }
    }else{
      const interrupt=name==='kingsun'||name==='ksdazzle';
      compat+='\n#define LAB_ENDPOINT_TYPE '+(interrupt?3:2)+'\n#define LAB_PACKET_SIZE '+(interrupt?8:64)+'\n';
      entry=await read('net-entry.c');
    }
  }
  const includes=[...new Set([source,...Object.values(localFiles)].flatMap(text=>Array.from(text.matchAll(/^\s*#include\s*<([^>]+)>/gm),m=>m[1])))];
  return {name,source,compat,entry,localFiles,includes,
    exports:NET_EXPORTS+(name==='sigmatel'?',lab_parameters,lab_thread':name==='ks959'?',lab_rx_counter':(name==='kingsun'||name==='ksdazzle'||name==='mcs7780'||name==='irda-usb')?',lab_dispatch_work,lab_dispatch_timer,lab_send_speed':''),
    referenceSHA256:spec.sha256,provenance:{tag:spec.tag||manifest.tag,commit:spec.commit||manifest.commit,url:spec.url}};
}
