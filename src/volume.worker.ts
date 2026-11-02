import {parseNifti} from './core.ts';
import {sha256} from '@noble/hashes/sha2.js';

async function imageFingerprint(file:File){
  if(globalThis.crypto?.subtle)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
  const hash=sha256.create(),reader=file.stream().getReader();
  try{while(true){const {value,done}=await reader.read();if(done)break;hash.update(value);}return Array.from(hash.digest(),n=>n.toString(16).padStart(2,'0')).join('');}
  finally{reader.releaseLock();hash.destroy();}
}

self.onmessage=async(event:MessageEvent<{file:File}>)=>{
  try{
    const file=event.data.file;
    let buffer=await file.arrayBuffer();
    if(new Uint8Array(buffer)[0]===31&&new Uint8Array(buffer)[1]===139)
      buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const volume=parseNifti(buffer,file.name),fingerprint=await imageFingerprint(file);
    self.postMessage({volume,fingerprint},{transfer:[volume.data.buffer as ArrayBuffer,volume.header.buffer as ArrayBuffer]});
  }catch(reason){self.postMessage({error:(reason as Error).message});}
};
