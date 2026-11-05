import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import type {ComputedRef} from 'vue';
import {parseNifti} from '../src/core.ts';
import {createProject,addMask,addPart,encodeProject,decodeProject,validateProject} from '../src/mimics/project.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MeasurementObject,SlicePlane,TriangleMesh,Vec3} from '../src/mimics/types.ts';

// Real workbench and operations.worker.ts through Node structured clone.
// Literal meshes/points are controlled hit inputs, not browser picking evidence.
// Expected values are analytic geometry/explicit pixel sets, never kernel output.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
interface Detail{kind:string;valid:boolean;value:number;unit:string;details:Record<string,any>;reason?:string}
type Editor=ReturnType<typeof useWorkbench>&{
  createDensityROI:(change:{kind:'density-rectangle'|'density-ellipse';plane:SlicePlane;points:[Vec3,Vec3]})=>unknown;
  updateMeasurementGeometry:(change:{id:string;points:Vec3[];plane?:SlicePlane})=>unknown;
  displayMeasurements:ComputedRef<MeasurementObject[]>;
  measurementDetails:(id:string)=>Detail;selectedMeasurementDetails:ComputedRef<Detail|null>;
};
const near=(actual:number,expected:number,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} differs from analytic ${expected}`);
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
function fixture(){
  const bytes=new Uint8Array(412),h=new DataView(bytes.buffer),affine=[[3,1,.5,10],[0,2,.25,-20],[0,0,4,30]];
  h.setInt32(0,348,true);h.setInt16(40,3,true);[4,5,3].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,Math.hypot(...affine.map(row=>row[a]!)),true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setInt16(254,1,true);h.setUint8(123,2);affine.forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+16*r+4*c,n,true)));bytes.set([110,43,49,0],344);
  for(let z=0;z<3;z++)for(let y=0;y<5;y++)for(let x=0;x<4;x++)bytes[352+x+4*(y+5*z)]=x+10*y+100*z;
  const volume=parseNifti(bytes.buffer,'measurement-shear.nii');let state=createProject(volume);const source=state.selectedMaskId,data=new Uint8Array(60);for(const i of [25,26,29,30])data[i]=1;
  state={...state,masks:state.masks.map(mask=>({...mask,name:'Source',data,threshold:[0,243] as [number,number]}))};state=addMask(state,60,'Overlap',Uint8Array.from({length:60},(_,i)=>Number(i===25)));
  // A closed parallelepiped with IJK bounds [.5,2.5] x [.5,3.5] x [.5,1.5].
  // The explicit affine arithmetic is fixture construction, not an output oracle.
  const world=([i,j,k]:number[])=>[3*i!+j!+.5*k!+10,2*j!+.25*k!-20,4*k!+30];
  const voxelCorners=[[.5,.5,.5],[2.5,.5,.5],[2.5,3.5,.5],[.5,3.5,.5],[.5,.5,1.5],[2.5,.5,1.5],[2.5,3.5,1.5],[.5,3.5,1.5]];
  const cube:TriangleMesh={positions:Float32Array.from(voxelCorners.flatMap(world)),indices:new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5])};
  state=addPart(state,cube,state.masks[0]);const a=state.selectedPartId;
  state=addPart(state,{positions:new Float32Array([15.25,-14.875,32,21.25,-14.875,32,18.25,-12.875,32]),indices:new Uint32Array([0,1,2])},state.masks[1]);const b=state.selectedPartId;
  state={...state,selectedMaskId:source,selectedPartId:a,viewState:{point:[1,2,1],activeAxis:2,tool:'navigate',tab:'measurements'}};return{volume,state,a,b};
}
async function withEditor(run:(editor:Editor,input:ReturnType<typeof fixture>,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))! as Editor,input=fixture();editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'fixture.deepmark.zip')]);await nextTick();await run(editor,input,exports);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function sources(editor:Editor){return{raw:editor.volume.value!.data.slice(),masks:editor.state.value.masks.map(mask=>({...mask,data:mask.data.slice(),threshold:mask.threshold?[...mask.threshold]:null})),parts:editor.state.value.parts.map(part=>({...part,mesh:{positions:part.mesh.positions.slice(),indices:part.mesh.indices.slice(),...(part.mesh.normals?{normals:part.mesh.normals.slice()}: {})}}))};}
function assertSources(editor:Editor,before:ReturnType<typeof sources>){assert.deepEqual(editor.volume.value!.data,before.raw);assert.deepEqual(editor.state.value.masks,before.masks);assert.deepEqual(editor.state.value.parts,before.parts);}
async function create(editor:Editor,tool:string,points:Vec3[]){editor.tool.value=tool;await nextTick();const count=editor.state.value.measurements.length;for(const point of points)await editor.imagePick([...point],2,point[2]);if(tool==='area')await editor.finishDrawing();assert.equal(editor.state.value.measurements.length,count+1);return editor.state.value.measurements.at(-1)!;}
function detail(editor:Editor,id:string){const result=editor.measurementDetails(id);assert.equal(result.valid,true,result.reason);editor.selectedMeasurementId.value=id;assert.equal(editor.selectedMeasurementDetails.value?.kind,result.kind);near(editor.selectedMeasurementDetails.value!.value,result.value);return result;}

const cases:{kind:'angle'|'diameter'|'ellipse'|'area';points:Vec3[];check:(d:Detail)=>void}[]=[
  {kind:'angle',points:[[2,2,1],[1,2,1],[2/3,3,1]],check:d=>{near(d.value,90);assert.equal(d.unit,'degree');}},
  {kind:'diameter',points:[[1/3,2,1],[2/3,3,1],[5/3,2,1]],check:d=>{near(d.value,4);near(d.details.radius,2);assert.deepEqual(d.details.center,[15.5,-15.75,34]);assert.equal(d.unit,'mm');}},
  {kind:'ellipse',points:[[0,2,1],[2,2,1],[2/3,3,1]],check:d=>{
    near(d.details.D1,6);near(d.details.D2,4);near(d.details.E,Math.sqrt(5)/3);near(d.value,6*Math.PI);near(d.details.A,6*Math.PI);
    // Independent complete-ellipse binomial h-series evaluated to 20 terms.
    near(d.details.P,15.86543958929059);near(d.details.DP,5.050126269922894);near(d.details.DA,2*Math.sqrt(6));assert.equal(d.unit,'mm²');
  }},
  {kind:'area',points:[[2/3,0,1],[8/3,0,1],[2,2,1],[0,2,1]],check:d=>{
    near(d.value,24);near(d.details.area,24);near(d.details.perimeter,20);assert.deepEqual(d.details.centroid,[15.5,-17.75,34]);near(d.details.Da,2*Math.sqrt(24/Math.PI));near(d.details.Dp,20/Math.PI);near(d.details.Lmax,Math.sqrt(52));near(d.details.L,4*Math.sqrt(13)/3);assert.equal(d.unit,'mm²');
  }},
];
for(const item of cases)test(`controller ${item.kind} uses full affine geometry and exposes the documented structured values`,async()=>withEditor(async editor=>{
  const before=sources(editor),revision=editor.revision.value;const m=await create(editor,item.kind,item.points);assert.deepEqual(m.plane,{axis:2,index:1});item.check(detail(editor,m.id));assert.equal(editor.revision.value,revision+1);assertSources(editor,before);
  editor.undo();assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.undoName.value,'');editor.undo(true);item.check(detail(editor,m.id));assertSources(editor,before);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));

test('Cancel discards incomplete geometric measurements, and area remains a single-slice contour',async()=>withEditor(async editor=>{
  const before=editor.state.value,revision=editor.revision.value;editor.tool.value='angle';await nextTick();await editor.imagePick([2,2,1],2,1);await editor.imagePick([1,2,1],2,1);assert.equal(editor.state.value.measurements.length,0);editor.cancel();await editor.finishDrawing();assert.ok(editor.state.value===before);assert.equal(editor.revision.value,revision);assert.equal(editor.dirty.value,false);
  editor.tool.value='area';await nextTick();await editor.imagePick([0,0,1],2,1);await editor.imagePick([2,0,1],2,1);await editor.imagePick([2,2,2],2,2);await editor.finishDrawing();assert.equal(editor.state.value.measurements.length,0);assert.equal(editor.revision.value,revision);editor.cancel();assert.equal(editor.draftPoints.value.length,0);
}));

test('one area geometry batch updates all four corners in one transaction without changing raw data or metadata references',async()=>withEditor(async editor=>{
  const before=sources(editor),m=await create(editor,'area',cases[3]!.points),old=normal(m),revision=editor.revision.value;
  editor.updateMeasurementGeometry({id:m.id,points:[[12.5,-19.75,34],[15.5,-19.75,34],[15.5,-15.75,34],[12.5,-15.75,34]],plane:{axis:2,index:1}});
  assert.equal(editor.error.value,'');assert.equal(editor.revision.value,revision+1);const d=detail(editor,m.id);near(d.value,12);near(d.details.perimeter,14);assert.deepEqual(d.details.centroid,[14,-17.75,34]);assertSources(editor,before);
  editor.undo();assert.deepEqual(normal(editor.state.value.measurements[0]),old);near(detail(editor,m.id).value,24);editor.undo(true);near(detail(editor,m.id).value,12);assertSources(editor,before);
}));

for(const kind of ['density-rectangle','density-ellipse'] as const)test(`${kind} samples the current slice and geometry batches preserve raw intensities across scrolling and metadata edits`,async()=>withEditor(async(editor,_input,exports)=>{
  const before=sources(editor),revision=editor.revision.value;editor.createDensityROI({kind,plane:{axis:2,index:1},points:[[0,1,1],[2,3,1]]});assert.equal(editor.error.value,'');assert.equal(editor.state.value.measurements.length,1);assert.equal(editor.revision.value,revision+1);const m=editor.state.value.measurements[0]!,ellipse=kind==='density-ellipse';
  let d=detail(editor,m.id);near(d.value,121);assert.equal(d.unit,'GV');assert.equal(d.details.count,ellipse?5:9);near(d.details.std,Math.sqrt(202/(ellipse?5:3)));near(d.details.area,ellipse?30:54);near(d.details.sampleArea,ellipse?30:54);near(d.details.geometricArea,ellipse?6*Math.PI:24);near(d.details.min,ellipse?111:110);near(d.details.max,ellipse?131:132);
  await editor.saveProject();assert.ok(exports.at(-1));assert.equal(editor.dirty.value,false);const savedState=editor.state.value,savedRevision=editor.revision.value,undo=editor.undoName.value,oldLabel=editor.measurementLabels.value[m.id],rawPoints=normal(m.points);editor.point.value=[1,2,2];await nextTick();
  assert.ok(editor.state.value===savedState);assert.equal(editor.revision.value,savedRevision);assert.equal(editor.undoName.value,undo);assert.equal(editor.dirty.value,false);assert.deepEqual(normal(editor.state.value.measurements[0]!.points),rawPoints);assert.equal(editor.state.value.measurements[0]!.plane!.index,1);
  const shown=editor.displayMeasurements.value.find(item=>item.id===m.id)!;assert.equal(shown.plane!.index,2);assert.deepEqual(shown.points,[[12,-17.5,38],[20,-13.5,38]]);d=detail(editor,m.id);near(d.value,221);assert.notEqual(editor.measurementLabels.value[m.id],oldLabel);assert.ok(editor.measurementLabels.value[m.id]!.includes('221'));
  const geometryRevision=editor.revision.value;editor.updateMeasurementGeometry({id:m.id,points:[[15,-17.5,38],[23,-13.5,38]],plane:{axis:2,index:2}});assert.equal(editor.error.value,'');assert.equal(editor.revision.value,geometryRevision+1);near(detail(editor,m.id).value,222);editor.undo();near(detail(editor,m.id).value,221);editor.undo(true);near(detail(editor,m.id).value,222);
  editor.center.value=-600;editor.width.value=1500;editor.measurementEditor.openEdit(m.id);assert.equal(editor.measurementEditor.apply({name:'Restyled ROI',color:'#abcdef',visible:false}),true);near(detail(editor,m.id).value,222);assertSources(editor,before);
}));

test('legacy two-click density creation still commits one ROI and incomplete legacy placement can be cancelled',async()=>withEditor(async editor=>{
  const revision=editor.revision.value;editor.tool.value='density-rectangle';await nextTick();await editor.imagePick([0,1,1],2,1);assert.equal(editor.state.value.measurements.length,0);editor.cancel();await editor.finishDrawing();assert.equal(editor.revision.value,revision);
  await editor.imagePick([0,1,1],2,1);await editor.imagePick([2,3,1],2,1);assert.equal(editor.state.value.measurements.length,1);assert.equal(editor.revision.value,revision+1);near(detail(editor,editor.state.value.measurements[0]!.id).value,121);
}));

test('distance across two Parts preserves each point source through batch geometry, drag, metadata and worker ZIP exchange',async()=>withEditor(async(editor,input,exports)=>{
  const before=sources(editor),a:Vec3=[12.25,-18.875,32],b:Vec3=[15.25,-14.875,32];editor.tool.value='distance';await nextTick();editor.partPick({partId:input.a,position:a});editor.partPick({partId:input.b,position:b});assert.equal(editor.state.value.measurements.length,1);const m=editor.state.value.measurements[0]!;assert.deepEqual(m.points,[a,b]);assert.deepEqual(m.pointPartIds,[input.a,input.b]);assert.equal(m.partId,undefined);assert.equal(m.plane,undefined);near(detail(editor,m.id).value,5);
  const revision=editor.revision.value;editor.updateMeasurementGeometry({id:m.id,points:[a,[21.25,-14.875,32]]});assert.equal(editor.revision.value,revision+1);near(detail(editor,m.id).value,Math.sqrt(97));assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);
  editor.moveMeasurementPoint({id:m.id,index:1,position:[18.25,-12.875,32]});near(detail(editor,m.id).value,Math.sqrt(72));assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);assert.equal(editor.state.value.measurements[0]!.partId,undefined);
  const immutable=editor.state.value,immutableRevision=editor.revision.value;editor.updateMeasurementGeometry({id:m.id,points:editor.state.value.measurements[0]!.points.map(point=>[...point]),pointPartIds:[input.b,input.b],partId:input.b,kind:'angle'} as any);assert.ok(editor.state.value===immutable);assert.equal(editor.revision.value,immutableRevision);assert.equal(editor.state.value.measurements[0]!.kind,'distance');assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);assert.equal(editor.state.value.measurements[0]!.partId,undefined);
  editor.measurementEditor.openEdit(m.id);assert.equal(editor.measurementEditor.apply({name:'Mixed surfaces',color:'#abcdef',visible:false}),true);assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);assertSources(editor,before);
  await editor.saveProject();const restored=decodeProject(exports.at(-1)!);assert.deepEqual(restored.state.measurements[0]!.pointPartIds,[input.a,input.b]);assert.equal(restored.state.measurements[0]!.partId,undefined);near(restored.state.measurements[0]!.points[1]![0],18.25);assert.deepEqual(restored.state.masks.map(mask=>mask.data),before.masks.map(mask=>mask.data));
}));

test('mixed image/Part and cross-slice image distances have no false uniform Part or single-plane attachment',async()=>{
  await withEditor(async(editor,input)=>{editor.tool.value='distance';await nextTick();await editor.imagePick([1,2,1],2,1);editor.partPick({partId:input.b,position:[15.25,-14.875,32]});const m=editor.state.value.measurements[0]!;assert.deepEqual(m.points,[[15.5,-15.75,34],[15.25,-14.875,32]]);assert.deepEqual(m.pointPartIds,[null,input.b]);assert.equal(m.partId,undefined);assert.equal(m.plane,undefined);near(detail(editor,m.id).value,Math.sqrt(4.828125));});
  await withEditor(async editor=>{editor.tool.value='distance';await nextTick();await editor.imagePick([1,2,0],2,0);await editor.imagePick([1,2,1],2,1);const m=editor.state.value.measurements[0]!;assert.equal(m.plane,undefined);assert.equal(m.partId,undefined);assert.deepEqual(m.pointPartIds,[null,null]);near(detail(editor,m.id).value,Math.sqrt(16.3125));});
});

test('3D ellipse accepts three cross-Part points and exposes six-by-four ellipse values without binding the last Part',async()=>withEditor(async(editor,input)=>{
  const before=sources(editor);editor.tool.value='ellipse';await nextTick();editor.partPick({partId:input.a,position:[15.25,-14.875,32]});editor.partPick({partId:input.b,position:[21.25,-14.875,32]});editor.partPick({partId:input.b,position:[18.25,-12.875,32]});assert.equal(editor.state.value.measurements.length,1);const m=editor.state.value.measurements[0]!;assert.deepEqual(m.pointPartIds,[input.a,input.b,input.b]);assert.equal(m.partId,undefined);assert.equal(m.plane,undefined);cases[2]!.check(detail(editor,m.id));assertSources(editor,before);
}));

test('PartToMask uses the actual worker geometry and records its source Part without changing source models or masks',async()=>withEditor(async(editor,input,exports)=>{
  const before=sources(editor),revision=editor.revision.value;editor.selectPart(input.a);await editor.runPart('partToMask');assert.equal(editor.error.value,'');assert.equal(editor.state.value.masks.length,3);const m=editor.activeMask.value!;assert.equal(m.sourcePartId,input.a);assert.deepEqual(m.data,Uint8Array.from({length:60},(_,i)=>Number(i%4>=1&&i%4<=2&&Math.floor(i/4)%5>=1&&Math.floor(i/4)%5<=3&&Math.floor(i/20)===1)));assert.equal(editor.revision.value,revision+1);assert.deepEqual(editor.state.value.parts,before.parts);assert.deepEqual(editor.state.value.masks.slice(0,2),before.masks);
  await editor.saveProject();assert.equal(decodeProject(exports.at(-1)!).state.masks[2]!.sourcePartId,input.a);editor.undo();assert.equal(editor.state.value.masks.length,2);editor.undo(true);assert.equal(editor.activeMask.value!.sourcePartId,input.a);
}));

test('deleting a Part cancels incomplete point-source drafts but preserves committed historical point references',async()=>withEditor(async(editor,input)=>{
  editor.tool.value='distance';await nextTick();editor.partPick({partId:input.a,position:[12.25,-18.875,32]});editor.partPick({partId:input.b,position:[15.25,-14.875,32]});const m=editor.state.value.measurements[0]!,points=normal(m.points);editor.selectPart(input.a);editor.deletePart();assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);assert.deepEqual(normal(editor.state.value.measurements[0]!.points),points);near(detail(editor,m.id).value,5);
  editor.tool.value='angle';await nextTick();editor.partPick({partId:input.b,position:[15.25,-14.875,32]});assert.equal(editor.draftPoints.value.length,1);editor.selectPart(input.b);editor.deletePart();await nextTick();assert.equal(editor.draftPoints.value.length,0);assert.equal(editor.state.value.measurements.length,1);assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[input.a,input.b]);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));

test('single-plane density creation and geometry updates reject cross-plane or zero-size input atomically',async()=>withEditor(async editor=>{
  const m=await create(editor,'area',cases[3]!.points),before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value;
  const noCommit=()=>{assert.ok(editor.state.value===before);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.state.value.measurements.length,1);};
  editor.updateMeasurementGeometry({id:m.id,points:[[12.5,-19.75,34],[18.5,-19.75,35],[18.5,-15.75,34],[12.5,-15.75,34]],plane:{axis:2,index:1}});assert.ok(editor.error.value);noCommit();
  editor.createDensityROI({kind:'density-rectangle',plane:{axis:2,index:1},points:[[0,1,1],[2,3,2]]});assert.ok(editor.error.value);noCommit();
  editor.createDensityROI({kind:'density-ellipse',plane:{axis:2,index:1},points:[[1,1,1],[1,3,1]]});assert.ok(editor.error.value);noCommit();
  assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));

test('stale revision and old-document geometry gestures cannot publish into a reopened project with the same measurement ID',async()=>withEditor(async(editor,input,exports)=>{
  editor.createDensityROI({kind:'density-rectangle',plane:{axis:2,index:1},points:[[0,1,1],[2,3,1]]});const m=editor.state.value.measurements[0]!,oldVolume=editor.volume.value!,oldRevision=editor.revision.value;
  editor.updatePart(input.b,{name:'renamed during gesture'});const afterRename=editor.state.value,revision=editor.revision.value;editor.updateMeasurementGeometry({id:m.id,points:[[14.5,-17.75,34],[22.5,-13.75,34]],plane:{axis:2,index:1},volume:oldVolume,revision:oldRevision} as any);assert.ok(editor.state.value===afterRename);assert.equal(editor.revision.value,revision);
  editor.createDensityROI({kind:'density-ellipse',plane:{axis:2,index:1},points:[[0,1,1],[2,3,1]],volume:oldVolume,revision:oldRevision} as any);assert.ok(editor.state.value===afterRename);
  await editor.saveProject();const beforeInstallVolume=editor.volume.value!,beforeInstallRevision=editor.revision.value;await editor.openFiles([new File([exports.at(-1)!.slice().buffer as ArrayBuffer],'same-ids-reopened.deepmark.zip')]);assert.ok(editor.volume.value!==beforeInstallVolume);assert.ok(editor.state.value.measurements.some(item=>item.id===m.id));const reopened=editor.state.value,reopenedRevision=editor.revision.value;
  editor.updateMeasurementGeometry({id:m.id,points:[[14.5,-17.75,34],[22.5,-13.75,34]],plane:{axis:2,index:1},volume:beforeInstallVolume,revision:beforeInstallRevision} as any);assert.ok(editor.state.value===reopened);assert.equal(editor.revision.value,reopenedRevision);near(detail(editor,m.id).value,121);assert.equal(editor.dirty.value,false);
}));

test('area point insertion/removal is a single image-plane transaction and resizes only null point provenance',async()=>withEditor(async editor=>{
  const m=await create(editor,'area',cases[3]!.points),revision=editor.revision.value,original=normal(m);editor.updateMeasurementGeometry({id:m.id,points:[[12.5,-19.75,34],[18.5,-19.75,34],[18.5,-15.75,34]],plane:{axis:2,index:1}});
  assert.equal(editor.error.value,'');assert.equal(editor.revision.value,revision+1);const triangle=editor.state.value.measurements[0]!;assert.equal(triangle.points.length,3);assert.deepEqual(triangle.pointPartIds,[null,null,null]);near(detail(editor,m.id).value,12);near(detail(editor,m.id).details.perimeter,10+Math.sqrt(52));
  editor.undo();assert.deepEqual(normal(editor.state.value.measurements[0]),original);editor.undo(true);assert.equal(editor.state.value.measurements[0]!.points.length,3);assert.deepEqual(editor.state.value.measurements[0]!.pointPartIds,[null,null,null]);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));

test('slice changes reject old UI density and image-point payloads even when volume and revision are unchanged, while explicit program APIs remain compatible',async()=>withEditor(async editor=>{
  editor.createDensityROI({kind:'density-rectangle',plane:{axis:2,index:1},points:[[0,1,1],[2,3,1]]});const roi=editor.state.value.measurements[0]!;
  const distance=await create(editor,'distance',[[0,1,1],[2,1,1]]);near(detail(editor,distance.id).value,6);await editor.saveProject();assert.equal(editor.dirty.value,false);
  const volume=editor.volume.value!,revision=editor.revision.value,plane:SlicePlane={axis:2,index:1};
  const oldCreate={kind:'density-ellipse' as const,plane,points:[[0,1,1],[2,3,1]] as [Vec3,Vec3],volume,revision};
  const oldUpdate={id:roi.id,points:[[14.5,-17.75,34],[22.5,-13.75,34]] as Vec3[],plane,volume,revision};
  const oldMove={id:distance.id,index:1,position:[20.5,-17.75,34] as Vec3,plane,volume,revision};
  const before=editor.state.value,undo=editor.undoName.value,status=editor.status.value,error=editor.error.value;editor.point.value=[1,2,2];await nextTick();assert.ok(editor.volume.value===volume);assert.equal(editor.revision.value,revision);
  editor.createDensityROI(oldCreate as any);editor.updateMeasurementGeometry(oldUpdate as any);editor.moveMeasurementPoint(oldMove as any);
  assert.ok(editor.state.value===before,'old slice payloads cannot create or change committed objects');assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.dirty.value,false);assert.equal(editor.status.value,status);assert.equal(editor.error.value,error);assert.deepEqual(editor.point.value,[1,2,2]);near(detail(editor,roi.id).value,221);near(detail(editor,distance.id).value,6);
  editor.createDensityROI({kind:oldCreate.kind,plane,points:oldCreate.points});assert.equal(editor.state.value.measurements.length,3,'unsnapshotted explicit creation can intentionally address a noncurrent legal slice');assert.equal(editor.state.value.measurements[2]!.plane!.index,1);
  editor.updateMeasurementGeometry({id:roi.id,points:oldUpdate.points,plane});assert.equal(editor.state.value.measurements[0]!.plane!.index,1);near(detail(editor,roi.id).value,222);
  editor.moveMeasurementPoint({id:distance.id,index:1,position:oldMove.position});near(detail(editor,distance.id).value,9);assert.equal(editor.revision.value,revision+3);
  editor.createDensityROI({kind:'density-rectangle',plane:{axis:2,index:2},points:[[0,1,2],[2,3,2]],volume:editor.volume.value,revision:editor.revision.value} as any);assert.equal(editor.state.value.measurements.length,4,'a fresh current-plane UI snapshot remains usable');assert.equal(editor.revision.value,revision+4);assert.doesNotThrow(()=>validateProject(editor.volume.value!,editor.state.value));
}));
