import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import ts from 'typescript';
import {effectScope,nextTick,proxyRefs,reactive,ref,shallowRef} from 'vue';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {parseNifti} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import {addPart,cloneResliceObject,createProject,decodeProject,encodeProject,ProjectHistory,validateProject} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import {createMprPlane,mprPlaneCenter} from '../src/mimics/mpr.ts';
import {resliceProperties,useResliceObjects} from '../src/mimics/useResliceObjects.ts';
import {useMeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {ReslicePropertiesPatch} from '../src/mimics/useResliceObjects.ts';
import type {MprPlane,ReslicePlaneObject,Vec3} from '../src/mimics/types.ts';

const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
const close=(a:number,b:number,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const pointClose=(a:readonly number[],b:readonly number[])=>a.forEach((n,i)=>close(n,b[i]!));
const plane=():MprPlane=>({origin:[10,20,30],u:[.6,.8,0],v:[-1.6,1.2,0],size:[8,6]});
function fixture(unit=2,little=true){
  const bytes=new Uint8Array(480),h=new DataView(bytes.buffer),scale=unit===1?.001:unit===3?1000:1;h.setInt32(0,348,little);h.setInt16(40,3,little);[4,4,4].forEach((n,a)=>{h.setInt16(42+a*2,n,little);h.setFloat32(80+a*4,(a+2)*scale,little);});h.setInt16(70,4,little);h.setInt16(72,16,little);h.setFloat32(108,352,little);h.setFloat32(112,1,little);h.setInt16(254,1,little);h.setUint8(123,unit);[[2,.25,0,10],[0,3,.5,-20],[0,0,-4,30]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n*scale,little)));bytes.set([110,43,49,0],344);for(let i=0;i<64;i++)h.setInt16(352+i*2,i,little);
  const volume=parseNifti(bytes.buffer,'reslice.nii');let state=createProject(volume);state=addPart(state,{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])});
  state.measurements=[{id:'historical-mpr-distance',name:'Historical MPR',kind:'distance',points:[[10,20,30],[10.6,20.8,30]],mprPlane:plane(),visible:true,color:'#abcdef'}];
  state.resliceObjects=[{id:'rp-a',name:'RP A',kind:'plane',plane:plane()},{id:'rp-b',name:'RP B',kind:'plane',plane:{...plane(),origin:[-5,6,7]}}];state.selectedResliceId='rp-a';state.viewState={point:[1,1,1],mpr:{enabled:false,plane:{...plane(),origin:[10,20,34.125]},step:.375,interpolation:'linear',crosshair:[1.125,2.25,3.5]}};return{volume,state};
}
function damage(bytes:Uint8Array,edit:(meta:any)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));edit(meta);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files,{level:0});}
function harness(){
  const input=fixture(),scope=effectScope(),state=shallowRef(input.state),volume=shallowRef<Volume|null>(input.volume),busy=ref(false),history=new ProjectHistory(1_000_000),errors:unknown[]=[],activations:(ReslicePlaneObject|null)[]=[];let dirty=0,throwCommit=false;
  const commit=(name:string,next:ProjectState)=>{if(throwCommit)throw new Error('allocation failed');history.push(name,state.value,next);state.value=next;dirty++;};
  const manager=scope.run(()=>useResliceObjects({state,volume,busy,commit,fail:error=>errors.push(error),onActivate:object=>activations.push(object)}))!;
  return{...input,scope,state,volume,busy,history,errors,activations,manager,dirty:()=>dirty,throwCommit:(value:boolean)=>{throwCommit=value;}};
}

test('named RP objects and active selection roundtrip separately from the scrolled/disabled MPR view for native units and byte orders',()=>{
  for(const unit of [1,2,3])for(const little of [true,false]){
    const {volume,state}=fixture(unit,little),expected=normal(state),restored=decodeProject(encodeProject(volume,state));assert.deepEqual(normal(restored.state),expected);assert.deepEqual(restored.volume.header,volume.header);assert.deepEqual(restored.volume.affine,volume.affine);assert.deepEqual(restored.volume.data,volume.data);assert.equal(restored.state.selectedResliceId,'rp-a');assert.equal(restored.state.viewState!.mpr!.enabled,false);assert.notDeepEqual(restored.state.resliceObjects![0]!.plane,restored.state.viewState!.mpr!.plane);
    for(const field of ['origin','u','v','size'] as const){restored.state.resliceObjects![0]!.plane[field][0]=999;assert.notEqual(state.resliceObjects![0]!.plane[field][0],999);}assert.deepEqual(normal(state),expected);
  }
  const {volume,state}=fixture();delete state.resliceObjects;delete state.selectedResliceId;const legacy=decodeProject(encodeProject(volume,state));assert.equal(Object.hasOwn(legacy.state,'resliceObjects'),false);assert.equal(Object.hasOwn(legacy.state,'selectedResliceId'),false);
  state.resliceObjects=[];state.selectedResliceId='';const empty=decodeProject(encodeProject(volume,state));assert.deepEqual(empty.state.resliceObjects,[]);assert.equal(empty.state.selectedResliceId,'');
});

test('RP schema rejects invalid selection, unsupported curve/fields/planes and ID collisions across every object group atomically',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state),cases:((s:any)=>void)[]=[
    s=>{s.resliceObjects={};},s=>{s.selectedResliceId='missing';},s=>{s.selectedResliceId=s.selectedMaskId;},s=>{s.selectedResliceId=null;},s=>{s.resliceObjects[0].kind='curve';},s=>{s.resliceObjects[0].visible=true;},s=>{s.resliceObjects[0].name=' ';},s=>{s.resliceObjects[0].plane.u=[0,0,0];},s=>{s.resliceObjects[0].id=s.resliceObjects[1].id;},
  ];
  for(const edit of cases){const invalid=structuredClone(state);edit(invalid);assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damage(good,m=>edit(m.project))));const history=new ProjectHistory();history.push('valid',state,{...state,name:'after'});history.undo();const bytes=history.bytesUsed;assert.throws(()=>history.push('bad',state,invalid));assert.equal(history.past.length,0);assert.equal(history.future.length,1);assert.equal(history.bytesUsed,bytes);}
  for(const target of [state.masks[0]!.id,state.parts[0]!.id,state.measurements[0]!.id,'centerline','polyline']){
    const invalid=structuredClone(state);if(target==='centerline')invalid.centerlines=[{id:target,name:'C',color:'#abcdef',visible:true,graph:{}} as any];if(target==='polyline')invalid.polylines=[{id:target,name:'P',color:'#abcdef',visible:true,set:{}} as any];invalid.resliceObjects![0]!.id=target;invalid.selectedResliceId=target;assert.throws(()=>validateProject(volume,invalid),/重复对象ID/);assert.throws(()=>new ProjectHistory().push('bad',state,invalid),/重复对象ID/);
  }
  const wrongPart=structuredClone(state);wrongPart.measurements[0]!.partId='rp-a';assert.throws(()=>encodeProject(volume,wrongPart),/其他类型对象/);
});

test('RP clone and history deeply isolate every frame array while preserving source buffers and historical measurement frames',()=>{
  const {state}=fixture(),expected=normal(state),history=new ProjectHistory();history.push('rename',state,{...state,resliceObjects:state.resliceObjects!.map(o=>({...o,name:o.name+' changed'}))});const clone=cloneResliceObject(state.resliceObjects![0]!);
  for(const field of ['origin','u','v','size'] as const){assert.notEqual(clone.plane[field],state.resliceObjects![0]!.plane[field]);state.resliceObjects![0]!.plane[field][0]=999;}
  const undo=history.undo()!;assert.deepEqual(normal(undo),expected);assert.equal(undo.masks[0]!.data,state.masks[0]!.data);assert.equal(undo.parts[0]!.mesh.positions,state.parts[0]!.mesh.positions);assert.notEqual(undo.resliceObjects![0]!.plane,undo.measurements[0]!.mprPlane);
  for(const field of ['origin','u','v','size'] as const)undo.resliceObjects![0]!.plane[field][0]=888;history.redo();assert.deepEqual(normal(history.undo()),expected);
});

test('every live Part/Mask ancestry reference rejects an existing RP ID across validation, ZIP and history while true historical orphans remain valid',()=>{
  const {volume,state}=fixture();state.centerlines=[{id:'reference-centerline',name:'Root',color:'#abcdef',visible:true,graph:{nodes:[{id:'root',position:[0,0,0],kind:'root'}],branches:[],branchSets:[],rootNodeId:'root',coordinateSystem:'world-mm',algorithm:'independent-clearance-shortest-path',cyclePolicy:'rooted-shortest-path-tree',warnings:[]}}];state.polylines=[{id:'reference-polyline',name:'Empty contours',color:'#abcdef',visible:true,set:{axis:2,dims:[4,4,4],layers:[],provenance:'independent-half-voxel-cell-boundary'}}];const good=encodeProject(volume,state);
  const cases:((s:ProjectState,id:string)=>void)[]=[(s,id)=>{s.measurements[0]!.partId=id;},(s,id)=>{s.measurements[0]!.pointPartIds=[id,null];},(s,id)=>{s.masks[0]!.sourcePartId=id;},(s,id)=>{s.centerlines![0]!.sourcePartId=id;},(s,id)=>{s.parts[0]!.sourceMaskId=id;},(s,id)=>{s.centerlines![0]!.sourceMaskId=id;},(s,id)=>{s.polylines![0]!.sourceMaskId=id;}];
  for(const change of cases){
    const invalid=structuredClone(state);change(invalid,'rp-a');assert.throws(()=>validateProject(volume,invalid),/其他类型对象/);assert.throws(()=>encodeProject(volume,invalid),/其他类型对象/);assert.throws(()=>decodeProject(damage(good,m=>change(m.project,'rp-a'))),/其他类型对象/);
    const history=new ProjectHistory();history.push('valid',state,{...state,name:'after'});history.undo();const bytes=history.bytesUsed;assert.throws(()=>history.push('wrong RP ancestry',state,invalid),/其他类型对象/);assert.equal(history.past.length,0);assert.equal(history.future.length,1);assert.equal(history.bytesUsed,bytes);
    const orphan=structuredClone(state);change(orphan,'truly-deleted-source');validateProject(volume,orphan);assert.deepEqual(normal(decodeProject(encodeProject(volume,orphan)).state),normal(orphan));const validHistory=new ProjectHistory();assert.doesNotThrow(()=>validHistory.push('historical source',state,orphan));
  }
});

test('measurement Properties identifies RP ID collisions and attachments as wrong types before editing or duplication',()=>{
  const h=harness(),selection=ref(h.state.value.measurements[0]!.id);let commits=0;
  const editor=h.scope.run(()=>useMeasurementProperties({state:h.state,volume:h.volume,busy:h.busy,selectedMeasurementId:selection,commit:(name,next)=>{h.history.push(name,h.state.value,next);h.state.value=next;commits++;},fail:error=>h.errors.push(error)}))!;
  try{
    const before=h.state.value,source=before.measurements[0]!;assert.equal(editor.openCreate({...source,id:'rp-a'}),false);assert.match(String(h.errors.at(-1)),/重复|已不存在/);assert.equal(editor.draft.value,null);
    for(const attachment of [{partId:'rp-a'},{pointPartIds:['rp-a',null]}]){
      const bad={...source,...attachment};h.state.value={...before,measurements:[bad]};assert.equal(editor.openEdit(source.id),false);assert.match(String(h.errors.at(-1)),/其他类型对象/);assert.equal(editor.duplicate(source.id),false);assert.equal(editor.toggle(source.id),false);assert.equal(editor.openCreate({...bad,id:'new-bad-attachment'}),false);assert.match(String(h.errors.at(-1)),/其他类型对象/);assert.equal(editor.draft.value,null);assert.equal(commits,0);
    }
    h.state.value={...before,measurements:[{...source,partId:'truly-deleted-part'}]};assert.equal(editor.openEdit(source.id),true);assert.equal(editor.apply({name:'Historical source remains editable'}),true);assert.equal(editor.duplicate(source.id),true);assert.equal(commits,2);assert.equal(h.state.value.measurements.at(-1)!.partId,'truly-deleted-part');
    assert.equal(editor.openEdit(source.id),true);const current=h.state.value;h.state.value={...current,resliceObjects:[...current.resliceObjects!,{id:'truly-deleted-part',name:'RP now owns this ID',kind:'plane',plane:plane()}]};assert.equal(editor.apply({name:'Cannot treat existing RP as orphan Part'}),false);assert.match(String(h.errors.at(-1)),/其他类型对象/);assert.ok(editor.draft.value);assert.equal(commits,2);
  }finally{h.scope.stop();}
});

test('manager new, select, duplicate, rename and delete use one atomic transaction and never rewrite source or measurement geometry',()=>{
  const h=harness();try{
    const source=h.state.value.masks,parts=h.state.value.parts,measurement=normal(h.state.value.measurements),input=plane();assert.equal(h.manager.fromPlane(input,'New RP'),true);assert.equal(h.history.past.length,1);assert.equal(h.dirty(),1);assert.equal(h.activations.length,1);const added=h.manager.selected.value!;assert.equal(added.name,'New RP');assert.notEqual(added.plane,input);assert.notEqual(h.activations[0]!.plane,added.plane);input.origin[0]=999;assert.notEqual(added.plane.origin[0],999);
    assert.equal(h.manager.select('rp-a'),true);assert.equal(h.history.past.length,1);assert.equal(h.dirty(),1);assert.equal(h.activations.length,2);assert.equal(h.manager.select('rp-a'),true);assert.equal(h.activations.length,3);assert.equal(h.manager.rename('rp-a','RP A'),false);assert.equal(h.history.past.length,1);
    assert.equal(h.manager.duplicate(),true);assert.equal(h.history.past.length,2);assert.equal(h.activations.length,4);const copied=h.manager.selected.value!;assert.notEqual(copied.id,'rp-a');for(const field of ['origin','u','v','size'] as const)assert.notEqual(copied.plane[field],h.state.value.resliceObjects![0]!.plane[field]);
    assert.equal(h.manager.rename(copied.id,'Renamed copy'),true);assert.equal(h.history.past.length,3);assert.equal(h.activations.length,4);assert.equal(h.manager.remove(),true);assert.equal(h.history.past.length,4);assert.equal(h.state.value.selectedResliceId,'');assert.equal(h.activations.at(-1),null);assert.equal(h.manager.selected.value,undefined);assert.equal(h.state.value.masks,source);assert.equal(h.state.value.parts,parts);assert.deepEqual(normal(h.state.value.measurements),measurement);
    assert.equal(h.manager.newObject(),true);assert.deepEqual(h.manager.selected.value!.plane.size,[256,256]);assert.equal(h.history.past.length,5);validateProject(h.volume.value!,h.state.value);
  }finally{h.scope.stop();}
});

test('activation follows selected geometry and Undo/Redo/external state exactly once without identity-clone loops',()=>{
  const h=harness();try{
    assert.equal(h.activations.length,0);const moved={...plane(),origin:[100,200,300] as Vec3};assert.equal(h.manager.updatePlane('rp-a',moved),true);assert.equal(h.activations.length,1);assert.deepEqual(h.activations[0]!.plane,moved);assert.equal(h.manager.updatePlane('rp-a',moved),false);assert.equal(h.activations.length,1);
    h.state.value={...h.state.value,resliceObjects:h.state.value.resliceObjects!.map(cloneResliceObject)};assert.equal(h.activations.length,1);h.state.value=h.history.undo()!;assert.equal(h.activations.length,2);assert.deepEqual(h.activations.at(-1)!.plane,plane());h.state.value=h.history.redo()!;assert.equal(h.activations.length,3);assert.deepEqual(h.activations.at(-1)!.plane,moved);
    h.state.value={...h.state.value,selectedResliceId:'rp-b'};assert.equal(h.activations.length,4);assert.equal(h.activations.at(-1)!.id,'rp-b');h.state.value={...h.state.value,resliceObjects:h.state.value.resliceObjects!.map(o=>o.id==='rp-b'?{...o,plane:{...o.plane,origin:[1,2,3]}}:o)};assert.equal(h.activations.length,5);h.activations.at(-1)!.plane.origin[0]=999;assert.equal(h.manager.selected.value!.plane.origin[0],1);
    h.manager.remove('rp-a');assert.equal(h.activations.length,5);h.manager.remove('rp-b');assert.equal(h.activations.length,6);assert.equal(h.activations.at(-1),null);assert.deepEqual(h.state.value.resliceObjects,[]);assert.equal(h.state.value.selectedResliceId,'');
  }finally{h.scope.stop();}
});

test('deferred Properties edits center, world orientation and physical FOV in one transaction while sample count stays readonly',()=>{
  const h=harness();try{
    const before=normal(h.state.value),source=h.state.value.masks,originalProps=resliceProperties(h.manager.selected.value!);close(originalProps.widthMm,8);close(originalProps.heightMm,12);assert.equal(h.manager.openProperties(),true);assert.equal(h.history.past.length,0);const draft=h.manager.propertiesDraft.value!;assert.equal(Object.isFrozen(draft.size),true);assert.throws(()=>{(draft.size as number[])[0]=999;},TypeError);
    draft.name='Draft only';draft.center[0]=999;h.manager.cancelProperties();assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,0);assert.equal(h.manager.applyProperties({name:'cancelled'}),false);
    h.manager.openProperties();const activated=h.activations.length;assert.equal(h.manager.applyProperties({name:'Physical RP',center:[1.25,2.5,3.75],angles:[0,0,90],widthMm:16,heightMm:12}),true);assert.equal(h.history.past.length,1);assert.equal(h.activations.length,activated+1);const changed=h.manager.selected.value!;assert.equal(changed.name,'Physical RP');assert.deepEqual(changed.plane.size,[8,6]);pointClose(changed.plane.u,[0,2,0]);pointClose(changed.plane.v,[-2,0,0]);pointClose(changed.plane.origin,[6.25,-4.5,3.75]);pointClose(mprPlaneCenter(changed.plane),[1.25,2.5,3.75]);assert.equal(h.state.value.masks,source);assert.deepEqual(normal(h.state.value.measurements),before.measurements);
    h.state.value=h.history.undo()!;assert.deepEqual(normal(h.state.value),before);h.state.value=h.history.redo()!;assert.deepEqual(h.manager.selected.value,changed);h.manager.openProperties();const activations=h.activations.length;assert.equal(h.manager.applyProperties(),false);assert.equal(h.history.past.length,1);assert.equal(h.activations.length,activations);assert.equal(h.manager.propertiesDraft.value,null);
  }finally{h.scope.stop();}
});

test('Properties merges unchanged fields from the latest live RP and metadata-only Apply preserves exact current frame',()=>{
  const h=harness();try{
    h.manager.openProperties();const draft=h.manager.propertiesDraft.value!,live={...plane(),origin:[50.125,60.25,70.5] as Vec3,u:[1.2,1.6,0] as Vec3,size:[10,9] as [number,number]};h.state.value={...h.state.value,resliceObjects:h.state.value.resliceObjects!.map(o=>o.id==='rp-a'?{...o,plane:live}:o)};
    const activates=h.activations.length;assert.equal(h.manager.applyProperties({name:'Live metadata',center:[...draft.center],angles:[...draft.angles],widthMm:draft.widthMm,heightMm:draft.heightMm}),true);assert.deepEqual(h.manager.selected.value!.plane,live);assert.notEqual(h.manager.selected.value!.plane,live);assert.equal(h.activations.length,activates+1);assert.equal(h.history.past.length,1);
    h.manager.openProperties();assert.equal(h.manager.applyProperties({center:[0,0,0]}),true);assert.deepEqual(h.manager.selected.value!.plane.u,live.u);assert.deepEqual(h.manager.selected.value!.plane.v,live.v);assert.deepEqual(h.manager.selected.value!.plane.size,live.size);pointClose(mprPlaneCenter(h.manager.selected.value!.plane),[0,0,0]);assert.equal(h.history.past.length,2);
  }finally{h.scope.stop();}
});

test('large world origins do not swallow a small real millimetre center edit or plane update',()=>{
  const h=harness();try{
    const large={...plane(),origin:[1e9,-1e9,1e9] as Vec3};h.manager.updatePlane('rp-a',large);h.manager.openProperties();const before=mprPlaneCenter(h.manager.selected.value!.plane),entries=h.history.past.length;assert.equal(h.manager.applyProperties({center:[before[0]+.05,before[1],before[2]]}),true);assert.equal(h.history.past.length,entries+1);close(mprPlaneCenter(h.manager.selected.value!.plane)[0]-before[0],.05,2e-7);
    const previous=cloneResliceObject(h.manager.selected.value!);assert.equal(h.manager.updatePlane(previous.id,{...previous.plane,origin:[previous.plane.origin[0]+.05,previous.plane.origin[1],previous.plane.origin[2]]}),true);assert.equal(h.history.past.length,entries+2);h.state.value=h.history.undo()!;assert.deepEqual(h.manager.selected.value,previous);
  }finally{h.scope.stop();}
});

test('invalid Properties payloads and failed commits retain the draft and never publish partial RP changes',()=>{
  const h=harness();try{
    const before=normal(h.state.value),patches:unknown[]=[{name:''},{center:[0,0]},{angles:[0,Infinity,0]},{center:new Float64Array(3)},{widthMm:0},{heightMm:-1},{widthMm:Infinity},{widthMm:1e-20},{size:[2,2]},{plane:plane()},{kind:'curve'}];h.manager.openProperties();
    for(const patch of patches){assert.equal(h.manager.applyProperties(patch as ReslicePropertiesPatch),false);assert.ok(h.manager.propertiesDraft.value);assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,0);}
    let reads=0;const accessor={};Object.defineProperty(accessor,'center',{enumerable:true,get(){reads++;return[0,0,0];}});assert.equal(h.manager.applyProperties(accessor),false);assert.equal(reads,0);
    h.throwCommit(true);assert.equal(h.manager.applyProperties({name:'uncommitted'}),false);assert.ok(h.manager.propertiesDraft.value);assert.equal(h.manager.fromPlane(plane()),false);assert.equal(h.manager.duplicate(),false);assert.equal(h.manager.remove(),false);assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,0);assert.equal(h.dirty(),0);
  }finally{h.scope.stop();}
});

test('busy state, volume identity, selection and object deletion cancel stale Properties; invalid new planes cannot dirty history',()=>{
  const h=harness();try{
    h.manager.openProperties();h.busy.value=true;assert.equal(h.manager.propertiesDraft.value,null);assert.equal(h.manager.applyProperties({name:'stale'}),false);assert.equal(h.manager.fromPlane(plane()),false);h.busy.value=false;
    h.manager.openProperties();h.volume.value={...h.volume.value!};assert.equal(h.manager.propertiesDraft.value,null);h.manager.openProperties();h.manager.select('rp-b');assert.equal(h.manager.propertiesDraft.value,null);h.manager.openProperties();h.manager.remove('rp-b');assert.equal(h.manager.propertiesDraft.value,null);assert.equal(h.state.value.selectedResliceId,'');assert.equal(h.history.past.length,1);
    const before=normal(h.state.value),count=h.history.past.length;assert.equal(h.manager.fromPlane({...plane(),v:[0,0,0]}),false);assert.equal(h.manager.select('missing'),false);assert.equal(h.manager.rename('rp-a',' '),false);assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,count);
    h.manager.select('rp-a');h.manager.openProperties();h.manager.cancelProperties();h.state.value={...h.state.value,name:'same-volume document replacement'};assert.equal(h.manager.applyProperties({name:'stale document'}),false);
  }finally{h.scope.stop();}
});

test('Euler property display and editing preserve arbitrary and gimbal frames without changing unchanged rounded plane geometry',()=>{
  const h=harness();try{
    for(const angles of [[20,30,40],[15,90,-45],[-25,-90,60]] as Vec3[]){
      const p=createMprPlane({center:[2,3,4],angles,size:[8,6],pixelSpacing:[.5,1.25]});h.manager.updatePlane('rp-a',p);h.manager.openProperties();const displayed=h.manager.propertiesDraft.value!,frame=createMprPlane({center:displayed.center,angles:displayed.angles,size:[8,6],pixelSpacing:[displayed.widthMm/8,displayed.heightMm/6]});pointClose(frame.u,p.u);pointClose(frame.v,p.v);assert.equal(h.manager.applyProperties(),false);assert.deepEqual(h.manager.selected.value!.plane,p);
    }
    const rounded={...plane(),v:[-1.6000001,1.2,0] as Vec3};h.manager.updatePlane('rp-a',rounded);h.manager.openProperties();assert.equal(h.manager.applyProperties({name:'Keep exact rounded frame'}),true);assert.deepEqual(h.manager.selected.value!.plane,rounded);
  }finally{h.scope.stop();}
});

// Compile production setup/render with the existing Vue compiler, without a
// browser. This checks real form events and VNodes, not pixel appearance.
async function dialogComponent(){
  const url=new URL('../src/mimics/ReslicePropertiesDialog.vue',import.meta.url),source=await readFile(url,'utf8'),descriptor=parse(source,{filename:url.pathname}).descriptor,script=compileScript(descriptor,{id:'reslice-properties-test'}),template=compileTemplate({source:descriptor.template!.content,filename:url.pathname,id:'reslice-properties-test',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);
  const rewrite=(code:string)=>code.replace(/from (['"])([^'"]+)\1/g,(_all,quote,specifier)=>`from ${quote}${specifier.startsWith('.')?new URL(specifier,url).href:import.meta.resolve(specifier)}${quote}`),module=(code:string)=>'data:text/javascript;base64,'+Buffer.from(rewrite(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)).toString('base64');
  const component=(await import(module(script.content))).default;component.render=(await import(module(template.code))).render;return component;
}
function withoutMount<T>(run:()=>T):T{const previous=console.warn;console.warn=(message,...args)=>{if(!/^\[Vue warn\]: (onMounted is called|withDirectives can only be used inside render functions\.)/.test(String(message)))previous(message,...args);};try{return run();}finally{console.warn=previous;}}
test('actual RP Properties form emits world-mm values without sample-size patches, validates input and cancels without committing',async()=>{
  const h=harness(),component=await dialogComponent(),events:{name:string;args:any[]}[]=[];h.manager.openProperties();const original=normal(h.state.value),props=reactive({draft:h.manager.propertiesDraft.value!,busy:false});
  const view=withoutMount(()=>h.scope.run(()=>component.setup(props,{expose:()=>{},emit:(name:string,...args:any[])=>{events.push({name,args});if(name==='apply')h.manager.applyProperties(args[0]);else if(name==='cancel')h.manager.cancelProperties();}})))!;
  try{
    const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[],tree=withoutMount(()=>component.render({},[],props,proxyRefs(view),{},{})),nodes=walk(tree);assert.equal(nodes.some(node=>node.props?.role==='dialog'&&node.props['aria-modal']==='true'),true);assert.equal(nodes.filter(node=>node.type==='input'&&node.props.type==='number').length,8);assert.equal(nodes.filter(node=>node.type==='input'&&node.props['aria-label']?.startsWith('中心')).length,3);
    view.form.center[0]=123.125;view.form.widthMm=16;view.form.name='Window RP';view.apply();assert.equal(events.length,1);assert.equal(events[0]!.name,'apply');assert.deepEqual(Object.keys(events[0]!.args[0]).sort(),['angles','center','heightMm','name','widthMm']);assert.equal(h.history.past.length,1);assert.deepEqual(h.manager.selected.value!.plane.size,[8,6]);close(mprPlaneCenter(h.manager.selected.value!.plane)[0],123.125);close(resliceProperties(h.manager.selected.value!).widthMm,16);assert.deepEqual(normal(h.state.value.measurements),original.measurements);
    h.manager.openProperties();props.draft=h.manager.propertiesDraft.value!;await nextTick();const count=events.length,before=normal(h.state.value);view.form.name='';view.apply();assert.equal(events.length,count);assert.ok(view.error.value);view.form.name='Valid';view.form.center[0]=NaN;view.apply();assert.equal(events.length,count);view.form.center[0]=1;view.form.heightMm=0;view.apply();assert.equal(events.length,count);view.form.heightMm=1;
    props.busy=true;view.apply();view.cancel();assert.equal(events.length,count);props.busy=false;let prevented=0,stopped=0;view.key({key:'Escape',preventDefault:()=>prevented++,stopPropagation:()=>stopped++});assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(events.at(-1)!.name,'cancel');assert.equal(h.manager.propertiesDraft.value,null);assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,1);
  }finally{h.scope.stop();}
});
