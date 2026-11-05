import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectScope,reactive,ref,shallowRef,watch} from 'vue';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {parseNifti} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import {createProject,decodeProject,encodeProject,ProjectHistory,validateMeasurementObject,validateProject,volumeGrid} from '../src/mimics/project.ts';
import type {ProjectMprViewState,ProjectState} from '../src/mimics/project.ts';
import {useMeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {MeasurementProperties} from '../src/mimics/useMeasurementProperties.ts';
import type {MeasurementObject,MprPlane,Vec3} from '../src/mimics/types.ts';

function plane():MprPlane{return{origin:[-12.25,33.5,-9],u:[.6,.8,0],v:[-1.6,1.2,0],size:[7,5]};}
function fixture(unit=2,little=true){
  const buffer=new ArrayBuffer(376),h=new DataView(buffer),bytes=new Uint8Array(buffer),scale=unit===1?.001:unit===3?1000:1;
  h.setInt32(0,348,little);h.setInt16(40,3,little);
  [3,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,little);h.setFloat32(80+a*4,(a+1)*scale,little);});
  h.setInt16(70,4,little);h.setInt16(72,16,little);h.setFloat32(108,352,little);h.setFloat32(112,1,little);h.setUint8(123,unit);h.setInt16(254,1,little);
  [[0,-2,.2,10],[1,0,0,-20],[0,0,3,30]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n*scale,little)));
  bytes.set([110,43,49,0],344);for(let i=0;i<12;i++)h.setInt16(352+i*2,i-3,little);
  const volume=parseNifti(buffer,'mpr-project.nii'),state=createProject(volume);
  const measurement:MeasurementObject={id:'mpr-distance',name:'MPR distance',kind:'distance',points:[[-12.25,33.5,-9],[-11.05,35.1,-9]],mprPlane:plane(),visible:true,color:'#abcdef',labelOffset:[.125,-.5,1]};
  state.measurements=[measurement];
  state.viewState={point:[2,1,1],activeAxis:2,mpr:{enabled:true,plane:plane(),step:.375,interpolation:'linear',crosshair:[1_000.125,-2_000.875,.03125]}};
  return{volume,state,measurement};
}
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function damage(bytes:Uint8Array,edit:(meta:any)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));edit(meta);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files,{level:0});}
function harness(){
  const input=fixture(),scope=effectScope(),state=shallowRef(input.state),volume=shallowRef<Volume|null>(input.volume),selectedMeasurementId=ref('mpr-distance'),busy=ref(false),history=new ProjectHistory(1_000_000),errors:unknown[]=[];let commits=0;
  const commit=(name:string,next:ProjectState)=>{history.push(name,state.value,next);state.value=next;commits++;};
  const editor=scope.run(()=>{
    watch([()=>state.value.measurements,selectedMeasurementId],()=>{if(selectedMeasurementId.value&&!state.value.measurements.some(m=>m.id===selectedMeasurementId.value))selectedMeasurementId.value='';},{flush:'sync'});
    return useMeasurementProperties({state,volume,selectedMeasurementId,busy,commit,fail:error=>errors.push(error)});
  })!;
  return{...input,state,volume,selectedMeasurementId,busy,scope,history,errors,editor,commits:()=>commits};
}

test('MPR ZIP and repeated saves preserve pixel steps, precise unbounded world crosshair and unchanged native volume geometry',()=>{
  for(const unit of [1,2,3])for(const little of [true,false]){
    const {volume,state}=fixture(unit,little),expected=normal(state),grid=normal(volumeGrid(volume)),restored=decodeProject(encodeProject(volume,state));
    assert.deepEqual(normal(restored.state),expected);assert.deepEqual(restored.volume.header,volume.header);assert.deepEqual(restored.volume.affine,volume.affine);assert.deepEqual(restored.volume.spacing,volume.spacing);assert.equal(restored.volume.little,little);assert.deepEqual(restored.volume.data,volume.data);assert.deepEqual(normal(volumeGrid(restored.volume)),grid);
    const again=decodeProject(encodeProject(restored.volume,restored.state));assert.deepEqual(normal(again.state),expected);
    assert.equal(Math.hypot(...again.state.measurements[0]!.mprPlane!.v),2);assert.deepEqual(again.state.viewState!.mpr!.crosshair,[1_000.125,-2_000.875,.03125]);
    for(const field of ['origin','u','v','size'] as const){restored.state.measurements[0]!.mprPlane![field][0]=999;restored.state.viewState!.mpr!.plane[field][0]=999;}
    restored.state.viewState!.mpr!.crosshair![0]=999;assert.deepEqual(normal(state),expected);
  }
});

test('optional MPR state leaves legacy native planes and missing display fields unchanged',()=>{
  const {volume,state}=fixture();delete state.measurements[0]!.mprPlane;state.measurements[0]!.plane={axis:2,index:1};delete state.viewState!.mpr;
  const restored=decodeProject(encodeProject(volume,state));assert.deepEqual(restored.state.measurements[0]!.plane,{axis:2,index:1});assert.equal(Object.hasOwn(restored.state.measurements[0]!,'mprPlane'),false);assert.equal(Object.hasOwn(restored.state.viewState!,'mpr'),false);
  delete state.viewState;assert.equal(Object.hasOwn(decodeProject(encodeProject(volume,state)).state,'viewState'),false);
  state.viewState={mpr:{enabled:false,plane:plane(),step:2,interpolation:'nearest'}};
  const mprOnly=decodeProject(encodeProject(volume,state));assert.equal(Object.hasOwn(mprOnly.state.viewState!,'point'),false);assert.equal(Object.hasOwn(mprOnly.state.viewState!.mpr!,'crosshair'),false);assert.deepEqual(mprOnly.state.viewState!.mpr,state.viewState.mpr);
});

test('MPR schema rejects mixed native/MPR planes but leaves controller coplanarity policy outside persistence',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state),mixed={...state,measurements:state.measurements.map(m=>({...m,plane:{axis:2 as const,index:0}}))};
  assert.throws(()=>validateProject(volume,mixed),/同时/);assert.throws(()=>encodeProject(volume,mixed),/同时/);assert.throws(()=>decodeProject(damage(good,m=>{m.project.measurements[0].plane={axis:2,index:0};})),/同时/);
  assert.throws(()=>validateMeasurementObject(mixed.measurements[0],volume.dims),/同时/);
  state.measurements[0]!.points[1]![2]=12345.875;
  validateProject(volume,state);assert.deepEqual(decodeProject(encodeProject(volume,state)).state.measurements[0]!.points,state.measurements[0]!.points);
});

test('MPR frame failures reject save/load/validation and history pushes without losing the redo branch',()=>{
  const malformed:unknown[]=[
    null,{...plane(),origin:[NaN,0,0]},{...plane(),u:[0,0,0]},{...plane(),u:[1e-9,0,0]},
    {...plane(),v:[1.2,1.6,0]},{...plane(),v:[1,1,0]},{...plane(),origin:[0,0]},
    {...plane(),size:[0,1]},{...plane(),size:[1.5,2]},{...plane(),size:[16385,1]},
    {...plane(),size:[2049,2049]},{...plane(),size:[1,Infinity]},{...plane(),spacing:[1,2]},
    {...plane(),origin:[1e308,0,0],u:[1e308,0,0],v:[0,1,0],size:[4,1]},
  ];
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  for(const candidate of malformed){
    const invalid={...state,measurements:[{...state.measurements[0]!,mprPlane:candidate as MprPlane}]};
    assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damage(good,m=>{m.project.measurements[0].mprPlane=candidate;})));
    const history=new ProjectHistory(1_000_000);history.push('valid',state,{...state,name:'after'});history.undo();const bytes=history.bytesUsed;
    assert.throws(()=>history.push('invalid',state,invalid));assert.equal(history.past.length,0);assert.equal(history.future.length,1);assert.equal(history.bytesUsed,bytes);assert.equal(history.redo()!.name,'after');
  }
});

test('MPR frames refuse nonordinary, sparse, accessor and extra-field inputs before serialization',()=>{
  let reads=0;const accessor=plane();Object.defineProperty(accessor,'origin',{enumerable:true,get(){reads++;return[0,0,0];}});
  const accessorArray=[0,0,0];Object.defineProperty(accessorArray,'1',{enumerable:true,get(){reads++;return 0;}});
  const extras=[0,0,0] as number[]&{extra?:number};extras.extra=1;
  const symbol=plane();Object.defineProperty(symbol,Symbol('hidden'),{value:1});
  const custom=Object.assign(Object.create({}),plane());
  const malformed=[accessor,{...plane(),origin:accessorArray},{...plane(),origin:new Float64Array([0,0,0])},{...plane(),origin:[0,,0]},{...plane(),origin:extras},symbol,custom];
  const {volume,state}=fixture();
  for(const candidate of malformed){
    const invalid={...state,measurements:[{...state.measurements[0]!,mprPlane:candidate as MprPlane}]};
    assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>validateMeasurementObject(invalid.measurements[0],volume.dims));
    assert.throws(()=>new ProjectHistory().push('invalid',state,invalid));
  }
  assert.equal(reads,0);
});

test('MPR view fields and strict precise crosshair validate consistently in archives and history',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state),base=state.viewState!.mpr!;
  const invalidViews:unknown[]=[null,{...base,enabled:1},{...base,step:0},{...base,step:-1},{...base,step:NaN},{...base,step:Infinity},{...base,interpolation:'cubic'},{...base,plane:{...plane(),v:[0,0,0]}},{...base,crosshair:[0,0]},{...base,crosshair:[0,NaN,0]},{...base,crosshair:[0,,0]},{...base,crosshair:new Float64Array(3)},{...base,extra:1}];
  for(const candidate of invalidViews){
    const invalid={...state,viewState:{mpr:candidate as ProjectMprViewState}};
    assert.throws(()=>validateProject(volume,invalid));assert.throws(()=>encodeProject(volume,invalid));assert.throws(()=>decodeProject(damage(good,m=>{m.project.viewState.mpr=candidate;})));assert.throws(()=>new ProjectHistory().push('invalid',state,invalid));
  }
  let reads=0;const accessor={...base};Object.defineProperty(accessor,'crosshair',{enumerable:true,get(){reads++;return[0,0,0];}});
  const hidden=[0,0,0];Object.defineProperty(hidden,'0',{enumerable:true,get(){reads++;return 0;}});
  for(const mpr of [accessor,{...base,crosshair:hidden}])assert.throws(()=>validateProject(volume,{...state,viewState:{mpr:mpr as ProjectMprViewState}}));assert.equal(reads,0);
  for(const crosshair of [undefined,[.125,-.25,.5] as Vec3,[1e100,-1e100,1e-100] as Vec3]){
    const mpr={...base,crosshair};state.viewState={mpr};const restored=decodeProject(encodeProject(volume,state));assert.deepEqual(restored.state.viewState!.mpr!.crosshair,crosshair);
  }
});

test('MPR history isolates every plane vector, output size, crosshair and Vue-backed view state',()=>{
  const {state}=fixture();state.viewState=reactive(state.viewState!);const expected=normal(state),history=new ProjectHistory(1_000_000);
  history.push('rename',state,{...state,name:'after'});
  for(const field of ['origin','u','v','size'] as const){state.measurements[0]!.mprPlane![field][0]=999;state.viewState!.mpr!.plane[field][0]=999;}
  state.viewState!.mpr!.crosshair![0]=999;state.viewState!.mpr!.step=4;state.viewState!.mpr!.interpolation='nearest';
  const undo=history.undo()!;assert.deepEqual(normal(undo),expected);assert.equal(undo.masks[0]!.data,state.masks[0]!.data);
  for(const field of ['origin','u','v','size'] as const){undo.measurements[0]!.mprPlane![field][0]=888;undo.viewState!.mpr!.plane[field][0]=888;}
  undo.viewState!.mpr!.crosshair![0]=888;assert.equal(history.redo()!.name,'after');assert.deepEqual(normal(history.undo()),expected);
});

test('MPR Properties exposes deeply read-only detached geometry and rejects geometry patches without committing',()=>{
  const h=harness();try{
    const original=normal(h.state.value),source=h.state.value.measurements[0]!;assert.equal(h.editor.openEdit(source.id),true);const draft=h.editor.draft.value!;
    assert.notEqual(draft.mprPlane,source.mprPlane);assert.ok(Object.isFrozen(draft.mprPlane));
    for(const field of ['origin','u','v','size'] as const){assert.notEqual(draft.mprPlane![field],source.mprPlane![field]);assert.ok(Object.isFrozen(draft.mprPlane![field]));assert.throws(()=>{draft.mprPlane![field][0]=999;},TypeError);}
    assert.throws(()=>{draft.mprPlane=plane();},TypeError);assert.throws(()=>{draft.mprPlane!.origin=[0,0,0];},TypeError);
    assert.equal(h.editor.apply({mprPlane:plane()} as unknown as MeasurementProperties),false);assert.ok(h.editor.draft.value);assert.equal(h.commits(),0);assert.equal(h.history.past.length,0);assert.equal(h.errors.length,1);assert.deepEqual(normal(h.state.value),original);
    h.editor.cancel();assert.equal(h.editor.draft.value,null);assert.equal(h.commits(),0);
  }finally{h.scope.stop();}
});

test('MPR metadata Apply keeps the latest live frame and duplicate independently owns all plane arrays',()=>{
  const h=harness();try{
    assert.equal(h.editor.openEdit('mpr-distance'),true);const latest=plane();latest.origin=[50.25,-70.5,90.75];latest.u=[1.2,1.6,0];latest.size=[8,9];
    const live={...h.state.value.measurements[0]!,mprPlane:latest,points:[[50,-70,90],[51,-69,90]] as Vec3[],labelOffset:[4,5,6] as Vec3};h.state.value={...h.state.value,measurements:[live]};
    assert.equal(h.editor.apply({name:'renamed',visible:false}),true);const edited=h.state.value.measurements[0]!;assert.deepEqual(edited.mprPlane,latest);assert.deepEqual(edited.points,live.points);assert.deepEqual(edited.labelOffset,[4,5,6]);assert.notEqual(edited.mprPlane,latest);assert.equal(h.commits(),1);
    assert.equal(h.editor.duplicate(edited.id),true);const copy=h.state.value.measurements[1]!;assert.equal(h.selectedMeasurementId.value,copy.id);assert.deepEqual(copy.mprPlane,edited.mprPlane);assert.notEqual(copy.mprPlane,edited.mprPlane);
    for(const field of ['origin','u','v','size'] as const){assert.notEqual(copy.mprPlane![field],edited.mprPlane![field]);edited.mprPlane![field][0]=999;assert.notEqual(copy.mprPlane![field][0],999);}
    assert.equal(h.commits(),2);const undone=h.history.undo()!;assert.equal(undone.measurements.length,1);assert.deepEqual(undone.measurements[0]!.mprPlane,latest);assert.equal(h.history.redo()!.measurements.length,2);
    validateProject(h.volume.value!,{...h.state.value,measurements:[copy]});
  }finally{h.scope.stop();}
});

test('MPR deferred creation, busy cancellation and document replacement never publish stale drafts',()=>{
  const h=harness();try{
    const fresh={...h.state.value.measurements[0]!,id:'pending-mpr'};assert.equal(h.editor.openCreate(fresh),true);fresh.mprPlane!.origin[0]=777;assert.notEqual(h.editor.draft.value!.mprPlane!.origin[0],777);h.editor.cancel();assert.equal(h.commits(),0);
    fresh.mprPlane=plane();assert.equal(h.editor.openCreate(fresh),true);h.busy.value=true;assert.equal(h.editor.draft.value,null);assert.equal(h.editor.apply({name:'stale'}),false);h.busy.value=false;
    assert.equal(h.editor.openCreate(fresh),true);h.volume.value={...h.volume.value!};assert.equal(h.editor.draft.value,null);assert.equal(h.commits(),0);
    assert.equal(h.editor.openCreate(fresh),true);assert.equal(h.editor.apply({name:'committed MPR'}),true);assert.equal(h.state.value.measurements.length,2);assert.equal(h.selectedMeasurementId.value,'pending-mpr');assert.equal(h.commits(),1);assert.equal(h.editor.apply({name:'double'}),false);
    assert.equal(h.editor.openEdit('pending-mpr'),true);h.state.value={...h.state.value,measurements:h.state.value.measurements.filter(m=>m.id!=='pending-mpr')};assert.equal(h.editor.draft.value,null);assert.equal(h.commits(),1);
    assert.equal(h.editor.openEdit('mpr-distance'),true);h.editor.cancel();h.state.value={...h.state.value,name:'same-volume replacement'};assert.equal(h.editor.apply({name:'stale replacement'}),false);assert.equal(h.commits(),1);
  }finally{h.scope.stop();}
});
