import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addMask} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MprContourEpoch} from '../src/mimics/mprContourSession.ts';
import type {Vec3} from '../src/mimics/types.ts';

// Independent high-risk ownership checks; actual workers and hand-authored source indices.
const workers=new Set<NodeWorker>();
let gate:{kind:string;ready:Promise<void>;signal:()=>void;release:(()=>void)|null}|null=null;
function hold(kind:string){let signal!:()=>void;const value={kind,ready:new Promise<void>(resolve=>signal=resolve),signal:()=>signal(),release:null as (()=>void)|null};gate=value;return value;}
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;jobs=new Map<number,string>();
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);
    this.worker.on('message',data=>{const held=gate,deliver=this.onmessage;if(data.type==='result'&&held&&!held.release&&this.jobs.get(data.id)===held.kind){gate=null;held.release=()=>deliver?.({data});held.signal();}else deliver?.({data});});
    this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));
  }
  postMessage(value:any){if(value.type==='run')this.jobs.set(value.id,value.kind);this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
let serial=0;
const polygon=():Vec3[]=>[[1,1,1],[3,1,1],[3,3,1],[1,3,1]];
function begin(e:Editor,tool:'lasso'|'livewire'='lasso'):MprContourEpoch {
  e.tool.value=tool;e.params.editOperation='add';e.params.livewireWeight=0;e.params.livewireAttraction=0;
  const context:MprContourEpoch={sessionId:++serial,activeMaskId:e.state.value.selectedMaskId,mprPlane:structuredClone(e.mpr.plane.value!),volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value};assert.equal(e.mpr.beginContour(context),true);return context;
}
async function withEditor(run:(e:Editor)=>Promise<void>){
  const old=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),e=scope.run(()=>useWorkbench({repository:null}))!;e.params.thresholdAutoPreview=false;
  const count=75,buffer=new ArrayBuffer(352+count*4),header=new DataView(buffer),bytes=new Uint8Array(buffer);header.setInt32(0,348,true);header.setInt16(40,3,true);[5,5,3].forEach((n,k)=>{header.setInt16(42+k*2,n,true);header.setFloat32(80+k*4,1,true);});header.setInt16(70,16,true);header.setInt16(72,32,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setUint8(123,2);bytes.set([110,43,49,0],344);for(let i=0;i<count;i++)header.setFloat32(352+i*4,25,true);
  try{
    parseNifti(buffer,'audit.nii');assert.equal(await e.openFiles([new File([buffer],'audit.nii')]),true);
    const active=e.state.value.selectedMaskId;let state={...e.state.value,masks:e.state.value.masks.map(mask=>({...mask,data:new Uint8Array(count)}))};state=addMask(state,count,'Independent overlapping mask',new Uint8Array(count).fill(1));e.state.value={...state,selectedMaskId:active};
    assert.equal(e.mpr.setPlane({origin:[0,0,1],u:[1,0,0],v:[0,1,0],size:[5,5]}),true);await nextTick();await run(e);
  }finally{gate=null;e.cancel();scope.stop();globalThis.Worker=old;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
const filled=()=>{const output=new Uint8Array(75);for(let y=1;y<=3;y++)for(let x=1;x<=3;x++)output[x+5*(y+5)]=1;return output;};

test('source-buffer replacement without document revision cancels only its contour job; stale result and cancellation cannot terminate a different global preview',{timeout:15000},async()=>withEditor(async e=>{
  const context=begin(e),old=hold('mpr-contour-raster'),completion=e.mpr.completeContour({...context,points:polygon()});await old.ready;assert.equal(e.busy.value,true);assert.equal(e.mpr.contourPending.value,true);
  const revision=e.revision.value,state=e.state.value,active=e.activeMask.value!,replacement=active.data.slice(),other=e.state.value.masks.find(mask=>mask.id!==active.id)!,otherData=other.data.slice(),raw=e.volume.value!.data.slice();
  e.state.value={...state,masks:state.masks.map(mask=>mask.id===active.id?{...mask,data:replacement}:mask)};
  assert.equal(e.revision.value,revision);assert.equal(e.mpr.contourDraft.value,null);assert.equal(e.busy.value,false);assert.equal(await completion,false);
  e.params.lower=25;e.params.upper=25;const global=hold('threshold'),preview=e.thresholdPreview();await global.ready;const pendingState=e.state.value;
  assert.equal(e.busy.value,true);assert.equal(e.preview.value,null);assert.equal(e.mpr.cancelContourGesture(context),false);e.mpr.cancelContour();old.release!();await nextTick();
  assert.equal(e.busy.value,true,'old contour result/cancel must leave unrelated worker ownership intact');assert.equal(e.state.value,pendingState);assert.equal(e.activeMask.value!.data,replacement);assert.equal(e.revision.value,revision);assert.equal(e.preview.value,null);
  global.release!();await preview;assert.equal(e.busy.value,false);assert.ok(e.preview.value?.every(n=>n===1));const completedPreview=e.preview.value;e.mpr.cancelContour();assert.equal(e.mpr.cancelContourGesture(context),false);assert.equal(e.preview.value,completedPreview);assert.equal(e.state.value,pendingState);assert.ok(replacement.every(n=>n===0));assert.deepEqual(e.volume.value!.data,raw);assert.deepEqual(e.state.value.masks.find(mask=>mask.id===other.id)!.data,otherData);
}));

test('caller points and published draft arrays cannot mutate a pending Lasso or the private LiveWire anchors/path',{timeout:15000},async()=>withEditor(async e=>{
  const context=begin(e),points=polygon(),raw=e.volume.value!.data.slice(),other=e.state.value.masks.find(mask=>mask.id!==context.activeMaskId)!.data.slice(),revision=e.revision.value,held=hold('mpr-contour-raster'),completion=e.mpr.completeContour({...context,points});await held.ready;
  points[0]![0]=400;points.length=0;context.mprPlane.origin[2]=500;const publicDraft=e.mpr.contourDraft.value!;publicDraft.points[0]![0]=-400;publicDraft.points.length=0;publicDraft.anchors.push([99,99,99]);publicDraft.mprPlane.origin[2]=999;
  held.release!();assert.equal(await completion,true);assert.deepEqual(e.activeMask.value!.data,filled());assert.equal(e.revision.value,revision+1);assert.deepEqual(e.volume.value!.data,raw);assert.deepEqual(e.state.value.masks.find(mask=>mask.id!==context.activeMaskId)!.data,other);
  e.undo();const wire=begin(e,'livewire'),anchors:Vec3[]=[[1,1,1],[2,1,1],[3,1,1],[3,2,1],[3,3,1],[2,3,1],[1,3,1],[1,2,1]];
  assert.equal(await e.mpr.contourPoint({...wire,position:anchors[0]!}),true);const shown=e.mpr.contourDraft.value!;shown.anchors[0]![0]=99;shown.points[0]![1]=99;shown.anchors.length=0;shown.points.length=0;
  for(const position of anchors.slice(1))assert.equal(await e.mpr.contourPoint({...wire,position}),true,e.error.value);
  assert.equal(e.mpr.contourDraft.value!.anchors.length,8);assert.deepEqual(e.mpr.contourDraft.value!.anchors[0],[1,1,1]);assert.equal(await e.mpr.completeContour(wire),true);assert.deepEqual(e.activeMask.value!.data,filled());assert.deepEqual(e.volume.value!.data,raw);assert.deepEqual(e.state.value.masks.find(mask=>mask.id!==wire.activeMaskId)!.data,other);
}));
