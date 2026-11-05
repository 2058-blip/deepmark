import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,addMask,encodeProject,decodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MeasurementObject,AnnotationStyle,Vec3} from '../src/mimics/types.ts';

// Exercise the real workbench and worker for model creation and ZIP exchange.
// Pointer hits are explicit inputs; this does not test browser picking or text rendering.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
const style:AnnotationStyle={arrow:'dot',rotation:37,align:'right'};
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function fixture(){
  const bytes=new Uint8Array(352+48),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[4,4,3].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,[2,3,4][a]!,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setInt16(254,1,true);h.setUint8(123,2);[[0,-3,0,10],[2,0,0,-20],[0,0,4,30]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+16*r+4*c,n,true)));bytes.set([110,43,49,0],344);bytes.fill(100,352);
  const volume=parseNifti(bytes.buffer,'annotation-rotated.nii');let state=createProject(volume);const source=state.selectedMaskId,data=new Uint8Array(48);for(const i of [21,22,25,26])data[i]=1;
  state={...state,masks:state.masks.map(mask=>({...mask,name:'Source',threshold:[100,100] as [number,number],data}))};state=addMask(state,48,'Independent overlap',Uint8Array.from({length:48},(_,i)=>Number(i===21)));state={...state,selectedMaskId:source,viewState:{point:[1,2,1],activeAxis:2,tool:'navigate',tab:'measurements'}};return{volume,state};
}
async function withEditor(run:(editor:Editor,input:ReturnType<typeof fixture>,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]);await nextTick();await run(editor,input,exports);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
const maskSnapshot=(editor:Editor)=>editor.state.value.masks.map(mask=>({...mask,data:mask.data.slice(),threshold:mask.threshold?[...mask.threshold]:null}));
function assertReferences(editor:Editor){assert.ok(!editor.selectedMeasurementId.value||editor.state.value.measurements.some(m=>m.id===editor.selectedMeasurementId.value));assert.ok(!editor.state.value.selectedPartId||editor.state.value.parts.some(p=>p.id===editor.state.value.selectedPartId));assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));}
function apply(editor:Editor,text='confirmed annotation'){
  const draft=editor.measurementEditor.draft.value;assert.ok(draft);assert.equal(editor.measurementEditor.apply({name:'Confirmed note',text,color:'#123456',visible:true,annotationStyle:{...style}}),true);return editor.state.value.measurements.at(-1)!;
}
async function draft2D(editor:Editor,point:Vec3=[1,2,1]){editor.tool.value='annotation';await nextTick();await editor.imagePick(point,2,point[2]);assert.ok(editor.measurementEditor.draft.value);}
async function createPart(editor:Editor){await editor.runPart('calculate3d');assert.equal(editor.error.value,'');const part=editor.activePart.value!;assert.ok(part.mesh.indices.length);return part;}
const worldHit=(mesh:{positions:Float32Array}):Vec3=>[mesh.positions[0]!,mesh.positions[1]!,mesh.positions[2]!];

test('2D annotation anchors open a world-coordinate draft; Cancel does nothing and Apply is exactly one Undo/Redo transaction',async()=>withEditor(async editor=>{
  const masks=maskSnapshot(editor),before=editor.state.value,revision=editor.revision.value;await draft2D(editor);
  assert.deepEqual(editor.measurementEditor.draft.value!.points,[[4,-18,34]]);assert.deepEqual(editor.measurementEditor.draft.value!.plane,{axis:2,index:1});assert.ok(editor.state.value===before);assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.revision.value,revision);assert.equal(editor.dirty.value,false);assert.equal(editor.undoName.value,'');
  editor.measurementEditor.cancel();assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.measurementEditor.apply({text:'cancelled'}),false);assert.ok(editor.state.value===before);
  await draft2D(editor);const note=apply(editor);assert.deepEqual(note.points,[[4,-18,34]]);assert.equal(note.partId,undefined);assert.equal(editor.revision.value,revision+1);assert.equal(editor.selectedMeasurementId.value,note.id);assert.equal(editor.measurementEditor.draft.value,null);assert.deepEqual(editor.state.value.masks,masks);
  editor.undo();assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.undoName.value,'');assertReferences(editor);editor.undo(true);assert.deepEqual(editor.state.value.measurements[0],note);assert.deepEqual(editor.state.value.masks,masks);assertReferences(editor);
}));

test('3D annotation creation is deferred and never changes the generated Part or its source Mask',async()=>withEditor(async editor=>{
  const masks=maskSnapshot(editor),part=await createPart(editor),positions=part.mesh.positions.slice(),provenance=[part.sourceMaskId,part.sourceRevision],hit=worldHit(part.mesh),revision=editor.revision.value,undo=editor.undoName.value;editor.tool.value='annotation';await nextTick();editor.partPick({partId:part.id,position:hit});
  assert.ok(editor.measurementEditor.draft.value);assert.equal(editor.measurementEditor.draft.value!.partId,part.id);editor.measurementEditor.draft.value!.points[0]!.forEach((n,a)=>assert.ok(Math.abs(n-hit[a]!)<1e-6));assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);
  editor.cancel();assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.state.value.measurements.length,0);editor.partPick({partId:part.id,position:hit});const note=apply(editor,'3D note');assert.equal(note.partId,part.id);assert.equal(note.plane,undefined);assert.equal(editor.revision.value,revision+1);
  assert.deepEqual(editor.state.value.masks,masks);assert.deepEqual(editor.activePart.value!.mesh.positions,positions);assert.deepEqual([editor.activePart.value!.sourceMaskId,editor.activePart.value!.sourceRevision],provenance);
  editor.undo();assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.state.value.parts.length,1);assert.equal(editor.undoName.value,undo);editor.undo(true);assert.equal(editor.state.value.measurements[0]!.id,note.id);assertReferences(editor);
}));

test('workbench properties, duplicate and hide survive real worker ZIP export/restore without modifying masks',async()=>withEditor(async(editor,_input,exports)=>{
  const masks=maskSnapshot(editor);await draft2D(editor);const original=apply(editor,'First line\nSecond line');assert.equal(editor.measurementEditor.openEdit(original.id),true);const revision=editor.revision.value;
  assert.equal(editor.measurementEditor.apply({name:'Edited note',text:'Edited complete text',color:'#abcdef',visible:true,annotationStyle:{arrow:'arrow',rotation:-45,align:'center'}}),true);assert.equal(editor.revision.value,revision+1);const edited=editor.state.value.measurements[0]!;assert.deepEqual(edited.points,[[4,-18,34]]);
  assert.equal(editor.measurementEditor.duplicate(edited.id),true);const copy=editor.state.value.measurements.at(-1)!;assert.notEqual(copy.id,edited.id);assert.notEqual(copy.points,edited.points);assert.notEqual(copy.points[0],edited.points[0]);assert.notEqual(copy.annotationStyle,edited.annotationStyle);assert.deepEqual(copy.annotationStyle,edited.annotationStyle);assert.equal(editor.selectedMeasurementId.value,copy.id);
  assert.equal(editor.measurementEditor.toggle(copy.id),true);assert.equal(editor.state.value.measurements.find(m=>m.id===copy.id)!.visible,false);assert.equal(editor.state.value.measurements.find(m=>m.id===edited.id)!.visible,true);assert.deepEqual(editor.state.value.masks,masks);
  const result=await editor.saveProject();assert.equal(result?.status,'written');const restored=decodeProject(exports.at(-1)!);assert.deepEqual(normal(restored.state.measurements),normal(editor.state.value.measurements));assert.equal(restored.state.viewState!.selectedMeasurementId,copy.id);
  await editor.openFiles([new File([exports.at(-1)!.slice().buffer as ArrayBuffer],'restored.deepmark.zip')]);assert.equal(editor.error.value,'');assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.selectedMeasurementId.value,copy.id);assert.deepEqual(editor.state.value.masks,masks);assertReferences(editor);
}));

test('new-document install and deleting an edited annotation cancel the stale dialog and clear invalid selection IDs',async()=>withEditor(async editor=>{
  await draft2D(editor);const note=apply(editor);assert.equal(editor.measurementEditor.openEdit(note.id),true);editor.deleteMeasurement(note.id);assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.selectedMeasurementId.value,'');const afterDelete=editor.state.value,revision=editor.revision.value;assert.equal(editor.measurementEditor.apply({text:'deleted resurrection'}),false);assert.ok(editor.state.value===afterDelete);assert.equal(editor.revision.value,revision);
  await draft2D(editor);const second=apply(editor);assert.equal(editor.measurementEditor.openEdit(second.id),true);const replacement=fixture();assert.equal(await editor.openFiles([new File([encodeProject(replacement.volume,replacement.state).slice().buffer as ArrayBuffer],'replacement.deepmark.zip')]),false);assert.equal(editor.measurementEditor.draft.value,null);assert.ok(editor.pendingReplacement.value);assert.ok(editor.state.value.measurements.some(m=>m.id===second.id));await editor.confirmReplacement('discard');
  assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.selectedMeasurementId.value,'');assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.measurementEditor.apply({text:'wrong document'}),false);assertReferences(editor);
}));

test('invalid, hidden, transparent or deleted 3D hits cannot select objects or open annotation drafts',async()=>withEditor(async editor=>{
  const masks=maskSnapshot(editor),part=await createPart(editor),hit=worldHit(part.mesh);editor.tool.value='annotation';await nextTick();
  const rejected=(value:{partId:string;position:Vec3})=>{const state=editor.state.value,point=[...editor.point.value],revision=editor.revision.value,undo=editor.undoName.value;assert.doesNotThrow(()=>editor.partPick(value));assert.ok(editor.state.value===state);assert.deepEqual(editor.point.value,point);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.measurementEditor.draft.value,null);assertReferences(editor);};
  for(const value of [{partId:'missing',position:hit},{partId:editor.state.value.selectedMaskId,position:hit},{partId:part.id,position:[NaN,0,0] as Vec3},{partId:part.id,position:[0,Infinity,0] as Vec3},{partId:part.id,position:[0,0] as unknown as Vec3}])rejected(value);
  editor.togglePart(part.id);rejected({partId:part.id,position:hit});editor.togglePart(part.id);editor.updatePart(part.id,{opacity:0});rejected({partId:part.id,position:hit});editor.updatePart(part.id,{opacity:1});editor.deletePart();rejected({partId:part.id,position:hit});assert.deepEqual(editor.state.value.masks,masks);
}));

test('starting real background work cancels a deferred annotation and ignores additional 3D picks until completion',async()=>withEditor(async editor=>{
  const masks=maskSnapshot(editor),part=await createPart(editor),hit=worldHit(part.mesh);await draft2D(editor);const revision=editor.revision.value,undo=editor.undoName.value,pending=editor.thresholdPreview();assert.equal(editor.busy.value,true);assert.equal(editor.measurementEditor.draft.value,null);const state=editor.state.value,point=[...editor.point.value];editor.partPick({partId:part.id,position:hit});assert.ok(editor.state.value===state);assert.deepEqual(editor.point.value,point);assert.equal(editor.measurementEditor.draft.value,null);await pending;
  assert.equal(editor.measurementEditor.apply({text:'stale after worker'}),false);assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.deepEqual(editor.state.value.masks,masks);assertReferences(editor);
}));

test('deleting a source Part preserves committed world-coordinate annotation provenance according to the existing orphan policy',async()=>withEditor(async(editor,_input,exports)=>{
  const masks=maskSnapshot(editor),part=await createPart(editor),hit=worldHit(part.mesh);editor.tool.value='annotation';await nextTick();editor.partPick({partId:part.id,position:hit});const note=apply(editor,'historical world note'),points=note.points.map(point=>[...point]);editor.deletePart();
  assert.equal(editor.state.value.parts.length,0);assert.equal(editor.state.value.selectedPartId,'');assert.equal(editor.state.value.measurements[0]!.partId,part.id);assert.deepEqual(editor.state.value.measurements[0]!.points,points);assert.equal(editor.measurementEditor.openEdit(note.id),true);assert.equal(editor.measurementEditor.apply({text:'edited orphan note'}),true);assertReferences(editor);
  await editor.saveProject();const restored=decodeProject(exports.at(-1)!);assert.equal(restored.state.measurements[0]!.partId,part.id);assert.deepEqual(restored.state.measurements[0]!.points,points);assert.deepEqual(editor.state.value.masks,masks);
}));

test('deleting the Part of a pending new 3D annotation cancels creation without changing the old committed-object orphan policy',async()=>withEditor(async editor=>{
  const masks=maskSnapshot(editor),part=await createPart(editor),hit=worldHit(part.mesh);editor.tool.value='annotation';await nextTick();editor.partPick({partId:part.id,position:hit});assert.ok(editor.measurementEditor.draft.value);assert.equal(editor.state.value.measurements.length,0);const revision=editor.revision.value;
  editor.deletePart();await nextTick();assert.equal(editor.measurementEditor.draft.value,null);assert.equal(editor.state.value.selectedPartId,'');assert.equal(editor.selectedMeasurementId.value,'');const afterDelete=editor.state.value;assert.equal(editor.measurementEditor.apply({text:'must not create a fresh orphan'}),false);assert.ok(editor.state.value===afterDelete);assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.revision.value,revision+1);assert.deepEqual(editor.state.value.masks,masks);assertReferences(editor);
}));
