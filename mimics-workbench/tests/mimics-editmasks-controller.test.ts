import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,addMask,encodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {Vec3} from '../src/mimics/types.ts';

// Real composable and operations.worker.ts through Node structured clone.
// This verifies contour/controller transactions, not browser lasso pointer
// sampling, double-click behavior, canvas overlays or native Mimics equivalence.
const workers=new Set<NodeWorker>();
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  worker:NodeWorker;
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));
  }
  postMessage(value:unknown){this.worker.postMessage(value);}
  terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
type Operation='add'|'remove'|'threshold';
const dims:Vec3=[7,6,2],length=84,index=(x:number,y:number,z:number)=>x+7*(y+6*z);
const rectangle=(x:number,y:number,z:number)=>z===0&&x>=1&&x<=4&&y>=1&&y<=4;
const outside=(x:number,y:number,z:number)=>x===0&&y===0&&z===0||x===6&&y===5&&z===1;
function bits(predicate:(x:number,y:number,z:number)=>boolean){
  return Uint8Array.from({length},(_,i)=>predicate(i%7,Math.floor(i/7)%6,Math.floor(i/42))?1:0);
}
const corners:Vec3[]=[[1,1,0],[4,1,0],[4,4,0],[1,4,0]];
// Consecutive anchors (including closure) are neighboring voxels. On the
// constant image, each shortest segment is the known single boundary edge.
const livewireAnchors:Vec3[]=[[1,1,0],[2,1,0],[3,1,0],[4,1,0],[4,2,0],[4,3,0],[4,4,0],[3,4,0],[2,4,0],[1,4,0],[1,3,0],[1,2,0]];
function fixture(initial:Uint8Array,uniform=false){
  const bytes=new Uint8Array(352+length*2),header=new DataView(bytes.buffer);
  header.setInt32(0,348,true);header.setInt16(40,3,true);
  dims.forEach((value,a)=>{header.setInt16(42+2*a,value,true);header.setFloat32(80+4*a,1,true);});
  header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setUint8(123,2);header.setInt16(254,1,true);
  [[1,0,0,10],[0,1,0,-20],[0,0,1,30]].forEach((row,r)=>row.forEach((value,c)=>header.setFloat32(280+16*r+4*c,value,true)));bytes.set([110,43,49,0],344);
  for(let z=0;z<2;z++)for(let y=0;y<6;y++)for(let x=0;x<7;x++)header.setInt16(352+2*index(x,y,z),uniform?10:x+10*y+100*z,true);
  const volume=parseNifti(bytes.buffer,'edit-mask.nii');let state=createProject(volume);const first=state.selectedMaskId;
  state={...state,masks:state.masks.map(mask=>({...mask,name:'Active',data:initial.slice(),threshold:[21,32] as [number,number]}))};
  state=addMask(state,length,'Other',bits((x,y,z)=>x===6&&y===0&&z===1));const second=state.selectedMaskId;
  state={...state,selectedMaskId:first,viewState:{point:[0,0,0],activeAxis:2,tool:'navigate',tab:'segmentation'}};
  return{volume,state,first,second};
}
async function withEditor(initial:Uint8Array,run:(editor:Editor,input:ReturnType<typeof fixture>)=>Promise<void>,uniform=false){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),editor=scope.run(()=>useWorkbench({repository:null}))!,input=fixture(initial,uniform);editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]);await nextTick();await run(editor,input);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function setOperation(editor:Editor,operation:Operation){
  // Explicit intended public contract while root adds this field to params.
  (editor.params as typeof editor.params&{editOperation:Operation}).editOperation=operation;
}
function setLocalRange(editor:Editor,lower:number,upper:number){
  const existing=editor.localThreshold.ranges.value[0];
  assert.equal(editor.localThreshold.update(0,'upper',Math.max(existing.upper,upper,lower)),true);
  assert.equal(editor.localThreshold.update(0,'lower',lower),true);
  assert.equal(editor.localThreshold.update(0,'upper',upper),true);
  assert.equal(editor.localThreshold.choose(0),true);
}
async function addPoints(editor:Editor,points:Vec3[]=corners){for(const point of points)await editor.imagePick([...point],2,point[2]);}
async function beginContour(editor:Editor,operation:Operation,shape:'lasso'|'livewire'='lasso'){
  editor.tool.value=shape;setOperation(editor,operation);await nextTick();
}
function assertUncommitted(editor:Editor,state:Editor['state']['value'],revision:number,undo:string){
  assert.ok(editor.state.value===state,'no new committed project');assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.busy.value,false);
  assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}

for(const operation of ['add','remove','threshold'] as const){
  test(`ordinary lasso ${operation} edits known voxels directly with one Undo/Redo and preserves the temporary selection`,async()=>{
    const initial=bits((x,y,z)=>outside(x,y,z)||(operation!=='add'&&rectangle(x,y,z)));
    await withEditor(initial,async(editor,input)=>{
      await beginContour(editor,operation);setLocalRange(editor,21,32);editor.params.lower=0;editor.params.upper=0;await nextTick();
      const temporary=bits((x,y,z)=>x===5&&y===5&&z===1);editor.selection.value=temporary;
      const before=editor.state.value,revision=editor.revision.value,other=before.masks.find(mask=>mask.id===input.second)!.data.slice();
      await addPoints(editor);assert.ok(editor.state.value===before,'placing contour points is provisional');await editor.finishDrawing();
      const expected=bits((x,y,z)=>outside(x,y,z)||(rectangle(x,y,z)&&(operation==='add'||operation==='threshold'&&x+10*y>=21&&x+10*y<=32)));
      assert.equal(editor.error.value,'');assert.deepEqual(editor.activeMask.value!.data,expected);assert.equal(editor.revision.value,revision+1);assert.equal(editor.dirty.value,true);
      assert.deepEqual([editor.params.lower,editor.params.upper],[0,0],'local contour editing never changes global threshold controls');assert.deepEqual(editor.activeMask.value!.threshold,[21,32]);
      assert.ok(editor.selection.value===temporary,'ordinary editing does not publish or replace a Multiple Slice Edit selection');assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.second)!.data,other);
      assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);assert.equal(editor.state.value.measurements.length,0);
      editor.undo();assert.deepEqual(editor.activeMask.value!.data,initial);editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,expected);
      assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
    });
  });
}

for(const operation of ['add','remove','threshold'] as const){
  test(`ordinary LiveWire ${operation} closes the real worker path and edits the active mask without a temporary Apply`,async()=>{
    const initial=bits((x,y,z)=>outside(x,y,z)||(operation!=='add'&&rectangle(x,y,z)));
    await withEditor(initial,async editor=>{
      await beginContour(editor,operation,'livewire');editor.params.livewireWeight=0;editor.params.livewireAttraction=0;setLocalRange(editor,20,30);await nextTick();
      const before=editor.state.value,revision=editor.revision.value,temporary=bits((x,y,z)=>x===6&&y===5&&z===0);editor.selection.value=temporary;
      await addPoints(editor,livewireAnchors);assert.equal(editor.error.value,'');assert.ok(editor.state.value===before);await editor.finishDrawing();
      const expected=bits((x,y,z)=>outside(x,y,z)||(operation==='add'&&rectangle(x,y,z)));
      assert.equal(editor.error.value,'');assert.deepEqual(editor.activeMask.value!.data,expected);assert.equal(editor.revision.value,revision+1);assert.ok(editor.selection.value===temporary);assert.equal(editor.state.value.measurements.length,0);
      editor.undo();assert.deepEqual(editor.activeMask.value!.data,initial);editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,expected);
    },true);
  });
}

test('invalid contours and unchanged operations never create a history entry',async()=>{
  await withEditor(bits(()=>false),async editor=>{
    await beginContour(editor,'add');const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
    await addPoints(editor,corners.slice(0,2));await editor.finishDrawing();assertUncommitted(editor,before,revision,undo);assert.equal(editor.dirty.value,false);
    editor.cancel();await addPoints(editor,[[1,1,0],[2,2,0],[3,3,0]]);await editor.finishDrawing();assertUncommitted(editor,before,revision,undo);assert.equal(editor.dirty.value,false);
  });
  for(const operation of ['add','remove','threshold'] as const){
    const initial=bits((x,y,z)=>outside(x,y,z)||(rectangle(x,y,z)&&(operation==='add'||operation==='threshold'&&x+10*y>=21&&x+10*y<=32)));
    await withEditor(initial,async editor=>{
      await beginContour(editor,operation);setLocalRange(editor,21,32);await nextTick();const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
      await addPoints(editor);await editor.finishDrawing();assert.equal(editor.error.value,'');assertUncommitted(editor,before,revision,undo);assert.equal(editor.dirty.value,false);
    });
  }
});

test('changing the target, edit operation, threshold range or slice cancels an unfinished ordinary contour',async()=>{
  for(const change of ['target','operation','threshold','slice'] as const){
    await withEditor(bits(outside),async(editor,input)=>{
      await beginContour(editor,change==='threshold'?'threshold':'add');setLocalRange(editor,21,32);await addPoints(editor,corners.slice(0,3));assert.ok(editor.draftPoints.value.length>=3);
      const revision=editor.revision.value,undo=editor.undoName.value,data=editor.state.value.masks.map(mask=>mask.data.slice());
      if(change==='target')editor.selectMask(input.second);
      else if(change==='operation')setOperation(editor,'remove');
      else if(change==='threshold')editor.localThreshold.update(0,'lower',22);
      else editor.point.value=[0,0,1];
      await nextTick();assert.equal(editor.draftPoints.value.length,0,`${change} clears the old contour`);assert.equal(editor.draftPlane.value,null);
      const current=editor.state.value;await editor.finishDrawing();assertUncommitted(editor,current,revision,undo);editor.state.value.masks.forEach((mask,i)=>assert.deepEqual(mask.data,data[i]));assert.equal(editor.dirty.value,false);
    });
  }
});

test('LiveWire parameter changes and explicit cancellation discard pending worker contour results',async()=>{
  for(const change of ['weight','operation','cancel'] as const){
    await withEditor(bits(outside),async editor=>{
      await beginContour(editor,'add','livewire');const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
      const pending=editor.imagePick([1,1,0],2,0);
      if(change==='weight')editor.params.livewireWeight=.2;else if(change==='operation')setOperation(editor,'remove');else editor.cancel();
      await nextTick();await pending;assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);await editor.finishDrawing();assertUncommitted(editor,before,revision,undo);assert.equal(editor.dirty.value,false);
    },true);
  }
});

test('non-measurement tools never fall through to measurement creation and Multiple Slice Select only edits the temporary mask',async()=>withEditor(bits(outside),async editor=>{
  const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
  for(const tool of ['multiple','boolean','crop','not-a-measurement']){
    editor.tool.value=tool;await nextTick();await addPoints(editor,corners.slice(0,3));await editor.finishDrawing();assertUncommitted(editor,before,revision,undo);assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.draftPlane.value,null);
  }
  editor.tool.value='select';editor.params.diameter=1;await nextTick();editor.brushBegin(2,0);editor.brushStroke([2,2,0],2,0);editor.brushEnd();
  assertUncommitted(editor,before,revision,undo);assert.deepEqual(editor.selection.value,bits((x,y,z)=>x===2&&y===2&&z===0));assert.deepEqual(editor.activeMask.value!.data,bits(outside));assert.equal(editor.dirty.value,false);
  editor.tool.value='annotation';await nextTick();await editor.imagePick([0,0,0],2,0);assert.equal(editor.state.value.measurements.length,0,'annotation creation waits for its properties dialog');assert.ok(editor.measurementEditor.draft.value);assert.equal(editor.measurementEditor.apply({text:'confirmed annotation'}),true);assert.equal(editor.state.value.measurements.length,1,'the whitelist still permits a confirmed annotation');assert.equal(editor.state.value.measurements[0]!.kind,'annotation');assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));
