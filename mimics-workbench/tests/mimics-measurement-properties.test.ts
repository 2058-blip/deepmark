import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computed,effectScope,ref,shallowRef,watch} from 'vue';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {parseNifti} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import {addPart,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import {useMeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {MeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {AnnotationStyle,MeasurementObject} from '../src/mimics/types.ts';

function fixture(){
  const buffer=new ArrayBuffer(360),h=new DataView(buffer),bytes=new Uint8Array(buffer);
  h.setInt32(0,348,true);h.setInt16(40,3,true);[2,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,1,true);});
  h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);bytes.set([0,1,2,3,4,5,6,7],352);
  const volume=parseNifti(buffer,'properties.nii');let state=createProject(volume);
  state=addPart(state,{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])});const partId=state.selectedPartId;
  const annotation:MeasurementObject={id:'annotation',name:'Note',kind:'annotation',points:[[0,0,0]],plane:{axis:2,index:0},partId,text:'original',color:'#ffffff',visible:true,annotationStyle:{arrow:'dot',rotation:15,align:'center'}};
  const distance:MeasurementObject={id:'distance',name:'Distance',kind:'distance',points:[[0,0,0],[1,0,0]],visible:true,color:'#ff0000'};
  const surface:MeasurementObject={id:'surface',name:'Path',kind:'surface-distance',points:[[0,0,0],[.5,0,0],[1,0,0]],controlPoints:[[0,0,0],[1,0,0]],partId,pathMethod:'edge-graph',plane:{axis:2,index:0},visible:false,color:'#112233'};
  state={...state,measurements:[annotation,distance,surface]};return{volume,state,partId};
}
function harness(){
  const input=fixture(),scope=effectScope(),state=shallowRef(input.state),volume=shallowRef<Volume|null>(input.volume),selectedMeasurementId=ref('distance'),busy=ref(false),history=new ProjectHistory(1_000_000),errors:unknown[]=[],commits:string[]=[];let dirty=0,throwCommit=false;
  const commit=(name:string,next:ProjectState)=>{if(throwCommit)throw new Error('transaction allocation failed');history.push(name,state.value,next);state.value=next;commits.push(name);dirty++;};
  const editor=scope.run(()=>{
    watch([()=>state.value.measurements,selectedMeasurementId],()=>{if(selectedMeasurementId.value&&!state.value.measurements.some(m=>m.id===selectedMeasurementId.value))selectedMeasurementId.value='';},{flush:'sync'});
    return useMeasurementProperties({state,volume,selectedMeasurementId,busy,commit,fail:error=>errors.push(error)});
  })!;
  return{...input,scope,state,volume,selectedMeasurementId,busy,history,errors,commits,editor,commit,dirty:()=>dirty,setThrowCommit:(value:boolean)=>{throwCommit=value;}};
}
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function damaged(bytes:Uint8Array,change:(meta:any)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));change(meta);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files);}

test('supported annotation styles and old objects without style survive real ZIP encode/decode',()=>{
  const {volume,state}=fixture();
  state.measurements=([['none',-360,'left'],['arrow',0,'center'],['dot',360,'right']] as const).map(([arrow,rotation,align],i)=>({...state.measurements[0]!,id:`annotation-${i}`,annotationStyle:{arrow,rotation,align}}));
  const restored=decodeProject(encodeProject(volume,state));assert.deepEqual(normal(restored.state),normal(state));
  restored.state.measurements[0]!.annotationStyle!.rotation=99;assert.equal(state.measurements[0]!.annotationStyle!.rotation,-360);
  const old={...state,measurements:state.measurements.map(({annotationStyle,...m})=>m)};assert.equal(decodeProject(encodeProject(volume,old)).state.measurements[0]!.annotationStyle,undefined);
});

test('style validation rejects non-annotation, unknown fields, invalid enums and rotation in save, load and history atomically',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state),cases:any[]=[{arrow:'invented',rotation:0,align:'left'},{arrow:'arrow',rotation:0,align:'invented'},{arrow:'dot',rotation:361,align:'right'},{arrow:'dot',rotation:-361,align:'right'},{arrow:'dot',rotation:NaN,align:'right'},{arrow:'dot',rotation:Infinity,align:'right'},{arrow:'dot',rotation:0,align:'left',font:'unsupported'},null];
  for(const style of cases){
    const invalid={...state,measurements:state.measurements.map((m,i)=>i===0?{...m,annotationStyle:style}:m)};
    assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements[0].annotationStyle=style;})));
    const history=new ProjectHistory(100000);history.push('valid',state,{...state,name:'changed'});history.undo();
    assert.throws(()=>history.push('invalid style',state,invalid));assert.equal(history.future.length,1);assert.equal(history.past.length,0);
  }
  const wrongKind={...state,measurements:state.measurements.map(m=>m.kind==='distance'?{...m,annotationStyle:{arrow:'arrow',rotation:0,align:'left'} as AnnotationStyle}:m)};
  assert.throws(()=>encodeProject(volume,wrongKind),/标注样式/);assert.throws(()=>decodeProject(damaged(good,m=>{m.project.measurements[1].annotationStyle={arrow:'arrow',rotation:0,align:'left'};})),/标注样式/);
});

test('style history snapshots remain independent of external edits and undo-redo results',()=>{
  const {state}=fixture(),history=new ProjectHistory(100000),expected=normal(state);
  history.push('rename',state,{...state,name:'after'});state.measurements[0]!.annotationStyle!.rotation=90;
  const undo=history.undo()!;assert.deepEqual(normal(undo),expected);undo.measurements[0]!.annotationStyle!.align='right';
  history.redo();assert.equal(history.undo()!.measurements[0]!.annotationStyle!.align,'center');
});

test('creation is deferred until Apply, geometry is isolated and read-only, and Cancel creates no history',()=>{
  const h=harness();try{
    const create:MeasurementObject={...h.state.value.measurements[0]!,id:'new-note',annotationStyle:undefined,points:[[1,1,0]],plane:{axis:2,index:0}};
    assert.equal(h.editor.openCreate(create),true);assert.equal(h.editor.editingId.value,'');assert.equal(h.commits.length,0);assert.equal(h.dirty(),0);assert.equal(h.selectedMeasurementId.value,'distance');
    create.points[0]![0]=999;assert.throws(()=>{h.editor.draft.value!.points[0]![0]=999;},TypeError);assert.throws(()=>{h.editor.draft.value!.partId='other';},TypeError);
    assert.equal(h.editor.apply({name:'Created note',text:'entered after anchor',color:'#abcdef',visible:false,annotationStyle:{arrow:'arrow',rotation:0,align:'left'}}),true);
    assert.equal(h.commits.length,1);assert.equal(h.dirty(),1);assert.equal(h.history.past.length,1);assert.equal(h.selectedMeasurementId.value,'new-note');assert.equal(h.editor.draft.value,null);
    const saved=decodeProject(encodeProject(h.volume.value!,h.state.value)).state.measurements.at(-1)!;
    assert.deepEqual(saved.points,[[1,1,0]]);assert.equal(saved.partId,h.partId);assert.equal(saved.text,'entered after anchor');assert.deepEqual(saved.annotationStyle,{arrow:'arrow',rotation:0,align:'left'});
    assert.equal(h.editor.openCreate({...create,id:'cancelled-note',points:[[0,0,0]]}),true);h.editor.cancel();assert.equal(h.editor.apply({text:'never saved'}),false);assert.equal(h.commits.length,1);assert.equal(h.dirty(),1);assert.equal(h.state.value.measurements.some(m=>m.id==='cancelled-note'),false);
  }finally{h.scope.stop();}
});

test('editing metadata preserves newer live points, plane and attachment and no-op Apply creates no transaction',()=>{
  const h=harness();try{
    assert.equal(h.editor.openEdit('annotation'),true);
    h.commit('move anchor',{...h.state.value,measurements:h.state.value.measurements.map(m=>m.id==='annotation'?{...m,points:[[5,6,7]],plane:{axis:1,index:1},partId:'historical-deleted-part'}:m)});
    assert.ok(h.editor.draft.value);
    const properties:MeasurementProperties={name:'Updated',text:'new text',color:'#123456',visible:false,annotationStyle:{arrow:'none',rotation:-45,align:'right'}};
    assert.equal(h.editor.apply(properties),true);const updated=h.state.value.measurements[0]!;
    assert.deepEqual(updated.points,[[5,6,7]]);assert.deepEqual(updated.plane,{axis:1,index:1});assert.equal(updated.partId,'historical-deleted-part');assert.equal(h.history.past.length,2);
    assert.equal(h.editor.openEdit('annotation'),true);assert.equal(h.editor.apply(properties),false);assert.equal(h.editor.draft.value,null);assert.equal(h.history.past.length,2);
    h.state.value=h.history.undo()!;assert.deepEqual(h.state.value.measurements[0]!.points,[[5,6,7]]);assert.equal(h.state.value.measurements[0]!.text,'original');
    validateProject(h.volume.value!,h.state.value);
  }finally{h.scope.stop();}
});

test('properties reject geometry/reference patches and invalid values without changing state or dismissing the editable draft',()=>{
  const h=harness();try{
    h.editor.openEdit('annotation');const before=normal(h.state.value);
    const invalid:any[]=[{points:[[9,9,9]]},{plane:{axis:1,index:1}},{partId:'invented'},{id:'changed'},{kind:'distance'},{color:'red'},{visible:1},{name:undefined},{text:42},{annotationStyle:{arrow:'dot',rotation:NaN,align:'left'}},{annotationStyle:{arrow:'dot',rotation:0,align:'left',unknown:true}}];
    for(const properties of invalid){assert.equal(h.editor.apply(properties),false);assert.ok(h.editor.draft.value);assert.deepEqual(normal(h.state.value),before);assert.equal(h.commits.length,0);assert.equal(h.dirty(),0);}
    h.editor.openEdit('distance');assert.equal(h.editor.apply({annotationStyle:{arrow:'dot',rotation:0,align:'left'}}),false);assert.equal(h.commits.length,0);
    assert.ok(h.errors.length>=invalid.length+1);
  }finally{h.scope.stop();}
});

test('busy state, document replacement and deleted measurements cancel stale dialogs without committing',()=>{
  const h=harness();try{
    h.editor.openEdit('annotation');h.busy.value=true;assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({text:'stale'}),false);assert.equal(h.editor.duplicate('annotation'),false);assert.equal(h.editor.toggle('annotation'),false);assert.equal(h.commits.length,0);
    h.busy.value=false;h.editor.openEdit('annotation');h.volume.value={...h.volume.value!,data:h.volume.value!.data.slice()};assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({text:'wrong document'}),false);
    h.editor.openEdit('annotation');h.commit('external delete',{...h.state.value,measurements:h.state.value.measurements.filter(m=>m.id!=='annotation')});assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({text:'deleted'}),false);assert.equal(h.commits.length,1);
    assert.equal(h.editor.openEdit('annotation'),false);assert.equal(h.editor.duplicate('annotation'),false);assert.equal(h.editor.toggle('annotation'),false);assert.equal(h.commits.length,1);
    h.volume.value=null;assert.equal(h.editor.openCreate({...h.state.value.measurements[0]!,id:'no-image'}),false);assert.equal(h.commits.length,1);
  }finally{h.scope.stop();}
});

test('duplicate deeply copies annotation style and path geometry, keeps attachments and selects only after one committed transaction',()=>{
  const h=harness();try{
    const surface=h.state.value.measurements.find(m=>m.id==='surface')!;assert.equal(h.editor.duplicate('surface'),true);const copy=h.state.value.measurements.at(-1)!;
    assert.notEqual(copy.id,surface.id);assert.equal(h.selectedMeasurementId.value,copy.id);assert.equal(h.history.past.length,1);assert.equal(copy.partId,surface.partId);assert.equal(copy.pathMethod,'edge-graph');
    assert.deepEqual(copy.points,surface.points);assert.notEqual(copy.points,surface.points);assert.notEqual(copy.points[0],surface.points[0]);assert.notEqual(copy.controlPoints,surface.controlPoints);assert.notEqual(copy.plane,surface.plane);
    const annotation=h.state.value.measurements[0]!;h.editor.duplicate(annotation.id);const note=h.state.value.measurements.at(-1)!;assert.notEqual(note.annotationStyle,annotation.annotationStyle);assert.deepEqual(note.annotationStyle,annotation.annotationStyle);assert.equal(h.history.past.length,2);
    annotation.annotationStyle!.rotation=100;surface.controlPoints![0]![0]=100;assert.equal(note.annotationStyle!.rotation,15);assert.equal(copy.controlPoints![0]![0],0);
    validateProject(h.volume.value!,h.state.value);
  }finally{h.scope.stop();}
});

test('toggle and optional-property removal save correctly; failed commits retain the draft and never select an unpublished ID',()=>{
  const h=harness();try{
    h.editor.toggle('annotation');assert.equal(h.state.value.measurements[0]!.visible,false);assert.equal(h.selectedMeasurementId.value,'distance');assert.equal(h.history.past.length,1);
    h.editor.openEdit('annotation');assert.equal(h.editor.apply({text:undefined,annotationStyle:undefined}),true);assert.equal(h.state.value.measurements[0]!.text,undefined);assert.equal(h.state.value.measurements[0]!.annotationStyle,undefined);assert.equal(h.history.past.length,2);
    const restored=decodeProject(encodeProject(h.volume.value!,h.state.value));assert.equal(restored.state.measurements[0]!.annotationStyle,undefined);
    h.setThrowCommit(true);const source=h.state.value.measurements[0]!;h.editor.openCreate({...source,id:'unpublished'});const previousSelected=h.selectedMeasurementId.value;
    assert.equal(h.editor.apply({text:'will fail'}),false);assert.ok(h.editor.draft.value);assert.equal(h.selectedMeasurementId.value,previousSelected);assert.equal(h.state.value.measurements.some(m=>m.id==='unpublished'),false);assert.equal(h.history.past.length,2);
    assert.equal(h.editor.duplicate('distance'),false);assert.equal(h.selectedMeasurementId.value,previousSelected);assert.equal(h.history.past.length,2);
  }finally{h.scope.stop();}
});

test('deleting the source Part cancels only a pending creation and preserves existing orphan annotations',()=>{
  const h=harness();try{
    const original=h.state.value.measurements[0]!;assert.equal(h.editor.openCreate({...original,id:'pending-anchor'}),true);
    h.commit('delete source Part',{...h.state.value,parts:[],selectedPartId:''});assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({text:'never attached'}),false);assert.equal(h.history.past.length,1);
    assert.equal(h.state.value.measurements.some(m=>m.id==='pending-anchor'),false);assert.equal(h.state.value.measurements[0]!.partId,h.partId);
    assert.equal(h.editor.openCreate({...original,id:'missing-source'}),false);assert.equal(h.history.past.length,1);
    assert.equal(h.editor.openEdit(original.id),true);assert.equal(h.editor.apply({text:'retained world anchor'}),true);assert.equal(h.state.value.measurements[0]!.partId,h.partId);assert.deepEqual(h.state.value.measurements[0]!.points,original.points);
    validateProject(h.volume.value!,h.state.value);
  }finally{h.scope.stop();}
});
