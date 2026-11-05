import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectScope,ref,shallowRef,watch} from 'vue';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {parseNifti} from '../src/core.ts';
import {addPart,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import {useMeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {MeasurementObject,Vec3} from '../src/mimics/types.ts';

function fixture(unit=2,little=true){
  const buffer=new ArrayBuffer(360),h=new DataView(buffer),bytes=new Uint8Array(buffer),scale=unit===1?.001:unit===3?1000:1;
  h.setInt32(0,348,little);h.setInt16(40,3,little);[2,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,little);h.setFloat32(80+a*4,scale,little);});
  h.setInt16(70,2,little);h.setInt16(72,8,little);h.setFloat32(108,352,little);h.setFloat32(112,1,little);h.setUint8(123,unit);bytes.set([110,43,49,0],344);bytes.set([0,1,2,3,4,5,6,7],352);
  const volume=parseNifti(buffer,'labels.nii');let state=createProject(volume);state=addPart(state,{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])});const part=state.parts[0]!;
  const common={visible:true,color:'#ffffff',labelOffset:[12.25,-4.5,.125] as Vec3};
  state={...state,measurements:[
    {...common,id:'distance',name:'distance',kind:'distance',points:[[0,0,0],[1,0,0]],pointPartIds:[part.id,null]},
    {...common,id:'angle',name:'angle',kind:'angle',points:[[0,0,0],[1,0,0],[1,1,0]]},
    {...common,id:'diameter',name:'diameter',kind:'diameter',points:[[0,0,0],[1,0,0],[0,1,0]]},
    {...common,id:'ellipse',name:'ellipse',kind:'ellipse',points:[[0,0,0],[1,0,0],[0,1,0]],plane:{axis:2,index:0}},
    {...common,id:'area',name:'area',kind:'area',points:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],plane:{axis:2,index:0}},
    {...common,id:'density-rectangle',name:'rectangle',kind:'density-rectangle',points:[[0,0,0],[1,1,0]],plane:{axis:2,index:0}},
    {...common,id:'density-ellipse',name:'ellipse density',kind:'density-ellipse',points:[[0,0,0],[1,1,0]],plane:{axis:2,index:0}},
    {...common,id:'surface-distance',name:'surface',kind:'surface-distance',points:[[0,0,0],[1,0,0]],partId:part.id,pathMethod:'edge-graph'},
    {id:'annotation',name:'note',kind:'annotation',points:[[0,0,0]],visible:true,color:'#ffffff',text:'old annotation',annotationStyle:{arrow:'arrow',rotation:0,align:'left'}},
  ].map(m=>({...m,...('labelOffset' in m?{labelOffset:[...m.labelOffset!] as Vec3}:{})})) as MeasurementObject[]};
  return{volume,state,part};
}
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function damaged(bytes:Uint8Array,change:(meta:any)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));change(meta);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files);}
function harness(){
  const input=fixture(),scope=effectScope(),state=shallowRef(input.state),volume=shallowRef(input.volume),busy=ref(false),selectedMeasurementId=ref(''),history=new ProjectHistory(1000000),errors:unknown[]=[];
  const commit=(name:string,next:ProjectState)=>{history.push(name,state.value,next);state.value=next;};
  const editor=scope.run(()=>{watch([()=>state.value.measurements,selectedMeasurementId],()=>{if(selectedMeasurementId.value&&!state.value.measurements.some(m=>m.id===selectedMeasurementId.value))selectedMeasurementId.value='';},{flush:'sync'});return useMeasurementProperties({state,volume,busy,selectedMeasurementId,commit,fail:error=>errors.push(error)});})!;
  return{...input,scope,state,volume,busy,selectedMeasurementId,history,errors,editor,commit};
}

test('world-mm label offsets survive ZIP for every non-annotation kind and native NIfTI unit/byte order without scaling geometry',()=>{
  for(const unit of [1,2,3])for(const little of [true,false]){
    const {volume,state}=fixture(unit,little),restored=decodeProject(encodeProject(volume,state));
    assert.deepEqual(normal(restored.state),normal(state));assert.deepEqual(restored.volume.header,volume.header);assert.deepEqual(restored.volume.affine,volume.affine);
    for(const measurement of restored.state.measurements.filter(m=>m.kind!=='annotation')){assert.deepEqual(measurement.labelOffset,[12.25,-4.5,.125]);assert.deepEqual(measurement.points,state.measurements.find(m=>m.id===measurement.id)!.points);}
    restored.state.measurements[0]!.labelOffset![0]=99;assert.equal(state.measurements[0]!.labelOffset![0],12.25);assert.equal(restored.state.measurements[1]!.labelOffset![0],12.25);
    const old={...state,measurements:state.measurements.map(({labelOffset,...m})=>m)};assert.equal(decodeProject(encodeProject(volume,old)).state.measurements[0]!.labelOffset,undefined);
  }
});

test('strict I/O and history reject malformed vectors, non-finite values and annotation offsets atomically',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state),cases:any[]=[null,[],[1,2],[1,2,3,4],['1',2,3],[true,2,3],[NaN,2,3],[Infinity,2,3],[1,undefined,3],Array(3),new Float32Array([1,2,3]),{0:1,1:2,2:3,length:3}];
  for(const labelOffset of cases){
    const invalid={...state,measurements:state.measurements.map(m=>m.id==='distance'?{...m,labelOffset}:m)};
    assert.throws(()=>validateProject(volume,invalid),/标签偏移/);assert.throws(()=>encodeProject(volume,invalid),/标签偏移/);assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements[0].labelOffset=labelOffset;})),/标签偏移/);
    const history=new ProjectHistory(1000000);history.push('valid',state,{...state,name:'after'});history.undo();assert.throws(()=>history.push('invalid',state,invalid),/标签偏移/);assert.equal(history.past.length,0);assert.equal(history.future.length,1);
  }
  const invalid={...state,measurements:state.measurements.map(m=>m.kind==='annotation'?{...m,labelOffset:[0,0,0] as Vec3}:m)};assert.throws(()=>encodeProject(volume,invalid),/标签偏移/);assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements.at(-1).labelOffset=[0,0,0];})),/标签偏移/);
  assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements[0].labelPosition=[0,0,0];})),/未支持字段/);
});

test('only ordinary array values are accepted; accessors and extra vector properties never silently disappear',()=>{
  const {volume,state}=fixture();class SpecialArray extends Array<number>{}
  const extra=[1,2,3];(extra as any).unknown=1;const hidden=[1,2,3];Object.defineProperty(hidden,'1',{value:2,enumerable:false});
  let reads=0;const accessor=[1,2,3];Object.defineProperty(accessor,'0',{get:()=>{reads++;return 1;},enumerable:true});
  const nullPrototype=Object.setPrototypeOf([1,2,3],null);
  for(const labelOffset of [new SpecialArray(1,2,3),extra,hidden,accessor,nullPrototype])assert.throws(()=>encodeProject(volume,{...state,measurements:state.measurements.map(m=>m.id==='distance'?{...m,labelOffset:labelOffset as Vec3}:m)}),/标签偏移/);
  assert.equal(reads,0,'vector accessors are rejected before evaluating them');
  const zero={...state,measurements:state.measurements.map(m=>m.id==='distance'?{...m,labelOffset:[0,0,0] as Vec3}:m)};assert.deepEqual(decodeProject(encodeProject(volume,zero)).state.measurements[0]!.labelOffset,[0,0,0]);
});

test('history snapshots isolate label vectors and replay them together with unchanged points and per-point attachments',()=>{
  const {state}=fixture(),history=new ProjectHistory(1000000),before=normal(state),after={...state,measurements:state.measurements.map(m=>m.id==='distance'?{...m,labelOffset:[9,8,7] as Vec3}:m)};
  history.push('move label',state,after);state.measurements[0]!.labelOffset![0]=100;after.measurements[0]!.labelOffset![0]=200;
  const undone=history.undo()!;assert.deepEqual(normal(undone),before);undone.measurements[0]!.labelOffset![1]=300;
  const redone=history.redo()!;assert.deepEqual(redone.measurements[0]!.labelOffset,[9,8,7]);assert.deepEqual(redone.measurements[0]!.points,before.measurements[0].points);assert.deepEqual(redone.measurements[0]!.pointPartIds,before.measurements[0].pointPartIds);
  assert.deepEqual(normal(history.undo()),before);
});

test('Properties cannot patch label geometry and preserve newer live offsets; duplicate freezes and clones independently',()=>{
  const h=harness();try{
    const initial=h.state.value.measurements[0]!;assert.equal(h.editor.openEdit(initial.id),true);assert.notEqual(h.editor.draft.value!.labelOffset,initial.labelOffset);
    assert.throws(()=>{h.editor.draft.value!.labelOffset![0]=0;},TypeError);assert.throws(()=>{h.editor.draft.value!.labelOffset=[0,0,0];},TypeError);
    for(const labelOffset of [[0,0,0],undefined]){assert.equal(h.editor.apply({labelOffset} as any),false);assert.equal(h.history.past.length,0);assert.ok(h.editor.draft.value);}
    h.commit('external label move',{...h.state.value,measurements:h.state.value.measurements.map(m=>m.id===initial.id?{...m,labelOffset:[9,8,7]}:m)});
    assert.equal(h.editor.apply({name:'renamed after move'}),true);const live=h.state.value.measurements[0]!;assert.deepEqual(live.labelOffset,[9,8,7]);assert.deepEqual(live.points,initial.points);assert.deepEqual(live.pointPartIds,initial.pointPartIds);
    assert.equal(h.editor.duplicate(live.id),true);const copy=h.state.value.measurements.at(-1)!;assert.notEqual(copy.labelOffset,live.labelOffset);assert.deepEqual(copy.labelOffset,[9,8,7]);assert.equal(h.selectedMeasurementId.value,copy.id);
    live.labelOffset![0]=-90;assert.equal(copy.labelOffset![0],9);const saved=decodeProject(encodeProject(h.volume.value,h.state.value));assert.deepEqual(saved.state.measurements.at(-1)!.labelOffset,[9,8,7]);
    h.editor.openEdit(live.id);h.commit('another label move',{...h.state.value,measurements:h.state.value.measurements.map(m=>m.id===live.id?{...m,labelOffset:[5,4,3]}:m)});const entries=h.history.past.length;
    assert.equal(h.editor.apply({}),false);assert.equal(h.history.past.length,entries);assert.deepEqual(h.state.value.measurements[0]!.labelOffset,[5,4,3]);
  }finally{h.scope.stop();}
});

test('pending creation captures its offset independently and busy/document cancellation never publishes a label-only object',()=>{
  const h=harness();try{
    const create:MeasurementObject={...h.state.value.measurements[0]!,id:'created',labelOffset:[1,2,3]};assert.equal(h.editor.openCreate(create),true);create.labelOffset![0]=999;
    assert.equal(h.editor.apply({name:'created with offset'}),true);assert.deepEqual(h.state.value.measurements.at(-1)!.labelOffset,[1,2,3]);assert.equal(h.history.past.length,1);
    h.editor.openCreate({...create,id:'cancelled'});h.busy.value=true;assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({name:'not committed'}),false);assert.equal(h.history.past.length,1);
    h.busy.value=false;h.editor.openEdit('created');h.volume.value={...h.volume.value,data:h.volume.value.data.slice()};assert.equal(h.editor.draft.value,null);assert.equal(h.history.past.length,1);
    assert.equal(h.state.value.measurements.some(m=>m.id==='cancelled'),false);validateProject(h.volume.value,h.state.value);
  }finally{h.scope.stop();}
});
