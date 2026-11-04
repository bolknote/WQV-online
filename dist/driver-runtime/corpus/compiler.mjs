import {WASI,File,OpenFile,ConsoleStdout,PreopenDirectory,Directory} from '../vendor/wasi/package/dist/index.js';
export async function compileUnit(pack,read=async name=>{
  const r=await fetch(new URL(name,import.meta.url));if(!r.ok)throw new Error(name+': HTTP '+r.status);
  return new Uint8Array(await r.arrayBuffer());
}) {
  const enc=s=>new TextEncoder().encode(s),dec=b=>new TextDecoder().decode(b);
  const tree=new Directory(new Map());
  function put(name,data){
    const parts=name.replace(/^\//,'').split('/');let folder=tree;
    for(const part of parts.slice(0,-1)){if(!folder.contents.has(part))folder.contents.set(part,new Directory(new Map()));folder=folder.contents.get(part);}
    folder.contents.set(parts.at(-1),new File(data instanceof Uint8Array?data:enc(data)));
  }
  const files=JSON.parse(dec(await read('../compiler/files.json')));
  await Promise.all(files.map(async name=>put(name,await read('../compiler/'+name))));
  tree.contents.set('tmp',new Directory(new Map()));
  for(const header of pack.includes)put('include/'+header,'#include <linux-compat.h>\n');
  put('include/linux-compat.h',pack.compat);
  for(const [name,data] of Object.entries(pack.localFiles||{}))put(name,data);
  put('driver.c',pack.source);put('entry.c',pack.entry);
  put('build.c','#include <linux-compat.h>\n#include "driver.c"\n#include "entry.c"\n');
  const log=[];
  const wasi=new WASI(['/usr/bin/cc','-I/include','-nostdlib','--entry-point=','-e',pack.exports,
    '-Wl,--allow-undefined','--stack-size=65536','/build.c','/usr/lib/wlibc.a','-o','/out.wasm'],['PWD=/'],[
    new OpenFile(new File([])),ConsoleStdout.lineBuffered(s=>log.push(s)),ConsoleStdout.lineBuffered(s=>log.push(s)),
    new PreopenDirectory('/',tree.contents),new PreopenDirectory('.',tree.contents)]);
  const cc=tree.contents.get('usr').contents.get('bin').contents.get('cc').data;
  const {instance}=await WebAssembly.instantiate(cc,{wasi_snapshot_preview1:wasi.wasiImport});
  const start=performance.now();const status=wasi.start(instance);
  if(status!==0)throw new Error(log.join('\n')||'WCC exited '+status);
  const out=tree.contents.get('out.wasm');if(!out)throw new Error('No Wasm output');
  const bytes=out.data.slice(),module=await WebAssembly.compile(bytes);
  const sha=await crypto.subtle.digest('SHA-256',enc(pack.source));
  return {bytes,log,compileMs:performance.now()-start,
    sourceSHA256:Array.from(new Uint8Array(sha),x=>x.toString(16).padStart(2,'0')).join(''),
    imports:WebAssembly.Module.imports(module),exports:WebAssembly.Module.exports(module).map(x=>x.name)};
}
