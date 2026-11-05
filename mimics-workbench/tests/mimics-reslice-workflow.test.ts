import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,encodeProject,decodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import {mprPlaneCenter} from '../src/mimics/mpr.ts';
import {sourceSliceMprPlane} from '../src/mimics/mprInteraction.ts';
import type {MprPlane,Vec3} from '../src/mimics/types.ts';

const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
function fixture(spatialUnit=2){
  const bytes=new Uint8Array(352+8*8*3),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[8,8,3].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,[2,3,4][a]!,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,spatialUnit);bytes.set([110,43,49,0],344);
  for(let i=352;i<bytes.length;i++)bytes[i]=(i-352)%251;const volume=parseNifti(bytes.buffer,'rp-workflow.nii'),state=createProject(volume);
  state.masks[0]!.data[5]=state.masks[0]!.data[69]=1;state.measurements=[{id:'existing',name:'Historical MPR distance',kind:'distance',points:[[2,3,4],[4,6,4]],mprPlane:{origin:[0,0,4],u:[2,0,0],v:[0,3,0],size:[8,8]},pointPartIds:[null,null],labelOffset:[1,-1,0],visible:true,color:'#abcdef'}];state.viewState={point:[4,4,1],activeAxis:2,tool:'navigate',tab:'measurements'};return{volume,state};
}
type Editor=ReturnType<typeof useWorkbench>;
async function withEditor(run:(e:Editor,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],e=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();e.params.thresholdAutoPreview=false;
  try{await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.zip')]);await nextTick();await run(e,exports);}finally{e.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(w=>w.terminate()));}
}
const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value));
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const point=(a:Vec3,b:Vec3)=>a.forEach((n,i)=>near(n,b[i]!));
function sources(e:Editor){return{data:e.volume.value!.data.slice(),header:e.volume.value!.header.slice(),affine:normalize(e.volume.value!.affine),masks:normalize(e.state.value.masks.map(m=>({...m,data:[...m.data]}))),measurements:normalize(e.state.value.measurements),parts:normalize(e.state.value.parts)};}
function assertSources(e:Editor,before:ReturnType<typeof sources>){assert.deepEqual(e.volume.value!.data,before.data);assert.deepEqual(e.volume.value!.header,before.header);assert.deepEqual(normalize(e.volume.value!.affine),before.affine);assert.deepEqual(normalize(e.state.value.masks.map(m=>({...m,data:[...m.data]}))),before.masks);assert.deepEqual(normalize(e.state.value.measurements),before.measurements);assert.deepEqual(normalize(e.state.value.parts),before.parts);}
const epoch=(e:Editor,sourcePlane=e.mpr.planes.value[0]!)=>({volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value,sourcePlane});
const shifted=(p:MprPlane,delta:Vec3):MprPlane=>({...p,origin:p.origin.map((v,a)=>v+delta[a]) as Vec3,u:[...p.u],v:[...p.v],size:[...p.size]});

test('interactive entry creates one axial RP; ordinary scrolling moves the view without moving the saved blue frame or any source data',async()=>withEditor(async e=>{
  const source=sources(e),revision=e.revision.value,ijk=[...e.point.value];assert.equal(e.mpr.startInteractive(),true);const object=e.reslices.selected.value!;assert.equal(e.state.value.resliceObjects!.length,1);assert.equal(e.state.value.selectedResliceId,object.id);assert.equal(e.revision.value,revision+1);assert.equal(e.dirty.value,true);assert.equal(e.mpr.interactive.value,true);near(mprPlaneCenter(object.plane)[2],4);const saved=normalize(object.plane),blue=normalize(e.mpr.interactiveCenter.value),white=normalize(e.mpr.crosshair.value),undo=e.undoName.value;
  assert.equal(e.mpr.scroll({distanceMm:4,plane:e.mpr.planes.value[0]!}),true);assert.deepEqual(normalize(e.reslices.selected.value!.plane),saved);assert.deepEqual(normalize(e.mpr.interactiveCenter.value),blue);assert.deepEqual(normalize(e.mpr.crosshair.value),white);assert.deepEqual(e.point.value,ijk);assert.equal(e.revision.value,revision+1);assert.equal(e.undoName.value,undo);assertSources(e,source);
}));

test('off-slice blue translation is one geometry transaction and Undo/Redo restores the selected RP without moving either navigation crosshair',async()=>withEditor(async e=>{
  e.mpr.startInteractive();const source=sources(e),object=e.reslices.selected.value!,base=normalize(object.plane) as MprPlane,c=mprPlaneCenter(base);e.mpr.locate([3.5,6.5,4]);const white=[...e.mpr.crosshair.value!] as Vec3,ijk=[...e.point.value];e.mpr.scroll({distanceMm:4,plane:e.mpr.planes.value[0]!});const captured=epoch(e),revision=e.revision.value,next=shifted(base,[2,-3,0]),payload={plane:next,crosshair:[c[0]+2,c[1]-3,c[2]] as Vec3,...captured};
  assert.equal(e.mpr.transform(payload),true);assert.equal(e.revision.value,revision+1);assert.deepEqual(e.reslices.selected.value!.plane,next);point(e.mpr.interactiveCenter.value!,payload.crosshair);assert.deepEqual(e.mpr.crosshair.value,white);assert.deepEqual(e.point.value,ijk);assert.equal(e.mpr.transform(payload),false);assertSources(e,source);
  e.undo();assert.deepEqual(normalize(e.reslices.selected.value!.plane),base);e.undo(true);assert.deepEqual(e.reslices.selected.value!.plane,next);assertSources(e,source);
}));

test('blue quarter turn preserves physical sampling and pivot, rejects resize/normal translation, and ignores a no-move click',async()=>withEditor(async e=>{
  e.mpr.startInteractive();const object=e.reslices.selected.value!,base=object.plane,c=mprPlaneCenter(base),revision=e.revision.value;
  assert.equal(e.mpr.transform({plane:base,crosshair:c,...epoch(e)}),false);assert.equal(e.revision.value,revision);
  const rotate=([x,y,z]:Vec3):Vec3=>[-y,x,z],delta=base.origin.map((v,a)=>v-c[a]) as Vec3,r=rotate(delta),rotated:MprPlane={origin:r.map((v,a)=>v+c[a]) as Vec3,u:rotate(base.u),v:rotate(base.v),size:[...base.size]};assert.equal(e.mpr.transform({plane:rotated,crosshair:c,...epoch(e)}),true);point(e.reslices.selected.value!.plane.u,[-base.u[1],base.u[0],base.u[2]]);point(e.reslices.selected.value!.plane.v,[-base.v[1],base.v[0],base.v[2]]);point(mprPlaneCenter(e.reslices.selected.value!.plane),c);assert.equal(e.revision.value,revision+1);
  const before=e.state.value;assert.equal(e.mpr.transform({plane:{...rotated,u:rotated.u.map(n=>n*2) as Vec3},crosshair:c,...epoch(e)}),false);assert.equal(e.state.value,before);assert.equal(e.mpr.transform({plane:shifted(rotated,[0,0,1]),crosshair:[c[0],c[1],c[2]+1],...epoch(e)}),false);assert.equal(e.state.value,before);assert.equal(e.revision.value,revision+1);
}));

test('source-IJK Ctrl drops work with MPR layout closed while old pose, stopped mode and changed source slices cannot replay',async()=>withEditor(async e=>{
  e.mpr.startInteractive();e.mpr.close();assert.equal(e.mpr.interactive.value,true);const object=e.reslices.selected.value!,c=mprPlaneCenter(object.plane),sourcePlane=sourceSliceMprPlane(e.grid.value!,2,e.point.value[2]),payload={plane:shifted(object.plane,[1,0,0]),crosshair:[c[0]+1,c[1],c[2]] as Vec3,...epoch(e,sourcePlane)},before=e.state.value;
  e.point.value=[4,4,2];assert.equal(e.mpr.transform(payload),false);assert.equal(e.state.value,before);e.point.value=[4,4,1];assert.equal(e.mpr.transform(payload),false,'returning to the same source slice cannot replay its old Ctrl payload');assert.equal(e.state.value,before);assert.equal(e.mpr.transform({...payload,...epoch(e,sourcePlane)}),true);const revision=e.revision.value;e.mpr.stopInteractive();assert.equal(e.mpr.transform({...payload,...epoch(e)}),false);assert.equal(e.revision.value,revision);
}));

test('RP Properties, duplicate/delete and real Worker ZIP preserve both the saved frame and independent browsed slice',async()=>withEditor(async(e,exports)=>{
  const source=sources(e);e.mpr.startInteractive();const id=e.reslices.selected.value!.id;e.reslices.openProperties();e.reslices.propertiesDraft.value!.name='Cancelled';e.reslices.cancelProperties();assert.notEqual(e.reslices.selected.value!.name,'Cancelled');const revision=e.revision.value;e.reslices.openProperties();assert.equal(e.reslices.applyProperties({name:'RP kept',widthMm:40,heightMm:30}),true);assert.equal(e.revision.value,revision+1);assert.equal(e.reslices.selected.value!.name,'RP kept');assert.deepEqual(e.reslices.selected.value!.plane.size,[256,256]);near(Math.hypot(...e.reslices.selected.value!.plane.u)*256,40);near(Math.hypot(...e.reslices.selected.value!.plane.v)*256,30);
  e.mpr.scroll({distanceMm:2,plane:e.mpr.planes.value[0]!});const saved=normalize(e.reslices.selected.value!.plane),pose=normalize(e.mpr.snapshot());await e.saveProject();const archive=exports.at(-1)!,decoded=decodeProject(archive);assert.deepEqual(normalize(decoded.state.resliceObjects![0]!.plane),saved);assert.deepEqual(normalize(decoded.state.viewState!.mpr),pose);assert.equal(decoded.state.selectedResliceId,id);await e.openFiles([new File([archive.slice().buffer as ArrayBuffer],'restored.zip')]);assert.deepEqual(normalize(e.reslices.selected.value!.plane),saved);assert.deepEqual(normalize(e.mpr.snapshot()),pose);assert.equal(e.mpr.interactive.value,false);assertSources(e,source);
  e.reslices.duplicate();const copy=e.reslices.selected.value!;assert.notEqual(copy.id,id);assert.deepEqual(normalize(copy.plane),saved);e.reslices.remove();assert.equal(e.state.value.selectedResliceId,'');assert.equal(e.mpr.enabled.value,false);assert.equal(e.state.value.resliceObjects!.length,1);e.undo();assert.equal(e.reslices.selected.value!.id,copy.id);assert.equal(e.mpr.enabled.value,true);assertSources(e,source);validateProject(e.volume.value!,e.state.value);
}));

test('a historical RP blocks reinterpretation of unknown source units just like other existing physical geometry',async()=>withEditor(async e=>{
  const input=fixture(0);input.state.measurements=[];input.state.resliceObjects=[{id:'historical-rp',name:'RP world geometry',kind:'plane',plane:{origin:[0,0,4],u:[2,0,0],v:[0,3,0],size:[8,8]}}];input.state.selectedResliceId='historical-rp';await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'unknown-unit-rp.zip')]);assert.equal(e.physicalUnitsKnown.value,false);const before=e.state.value,volume=e.volume.value,revision=e.revision.value;e.spatialUnitChoice.value=2;e.confirmSpatialUnit();assert.equal(e.state.value,before);assert.equal(e.volume.value,volume);assert.equal(e.revision.value,revision);assert.equal(e.physicalUnitsKnown.value,false);assert.match(e.error.value,/物理几何对象/);assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');
}));
