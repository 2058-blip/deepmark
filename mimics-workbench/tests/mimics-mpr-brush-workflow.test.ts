import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addMask,addPart,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MprPlane,Vec3} from '../src/mimics/types.ts';

// Real controller/worker exchange, synthetic images and a hand-derived source
// cell/slab oracle. This tests the independent application writeback policy;
// local native help does not establish arbitrary-RP brush kernel parity.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
const plain=(value:unknown)=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const plane=():MprPlane=>({origin:[0,0,.13],u:[2/Math.sqrt(5),0,1/Math.sqrt(5)],v:[0,1,0],size:[17,9]});
function fixture(size=5){
  const count=size**3,buffer=new ArrayBuffer(352+count*4),h=new DataView(buffer),bytes=new Uint8Array(buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[size,size,size].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,1,true);});h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);
  for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++)h.setFloat32(352+4*(x+size*(y+size*z)),100*x+10*y+z,true);
  const volume=parseNifti(buffer,'mpr-brush-workflow.nii');let state=createProject(volume);const a=state.selectedMaskId;state={...state,masks:state.masks.map(m=>({...m,name:'Edited source mask',data:Uint8Array.from({length:count},(_,i)=>Number(i%3===0)),threshold:[211,211],revision:3}))};state=addMask(state,count,'Independent overlapping mask',new Uint8Array(count).fill(1));const b=state.selectedMaskId;state={...state,selectedMaskId:a,masks:state.masks.map(m=>m.id===b?{...m,threshold:[40,50],revision:2}:m)};
  state=addPart(state,{positions:new Float32Array([0,0,1,4,0,1,0,4,1]),indices:new Uint32Array([0,1,2])},state.masks[0]);state.measurements=[{id:'historical-frame',name:'Fixed pre-existing world measurement',kind:'distance',points:[[0,0,.13],[0,1,.13]],mprPlane:plane(),pointPartIds:[state.selectedPartId,state.selectedPartId],labelOffset:[.1,-.2,.3],visible:true,color:'#abcdef'}];state.resliceObjects=[{id:'rp-brush',name:'Independent oblique RP',kind:'plane',plane:plane()},{id:'rp-other',name:'Other RP',kind:'plane',plane:{...plane(),origin:[0,0,10.13]}}];state.selectedResliceId='rp-brush';state.viewState={point:[2,2,2],activeAxis:2,tool:'navigate',mpr:{enabled:true,plane:plane(),step:.375,interpolation:'linear',crosshair:[2,2,1.13]}};return{volume,state,a,b,size};
}
async function withEditor(run:(e:Editor,input:ReturnType<typeof fixture>,exports:Uint8Array[])=>Promise<void>|void,size=5){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],e=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture(size);e.params.thresholdAutoPreview=false;
  try{assert.equal(await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'mpr-brush-fixture.zip')]),true);await nextTick();e.params.brushShape='square';e.params.sameWidthHeight=true;assert.equal(e.setBrushSize(100,100),true);await run(e,input,exports);}finally{e.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function source(e:Editor){return{volume:e.volume.value,data:e.volume.value!.data.slice(),header:e.volume.value!.header.slice(),affine:plain(e.volume.value!.affine),otherMasks:plain(e.state.value.masks.filter(m=>m.id!==e.state.value.selectedMaskId)),parts:plain(e.state.value.parts),measurements:plain(e.state.value.measurements),reslices:plain(e.state.value.resliceObjects),selectedReslice:e.state.value.selectedResliceId,point:[...e.point.value],crosshair:plain(e.mpr.crosshair.value)};}
function assertSource(e:Editor,s:ReturnType<typeof source>,editedId=e.state.value.selectedMaskId){assert.equal(e.volume.value,s.volume);assert.deepEqual(e.volume.value!.data,s.data);assert.deepEqual(e.volume.value!.header,s.header);assert.deepEqual(plain(e.volume.value!.affine),s.affine);assert.deepEqual(plain(e.state.value.masks.filter(m=>m.id!==editedId)),s.otherMasks);assert.deepEqual(plain(e.state.value.parts),s.parts);assert.deepEqual(plain(e.state.value.measurements),s.measurements);assert.deepEqual(plain(e.state.value.resliceObjects),s.reslices);assert.equal(e.state.value.selectedResliceId,s.selectedReslice);assert.deepEqual(e.point.value,s.point);assert.deepEqual(plain(e.mpr.crosshair.value),s.crosshair);}
function invariant(e:Editor){return{state:e.state.value,revision:e.revision.value,dirty:e.dirty.value,undo:e.undoName.value,redo:e.redoName.value,view:plain(e.mpr.snapshot())};}
function assertInvariant(e:Editor,s:ReturnType<typeof invariant>){assert.equal(e.state.value,s.state);assert.equal(e.revision.value,s.revision);assert.equal(e.dirty.value,s.dirty);assert.equal(e.undoName.value,s.undo);assert.equal(e.redoName.value,s.redo);assert.deepEqual(plain(e.mpr.snapshot()),s.view);}
let nextTestStrokeId=0;
const context=(e:Editor)=>({strokeId:++nextTestStrokeId,activeMaskId:e.state.value.selectedMaskId,mprPlane:e.mpr.plane.value!,volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value});
const position:Vec3=[2,2,1.13];
function changedDraft(e:Editor){const epoch=context(e);assert.equal(e.mpr.beginBrush(epoch),true);assert.equal(e.mpr.brushStroke({...epoch,position,startSegment:true}),true);assert.ok(e.mpr.brushPreview.value);assert.notDeepEqual(e.mpr.brushPreview.value,e.activeMask.value!.data);return epoch;}
// For the identity source cells and z=x/2+.13, the closed projected cell slab
// reduces to |-x+2z-.26| <= 1.5. Integer source centers therefore have 2z-x=-1,0,1.
function expected(initial:Uint8Array,raw:Float32Array,operation:'paint'|'erase'|'local-threshold',range:[number,number]=[211,211]){const out=initial.slice();for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<5;x++){if(![-1,0,1].includes(2*z-x))continue;const i=x+5*(y+5*z);out[i]=operation==='paint'?1:operation==='erase'?0:Number(raw[i]!>=range[0]&&raw[i]!<=range[1]);}return out;}

test('an oblique MPR paint/erase stroke edits only source-cell membership, previews privately, and commits one exact Undo/Redo transaction',async()=>withEditor(async(e,input)=>{
  const raw=source(e),initial=e.activeMask.value!.data.slice(),maskRevision=e.activeMask.value!.revision;
  for(const operation of ['paint','erase'] as const){e.tool.value=operation;const before=invariant(e),epoch=changedDraft(e),preview=e.mpr.brushPreview.value!;assert.equal(e.mpr.brushStroke({...epoch,position:[2.1,2.05,1.18]}),true);assert.deepEqual(e.mpr.brushPreview.value,expected(initial,e.volume.value!.data,operation));assert.deepEqual(e.activeMask.value!.data,initial);assert.equal(e.activeMask.value!.revision,maskRevision);assertInvariant(e,before);assert.notEqual(preview,e.activeMask.value!.data);assertSource(e,raw,input.a);
    assert.equal(e.mpr.endBrush(epoch),true);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.revision.value,before.revision+1);assert.equal(e.activeMask.value!.revision,maskRevision+1);assert.deepEqual(e.activeMask.value!.data,expected(initial,e.volume.value!.data,operation));assert.deepEqual(e.activeMask.value!.threshold,[211,211]);assertSource(e,raw,input.a);const committed=invariant(e);assert.equal(e.mpr.endBrush(epoch),false);assertInvariant(e,committed);
    e.undo();assert.deepEqual(e.activeMask.value!.data,initial);assert.equal(e.activeMask.value!.revision,maskRevision);assert.equal(e.undoName.value,'');e.undo(true);assert.deepEqual(e.activeMask.value!.data,expected(initial,e.volume.value!.data,operation));e.undo();assertSource(e,raw,input.a);
  }
}));

test('MPR local threshold evaluates original source intensities independently of display interpolation or output sampling resolution',async()=>withEditor(async(e,input,exports)=>{
  const raw=source(e),initial=e.activeMask.value!.data.slice(),wanted=expected(initial,e.volume.value!.data,'local-threshold');e.tool.value='local-threshold';e.params.lower=1000;e.params.upper=1000;
  assert.equal(e.volume.value!.data[32],211);assert.equal(initial[32],0);assert.equal(wanted[32],1,'the original source value must be added even when its projected displayed value differs');
  for(const interpolation of ['linear','nearest'] as const){const base=plane(),view=interpolation==='linear'?base:{origin:[...base.origin] as Vec3,u:base.u.map(n=>n/2) as Vec3,v:base.v.map(n=>n/2) as Vec3,size:[33,17] as [number,number]};assert.equal(e.mpr.setPlane(view),true);e.mpr.setInterpolation(interpolation);const epoch=changedDraft(e);assert.deepEqual(e.mpr.brushPreview.value,wanted);assert.deepEqual(e.activeMask.value!.data,initial);assert.equal(e.mpr.endBrush(epoch),true);assert.deepEqual(e.activeMask.value!.data,wanted);assert.deepEqual(e.activeMask.value!.threshold,[211,211]);assert.deepEqual([e.params.lower,e.params.upper],[1000,1000]);assertSource(e,raw,input.a);e.undo();assert.deepEqual(e.activeMask.value!.data,initial);}
  e.undo(true);assert.equal((await e.saveProject())?.status,'written');const saved=decodeProject(exports.at(-1)!);assert.deepEqual(saved.state.masks.find(m=>m.id===input.a)!.data,wanted);assert.deepEqual(saved.state.masks.find(m=>m.id===input.a)!.threshold,[211,211]);assert.deepEqual(saved.state.masks.find(m=>m.id===input.b)!.data,e.state.value.masks.find(m=>m.id===input.b)!.data);assert.deepEqual(saved.volume.data,raw.data);validateProject(saved.volume,saved.state);
}));

test('MPR brush begin, continuation and release require full current plane, document, pose and active-Mask context; invalid continuation cancels the whole preview',async()=>withEditor(async(e,input)=>{
  e.tool.value='paint';const raw=source(e),before=invariant(e);
  function invalidContexts(valid:ReturnType<typeof context>){const invalid:unknown[]=[undefined,null];for(const field of ['strokeId','activeMaskId','mprPlane','volume','revision','mprRevision'] as const){const omitted={...valid} as any;delete omitted[field];invalid.push(omitted,{...valid,[field]:undefined});}
    for(const strokeId of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1'])invalid.push({...valid,strokeId});
    invalid.push({...valid,activeMaskId:input.b},{...valid,activeMaskId:e.state.value.selectedPartId},{...valid,volume:{...valid.volume}},{...valid,revision:valid.revision+1},{...valid,mprRevision:valid.mprRevision+1},{...valid,mprPlane:{...valid.mprPlane,origin:[0,0,1.13]}},{...valid,mprPlane:{...valid.mprPlane,size:[18,9]}});return invalid;}
  const invalid=invalidContexts(context(e));for(const value of invalid){assert.equal(e.mpr.beginBrush(value as any),false);assert.equal(e.mpr.brushPreview.value,null);assertInvariant(e,before);}
  for(let i=0;i<invalid.length;i++){const epoch=changedDraft(e),value=invalidContexts(epoch)[i];assert.equal(e.mpr.brushStroke({...value as any,position}),false);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.endBrush(epoch),false);assertInvariant(e,before);}
  for(const invalidPosition of [[2,2,1.5],[NaN,2,1.13],[2,2],undefined]){const epoch=changedDraft(e);assert.equal(e.mpr.brushStroke({...epoch,position:invalidPosition} as any),false);assert.equal(e.mpr.brushPreview.value,null);assertInvariant(e,before);}
  for(let i=0;i<invalid.length;i++){const epoch=changedDraft(e),value=invalidContexts(epoch)[i];assert.equal(e.mpr.endBrush(value as any),false);assert.equal(e.mpr.brushPreview.value,null);assertInvariant(e,before);}assertSource(e,raw,input.a);
}));

test('MPR brush Cancel, same-plane pose cycles, Mask selection cycles and brush-size cycles never publish an earlier partial stroke',async()=>withEditor(async(e,input)=>{
  e.tool.value='paint';const raw=source(e),initial=e.activeMask.value!.data.slice(),revision=e.revision.value;
  let old=changedDraft(e);e.mpr.cancelBrush();assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.endBrush(old),false);assert.equal(e.revision.value,revision);assert.deepEqual(e.activeMask.value!.data,initial);
  old=changedDraft(e);assert.equal(e.mpr.setPlane({...plane(),origin:[0,0,1.13]}),true);assert.equal(e.mpr.setPlane(plane()),true);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.brushStroke({...old,position}),false);assert.equal(e.mpr.endBrush(context(e)),false);assert.equal(e.revision.value,revision);assert.deepEqual(e.activeMask.value!.data,initial);
  old=changedDraft(e);e.selectMask(input.b);e.selectMask(input.a);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.brushStroke({...old,position}),false);assert.equal(e.mpr.endBrush(context(e)),false);assert.equal(e.revision.value,revision);assert.deepEqual(e.activeMask.value!.data,initial);
  old=changedDraft(e);e.setBrushSize(80,80);e.setBrushSize(100,100);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.brushStroke({...old,position}),false);assert.equal(e.mpr.endBrush(context(e)),false);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,'');assert.equal(e.dirty.value,false);assert.deepEqual(e.activeMask.value!.data,initial);assertSource(e,raw,input.a);
  changedDraft(e);e.mpr.close();assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.endBrush(context(e)),false);assert.equal(e.revision.value,revision);assert.deepEqual(e.activeMask.value!.data,initial);assertSource(e,raw,input.a);
}));

test('MPR local-threshold range changes cancel its draft while unrelated global controls and inactive presets leave source-value evaluation unchanged',async()=>withEditor(async(e,input)=>{
  e.tool.value='local-threshold';const raw=source(e),initial=e.activeMask.value!.data.slice();assert.equal(e.localThreshold.update(0,'upper',213),true);assert.equal(e.localThreshold.update(0,'lower',210),true);assert.equal(e.localThreshold.choose(0),true);let epoch=changedDraft(e),preview=e.mpr.brushPreview.value;
  e.params.lower=0;e.params.upper=0;assert.equal(e.localThreshold.update(2,'upper',215),true);assert.equal(e.mpr.brushPreview.value,preview);assert.deepEqual(e.mpr.brushPreview.value,expected(initial,e.volume.value!.data,'local-threshold',[210,213]));assert.equal(e.mpr.endBrush(epoch),true);assert.deepEqual(e.activeMask.value!.threshold,[211,211]);e.undo();assert.deepEqual(e.activeMask.value!.data,initial);
  epoch=changedDraft(e);assert.equal(e.localThreshold.choose(1),true);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.endBrush(epoch),false);assert.deepEqual(e.activeMask.value!.data,initial);assert.equal(e.undoName.value,'');assertSource(e,raw,input.a);
}));

test('failed MPR brush history allocation clears the private preview and preserves source, clean state and a real redo branch',async()=>withEditor(async(e,input)=>{
  e.updateMask(input.a,{name:'Temporary name'});e.undo();assert.ok(e.redoName.value);e.tool.value='paint';await e.saveProject();const raw=source(e),before=invariant(e),epoch=changedDraft(e),push=ProjectHistory.prototype.push;let calls=0;ProjectHistory.prototype.push=function(){calls++;throw new Error('MPR brush audit intentional history allocation failure');};
  try{assert.equal(e.mpr.endBrush(epoch),false);assert.equal(calls,1,'one valid release reaches one real commit boundary');}finally{ProjectHistory.prototype.push=push;}
  assert.equal(e.mpr.brushPreview.value,null);assertInvariant(e,before);assertSource(e,raw,input.a);assert.match(e.error.value,/MPR brush audit intentional/);const retry=changedDraft(e);assert.equal(e.mpr.endBrush(retry),true);assert.equal(e.revision.value,before.revision+1);assert.equal(e.redoName.value,'');assertSource(e,raw,input.a);
}));

test('cumulative MPR brush scan-budget failure discards an already changed private preview without a half commit',async()=>withEditor(async(e,input)=>{
  const bulkPlane:MprPlane={origin:[0,0,.13],u:[Math.SQRT1_2,0,Math.SQRT1_2],v:[0,1,0],size:[200,80]};assert.equal(e.mpr.setPlane(bulkPlane),true);e.tool.value='paint';assert.equal(e.setBrushSize(500,500),true);const initial=e.activeMask.value!.data.slice(),before=invariant(e),raw=e.volume.value!.data.slice(),other=e.state.value.masks.find(m=>m.id===input.b)!.data.slice(),epoch=context(e);
  assert.equal(e.mpr.beginBrush(epoch),true);assert.equal(e.mpr.brushStroke({...epoch,position:[30,30,30.13],startSegment:true}),true);assert.ok(e.mpr.brushPreview.value);assert.notDeepEqual(e.mpr.brushPreview.value,initial);let rejected=false,samples=1;
  for(;samples<80;samples++){const delta=samples*.001;if(!e.mpr.brushStroke({...epoch,position:[30+delta,30,30.13+delta]})){rejected=true;break;}}
  assert.equal(rejected,true,'overlapping but distinct segments must still consume the whole-stroke scan budget');assert.ok(samples>1);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.mpr.endBrush(epoch),false);assertInvariant(e,before);assert.deepEqual(e.activeMask.value!.data,initial);assert.deepEqual(e.volume.value!.data,raw);assert.deepEqual(e.state.value.masks.find(m=>m.id===input.b)!.data,other);assert.match(e.error.value,/扫描|scan|预算|budget|候选|上限|超过/i);
},64));

test('cancel and restart at an identical document epoch cannot replay the previous stroke or erase the new stroke preview',async()=>withEditor(async(e,input)=>{
  e.tool.value='paint';const raw=source(e),initial=e.activeMask.value!.data.slice(),before=invariant(e),old=changedDraft(e);e.mpr.cancelBrush();const fresh=changedDraft(e);assert.notEqual(fresh.strokeId,old.strokeId);assert.equal(fresh.volume,old.volume);assert.equal(fresh.revision,old.revision);assert.equal(fresh.mprRevision,old.mprRevision);assert.equal(fresh.activeMaskId,old.activeMaskId);assert.deepEqual(fresh.mprPlane,old.mprPlane);
  const preview=e.mpr.brushPreview.value!,bytes=preview.slice(),previewRevision=e.mpr.brushPreviewRevision.value;const unchanged=()=>{assert.equal(e.mpr.brushPreview.value,preview);assert.deepEqual(e.mpr.brushPreview.value,bytes);assert.equal(e.mpr.brushPreviewRevision.value,previewRevision);assertInvariant(e,before);assertSource(e,raw,input.a);};
  assert.equal(e.mpr.beginBrush(old),false);unchanged();assert.equal(e.mpr.brushStroke({...old,position:[2.1,2.05,1.18]}),false);unchanged();assert.equal(e.mpr.endBrush(old),false);unchanged();assert.equal(e.mpr.cancelBrushGesture(old),false);unchanged();
  const invalidCancels:unknown[]=[undefined,null,{...fresh,strokeId:0},{...fresh,strokeId:-1},{...fresh,activeMaskId:input.b},{...fresh,volume:{...fresh.volume}},{...fresh,revision:fresh.revision+1},{...fresh,mprRevision:fresh.mprRevision+1},{...fresh,mprPlane:{...fresh.mprPlane,origin:[0,0,1.13]}}];for(const field of ['strokeId','activeMaskId','mprPlane','volume','revision','mprRevision'] as const){const omitted={...fresh} as any;delete omitted[field];invalidCancels.push(omitted,{...fresh,[field]:undefined});}
  for(const value of invalidCancels){assert.equal(e.mpr.cancelBrushGesture(value as any),false);unchanged();}
  assert.equal(e.mpr.endBrush(fresh),true);assert.equal(e.mpr.brushPreview.value,null);assert.equal(e.revision.value,before.revision+1);assert.deepEqual(e.activeMask.value!.data,expected(initial,e.volume.value!.data,'paint'));assertSource(e,raw,input.a);
  e.tool.value='erase';const cancelEpoch=changedDraft(e),beforeCancel=invariant(e);assert.equal(e.mpr.cancelBrushGesture(fresh),false);assert.ok(e.mpr.brushPreview.value);assert.equal(e.mpr.cancelBrushGesture(cancelEpoch),true);assert.equal(e.mpr.brushPreview.value,null);assertInvariant(e,beforeCancel);assert.equal(e.mpr.endBrush(cancelEpoch),false);assertSource(e,raw,input.a);
}));
