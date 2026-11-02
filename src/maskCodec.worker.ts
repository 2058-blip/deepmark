import {gunzipSync} from 'fflate';
self.onmessage=async(event:MessageEvent<string>)=>{
  try{
    const bytes=Uint8Array.from(atob(event.data),c=>c.charCodeAt(0));
    const raw=typeof DecompressionStream==='undefined'?gunzipSync(bytes).buffer:await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    self.postMessage({raw},{transfer:[raw as ArrayBuffer]});
  }catch(reason){self.postMessage({error:(reason as Error).message});}
};
