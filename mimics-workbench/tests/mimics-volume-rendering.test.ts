import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransferLUT,columnMajor,compositeVolumeSamples,evaluateTransferFunction,inspectVolumeForRendering,intersectVolumeRay,normalizeTransferPoints,opacityForStep,presetTransferFunction,rayBoxIntersection,relativeWorldToTexture,renderingSampleCount,sampleVolumeAtWorld,sampleVolumeTrilinear,transformVolumePoint,volumeGeometry,windowNormalized,type TransferPoint } from '../src/mimics/volumeRendering.ts';
import {physicalPoint,type Vec3,type VolumeGrid} from '../src/mimics/types.ts';
const near=(a:number,b:number,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const nearPoint=(a:Vec3,b:Vec3,tolerance=1e-10)=>a.forEach((v,k)=>near(v,b[k]!,tolerance));
function grid(dims:Vec3=[3,4,5],spacing:Vec3=[1,1,1]):VolumeGrid{return {dims,spacing,data:Float32Array.from({length:dims[0]*dims[1]*dims[2]},(_,i)=>i%dims[0]+10*(Math.floor(i/dims[0])%dims[1])+100*Math.floor(i/(dims[0]*dims[1])))};}
const affine=[[0,-2,0,100],[3,0,.25,-20],[0,0,-4,50],[0,0,0,1]];

test('physical volume support includes half a voxel on every face, with anisotropic dimensions',()=>{
  const geometry=volumeGeometry(grid([4,6,8],[2,3,4]));assert.deepEqual(geometry.bounds.min,[-1,-1.5,-2]);assert.deepEqual(geometry.bounds.max,[7,16.5,30]);assert.deepEqual(geometry.bounds.size,[8,18,32]);assert.deepEqual(geometry.physicalVoxelSize,[2,3,4]);
});

test('inverse affine and normalized 3D texture mapping handle rotation, shear, reflection and translation',()=>{
  const g={...grid(),affine},geometry=volumeGeometry(g),voxel:Vec3=[1.2,1.75,2.4],world=physicalPoint(voxel,g);
  nearPoint(world,[96.5,-15.8,40.4]);nearPoint(transformVolumePoint(geometry.worldToVoxel,world),voxel);
  nearPoint(transformVolumePoint(geometry.worldToTexture,world),[(1.2+.5)/3,(1.75+.5)/4,(2.4+.5)/5]);
  nearPoint(geometry.bounds.min,[93,-21.625,32]);nearPoint(geometry.bounds.max,[101,-11.375,52]);
  nearPoint(transformVolumePoint(geometry.worldToTexture,physicalPoint([-.5,-.5,-.5],g)),[0,0,0]);nearPoint(transformVolumePoint(geometry.worldToTexture,physicalPoint([2.5,3.5,4.5],g)),[1,1,1]);
  const relative=world.map((v,k)=>v-geometry.bounds.center[k]!) as Vec3;nearPoint(transformVolumePoint(relativeWorldToTexture(geometry),relative),transformVolumePoint(geometry.worldToTexture,world));
});

test('relative coordinates retain texture mapping under a large physical translation',()=>{
  const g={...grid(),affine:[[.7,.1,0,1e8],[0,1.2,.2,-2e8],[0,0,-2.5,3e8],[0,0,0,1]]},geometry=volumeGeometry(g);
  const relative=physicalPoint([1,2,3],g).map((v,k)=>v-geometry.bounds.center[k]!) as Vec3;
  nearPoint(transformVolumePoint(relativeWorldToTexture(geometry),relative),[1.5/3,2.5/4,3.5/5],2e-8);
  const m=columnMajor([[2,0,0,10],[0,3,0,20],[0,0,4,30],[0,0,0,1]]);assert.deepEqual([...m],[2,0,0,0,0,3,0,0,0,0,4,0,10,20,30,1]);
});

test('ray-box intersection handles parallel axes, inside rays, negative directions and misses',()=>{
  assert.deepEqual(rayBoxIntersection([-1,.5,.5],[1,0,0],[0,0,0],[1,1,1]),{enter:1,exit:2});
  assert.deepEqual(rayBoxIntersection([.5,.5,.5],[0,0,-1],[0,0,0],[1,1,1]),{enter:0,exit:.5});
  assert.equal(rayBoxIntersection([-1,2,.5],[1,0,0],[0,0,0],[1,1,1]),null);assert.equal(rayBoxIntersection([-1,.5,.5],[-1,0,0],[0,0,0],[1,1,1]),null);
  assert.throws(()=>rayBoxIntersection([0,0,0],[0,0,0],[0,0,0],[1,1,1]),/方向/);
});

test('volume ray intervals use physical millimetres even under anisotropic or reflected/sheared affines',()=>{
  assert.deepEqual(intersectVolumeRay(grid([4,6,8],[2,3,4]),[-11,4,5],[2,0,0]),{enter:10,exit:18});
  const g={...grid(),affine},origin=physicalPoint([-5,2,2],g),interval=intersectVolumeRay(g,origin,[0,3,0]);assert.ok(interval);near(interval.enter,13.5);near(interval.exit,22.5);
});

test('manual trilinear sampling reproduces a linear scalar field and clamps only the half-voxel border support',()=>{
  const g=grid();near(sampleVolumeTrilinear(g,[1.2,1.75,2.4]),258.7);near(sampleVolumeTrilinear(g,[-.25,1,2]),210);
  const rotated={...g,affine};near(sampleVolumeAtWorld(rotated,physicalPoint([1.2,1.75,2.4],rotated))!,258.7);
  assert.equal(sampleVolumeAtWorld(rotated,physicalPoint([-.6,1,2],rotated)),undefined);
  near(sampleVolumeAtWorld(rotated,physicalPoint([-.5,1,2],rotated))!,210);
});

test('memory and MAX_3D_TEXTURE_SIZE failures are explicit and do not resample the source',()=>{
  const g=grid(),before=g.data.slice(),bytes=g.data.length*4;
  const result=inspectVolumeForRendering(g,{max3DTextureSize:5,maxTextureBytes:bytes});assert.equal(result.textureBytes,bytes);assert.equal(result.voxelCount,60);assert.equal(result.min,0);assert.equal(result.max,432);
  assert.throws(()=>inspectVolumeForRendering(g,{max3DTextureSize:4}),/MAX_3D_TEXTURE_SIZE.*未做降采样/);
  assert.throws(()=>inspectVolumeForRendering(g,{maxTextureBytes:bytes-1}),/MiB.*未做降采样/);assert.deepEqual(g.data,before);
  const bad=grid();bad.data[7]=NaN;assert.throws(()=>inspectVolumeForRendering(bad),/NaN/);
});

test('invalid affine matrices fail before attempting GPU work',()=>{
  assert.throws(()=>volumeGeometry({...grid(),affine:[[1,0,0,0],[0,0,0,0],[0,0,1,0],[0,0,0,1]]}),/不可逆/);
  assert.throws(()=>volumeGeometry({...grid(),affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,1,1]]}),/仿射/);
  assert.throws(()=>volumeGeometry({...grid(),spacing:[1,0,1]}),/间距/);
});

test('transfer functions sort immutable controls and interpolate RGB and alpha in scalar space',()=>{
  const points:TransferPoint[]=[{value:100,color:[1,.5,.25],opacity:.8},{value:-100,color:[0,0,0],opacity:0}],original=JSON.stringify(points);
  const sorted=normalizeTransferPoints(points);assert.equal(sorted[0]!.value,-100);assert.equal(JSON.stringify(points),original);
  assert.deepEqual(evaluateTransferFunction(points,0),{color:[.5,.25,.125],opacity:.4});assert.deepEqual(evaluateTransferFunction(points,-200),{color:[0,0,0],opacity:0});assert.deepEqual(evaluateTransferFunction(points,200),{color:[1,.5,.25],opacity:.8});
  assert.throws(()=>normalizeTransferPoints([points[0]!,points[0]!]),/重复/);assert.throws(()=>normalizeTransferPoints([{value:0,color:[1,0,0],opacity:2},points[0]!]),/无效/);
});

test('floating-point transfer LUT preserves endpoints, intermediate interpolation and explicit domains',()=>{
  const points:TransferPoint[]=[{value:-10,color:[0,0,0],opacity:.2},{value:10,color:[1,.5,.25],opacity:.8}],lut=buildTransferLUT(points,[-10,10],5);
  assert.deepEqual(lut.domain,[-10,10]);assert.equal(lut.data.length,20);near(lut.data[0]!,0);near(lut.data[3]!,.2,1e-7);near(lut.data[8]!,.5);near(lut.data[11]!,.5);near(lut.data[19]!,.8,1e-7);
  const extended=buildTransferLUT(points,[-20,20],5);near(extended.data[0]!,0);near(extended.data[19]!,.8,1e-7);assert.throws(()=>buildTransferLUT(points,[0,0]),/范围/);
});

test('documented preset names are independent mutable CT examples with valid fresh controls',()=>{
  for(const name of ['bone','soft','both'] as const){const a=presetTransferFunction(name),b=presetTransferFunction(name);assert.ok(normalizeTransferPoints(a).length>=2);assert.notDeepEqual(a,presetTransferFunction(name==='bone'?'soft':'bone'));a[0]!.color[0]=.9;assert.notEqual(a[0]!.color[0],b[0]!.color[0]);}
});

test('opacity correction makes homogeneous attenuation invariant to physical ray-march step',()=>{
  near(opacityForStep(.5,2),.75);near(opacityForStep(1,0),0);near(opacityForStep(1,.1),1);
  const coarse=compositeVolumeSamples([{color:[.8,.4,.2],opacity:.3,distanceMm:4.8}],.7);
  const fine=compositeVolumeSamples(Array.from({length:100},()=>({color:[.8,.4,.2] as Vec3,opacity:.3,distanceMm:.048})),.7);
  near(coarse.opacity,1-Math.pow(1-.3*.7,4.8));near(fine.opacity,coarse.opacity,2e-14);nearPoint(fine.color,coarse.color,2e-14);
});

test('front-to-back composition preserves visibility order rather than selecting an opaque isosurface',()=>{
  const red={color:[1,0,0]as Vec3,opacity:.5,distanceMm:1},blue={color:[0,0,1]as Vec3,opacity:.5,distanceMm:1};
  assert.deepEqual(compositeVolumeSamples([red,blue]),{color:[.5,0,.25],opacity:.75});assert.deepEqual(compositeVolumeSamples([blue,red]),{color:[.25,0,.5],opacity:.75});
  assert.deepEqual(compositeVolumeSamples([red,blue],0),{color:[0,0,0],opacity:0});
});

test('sampling budget and display window reject invalid parameters without silently truncating rays',()=>{
  assert.equal(renderingSampleCount(10,.75),14);assert.equal(renderingSampleCount(0,1),0);assert.throws(()=>renderingSampleCount(4097,1),/超过 4096/);assert.throws(()=>renderingSampleCount(1,0),/步长/);
  assert.equal(windowNormalized(-100,0,200),0);assert.equal(windowNormalized(0,0,200),.5);assert.equal(windowNormalized(100,0,200),1);assert.equal(windowNormalized(300,0,200),1);assert.throws(()=>windowNormalized(0,0,0),/窗宽/);
});
