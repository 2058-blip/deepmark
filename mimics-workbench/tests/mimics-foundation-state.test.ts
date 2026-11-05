import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {WorkbenchOptions} from '../src/mimics/useWorkbench.ts';
import {addMask,createProject,decodeProject,encodeProject,validateProject} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import type {MeasurementObject} from '../src/mimics/types.ts';
import type {WorkspaceRepository,WorkspaceSnapshot} from '../src/mimics/workspaceRepository.ts';

const workers=new Set<NodeWorker>();
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  worker:NodeWorker;
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads'; globalThis.self={postMessage:value=>parentPort.postMessage(value)}; await import(${JSON.stringify(url.href)}); parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));
  }
  postMessage(value:unknown){this.worker.postMessage(value);}
  terminate(){void this.worker.terminate();}
}
function fixture(){
  const buffer=new ArrayBuffer(360),header=new DataView(buffer),bytes=new Uint8Array(buffer);
  header.setInt32(0,348,true);header.setInt16(40,3,true);
  for(let a=0;a<3;a++){header.setInt16(42+a*2,2,true);header.setFloat32(80+a*4,1,true);}
  header.setInt16(70,2,true);header.setInt16(72,8,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setUint8(123,2);
  bytes.set([110,43,49,0],344);bytes.set([0,1,2,3,4,5,6,7],352);
  const volume=parseNifti(buffer,'state.nii');let state=createProject(volume);
  state={...state,masks:state.masks.map(m=>({...m,name:'A',threshold:[1,3]}))};const a=state.selectedMaskId;
  state=addMask(state,8,'B');state={...state,masks:state.masks.map(m=>m.id===state.selectedMaskId?{...m,threshold:[4,6]}:m)};const b=state.selectedMaskId;
  state=addMask(state,8,'Unsegmented');const unsegmented=state.selectedMaskId;
  const measurement=(id:string):MeasurementObject=>({id,name:id,kind:'distance',points:[[0,0,0],[1,0,0]],color:'#ffffff',visible:true});
  state={...state,selectedMaskId:a,measurements:[measurement('measurement-a'),measurement('measurement-b')],viewState:{point:[0,0,0],window:{center:3,width:7},tool:'navigate',tab:'segmentation',selectedMeasurementId:'measurement-a'}};
  return{volume,state,a,b,unsegmented};
}
type Fixture=ReturnType<typeof fixture>;
type Editor=ReturnType<typeof useWorkbench>;
async function withEditor(run:(editor:Editor,input:Fixture,exports:Uint8Array[])=>Promise<void>,options:WorkbenchOptions={}){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,...options,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!;
  const input=fixture();editor.params.thresholdAutoPreview=false;
  try{
    assert.equal(await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]),true);
    await nextTick();await run(editor,input,exports);
  }finally{
    editor.cancel();if(editor.cacheAvailable)await editor.flushLocalCache();scope.stop();globalThis.Worker=previous;
    await Promise.all([...workers].map(worker=>worker.terminate()));
  }
}
function assertSelectionValid(editor:Editor){
  assert.ok(!editor.selectedMeasurementId.value||editor.state.value.measurements.some(m=>m.id===editor.selectedMeasurementId.value));
  assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}
async function assertSaveValid(editor:Editor,exports:Uint8Array[]){
  assert.equal((await editor.saveProject())?.status,'written');assert.equal(editor.error.value,'');
  const restored=decodeProject(exports.at(-1)!);assert.equal(restored.state.viewState?.selectedMeasurementId,editor.selectedMeasurementId.value);validateProject(restored.volume,restored.state);
}

test('deleting a selected measurement and replaying the transaction cannot leave an unsavable selection',{timeout:15000},async()=>{
  await withEditor(async(editor,_input,exports)=>{
    editor.deleteMeasurement('measurement-b');assert.equal(editor.selectedMeasurementId.value,'measurement-a');editor.undo();
    editor.deleteMeasurement('measurement-a');assert.equal(editor.selectedMeasurementId.value,'');assertSelectionValid(editor);await assertSaveValid(editor,exports);
    editor.undo();assert.equal(editor.state.value.measurements.some(m=>m.id==='measurement-a'),true);assertSelectionValid(editor);
    editor.locateMeasurement('measurement-a');editor.undo(true);assert.equal(editor.selectedMeasurementId.value,'');assertSelectionValid(editor);await assertSaveValid(editor,exports);
  });
});

test('undoing a newly created selected measurement clears it immediately and redo remains savable',{timeout:15000},async()=>{
  await withEditor(async(editor,_input,exports)=>{
    editor.tool.value='distance';await editor.imagePick([0,0,0],2,0);await editor.imagePick([1,0,0],2,0);
    const added=editor.state.value.measurements.at(-1)!;assert.notEqual(added.id,'measurement-b');editor.locateMeasurement(added.id);assert.equal(editor.selectedMeasurementId.value,added.id);
    editor.undo();assert.equal(editor.state.value.measurements.some(m=>m.id===added.id),false);assert.equal(editor.selectedMeasurementId.value,'');assertSelectionValid(editor);await assertSaveValid(editor,exports);
    editor.undo(true);assert.equal(editor.state.value.measurements.some(m=>m.id===added.id),true);assertSelectionValid(editor);await assertSaveValid(editor,exports);
    editor.selectedMeasurementId.value='removed-before-click';assert.equal(editor.selectedMeasurementId.value,'');assertSelectionValid(editor);
  });
});

test('threshold controls follow the selected mask metadata, defaults and mask deletion undo-redo',{timeout:15000},async()=>{
  await withEditor(async(editor,input)=>{
    assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.params.lower=2;editor.params.upper=5;editor.updateMask(input.a,{name:'renamed'});assert.deepEqual([editor.params.lower,editor.params.upper],[2,5],'unrelated metadata must not discard a draft range');
    editor.selectMask(input.b);assert.deepEqual([editor.params.lower,editor.params.upper],[4,6]);
    editor.selectMask(input.a);assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.selectMask(input.unsegmented);assert.deepEqual([editor.params.lower,editor.params.upper],[7,7]);
    editor.selectMask(input.b);editor.deleteMask();assert.equal(editor.state.value.selectedMaskId,input.a);assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.undo();assert.equal(editor.state.value.selectedMaskId,input.b);assert.deepEqual([editor.params.lower,editor.params.upper],[4,6]);
    editor.undo(true);assert.equal(editor.state.value.selectedMaskId,input.a);assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.duplicateMask();assert.deepEqual(editor.activeMask.value!.threshold,[1,3]);assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.newMask();assert.equal(editor.activeMask.value!.threshold,null);assert.deepEqual([editor.params.lower,editor.params.upper],[7,7]);
  });
});

test('applied threshold metadata and panel range restore together through undo-redo and project save',{timeout:15000},async()=>{
  await withEditor(async(editor,_input,exports)=>{
    editor.tool.value='threshold';editor.params.lower=2;editor.params.upper=5;
    await editor.thresholdPreview();assert.equal(editor.error.value,'');editor.applyPreview();
    assert.deepEqual(editor.activeMask.value!.threshold,[2,5]);assert.deepEqual([...editor.activeMask.value!.data],[0,0,1,1,1,1,0,0]);
    editor.undo();assert.deepEqual(editor.activeMask.value!.threshold,[1,3]);assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.undo(true);assert.deepEqual(editor.activeMask.value!.threshold,[2,5]);assert.deepEqual([editor.params.lower,editor.params.upper],[2,5]);
    await assertSaveValid(editor,exports);assert.deepEqual(decodeProject(exports.at(-1)!).state.masks[0]!.threshold,[2,5]);
  });
});

class MemoryRepository implements WorkspaceRepository {
  records=new Map<string,WorkspaceSnapshot>();
  async save(snapshot:WorkspaceSnapshot){this.records.set(snapshot.id,structuredClone(snapshot));}
  async load(id:string){return structuredClone(this.records.get(id)??null);}
  async list(){return [];}
}
test('local project restoration applies threshold and measurement selection, while legacy view state resets selection',{timeout:15000},async()=>{
  const repository=new MemoryRepository(),input=fixture(),legacy:ProjectState={...input.state,selectedMaskId:input.b};delete legacy.viewState;
  repository.records.set('saved',{id:'saved',volume:input.volume,state:input.state,updatedAt:1});repository.records.set('legacy',{id:'legacy',volume:input.volume,state:legacy,updatedAt:2});
  await withEditor(async(editor)=>{
    await editor.restoreLocalProject('saved');assert.equal(editor.selectedMeasurementId.value,'measurement-a');assert.deepEqual([editor.params.lower,editor.params.upper],[1,3]);
    editor.deleteMeasurement('measurement-a');await editor.flushLocalCache();
    const saved=repository.records.get('saved')!;assert.equal(saved.state.viewState?.selectedMeasurementId,'');assert.doesNotThrow(()=>validateProject(saved.volume,saved.state));
    await editor.restoreLocalProject('legacy');assert.ok(editor.pendingReplacement.value);await editor.confirmReplacement('discard');
    assert.equal(editor.selectedMeasurementId.value,'');assert.deepEqual([editor.params.lower,editor.params.upper],[4,6]);assertSelectionValid(editor);
  },{repository,autosaveDelayMs:60_000});
});
