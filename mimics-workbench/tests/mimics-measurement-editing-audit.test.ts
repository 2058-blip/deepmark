import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addPart,createProject,decodeProject,encodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {Vec3} from '../src/mimics/types.ts';

const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
function fixture(){
  const bytes=new Uint8Array(352+8*8*3),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[8,8,3].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,1,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);
  const volume=parseNifti(bytes.buffer,'editing-audit.nii');let state=createProject(volume);state=addPart(state,{positions:new Float32Array([1,1,1,5,1,1,1,5,1]),indices:new Uint32Array([0,1,2])});const part=state.parts[0]!;
  const points:Vec3[]=[[1,1,1],[5,1,1],[5,4,1],[1,4,1]],base={name:'Area',kind:'area' as const,points,plane:{axis:2 as const,index:1},visible:true,color:'#abcdef',labelOffset:[2,1,0] as Vec3};
  state={...state,measurements:[{...base,id:'area',pointPartIds:[null,null,null,null]},{...base,id:'legacy-part-area',partId:part.id},{...base,id:'point-part-area',partId:part.id,pointPartIds:[part.id,part.id,part.id,part.id]}],viewState:{point:[3,3,1],activeAxis:2,tool:'navigate',tab:'measurements'}};
  return{volume,state};
}
type Editor=ReturnType<typeof useWorkbench>;
async function withEditor(run:(editor:Editor,exports:Uint8Array[])=>Promise<void>|void){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();editor.params.thresholdAutoPreview=false;
  try{assert.equal(await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'editing-audit.zip')]),true);await run(editor,exports);}finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
const epoch=(editor:Editor)=>({volume:editor.volume.value!,revision:editor.revision.value});
const five:Vec3[]=[[1,1,1],[3,1,1],[5,1,1],[5,4,1],[1,4,1]];

test('controller label updates reject raw typed arrays and hidden array metadata before cloning or committing',{timeout:15000},async()=>withEditor(editor=>{
  const before=editor.state.value,capture=epoch(editor),extra=[1,2,3];(extra as any).unknown='must not disappear';
  let reads=0;const accessor=[1,2,3];Object.defineProperty(accessor,'0',{get:()=>{reads++;return 1;},enumerable:true});
  for(const offset of [new Float32Array([1,2,3]),extra,accessor]){
    assert.equal(editor.updateMeasurementLabel({id:'area',offset:offset as any,...capture}),false);
    assert.equal(editor.state.value,before);assert.equal(editor.revision.value,capture.revision);assert.equal(editor.undoName.value,'');assert.equal(editor.dirty.value,false);
  }
  assert.equal(reads,0);assert.deepEqual(editor.state.value.measurements[0]!.labelOffset,[2,1,0]);
}));

test('geometry preview rejects points on another slice instead of showing a valid result on the declared plane',{timeout:15000},async()=>withEditor(editor=>{
  const before=editor.state.value,capture=epoch(editor),otherPlane=editor.state.value.measurements[0]!.points.map(p=>[p[0],p[1],2] as Vec3),request={id:'area',points:otherPlane,plane:{axis:2 as const,index:1},...capture};
  assert.equal(editor.previewMeasurementGeometry(request),false);assert.equal(editor.measurementPreview.value,null);assert.equal(editor.measurementDetails('area').preview,undefined);
  assert.equal(editor.updateMeasurementGeometry(request),false);assert.equal(editor.state.value,before);assert.equal(editor.revision.value,capture.revision);assert.equal(editor.undoName.value,'');assert.equal(editor.dirty.value,false);
}));

test('area vertex-count changes reject both legacy uniform and explicit Part provenance without rewriting source arrays',{timeout:15000},async()=>withEditor(editor=>{
  const before=editor.state.value,capture=epoch(editor),source=before.measurements[2]!.pointPartIds!.slice();
  for(const id of ['legacy-part-area','point-part-area']){
    const request={id,points:five,plane:{axis:2 as const,index:1},...capture};assert.equal(editor.previewMeasurementGeometry(request),false);assert.equal(editor.updateMeasurementGeometry(request),false);
    assert.equal(editor.state.value,before);assert.equal(editor.revision.value,capture.revision);assert.equal(editor.undoName.value,'');assert.equal(editor.dirty.value,false);
  }
  assert.deepEqual(editor.state.value.measurements[2]!.pointPartIds,source);assert.equal(editor.state.value.measurements[1]!.pointPartIds,undefined);
}));

test('image-only area insert/remove keeps attachment lengths and label offsets through separate transactions and worker ZIP',{timeout:15000},async()=>withEditor(async(editor,exports)=>{
  const raw=editor.volume.value!.data.slice(),mask=editor.activeMask.value!.data.slice();
  assert.equal(editor.previewMeasurementGeometry({id:'area',points:five,...epoch(editor)}),true);assert.equal(editor.state.value.measurements[0]!.points.length,4);
  assert.equal(editor.updateMeasurementGeometry({id:'area',points:five,...epoch(editor)}),true);assert.equal(editor.state.value.measurements[0]!.pointPartIds!.length,5);assert.ok(editor.state.value.measurements[0]!.pointPartIds!.every(id=>id===null));
  const three:Vec3[]=[[1,1,1],[5,1,1],[1,4,1]];assert.equal(editor.updateMeasurementGeometry({id:'area',points:three,...epoch(editor)}),true);assert.equal(editor.state.value.measurements[0]!.pointPartIds!.length,3);assert.deepEqual(editor.state.value.measurements[0]!.labelOffset,[2,1,0]);
  assert.equal(editor.updateMeasurementLabel({id:'area',offset:[3,-2,0],...epoch(editor)}),true);assert.deepEqual(editor.state.value.measurements[0]!.points,three);assert.equal(editor.state.value.measurements[0]!.pointPartIds!.length,3);
  editor.undo();assert.deepEqual(editor.state.value.measurements[0]!.labelOffset,[2,1,0]);assert.equal(editor.state.value.measurements[0]!.points.length,3);
  editor.undo();assert.equal(editor.state.value.measurements[0]!.points.length,5);assert.equal(editor.state.value.measurements[0]!.pointPartIds!.length,5);editor.undo(true);assert.equal(editor.state.value.measurements[0]!.points.length,3);
  assert.equal((await editor.saveProject())?.status,'written');const restored=decodeProject(exports.at(-1)!);validateProject(restored.volume,restored.state);assert.deepEqual(restored.state.measurements[0]!.points,three);assert.deepEqual(restored.state.measurements[0]!.pointPartIds,[null,null,null]);assert.deepEqual(restored.state.measurements[0]!.labelOffset,[2,1,0]);
  assert.deepEqual(editor.volume.value!.data,raw);assert.deepEqual(editor.activeMask.value!.data,mask);
}));
