import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,ref,shallowRef} from 'vue';
import {prepareMprSampler} from '../src/mimics/mpr.ts';
import {densityStatistics} from '../src/mimics/measurements.ts';
import {acquireMprSamplingOwner,MprSamplingCancelled,MprSamplingOwner,type MprSamplingSource,type MprSamplerRequest} from '../src/mimics/mprSamplingClient.ts';
import {useMprSampling} from '../src/mimics/useMprSampling.ts';
import type {MprPlane,VolumeGrid} from '../src/mimics/types.ts';

// Actual Node Worker adapter, preserving transfer semantics. No main-thread raster fallback.
const instances:WorkerAdapter[]=[];
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;onmessageerror:(()=>void)|null=null;
  readonly worker:NodeWorker;terminated=false;posted:{type:string;owner?:number;id?:number;transferBytes:number[]}[]=[];received:any[]=[];
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>{if(data?.__mprTestCrash)throw new Error(data.__mprTestCrash);self.onmessage({data});});`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));instances.push(this);this.worker.on('message',data=>{this.received.push(data);this.onmessage?.({data});});this.worker.on('error',error=>this.onerror?.({message:error.message}));
  }
  postMessage(value:MprSamplerRequest,transfer:Transferable[]=[]){this.posted.push({type:value.type,...('owner'in value?{owner:value.owner}:{}),...('id'in value?{id:value.id}:{}),transferBytes:transfer.map(buffer=>(buffer as ArrayBuffer).byteLength)});this.worker.postMessage(value,transfer as ArrayBuffer[]);}
  crash(message:string){this.worker.postMessage({__mprTestCrash:message});}
  terminate(){this.terminated=true;void this.worker.terminate();}
}
const plane=(origin:[number,number,number]=[.5,.5,.5],size:[number,number]=[1,1]):MprPlane=>({origin,u:[1,0,0],v:[0,1,0],size});
function source(revision=0):MprSamplingSource{return{revision,grid:{dims:[2,2,2],spacing:[1,1,1],data:new Float32Array([0,10,100,110,1000,1010,1100,1110])},masks:[{id:'A',data:new Uint8Array([1,0,0,0,0,0,0,1]),revision:0},{id:'B',data:new Uint8Array([0,1,0,0,0,0,0,0]),revision:0}]};}
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw new Error('Worker test timed out.');await new Promise(resolve=>setTimeout(resolve,2));}}
async function withWorkers(run:()=>Promise<void>){const previous=globalThis.Worker,start=instances.length;(globalThis as any).Worker=WorkerAdapter;try{await run();}finally{await Promise.all(instances.slice(start).map(async instance=>{instance.terminated=true;await instance.worker.terminate();}));globalThis.Worker=previous;}}
const sent=(instance:WorkerAdapter,type:string)=>instance.posted.filter(message=>message.type===type);

test('one resident MPR Worker serves three owners and transfers only owned source copies',async()=>withWorkers(async()=>{
  const start=instances.length,document={},s=source(),gray=s.grid.data.slice(),a=s.masks[0]!.data.slice(),b=s.masks[1]!.data.slice(),owners=[0,1,2].map(()=>acquireMprSamplingOwner(document));
  try{const results=await Promise.all(owners.map((owner,i)=>owner.request(s,plane(i===0?[0,0,0]:i===1?[.5,.5,.5]:[1,1,1]))));assert.equal(instances.length-start,1);const worker=instances[start]!;assert.equal(sent(worker,'init').length,1);assert.equal(sent(worker,'sample').length,3);assert.deepEqual(sent(worker,'init')[0]!.transferBytes,[32,8,8]);assert.deepEqual(results.map(result=>result.gray[0]),[0,555,1110]);assert.deepEqual(results.map(result=>result.masks[0]!.data[0]),[1,1,1]);assert.equal(s.grid.data.byteLength,32);assert.equal(s.masks[0]!.data.byteLength,8);assert.deepEqual(s.grid.data,gray);assert.deepEqual(s.masks[0]!.data,a);assert.deepEqual(s.masks[1]!.data,b);
    owners[0]!.dispose();assert.equal(worker.terminated,false);owners[1]!.dispose();assert.equal(worker.terminated,false);owners[2]!.dispose();assert.equal(worker.terminated,true);
  }finally{owners.forEach(owner=>owner.dispose());}
}));

test('MPR Worker uses existing independent oblique resampling values and independent nearest Mask overlays',async()=>withWorkers(async()=>{
  const data=new Float32Array(27);for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)data[x+3*(y+3*z)]=10*x+100*y+1000*z;
  const s:MprSamplingSource={revision:1,grid:{dims:[3,3,3],spacing:[1,1,1],data},masks:[{id:'A',data:Uint8Array.from({length:27},(_,i)=>i===13?1:0)},{id:'B',data:Uint8Array.from({length:27},(_,i)=>i===26?255:0)}]},owner=acquireMprSamplingOwner({});
  try{const result=await owner.request(s,{origin:[.5,.5,.5],u:[.5,.5,0],v:[-.25,.25,.5],size:[3,3]});assert.deepEqual([...result.gray],[555,610,665,1077.5,1132.5,1187.5,1600,1655,1710]);assert.deepEqual([...result.valid],Array(9).fill(1));assert.deepEqual([...result.masks[0]!.data],[1,1,0,0,1,0,0,0,0]);assert.deepEqual([...result.masks[1]!.data],Array(9).fill(0));}finally{owner.dispose();}
}));

test('owner latest-pose replacement and cancellation cannot publish older worker results',async()=>withWorkers(async()=>{
  const s=source(),owner=acquireMprSamplingOwner({}),start=instances.length;
  try{await owner.request(s,plane());const first=owner.request(s,plane([0,0,0],[512,512])).then(()=>{throw new Error('Obsolete scan unexpectedly resolved.');},error=>assert.ok(error instanceof MprSamplingCancelled)),obsoleteId=sent(instances[start]!,'sample').at(-1)!.id;await new Promise(resolve=>setTimeout(resolve,5));const result=await owner.request(s,plane([1,1,1]));await first;assert.equal(result.gray[0],1110);assert.equal(sent(instances[start]!,'init').length,1);assert.equal(instances[start]!.received.some(message=>message.type==='result'&&message.id===obsoleteId),false,'the worker itself abandons the obsolete bounded scan');
    const pending=owner.request(s,plane([0,0,0],[512,512]));const rejected=assert.rejects(pending,MprSamplingCancelled);owner.cancel();await rejected;await owner.request(s,plane([0,0,0]));assert.equal(sent(instances[start]!,'init').length,1,'pose cancellation preserves the resident source');
  }finally{owner.dispose();}
}));

test('real Worker scan keeps one global pixel coordinate frame across asynchronous yield boundaries',async()=>withWorkers(async()=>{
  const owner=acquireMprSamplingOwner({});try{const result=await owner.request(source(),{origin:[.5,.5,.5],u:[1/256,1/256,0],v:[-1/512,1/512,1/256],size:[65,65]});
    // I=10X+100Y+1000Z gives stepU=0.4296875 and stepV=4.08203125.
    assert.equal(result.gray[0],555);assert.equal(result.gray[4095],812.16796875);assert.equal(result.gray[4096],812.59765625);assert.equal(result.gray.at(-1),843.75);assert.equal(result.valid[4095],1);assert.equal(result.valid[4096],1);
  }finally{owner.dispose();}
}));

test('prepared and real Worker nearest sampling preserve analytic half ties under reflected sheared source affines',async()=>withWorkers(async()=>{
  const data=new Float32Array(245),parity=new Uint8Array(245),overlap=new Uint8Array(245);for(let k=0;k<5;k++)for(let j=0;j<7;j++)for(let i=0;i<7;i++){const n=i+7*(j+7*k);data[n]=102-4*i-8*j+k;parity[n]=Number((i+j+k)%2===0);overlap[n]=Number(i===3);}
  const s:MprSamplingSource={revision:1,grid:{dims:[7,7,5],spacing:[2,Math.hypot(.5,3),Math.hypot(.25,.5,4)],affine:[[-2,.5,.25,10],[0,3,.5,-20],[0,0,4,30]],data},masks:[{id:'Parity',data:parity},{id:'Overlap',data:overlap}]},p:MprPlane={origin:[5.3125,-13.375,35],u:[.5,0,0],v:[0,.75,0],size:[5,4]},owner=acquireMprSamplingOwner({});
  try{for(const interpolation of ['linear','nearest'] as const){const result=await owner.request(s,p,interpolation);assert.equal(result.gray[2],interpolation==='linear'?77.25:75);assert.equal(result.masks[0]!.data[2],1);assert.equal(result.masks[1]!.data[2],1);}
    // Analytic inverse at pixel(2,0): IJK=(2.5,2,1.25), nearest=(3,2,1).
    const stats=densityStatistics(s.grid,p,{kind:'rect',min:[2,0],max:[2,0]},{interpolation:'nearest'});assert.equal(stats.count,1);assert.equal(stats.mean,75);
  }finally{owner.dispose();}
}));

test('changing source data restarts the resident epoch, invalidates peers and rejects older source versions',async()=>withWorkers(async()=>{
  const start=instances.length,document={},s=source(),peerInvalidations:string[]=[],owner=acquireMprSamplingOwner(document),peer=acquireMprSamplingOwner(document,message=>peerInvalidations.push(message??'source changed'));
  try{await owner.request(s,plane());await peer.request(s,plane());peerInvalidations.length=0;const next={...s,revision:1,grid:{...s.grid,data:new Float32Array(8).fill(7)}};const result=await owner.request(next,plane());assert.equal(result.gray[0],7);assert.equal(instances.length-start,2);assert.equal(instances[start]!.terminated,true);assert.deepEqual(peerInvalidations,['source changed']);await assert.rejects(peer.request(s,plane()),MprSamplingCancelled);assert.equal(instances.length-start,2);await peer.request({...next,revision:2},plane([0,0,0]));assert.equal(instances.length-start,2,'metadata-only revision uses the same source copy');
  }finally{owner.dispose();peer.dispose();}
}));

test('prepared MPR asynchronous scan yields cancellation without partial outputs or repeating source validation',async()=>{
  const s=source(),prepared=prepareMprSampler(s.grid,s.masks);let cancelled=false,yields=0,result:unknown;await assert.rejects(async()=>{result=await prepared.sampleAsync(plane([0,0,0],[128,128]),{cancelled:()=>cancelled},async()=>{yields++;cancelled=true;});},/取消/);assert.equal(yields,1);assert.equal(result,undefined);assert.deepEqual([...s.grid.data],[0,10,100,110,1000,1010,1100,1110]);
  await assert.rejects(prepared.sampleAsync(plane([0,0,0],[128,128]),{maxBytes:128}),/内存预算/);assert.equal(prepared.sample(plane()).gray[0],555);
});

function composableHarness(){
  const s=source(),volume=shallowRef<object|null>({id:'document'}),grid=shallowRef<VolumeGrid|null>(s.grid),sourceRevision=ref(0),p=shallowRef<MprPlane|null>(plane()),interpolation=ref<'linear'|'nearest'>('linear'),masks=shallowRef(s.masks.map(mask=>({...mask,color:'#fff',visible:true,opacity:1}))),scope=effectScope(),sampling=scope.run(()=>useMprSampling({volume,grid,sourceRevision,plane:p,interpolation,masks}))!;
  return{sampling,volume,grid,sourceRevision,plane:p,interpolation,masks,close:()=>scope.stop()};
}
function threePaneHarness(){
  const s=source(),volume=shallowRef<object|null>({id:'shared-document'}),grid=shallowRef<VolumeGrid|null>(s.grid),sourceRevision=ref(0),interpolation=ref<'linear'|'nearest'>('linear'),masks=shallowRef(s.masks);
  const views=([ [0,0,0],[.5,.5,.5],[1,1,1] ] as [number,number,number][]).map(origin=>{const scope=effectScope(),p=shallowRef<MprPlane|null>(plane(origin)),sampling=scope.run(()=>useMprSampling({volume,grid,sourceRevision,plane:p,interpolation,masks}))!;return{sampling,scope,plane:p};});
  return{views,close:()=>views.forEach(view=>view.scope.stop())};
}

test('sampling composable clears each new pose while metadata, window and Mask colors only redraw',async()=>withWorkers(async()=>{
  const start=instances.length,h=composableHarness();try{await until(()=>!!h.sampling.samples.value);const worker=instances[start]!,first=h.sampling.samples.value;h.sourceRevision.value++;h.masks.value=h.masks.value.map(mask=>({...mask,color:'#123456',visible:false,opacity:.4}));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.sampling.samples.value,first);assert.equal(sent(worker,'sample').length,1);assert.equal(sent(worker,'init').length,1);
    h.plane.value=plane([1,1,1]);assert.equal(h.sampling.samples.value,null);assert.equal(h.sampling.loading.value,true);await until(()=>!h.sampling.loading.value);assert.equal(h.sampling.samples.value!.gray[0],1110);assert.equal(sent(worker,'sample').length,2);h.interpolation.value='nearest';await until(()=>!h.sampling.loading.value);assert.equal(sent(worker,'sample').length,3);assert.equal(sent(worker,'init').length,1);
  }finally{h.close();}
}));

test('composable document replacement and cancelled poses cannot resurrect old image data',async()=>withWorkers(async()=>{
  const start=instances.length,h=composableHarness();try{await until(()=>!!h.sampling.samples.value);h.plane.value=plane([0,0,0],[512,512]);h.volume.value={id:'replacement'};h.grid.value={...h.grid.value!,data:new Float32Array(8).fill(9)};h.sourceRevision.value++;h.plane.value=plane();await until(()=>!h.sampling.loading.value);assert.equal(h.sampling.samples.value!.gray[0],9);assert.ok(instances[start]!.terminated);assert.equal(h.sampling.error.value,'');
    h.plane.value=plane([0,0,0],[512,512]);h.sampling.cancel();assert.equal(h.sampling.samples.value,null);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.sampling.samples.value,null);assert.equal(h.sampling.loading.value,false);
  }finally{h.close();}
}));

test('an explicit Mask revision invalidates resident data even when the controlled source reuses its buffer',async()=>withWorkers(async()=>{
  const start=instances.length,h=composableHarness();try{await until(()=>!!h.sampling.samples.value);assert.equal(h.sampling.samples.value!.masks[0]!.data[0],1);const original=h.masks.value[0]!.data;original[7]=0;h.masks.value=h.masks.value.map((mask,i)=>i===0?{...mask,revision:mask.revision!+1}:mask);h.sourceRevision.value++;assert.equal(h.sampling.samples.value,null);await until(()=>!h.sampling.loading.value);assert.equal(h.sampling.samples.value!.masks[0]!.data[0],0);assert.equal(h.masks.value[0]!.data,original);assert.equal(original.byteLength,8);assert.equal(instances.length-start,2);assert.equal(instances[start]!.terminated,true);
  }finally{h.close();}
}));

test('worker failure is visible with no synchronous fallback and explicit refresh can retry',async()=>withWorkers(async()=>{
  const start=instances.length,h=composableHarness();try{await until(()=>!!h.sampling.samples.value);instances[start]!.onerror?.({message:'test worker crashed'});assert.equal(h.sampling.samples.value,null);assert.equal(h.sampling.loading.value,false);assert.match(h.sampling.error.value,/worker crashed/);assert.equal(instances[start]!.terminated,true);h.sampling.refresh();await until(()=>!h.sampling.loading.value);assert.equal(h.sampling.samples.value!.gray[0],555);assert.equal(h.sampling.error.value,'');assert.equal(instances.length-start,2);
  }finally{h.close();}
}));

test('one pane explicitly retrying a genuinely crashed shared Worker restores all three real Vue sampling owners',async()=>withWorkers(async()=>{
  const start=instances.length,h=threePaneHarness();try{await until(()=>h.views.every(view=>!!view.sampling.samples.value));assert.equal(instances.length-start,1);assert.deepEqual(h.views.map(view=>view.sampling.samples.value!.gray[0]),[0,555,1110]);
    instances[start]!.crash('shared worker crashed');await until(()=>h.views.every(view=>view.sampling.error.value.includes('shared worker crashed')));assert.ok(h.views.every(view=>view.sampling.samples.value===null&&!view.sampling.loading.value));
    h.views[0]!.sampling.refresh();await until(()=>h.views.every(view=>!!view.sampling.samples.value));assert.equal(instances.length-start,2);assert.deepEqual(h.views.map(view=>view.sampling.samples.value!.gray[0]),[0,555,1110]);assert.ok(h.views.every(view=>view.sampling.error.value===''&&!view.sampling.loading.value));assert.equal(sent(instances[start+1]!,'init').length,1);assert.equal(sent(instances[start+1]!,'sample').length,3);
  }finally{h.close();}
}));

test('a fatal retry initialization revokes queued peer recovery without automatic blind retries',async()=>withWorkers(async()=>{
  const start=instances.length,h=threePaneHarness(),original=MprSamplingOwner.prototype.request;let requests=0;
  try{await until(()=>h.views.every(view=>!!view.sampling.samples.value));instances[start]!.crash('initial shared crash');await until(()=>h.views.every(view=>!!view.sampling.error.value));
    MprSamplingOwner.prototype.request=function(...args:Parameters<typeof original>){requests++;return original.apply(this,args);};
    // This fails synchronously after peers were notified of a new resident epoch.
    (globalThis as any).Worker=undefined;h.views[0]!.sampling.refresh();(globalThis as any).Worker=WorkerAdapter;
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(requests,1,'the fatal error must cancel both queued peer update jobs');assert.equal(instances.length-start,1);assert.ok(h.views.every(view=>view.sampling.samples.value===null&&!view.sampling.loading.value&&view.sampling.error.value.includes('后台Worker')));
    h.views[0]!.sampling.refresh();await until(()=>h.views.every(view=>!!view.sampling.samples.value));assert.equal(requests,4,'one explicit request plus two legitimate peer recoveries');assert.equal(instances.length-start,2);
  }finally{MprSamplingOwner.prototype.request=original;(globalThis as any).Worker=WorkerAdapter;h.close();}
}));

test('cancelled and disposed peers cannot be resurrected by a queued shared-worker recovery',async()=>withWorkers(async()=>{
  const start=instances.length,h=threePaneHarness();try{await until(()=>h.views.every(view=>!!view.sampling.samples.value));instances[start]!.crash('shared crash before cancellation');await until(()=>h.views.every(view=>!!view.sampling.error.value));
    h.views[0]!.sampling.refresh();h.views[1]!.sampling.cancel();h.views[2]!.scope.stop();await until(()=>!!h.views[0]!.sampling.samples.value);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.views[1]!.sampling.samples.value,null);assert.equal(h.views[1]!.sampling.loading.value,false);assert.equal(h.views[2]!.sampling.samples.value,null);assert.equal(sent(instances[start+1]!,'sample').length,1);
    h.views[1]!.sampling.refresh();await until(()=>!!h.views[1]!.sampling.samples.value);assert.equal(h.views[1]!.sampling.samples.value!.gray[0],555);assert.equal(sent(instances[start+1]!,'init').length,1);
  }finally{h.close();}
}));

test('worker initialization rejects invalid sources visibly and preserves every original buffer',async()=>withWorkers(async()=>{
  const start=instances.length,h=composableHarness();try{await until(()=>!!h.sampling.samples.value);h.grid.value={...h.grid.value!,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]};h.sourceRevision.value++;await until(()=>!!h.sampling.error.value);assert.match(h.sampling.error.value,/不可逆/);assert.equal(h.sampling.samples.value,null);assert.equal(h.grid.value!.data.byteLength,32);assert.equal(h.masks.value[0]!.data.byteLength,8);assert.equal(instances.length-start,2);
  }finally{h.close();}
}));

test('an unavailable Worker leaves an explicit error and no main-thread sampled image',()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=undefined;const h=composableHarness();try{assert.equal(h.sampling.samples.value,null);assert.equal(h.sampling.loading.value,false);assert.match(h.sampling.error.value,/后台Worker/);}finally{h.close();globalThis.Worker=previous;}
});
