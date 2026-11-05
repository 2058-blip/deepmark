import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {parseNifti,exportNifti} from '../src/core.ts';
import {addMask,addPart,createProject,decodeProject,encodeProject,makeMask,ProjectHistory,replaceMask,validateProject,volumeGrid} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import type {DicomVolume} from '../src/mimics/dicom.ts';
import {convertSeriesToVolume} from '../src/mimics/dicom.ts';
import type {DicomSlice} from '../src/mimics/dicom.ts';
import {physicalPoint} from '../src/mimics/types.ts';
import type {TriangleMesh} from '../src/mimics/types.ts';
import {fitCenterline} from '../src/mimics/centerline.ts';
import {calculatePolylines} from '../src/mimics/contours.ts';
import {calculateSurface} from '../src/mimics/geometry.ts';

function fixture(unit=2,little=true){
  const buffer=new ArrayBuffer(376),h=new DataView(buffer),bytes=new Uint8Array(buffer);
  h.setInt32(0,348,little);h.setInt16(40,3,little);
  const nativeScale=unit===1?.001:unit===3?1000:1;
  [3,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,little);h.setFloat32(80+a*4,(a+1)*nativeScale,little);});
  h.setInt16(70,4,little);h.setInt16(72,16,little);h.setFloat32(108,352,little);h.setFloat32(112,2,little);h.setFloat32(116,-1000,little);h.setUint8(123,unit);h.setInt16(254,1,little);
  const affine=[[0,-2,.2,10],[1,0,0,-20],[0,0,3,30]];
  affine.forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n*nativeScale,little)));bytes.set([110,43,49,0],344);
  for(let i=0;i<12;i++)h.setInt16(352+i*2,i-3,little);
  const volume=parseNifti(buffer,'合成项目.nii');
  let state=createProject(volume);state=replaceMask(state,state.selectedMaskId,Uint8Array.from({length:12},(_,i)=>Number(i<7)),[-1006,-990]);
  state={...state,masks:state.masks.map(m=>({...m,opacity:0,name:'重叠组织 A',revision:4}))};
  state=addMask(state,12,'重叠组织 B',Uint8Array.from({length:12},(_,i)=>Number(i>=4)));
  const mesh:TriangleMesh={positions:new Float32Array([10,-20,30,10,-19,30,8,-20,30]),indices:new Uint32Array([0,1,2]),normals:new Float32Array([0,0,1,0,0,1,0,0,1])};
  state=addPart(state,mesh,state.masks[0]);state={...state,parts:state.parts.map(p=>({...p,opacity:0})),measurements:[{id:'measure-distance',name:'物理距离',kind:'distance',points:[physicalPoint([0,0,0],volumeGrid(volume)),physicalPoint([2,1,1],volumeGrid(volume))],plane:{axis:2,index:0},visible:true,color:'#ffffff'},{id:'annotation',name:'文字',kind:'annotation',points:[[10,-20,30]],partId:state.selectedPartId,text:'保留 文字、箭头锚点',visible:false,color:'#ffdf7a'}]};
  return {volume,state};
}
const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value));
function damage(bytes:Uint8Array,edit:(meta:any,files:Record<string,Uint8Array>)=>void){const files=unzipSync(bytes),meta=JSON.parse(strFromU8(files['project.json']!));edit(meta,files);files['project.json']=strToU8(JSON.stringify(meta));return zipSync(files,{level:0});}
function objectFixture(){
  const seed=fixture(),buffer=new ArrayBuffer(352+50*2),bytes=new Uint8Array(buffer),view=new DataView(buffer);bytes.set(seed.volume.header);[5,5,2].forEach((n,a)=>view.setInt16(42+a*2,n,true));
  for(let i=0;i<50;i++)view.setInt16(352+i*2,i,true);const volume=parseNifti(buffer),grid=volumeGrid(volume),mask=Uint8Array.from({length:50},(_,i)=>Number(!(i%5===2&&Math.floor(i/5)%5===2)));
  let state=createProject(volume);state=replaceMask(state,state.selectedMaskId,mask);const graph=fitCenterline(grid,mask,{root:[0,0,0],endpoints:[[4,4,1]],coordinateSpace:'voxel'}),set=calculatePolylines(grid,mask,{axis:2});
  state={...state,centerlines:[{id:'centerline-1',name:'分支树',visible:true,color:'#ffffff',graph,sourceMaskId:state.selectedMaskId,sourceRevision:1,sourcePartId:'historical-deleted-part'}],polylines:[{id:'polyline-1',name:'带孔轮廓',visible:false,color:'#112233',set,sourceMaskId:state.selectedMaskId,sourceRevision:1}],selectedCenterlineId:'centerline-1',selectedPolylineId:'polyline-1'};return {volume,state};
}

test('ZIP roundtrip preserves independent overlapping masks, parts/normals, measurements, zero opacity and detached buffers',()=>{
  const {volume,state}=fixture();const encoded=encodeProject(volume,state),restored=decodeProject(encoded);
  assert.deepEqual(normalize(restored.state),normalize(state));
  assert.deepEqual(restored.volume.data,volume.data);assert.deepEqual(restored.volume.header,volume.header);assert.deepEqual(restored.volume.affine,volume.affine);
  assert.equal(restored.state.masks[0]!.data[5],1);assert.equal(restored.state.masks[1]!.data[5],1);
  assert.equal(restored.state.masks[0]!.opacity,0);assert.equal(restored.state.parts[0]!.opacity,0);
  assert.deepEqual(restored.state.parts[0]!.mesh.normals,state.parts[0]!.mesh.normals);
  restored.state.masks[0]!.data[5]=0;assert.equal(restored.state.masks[1]!.data[5],1);assert.equal(state.masks[0]!.data[5],1);
  const second=decodeProject(encodeProject(restored.volume,restored.state));assert.deepEqual(normalize(second.state),normalize(restored.state));
});
test('native metre/micron and big endian NIfTI geometry survive project save and label export as millimetre workbench grids',()=>{
  for(const unit of [1,2,3])for(const little of [true,false]){
    const {volume,state}=fixture(unit,little),restored=decodeProject(encodeProject(volume,state)),grid=volumeGrid(restored.volume);
    const point=physicalPoint([2,1,1],grid);point.forEach((n,a)=>assert.ok(Math.abs(n-[8.2,-18,33][a]!)<1e-4));
    const labels=Uint16Array.from(restored.state.masks[0]!.data),exported=parseNifti(exportNifti(restored.volume,labels));
    assert.equal(exported.little,little);assert.deepEqual(exported.affine,volume.affine);assert.deepEqual(exported.data,Float32Array.from(labels));assert.equal(exported.header[123]!&7,unit);
  }
});
test('DICOM MONOCHROME1 display inversion, quantitative unit and window metadata survive without modifying values',()=>{
  const {volume,state}=fixture();(volume as DicomVolume).dicom={modality:'CT',intensityUnit:'HU',photometricInterpretation:'MONOCHROME1',displayInverted:true,windowCenter:35,windowWidth:450,coordinateSystem:'RAS'};
  const restored=decodeProject(encodeProject(volume,state)).volume as DicomVolume;
  assert.deepEqual(restored.dicom,(volume as DicomVolume).dicom);assert.deepEqual(restored.data,volume.data);
});
test('surface-distance user constraints remain separate from dense edge-graph paths after save and undo',()=>{
  const {volume,state}=fixture();state.measurements.push({id:'surface-path',name:'曲面路径',kind:'surface-distance',points:[[10,-20,30],[10,-19,30],[8,-20,30]],controlPoints:[[10,-20,30],[8,-20,30]],pathMethod:'edge-graph',partId:state.selectedPartId,visible:true,color:'#abcdef'});
  const good=encodeProject(volume,state),restored=decodeProject(good);assert.deepEqual(normalize(restored.state.measurements.at(-1)),normalize(state.measurements.at(-1)));assert.equal(restored.state.measurements.at(-1)!.controlPoints!.length,2);assert.equal(restored.state.measurements.at(-1)!.points.length,3);
  const history=new ProjectHistory(100000);history.push('rename',state,{...state,name:'after'});state.measurements.at(-1)!.controlPoints![0]![0]=999;assert.equal(history.undo()!.measurements.at(-1)!.controlPoints![0]![0],10);
  assert.throws(()=>decodeProject(damage(good,m=>{m.project.measurements.at(-1).controlPoints=[[0,0,0]];})),/约束点/);assert.throws(()=>decodeProject(damage(good,m=>{m.project.measurements[0].pathMethod='edge-graph';})),/路径方法/);
});
test('optional centreline graphs and nested polyline rings persist in version 1 and history snapshots remain independent',()=>{
  const {volume,state}=objectFixture(),restored=decodeProject(encodeProject(volume,state));assert.deepEqual(normalize(restored.state),normalize(state));
  assert.equal(restored.state.polylines![0]!.set.layers[0]!.rings.filter(r=>r.hole).length,1);assert.equal(restored.state.centerlines![0]!.graph.cyclePolicy,'rooted-shortest-path-tree');
  const expected=normalize(state),history=new ProjectHistory(1000000);history.push('rename',state,{...state,name:'renamed'});
  state.centerlines![0]!.graph.nodes[0]!.position[0]=999;state.polylines![0]!.set.layers[0]!.rings[0]!.points[0]![0]=999;assert.deepEqual(normalize(history.undo()),expected);
  const legacy=fixture(),old=decodeProject(encodeProject(legacy.volume,legacy.state));assert.equal(old.state.centerlines,undefined);assert.equal(old.state.polylines,undefined);
});
test('centreline topology and contour dimensions, planes, metrics, finite points and parent relations are validated',()=>{
  const {volume,state}=objectFixture(),good=encodeProject(volume,state),cases:[(m:any)=>void,RegExp][]=[
    [m=>{m.project.centerlines[0].graph.rootNodeId='missing';},/根节点/],
    [m=>{m.project.centerlines[0].sourcePartId=123;},/来源Part ID/],
    [m=>{m.project.centerlines[0].graph.branches[0].radiiMm[0]=null;},/分支损坏/],
    [m=>{m.project.centerlines[0].graph.branches.push({...m.project.centerlines[0].graph.branches[0],id:'loop'});},/非树|闭环/],
    [m=>{m.project.polylines[0].set.dims[0]=999;},/尺寸/],
    [m=>{m.project.polylines[0].set.layers[0].plane.axis=1;},/切片/],
    [m=>{m.project.polylines[0].set.layers[0].rings[0].parent=0;},/parent/],
    [m=>{m.project.polylines[0].set.layers[0].rings[0].points[0][0]=null;},/坐标/],
    [m=>{m.project.polylines[0].set.layers[0].rings[0].areaMm2=999;},/面积/],
    [m=>{m.project.polylines[0].set.layers[0].rings[1].hole=false;},/洞/],
    [m=>{m.project.selectedCenterlineId='missing';},/活动中心线/],
    [m=>{m.project.polylines[0].id=m.project.centerlines[0].id;m.project.selectedPolylineId=m.project.centerlines[0].id;},/重复对象ID/],
  ];for(const [edit,pattern] of cases)assert.throws(()=>decodeProject(damage(good,edit)),pattern);
});
test('one history entry restores an atomic source cut, new overlapping target and annotation; redo and branching remain consistent',()=>{
  const {state}=fixture(),history=new ProjectHistory(100000);
  const cut=state.masks[0]!.data.slice();cut[5]=0;
  let after=replaceMask(state,state.masks[0]!.id,cut);after=addMask(after,12,'复制/剪切目标',Uint8Array.from({length:12},(_,i)=>Number(i===5)));
  after={...after,measurements:[...after.measurements,{id:'transaction-label',name:'结果',kind:'annotation',points:[[1,2,3]],text:'原子操作',visible:true,color:'#ffffff'}]};
  history.push('cut→new mask + annotation',state,after);
  assert.equal(history.past.length,1);assert.deepEqual(normalize(history.undo()),normalize(state));assert.deepEqual(normalize(history.redo()),normalize(after));
  const back=history.undo()!;const branch={...back,name:'new branch'};history.push('rename',back,branch);assert.equal(history.redo(),undefined);assert.equal(history.past.at(-1)!.name,'rename');assert.deepEqual(normalize(history.undo()),normalize(state));
});
test('history snapshots isolate mutable metadata, while immutable voxel buffers are shared across states',()=>{
  const {state}=fixture(),history=new ProjectHistory(100000);const expected=normalize(state),after={...state,name:'changed'};
  history.push('rename',state,after);state.masks[0]!.threshold![0]=999;state.measurements[0]!.points[0]![0]=999;
  const undone=history.undo()!;assert.deepEqual(normalize(undone),expected);assert.equal(undone.masks[0]!.data,state.masks[0]!.data);
  undone.measurements[0]!.points[0]![0]=888;const redone=history.redo()!;const again=history.undo()!;assert.notEqual(again.measurements[0]!.points[0]![0],888);assert.equal(redone.name,'changed');
});
test('history accounts for removed masks, mesh normals and old buffers, evicts oversized entries and respects entry cap',()=>{
  const {state}=fixture(),large={...state,masks:state.masks.map(m=>({...m,data:new Uint8Array(2000)})),parts:state.parts.map(p=>({...p,mesh:{positions:new Float32Array(3000),indices:new Uint32Array(3000),normals:new Float32Array(3000)}}))};
  const empty:ProjectState={...large,masks:[],parts:[],measurements:[],selectedMaskId:'',selectedPartId:''};
  const history=new ProjectHistory(100000);history.push('delete all',large,empty);assert.ok(history.bytesUsed>=40000);assert.ok(history.bytesUsed<=history.maxBytes);assert.ok(history.undo());assert.ok(history.bytesUsed<=history.maxBytes);
  const tooSmall=new ProjectHistory(1000);tooSmall.push('delete all',large,empty);assert.equal(tooSmall.past.length,0);assert.equal(tooSmall.bytesUsed,0);assert.equal(tooSmall.undo(),undefined);
  const disabled=new ProjectHistory(0);disabled.push('rename',state,{...state,name:'x'});assert.equal(disabled.undo(),undefined);
  const capped=new ProjectHistory(100000,2);let previous=state;for(let i=0;i<4;i++){const next={...previous,name:String(i)};capped.push('rename '+i,previous,next);previous=next;}
  assert.equal(capped.past.length,2);assert.equal(capped.undo()!.name,'2');assert.equal(capped.undo()!.name,'1');assert.equal(capped.undo(),undefined);capped.clear();assert.equal(capped.bytesUsed,0);assert.equal(capped.redo(),undefined);
});
test('damaged ZIP descriptors, binary lengths, numeric values, NIfTI geometry and object IDs are rejected',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  const cases:[(meta:any,files:Record<string,Uint8Array>)=>void,RegExp][]=[
    [(m)=>{m.version=999;},/格式或版本/],[(m,f)=>{delete f['masks/0.u8'];},/数据损坏/],[(m,f)=>{f['parts/0.normals.f32']=new Uint8Array(4);},/数据损坏/],
    [(m,f)=>{new DataView(f['image/values.f32']!.buffer).setFloat32(0,NaN,true);},/非有限/],[(m,f)=>{f['masks/0.u8']![0]=7;},/二值/],
    [(m)=>{m.volume.min=-999999;},/灰度范围/],[(m)=>{m.volume.affine[0][0]=20;},/仿射/],[(m)=>{m.volume.spacing[0]=123;},/仿射/],[(m)=>{m.volume.affine=[[0,0,0,0],[0,0,0,0],[0,0,0,0]];},/仿射/],
    [(m,f)=>{new DataView(f['image/header.bin']!.buffer).setInt16(42,9,true);},/NIfTI头/],[(m)=>{m.project.masks[0].opacity=2;},/透明度/],
    [(m)=>{m.project.measurements[1].id=m.project.masks[0].id;},/重复对象ID/],[(m)=>{m.project.measurements[0].kind='invented';},/类型/],[(m)=>{m.project.measurements[0].plane.index=99;},/平面/],
    [(m)=>{m.project.selectedMaskId='does-not-exist';},/活动对象引用/],[(m)=>{m.project.masks[0].path='image/header.bin';},/Mask属性/],
  ];
  for(const [edit,pattern] of cases)assert.throws(()=>decodeProject(damage(good,edit)),pattern);
  assert.throws(()=>decodeProject(good.subarray(0,30)));assert.throws(()=>decodeProject(zipSync({'not-project.txt':strToU8('x')})),/project.json/);
});
test('ZIP resource limits are checked before inflation and traversal paths are never accepted',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  assert.throws(()=>decodeProject(good,{maxArchiveBytes:10}),/压缩包/);assert.throws(()=>decodeProject(good,{maxUncompressedBytes:100}),/解压数据/);assert.throws(()=>decodeProject(good,{maxEntryBytes:16}),/解压数据/);assert.throws(()=>decodeProject(good,{maxFiles:2}),/解压数据/);
  assert.throws(()=>decodeProject(zipSync({'../outside':strToU8('x')})),/数据路径/);
  const corrupted=good.slice(),view=new DataView(corrupted.buffer);let directory=0;while(directory<corrupted.length-4&&view.getUint32(directory,true)!==0x02014b50)directory++;assert.ok(directory<corrupted.length-4);corrupted[directory+16]^=1;
  assert.throws(()=>decodeProject(corrupted),/ZIP校验/);
  assert.throws(()=>decodeProject(zipSync({'project.json':strToU8('not-json')})),/内容损坏/);
});

test('optional v1 view state restores voxel position, window, mode and selected measurement and is isolated in history',()=>{
  const {volume,state}=fixture();
  state.viewState={point:[2,1,1],window:{center:0,width:1},activeAxis:0,renderMode:'volume',tool:'distance',selectedMeasurementId:'measure-distance',tab:'measurements'};
  const expected=normalize(state),restored=decodeProject(encodeProject(volume,state));
  assert.deepEqual(normalize(restored.state),expected);
  restored.state.viewState!.point![0]=0;restored.state.viewState!.window!.center=100;
  assert.equal(state.viewState.point![0],2);assert.equal(state.viewState.window!.center,0);
  const history=new ProjectHistory(1000000);history.push('change view',state,{...state,viewState:{...state.viewState,renderMode:'parts',tab:'surface'}});
  state.viewState.point![0]=1;state.viewState.window!.width=999;
  const undone=history.undo()!;assert.deepEqual(normalize(undone),expected);
  undone.viewState!.window!.center=-999;
  assert.equal(history.redo()!.viewState!.renderMode,'parts');assert.equal(history.undo()!.viewState!.window!.center,0);
  const legacy=fixture();assert.equal(decodeProject(encodeProject(legacy.volume,legacy.state)).state.viewState,undefined);
});

test('invalid view state is rejected consistently by ZIP restore and in-memory validation',()=>{
  const cases:[Record<string,unknown>,RegExp][]=[
    [{point:[3,0,0]},/定位点/],[{point:[.5,0,0]},/定位点/],[{point:[0,0]},/定位点/],
    [{window:{center:0,width:0}},/窗宽/],[{window:{center:null,width:1}},/窗宽/],[{activeAxis:3},/活动轴/],
    [{renderMode:'surface'},/渲染模式/],[{tab:'invented'},/标签页/],[{tool:'invented'},/工具/],
    [{selectedMeasurementId:'absent'},/活动测量引用/],[{camera:{zoom:1}},/未支持字段/],
  ];
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  for(const [viewState,pattern] of cases){
    const invalid={...state,viewState} as ProjectState;
    assert.throws(()=>validateProject(volume,invalid),pattern);
    assert.throws(()=>encodeProject(volume,invalid),pattern);
    assert.throws(()=>decodeProject(damage(good,m=>{m.project.viewState=viewState;})),pattern);
  }
});

test('the public validator checks detached IndexedDB-style data without modifying or replacing source buffers',()=>{
  const {volume,state}=objectFixture(),saved=structuredClone({volume,state});
  saved.state.viewState={point:[4,4,1],window:{center:0,width:50},activeAxis:2,renderMode:'parts',tool:'smartExpand',selectedMeasurementId:'',tab:'analysis'};
  const expected=normalize(saved),data=saved.volume.data,mask=saved.state.masks[0]!.data,mesh=saved.state.parts[0]?.mesh;
  validateProject(saved.volume,saved.state);
  assert.deepEqual(normalize(saved),expected);assert.equal(saved.volume.data,data);assert.equal(saved.state.masks[0]!.data,mask);assert.equal(saved.state.parts[0]?.mesh,mesh);
  assert.deepEqual(normalize(decodeProject(encodeProject(saved.volume,saved.state))),expected);
  saved.state.masks[0]!.data[0]=2;
  assert.throws(()=>validateProject(saved.volume,saved.state),/二值/);
  assert.equal(saved.state.masks[0]!.data[0],2);assert.equal(saved.volume.data,data);
});

test('saving rejects invalid buffers and non-JSON metadata before producing an unreadable archive',()=>{
  const cases:[(volume:any,state:any)=>void,RegExp][]=[
    [(v)=>{v.data=new Float64Array(v.data);},/存储类型/],
    [(v)=>{v.data[0]=NaN;},/非有限/],
    [(_v,s)=>{s.masks[0].data[0]=2;},/二值/],
    [(_v,s)=>{s.parts[0].mesh.indices[0]=999;},/网格/],
    [(_v,s)=>{s.parts[0].mesh.normals=new Float32Array([0,0,1]);},/数据损坏/],
    [(_v,s)=>{s.measurements[0].points[0][0]=NaN;},/坐标/],
    [(_v,s)=>{s.measurements[0].points[0]=Array(3);},/稀疏数组/],
    [(_v,s)=>{s.name=123n;},/名称/],
    [(_v,s)=>{Object.defineProperty(s,'centerlines',{value:[],enumerable:false});},/未支持的属性/],
    [(_v,s)=>{Object.defineProperty(s,'viewState',{get:()=>({renderMode:'parts'}),enumerable:true});},/未支持的属性/],
    [(_v,s)=>{Object.defineProperty(s.measurements[0].points[0],0,{get:()=>10,enumerable:true});},/未支持的属性/],
  ];
  for(const [edit,pattern] of cases){const {volume,state}=fixture();edit(volume,state);assert.throws(()=>validateProject(volume,state),pattern);assert.throws(()=>encodeProject(volume,state),pattern);}
});

test('unknown metadata and extra binary entries are rejected instead of silently dropping unsaved objects',()=>{
  const cases:((meta:any)=>void)[]=[
    m=>{m.extra={};},m=>{m.volume.phase='new';},m=>{m.project.unsupportedAdvancedObject={};},
    m=>{m.project.masks[0].locked=true;},m=>{m.project.parts[0].newAttribute=1;},
    m=>{m.project.measurements[0].plane.normal=[1,0,0];},m=>{m.project.measurements[0].newAttribute=1;},
  ];
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  for(const edit of cases)assert.throws(()=>decodeProject(damage(good,edit)),/未支持字段/);
  assert.throws(()=>decodeProject(damage(good,(_m,f)=>{f['extra/phase.bin']=new Uint8Array([1]);})),/未支持的数据条目/);
  const objects=objectFixture(),advanced=encodeProject(objects.volume,objects.state);
  for(const edit of [m=>{m.project.centerlines[0].graph.nodes[0].label='unsupported';},m=>{m.project.polylines[0].set.layers[0].rings[0].newMetric=1;}] as ((m:any)=>void)[])assert.throws(()=>decodeProject(damage(advanced,edit)),/未支持字段/);
  for(const edit of [(_v,s)=>{s.extra={};},(_v,s)=>{s.masks[0].path='would-be-overwritten';},(_v,s)=>{s.parts[0].mesh.units='m';},(v)=>{v.dicom={modality:'CT',intensityUnit:'HU',photometricInterpretation:'MONOCHROME2',displayInverted:false,coordinateSystem:'RAS',unsupported:'x'};}] as ((v:any,s:any)=>void)[]){const input=fixture();edit(input.volume,input.state);assert.throws(()=>encodeProject(input.volume,input.state),/未支持字段/);}
});

test('provenance permits older or deleted sources but rejects future revisions and references of the wrong type',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  assert.throws(()=>decodeProject(damage(good,m=>{m.project.parts[0].sourceRevision=5;})),/晚于/);
  assert.throws(()=>decodeProject(damage(good,m=>{m.project.parts[0].sourceMaskId=m.project.parts[0].id;})),/其他类型/);
  assert.throws(()=>decodeProject(damage(good,m=>{m.project.measurements[1].partId=m.project.masks[0].id;})),/其他类型/);
  const stale={...state,masks:state.masks.map(m=>({...m,revision:m.revision+1}))};validateProject(volume,stale);
  const deleted={...state,masks:state.masks.slice(1)};validateProject(volume,deleted);
  assert.equal(decodeProject(encodeProject(volume,deleted)).state.parts[0]!.sourceRevision,4);
  const objects=objectFixture(),advanced=encodeProject(objects.volume,objects.state);
  for(const kind of ['centerlines','polylines'])assert.throws(()=>decodeProject(damage(advanced,m=>{m.project[kind][0].sourceRevision=2;})),/晚于/);
});

test('mask and mesh helpers reject invalid inputs atomically and preserve undo-redo branches after rejection',()=>{
  const {state}=fixture(),before=normalize(state),history=new ProjectHistory(1000000);
  assert.throws(()=>makeMask(NaN),/尺寸/);assert.throws(()=>addMask(state,13),/尺寸/);
  assert.throws(()=>replaceMask(state,state.masks[0]!.id,new Uint8Array(12).fill(2)),/二值/);
  assert.throws(()=>replaceMask(state,state.masks[0]!.id,new Uint8Array(12),[2,1]),/阈值/);
  assert.throws(()=>replaceMask({...state,masks:state.masks.map(m=>({...m,revision:Number.MAX_SAFE_INTEGER}))},state.masks[0]!.id,new Uint8Array(12)),/版本/);
  assert.throws(()=>addPart(state,{positions:new Float32Array([0,0,0]),indices:new Uint32Array([0,1,2])}),/网格/);
  assert.deepEqual(normalize(state),before);
  const after={...state,name:'changed'};history.push('valid',state,after);history.undo();
  const bytes=history.bytesUsed,invalid={...state,viewState:{window:{center:NaN,width:10}}};
  assert.throws(()=>history.push('invalid',state,invalid),/元数据/);
  assert.equal(history.past.length,0);assert.equal(history.future.length,1);assert.equal(history.bytesUsed,bytes);assert.equal(history.redo()!.name,'changed');
});

test('native header datatype, scaling, offset and oblique marker cannot hide behind project value buffers',()=>{
  const {volume,state}=fixture(),good=encodeProject(volume,state);
  const cases:[(meta:any,header:DataView)=>void,RegExp][]=[
    [(_m,h)=>h.setInt16(70,999,true),/数据类型/],
    [(_m,h)=>h.setInt16(72,8,true),/位深/],
    [(_m,h)=>h.setFloat32(112,NaN,true),/缩放/],
    [(_m,h)=>h.setFloat32(108,NaN,true),/偏移/],
    [(m)=>{m.volume.oblique=!m.volume.oblique;},/方向标记/],
  ];
  for(const [edit,pattern] of cases)assert.throws(()=>decodeProject(damage(good,(m,f)=>edit(m,new DataView(f['image/header.bin']!.buffer)))),pattern);
});

test('synthetic DICOM conversion to overlapping masks, calculated Part, measurement and one undoable saved transaction',()=>{
  const slices:DicomSlice[]=Array.from({length:3},(_,z)=>({
    seriesInstanceUID:'offline-synthetic',sopInstanceUID:`offline-${z}`,modality:'CT',rows:4,columns:4,
    imagePosition:[10,20,z*2],imageOrientation:[1,0,0,0,1,0],pixelSpacing:[.75,.5],sliceThickness:2,
    bitsAllocated:16,bitsStored:16,highBit:15,signed:true,rescaleSlope:1,rescaleIntercept:0,intensityUnit:'HU',
    photometricInterpretation:'MONOCHROME1',windowCenter:0,windowWidth:500,
    data:Float32Array.from({length:16},(_,i)=>i%4>=1&&i%4<=2&&Math.floor(i/4)>=1&&Math.floor(i/4)<=2?400:-1000),
    transferSyntaxUID:'1.2.840.10008.1.2.1',
  }));
  const volume=convertSeriesToVolume(slices),grid=volumeGrid(volume),history=new ProjectHistory(1000000);
  const before=createProject(volume),mask=Uint8Array.from(volume.data,value=>Number(value>200));
  let after=replaceMask(before,before.selectedMaskId,mask,[200,1000]);
  after=addMask(after,mask.length,'Independent overlap',mask.slice());
  const source=after.masks[0]!,mesh=calculateSurface(grid,source.data);assert.ok(mesh.indices.length>0);
  after=addPart(after,mesh,source);
  after={...after,measurements:[{id:'dicom-distance',kind:'distance',name:'0.5 mm',points:[physicalPoint([1,1,1],grid),physicalPoint([2,1,1],grid)],visible:true,color:'#ffffff'}],viewState:{point:[1,1,1],window:{center:0,width:500},renderMode:'parts',selectedMeasurementId:'dicom-distance'}};
  history.push('segment → Part → measure',before,after);
  assert.deepEqual(normalize(history.undo()),normalize(before));assert.deepEqual(normalize(history.redo()),normalize(after));
  const restored=decodeProject(encodeProject(volume,after));
  assert.deepEqual(normalize(restored.state),normalize(after));assert.deepEqual((restored.volume as DicomVolume).dicom,volume.dicom);
  assert.deepEqual(restored.volume.data,volume.data);assert.equal(restored.state.parts[0]!.sourceRevision,1);
  const points=restored.state.measurements[0]!.points;assert.equal(Math.hypot(...points[1]!.map((n,a)=>n-points[0]![a]!)),.5);
  restored.state.masks[0]!.data.fill(0);assert.ok(restored.state.masks[1]!.data.some(Boolean));assert.ok(source.data.some(Boolean));
});

test('invalid runtime history budgets reject before stack mutation instead of entering an unbounded prune loop',()=>{
  const {state}=fixture(),history=new ProjectHistory(1000000),after={...state,name:'after'};
  history.push('rename',state,after);
  history.maxEntries=-1;
  assert.throws(()=>history.push('bad budget',after,state),/预算/);assert.throws(()=>history.undo(),/预算/);assert.equal(history.past.length,1);assert.equal(history.future.length,0);
  history.maxEntries=1000;history.undo();history.maxBytes=NaN;
  assert.throws(()=>history.redo(),/预算/);assert.equal(history.future.length,1);assert.equal(history.past.length,0);
  history.maxBytes=1000000;assert.equal(history.redo()!.name,'after');
});
