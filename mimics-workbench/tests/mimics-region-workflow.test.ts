import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import type {Ref,ComputedRef} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,addMask,encodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {Axis,Vec3,MaskObject} from '../src/mimics/types.ts';

// Actual controller and operations.worker.ts, with a Node structured-clone
// adapter. This does not run the browser, original program or native oracle.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>&{regionSourceId:Ref<string>;regionSource:ComputedRef<MaskObject|undefined>;setRegionSource:(id:string)=>void;swapRegionMasks:()=>void};
const dims:Vec3=[7,6,3],length=126;
const face:Vec3[]=[[1,1,0],[2,1,0],[1,1,1]],diagonal:Vec3[]=[[3,2,0],[3,2,1]],remote:Vec3[]=[[5,4,0],[5,4,1]],sourcePoints=[...face,...diagonal,...remote];
const marker:Vec3=[0,5,2],otherMarker:Vec3=[6,0,2];
function bits(points:Vec3[]){const result=new Uint8Array(length);for(const [x,y,z] of points)result[x+7*(y+6*z)]=1;return result;}
function fixture(){
  const bytes=new Uint8Array(352+length),view=new DataView(bytes.buffer);view.setInt32(0,348,true);view.setInt16(40,3,true);dims.forEach((n,a)=>{view.setInt16(42+a*2,n,true);view.setFloat32(80+a*4,1,true);});view.setInt16(70,2,true);view.setInt16(72,8,true);view.setFloat32(108,352,true);view.setUint8(123,2);bytes.set([110,43,49,0],344);bytes.fill(100,352);
  const volume=parseNifti(bytes.buffer,'region-workflow.nii');let state=createProject(volume);const a=state.selectedMaskId;state={...state,masks:state.masks.map(mask=>({...mask,name:'Source A',threshold:[100,100] as [number,number],data:bits(sourcePoints)}))};
  state=addMask(state,length,'Target B',bits([marker,face[0]!]));const b=state.selectedMaskId;state=addMask(state,length,'Visible C',bits([otherMarker]));const c=state.selectedMaskId;
  state={...state,selectedMaskId:a,viewState:{point:[0,0,0],activeAxis:2,tool:'navigate',tab:'segmentation'}};return{volume,state,a,b,c};
}
async function withEditor(run:(editor:Editor,input:ReturnType<typeof fixture>)=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),editor=scope.run(()=>useWorkbench({repository:null}))! as Editor,input=fixture();editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]);await nextTick();await run(editor,input);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
async function enter(editor:Editor,input:ReturnType<typeof fixture>){editor.tool.value='region';await nextTick();assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.regionSource.value?.id,input.a);assert.equal(editor.params.target,'new');}
async function click(editor:Editor,seed:Vec3=face[0]!,axis:Axis=2){await editor.imagePick([...seed],axis,seed[axis]);assert.equal(editor.busy.value,false);}
function assertNoCommit(editor:Editor,state:Editor['state']['value'],revision:number,undo:string,dirty:boolean){assert.ok(editor.state.value===state,'the request must not publish a new project');assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.dirty.value,dirty);assert.equal(editor.state.value.measurements.length,0);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));}

test('Source/Target are independent of the active visualization Mask and Swap exchanges two existing IDs without history',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.selectMask(input.c);const selected=editor.state.value,revision=editor.revision.value;
  assert.equal(editor.regionSourceId.value,input.a,'changing visualization does not silently replace Source');editor.setRegionSource(input.b);editor.params.target=input.a;await nextTick();assert.equal(editor.state.value.selectedMaskId,input.c);assert.ok(editor.state.value===selected);
  editor.swapRegionMasks();assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.regionSource.value?.id,input.a);assert.equal(editor.params.target,input.b);assert.equal(editor.state.value.selectedMaskId,input.c);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,'');assert.equal(editor.dirty.value,false);
  editor.updateMask(input.a,{name:'Source renamed'});editor.updateMask(input.b,{name:'Target renamed'});assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.params.target,input.b);
  editor.tool.value='navigate';await nextTick();editor.tool.value='region';await nextTick();assert.equal(editor.regionSourceId.value,input.c,'a fresh Region Growing session defaults to the current active mask');assert.equal(editor.params.target,'new');
}));

test('Target New creates one separate nonempty Mask per click while Source and active selection stay unchanged',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.params.leaveOriginal=true;editor.params.connectivity=6;editor.params.multiple=true;const before=editor.state.value,revision=editor.revision.value;
  await click(editor);assert.equal(editor.error.value,'');assert.equal(editor.state.value.masks.length,4);const first=editor.state.value.masks[3]!;assert.deepEqual(first.data,bits(face));assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.params.target,'new');assert.equal(editor.state.value.selectedMaskId,input.a,'the help requires explicitly activating a generated Mask');assert.deepEqual(editor.regionSource.value!.data,bits(sourcePoints));
  await click(editor,remote[0]!);assert.equal(editor.state.value.masks.length,5);assert.deepEqual(editor.state.value.masks[4]!.data,bits(remote));assert.deepEqual(editor.state.value.masks[3]!.data,bits(face));assert.equal(editor.params.target,'new');assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.revision.value,revision+2);
  editor.undo();assert.equal(editor.state.value.masks.length,4);editor.undo();assert.deepEqual(editor.state.value,before);editor.undo(true);editor.undo(true);assert.equal(editor.state.value.masks.length,5);
}));

test('existing Target receives the selected Source component even when another Mask is active, and repeated copy is a whole-operation no-op',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.selectMask(input.c);editor.params.target=input.b;editor.params.leaveOriginal=true;editor.params.connectivity=6;const before=editor.state.value,revision=editor.revision.value;
  await click(editor);assert.equal(editor.error.value,'');assert.equal(editor.state.value.masks.length,3);assert.equal(editor.state.value.selectedMaskId,input.c);assert.equal(editor.regionSourceId.value,input.a);assert.deepEqual(editor.regionSource.value!.data,bits(sourcePoints));assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.b)!.data,bits([marker,...face]));assert.equal(editor.revision.value,revision+1);
  const copied=editor.state.value,undo=editor.undoName.value;await click(editor);assertNoCommit(editor,copied,revision+1,undo,true);
  editor.undo();assert.deepEqual(editor.state.value,before,'the repeated component did not add an empty history entry');editor.undo(true);assert.deepEqual(editor.state.value,copied);
}));

test('Leave Original off moves into an overlapping existing Target atomically, including when only Source changes',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.params.target=input.b;editor.params.connectivity=6;editor.params.leaveOriginal=true;await click(editor);
  const beforeMove=editor.state.value,target=editor.state.value.masks.find(mask=>mask.id===input.b)!.data.slice(),revision=editor.revision.value;editor.params.leaveOriginal=false;await click(editor);
  assert.equal(editor.error.value,'');assert.deepEqual(editor.regionSource.value!.data,bits([...diagonal,...remote]));assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.b)!.data,target);assert.equal(editor.revision.value,revision+1,'source removal makes this a real transaction even if target already contained the component');assert.equal(editor.state.value.selectedMaskId,input.a);
  editor.undo();assert.deepEqual(editor.state.value,beforeMove);editor.undo(true);assert.deepEqual(editor.regionSource.value!.data,bits([...diagonal,...remote]));
}));

test('background seeds and same-source targets cannot create empty masks, history or a partial source cut',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.params.leaveOriginal=false;const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
  await click(editor,[6,5,2]);assertNoCommit(editor,before,revision,undo,false);assert.equal(editor.state.value.masks.length,3);assert.equal(editor.params.target,'new');
  editor.params.target=input.a;await click(editor);assert.ok(editor.error.value);assertNoCommit(editor,before,revision,undo,false);assert.deepEqual(editor.regionSource.value!.data,bits(sourcePoints));
}));

test('6/26 connectivity and Multiple off use explicit source membership and the clicked orthogonal plane',async()=>{
  const cases:{connectivity:6|26;multiple:boolean;axis:Axis;expected:Vec3[]}[]=[
    {connectivity:6,multiple:true,axis:2,expected:face},
    {connectivity:26,multiple:true,axis:2,expected:[...face,...diagonal]},
    {connectivity:6,multiple:false,axis:2,expected:face.slice(0,2)},
    {connectivity:26,multiple:false,axis:2,expected:[...face.slice(0,2),diagonal[0]!] },
    {connectivity:6,multiple:false,axis:0,expected:[face[0]!,face[2]!] },
    {connectivity:6,multiple:false,axis:1,expected:face},
  ];
  for(const item of cases)await withEditor(async(editor,input)=>{await enter(editor,input);editor.params.connectivity=item.connectivity;editor.params.multiple=item.multiple;editor.params.leaveOriginal=true;await click(editor,face[0]!,item.axis);assert.equal(editor.error.value,'');assert.deepEqual(editor.state.value.masks.at(-1)!.data,bits(item.expected));assert.deepEqual(editor.regionSource.value!.data,bits(sourcePoints));assert.equal(editor.state.value.selectedMaskId,input.a);});
});

test('changing Source, Target, connectivity, Multiple or Leave Original discards an in-flight move with no partial commit',async()=>{
  for(const change of ['source','target','connectivity','multiple','leaveOriginal'] as const)await withEditor(async(editor,input)=>{
    await enter(editor,input);editor.params.leaveOriginal=false;editor.params.connectivity=6;editor.params.multiple=true;const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
    const pending=editor.imagePick([...face[0]!],2,0);
    if(change==='source')editor.setRegionSource(input.b);else if(change==='target')editor.params.target=input.b;else if(change==='connectivity')editor.params.connectivity=26;else if(change==='multiple')editor.params.multiple=false;else editor.params.leaveOriginal=true;
    await nextTick();await pending;assert.equal(editor.busy.value,false);assertNoCommit(editor,before,revision,undo,false);assert.equal(editor.state.value.masks.length,3);assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.a)!.data,bits(sourcePoints));
  });
});

test('cancel and immediate rerun retain the independent Source and publish only the newer region request',async()=>withEditor(async(editor,input)=>{
  await enter(editor,input);editor.params.leaveOriginal=true;editor.params.connectivity=6;const revision=editor.revision.value;const first=editor.imagePick([...face[0]!],2,0);editor.cancel();editor.params.connectivity=26;const second=editor.imagePick([...face[0]!],2,0);await Promise.all([first,second]);
  assert.equal(editor.error.value,'');assert.equal(editor.busy.value,false);assert.equal(editor.state.value.masks.length,4);assert.deepEqual(editor.state.value.masks[3]!.data,bits([...face,...diagonal]));assert.equal(editor.regionSourceId.value,input.a);assert.equal(editor.params.target,'new');assert.equal(editor.state.value.selectedMaskId,input.a);assert.equal(editor.revision.value,revision+1);
}));

test('deleting Source/Target and opening another document do not leave stale workflow IDs',async()=>{
  await withEditor(async(editor,input)=>{
    await enter(editor,input);editor.params.target=input.b;editor.selectMask(input.b);editor.deleteMask();await nextTick();assert.equal(editor.params.target,'new');assert.equal(editor.regionSourceId.value,input.a);
    editor.selectMask(input.a);editor.deleteMask();await nextTick();assert.equal(editor.regionSourceId.value,input.c);assert.equal(editor.regionSource.value?.id,input.c);assert.equal(editor.params.target,'new');editor.deleteMask();await nextTick();assert.equal(editor.regionSourceId.value,'');assert.equal(editor.regionSource.value,undefined);assert.equal(editor.params.target,'new');
    const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;await click(editor);assertNoCommit(editor,before,revision,undo,true);
  });
  await withEditor(async(editor,input)=>{
    await enter(editor,input);editor.params.target=input.b;const replacement=fixture();assert.equal(await editor.openFiles([new File([encodeProject(replacement.volume,replacement.state).slice().buffer as ArrayBuffer],'replacement.deepmark.zip')]),true);assert.ok(![input.a,input.b,input.c].includes(editor.regionSourceId.value));editor.tool.value='region';await nextTick();assert.equal(editor.regionSourceId.value,replacement.a);assert.equal(editor.params.target,'new');
  });
});

test('legacy direct runMask region uses active Source when its separate source ID is absent',async()=>withEditor(async(editor,input)=>{
  editor.regionSourceId.value='';editor.params.target='new';editor.params.leaveOriginal=true;await editor.runMask('region','legacy region',{connectivity:6},face[0]);assert.equal(editor.error.value,'');assert.equal(editor.state.value.masks.length,4);assert.deepEqual(editor.state.value.masks[3]!.data,bits(face));assert.deepEqual(editor.state.value.masks.find(mask=>mask.id===input.a)!.data,bits(sourcePoints));
}));
