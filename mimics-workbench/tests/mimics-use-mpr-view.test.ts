import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {computed,effectScope,nextTick,ref,shallowRef} from 'vue';
import {parseNifti,type Volume} from '../src/core.ts';
import {createProject,encodeProject} from '../src/mimics/project.ts';
import {useMprView} from '../src/mimics/useMprView.ts';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import {createMprPlane,mprPlaneCenter,mprPlaneNormal,mprPixelToWorld} from '../src/mimics/mpr.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`),point=(a:readonly number[],b:readonly number[])=>{assert.equal(a.length,b.length);a.forEach((v,k)=>near(v,b[k]!));};
function viewHarness(){
  const volume=shallowRef({dims:[4,4,4],spacing:[2,3,4],affine:[[2,1,0,10],[0,3,0,-20],[0,0,-4,50]],data:new Float32Array(64),unit:'mm'} as Volume),sourcePoint=ref<Vec3>([1,1,1]),busy=ref(false),status=ref(''),errors:unknown[]=[],scope=effectScope();let cancels=0;
  const view=scope.run(()=>useMprView({volume,grid:computed(()=>volume.value as VolumeGrid),point:sourcePoint,busy,physicalUnitsKnown:computed(()=>volume.value.unit==='mm'),cancel:()=>{cancels++;},fail:error=>errors.push(error),status}))!;
  return{view,volume,sourcePoint,busy,status,errors,cancels:()=>cancels,close:()=>scope.stop()};
}

test('MPR three-point plane keeps first-to-second axis, positive projected up and the world centroid',()=>{
  const h=viewHarness();try{h.view.resolution.value=[7,9];assert.equal(h.view.beginDefinition(),true);assert.equal(h.view.addDefinitionPoint([10,-20,50]),true);assert.equal(h.view.addDefinitionPoint([14,-20,50]),true);assert.equal(h.view.addDefinitionPoint([11,-17,50]),true);const p=h.view.plane.value!;point(mprPlaneNormal(p),[0,0,1]);near(p.u[1],0);near(p.u[2],0);assert.ok(p.u[0]>0);near(p.v[0],0);near(p.v[2],0);assert.ok(p.v[1]>0);point(mprPlaneCenter(p),[35/3,-19,50]);point(h.view.crosshair.value!,[35/3,-19,50]);assert.deepEqual(h.sourcePoint.value,[1,1,1]);assert.equal(h.view.definitionPoints.value.length,0);assert.equal(h.view.defining.value,false);assert.equal(h.errors.length,0);
  }finally{h.close();}
});

test('MPR duplicate or collinear third definitions retain the first two points for a valid retry',()=>{
  const h=viewHarness();try{h.view.beginDefinition();h.view.addDefinitionPoint([0,0,0]);h.view.addDefinitionPoint([1,0,0]);assert.equal(h.view.addDefinitionPoint([0,0,0]),false);assert.equal(h.view.addDefinitionPoint([2,0,0]),false);assert.deepEqual(h.view.definitionPoints.value,[[0,0,0],[1,0,0]]);assert.equal(h.view.defining.value,true);assert.equal(h.view.plane.value,null);assert.equal(h.view.addDefinitionPoint([0,1,0]),true);point(mprPlaneNormal(h.view.plane.value!),[0,0,1]);assert.equal(h.errors.length,2);
  }finally{h.close();}
});

test('scrolling each orthogonal MPR view addresses its physical normal without moving either saved crosshair',()=>{
  const h=viewHarness();try{const base=createMprPlane({center:[12,-17,46],size:[7,9],pixelSpacing:[.5,.75],angles:[90,0,0]});h.view.setPlane(base);h.view.crosshair.value=[15,-16,45];const crosshair=[...h.view.crosshair.value],source=[...h.sourcePoint.value],origin=[...base.origin];
    assert.equal(h.view.scroll({plane:h.view.planes.value[0]!,distanceMm:2}),true);point(h.view.plane.value!.origin,[origin[0],origin[1]-2,origin[2]]);
    assert.equal(h.view.scroll({plane:h.view.planes.value[1]!,distanceMm:2}),true);point(h.view.plane.value!.origin,[origin[0]+2,origin[1]-2,origin[2]]);
    assert.equal(h.view.scroll({plane:h.view.planes.value[2]!,distanceMm:2}),true);point(h.view.plane.value!.origin,[origin[0]+2,origin[1]-2,origin[2]+2]);point(h.view.plane.value!.u,base.u);point(h.view.plane.value!.v,base.v);point(h.view.crosshair.value!,crosshair);point(h.sourcePoint.value,source);
  }finally{h.close();}
});

test('MPR snapshot restore clones the exact plane and independent crosshair, then explicit source sync uses the full affine',()=>{
  const h=viewHarness();try{const base=createMprPlane({center:[12,-17,46],size:[7,9],pixelSpacing:[.5,.75],angles:[90,0,0]});h.view.setPlane(base);h.view.crosshair.value=[15,-14,42];h.view.setStep(2.5);h.view.setInterpolation('nearest');const snapshot=h.view.snapshot()!,pose=h.view.poseRevision.value;h.view.restore(snapshot);assert.ok(h.view.poseRevision.value>pose);assert.deepEqual(h.view.plane.value,snapshot.plane);assert.notEqual(h.view.plane.value,snapshot.plane);assert.notEqual(h.view.crosshair.value,snapshot.crosshair);assert.deepEqual(h.sourcePoint.value,[1,1,1]);assert.equal(h.view.step.value,2.5);assert.equal(h.view.interpolation.value,'nearest');
    // World (15,-14,42) -> voxel (1.5,2,2), explicitly rounded to (2,2,2).
    assert.equal(h.view.syncToSource(),true);assert.deepEqual(h.sourcePoint.value,[2,2,2]);snapshot.plane.origin[0]=999;snapshot.crosshair![0]=999;assert.notEqual(h.view.plane.value!.origin[0],999);assert.notEqual(h.view.crosshair.value![0],999);
  }finally{h.close();}
});

test('restored oblique MPR orientation survives applying only a changed output resolution',()=>{
  const h=viewHarness();try{const base=createMprPlane({center:[12,-17,46],size:[7,9],pixelSpacing:[.5,.75],angles:[90,0,0]});h.view.restore({enabled:true,plane:base,step:1,interpolation:'linear'});h.view.resolution.value=[11,13];assert.equal(h.view.applyOrientation(),true);point(mprPlaneNormal(h.view.plane.value!),[0,-1,0]);point(mprPlaneCenter(h.view.plane.value!),[12,-17,46]);assert.deepEqual(h.view.plane.value!.size,[11,13]);
  }finally{h.close();}
});

test('MPR restored Euler gimbal cases retain both in-plane axis directions after resolution-only application',()=>{
  const sine=(degrees:number)=>Math.sin(degrees*Math.PI/180),cosine=(degrees:number)=>Math.cos(degrees*Math.PI/180);
  for(const input of [{angles:[10,90,30] as Vec3,u:[0,0,-1],v:[-sine(20),cosine(20),0]},{angles:[10,-90,30] as Vec3,u:[0,0,1],v:[-sine(40),cosine(40),0]}]){
    const h=viewHarness();try{const base=createMprPlane({center:[12,-17,46],size:[7,9],pixelSpacing:[.5,.75],angles:input.angles});h.view.restore({enabled:true,plane:base,step:1,interpolation:'linear'});h.view.resolution.value=[11,13];assert.equal(h.view.applyOrientation(),true);const p=h.view.plane.value!;point(p.u.map(n=>n/Math.hypot(...p.u)),input.u);point(p.v.map(n=>n/Math.hypot(...p.v)),input.v);point(mprPlaneCenter(p),[12,-17,46]);}finally{h.close();}
  }
});

const workers=new Set<NodeWorker>();
class WorkerAdapter{
  onmessage:((event:{data:any})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;worker:NodeWorker;
  constructor(url:URL){const source=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));workers.add(this.worker);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));this.worker.on('exit',()=>workers.delete(this.worker));}
  postMessage(value:unknown){this.worker.postMessage(value);}terminate(){void this.worker.terminate();}
}
function fixture(){
  const bytes=new Uint8Array(352+6*6*4),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[6,6,4].forEach((n,a)=>{h.setInt16(42+2*a,n,true);h.setFloat32(80+4*a,[2,Math.sqrt(10),4][a]!,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);h.setInt16(254,1,true);[[2,1,0,10],[0,3,0,-20],[0,0,-4,50]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+16*r+4*c,n,true)));bytes.set([110,43,49,0],344);
  for(let z=0;z<4;z++)for(let y=0;y<6;y++)for(let x=0;x<6;x++)bytes[352+x+6*(y+6*z)]=5*x+7*y+11*z;
  const volume=parseNifti(bytes.buffer,'mpr-combination.nii');return{volume,state:createProject(volume)};
}
const basePlane=():MprPlane=>({origin:[12,-17,46],u:[1,0,0],v:[0,1,0],size:[4,4]});
async function withEditor(run:(editor:ReturnType<typeof useWorkbench>)=>Promise<void>){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;const scope=effectScope(),editor=scope.run(()=>useWorkbench({repository:null}))!,input=fixture();editor.params.thresholdAutoPreview=false;
  try{await editor.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'mpr-combination.deepmark.zip')]);await nextTick();editor.mpr.setPlane(basePlane());await run(editor);}finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(w=>w.terminate()));}
}
const epoch=(e:ReturnType<typeof useWorkbench>)=>({volume:e.volume.value!,revision:e.revision.value,mprRevision:e.mpr.poseRevision.value});
function addDensity(e:ReturnType<typeof useWorkbench>){const plane=e.mpr.planes.value[0]!;assert.equal(e.mpr.createDensityROI({kind:'density-rectangle',points:[mprPixelToWorld(plane,[0,0]),mprPixelToWorld(plane,[2,2])],mprPlane:plane,...epoch(e)}),true);return e.state.value.measurements.at(-1)!;}

test('controller density scrolling preserves world in-plane geometry and samples the current reflected/sheared physical plane',async()=>withEditor(async e=>{
  const measurement=addDensity(e),source=e.volume.value!.data.slice(),before=JSON.stringify(measurement),revision=e.revision.value,undo=e.undoName.value,sourcePoint=[...e.point.value];near(e.measurementDetails(measurement.id).value,24.5);
  assert.equal(e.mpr.scroll({plane:e.mpr.planes.value[0]!,distanceMm:4}),true);const shown=e.displayMeasurements.value.find(m=>m.id===measurement.id)!;point(shown.points[0]!,[12,-17,50]);point(shown.points[1]!,[14,-15,50]);near(e.measurementDetails(measurement.id).value,13.5);assert.equal(JSON.stringify(e.state.value.measurements.at(-1)!),before);assert.deepEqual(e.volume.value!.data,source);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);point(e.point.value,sourcePoint);
}));

test('controller density labels remain movable on the current MPR slice after non-destructive scrolling',async()=>withEditor(async e=>{
  const measurement=addDensity(e);e.mpr.scroll({plane:e.mpr.planes.value[0]!,distanceMm:4});const shown=e.displayMeasurements.value.find(m=>m.id===measurement.id)!;
  assert.equal(e.updateMeasurementLabel({id:measurement.id,offset:[2,1,0],mprPlane:shown.mprPlane,...epoch(e)}),true);assert.deepEqual(e.state.value.measurements.at(-1)!.labelOffset,[2,1,0]);
}));

test('controller stale MPR scroll payloads cannot alter a new pose or a restored document with an identical plane',async()=>withEditor(async e=>{
  const stale={plane:e.mpr.planes.value[0]!,distanceMm:4,...epoch(e)};e.mpr.setInterpolation('nearest');const before=JSON.stringify(e.mpr.snapshot()),pose=e.mpr.poseRevision.value;assert.equal(e.mpr.scroll(stale as any),false);assert.equal(JSON.stringify(e.mpr.snapshot()),before);assert.equal(e.mpr.poseRevision.value,pose);
  const input=fixture();input.state.viewState={mpr:{enabled:true,plane:basePlane(),step:1,interpolation:'linear'}};await e.openFiles([new File([encodeProject(input.volume,input.state).slice().buffer as ArrayBuffer],'new-identical-plane.deepmark.zip')]);assert.equal(e.mpr.scroll(stale as any),false);assert.deepEqual(e.mpr.plane.value,basePlane());
}));

test('a small actual orientation change does not misclassify a stored density plane as a pure scroll and invalidate its ROI',async()=>withEditor(async e=>{
  const measurement=addDensity(e),points=JSON.stringify(measurement.points);e.mpr.rotation.value=[.001,0,0];assert.equal(e.mpr.applyOrientation(),true);assert.equal(e.measurementDetails(measurement.id).valid,true);assert.equal(JSON.stringify(e.state.value.measurements.find(m=>m.id===measurement.id)!.points),points);
}));
