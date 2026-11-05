import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import type {Ref,ComputedRef} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,addMask,encodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {Axis,Vec3,MaskObject} from '../src/mimics/types.ts';

// The actual composable, OperationClient and operations.worker.ts run through
// Node worker_threads. These checks do not execute canvas/pointer/browser UI or
// establish numerical equivalence to Mimics' interpolation/LiveWire algorithms.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));
  }
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type BaseEditor=ReturnType<typeof useWorkbench>;
type Editor=BaseEditor&{
  params:BaseEditor['params']&{selectionType:'brush'|'lasso'|'livewire'};
  multipleEditing:ComputedRef<boolean>;imageTool:ComputedRef<string>;selectionAxis:Ref<Axis>;
  displayMasks:ComputedRef<MaskObject[]>;interpolationPreview:Ref<Uint8Array|null>;
  setSelectionAxis:(axis:Axis)=>void;copySelection:()=>Promise<unknown>;interpolateSelection:()=>Promise<unknown>;
  applyInterpolation:()=>void;cancelInterpolation:()=>void;applyTemporarySelection:()=>Promise<unknown>;closeMultipleEdit:()=>void;
  localThreshold:{range:ComputedRef<{lower:number;upper:number}>;choose:(slot:0|1|2)=>void;update:(slot:0|1|2,bound:'lower'|'upper',value:number)=>void};
};
const dims:Vec3=[7,6,4],length=168;
const bits=(predicate:(x:number,y:number,z:number)=>boolean)=>Uint8Array.from({length},(_,i)=>predicate(i%7,Math.floor(i/7)%6,Math.floor(i/42))?1:0);
const outside=(x:number,y:number,z:number)=>x===0&&y===0&&z===0||x===6&&y===5&&z===3;
const roi=(x:number,y:number)=>x>=1&&x<=3&&y>=1&&y<=3;
const outer=(z=1):Vec3[]=>[[1,1,z],[3,1,z],[3,3,z],[1,3,z]];
const inner=(z=1):Vec3[]=>[[2,2,z],[3,2,z],[3,3,z],[2,3,z]];
const wire=(z=1):Vec3[]=>[[1,1,z],[2,1,z],[3,1,z],[3,2,z],[3,3,z],[2,3,z],[1,3,z],[1,2,z]];
function fixture(initial:Uint8Array,uniform=false,visible=true){
  const bytes=new Uint8Array(352+length*2),header=new DataView(bytes.buffer);header.setInt32(0,348,true);header.setInt16(40,3,true);
  dims.forEach((value,a)=>{header.setInt16(42+2*a,value,true);header.setFloat32(80+4*a,1,true);});header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setUint8(123,2);header.setInt16(254,1,true);
  [[1,0,0,10],[0,1,0,-20],[0,0,1,30]].forEach((row,r)=>row.forEach((value,c)=>header.setFloat32(280+16*r+4*c,value,true)));bytes.set([110,43,49,0],344);
  for(let z=0;z<4;z++)for(let y=0;y<6;y++)for(let x=0;x<7;x++)header.setInt16(352+2*(x+7*(y+6*z)),uniform?10:x+10*y+100*z,true);
  const volume=parseNifti(bytes.buffer,'multiple-edit.nii');let state=createProject(volume);const first=state.selectedMaskId;
  state={...state,masks:state.masks.map(mask=>({...mask,name:'A',visible,data:initial.slice(),threshold:[21,32] as [number,number]}))};state=addMask(state,length,'B',bits((x,y,z)=>x===6&&y===0&&z===3));const second=state.selectedMaskId;
  state={...state,selectedMaskId:first,viewState:{point:[0,0,1],activeAxis:2,tool:'navigate',tab:'segmentation'}};return{volume,state,first,second};
}
async function withEditor(run:(editor:Editor,input:ReturnType<typeof fixture>)=>Promise<void>,options:{initial?:Uint8Array;uniform?:boolean;visible?:boolean}={}){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),editor=scope.run(()=>useWorkbench({repository:null}))! as Editor;
  const input=fixture(options.initial??bits(outside),options.uniform,options.visible);editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]);await nextTick();await run(editor,input);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
async function start(editor:Editor,axis:Axis=2,type:'brush'|'lasso'|'livewire'='brush'){
  editor.activeAxis.value=axis;editor.tool.value='multiple';editor.params.selectionType=type;editor.params.diameter=1;await nextTick();assert.equal(editor.multipleEditing.value,true);assert.equal(editor.selectionAxis.value,axis);
}
function pointSlice(editor:Editor,axis:Axis,slice:number){const point=[...editor.point.value] as Vec3;point[axis]=slice;editor.point.value=point;}
async function paint(editor:Editor,points:Vec3[],axis:Axis=2){
  editor.params.selectionType='brush';await nextTick();for(const point of points){pointSlice(editor,axis,point[axis]);editor.brushBegin(axis,point[axis]);editor.brushStroke(point,axis,point[axis]);editor.brushEnd();}
}
async function contour(editor:Editor,points:Vec3[],axis:Axis=2,finish=true){
  pointSlice(editor,axis,points[0]![axis]);await nextTick();for(const point of points)await editor.imagePick([...point],axis,point[axis]);if(finish)await editor.finishDrawing();
}
async function anchors(editor:Editor){await start(editor,2,'lasso');await contour(editor,outer(0));await contour(editor,outer(2));editor.params.startSlice=0;editor.params.endSlice=2;}
function assertSourceUnchanged(editor:Editor,state:BaseEditor['state']['value'],revision:number,undo:string){
  assert.ok(editor.state.value===state,'temporary editing must not publish project changes');assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.dirty.value,false);assert.equal(editor.state.value.measurements.length,0);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}

test('multiple/select/deselect share a session direction and preserve completed selection across type and operation changes',async()=>withEditor(async editor=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await start(editor);await paint(editor,[[1,1,1]]);const selected=editor.selection.value!.slice();
  for(const tool of ['select','deselect','multiple'])for(const type of ['brush','lasso','livewire'] as const){editor.tool.value=tool;editor.params.selectionType=type;await nextTick();assert.equal(editor.multipleEditing.value,true);assert.equal(editor.selectionAxis.value,2);assert.deepEqual(editor.selection.value,selected);if(type!=='brush')assert.equal(editor.imageTool.value,type);}
  editor.activeAxis.value=0;await nextTick();assert.equal(editor.selectionAxis.value,2,'hovering another view does not change the Copy to slices direction');editor.setSelectionAxis(0);assert.equal(editor.selectionAxis.value,0);assert.deepEqual(editor.selection.value,selected);
  editor.tool.value='navigate';await nextTick();assert.equal(editor.multipleEditing.value,false);assert.equal(editor.selection.value,null);assert.equal(editor.interpolationPreview.value,null);assertSourceUnchanged(editor,state,revision,undo);
}));

test('displayMasks isolates the active Mask with ephemeral visibility without changing real metadata or history',async()=>withEditor(async(editor,input)=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await start(editor);assert.equal(editor.displayMasks.value.length,1);assert.equal(editor.displayMasks.value[0]!.id,input.first);assert.equal(editor.displayMasks.value[0]!.visible,true);
  assert.equal(editor.activeMask.value!.visible,false);assert.equal(editor.state.value.masks.find(mask=>mask.id===input.second)!.visible,true);
  await paint(editor,[[1,1,1]]);assert.ok(editor.selection.value?.some(Boolean),'the temporarily displayed active mask is editable in this session');assertSourceUnchanged(editor,state,revision,undo);
  editor.closeMultipleEdit();assert.equal(editor.tool.value,'navigate');assert.equal(editor.displayMasks.value.length,2);assert.equal(editor.state.value.masks[0]!.visible,false);assert.equal(editor.state.value.masks[1]!.visible,true);assertSourceUnchanged(editor,state,revision,undo);
},{visible:false}));

for(const type of ['lasso','livewire'] as const)test(`Multiple Slice ${type} Select/Deselect applies union/difference only to the temporary mask`,async()=>withEditor(async editor=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await start(editor,2,type);editor.params.livewireWeight=0;editor.params.livewireAttraction=0;await nextTick();
  await contour(editor,type==='livewire'?wire():outer());assert.equal(editor.error.value,'');assert.deepEqual(editor.selection.value,bits((x,y,z)=>z===1&&roi(x,y)));assertSourceUnchanged(editor,state,revision,undo);
  editor.tool.value='deselect';await nextTick();await contour(editor,inner());assert.equal(editor.error.value,'');assert.deepEqual(editor.selection.value,bits((x,y,z)=>z===1&&roi(x,y)&&!(x>=2&&y>=2)));assertSourceUnchanged(editor,state,revision,undo);
  editor.tool.value='select';await nextTick();await contour(editor,inner());assert.deepEqual(editor.selection.value,bits((x,y,z)=>z===1&&roi(x,y)));assertSourceUnchanged(editor,state,revision,undo);
},{uniform:type==='livewire'}));

test('type, Select/Deselect, axis and slice changes cancel only unfinished contours while retaining completed members',async()=>{
  for(const change of ['type','operation','axis','slice'] as const)await withEditor(async editor=>{
    const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await start(editor);await paint(editor,[[5,4,1]]);const selected=editor.selection.value!.slice();editor.params.selectionType='lasso';await nextTick();await contour(editor,outer().slice(0,3),2,false);assert.ok(editor.draftPoints.value.length>=3);
    if(change==='type')editor.params.selectionType='livewire';else if(change==='operation')editor.tool.value='deselect';else if(change==='axis')editor.setSelectionAxis(0);else pointSlice(editor,2,2);
    await nextTick();assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);await editor.finishDrawing();assert.deepEqual(editor.selection.value,selected);assertSourceUnchanged(editor,state,revision,undo);
  });
});

test('changing target clears the old temporary mask and unfinished contour without changing either real Mask',async()=>withEditor(async(editor,input)=>{
  await start(editor);await paint(editor,[[5,4,1]]);editor.params.selectionType='lasso';await nextTick();await contour(editor,outer().slice(0,3),2,false);const revision=editor.revision.value,undo=editor.undoName.value,data=editor.state.value.masks.map(mask=>mask.data.slice());
  editor.selectMask(input.second);await nextTick();assert.equal(editor.multipleEditing.value,true);assert.equal(editor.selection.value,null);assert.equal(editor.interpolationPreview.value,null);assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);
  const state=editor.state.value;await editor.finishDrawing();assertSourceUnchanged(editor,state,revision,undo);editor.state.value.masks.forEach((mask,i)=>assert.deepEqual(mask.data,data[i]));
}));

test('in-flight Multiple Slice LiveWire results cannot revive contours after type, operation, axis, slice or target changes',async()=>{
  for(const change of ['type','operation','axis','slice','target'] as const)await withEditor(async(editor,input)=>{
    await start(editor);await paint(editor,[[5,4,1]]);const selected=editor.selection.value!.slice();editor.params.selectionType='livewire';editor.params.livewireWeight=0;await nextTick();const revision=editor.revision.value,undo=editor.undoName.value;
    const pending=editor.imagePick([1,1,1],2,1);
    if(change==='type')editor.params.selectionType='lasso';else if(change==='operation')editor.tool.value='deselect';else if(change==='axis')editor.setSelectionAxis(0);else if(change==='slice')pointSlice(editor,2,2);else editor.selectMask(input.second);
    await nextTick();await pending;assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);assert.equal(editor.busy.value,false);
    if(change==='target')assert.equal(editor.selection.value,null);else assert.deepEqual(editor.selection.value,selected);const state=editor.state.value;await editor.finishDrawing();assertSourceUnchanged(editor,state,revision,undo);
  },{uniform:true});
});

test('wrong-view editing cannot alter the fixed-axis selection until setSelectionAxis explicitly changes it',async()=>withEditor(async editor=>{
  await start(editor);await paint(editor,[[1,1,1]]);const selected=editor.selection.value!.slice();editor.activeAxis.value=0;pointSlice(editor,0,2);
  editor.brushBegin(0,2);editor.brushStroke([2,3,1],0,2);editor.brushEnd();assert.deepEqual(editor.selection.value,selected);assert.equal(editor.selectionAxis.value,2);
  editor.setSelectionAxis(0);await paint(editor,[[2,3,1]],0);assert.deepEqual(editor.selection.value,bits((x,y,z)=>x===1&&y===1&&z===1||x===2&&y===3&&z===1));assert.equal(editor.dirty.value,false);
}));

test('nonzero copy uses the fixed session axis, replaces full destination slices and jumps to the clipped last destination',async()=>withEditor(async editor=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await start(editor);await paint(editor,[[1,1,1],[2,1,1],[5,4,3]]);pointSlice(editor,2,1);editor.activeAxis.value=0;pointSlice(editor,0,3);
  editor.params.copyCount=99;editor.params.copyDirection=1;await editor.copySelection();assert.equal(editor.error.value,'');assert.deepEqual(editor.selection.value,bits((x,y,z)=>z>=1&&y===1&&(x===1||x===2)));assert.equal(editor.point.value[2],3);assert.equal(editor.point.value[0],3);assert.equal(editor.selectionAxis.value,2);assertSourceUnchanged(editor,state,revision,undo);
}));

test('reverse copy clips at the first slice and fixed sagittal copies also use their own axis',async()=>{
  await withEditor(async editor=>{await start(editor);await paint(editor,[[1,1,2]]);editor.params.copyCount=99;editor.params.copyDirection=-1;await editor.copySelection();assert.deepEqual(editor.selection.value,bits((x,y,z)=>x===1&&y===1&&z<=2));assert.equal(editor.point.value[2],0);assert.equal(editor.dirty.value,false);});
  await withEditor(async editor=>{await start(editor,0);await paint(editor,[[3,1,1],[3,2,1]],0);editor.activeAxis.value=2;editor.params.copyCount=99;editor.params.copyDirection=1;await editor.copySelection();assert.deepEqual(editor.selection.value,bits((x,y,z)=>x>=3&&z===1&&(y===1||y===2)));assert.equal(editor.point.value[0],6);assert.equal(editor.point.value[2],1);assert.equal(editor.selectionAxis.value,0);});
});

test('zero copy fills all remaining slices in either direction and keeps the current slice',async()=>{
  for(const direction of [1,-1] as const)await withEditor(async editor=>{await start(editor);const source=direction===1?1:2;await paint(editor,[[1,1,source]]);const before=[...editor.point.value];editor.params.copyCount=0;editor.params.copyDirection=direction;await editor.copySelection();assert.deepEqual(editor.selection.value,bits((x,y,z)=>x===1&&y===1&&(direction===1?z>=source:z<=source)));assert.deepEqual(editor.point.value,before);});
});

test('empty, invalid and cancelled copy preserve both selection and crosshair',async()=>withEditor(async editor=>{
  await start(editor);const emptyPoint=[...editor.point.value];await editor.copySelection();assert.equal(editor.selection.value,null);assert.deepEqual(editor.point.value,emptyPoint);
  await paint(editor,[[1,1,1]]);const selected=editor.selection.value,bytes=selected!.slice(),point=[...editor.point.value],state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
  for(const [count,direction] of [[-1,1],[1.5,1],[1,0]]){editor.params.copyCount=count;editor.params.copyDirection=direction;await editor.copySelection();assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,bytes);assert.deepEqual(editor.point.value,point);assertSourceUnchanged(editor,state,revision,undo);}
  editor.params.copyCount=2;editor.params.copyDirection=1;const pending=editor.copySelection();editor.cancel();await pending;assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,bytes);assert.deepEqual(editor.point.value,point);assert.equal(editor.busy.value,false);assertSourceUnchanged(editor,state,revision,undo);
}));

test('interpolation publishes a separate known preview and blocks editing, copy, repeat interpolation and final Apply until resolved',async()=>withEditor(async editor=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await anchors(editor);const selected=editor.selection.value,original=selected!.slice();assert.deepEqual(original,bits((x,y,z)=>roi(x,y)&&(z===0||z===2)));
  await editor.interpolateSelection();assert.equal(editor.error.value,'');const preview=editor.interpolationPreview.value;assert.ok(preview);assert.deepEqual(preview,bits((x,y,z)=>roi(x,y)&&z<=2));assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,original);assertSourceUnchanged(editor,state,revision,undo);
  await editor.interpolateSelection();assert.ok(editor.interpolationPreview.value===preview);
  editor.params.selectionType='brush';await nextTick();editor.brushBegin(2,2);editor.brushStroke([5,4,2],2,2);editor.brushEnd();assert.equal(editor.draft.value,null);
  editor.params.selectionType='lasso';await nextTick();await contour(editor,outer(1));assert.equal(editor.draftPoints.value.length,0);
  await editor.copySelection();await editor.applyTemporarySelection();assert.ok(editor.interpolationPreview.value===preview);assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,original);assertSourceUnchanged(editor,state,revision,undo);
  editor.applyInterpolation();assert.equal(editor.interpolationPreview.value,null);assert.deepEqual(editor.selection.value,bits((x,y,z)=>roi(x,y)&&z<=2));assertSourceUnchanged(editor,state,revision,undo);
}));

test('cancelInterpolation discards only its preview and cancelled/failed computations cannot replace the temporary mask',async()=>withEditor(async editor=>{
  await anchors(editor);const selected=editor.selection.value,original=selected!.slice(),point=[...editor.point.value],state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
  await editor.interpolateSelection();assert.ok(editor.interpolationPreview.value);editor.cancelInterpolation();assert.equal(editor.interpolationPreview.value,null);assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,original);
  const pending=editor.interpolateSelection();editor.cancel();await pending;assert.equal(editor.interpolationPreview.value,null);assert.ok(editor.selection.value===selected);assert.deepEqual(editor.point.value,point);
  editor.params.startSlice=2;editor.params.endSlice=0;await editor.interpolateSelection();assert.equal(editor.interpolationPreview.value,null);assert.ok(editor.selection.value===selected);assert.deepEqual(editor.selection.value,original);assert.deepEqual(editor.point.value,point);assertSourceUnchanged(editor,state,revision,undo);
}));

for(const operation of ['add','remove','threshold'] as const)test(`final temporary ${operation} edits only the known ROI in one active-Mask transaction`,async()=>{
  const initial=bits((x,y,z)=>outside(x,y,z)||(operation!=='add'&&z===1&&roi(x,y)));
  await withEditor(async(editor,input)=>{
    await start(editor,2,'lasso');await contour(editor,outer());const before=editor.state.value,revision=editor.revision.value,other=before.masks.find(mask=>mask.id===input.second)!.data.slice();editor.params.selectionOperation=operation;
    if(operation==='threshold'){editor.localThreshold.update(0,'upper',132);editor.localThreshold.update(0,'lower',121);editor.localThreshold.choose(0);assert.deepEqual(editor.localThreshold.range.value,{lower:121,upper:132});editor.params.lower=0;editor.params.upper=0;await nextTick();}
    await editor.applyTemporarySelection();const expected=bits((x,y,z)=>outside(x,y,z)||(z===1&&roi(x,y)&&(operation==='add'||operation==='threshold'&&x+10*y+100*z>=121&&x+10*y+100*z<=132)));
    assert.equal(editor.error.value,'');assert.deepEqual(editor.activeMask.value!.data,expected);assert.equal(editor.revision.value,revision+1);assert.equal(editor.dirty.value,true);assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.second)!.data,other);
    if(operation==='threshold')assert.deepEqual([editor.params.lower,editor.params.upper],[0,0],'local operation does not overwrite global threshold parameters');
    editor.undo();assert.deepEqual(editor.activeMask.value!.data,initial);editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,expected);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
  },{initial});
});

test('closeMultipleEdit drops temporary state and interpolation preview, returns to navigation, and leaves active data untouched',async()=>withEditor(async editor=>{
  const state=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await anchors(editor);await editor.interpolateSelection();assert.ok(editor.selection.value);assert.ok(editor.interpolationPreview.value);
  editor.closeMultipleEdit();assert.equal(editor.tool.value,'navigate');assert.equal(editor.multipleEditing.value,false);assert.equal(editor.selection.value,null);assert.equal(editor.interpolationPreview.value,null);assert.equal(editor.draft.value,null);assert.equal(editor.draftPoints.value.length,0);assertSourceUnchanged(editor,state,revision,undo);
}));

test('same-target rename and final Apply preserve the completed selection instead of restarting its session',async()=>withEditor(async(editor,input)=>{
  await start(editor);await paint(editor,[[1,1,1]]);const selected=editor.selection.value,selectionBytes=selected!.slice(),initial=editor.activeMask.value!.data.slice();
  editor.updateMask(input.first,{name:'A renamed'});await nextTick();assert.equal(editor.state.value.selectedMaskId,input.first);assert.equal(editor.activeMask.value!.name,'A renamed');assert.ok(editor.selection.value===selected,'same-ID metadata edits keep the selection owner and buffer');assert.deepEqual(editor.selection.value,selectionBytes);
  const beforeApply=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;editor.params.selectionOperation='add';await editor.applyTemporarySelection();await nextTick();
  assert.equal(editor.error.value,'');assert.equal(editor.revision.value,revision+1);assert.ok(editor.selection.value===selected,'applying to the same target does not restart the temporary session');assert.deepEqual(editor.selection.value,selectionBytes);assert.deepEqual(editor.activeMask.value!.data,bits((x,y,z)=>outside(x,y,z)||x===1&&y===1&&z===1));
  editor.undo();assert.deepEqual(editor.state.value,beforeApply,'one Undo restores exactly the renamed project before Apply');assert.equal(editor.activeMask.value!.name,'A renamed');assert.equal(editor.undoName.value,undo);assert.deepEqual(editor.activeMask.value!.data,initial);assert.ok(editor.selection.value===selected);
  editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,bits((x,y,z)=>outside(x,y,z)||x===1&&y===1&&z===1));assert.ok(editor.selection.value===selected);
}));
