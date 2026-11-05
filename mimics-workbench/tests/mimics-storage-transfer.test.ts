import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {makeDemo,parseNifti} from '../src/core.ts';
import {createProject} from '../src/mimics/project.ts';
import {WorkspaceSaveQueue} from '../src/mimics/workspaceRepository.ts';
import type {WorkspaceRepository,WorkspaceSnapshot} from '../src/mimics/workspaceRepository.ts';
import {saveLocalFile} from '../src/mimics/fileTransfer.ts';
import type {SaveFileRequest} from '../src/mimics/fileTransfer.ts';
import {sameImageGeometry,splitImportedLabels} from '../src/mimics/segmentationImport.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const image=makeDemo();
function snapshot(id:string,revision:number):WorkspaceSnapshot{return{id,volume:image,state:{...createProject(image),name:`${id} r${revision}`},revision,updatedAt:revision};}
class ControlledRepository implements WorkspaceRepository {
  calls:{snapshot:WorkspaceSnapshot;resolve:()=>void;reject:(error:unknown)=>void}[]=[];
  stored=new Map<string,WorkspaceSnapshot>();
  active=0;maxActive=0;
  save(snapshot:WorkspaceSnapshot){
    const result=deferred<void>();this.active++;this.maxActive=Math.max(this.maxActive,this.active);
    this.calls.push({snapshot,resolve:()=>result.resolve(),reject:result.reject});
    return result.promise.then(()=>{this.stored.set(snapshot.id,snapshot);}).finally(()=>{this.active--;});
  }
  async list(){return [];}
  async load(id:string){return this.stored.get(id)??null;}
}

test('save queue retains the newest snapshot while an earlier asynchronous write is in flight',{timeout:3000},async()=>{
  const repository=new ControlledRepository(),saved:WorkspaceSnapshot[]=[],queue=new WorkspaceSaveQueue(repository,s=>saved.push(s));
  const first=snapshot('A',1),second=snapshot('A',2),latest=snapshot('A',3);
  queue.enqueue(first);await nextTurn();assert.equal(repository.calls[0]!.snapshot,first);
  queue.enqueue(second);const done=queue.flush(latest);
  assert.equal(repository.calls.length,1);
  repository.calls[0]!.resolve();await nextTurn();
  assert.equal(repository.calls.length,2);assert.equal(repository.calls[1]!.snapshot,latest);
  repository.calls[1]!.resolve();await done;
  assert.equal(repository.stored.get('A'),latest);assert.deepEqual(saved,[first,latest]);assert.equal(repository.maxActive,1);
});

test('switching documents preserves the last pending snapshot of every document',{timeout:3000},async()=>{
  const repository=new ControlledRepository(),queue=new WorkspaceSaveQueue(repository);
  queue.enqueue(snapshot('A',1));await nextTurn();
  queue.enqueue(snapshot('B',1));queue.enqueue(snapshot('A',2));queue.enqueue(snapshot('C',1));queue.enqueue(snapshot('B',2));
  const done=queue.flush(snapshot('A',3));
  repository.calls[0]!.resolve();
  for(let i=1;i<=3;i++){await nextTurn();assert.ok(repository.calls[i],`pending document write ${i} was dropped`);repository.calls[i]!.resolve();}
  await done;
  assert.equal(repository.stored.get('A')!.revision,3);assert.equal(repository.stored.get('B')!.revision,2);assert.equal(repository.stored.get('C')!.revision,1);
  assert.equal(repository.calls.length,4);assert.equal(repository.maxActive,1);
});

test('flush exposes its document failure even when another document succeeds, and explicit retry can recover',{timeout:3000},async()=>{
  const repository=new ControlledRepository(),failures:unknown[]=[],saved:WorkspaceSnapshot[]=[],queue=new WorkspaceSaveQueue(repository,s=>saved.push(s),e=>failures.push(e));
  const quota=new Error('quota exceeded'),a=snapshot('A',1),b=snapshot('B',1);
  const failed=queue.flush(a);const rejected=assert.rejects(failed,error=>error===quota);await nextTurn();queue.enqueue(b);
  repository.calls[0]!.reject(quota);await nextTurn();assert.equal(repository.calls[1]!.snapshot,b);repository.calls[1]!.resolve();await rejected;
  assert.equal(repository.stored.has('A'),false);assert.equal(repository.stored.get('B'),b);assert.deepEqual(failures,[quota]);assert.deepEqual(saved,[b]);
  const retry=queue.flush(snapshot('A',2));await nextTurn();repository.calls[2]!.resolve();await retry;
  assert.equal(repository.stored.get('A')!.revision,2);
});

test('a newer snapshot can recover an in-flight failure without losing the retry',{timeout:3000},async()=>{
  const repository=new ControlledRepository(),queue=new WorkspaceSaveQueue(repository),first=snapshot('A',1),latest=snapshot('A',2);
  queue.enqueue(first);await nextTurn();const done=queue.flush(latest);repository.calls[0]!.reject(new Error('temporary'));
  await nextTurn();assert.equal(repository.calls[1]!.snapshot,latest);repository.calls[1]!.resolve();await done;
  assert.equal(repository.stored.get('A'),latest);
});

test('synchronous repository and observer errors cannot leave the queue stuck or misreport a later write',{timeout:3000},async()=>{
  const primary=new Error('sync storage failure'),stored:WorkspaceSnapshot[]=[],failures:WorkspaceSnapshot[]=[];
  const repository:WorkspaceRepository={save:s=>{if(s.revision===1)throw primary;stored.push(s);return Promise.resolve();},list:async()=>[],load:async()=>null};
  const queue=new WorkspaceSaveQueue(repository,()=>{throw new Error('saved observer failed');},(_error,s)=>{failures.push(s);throw new Error('failed observer failed');});
  const first=snapshot('A',1);await assert.rejects(queue.flush(first),error=>error===primary);assert.deepEqual(failures,[first]);
  const recovered=snapshot('A',2),other=snapshot('B',2);await queue.flush(recovered);await queue.flush(other);assert.deepEqual(stored,[recovered,other]);
});

function fakeGlobals(values:Record<string,unknown>){
  const originals=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries(values)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  return()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}};
}
const requestBase={name:'offline-project.zip',mime:'application/zip',extension:'.zip',description:'Offline project'};

test('native save waits for the chosen path before producing bytes and reports written only after close',{timeout:3000},async()=>{
  const picker=deferred<any>(),closed=deferred<void>(),events:string[]=[];let blob:Blob|undefined,options:any;
  const restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:(value:unknown)=>{events.push('picker');options=value;return picker.promise;}}});
  try{
    const bytes=new Uint8Array([9,1,2,3,9]).subarray(1,4);
    const request:SaveFileRequest={...requestBase,produce:()=>{events.push('produce');return bytes;}};
    let completed=false;const done=saveLocalFile(request).then(result=>{completed=true;return result;});
    assert.deepEqual(events,['picker']);assert.equal(completed,false);
    picker.resolve({name:'chosen.zip',createWritable:async()=>{events.push('open');return{write:async(value:Blob)=>{events.push('write');blob=value;},close:async()=>{events.push('close');await closed.promise;}};}});
    await nextTurn();assert.deepEqual(events,['picker','produce','open','write','close']);assert.equal(completed,false);
    assert.equal(options.suggestedName,'offline-project.zip');assert.deepEqual(options.types[0].accept,{'application/zip':['.zip']});
    assert.deepEqual(new Uint8Array(await blob!.arrayBuffer()),new Uint8Array([1,2,3]));assert.equal(blob!.type,'application/zip');
    closed.resolve();assert.deepEqual(await done,{status:'written',name:'chosen.zip'});
  }finally{restore();}
});

test('cancelled picker does not produce bytes and picker failures remain visible',async()=>{
  let produced=0;const request={...requestBase,produce:()=>{produced++;return new Uint8Array([1]);}};
  const cancelled=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:async()=>{throw new DOMException('cancelled','AbortError');}}});
  try{assert.deepEqual(await saveLocalFile(request),{status:'cancelled',name:request.name});assert.equal(produced,0);}finally{cancelled();}
  const denied=new Error('permission denied'),restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:async()=>{throw denied;}}});
  try{await assert.rejects(saveLocalFile(request),error=>error===denied);assert.equal(produced,0);}finally{restore();}
});

test('native write or close failures preserve the primary failure when abort rejects, throws or is absent',async()=>{
  for(const stage of ['write','close'] as const)for(const abortMode of ['reject','throw','absent'] as const){
    const events:string[]=[],primary=new Error(`${stage} failed`),abortError=new Error('abort failed');
    const abort=abortMode==='throw'?()=>{events.push('abort');throw abortError;}:async()=>{events.push('abort');throw abortError;};
    const writable={write:async()=>{events.push('write');if(stage==='write')throw primary;},close:async()=>{events.push('close');if(stage==='close')throw primary;},...(abortMode!=='absent'?{abort}:{})};
    const restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:async()=>({name:'chosen.zip',createWritable:async()=>writable})}});
    try{await assert.rejects(saveLocalFile({...requestBase,produce:()=>new Uint8Array([1])}),error=>error===primary);assert.deepEqual(events,[stage==='close'?['write','close']:['write'],abortMode!=='absent'?['abort']:[]].flat());}finally{restore();}
  }
});

test('produce and writable-creation failures are exposed without claiming a completed write',async()=>{
  for(const stage of ['produce','open'] as const){
    const events:string[]=[],primary=new Error(`${stage} failed`),restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:async()=>({name:'chosen.zip',createWritable:async()=>{events.push('open');throw primary;}})}});
    try{await assert.rejects(saveLocalFile({...requestBase,produce:()=>{events.push('produce');if(stage==='produce')throw primary;return new Uint8Array([1]);}}),error=>error===primary);assert.deepEqual(events,stage==='produce'?['produce']:['produce','open']);}finally{restore();}
  }
});

test('anchor fallback and explicit download only report download-started, even when a native picker exists',async()=>{
  for(const {secure,picker,delivery} of [{secure:false,picker:true,delivery:undefined},{secure:true,picker:false,delivery:undefined},{secure:true,picker:true,delivery:'download' as const}]){
    const events:string[]=[],scheduled:(()=>void)[]=[];let producedBlob:Blob|undefined,link:any;
    const restore=fakeGlobals({
      window:{isSecureContext:secure,...(picker?{showSaveFilePicker:()=>{throw new Error('the native picker must not run for fallback or explicit download');}}:{})},
      document:{createElement:(tag:string)=>{assert.equal(tag,'a');link={href:'',download:'',click:()=>events.push('click'),remove:()=>events.push('remove')};return link;},body:{append:(a:unknown)=>{assert.equal(a,link);events.push('append');}}},
      URL:{createObjectURL:(blob:Blob)=>{producedBlob=blob;events.push('url');return'blob:controlled';},revokeObjectURL:(url:string)=>{assert.equal(url,'blob:controlled');events.push('revoke');}},
      setTimeout:(callback:()=>void,delay:number)=>{assert.equal(delay,30_000);scheduled.push(callback);return 1;},
    });
    try{
      const result=await saveLocalFile({...requestBase,delivery,produce:()=>{events.push('produce');return new Uint8Array([1,2]);}});
      assert.deepEqual(result,{status:'download-started',name:requestBase.name});assert.equal(link.download,requestBase.name);assert.equal(link.href,'blob:controlled');
      assert.deepEqual(new Uint8Array(await producedBlob!.arrayBuffer()),new Uint8Array([1,2]));assert.deepEqual(events,['produce','url','append','click','remove']);
      scheduled[0]!();assert.equal(events.at(-1),'revoke');
    }finally{restore();}
  }
});

test('invalid file delivery rejects before producing bytes or invoking browser file APIs',async()=>{
  const events:string[]=[],restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:()=>{events.push('picker');throw new Error('must not run');}},document:{createElement:()=>{events.push('element');throw new Error('must not run');}},URL:{createObjectURL:()=>{events.push('url');throw new Error('must not run');}}});
  try{for(const delivery of [null,'silent','DOWNLOAD',false,0,{},[]])await assert.rejects(saveLocalFile({...requestBase,delivery:delivery as any,produce:()=>{events.push('produce');return new Uint8Array([1]);}}),/delivery/);assert.deepEqual(events,[]);}finally{restore();}
});

test('explicit download preserves produce failures without invoking a picker or starting a download',async()=>{
  const primary=new Error('archive failed'),events:string[]=[],restore=fakeGlobals({window:{isSecureContext:true,showSaveFilePicker:()=>{events.push('picker');throw new Error('must not run');}},document:{createElement:()=>{events.push('element');throw new Error('must not run');}},URL:{createObjectURL:()=>{events.push('url');throw new Error('must not run');}}});
  try{await assert.rejects(saveLocalFile({...requestBase,delivery:'download',produce:()=>{events.push('produce');throw primary;}}),error=>error===primary);assert.deepEqual(events,['produce']);}finally{restore();}
});

test('categorical imports preserve every nonzero label as separate independent membership',()=>{
  const input=new Float32Array([0,9,2,65535,9,2,0]),before=input.slice(),masks=splitImportedLabels(input);
  assert.deepEqual(masks.map(m=>m.label),[2,9,65535]);
  assert.deepEqual(masks.map(m=>[...m.data]),[[0,0,1,0,0,1,0],[0,1,0,0,1,0,0],[0,0,0,1,0,0,0]]);
  masks[0]!.data.fill(0);assert.equal(masks[1]!.data[1],1);assert.deepEqual(input,before);
});

test('categorical imports reject probabilities, non-finite values, invalid categories and budget overflow',()=>{
  for(const input of [[],[0,0],[1,NaN],[1,Infinity],[1,.5],[-1,1],[65536,1]])assert.throws(()=>splitImportedLabels(new Float32Array(input)));
  assert.throws(()=>splitImportedLabels(new Float32Array([1,2,3]),8),/内存预算/);
  assert.equal(splitImportedLabels(new Float32Array([1,2,3]),9).length,3);
  assert.throws(()=>splitImportedLabels(Float32Array.from({length:257},(_,i)=>i+1)),/内存预算/);
});

test('non-finite or unsafe import budgets cannot disable the allocation limit',()=>{
  const input=new Float32Array([0,1,1,0]),before=input.slice();
  for(const budget of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>splitImportedLabels(input,budget),/预算/);
  assert.throws(()=>splitImportedLabels(input,0),/预算/);assert.throws(()=>splitImportedLabels(input,3),/预算/);
  assert.equal(splitImportedLabels(input,4).length,1);assert.deepEqual(input,before);
});

function geometricVolume(unit:number,little=true,dims:[number,number,number]=[2,2,2]){
  const buffer=new ArrayBuffer(352+dims[0]*dims[1]*dims[2]),h=new DataView(buffer),bytes=new Uint8Array(buffer),factor=unit===1?.001:unit===3?1000:1;
  h.setInt32(0,348,little);h.setInt16(40,3,little);
  dims.forEach((n,a)=>{h.setInt16(42+a*2,n,little);h.setFloat32(80+a*4,(a+1)*factor,little);});
  h.setInt16(70,2,little);h.setInt16(72,8,little);h.setFloat32(108,352,little);h.setFloat32(112,1,little);h.setUint8(123,unit);h.setInt16(254,1,little);
  [[0,-2,.25,10],[1,0,0,-20],[0,0,3,30]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n*factor,little)));
  bytes.set([110,43,49,0],344);return parseNifti(buffer);
}
test('geometry matching compares millimetre coordinates across native metre, mm and micron byte orders',()=>{
  const reference=geometricVolume(2);
  for(const unit of [1,2,3])for(const little of [true,false])assert.equal(sameImageGeometry(reference,geometricVolume(unit,little)),true);
  const shifted=geometricVolume(2);shifted.affine[0]![3]!+=.1;assert.equal(sameImageGeometry(reference,shifted),false);
  const mismatch=geometricVolume(2);mismatch.dims[0]=3;assert.equal(sameImageGeometry(reference,mismatch),false);
  assert.equal(sameImageGeometry(reference,geometricVolume(0)),false);
  const nan=geometricVolume(2);nan.affine[0]![0]=NaN;assert.equal(sameImageGeometry(reference,nan),false);
});

test('geometry matching cannot hide a voxel translation at a large origin or cumulative drift across the image',()=>{
  const reference=geometricVolume(2),shifted=geometricVolume(2);reference.affine[0]![3]=100000;shifted.affine[0]![3]=100000.5;
  assert.equal(sameImageGeometry(reference,shifted),false);
  const long=geometricVolume(2,true,[1024,2,2]),drifted=geometricVolume(2,true,[1024,2,2]);drifted.affine[0]![0]+=1e-6;
  assert.equal(sameImageGeometry(long,drifted),false);
  const roundoff=geometricVolume(2);roundoff.affine[0]![3]+=1e-6;assert.equal(sameImageGeometry(geometricVolume(2),roundoff),true);
});
