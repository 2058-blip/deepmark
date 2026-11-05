import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectScope,ref,shallowRef,watch} from 'vue';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {parseNifti} from '../src/core.ts';
import {addMask,addPart,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import {measurementPartIds,measurementPointPartId,uniformMeasurementPartId} from '../src/mimics/measurementAttachments.ts';
import {useMeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {MeasurementObject} from '../src/mimics/types.ts';

function fixture(){
  const buffer=new ArrayBuffer(360),h=new DataView(buffer),bytes=new Uint8Array(buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);
  [2,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,1,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);bytes.set([0,1,2,3,4,5,6,7],352);
  const volume=parseNifti(buffer,'attachments.nii');let state=createProject(volume);
  state=addPart(state,{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])});const a=state.parts.at(-1)!;
  state=addPart(state,{positions:new Float32Array([2,0,0,3,0,0,2,1,0]),indices:new Uint32Array([0,1,2])});const b=state.parts.at(-1)!;
  const base={visible:true,color:'#ffffff'};
  state={...state,measurements:[
    {...base,id:'legacy',name:'legacy',kind:'distance',points:[[0,0,0],[1,0,0]],partId:a.id},
    {...base,id:'cross',name:'cross',kind:'distance',points:[[0,0,0],[3,4,0]],pointPartIds:[a.id,b.id]},
    {...base,id:'mixed',name:'mixed',kind:'angle',points:[[0,0,0],[1,0,0],[1,1,0]],pointPartIds:[a.id,null,b.id]},
    {...base,id:'image',name:'image',kind:'distance',points:[[0,0,0],[1,0,0]],pointPartIds:[null,null]},
    {...base,id:'uniform',name:'uniform',kind:'diameter',points:[[0,0,0],[1,0,0],[0,1,0]],partId:a.id,pointPartIds:[a.id,a.id,a.id]},
    {...base,id:'note',name:'note',kind:'annotation',points:[[0,0,0]],partId:a.id,pointPartIds:[a.id],text:'attached'},
    {...base,id:'surface',name:'surface',kind:'surface-distance',points:[[0,0,0],[1,0,0]],partId:a.id,pathMethod:'edge-graph'},
  ]};
  state=addMask(state,8,'From non-selected A',new Uint8Array([1,0,1,0,0,0,0,0]),a);
  return{volume,state,a,b};
}
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function damaged(bytes:Uint8Array,change:(meta:any)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));change(meta);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files);}
function harness(){
  const input=fixture(),scope=effectScope(),state=shallowRef(input.state),volume=shallowRef(input.volume),busy=ref(false),selectedMeasurementId=ref(''),history=new ProjectHistory(1000000),errors:unknown[]=[];
  const commit=(name:string,next:ProjectState)=>{history.push(name,state.value,next);state.value=next;};
  const editor=scope.run(()=>{watch([()=>state.value.measurements,selectedMeasurementId],()=>{if(selectedMeasurementId.value&&!state.value.measurements.some(m=>m.id===selectedMeasurementId.value))selectedMeasurementId.value='';},{flush:'sync'});return useMeasurementProperties({state,volume,busy,selectedMeasurementId,commit,fail:error=>errors.push(error)});})!;
  return{...input,scope,state,volume,busy,selectedMeasurementId,history,errors,editor,commit};
}

test('per-point helpers preserve mixed image/Part ancestry and retain legacy uniform attachments',()=>{
  const {state,a,b}=fixture(),cross=state.measurements.find(m=>m.id==='cross')!,mixed=state.measurements.find(m=>m.id==='mixed')!,legacy=state.measurements[0]!;
  assert.equal(measurementPointPartId(cross,0),a.id);assert.equal(measurementPointPartId(cross,1),b.id);assert.equal(measurementPointPartId(cross,2),null);
  assert.equal(measurementPointPartId({...mixed,partId:a.id},1),null,'an explicit image point never falls back to a uniform summary');
  assert.equal(measurementPointPartId(legacy,1),a.id);assert.equal(measurementPointPartId(state.measurements.find(m=>m.id==='surface')!,1),a.id);
  assert.deepEqual(measurementPartIds(mixed),[a.id,b.id]);assert.deepEqual(measurementPartIds(state.measurements.find(m=>m.id==='image')!),[]);
  assert.deepEqual(measurementPartIds({...mixed,pointPartIds:[b.id,a.id,b.id,null]}),[b.id,a.id]);
  for(const ids of [[],[null],[a.id,null],[a.id,b.id]])assert.equal(uniformMeasurementPartId(ids),undefined);
  assert.equal(uniformMeasurementPartId([a.id,a.id]),a.id);assert.equal(uniformMeasurementPartId([a.id]),a.id);
});

test('ZIP and history preserve distinct point sources, nulls and reverse Mask ancestry without synthesising summaries',()=>{
  const {volume,state,a,b}=fixture(),before=normal(state),restored=decodeProject(encodeProject(volume,state));assert.deepEqual(normal(restored.state),before);
  const cross=restored.state.measurements.find(m=>m.id==='cross')!;assert.equal(cross.partId,undefined);assert.deepEqual(cross.pointPartIds,[a.id,b.id]);assert.equal(Math.hypot(...cross.points[1]!.map((v,k)=>v-cross.points[0]![k]!)),5);
  assert.equal(restored.state.measurements[0]!.pointPartIds,undefined);assert.equal(restored.state.masks.at(-1)!.sourcePartId,a.id);assert.equal((restored.state.masks.at(-1) as any).sourceRevision,undefined);
  cross.pointPartIds![0]='deleted-history';assert.deepEqual(state.measurements.find(m=>m.id==='cross')!.pointPartIds,[a.id,b.id]);
  const history=new ProjectHistory(1000000);history.push('rename',state,{...state,name:'after'});state.measurements.find(m=>m.id==='cross')!.pointPartIds![0]=b.id;state.masks.at(-1)!.sourcePartId=b.id;
  const undone=history.undo()!;assert.deepEqual(normal(undone),before);undone.measurements.find(m=>m.id==='cross')!.pointPartIds![1]='mutated-undo';history.redo();assert.deepEqual(normal(history.undo()),before);
});

test('strict I/O and history reject wrong lengths, invalid point IDs, surface paths and inconsistent uniform summaries',()=>{
  const {volume,state,a,b}=fixture(),good=encodeProject(volume,state),cases:any[]=[[a.id],null,[a.id,''],[a.id,'x'.repeat(257)],[a.id,42],[a.id,false],[a.id,{}]];
  for(const pointPartIds of cases){
    const invalid={...state,measurements:state.measurements.map(m=>m.id==='cross'?{...m,pointPartIds}:m)};
    assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements.find((x:any)=>x.id==='cross').pointPartIds=pointPartIds;})));
    const history=new ProjectHistory(1000000);history.push('valid',state,{...state,name:'after'});history.undo();assert.throws(()=>history.push('bad',state,invalid));assert.equal(history.future.length,1);assert.equal(history.past.length,0);
  }
  for(const pointPartIds of [[a.id,undefined],Array(2)]){const invalid={...state,measurements:state.measurements.map(m=>m.id==='cross'?{...m,pointPartIds:pointPartIds as any}:m)};assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>new ProjectHistory(1000000).push('bad in-memory array',state,invalid));}
  for(const [id,patch] of [['cross',{partId:a.id}],['mixed',{partId:a.id}],['surface',{pointPartIds:[a.id,a.id]}]] as const){
    const invalid={...state,measurements:state.measurements.map(m=>m.id===id?{...m,...patch}:m)};assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damaged(good,m=>Object.assign(m.project.measurements.find((x:any)=>x.id===id),patch))));
  }
  assert.notEqual(a.id,b.id);
});

test('live references of another object type reject while deleted historical Part IDs retain all geometry',()=>{
  const {volume,state,a,b}=fixture(),good=encodeProject(volume,state),maskId=state.masks[0]!.id;
  for(const wrongId of [maskId,'cross']){
    assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements.find((x:any)=>x.id==='cross').pointPartIds[0]=wrongId;})),/其他类型/);
    assert.throws(()=>decodeProject(damaged(good,m=>{m.project.masks.at(-1).sourcePartId=wrongId;})),/其他类型/);
  }
  const without={...state,parts:[],selectedPartId:''};validateProject(volume,without);const restored=decodeProject(encodeProject(volume,without)).state;
  assert.deepEqual(restored.measurements.find(m=>m.id==='cross')!.pointPartIds,[a.id,b.id]);assert.deepEqual(restored.measurements.find(m=>m.id==='mixed')!.pointPartIds,[a.id,null,b.id]);assert.equal(restored.masks.at(-1)!.sourcePartId,a.id);assert.deepEqual(restored.measurements.find(m=>m.id==='cross')!.points,[[0,0,0],[3,4,0]]);
  const history=new ProjectHistory(1000000);history.push('delete all Parts',state,without);assert.equal(history.undo()!.parts.length,2);assert.equal(history.redo()!.masks.at(-1)!.sourcePartId,a.id);
});

test('Mask creation records only the provided live Part ID and refuses removed or replaced source geometry atomically',()=>{
  const {state,a,b}=fixture(),data=new Uint8Array(8),before=normal(state);
  const added=addMask(state,8,'Reverse',data,{...a,name:'old metadata name'});assert.equal(added.masks.at(-1)!.sourcePartId,a.id);assert.equal(added.masks.at(-1)!.revision,0);assert.equal(added.selectedPartId,b.id);
  assert.equal(addMask(state,8,'Legacy four arguments',data).masks.at(-1)!.sourcePartId,undefined);
  assert.throws(()=>addMask(state,8,'Missing',data,{...a,id:'deleted-part'}),/来源Part/);
  assert.throws(()=>addMask(state,8,'Changed mesh descriptor',data,{...a,mesh:{...a.mesh}}),/来源Part/);
  assert.throws(()=>addMask({...state,parts:state.parts.filter(p=>p.id!==a.id)},8,'Deleted',data,a),/来源Part/);
  assert.throws(()=>addMask(state,8,'Null',data,null as any),/来源Part/);assert.deepEqual(normal(state),before);
  const bad={...state,masks:state.masks.map((m,i)=>i===0?{...m,sourcePartId:state.measurements[0]!.id}:m)};assert.throws(()=>encodeProject(fixture().volume,bad),/其他类型/);
  const invalid={...state,masks:state.masks.map((m,i)=>i===0?{...m,sourcePartId:42 as any}:m)};assert.throws(()=>encodeProject(fixture().volume,invalid),/来源Part/);
});

test('properties and duplication clone point attachments, forbid form patches, and preserve newer live per-point metadata',()=>{
  const h=harness();try{
    const original=h.state.value.measurements.find(m=>m.id==='cross')!;assert.equal(h.editor.openEdit('cross'),true);assert.notEqual(h.editor.draft.value!.pointPartIds,original.pointPartIds);assert.throws(()=>{h.editor.draft.value!.pointPartIds![0]=h.b.id;},TypeError);
    assert.equal(h.editor.apply({pointPartIds:[h.b.id,h.b.id]} as any),false);assert.equal(h.history.past.length,0);
    h.commit('external anchor change',{...h.state.value,measurements:h.state.value.measurements.map(m=>m.id==='cross'?{...m,points:[[2,1,1],[0,0,0]],pointPartIds:[h.b.id,null]}:m)});
    assert.equal(h.editor.apply({name:'edited metadata'}),true);const edited=h.state.value.measurements.find(m=>m.id==='cross')!;assert.deepEqual(edited.pointPartIds,[h.b.id,null]);assert.deepEqual(edited.points,[[2,1,1],[0,0,0]]);assert.equal(edited.partId,undefined);
    const mixed=h.state.value.measurements.find(m=>m.id==='mixed')!;assert.equal(h.editor.duplicate('mixed'),true);const copy=h.state.value.measurements.at(-1)!;assert.deepEqual(copy.pointPartIds,[h.a.id,null,h.b.id]);assert.notEqual(copy.pointPartIds,mixed.pointPartIds);assert.equal(copy.partId,undefined);assert.equal(h.selectedMeasurementId.value,copy.id);
    mixed.pointPartIds![0]=h.b.id;assert.equal(copy.pointPartIds![0],h.a.id);validateProject(h.volume.value,h.state.value);assert.deepEqual(decodeProject(encodeProject(h.volume.value,h.state.value)).state.measurements.at(-1)!.pointPartIds,[h.a.id,null,h.b.id]);
  }finally{h.scope.stop();}
});

test('deleting either source cancels a pending cross-Part creation without deleting committed historical measurements',()=>{
  for(const source of ['a','b'] as const){
    const h=harness();try{
      const candidate={...h.state.value.measurements.find(m=>m.id==='cross')!,id:'pending-cross'};assert.equal(h.editor.openCreate(candidate),true);
      const remaining=h.state.value.parts.filter(p=>p.id!==h[source].id);h.commit('delete a source',{...h.state.value,parts:remaining,selectedPartId:remaining[0]!.id});
      assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({name:'not committed'}),false);assert.equal(h.history.past.length,1);assert.equal(h.state.value.measurements.some(m=>m.id==='pending-cross'),false);
      assert.equal(h.editor.openEdit('cross'),true);assert.equal(h.editor.apply({name:'historical cross'}),true);assert.deepEqual(h.state.value.measurements.find(m=>m.id==='cross')!.pointPartIds,[h.a.id,h.b.id]);validateProject(h.volume.value,h.state.value);
    }finally{h.scope.stop();}
  }
});

test('image points do not create phantom Part dependencies during a pending mixed creation',()=>{
  const h=harness();try{
    const candidate:MeasurementObject={...h.state.value.measurements.find(m=>m.id==='cross')!,id:'pending-image',pointPartIds:[h.a.id,null]};assert.equal(h.editor.openCreate(candidate),true);
    h.commit('delete unrelated Part',{...h.state.value,parts:h.state.value.parts.filter(p=>p.id!==h.b.id),selectedPartId:h.a.id});assert.ok(h.editor.draft.value);
    assert.equal(h.editor.apply({name:'mixed source'}),true);assert.deepEqual(h.state.value.measurements.at(-1)!.pointPartIds,[h.a.id,null]);assert.equal(h.state.value.measurements.at(-1)!.partId,undefined);
    assert.equal(h.editor.openCreate({...candidate,id:'missing',pointPartIds:['deleted-part',null]}),false);assert.equal(h.history.past.length,2);
  }finally{h.scope.stop();}
});
