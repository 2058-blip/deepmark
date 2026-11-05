import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_MPR_PIXELS,MAX_MPR_DIMENSION,validateMprPlane,mprPlaneNormal,mprPlaneCenter,mprPixelToWorld,mprWorldToPixel,scrollMprPlane,createMprPlane,fitMprPlane,orthogonalMprPlanes,sampleMprSlice,mprDensityPlane} from '../src/mimics/mpr.ts';
import {densityStatistics,nearestVoxelCoordinate} from '../src/mimics/measurements.ts';
import type {MprPlane,VolumeGrid,Vec3} from '../src/mimics/types.ts';

const near=(a:number,b:number,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`),point=(a:readonly number[],b:readonly number[],tolerance=1e-8)=>{assert.equal(a.length,b.length);a.forEach((v,k)=>near(v,b[k]!,tolerance));};
const plane=(extra:Partial<MprPlane>={}):MprPlane=>({origin:[0,0,0],u:[1,0,0],v:[0,1,0],size:[2,2],...extra});
const tinyGrid=():VolumeGrid=>({dims:[2,2,2],spacing:[1,1,1],data:new Float32Array([0,10,100,110,1000,1010,1100,1110])});
const shear=[[2,1,0,100],[0,3,0,-20],[0,0,-4,50],[0,0,0,1]];
function linearGrid():VolumeGrid{
  const data=new Float32Array(48);for(let z=0;z<3;z++)for(let y=0;y<4;y++)for(let x=0;x<4;x++)data[x+4*(y+4*z)]=292+4*x-7*y-2*z;
  return{dims:[4,4,3],spacing:[2,Math.sqrt(10),4],affine:shear.map(row=>[...row]),data};
}

test('MPR plane validation clones physical steps and rejects unknown fields, sparse arrays and accessors',()=>{
  const input=plane({origin:[10,20,30],u:[0,2,0],v:[0,0,-3]}),copy=validateMprPlane(input);assert.deepEqual(copy,input);assert.notEqual(copy,input);assert.notEqual(copy.u,input.u);copy.u[1]=9;assert.equal(input.u[1],2);
  assert.throws(()=>validateMprPlane({...input,extra:true}),/字段/);assert.throws(()=>validateMprPlane({...input,[Symbol('extra')]:true}),/字段/);
  const sparse:any=[0,,0];assert.throws(()=>validateMprPlane({...input,origin:sparse}),/稠密/);
  const extra:any=[0,0,0];extra.note='x';assert.throws(()=>validateMprPlane({...input,origin:extra}),/稠密/);
  let invoked=0;const accessor={...input};Object.defineProperty(accessor,'origin',{get:()=>{invoked++;return[0,0,0];}});assert.throws(()=>validateMprPlane(accessor),/getter/);assert.equal(invoked,0);
  const axis:any=[1,0,0];Object.defineProperty(axis,'0',{get:()=>{invoked++;return 1;}});assert.throws(()=>validateMprPlane({...input,u:axis}),/getter/);assert.equal(invoked,0);
  assert.throws(()=>validateMprPlane(new Date()),/普通对象/);assert.throws(()=>validateMprPlane({...input,u:new Float32Array([1,0,0])}),/普通稠密数组/);
});

test('MPR plane bounds reject invalid geometry and output budgets before sampling',()=>{
  assert.equal(MAX_MPR_PIXELS,4194304);assert.equal(MAX_MPR_DIMENSION,16384);
  for(const size of [[0,2],[1.5,2],[16385,1],[4096,4096]])assert.throws(()=>validateMprPlane(plane({size:size as [number,number]})),/尺寸/);
  assert.throws(()=>validateMprPlane(plane({u:[0,0,0]})),/方向向量/);assert.throws(()=>validateMprPlane(plane({u:[1e-10,0,0]})),/方向向量/);assert.throws(()=>validateMprPlane(plane({v:[1,1,0]})),/正交/);assert.throws(()=>validateMprPlane(plane({origin:[Infinity,0,0]})),/有限/);
  assert.throws(()=>validateMprPlane(plane({origin:[1e308,0,0],u:[1e308,0,0],size:[3,2]})),/有限/);
});

test('MPR pixel centers map to world and signed plane distance with reflected non-unit axes',()=>{
  const p=plane({origin:[10,20,30],u:[0,2,0],v:[0,0,-3],size:[3,4]});point(mprPlaneNormal(p),[-1,0,0]);point(mprPlaneCenter(p),[10,22,25.5]);point(mprPixelToWorld(p,[1.5,2]),[10,23,24]);
  const projected=mprWorldToPixel(p,[6,23,24]);point(projected.pixel,[1.5,2]);near(projected.distance,4);const moved=scrollMprPlane(p,2);point(moved.origin,[8,20,30]);point(moved.u,p.u);point(moved.v,p.v);point(p.origin,[10,20,30]);
  assert.throws(()=>scrollMprPlane(p,NaN),/毫米/);assert.throws(()=>mprPixelToWorld(p,[Infinity,0]),/有限/);
});

test('accepted rounded orthogonal frames invert their Gram residual rather than drifting pixel coordinates',()=>{
  const p=plane({origin:[10,20,30],u:[2,0,0],v:[1e-6,3,0]});const world=mprPixelToWorld(p,[1.25,-2.5]),back=mprWorldToPixel(p,world);point(back.pixel,[1.25,-2.5],1e-11);near(back.distance,0);
  const extreme=plane({u:[1e308,0,0],v:[0,1e-8,0],size:[1,1]});point(mprWorldToPixel(extreme,[5e307,2e-8,0]).pixel,[.5,2]);
});

test('MPR orientation uses explicit world Euler degrees or normal plus positive sample-v up',()=>{
  const p=createMprPlane({center:[5,6,7],size:[3,3],pixelSpacing:[2,4],angles:[90,0,0]});point(p.origin,[3,6,3]);point(p.u,[2,0,0]);point(p.v,[0,0,4]);point(mprPlaneNormal(p),[0,-1,0]);point(mprPlaneCenter(p),[5,6,7]);
  const q=createMprPlane({center:[0,0,0],size:[1,1],pixelSpacing:[1,1],angles:[0,90,90]});point(q.u,[0,0,-1]);point(q.v,[-1,0,0]);point(mprPlaneNormal(q),[0,1,0]);
  const r=createMprPlane({center:[0,0,0],size:[1,1],pixelSpacing:[1,2],normal:[0,-5,0],up:[0,0,3]});point(r.u,[1,0,0]);point(r.v,[0,0,2]);
  assert.throws(()=>createMprPlane({center:[0,0,0],size:[2,2],pixelSpacing:[1,1],normal:[0,0,1],up:[0,0,2]}),/方向向量/);assert.throws(()=>createMprPlane({center:[0,0,0],size:[2,2],pixelSpacing:[1,1],normal:[0,0,1],angles:[0,0,0]}),/同时/);
});

test('MPR FOV fit projects full affine/sheared/reflected half-voxel support into actual orthogonal output steps',()=>{
  const grid:VolumeGrid={dims:[2,3,2],spacing:[2,Math.sqrt(10),4],affine:shear,data:new Float32Array(12)},p=fitMprPlane(grid,{size:[7,9],normal:[0,0,1],up:[0,1,0]});
  point(p.origin,[99,-21,48]);point(p.u,[1,0,0]);point(p.v,[0,1,0]);point(mprPlaneCenter(p),[102,-17,48]);
  // The independent physical bounds are X=[98.5,105.5], Y=[-21.5,-12.5].
  point(mprWorldToPixel(p,[98.5,-21.5,48]).pixel,[-.5,-.5]);point(mprWorldToPixel(p,[105.5,-12.5,48]).pixel,[6.5,8.5]);
  const shifted=fitMprPlane(grid,{size:[7,9],center:[100,-17,48]});point(mprPlaneCenter(shifted),[100,-17,48]);near(Math.hypot(...shifted.u),11/7);assert.throws(()=>fitMprPlane({...grid,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},{size:[7,9]}),/不可逆/);
});

test('three MPR planes share one world center and preserve the saved base pixel frame exactly',()=>{
  const grid:VolumeGrid={dims:[2,3,2],spacing:[2,Math.sqrt(10),4],affine:shear,data:new Float32Array(12)},base=plane({origin:[101,-18,48],u:[.25,0,0],v:[0,.5,0],size:[9,5]}),views=orthogonalMprPlanes(grid,base);
  assert.deepEqual(views[0],base);assert.notEqual(views[0],base);assert.notEqual(views[0].origin,base.origin);point(mprPlaneNormal(views[0]),[0,0,1]);point(mprPlaneNormal(views[1]),[1,0,0]);point(mprPlaneNormal(views[2]),[0,1,0]);
  for(const view of views)point(mprPlaneCenter(view),[102,-17,48]);point(views[1].u,[0,1,0]);point(views[1].v,[0,0,1.6]);point(views[2].u,[0,0,8/9]);point(views[2].v,[1.4,0,0]);
});

test('MPR trilinear gray follows an analytic world-linear field through affine shear and reflection',()=>{
  const grid=linearGrid(),p=plane({origin:[101.75,-17.75,49],u:[.5,0,0],v:[0,.75,0],size:[3,3]}),source=grid.data.slice(),result=sampleMprSlice(grid,p);
  // World intensity = 2X-3Y+0.5Z+7, so pixel steps add +1 and -2.25.
  point(result.gray,[288.25,289.25,290.25,286,287,288,283.75,284.75,285.75]);assert.deepEqual([...result.valid],Array(9).fill(1));assert.deepEqual([...result.support],Array(9).fill(1));assert.deepEqual(grid.data,source);assert.notEqual(result.plane,p);
  const stats=densityStatistics(grid,mprDensityPlane(p),{kind:'rect',min:[0,0],max:[2,2]},{interpolation:'linear'});assert.equal(stats.count,9);assert.equal(stats.excluded,0);near(stats.mean,287);near(stats.min,283.75);near(stats.max,290.25);near(stats.area,3.375);
});

test('MPR true oblique output mixes all three voxel axes instead of transforming an IJK canvas',()=>{
  const data=new Float32Array(27);for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)data[x+3*(y+3*z)]=10*x+100*y+1000*z;
  const grid:VolumeGrid={dims:[3,3,3],spacing:[1,1,1],data},p=plane({origin:[.5,.5,.5],u:[.5,.5,0],v:[-.25,.25,.5],size:[3,3]}),result=sampleMprSlice(grid,p);
  point(result.gray,[555,610,665,1077.5,1132.5,1187.5,1600,1655,1710]);assert.deepEqual([...result.valid],Array(9).fill(1));
});

test('MPR spacing-only grids retain physical anisotropy without an affine or implicit unit conversion',()=>{
  const grid={...tinyGrid(),spacing:[2,3,4] as Vec3},result=sampleMprSlice(grid,plane({origin:[0,0,2],u:[1,0,0],v:[0,1.5,0]}));
  point(result.gray,[500,505,550,555]);assert.deepEqual([...result.valid],[1,1,1,1]);
});

test('MPR samples each independent Mask with nearest labels even when gray uses trilinear interpolation',()=>{
  const grid=linearGrid(),p=plane({origin:[101.75,-17.75,49],u:[.5,0,0],v:[0,.75,0],size:[3,3]}),a=new Uint8Array(48),b=new Uint8Array(48);a[5]=1;b[4]=255;const result=sampleMprSlice(grid,p,[{id:'A',data:a},{id:'B',data:b}]);
  assert.deepEqual(result.masks.map(m=>m.id),['A','B']);assert.deepEqual([...result.masks[0]!.data],[1,1,1,0,1,1,0,1,1]);assert.deepEqual([...result.masks[1]!.data],[0,0,0,255,0,0,255,0,0]);assert.equal(a[5],1);assert.equal(b[4],255);assert.notEqual(result.masks[0]!.data,a);
  point(sampleMprSlice(grid,p,[],{interpolation:'nearest'}).gray,[289,289,289,285,289,289,285,289,289]);
});

test('MPR half-voxel Mask support is separate from density-compatible gray center validity',()=>{
  const grid:VolumeGrid={dims:[2,1,1],spacing:[1,1,1],data:new Float32Array([10,20])},p=plane({origin:[-.75,0,0],u:[.25,0,0],v:[0,1,0],size:[11,1]}),result=sampleMprSlice(grid,p,[{id:'A',data:new Uint8Array([1,0])}]);
  assert.deepEqual([...result.support],[0,1,1,1,1,1,1,1,1,1,0]);assert.deepEqual([...result.valid],[0,0,0,1,1,1,1,1,0,0,0]);point(result.gray.slice(3,8),[10,12.5,15,17.5,20]);for(const index of [0,1,2,8,9,10])assert.ok(Number.isNaN(result.gray[index]));assert.deepEqual([...result.masks[0]!.data],[0,1,1,1,1,0,0,0,0,0,0]);
  const stats=densityStatistics(grid,mprDensityPlane(p),{kind:'rect',min:[0,0],max:[10,0]},{interpolation:'linear'});assert.equal(stats.count,5);assert.equal(stats.excluded,6);near(stats.mean,15);
});

test('zero-weight NaN neighbors do not poison MPR gray while positive-weight NaN excludes only gray, preserving Mask support',()=>{
  const grid=tinyGrid();grid.data[1]=NaN;const result=sampleMprSlice(grid,plane({size:[1,1]}),[{id:'A',data:new Uint8Array(8).fill(1)}]);assert.equal(result.gray[0],0);assert.equal(result.valid[0],1);
  const mixed=sampleMprSlice(grid,plane({origin:[.5,0,0],size:[1,1]}),[{id:'A',data:new Uint8Array(8).fill(1)}]);assert.ok(Number.isNaN(mixed.gray[0]));assert.equal(mixed.valid[0],0);assert.equal(mixed.support[0],1);assert.equal(mixed.masks[0]!.data[0],1);
});

test('physical density linear skips genuinely zero underflow weights and excludes positive-weight NaN samples',()=>{
  const grid:VolumeGrid={dims:[2,2,1],spacing:[1,1,1],data:new Float32Array([10,10,10,NaN])},roi={kind:'rect' as const,min:[0,0] as [number,number],max:[0,0] as [number,number]};
  // fx*fy underflows to exactly zero. The diagonal NaN has no contribution.
  const zero=plane({origin:[1e-200,1e-200,0],size:[1,1]}),clean=densityStatistics(grid,zero,roi,{interpolation:'linear'});assert.equal(clean.count,1);assert.equal(clean.excluded,0);near(clean.mean,10);assert.equal(sampleMprSlice(grid,zero).valid[0],1);
  const positive=densityStatistics(grid,plane({origin:[.5,.5,0],size:[1,1]}),roi,{interpolation:'linear'});assert.equal(positive.count,0);assert.equal(positive.excluded,1);assert.ok(Number.isNaN(positive.mean));
  assert.equal(densityStatistics(grid,plane({size:[1,1]}),roi).mean,10,'existing nearest default is unchanged');
});

test('MPR rejects invalid affine, Mask source and explicit allocation budgets atomically',()=>{
  const grid=tinyGrid(),before=grid.data.slice();assert.throws(()=>sampleMprSlice(grid,plane(),[],{maxPixels:3}),/像素预算/);assert.throws(()=>sampleMprSlice(grid,plane(),[{id:'A',data:new Uint8Array(8)}],{maxBytes:27}),/内存预算/);assert.throws(()=>sampleMprSlice(grid,plane(),[{id:'A',data:new Uint8Array(7)}]),/Mask/);assert.throws(()=>sampleMprSlice(grid,plane(),[{id:'A',data:new Uint8Array(8)},{id:'A',data:new Uint8Array(8)}]),/Mask/);
  assert.throws(()=>sampleMprSlice({...grid,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},plane()),/不可逆/);assert.throws(()=>sampleMprSlice(grid,plane(),[],{interpolation:'cubic' as any}),/插值/);assert.deepEqual(grid.data,before);
});

test('nearest voxel ties repair only the two-ULP neighborhood and leave genuinely lower non-half coordinates unchanged',()=>{
  assert.equal(nearestVoxelCoordinate(2.5-Number.EPSILON*2),3);assert.equal(nearestVoxelCoordinate(2.5-Number.EPSILON*4),3);
  assert.equal(nearestVoxelCoordinate(2.5-Number.EPSILON*8),2);assert.equal(nearestVoxelCoordinate(2.5-1e-12),2);assert.equal(nearestVoxelCoordinate(.5-2**-40),0);assert.equal(nearestVoxelCoordinate(-.5-2**-40),-1);
  assert.equal(nearestVoxelCoordinate(2.5),3);assert.equal(nearestVoxelCoordinate(-.5),0);assert.equal(nearestVoxelCoordinate(.25),0);assert.equal(nearestVoxelCoordinate(.75),1);assert.equal(nearestVoxelCoordinate(2**50),2**50);
});

test('MPR cancellation before work or during a bounded scan returns no partial result and never changes sources',()=>{
  const grid=tinyGrid(),mask=new Uint8Array(8).fill(1),source=grid.data.slice(),before=mask.slice();let result:unknown,calls=0;
  assert.throws(()=>{result=sampleMprSlice(grid,plane(),[{id:'A',data:mask}],{cancelled:()=>true});},/取消/);assert.equal(result,undefined);
  assert.throws(()=>{result=sampleMprSlice(grid,plane({size:[20,20]}),[{id:'A',data:mask}],{cancelled:()=>++calls===3});},/取消/);assert.equal(calls,3);assert.equal(result,undefined);assert.deepEqual(grid.data,source);assert.deepEqual(mask,before);
});
