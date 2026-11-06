import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationClient} from '../src/mimics/operationClient.ts';

class RecordingWorker {
  static instances:RecordingWorker[]=[];
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  messages:any[]=[];terminated=false;
  constructor(){RecordingWorker.instances.push(this);}
  postMessage(message:any){this.messages.push(structuredClone(message));}
  terminate(){this.terminated=true;}
  finish(type='result'){const run=this.messages.findLast(message=>message.type==='run');this.onmessage?.({data:{id:run.id,type,result:{mask:new Uint8Array(1),count:1},message:'辅助内存预算不足'}});}
}
function withWorker(run:()=>Promise<void>){return async()=>{const previous=globalThis.Worker;RecordingWorker.instances=[];(globalThis as any).Worker=RecordingWorker;try{await run();}finally{globalThis.Worker=previous;}};}
test('image-only operations do not structured-clone unused whole-volume masks',withWorker(async()=>{
  const client=new OperationClient(),data=new Float32Array(64),mask=new Uint8Array(64),other=new Uint8Array(64);
  client.initialize({dims:[4,4,4],spacing:[1,1,1],data});
  for(const kind of ['dynamic','threshold']){const pending=client.run({kind,mask,other,seed:[1,1,1]});const worker=RecordingWorker.instances.at(-1)!;const request=worker.messages.at(-1);assert.equal('mask' in request,false);assert.equal('other' in request,false);worker.finish();await pending;}
  assert.equal(data.byteLength,256);assert.equal(mask.byteLength,64);assert.equal(other.byteLength,64);client.dispose();
}));
test('operations requiring both masks preserve their independent inputs',withWorker(async()=>{
  const client=new OperationClient(),mask=new Uint8Array([1,0]),other=new Uint8Array([0,1]);client.initialize({dims:[2,1,1],spacing:[1,1,1],data:new Float32Array(2)});
  const pending=client.run({kind:'boolean',mask,other,options:{operation:'union'}}),worker=RecordingWorker.instances.at(-1)!;assert.deepEqual(worker.messages.at(-1).mask,mask);assert.deepEqual(worker.messages.at(-1).other,other);worker.finish();await pending;client.dispose();
}));
test('large CT worker copies are released on result and recoverable failure, with retry supported',withWorker(async()=>{
  const client=new OperationClient(),data=new Float32Array(64*1024*1024/4);client.initialize({dims:[256,256,256],spacing:[1,1,1],data});
  const first=client.run({kind:'dynamic',seed:[1,1,1]}),worker=RecordingWorker.instances.at(-1)!;worker.finish();await first;assert.equal(worker.terminated,true);assert.equal(data.byteLength,64*1024*1024);
  const failed=client.run({kind:'dynamic',seed:[1,1,1]}),second=RecordingWorker.instances.at(-1)!;assert.notEqual(second,worker);second.finish('error');await assert.rejects(failed,/内存预算/);assert.equal(second.terminated,true);
  const retry=client.run({kind:'dynamic',seed:[1,1,1]}),third=RecordingWorker.instances.at(-1)!;third.finish();await retry;assert.equal(data.byteLength,64*1024*1024);client.dispose();
}));
