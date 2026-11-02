import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readTransferBlob} from '../src/transfer.ts';
import type {TransferProgress} from '../src/transfer.ts';
import {downloadBlobAuthenticated,uploadDataset} from '../src/api.ts';

function streamed(chunks:number[][],headers:Record<string,string>={}){
  return new Response(new ReadableStream<Uint8Array>({start(controller){for(const bytes of chunks)controller.enqueue(new Uint8Array(bytes));controller.close();}}),{headers});
}

test('a streamed download preserves binary data and reports actual byte progress',async()=>{
  const updates:TransferProgress[]=[];
  const blob=await readTransferBlob(streamed([[0,255],[1,2,3]],{'content-length':'5','content-type':'application/gzip'}),{onProgress:progress=>updates.push(progress)});
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array([0,255,1,2,3]));assert.equal(blob.type,'application/gzip');
  assert.deepEqual(updates.map(progress=>[progress.loaded,progress.total,progress.percent,progress.complete]),[[0,5,0,false],[2,5,40,false],[5,5,100,false],[5,5,100,true]]);
});

test('unknown or encoded lengths never produce an invented download percentage',async()=>{
  for(const headers of [{},{'content-length':'3','content-encoding':'gzip'},{'content-length':'wrong'}]){
    const updates:TransferProgress[]=[];
    await readTransferBlob(streamed([[1,2],[3,4,5,6]],headers),{onProgress:progress=>updates.push(progress)});
    assert.ok(updates.every(progress=>progress.total===null&&progress.percent===null));
    assert.equal(updates.at(-1)?.loaded,6);assert.equal(updates.at(-1)?.complete,true);
  }
});

test('cancelling an in-flight body stops its reader without reporting completion',async()=>{
  const controller=new AbortController(),updates:TransferProgress[]=[];let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array([7,8]));},cancel(){cancelled=true;}});
  const result=readTransferBlob(new Response(body,{headers:{'content-length':'10'}}),{signal:controller.signal,onProgress:progress=>{updates.push(progress);if(progress.loaded===2)controller.abort();}});
  await assert.rejects(result,{name:'AbortError'});assert.equal(cancelled,true);assert.ok(updates.every(progress=>!progress.complete));
  await assert.rejects(readTransferBlob(streamed([[1]]),{signal:controller.signal}),{name:'AbortError'});
});

test('a failed stream does not create a partial successful file',async()=>{
  const updates:TransferProgress[]=[];
  const response=new Response(new ReadableStream<Uint8Array>({pull(controller){controller.error(new Error('connection lost'));}}));
  await assert.rejects(readTransferBlob(response,{onProgress:progress=>updates.push(progress)}),/connection lost/);
  assert.ok(updates.every(progress=>!progress.complete));
});

test('authenticated downloads preserve HTTP errors and do not consume them as files',async()=>{
  const original=globalThis.fetch;let requested:RequestInit|undefined;
  globalThis.fetch=async(_url,options)=>{requested=options;return new Response(JSON.stringify({error:'没有访问权限。'}),{status:403,headers:{'content-type':'application/json'}});};
  try{await assert.rejects(downloadBlobAuthenticated('/protected'),{status:403,message:'没有访问权限。'});assert.equal(requested?.credentials,'same-origin');}
  finally{globalThis.fetch=original;}
});

test('upload cancellation aborts the credentialed CSRF-protected request and permits retry',async()=>{
  const original=globalThis.XMLHttpRequest;const instances:UploadRequest[]=[];
  class UploadRequest{
    upload:{onprogress?:(event:ProgressEvent)=>void;onload?:()=>void}={};headers=new Map<string,string>();withCredentials=false;status=200;responseText='{"dataset":{"id":"new"}}';
    onload?:()=>void;onerror?:()=>void;onabort?:()=>void;aborted=false;sent=false;method='';path='';
    constructor(){instances.push(this);}open(method:string,path:string){this.method=method;this.path=path;}setRequestHeader(key:string,value:string){this.headers.set(key,value);}send(){this.sent=true;}abort(){this.aborted=true;this.onabort?.();}
  }
  globalThis.XMLHttpRequest=UploadRequest as unknown as typeof XMLHttpRequest;
  try{
    const controller=new AbortController(),updates:TransferProgress[]=[];
    const pending=uploadDataset(new FormData(),progress=>updates.push(progress),{signal:controller.signal});
    const request=instances[0];assert.equal(request.method,'POST');assert.equal(request.path,'/api/datasets/upload');assert.equal(request.withCredentials,true);assert.equal(request.headers.get('X-Deepmark-Request'),'1');
    request.upload.onprogress?.({loaded:80,total:200,lengthComputable:true} as ProgressEvent);assert.equal(updates.at(-1)?.percent,40);
    controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(request.aborted,true);
    const retry=uploadDataset(new FormData(),progress=>updates.push(progress));instances[1].upload.onload?.();assert.equal(updates.at(-1)?.complete,true);instances[1].onload?.();assert.deepEqual(await retry,{dataset:{id:'new'}});
  }finally{globalThis.XMLHttpRequest=original;}
});
