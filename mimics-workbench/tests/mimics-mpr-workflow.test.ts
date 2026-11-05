import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addMask,createProject,decodeProject,encodeProject,validateProject} from '../src/mimics/project.ts';
import {sampleMprSlice} from '../src/mimics/mpr.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import type {MprPlane,Vec3} from '../src/mimics/types.ts';

// Real workbench, production worker operations and ZIP exchange. Inputs represent
// explicit world hits; browser drawing/picking and native Mimics are outside scope.
const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
type Editor=ReturnType<typeof useWorkbench>;
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));
const close=(actual:number,expected:number,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const closePoint=(actual:Vec3,expected:Vec3)=>actual.forEach((n,a)=>close(n,expected[a]!));

// Independent fixture geometry: reflection, shear, anisotropy and translation.
// Closed forms below do not call production affine/MPR/measurement helpers.
const world=(i:number,j:number,k:number):Vec3=>[10-2*i+.5*j+.25*k,-20+3*j+.5*k,30+4*k];
const field=([x,y,z]:Vec3)=>2*x-3*y+.5*z+7;
function inverseFixture([x,y,z]:Vec3):Vec3{const k=(z-30)/4,j=(y+20-.5*k)/3;return[(10+.5*j+.25*k-x)/2,j,k];}
const basePlane=():MprPlane=>({origin:world(3,2,1.25),u:[.5,0,0],v:[0,.75,0],size:[5,4]});
const at=(p:MprPlane,x:number,y:number):Vec3=>[p.origin[0]+p.u[0]*x+p.v[0]*y,p.origin[1]+p.u[1]*x+p.v[1]*y,p.origin[2]+p.u[2]*x+p.v[2]*y];
const rectPixels:[number,number][]=[[1,1],[2,1],[3,1],[1,2],[2,2],[3,2]];
const ellipsePixels:[number,number][]=[[2,0],[1,1],[2,1],[3,1],[1,2],[2,2],[3,2],[2,3]];
function oracle(p:MprPlane,pixels:[number,number][],interpolation:'linear'|'nearest'='linear'){
  const values=pixels.map(([x,y])=>{const q=at(p,x,y);if(interpolation==='linear')return field(q);const [i,j,k]=inverseFixture(q).map(Math.round);return 102-4*i!-8*j!+k!;});
  const mean=values.reduce((sum,n)=>sum+n,0)/values.length,std=Math.sqrt(values.reduce((sum,n)=>sum+(n-mean)**2,0)/values.length);return{mean,std,min:Math.min(...values),max:Math.max(...values)};
}
function fixture(){
  const dims:Vec3=[7,7,5],bytes=new Uint8Array(352+7*7*5*4),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);dims.forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,[2,Math.hypot(.5,3),Math.hypot(.25,.5,4)][a]!,true);});h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setInt16(254,1,true);h.setUint8(123,2);
  [[-2,.5,.25,10],[0,3,.5,-20],[0,0,4,30]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n,true)));bytes.set([110,43,49,0],344);
  for(let k=0;k<5;k++)for(let j=0;j<7;j++)for(let i=0;i<7;i++)h.setFloat32(352+4*(i+7*(j+7*k)),field(world(i,j,k)),true);
  const volume=parseNifti(bytes.buffer,'mpr-full-affine-linear.nii');let state=createProject(volume);
  state={...state,masks:state.masks.map(mask=>({...mask,name:'Parity',data:Uint8Array.from({length:245},(_,n)=>{const i=n%7,j=Math.floor(n/7)%7,k=Math.floor(n/49);return Number((i+j+k)%2===0);})}))};
  state=addMask(state,245,'Independent overlap',Uint8Array.from({length:245},(_,n)=>Number(n%7===3)));
  state.viewState={point:[3,2,1],activeAxis:2,tool:'navigate',tab:'measurements'};return{volume,state};
}
async function withEditor(run:(editor:Editor,exports:Uint8Array[])=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),exports:Uint8Array[]=[],editor=scope.run(()=>useWorkbench({repository:null,saveFile:async request=>{exports.push((await request.produce()).slice());return{status:'written',name:request.name};}}))!,input=fixture();editor.params.thresholdAutoPreview=false;
  try{assert.equal(await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'mpr-fixture.zip')]),true);await nextTick();assert.ok(editor.mpr);await run(editor,exports);}
  finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function sourceSnapshot(e:Editor){return{volume:e.volume.value!,data:e.volume.value!.data.slice(),header:e.volume.value!.header.slice(),affine:normal(e.volume.value!.affine),masks:e.state.value.masks.map(m=>({...m,data:m.data.slice()})),point:[...e.point.value]};}
function assertSource(e:Editor,before:ReturnType<typeof sourceSnapshot>,samePoint=true){assert.equal(e.volume.value,before.volume);assert.deepEqual(e.volume.value!.data,before.data);assert.deepEqual(e.volume.value!.header,before.header);assert.deepEqual(e.volume.value!.affine,before.affine);assert.deepEqual(e.state.value.masks,before.masks);if(samePoint)assert.deepEqual(e.point.value,before.point);}
const epoch=(e:Editor,p=e.mpr.plane.value!)=>({mprPlane:p,mprRevision:e.mpr.poseRevision.value,volume:e.volume.value!,revision:e.revision.value});
function createDistance(e:Editor){e.tool.value='distance';const p=e.mpr.plane.value!,start=at(p,1,1),end=at(p,3,1);assert.equal(e.mpr.pick({...epoch(e),position:start}),true);assert.equal(e.mpr.draftPoints.value.length,1);closePoint(e.mpr.draftPoints.value[0]!,start);assert.deepEqual(e.mpr.draftPlane.value,p);assert.equal(e.mpr.pick({...epoch(e),position:end}),true);return e.state.value.measurements.at(-1)!;}
function assertStats(e:Editor,id:string,p:MprPlane,pixels=rectPixels,interpolation:'linear'|'nearest'='linear'){
  const result=e.measurementDetails(id),expected=oracle(p,pixels,interpolation);assert.equal(result.valid,true);assert.equal(result.unit,'GV');assert.equal(result.details.count,pixels.length);close(result.value,expected.mean);close(Number(result.details.std),expected.std);close(Number(result.details.min),expected.min);close(Number(result.details.max),expected.max);
}

test('real MPR sampling uses the full source affine and world-linear oracle while masks remain independent nearest samples',async()=>withEditor(async e=>{
  const source=sourceSnapshot(e),before=e.state.value,revision=e.revision.value;assert.equal(e.mpr.setPlane(basePlane()),true);const p=e.mpr.plane.value!;
  for(const interpolation of ['linear','nearest'] as const){
    e.mpr.setInterpolation(interpolation);const slice=sampleMprSlice(e.grid.value!,p,e.state.value.masks,{interpolation});
    assert.equal(slice.gray.length,20);assert.equal(slice.masks.length,2);
    for(let y=0;y<4;y++)for(let x=0;x<5;x++){
      const n=x+5*y,q=at(p,x,y),[i,j,k]=inverseFixture(q).map(Math.round);assert.equal(slice.valid[n],1);assert.equal(slice.support[n],1);close(slice.gray[n]!,interpolation==='linear'?field(q):102-4*i!-8*j!+k!);
      assert.equal(slice.masks[0]!.data[n],Number((i!+j!+k!)%2===0),`Mask parity at ${interpolation} pixel (${x},${y}), world ${q}, voxel ${[i,j,k]}`);assert.equal(slice.masks[1]!.data[n],Number(i===3),`Mask overlap at ${interpolation} pixel (${x},${y})`);
    }
    assert.notEqual(slice.masks[0]!.data,slice.masks[1]!.data);
  }
  assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');assertSource(e,source);
  e.params.lower=65;e.params.upper=72;await e.thresholdPreview();assert.equal(e.error.value,'');assert.ok(e.preview.value);
  e.volume.value!.data.forEach((n,i)=>assert.equal(e.preview.value![i],Number(n>=65&&n<=72)));assertSource(e,source);assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.dirty.value,false);
}));

test('density ROI samples the current MPR slice and active interpolation without changing raw geometry, source, history or clean state on scroll',async()=>withEditor(async(e,exports)=>{
  const source=sourceSnapshot(e);e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!;const distance=createDistance(e),ordinary=normal(distance);
  assert.equal(e.mpr.createDensityROI({kind:'density-rectangle',points:[at(p,.25,.25),at(p,3.75,2.75)],...epoch(e)}),true);const roi=e.state.value.measurements.at(-1)!,stored=normal(roi);assertStats(e,roi.id,p);
  assert.equal(e.mpr.createDensityROI({kind:'density-ellipse',points:[at(p,0,0),at(p,4,3)],...epoch(e)}),true);const ellipse=e.state.value.measurements.at(-1)!;assertStats(e,ellipse.id,p,ellipsePixels);
  await e.saveProject();assert.ok(exports.length);assert.equal(e.dirty.value,false);const before=e.state.value,revision=e.revision.value,undo=e.undoName.value,redo=e.redoName.value;
  assert.equal(e.mpr.scroll({distanceMm:1,plane:p}),true);const current=e.mpr.plane.value!;close(current.origin[2],p.origin[2]+1);assertStats(e,roi.id,current);assertStats(e,ellipse.id,current,ellipsePixels);
  assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.redoName.value,redo);assert.equal(e.dirty.value,false);assert.deepEqual(normal(e.state.value.measurements.find(m=>m.id===roi.id)),stored);assert.deepEqual(normal(e.displayMeasurements.value.find(m=>m.id===distance.id)),ordinary);
  const shown=e.displayMeasurements.value.find(m=>m.id===roi.id)!;assert.deepEqual(shown.mprPlane,current);shown.points.forEach((q,i)=>closePoint(q,[roi.points[i]![0],roi.points[i]![1],roi.points[i]![2]+1]));
  e.mpr.setInterpolation('nearest');assertStats(e,roi.id,current,rectPixels,'nearest');assertStats(e,ellipse.id,current,ellipsePixels,'nearest');assert.notEqual(e.measurementDetails(roi.id).value,oracle(current,rectPixels).mean);assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.dirty.value,false);assertSource(e,source);
}));

test('MPR world-point creation, previews, geometry release and Undo/Redo retain the plane and independent label offset',async()=>withEditor(async e=>{
  const source=sourceSnapshot(e);e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!,revision=e.revision.value,distance=createDistance(e);assert.equal(distance.plane,undefined);assert.deepEqual(distance.mprPlane,p);close(e.measurementDetails(distance.id).value,1);assert.equal(e.revision.value,revision+1);assert.deepEqual(distance.pointPartIds,[null,null]);
  const changed=[at(p,0,1),at(p,4,1)],before=e.state.value,epochBefore=epoch(e);
  assert.equal(e.mpr.previewMeasurementGeometry({id:distance.id,points:changed,...epochBefore}),true);close(e.measurementDetails(distance.id).value,2);assert.equal(e.state.value,before);assert.equal(e.revision.value,epochBefore.revision);assert.equal(e.measurementDetails(distance.id).preview,true);
  assert.equal(e.mpr.updateMeasurementGeometry({id:distance.id,points:changed,...epochBefore}),true);assert.equal(e.measurementPreview.value,null);close(e.measurementDetails(distance.id).value,2);assert.equal(e.revision.value,epochBefore.revision+1);
  const geometric=e.state.value.measurements.at(-1)!;assert.equal(e.mpr.updateMeasurementLabel({id:distance.id,offset:[.125,-.25,.5],...epoch(e)}),true);assert.deepEqual(e.state.value.measurements.at(-1)!.points,geometric.points);assert.deepEqual(e.state.value.measurements.at(-1)!.labelOffset,[.125,-.25,.5]);
  e.undo();assert.equal(e.state.value.measurements.at(-1)!.labelOffset,undefined);close(e.measurementDetails(distance.id).value,2);e.undo();assert.deepEqual(e.state.value.measurements.at(-1),distance);e.undo();assert.equal(e.state.value.measurements.length,0);
  e.undo(true);e.undo(true);e.undo(true);assert.deepEqual(e.state.value.measurements.at(-1)!.labelOffset,[.125,-.25,.5]);close(e.measurementDetails(distance.id).value,2);assertSource(e,source);validateProject(e.volume.value!,e.state.value);
}));

test('Part world events can preview and edit an MPR ellipse on its stored plane after closing MPR while explicit pane events reject',async()=>withEditor(async e=>{
  const source=sourceSnapshot(e);e.mpr.setPlane(basePlane());e.tool.value='ellipse';const p=e.mpr.plane.value!;
  for(const position of [at(p,0,1.5),at(p,4,1.5),at(p,2,2.5)])assert.equal(e.mpr.pick({position,...epoch(e)}),true);
  const original=e.state.value.measurements.at(-1)!;assert.equal(original.kind,'ellipse');assert.deepEqual(original.mprPlane,p);assert.equal(original.plane,undefined);close(e.measurementDetails(original.id).value,.75*Math.PI);
  await e.saveProject();const paneEvent=epoch(e),revision=e.revision.value,undo=e.undoName.value;e.mpr.close();assert.equal(e.mpr.enabled.value,false);assert.equal(e.revision.value,revision);assert.equal(e.dirty.value,false);
  const before=e.state.value,points=[at(p,0,1),at(p,4,1),at(p,2,2.25)],labelOffset:Vec3=[.125,-.25,.5];
  // An explicit MPR context must still name an active current pane. Merely
  // refreshing its epoch while the pane is closed cannot make the event valid.
  for(const context of [paneEvent,{...paneEvent,mprRevision:e.mpr.poseRevision.value}]){
    assert.equal(e.previewMeasurementGeometry({id:original.id,points,...context}),false);assert.equal(e.updateMeasurementGeometry({id:original.id,points,...context}),false);assert.equal(e.updateMeasurementLabel({id:original.id,offset:labelOffset,...context}),false);
  }
  assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.measurementPreview.value,null);assert.equal(e.dirty.value,false);
  // PartViewport sends only document identity/epoch, so the controller uses the
  // object's own stored physical plane rather than requiring an open MPR view.
  const worldEvent={volume:e.volume.value!,revision:e.revision.value};
  const offPlane=points.map(q=>[q[0],q[1],q[2]+.5] as Vec3);assert.equal(e.previewMeasurementGeometry({id:original.id,points:offPlane,...worldEvent}),false);assert.equal(e.updateMeasurementGeometry({id:original.id,points:offPlane,...worldEvent}),false);
  assert.equal(e.previewMeasurementGeometry({id:original.id,points,...worldEvent}),true);assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.dirty.value,false);assert.deepEqual(e.measurementPreview.value!.mprPlane,original.mprPlane);close(e.measurementDetails(original.id).value,.9375*Math.PI);assertSource(e,source);
  assert.equal(e.updateMeasurementGeometry({id:original.id,points,...worldEvent}),true);const edited=e.state.value.measurements.at(-1)!;assert.equal(e.revision.value,revision+1);assert.equal(e.measurementPreview.value,null);assert.deepEqual(edited.points,points);assert.deepEqual(edited.mprPlane,original.mprPlane);assert.deepEqual(edited.pointPartIds,original.pointPartIds);assert.equal(e.mpr.enabled.value,false);assert.equal(e.updateMeasurementGeometry({id:original.id,points,volume:e.volume.value!,revision:e.revision.value}),false);assert.equal(e.revision.value,revision+1);close(e.measurementDetails(original.id).value,.9375*Math.PI);
  assert.equal(e.updateMeasurementLabel({id:original.id,offset:labelOffset,volume:e.volume.value!,revision:e.revision.value}),true);const labeled=e.state.value.measurements.at(-1)!;assert.equal(e.revision.value,revision+2);assert.deepEqual(labeled.points,edited.points);assert.deepEqual(labeled.mprPlane,original.mprPlane);assert.deepEqual(labeled.labelOffset,labelOffset);assert.equal(e.updateMeasurementLabel({id:original.id,offset:labelOffset,volume:e.volume.value!,revision:e.revision.value}),false);assert.equal(e.revision.value,revision+2);
  e.undo();assert.deepEqual(e.state.value.measurements.at(-1),edited);e.undo();assert.deepEqual(e.state.value.measurements.at(-1),original);e.undo(true);e.undo(true);assert.deepEqual(e.state.value.measurements.at(-1),labeled);assert.equal(e.mpr.enabled.value,false);assertSource(e,source);validateProject(e.volume.value!,e.state.value);
}));

test('MPR density geometry release uses the displayed scrolled frame and remains one atomic reversible edit',async()=>withEditor(async e=>{
  const source=sourceSnapshot(e);e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!;assert.equal(e.mpr.createDensityROI({kind:'density-rectangle',points:[at(p,.25,.25),at(p,3.75,2.75)],...epoch(e)}),true);const original=e.state.value.measurements.at(-1)!;
  e.mpr.scroll({distanceMm:1,plane:p});const current=e.mpr.plane.value!,revision=e.revision.value;
  e.mpr.moveMeasurementPoint({id:original.id,index:1,position:at(current,2.75,2.75),...epoch(e)});
  assert.equal(e.revision.value,revision+1);const edited=e.state.value.measurements.at(-1)!;assert.deepEqual(edited.mprPlane,current);closePoint(edited.points[0]!,at(current,.25,.25));closePoint(edited.points[1]!,at(current,2.75,2.75));assertStats(e,edited.id,current,[[1,1],[2,1],[1,2],[2,2]]);
  e.undo();assert.deepEqual(e.state.value.measurements.at(-1),original);assertStats(e,original.id,current);e.undo(true);assert.deepEqual(e.state.value.measurements.at(-1),edited);assertSource(e,source);
}));

test('density label relocation on a scrolled MPR frame preserves the stored ROI and changes only its world offset',async()=>withEditor(async e=>{
  e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!;e.mpr.createDensityROI({kind:'density-rectangle',points:[at(p,.25,.25),at(p,3.75,2.75)],...epoch(e)});const original=e.state.value.measurements.at(-1)!;
  e.mpr.scroll({distanceMm:1,plane:p});const revision=e.revision.value,source=sourceSnapshot(e);
  assert.equal(e.mpr.updateMeasurementLabel({id:original.id,offset:[.2,-.4,.1],...epoch(e)}),true);const moved=e.state.value.measurements.at(-1)!;assert.equal(e.revision.value,revision+1);assert.deepEqual(moved.points,original.points);assert.deepEqual(moved.mprPlane,original.mprPlane);assert.deepEqual(moved.labelOffset,[.2,-.4,.1]);assertStats(e,original.id,e.mpr.plane.value!);
  e.undo();assert.deepEqual(e.state.value.measurements.at(-1),original);e.undo(true);assert.deepEqual(e.state.value.measurements.at(-1)!.labelOffset,[.2,-.4,.1]);assertSource(e,source);
}));

test('pose epochs reject stale picks, ROI releases, previews, geometry and label edits after returning to identical plane coordinates',async()=>withEditor(async e=>{
  e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!,distance=createDistance(e),old=epoch(e);e.mpr.scroll({distanceMm:1,plane:p});assert.equal(e.mpr.setPlane(p),true);assert.deepEqual(e.mpr.plane.value,p);assert.notEqual(e.mpr.poseRevision.value,old.mprRevision);assert.equal(e.revision.value,old.revision);
  const before=e.state.value,source=sourceSnapshot(e),revision=e.revision.value,undo=e.undoName.value;
  assert.equal(e.mpr.pick({position:at(p,2,2),...old}),false);assert.equal(e.mpr.createDensityROI({kind:'density-rectangle',points:[at(p,0,0),at(p,3,2)],...old}),false);assert.equal(e.mpr.previewMeasurementGeometry({id:distance.id,points:[at(p,0,1),at(p,4,1)],...old}),false);assert.equal(e.mpr.updateMeasurementGeometry({id:distance.id,points:[at(p,0,1),at(p,4,1)],...old}),false);assert.equal(e.mpr.updateMeasurementLabel({id:distance.id,offset:[1,2,3],...old}),false);
  assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.mpr.draftPoints.value.length,0);assert.equal(e.measurementPreview.value,null);assertSource(e,source);
}));

test('successful three-point definition adds one reversible RP while cancellation, world crosshair and source synchronization preserve source geometry',async()=>withEditor(async e=>{
  const source=sourceSnapshot(e),before=e.state.value,revision=e.revision.value;e.mpr.setPlane(basePlane());const old=normal(e.mpr.plane.value);assert.equal(e.mpr.beginDefinition(),true);assert.equal(e.tool.value,'mpr-plane');assert.equal(e.mpr.addDefinitionPoint([0,0,0]),true);assert.equal(e.mpr.addDefinitionPoint([1,1,1]),true);assert.equal(e.mpr.addDefinitionPoint([2,2,2]),false);assert.match(e.error.value,/共线/);assert.deepEqual(normal(e.mpr.plane.value),old);assert.equal(e.mpr.definitionPoints.value.length,2);e.cancel();assert.equal(e.mpr.defining.value,false);assert.equal(e.mpr.definitionPoints.value.length,0);
  assert.equal(e.state.value,before);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,'');assert.equal(e.dirty.value,false);assertSource(e,source);
  assert.equal(e.mpr.beginDefinition(),true);for(const q of [world(1,1,1),world(3,1,1),world(1,3,1)])assert.equal(e.mpr.addDefinitionPoint(q),true);assert.equal(e.mpr.defining.value,false);assert.equal(e.mpr.definitionPoints.value.length,0);assert.equal(e.tool.value,'navigate');assert.ok(e.mpr.plane.value);
  assert.equal(e.state.value.resliceObjects?.length,1);const created=e.state.value.resliceObjects![0]!,createdUndo=e.undoName.value;assert.equal(created.kind,'plane');assert.equal(e.state.value.selectedResliceId,created.id);assert.deepEqual(created.plane,e.mpr.plane.value);assert.equal(e.revision.value,revision+1);assert.ok(createdUndo);assert.equal(e.dirty.value,true);assert.deepEqual(e.state.value.measurements,before.measurements);assertSource(e,source);
  e.undo();assert.deepEqual(normal(e.state.value),normal(before));assert.equal(e.undoName.value,'');assertSource(e,source);e.undo(true);assert.deepEqual(e.state.value.resliceObjects,[created]);assert.equal(e.state.value.selectedResliceId,created.id);assert.equal(e.undoName.value,createdUndo);assertSource(e,source);
  await e.saveProject();assert.equal(e.dirty.value,false);const viewRevision=e.revision.value;
  e.mpr.setPlane(basePlane());e.tool.value='distance';assert.equal(e.mpr.pick({position:at(e.mpr.plane.value!,1,1),...epoch(e)}),true);assert.equal(e.mpr.draftPoints.value.length,1);e.mpr.scroll({distanceMm:1,plane:e.mpr.plane.value!});assert.equal(e.mpr.draftPoints.value.length,0);assert.equal(e.mpr.draftPlane.value,null);
  const crosshair=world(-10.125,2.875,20.25);assert.equal(e.mpr.locate(crosshair),true);assert.deepEqual(e.mpr.crosshair.value,crosshair);assertSource(e,source);assert.equal(e.mpr.syncToSource(),true);assert.deepEqual(e.point.value,[0,3,4]);assertSource(e,source,false);assert.equal(e.revision.value,viewRevision);assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,createdUndo);assert.deepEqual(e.state.value.resliceObjects,[created]);assert.deepEqual(e.state.value.measurements,before.measurements);
}));

test('real worker ZIP export and install restore exact MPR pose, density results, geometry and labels while replacing stale document epochs',async()=>withEditor(async(e,exports)=>{
  e.mpr.setPlane(basePlane());const p=e.mpr.plane.value!,distance=createDistance(e);e.mpr.updateMeasurementLabel({id:distance.id,offset:[.25,-.125,.5],...epoch(e)});e.mpr.createDensityROI({kind:'density-rectangle',points:[at(p,.25,.25),at(p,3.75,2.75)],...epoch(e)});const roi=e.state.value.measurements.at(-1)!;e.mpr.scroll({distanceMm:1,plane:p});e.mpr.setInterpolation('nearest');e.mpr.setStep(.625);const crosshair=world(2.125,1.875,2.25);e.mpr.locate(crosshair);const pose=normal(e.mpr.snapshot()),expected=normal(e.state.value.measurements),source=sourceSnapshot(e),stale=epoch(e),result=e.measurementDetails(roi.id);
  assert.equal((await e.saveProject())?.status,'written');assert.equal(e.dirty.value,false);const archive=exports.at(-1)!,restored=decodeProject(archive);assert.deepEqual(normal(restored.state.viewState!.mpr),pose);assert.deepEqual(normal(restored.state.measurements),expected);assert.deepEqual(restored.volume.header,source.header);assert.deepEqual(restored.volume.affine,source.affine);assert.deepEqual(restored.volume.data,source.data);assert.deepEqual(restored.state.masks,source.masks);
  assert.equal(await e.openFiles([new File([archive.slice().buffer as ArrayBuffer],'mpr-restored.zip')]),true);assert.deepEqual(normal(e.mpr.snapshot()),pose);assert.deepEqual(normal(e.state.value.measurements),expected);assert.deepEqual(e.mpr.crosshair.value,crosshair);close(e.measurementDetails(roi.id).value,result.value);assert.equal(e.measurementDetails(roi.id).details.count,result.details.count);assert.equal(e.undoName.value,'');assert.equal(e.redoName.value,'');assert.equal(e.dirty.value,false);assert.notEqual(e.volume.value,stale.volume);assert.notEqual(e.mpr.poseRevision.value,stale.mprRevision);
  assert.equal(e.mpr.createDensityROI({kind:'density-rectangle',points:[at(stale.mprPlane,0,0),at(stale.mprPlane,2,2)],...stale}),false);assert.equal(e.mpr.updateMeasurementLabel({id:distance.id,offset:[9,9,9],...stale}),false);validateProject(e.volume.value!,e.state.value);
}));
