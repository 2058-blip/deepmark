import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';

// Actual controller/worker and real debounce timers. No browser or original
// Mimics oracle: the six foreground voxels are explicit fixture members.
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
function imageFile(){
  const bytes=new Uint8Array(368),header=new DataView(bytes.buffer);header.setInt32(0,348,true);header.setInt16(40,3,true);
  [4,2,2].forEach((value,a)=>{header.setInt16(42+2*a,value,true);header.setFloat32(80+4*a,1,true);});header.setInt16(70,2,true);header.setInt16(72,8,true);header.setFloat32(108,352,true);header.setUint8(123,2);bytes.set([110,43,49,0],344);
  bytes.set([0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150],352);return new File([bytes.buffer],'auto-preview.nii');
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitUntil(condition:()=>boolean,message:string){
  const deadline=Date.now()+1000;while(!condition()){assert.ok(Date.now()<deadline,message);await pause(10);}
}

test('automatic threshold preview applies once and stays committed without a replacement-state watcher reviving its preview',async()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),editor=scope.run(()=>useWorkbench({repository:null}))!;
  try{
    await editor.openFiles([imageFile()]);editor.params.lower=40;editor.params.upper=90;editor.params.thresholdAutoPreview=true;const before=editor.state.value,revision=editor.revision.value;
    editor.tool.value='threshold';await nextTick();await waitUntil(()=>!!editor.preview.value&&!editor.busy.value,'automatic threshold preview did not complete within one second');
    const expected=Uint8Array.from({length:16},(_,i)=>Number(i>=4&&i<=9));assert.equal(editor.error.value,'');assert.deepEqual(editor.preview.value,expected);assert.ok(editor.state.value===before);assert.equal(editor.activeMask.value!.data.some(Boolean),false);
    editor.applyPreview();await nextTick();const applied=editor.state.value,status=editor.status.value;assert.equal(editor.preview.value,null);assert.deepEqual(editor.activeMask.value!.data,expected);assert.equal(editor.revision.value,revision+1);assert.equal(editor.busy.value,false);
    // Observe beyond the debounce plus worker time. Polling is bounded and
    // fails on the first resurrected preview, busy state or unsolicited status.
    const deadline=Date.now()+450;do{assert.equal(editor.preview.value,null,'Apply must not schedule another preview merely because project metadata has a new object identity');assert.equal(editor.busy.value,false);assert.equal(editor.status.value,status);assert.ok(editor.state.value===applied);assert.equal(editor.revision.value,revision+1);await pause(10);}while(Date.now()<deadline);
    assert.equal(editor.error.value,'');editor.undo();assert.equal(editor.activeMask.value!.data.some(Boolean),false);assert.equal(editor.undoName.value,'');editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,expected);
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
});
