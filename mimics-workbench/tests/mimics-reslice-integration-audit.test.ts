import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addPart,createProject,encodeProject,ProjectHistory} from '../src/mimics/project.ts';
import {mprPlaneCenter} from '../src/mimics/mpr.ts';
import {sourceSliceMprPlane} from '../src/mimics/mprInteraction.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MprPlane,Vec3} from '../src/mimics/types.ts';

// Independent controller counterexamples. Worker exchange is real; browser
// pointer picking and original-runtime behaviour are outside this audit.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
const normal=(value:unknown)=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
function fixture(){
  const bytes=new Uint8Array(352+75),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[5,5,3].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,[2,3,4][a]!,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);for(let i=0;i<75;i++)bytes[352+i]=i;
  const volume=parseNifti(bytes.buffer,'rp-independent-audit.nii');let state=createProject(volume);state.masks[0]!.data[10]=state.masks[0]!.data[11]=1;state=addPart(state,{positions:new Float32Array([0,0,4,8,0,4,0,12,4]),indices:new Uint32Array([0,1,2])},state.masks[0]);state.measurements=[{id:'historical-mpr',name:'Fixed historical geometry',kind:'distance',points:[[2,3,4],[4,3,4]],mprPlane:{origin:[0,0,4],u:[2,0,0],v:[0,3,0],size:[5,5]},partId:state.selectedPartId,pointPartIds:[state.selectedPartId,state.selectedPartId],labelOffset:[.125,-.25,.5],visible:true,color:'#abcdef'}];state.viewState={point:[2,2,1],activeAxis:2,tool:'navigate'};return{volume,state};
}
async function withEditor(run:(e:Editor)=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),e=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{await request.produce();return{status:'written',name:request.name};}}))!,input=fixture();e.params.thresholdAutoPreview=false;
  try{assert.equal(await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'rp-audit.zip')]),true);await nextTick();await run(e);}finally{e.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function source(e:Editor){return{volume:e.volume.value,data:e.volume.value!.data.slice(),header:e.volume.value!.header.slice(),affine:normal(e.volume.value!.affine),masks:normal(e.state.value.masks),parts:normal(e.state.value.parts),measurements:normal(e.state.value.measurements),point:[...e.point.value]};}
function assertSource(e:Editor,s:ReturnType<typeof source>){assert.equal(e.volume.value,s.volume);assert.deepEqual(e.volume.value!.data,s.data);assert.deepEqual(e.volume.value!.header,s.header);assert.deepEqual(normal(e.volume.value!.affine),s.affine);assert.deepEqual(normal(e.state.value.masks),s.masks);assert.deepEqual(normal(e.state.value.parts),s.parts);assert.deepEqual(normal(e.state.value.measurements),s.measurements);assert.deepEqual(e.point.value,s.point);}
function invariant(e:Editor){return{state:e.state.value,revision:e.revision.value,dirty:e.dirty.value,undo:e.undoName.value,redo:e.redoName.value,view:normal(e.mpr.snapshot()),interactive:e.mpr.interactive.value};}
function assertInvariant(e:Editor,s:ReturnType<typeof invariant>){assert.equal(e.state.value,s.state);assert.equal(e.revision.value,s.revision);assert.equal(e.dirty.value,s.dirty);assert.equal(e.undoName.value,s.undo);assert.equal(e.redoName.value,s.redo);assert.deepEqual(normal(e.mpr.snapshot()),s.view);assert.equal(e.mpr.interactive.value,s.interactive);}
function rejectedCommit(run:()=>boolean){
  const previous=ProjectHistory.prototype.push;let calls=0;ProjectHistory.prototype.push=function(){calls++;throw new Error('audit intentional history allocation failure');};
  try{assert.equal(run(),false);assert.equal(calls,1,'the candidate must reach the real commit boundary');}finally{ProjectHistory.prototype.push=previous;}
}
const shifted=(p:MprPlane,d:Vec3):MprPlane=>({origin:p.origin.map((n,a)=>n+d[a]!) as Vec3,u:[...p.u],v:[...p.v],size:[...p.size]});
const epoch=(e:Editor,sourcePlane=e.mpr.planes.value[0]!)=>({volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value,sourcePlane});

test('a new successful three-point definition adds another RP instead of overwriting the previously selected RP',async()=>withEditor(async e=>{
  const raw=source(e);assert.equal(e.mpr.startInteractive(),true);const previous=normal(e.reslices.selected.value),revision=e.revision.value;assert.equal(e.mpr.beginDefinition(),true);for(const position of [[2,3,4],[8,3,4],[2,12,8]] as Vec3[])assert.equal(e.mpr.addDefinitionPoint(position),true);
  assert.equal(e.state.value.resliceObjects!.length,2,'every completed new plane definition belongs in the RP collection');const created=e.reslices.selected.value!;assert.notEqual(created.id,previous.id);assert.deepEqual(normal(e.state.value.resliceObjects!.find(o=>o.id===previous.id)),previous);assert.deepEqual(created.plane,e.mpr.plane.value);assert.equal(e.revision.value,revision+1);assertSource(e,raw);
  e.undo();assert.deepEqual(normal(e.state.value.resliceObjects),[previous]);assert.equal(e.state.value.selectedResliceId,previous.id);e.undo(true);assert.equal(e.state.value.resliceObjects!.length,2);assert.equal(e.state.value.selectedResliceId,created.id);assertSource(e,raw);
}));

test('failed Euler, blue transform and three-point commits restore the independent browsed view and preserve a real redo branch',async()=>withEditor(async e=>{
  const raw=source(e);e.mpr.startInteractive();const id=e.reslices.selected.value!.id;e.reslices.rename(id,'Temporary name');e.undo();assert.ok(e.redoName.value);e.mpr.locate([3.125,5.25,4.5]);e.mpr.scroll({distanceMm:.375,plane:e.mpr.planes.value[0]!});e.mpr.close();await e.saveProject();assert.equal(e.dirty.value,false);const before=invariant(e),oldPose=e.mpr.poseRevision.value;
  e.mpr.rotation.value=[17,23,-31];rejectedCommit(()=>e.mpr.applyOrientation());assertInvariant(e,before);assert.notEqual(e.mpr.poseRevision.value,oldPose);assert.match(e.error.value,/audit intentional/);assertSource(e,raw);
  const object=e.reslices.selected.value!,center=mprPlaneCenter(object.plane),sourcePlane=sourceSliceMprPlane(e.grid.value!,2,e.point.value[2]);rejectedCommit(()=>e.mpr.transform({plane:shifted(object.plane,[.5,-.25,0]),crosshair:[center[0]+.5,center[1]-.25,center[2]],...epoch(e,sourcePlane)}));assertInvariant(e,before);assertSource(e,raw);
  e.mpr.beginDefinition();assert.equal(e.mpr.interactive.value,false);e.mpr.addDefinitionPoint([2,3,4]);e.mpr.addDefinitionPoint([8,3,4]);const definitionBefore=invariant(e);rejectedCommit(()=>e.mpr.addDefinitionPoint([2,12,8]));assertInvariant(e,definitionBefore);assert.equal(e.mpr.defining.value,false);assertSource(e,raw);
}));

test('failed first MPR open and interactive entry cannot leave a phantom RP or a changed view',async()=>withEditor(async e=>{
  const raw=source(e),before=invariant(e);assert.equal(e.mpr.snapshot(),undefined);rejectedCommit(()=>e.mpr.open());assertInvariant(e,before);assert.equal(e.state.value.resliceObjects,undefined);assert.equal(e.state.value.selectedResliceId,undefined);assert.equal(e.mpr.plane.value,null);assert.equal(e.mpr.enabled.value,false);
  rejectedCommit(()=>e.mpr.startInteractive());assertInvariant(e,before);assert.equal(e.state.value.resliceObjects,undefined);assertSource(e,raw);
}));

test('switching between identical RP frames and back invalidates an old blue payload even without a document revision or source-plane change',async()=>withEditor(async e=>{
  e.mpr.startInteractive();const first=e.reslices.selected.value!.id;e.reslices.duplicate();const second=e.reslices.selected.value!.id;assert.notEqual(first,second);await e.saveProject();const raw=source(e),base=e.reslices.selected.value!.plane,c=mprPlaneCenter(base),payload={plane:shifted(base,[.5,-.25,0]),crosshair:[c[0]+.5,c[1]-.25,c[2]] as Vec3,...epoch(e)};
  e.reslices.select(first);e.reslices.select(second);assert.equal(e.revision.value,payload.revision);assert.deepEqual(e.mpr.planes.value[0],payload.sourcePlane);assert.notEqual(e.mpr.poseRevision.value,payload.mprRevision);const before=invariant(e);assert.equal(e.mpr.transform(payload),false);assertInvariant(e,before);assertSource(e,raw);
  assert.equal(e.mpr.transform({...payload,...epoch(e)}),true);assert.equal(e.revision.value,before.revision+1);assertSource(e,raw);
}));
