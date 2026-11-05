import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,encodeProject,decodeProject,addPart} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {Vec3} from '../src/mimics/types.ts';

// These tests use the real controller and worker export. Pointer picking is covered
// separately by the viewport suites; no browser or original-runtime claim is made.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
function fixture(){
  const bytes=new Uint8Array(352+8*8*3),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[8,8,3].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,1,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);
  const volume=parseNifti(bytes.buffer,'editing.nii'),state=createProject(volume);
  state.measurements=[{id:'area',name:'Area',kind:'area',points:[[1,1,1],[5,1,1],[5,4,1],[1,4,1]],pointPartIds:[null,null,null,null],plane:{axis:2,index:1},labelOffset:[2,1,0],visible:true,color:'#abcdef'},{id:'ellipse',name:'Ellipse',kind:'ellipse',points:[[1,3,1],[5,3,1],[4,4,1]],pointPartIds:[null,null,null],plane:{axis:2,index:1},visible:true,color:'#fedcba'}];
  state.viewState={point:[3,3,1],activeAxis:2,tool:'navigate',tab:'measurements'};return{volume,state};
}
async function withEditor(run:(editor:ReturnType<typeof useWorkbench>,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'editing.deepmark.zip')]);await nextTick();await run(editor,exports);}finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(w=>w.terminate()));}
}
const smaller:Vec3[]=[[1,1,1],[3,1,1],[3,4,1],[1,4,1]];
const snapshot=(editor:ReturnType<typeof useWorkbench>)=>({volume:editor.volume.value!,revision:editor.revision.value});

test('geometric preview changes live details and labels but never raw geometry, image, masks, revision, dirty or history',async()=>withEditor(async e=>{
  const before=e.state.value,raw=e.volume.value!.data.slice(),mask=e.activeMask.value!.data.slice(),undo=e.undoName.value,epoch=snapshot(e);assert.equal(e.measurementDetails('area').value,12);
  const request={id:'area',points:smaller.map(p=>[...p] as Vec3),plane:{axis:2 as const,index:1},...epoch};assert.equal(e.previewMeasurementGeometry(request),true);request.points[0]![0]=7;
  assert.equal(e.measurementDetails('area').value,6);assert.equal(e.selectedMeasurementDetails.value!.preview,true);assert.equal(e.measurementLabels.value.area,'6.00 mm²');assert.equal(e.state.value,before);assert.deepEqual(e.state.value.measurements[0]!.points,fixture().state.measurements[0]!.points);assert.deepEqual(e.volume.value!.data,raw);assert.deepEqual(e.activeMask.value!.data,mask);assert.equal(e.revision.value,epoch.revision);assert.equal(e.undoName.value,undo);assert.equal(e.dirty.value,false);
  e.previewMeasurementGeometry(null);assert.equal(e.measurementDetails('area').value,12);assert.equal(e.selectedMeasurementDetails.value!.preview,undefined);assert.equal(e.state.value,before);
}));

test('preview is excluded from real worker ZIP export and explicit cancel restores committed values',async()=>withEditor(async(e,exports)=>{
  assert.equal(e.previewMeasurementGeometry({id:'area',points:smaller,...snapshot(e)}),true);await e.saveProject();const restored=decodeProject(exports.at(-1)!);assert.deepEqual(restored.state.measurements[0]!.points,fixture().state.measurements[0]!.points);assert.deepEqual(restored.state.measurements[0]!.labelOffset,[2,1,0]);assert.equal(e.dirty.value,false);
  e.cancel();assert.equal(e.measurementPreview.value,null);assert.equal(e.measurementDetails('area').value,12);assert.equal(e.undoName.value,'');
}));

test('one geometry release commits the preview once, preserves label and point sources, and Undo/Redo restores the complete object',async()=>withEditor(async e=>{
  const before=e.state.value.measurements[0]!,epoch=snapshot(e);e.previewMeasurementGeometry({id:'area',points:smaller,...epoch});assert.equal(e.updateMeasurementGeometry({id:'area',points:smaller,plane:{axis:2,index:1},...epoch}),true);assert.equal(e.revision.value,epoch.revision+1);assert.equal(e.measurementPreview.value,null);assert.equal(e.measurementDetails('area').value,6);assert.deepEqual(e.state.value.measurements[0]!.labelOffset,[2,1,0]);assert.deepEqual(e.state.value.measurements[0]!.pointPartIds,[null,null,null,null]);
  e.undo();assert.deepEqual(e.state.value.measurements[0],before);e.undo(true);assert.equal(e.measurementDetails('area').value,6);
}));

test('invalid area and ellipse previews report a reason, while invalid releases preserve the previous valid object atomically',async()=>withEditor(async e=>{
  const before=e.state.value,epoch=snapshot(e),crossed:Vec3[]=[[1,1,1],[5,4,1],[5,1,1],[1,4,1]];e.previewMeasurementGeometry({id:'area',points:crossed,...epoch});assert.equal(e.measurementDetails('area').valid,false);assert.ok(e.measurementDetails('area').reason);assert.equal(e.updateMeasurementGeometry({id:'area',points:crossed,...epoch}),false);assert.equal(e.state.value,before);assert.equal(e.revision.value,epoch.revision);e.previewMeasurementGeometry(null);
  const collapsed:Vec3[]=[[1,3,1],[5,3,1],[3,3,1]];e.previewMeasurementGeometry({id:'ellipse',points:collapsed,...epoch});assert.equal(e.measurementDetails('ellipse').valid,false);assert.equal(e.updateMeasurementGeometry({id:'ellipse',points:collapsed,...epoch}),false);assert.equal(e.state.value,before);assert.equal(e.undoName.value,'');
}));

test('new invalid area/ellipse geometry cannot enter the project and a bad ellipse third point can be retried',async()=>withEditor(async e=>{
  const before=e.state.value,revision=e.revision.value;e.tool.value='area';for(const p of [[1,1,1],[5,4,1],[5,1,1],[1,4,1]] as Vec3[])await e.imagePick(p,2,1);e.finishDrawing();assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.ok(e.error.value);e.cancel();
  e.tool.value='ellipse';await e.imagePick([1,3,1],2,1);await e.imagePick([5,3,1],2,1);await e.imagePick([3,3,1],2,1);assert.equal(e.state.value,before);assert.equal(e.draftPoints.value.length,2);assert.deepEqual(e.draftPlane.value,{axis:2,index:1});await e.imagePick([3,4,1],2,1);assert.equal(e.state.value.measurements.length,3);assert.equal(e.error.value,'');assert.equal(e.revision.value,revision+1);assert.deepEqual(e.state.value.measurements[2]!.pointPartIds,[null,null,null]);assert.equal(e.draftPoints.value.length,0);
}));

test('label relocation is separate from measurement geometry, persists through worker export, and has one reversible transaction',async()=>withEditor(async(e,exports)=>{
  const before=e.state.value.measurements[1]!,epoch=snapshot(e);assert.equal(e.updateMeasurementLabel({id:'ellipse',offset:[3,-2,0],...epoch}),true);const moved=e.state.value.measurements[1]!;assert.deepEqual(moved.points,before.points);assert.deepEqual(moved.pointPartIds,before.pointPartIds);assert.deepEqual(moved.labelOffset,[3,-2,0]);assert.equal(e.revision.value,epoch.revision+1);assert.equal(e.updateMeasurementLabel({id:'ellipse',offset:[3,-2,0]}),false);assert.equal(e.revision.value,epoch.revision+1);
  await e.saveProject();assert.deepEqual(decodeProject(exports.at(-1)!).state.measurements[1]!.labelOffset,[3,-2,0]);e.undo();assert.equal(e.state.value.measurements[1]!.labelOffset,undefined);e.undo(true);assert.deepEqual(e.state.value.measurements[1]!.labelOffset,[3,-2,0]);
}));

test('stale preview/label payloads cannot affect a new document with the same IDs or a different current slice',async()=>withEditor(async e=>{
  const epoch=snapshot(e),input=fixture();e.point.value=[3,3,2];assert.equal(e.previewMeasurementGeometry({id:'area',points:smaller,plane:{axis:2,index:1},...epoch}),false);assert.equal(e.updateMeasurementLabel({id:'area',offset:[1,1,0],...epoch}),false);assert.equal(e.dirty.value,false);
  await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'same-ids.deepmark.zip')]);const before=e.state.value,revision=e.revision.value;assert.equal(e.previewMeasurementGeometry({id:'area',points:smaller,...epoch}),false);assert.equal(e.updateMeasurementLabel({id:'area',offset:[1,1,0],...epoch}),false);assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.measurementPreview.value,null);
}));

test('preview clears on tool changes, slice navigation, Properties and object changes without creating history',async()=>withEditor(async e=>{
  const preview=()=>assert.equal(e.previewMeasurementGeometry({id:'area',points:smaller}),true);preview();e.tool.value='area';assert.equal(e.measurementPreview.value,null);preview();e.point.value=[4,3,1];assert.equal(e.measurementPreview.value,null);preview();e.measurementEditor.openEdit('area');assert.equal(e.measurementPreview.value,null);e.measurementEditor.cancel();preview();e.deleteMeasurement('ellipse');assert.equal(e.measurementPreview.value,null);assert.equal(e.undoName.value,'删除测量');
}));

test('actual surface-path recalculation preserves user metadata and label offset while replacing only path geometry',async()=>withEditor(async e=>{
  const input=fixture();input.state=addPart(input.state,{positions:new Float32Array([0,0,1,7,0,1,0,7,1]),indices:new Uint32Array([0,1,2])},input.state.masks[0]);const partId=input.state.selectedPartId;
  input.state.measurements.push({id:'path',name:'Custom path',kind:'surface-distance',points:[[0,0,1],[7,0,1]],controlPoints:[[1,1,1],[4,1,1]],pathMethod:'edge-graph',partId,labelOffset:[1,-2,0],color:'#123456',visible:false});
  await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'path.deepmark.zip')]);const before=e.state.value.measurements.at(-1)!,revision=e.revision.value;
  e.moveMeasurementPoint({id:'path',index:1,position:[3,2,1]});while(e.busy.value)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(e.error.value,'');const after=e.state.value.measurements.find(m=>m.id==='path')!;
  assert.equal(e.revision.value,revision+1);assert.equal(after.id,before.id);assert.equal(after.name,'Custom path');assert.equal(after.color,'#123456');assert.equal(after.visible,false);assert.deepEqual(after.labelOffset,[1,-2,0]);assert.equal(after.partId,partId);assert.ok(after.points.length>=2);assert.notDeepEqual(after.controlPoints,before.controlPoints);e.undo();assert.deepEqual(e.state.value.measurements.find(m=>m.id==='path'),before);
}));

test('three-dimensional ellipse completion uses a draft token and keeps the plane-defined third point independent of Part provenance',async()=>withEditor(async e=>{
  const input=fixture();input.state=addPart(input.state,{positions:new Float32Array([0,0,1,7,0,1,0,7,1]),indices:new Uint32Array([0,1,2])},input.state.masks[0]);const partId=input.state.selectedPartId;await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'ellipse-create.deepmark.zip')]);e.tool.value='ellipse';
  const before=e.state.value.measurements.length,revision=e.revision.value;e.partPick({partId,position:[1,3,1]});e.partPick({partId,position:[5,3,1]});const payload={position:[3,4,1] as Vec3,draftToken:e.measurementDraftToken.value,...snapshot(e)};assert.equal(e.completeEllipseCreation(payload),true);assert.equal(e.revision.value,revision+1);assert.equal(e.state.value.measurements.length,before+1);const m=e.state.value.measurements.at(-1)!;assert.deepEqual(m.points,[[1,3,1],[5,3,1],[3,4,1]]);assert.deepEqual(m.pointPartIds,[partId,partId,null]);assert.equal(m.partId,undefined);assert.equal(m.plane,undefined);assert.equal(e.completeEllipseCreation(payload),false);e.undo();assert.equal(e.state.value.measurements.length,before);
}));

test('cancelling and rebuilding an identical ellipse axis cannot reuse an old completion payload without a project revision change',async()=>withEditor(async e=>{
  const input=fixture();input.state=addPart(input.state,{positions:new Float32Array([0,0,1,7,0,1,0,7,1]),indices:new Uint32Array([0,1,2])},input.state.masks[0]);const partId=input.state.selectedPartId;await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'ellipse-token.deepmark.zip')]);e.tool.value='ellipse';
  const axis=()=>{e.partPick({partId,position:[1,3,1]});e.partPick({partId,position:[5,3,1]});};axis();const payload={position:[3,4,1] as Vec3,draftToken:e.measurementDraftToken.value,...snapshot(e)};e.cancel();axis();const before=e.state.value;assert.equal(e.revision.value,payload.revision);assert.notEqual(e.measurementDraftToken.value,payload.draftToken);assert.equal(e.completeEllipseCreation(payload),false);assert.equal(e.state.value,before);assert.equal(e.draftPoints.value.length,2);assert.equal(e.completeEllipseCreation({...payload,draftToken:e.measurementDraftToken.value}),true);
}));
