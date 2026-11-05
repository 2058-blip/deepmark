import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addMask,createProject,decodeProject,encodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {LocalThresholdSlot} from '../src/mimics/useLocalThreshold.ts';

// Exercise the real controller and worker module, without browser or filesystem UI.
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
  const values=[10,20,30,40,50,15,25,35,45,55],buffer=new ArrayBuffer(352+values.length*4),header=new DataView(buffer),bytes=new Uint8Array(buffer);
  header.setInt32(0,348,true);header.setInt16(40,3,true);
  [5,1,2].forEach((n,a)=>{header.setInt16(42+a*2,n,true);header.setFloat32(80+a*4,1,true);});
  header.setInt16(70,16,true);header.setInt16(72,32,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setUint8(123,2);
  bytes.set([110,43,49,0],344);values.forEach((value,i)=>header.setFloat32(352+i*4,value,true));
  const volume=parseNifti(buffer,'local-brush.nii');let state=createProject(volume);const a=state.selectedMaskId;
  state={...state,masks:state.masks.map(m=>({...m,name:'A',data:new Uint8Array([1,0,1,1,1,1,1,1,1,1]),threshold:[20,30],revision:3}))};
  state=addMask(state,values.length,'Overlapping B',new Uint8Array(values.length).fill(1));const b=state.selectedMaskId;
  state={...state,selectedMaskId:a,masks:state.masks.map(m=>m.id===b?{...m,threshold:[40,50]}:m),viewState:{point:[2,0,0],activeAxis:2,tool:'local-threshold',tab:'segmentation'}};
  return{volume,state,a,b};
}
type Editor=ReturnType<typeof useWorkbench>;
type Fixture=ReturnType<typeof fixture>;
async function withEditor(run:(editor:Editor,input:Fixture,exports:Uint8Array[])=>Promise<void>|void){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!;
  const input=fixture();editor.params.thresholdAutoPreview=false;
  try{
    assert.equal(await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'local.deepmark.zip')]),true);
    editor.params.brushShape='square';editor.params.diameter=2;await run(editor,input,exports);
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function customRanges(editor:Editor){
  assert.equal(editor.localThreshold.update(0,'upper',45),true);assert.equal(editor.localThreshold.update(0,'lower',35),true);
  assert.equal(editor.localThreshold.update(2,'lower',5),true);assert.equal(editor.localThreshold.update(2,'upper',15),true);
}
function beginChangedStroke(editor:Editor){
  editor.brushBegin(2,0);editor.brushStroke([2,0,0],2,0);assert.ok(editor.draft.value);
  assert.notDeepEqual(editor.draft.value,editor.activeMask.value!.data);
}

test('local threshold brush uses each chosen range, preserves outside voxels and survives actual project worker export',{timeout:15000},async()=>{
  await withEditor(async(editor,input,exports)=>{
    editor.params.lower=0;editor.params.upper=0;customRanges(editor);
    const before=editor.activeMask.value!.data.slice(),other=editor.state.value.masks.find(m=>m.id===input.b)!.data.slice(),revision=editor.activeMask.value!.revision;
    const expected:Record<LocalThresholdSlot,number[]>={0:[1,0,0,1,1,1,1,1,1,1],1:[1,1,1,0,1,1,1,1,1,1],2:[1,0,0,0,1,1,1,1,1,1]};
    for(const choice of [0,1,2] as const){
      assert.equal(editor.localThreshold.choose(choice),true);beginChangedStroke(editor);
      assert.deepEqual(editor.activeMask.value!.data,before,'draft must not edit live membership before pointer-up');editor.brushEnd();
      assert.deepEqual([...editor.activeMask.value!.data],expected[choice]);assert.deepEqual(editor.activeMask.value!.threshold,[20,30]);assert.equal(editor.activeMask.value!.revision,revision+1);
      assert.equal(editor.localThreshold.slot.value,choice);assert.deepEqual([editor.params.lower,editor.params.upper],[0,0]);
      assert.deepEqual(editor.state.value.masks.find(m=>m.id===input.b)!.data,other);assert.deepEqual(editor.volume.value!.data,input.volume.data);
      editor.undo();assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.activeMask.value!.revision,revision);assert.equal(editor.undoName.value,'');
    }
    editor.undo(true);assert.deepEqual([...editor.activeMask.value!.data],expected[2]);
    assert.equal((await editor.saveProject())?.status,'written');assert.equal(editor.error.value,'');
    const saved=decodeProject(exports.at(-1)!);validateProject(saved.volume,saved.state);
    assert.deepEqual(saved.state.masks.find(m=>m.id===input.a)!.threshold,[20,30]);assert.deepEqual([...saved.state.masks.find(m=>m.id===input.a)!.data],expected[2]);
  });
});

test('several local samples in one brush stroke form one undoable transaction with no mutation between samples',{timeout:15000},async()=>{
  await withEditor(editor=>{
    const before=editor.activeMask.value!.data.slice(),revision=editor.activeMask.value!.revision;
    editor.brushBegin(2,0);editor.brushStroke([1,0,0],2,0);editor.brushStroke([3,0,0],2,0);
    assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.activeMask.value!.revision,revision);editor.brushEnd();
    assert.deepEqual([...editor.activeMask.value!.data],[0,1,1,0,0,1,1,1,1,1]);assert.equal(editor.activeMask.value!.revision,revision+1);assert.equal(editor.undoName.value,'局部阈值');
    editor.undo();assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.undoName.value,'');
    editor.undo(true);assert.deepEqual([...editor.activeMask.value!.data],[0,1,1,0,0,1,1,1,1,1]);assert.deepEqual(editor.activeMask.value!.threshold,[20,30]);
  });
});

test('renaming a mask preserves its custom local range for the next real brush, and that brush alone is undone',{timeout:15000},async()=>{
  await withEditor((editor,input)=>{
    customRanges(editor);editor.localThreshold.choose(0);editor.params.lower=0;editor.params.upper=0;
    editor.updateMask(input.a,{name:'Renamed A'});assert.deepEqual(editor.localThreshold.range.value,{lower:35,upper:45});assert.equal(editor.localThreshold.slot.value,0);
    const before=editor.activeMask.value!.data.slice();beginChangedStroke(editor);editor.brushEnd();
    assert.deepEqual([...editor.activeMask.value!.data],[1,0,0,1,1,1,1,1,1,1]);assert.deepEqual(editor.activeMask.value!.threshold,[20,30]);
    editor.undo();assert.equal(editor.activeMask.value!.name,'Renamed A');assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.undoName.value,'修改Mask属性');
  });
});

test('changing global threshold controls during a local brush cannot change its range or publish a partial result',{timeout:15000},async()=>{
  await withEditor(editor=>{
    customRanges(editor);editor.localThreshold.choose(0);beginChangedStroke(editor);const draft=editor.draft.value;
    editor.params.lower=0;editor.params.upper=0;assert.equal(editor.draft.value,draft);assert.deepEqual(editor.localThreshold.range.value,{lower:35,upper:45});
    editor.brushEnd();assert.deepEqual([...editor.activeMask.value!.data],[1,0,0,1,1,1,1,1,1,1]);assert.deepEqual(editor.activeMask.value!.threshold,[20,30]);assert.deepEqual([editor.params.lower,editor.params.upper],[0,0]);
  });
});

test('editing an unselected custom range cannot cancel a brush that is using another range',{timeout:15000},async()=>{
  await withEditor(editor=>{
    customRanges(editor);editor.localThreshold.choose(0);beginChangedStroke(editor);const draft=editor.draft.value;
    assert.equal(editor.localThreshold.update(2,'upper',16),true);assert.deepEqual(editor.localThreshold.range.value,{lower:35,upper:45});
    assert.equal(editor.draft.value,draft,'an inactive preset does not change the in-flight brush range');
    editor.brushEnd();assert.deepEqual([...editor.activeMask.value!.data],[1,0,0,1,1,1,1,1,1,1]);assert.deepEqual(editor.activeMask.value!.threshold,[20,30]);
  });
});

test('choosing the default or another local range cancels an active custom brush without a half commit',{timeout:15000},async()=>{
  await withEditor(editor=>{
    customRanges(editor);editor.localThreshold.choose(0);const before=editor.activeMask.value!.data.slice(),revision=editor.activeMask.value!.revision;
    beginChangedStroke(editor);editor.localThreshold.choose(1);assert.equal(editor.draft.value,null);editor.brushEnd();
    assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.activeMask.value!.revision,revision);assert.equal(editor.undoName.value,'');
    beginChangedStroke(editor);editor.localThreshold.choose(2);assert.equal(editor.draft.value,null);editor.brushEnd();
    assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.activeMask.value!.revision,revision);assert.equal(editor.undoName.value,'');
  });
});

test('switching masks or explicitly cancelling an active local brush leaves both masks and history untouched',{timeout:15000},async()=>{
  await withEditor((editor,input)=>{
    customRanges(editor);editor.localThreshold.choose(0);
    const before=editor.state.value.masks.map(m=>({id:m.id,data:m.data.slice(),revision:m.revision,threshold:m.threshold}));
    beginChangedStroke(editor);editor.selectMask(input.b);assert.equal(editor.draft.value,null);editor.brushEnd();
    assert.equal(editor.localThreshold.slot.value,1);assert.deepEqual(editor.localThreshold.range.value,{lower:40,upper:50});
    assert.deepEqual(editor.state.value.masks.map(m=>({id:m.id,data:m.data,revision:m.revision,threshold:m.threshold})),before);assert.equal(editor.undoName.value,'');
    editor.selectMask(input.a);beginChangedStroke(editor);editor.cancel();editor.brushEnd();
    assert.equal(editor.draft.value,null);assert.deepEqual(editor.state.value.masks.map(m=>({id:m.id,data:m.data,revision:m.revision,threshold:m.threshold})),before);assert.equal(editor.undoName.value,'');
    validateProject(editor.volume.value!,editor.state.value);
  });
});
