import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addPart,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import {mprPlaneCenter} from '../src/mimics/mpr.ts';
import {sourceSliceMprPlane} from '../src/mimics/mprInteraction.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MprPlane,Vec3} from '../src/mimics/types.ts';

// Independent controller audit: uses the real worker exchange and a hand-built
// oblique frame. These checks do not establish native pointer or render parity.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
const plain=(value:unknown)=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const nearPoint=(a:readonly number[],b:readonly number[])=>a.forEach((n,i)=>near(n,b[i]!));
const oblique=():MprPlane=>({origin:[4,1,3],u:[0,1.2,1.6],v:[3,0,0],size:[7,5]});
function fixture(){
  const bytes=new Uint8Array(352+125),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[5,5,5].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,[2,3,4][a]!,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);for(let i=0;i<125;i++)bytes[352+i]=i;
  const volume=parseNifti(bytes.buffer,'rp-gizmo-controller-audit.nii');let state=createProject(volume);state.masks[0]!.data[10]=state.masks[0]!.data[11]=1;state=addPart(state,{positions:new Float32Array([0,0,4,8,0,4,0,12,4]),indices:new Uint32Array([0,1,2])},state.masks[0]);
  state.measurements=[{id:'fixed-measurement',name:'Existing attached MPR geometry',kind:'distance',points:[[4,1,3],[4,2.2,4.6]],mprPlane:oblique(),pointPartIds:[state.selectedPartId,state.selectedPartId],labelOffset:[.125,-.25,.5],visible:true,color:'#abcdef'}];
  state.resliceObjects=[{id:'rp-gizmo',name:'RP oblique',kind:'plane',plane:oblique()},{id:'rp-other',name:'RP untouched',kind:'plane',plane:{...oblique(),origin:[40,1,3]}}];state.selectedResliceId='rp-gizmo';state.viewState={point:[2,2,1],activeAxis:2,tool:'navigate',mpr:{enabled:false,plane:{...oblique(),origin:[4,2.6,1.8]},crosshair:[3.125,5.25,4.5],step:.375,interpolation:'nearest'}};return{volume,state};
}
async function withEditor(run:(e:Editor,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],e=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();e.params.thresholdAutoPreview=false;
  try{assert.equal(await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'rp-gizmo-audit.zip')]),true);await nextTick();await run(e,exports);}finally{e.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function source(e:Editor){return{volume:e.volume.value,data:e.volume.value!.data.slice(),header:e.volume.value!.header.slice(),affine:plain(e.volume.value!.affine),masks:plain(e.state.value.masks),parts:plain(e.state.value.parts),measurements:plain(e.state.value.measurements),point:[...e.point.value],other:plain(e.state.value.resliceObjects!.find(o=>o.id==='rp-other'))};}
function assertSource(e:Editor,s:ReturnType<typeof source>){assert.equal(e.volume.value,s.volume);assert.deepEqual(e.volume.value!.data,s.data);assert.deepEqual(e.volume.value!.header,s.header);assert.deepEqual(plain(e.volume.value!.affine),s.affine);assert.deepEqual(plain(e.state.value.masks),s.masks);assert.deepEqual(plain(e.state.value.parts),s.parts);assert.deepEqual(plain(e.state.value.measurements),s.measurements);assert.deepEqual(e.point.value,s.point);assert.deepEqual(plain(e.state.value.resliceObjects!.find(o=>o.id==='rp-other')),s.other);}
function invariant(e:Editor){return{state:e.state.value,revision:e.revision.value,dirty:e.dirty.value,undo:e.undoName.value,redo:e.redoName.value,view:plain(e.mpr.snapshot()),pose:e.mpr.poseRevision.value,interactive:e.mpr.interactive.value};}
function assertInvariant(e:Editor,s:ReturnType<typeof invariant>){assert.equal(e.state.value,s.state);assert.equal(e.revision.value,s.revision);assert.equal(e.dirty.value,s.dirty);assert.equal(e.undoName.value,s.undo);assert.equal(e.redoName.value,s.redo);assert.deepEqual(plain(e.mpr.snapshot()),s.view);assert.equal(e.mpr.poseRevision.value,s.pose);assert.equal(e.mpr.interactive.value,s.interactive);}
const shifted=(p:MprPlane,d:Vec3):MprPlane=>({origin:p.origin.map((n,a)=>n+d[a]!) as Vec3,u:[...p.u],v:[...p.v],size:[...p.size]});
const epoch=(e:Editor)=>({volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value});
const modifyEpoch=(e:Editor)=>({volume:e.volume.value!,revision:e.revision.value,resliceRevision:e.mpr.poseRevision.value});
const resized=():MprPlane=>({origin:[7,-2.6,-1.8],u:[0,2.4,3.2],v:[1.5,0,0],size:[7,5]});

test('blue drops require the complete document and pose epoch even when a matching selected RP and source slice exist',async()=>withEditor(async e=>{
  assert.equal(e.mpr.editInteractive('rp-gizmo'),true);e.reslices.rename('rp-gizmo','Temporary');e.undo();assert.ok(e.redoName.value);e.mpr.close();await e.saveProject();
  const raw=source(e),base=e.reslices.selected.value!.plane,c=mprPlaneCenter(base),payload={plane:shifted(base,[.5,-.25,0]),crosshair:[c[0]+.5,c[1]-.25,c[2]] as Vec3,sourcePlane:sourceSliceMprPlane(e.grid.value!,2,e.point.value[2]),...epoch(e)},before=invariant(e);
  for(const field of ['volume','revision','mprRevision'] as const){
    const omitted={...payload} as any;delete omitted[field];assert.equal(e.mpr.transform(omitted),false,`missing ${field}`);assertInvariant(e,before);
    assert.equal(e.mpr.transform({...payload,[field]:undefined} as any),false,`undefined ${field}`);assertInvariant(e,before);
  }
  assertSource(e,raw);assert.equal(e.mpr.transform(payload),true);assert.equal(e.revision.value,before.revision+1);assert.equal(e.redoName.value,'');assertSource(e,raw);
}));

test('3D RP Resize preserves unequal sample counts, changes only physical FOV, and retains disabled layout through Undo, Redo and ZIP',async()=>withEditor(async(e,exports)=>{
  const raw=source(e),white=[...e.mpr.crosshair.value!],step=e.mpr.step.value,interpolation=e.mpr.interpolation.value;
  assert.equal(e.mpr.enabled.value,false);assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);assert.equal(e.mpr.enabled.value,false);const before=plain(e.reslices.selected.value),revision=e.revision.value,next=resized(),payload={id:'rp-gizmo',plane:next,action:'resize' as const,...modifyEpoch(e)};
  assert.equal(e.mpr.modifyPlane(payload),true);assert.equal(e.revision.value,revision+1);assert.deepEqual(e.reslices.selected.value!.plane,next);assert.deepEqual(next.size,[7,5]);nearPoint(mprPlaneCenter(next),[10,4.6,7.8]);near(next.size[0]*Math.hypot(...next.u),28);near(next.size[1]*Math.hypot(...next.v),7.5);assert.equal(e.mpr.enabled.value,false);assert.deepEqual(e.mpr.plane.value,next);assert.deepEqual(e.mpr.crosshair.value,white);assert.equal(e.mpr.step.value,step);assert.equal(e.mpr.interpolation.value,interpolation);assertSource(e,raw);
  const committed=plain(e.reslices.selected.value),after=invariant(e);assert.equal(e.mpr.modifyPlane(payload),false);assertInvariant(e,after);
  e.undo();assert.deepEqual(plain(e.reslices.selected.value),before);assert.equal(e.mpr.enabled.value,false);assertSource(e,raw);e.undo(true);assert.deepEqual(plain(e.reslices.selected.value),committed);assert.equal(e.mpr.enabled.value,false);assert.deepEqual(e.mpr.crosshair.value,white);assert.equal(e.mpr.step.value,step);assert.equal(e.mpr.interpolation.value,interpolation);assertSource(e,raw);
  assert.equal((await e.saveProject())?.status,'written');const bytes=exports.at(-1)!,decoded=decodeProject(bytes);assert.deepEqual(plain(decoded.state.resliceObjects!.find(o=>o.id==='rp-gizmo')),committed);assert.equal(decoded.state.viewState!.mpr!.enabled,false);assert.deepEqual(decoded.state.viewState!.mpr!.plane,next);assert.deepEqual(decoded.state.viewState!.mpr!.crosshair,white);assert.equal(decoded.state.viewState!.mpr!.step,step);assert.equal(decoded.state.viewState!.mpr!.interpolation,interpolation);
  const stale={id:'rp-gizmo',plane:oblique(),action:'resize' as const,...modifyEpoch(e)};assert.equal(await e.openFiles([new File([bytes.slice().buffer as ArrayBuffer],'rp-resize-restored.zip')]),true);assert.equal(e.mpr.enabled.value,false);assert.equal(e.state.value.selectedResliceId,'rp-gizmo');assert.deepEqual(e.reslices.selected.value!.plane,next);assert.deepEqual(e.mpr.crosshair.value,white);assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');assert.equal(e.redoName.value,'');assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);const restored=invariant(e);assert.equal(e.mpr.modifyPlane(stale),false);assertInvariant(e,restored);
  // ZIP installs replace source identity while retaining the complete geometry.
  const restoredSource=source(e);assert.notEqual(restoredSource.volume,raw.volume);assert.deepEqual(restoredSource.data,raw.data);assert.deepEqual(restoredSource.header,raw.header);assert.deepEqual(restoredSource.affine,raw.affine);assert.deepEqual(restoredSource.masks,raw.masks);assert.deepEqual(restoredSource.parts,raw.parts);assert.deepEqual(restoredSource.measurements,raw.measurements);assert.deepEqual(restoredSource.other,raw.other);validateProject(e.volume.value!,e.state.value);
}));

test('3D Modify rejects incomplete epochs, foreign objects, wrong actions, sample-count edits and non-resize geometry without disturbing redo',async()=>withEditor(async e=>{
  e.reslices.rename('rp-gizmo','Temporary');e.undo();assert.ok(e.redoName.value);assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);await e.saveProject();const raw=source(e),payload={id:'rp-gizmo',plane:resized(),action:'resize' as const,...modifyEpoch(e)},before=invariant(e);
  for(const field of ['id','action','volume','revision','resliceRevision'] as const){const omitted={...payload} as any;delete omitted[field];assert.equal(e.mpr.modifyPlane(omitted),false,`missing ${field}`);assertInvariant(e,before);assert.equal(e.mpr.modifyPlane({...payload,[field]:undefined} as any),false,`undefined ${field}`);assertInvariant(e,before);}
  const reversed={...resized(),u:[0,-2.4,-3.2] as Vec3,origin:[7,11.8,17.4] as Vec3},quarterTurn:MprPlane={origin:[4,8.2,12.6],u:[2,0,0],v:[0,-1.8,-2.4],size:[7,5]};
  const invalid:unknown[]=[{...payload,id:'rp-other'},{...payload,id:e.state.value.selectedPartId},{...payload,volume:{...e.volume.value!}},{...payload,revision:payload.revision+1},{...payload,resliceRevision:payload.resliceRevision+1},{...payload,action:'rotate',plane:quarterTurn},{...payload,action:'unknown'},{...payload,plane:{...resized(),size:[8,5],origin:[7,-3.8,-3.4]}},{...payload,plane:shifted(resized(),[.25,0,0])},{...payload,plane:reversed},{...payload,plane:quarterTurn}];
  for(const value of invalid){assert.equal(e.mpr.modifyPlane(value as any),false);assertInvariant(e,before);}assertSource(e,raw);
  const old=payload;e.reslices.select('rp-other');e.reslices.select('rp-gizmo');assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);const selected=invariant(e);assert.equal(e.mpr.modifyPlane(old),false,'returning to the same selected frame cannot refresh an earlier epoch');assertInvariant(e,selected);assertSource(e,raw);
  const fresh={...payload,...modifyEpoch(e)};assert.equal(e.mpr.modifyPlane(fresh),true);assert.equal(e.revision.value,before.revision+1);assert.equal(e.redoName.value,'');assertSource(e,raw);
}));

test('3D Rotate mode moves in the RP plane and turns around its normal as distinct single reversible geometry commits',async()=>withEditor(async e=>{
  const raw=source(e),white=[...e.mpr.crosshair.value!];assert.equal(e.mpr.beginPlaneModify('rotate','rp-gizmo'),true);const revision=e.revision.value,base=plain(e.reslices.selected.value),moved=shifted(oblique(),[-.25,.3,.4]);
  assert.equal(e.mpr.modifyPlane({id:'rp-gizmo',plane:moved,action:'move',...modifyEpoch(e)}),true);assert.equal(e.revision.value,revision+1);nearPoint(mprPlaneCenter(moved),[9.75,4.9,8.2]);const afterMove=invariant(e);
  assert.equal(e.mpr.modifyPlane({id:'rp-gizmo',plane:shifted(moved,[0,.8,-.6]),action:'move',...modifyEpoch(e)}),false,'center movement normal to the grabbed RP is not an in-plane move');assertInvariant(e,afterMove);
  // Independent 90-degree turn: old u points along old v, old v along -old u.
  const rotated:MprPlane={origin:[3.75,8.5,13],u:[2,0,0],v:[0,-1.8,-2.4],size:[7,5]};assert.equal(e.mpr.modifyPlane({id:'rp-gizmo',plane:rotated,action:'rotate',...modifyEpoch(e)}),true);assert.equal(e.revision.value,revision+2);nearPoint(mprPlaneCenter(rotated),[9.75,4.9,8.2]);near(Math.hypot(...rotated.u),2);near(Math.hypot(...rotated.v),3);assert.deepEqual(e.reslices.selected.value!.plane,rotated);assert.equal(e.mpr.enabled.value,false);assert.deepEqual(e.mpr.crosshair.value,white);assertSource(e,raw);
  const afterRotate=invariant(e);assert.equal(e.mpr.modifyPlane({id:'rp-gizmo',plane:shifted(rotated,[1,0,0]),action:'rotate',...modifyEpoch(e)}),false);assertInvariant(e,afterRotate);const otherwiseValidResize:MprPlane={origin:[-2.25,6.7,10.6],u:[4,0,0],v:[0,-.9,-1.2],size:[7,5]};assert.equal(e.mpr.modifyPlane({id:'rp-gizmo',plane:otherwiseValidResize,action:'resize',...modifyEpoch(e)}),false);assertInvariant(e,afterRotate);
  e.undo();assert.deepEqual(e.reslices.selected.value!.plane,moved);e.undo();assert.deepEqual(plain(e.reslices.selected.value),base);e.undo(true);e.undo(true);assert.deepEqual(e.reslices.selected.value!.plane,rotated);assert.equal(e.mpr.enabled.value,false);assert.deepEqual(e.mpr.crosshair.value,white);assertSource(e,raw);
}));

test('failed 3D Resize allocation leaves the selected RP, hidden browsed frame, clean state and real redo branch untouched',async()=>withEditor(async e=>{
  e.reslices.rename('rp-gizmo','Temporary');e.undo();assert.ok(e.redoName.value);assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);await e.saveProject();const raw=source(e),before=invariant(e),payload={id:'rp-gizmo',plane:resized(),action:'resize' as const,...modifyEpoch(e)},push=ProjectHistory.prototype.push;let calls=0;
  ProjectHistory.prototype.push=function(){calls++;throw new Error('gizmo audit intentional history allocation failure');};try{assert.equal(e.mpr.modifyPlane(payload),false);assert.equal(calls,1,'the valid resize reaches exactly one real commit boundary');}finally{ProjectHistory.prototype.push=push;}
  assertInvariant(e,before);assertSource(e,raw);assert.match(e.error.value,/gizmo audit intentional/);assert.equal(e.mpr.modifyPlane(payload),true);assert.equal(e.revision.value,before.revision+1);assert.equal(e.redoName.value,'');assert.equal(e.mpr.enabled.value,false);assertSource(e,raw);
}));

test('entering blue editing on the same RP ends 3D Modify, while selection changes and ZIP install clear its transient session',async()=>withEditor(async(e,exports)=>{
  const raw=source(e),revision=e.revision.value;assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);assert.equal(e.mpr.resliceMode.value,'resize');assert.equal(e.mpr.interactive.value,false);
  const stale={id:'rp-gizmo',plane:resized(),action:'resize' as const,...modifyEpoch(e)};assert.equal(e.mpr.editInteractive('rp-gizmo'),true);assert.equal(e.mpr.interactive.value,true);assert.equal(e.mpr.resliceMode.value,'view');assert.equal(e.mpr.resliceId.value,'');assert.equal(e.revision.value,revision);assert.equal(e.dirty.value,false);const blue=invariant(e);assert.equal(e.mpr.modifyPlane(stale),false);assertInvariant(e,blue);
  assert.equal(e.mpr.beginPlaneModify('rotate','rp-gizmo'),true);assert.equal(e.mpr.interactive.value,false);assert.equal(e.mpr.resliceMode.value,'rotate');assert.equal(e.reslices.select('rp-other'),true);assert.equal(e.mpr.resliceMode.value,'view');assert.equal(e.mpr.resliceId.value,'');assert.equal(e.revision.value,revision);assertSource(e,raw);
  assert.equal(e.mpr.beginPlaneModify('resize','rp-gizmo'),true);assert.equal((await e.saveProject())?.status,'written');const bytes=exports.at(-1)!;assert.equal(await e.openFiles([new File([bytes.slice().buffer as ArrayBuffer],'rp-modify-session-restored.zip')]),true);assert.equal(e.mpr.resliceMode.value,'view');assert.equal(e.mpr.resliceId.value,'');assert.equal(e.mpr.interactive.value,false);assert.equal(e.state.value.selectedResliceId,'rp-gizmo');assert.equal(e.dirty.value,false);
}));
