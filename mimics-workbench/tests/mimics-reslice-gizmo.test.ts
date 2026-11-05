import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MIN_RESLICE_FIELD_OF_VIEW_MM,reslicePlaneFrame,reslicePlaneHandles,translateReslicePlane,rotateReslicePlane,resizeReslicePlane} from '../src/mimics/resliceGizmo.ts';
import {mprPlaneCenter,mprPlaneNormal,validateMprPlane} from '../src/mimics/mpr.ts';
import {sourceSliceMprPlane} from '../src/mimics/mprInteraction.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const base:MprPlane={origin:[2,10,6],u:[2,0,0],v:[0,3,0],size:[4,2]}; // center [5,11.5,6], full support x=[1,9], y=[8.5,14.5].
const near=(actual:number,expected:number,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const point=(actual:readonly number[],expected:readonly number[])=>{assert.equal(actual.length,expected.length);actual.forEach((n,k)=>near(n,expected[k]!));};
const points=(actual:readonly Vec3[],expected:readonly Vec3[])=>{assert.equal(actual.length,expected.length);actual.forEach((p,k)=>point(p,expected[k]!));};
function isIndependentClone(actual:MprPlane,source:MprPlane):void {
  assert.notEqual(actual,source);for(const key of ['origin','u','v','size'] as const)assert.notEqual(actual[key],source[key]);
  assert.deepEqual(validateMprPlane(actual),actual);
}

test('RP frame uses complete pixel support, physical sample steps and a fixed corner winding',()=>{
  const frame=reslicePlaneFrame(base);point(frame.center,[5,11.5,6]);point(frame.u,[1,0,0]);point(frame.v,[0,1,0]);point(frame.normal,[0,0,1]);near(frame.width,8);near(frame.height,6);
  points(frame.corners,[[1,8.5,6],[9,8.5,6],[9,14.5,6],[1,14.5,6]]);
  const single=reslicePlaneFrame({origin:[7,8,9],u:[2,0,0],v:[0,0,-4],size:[1,1]});point(single.center,[7,8,9]);near(single.width,2);near(single.height,4);points(single.corners,[[6,8,11],[8,8,11],[8,8,7],[6,8,7]]);point(single.normal,[0,1,0]);
});

test('RP handles occupy physical support sides and corners and do not alias the source or each other',()=>{
  const resize=reslicePlaneHandles(base,'resize'),rotate=reslicePlaneHandles(base,'rotate');assert.equal(resize.length,9);assert.equal(rotate.length,5);
  const expected:Record<string,Vec3>={center:[5,11.5,6],'u-':[1,11.5,6],'u+':[9,11.5,6],'v-':[5,8.5,6],'v+':[5,14.5,6],'corner--':[1,8.5,6],'corner+-':[9,8.5,6],'corner++':[9,14.5,6],'corner-+':[1,14.5,6],'rotate--':[1,8.5,6],'rotate+-':[9,8.5,6],'rotate++':[9,14.5,6],'rotate-+':[1,14.5,6]};
  for(const handle of [...resize,...rotate]){point(handle.position,expected[handle.id]!);assert.equal(handle.kind,handle.id==='center'?'move':handle.id.startsWith('rotate')?'rotate':'resize');if(handle.kind==='rotate')assert.equal(handle.axis,'normal');}
  rotate[1]!.position[0]=900;point(resize[5]!.position,[1,8.5,6]);point(base.origin,[2,10,6]);
  assert.throws(()=>reslicePlaneHandles(base,'bad' as 'rotate'),/模式/);
});

test('world translation preserves every step and sample dimension and leaves its input immutable',()=>{
  const frozen=structuredClone(base),moved=translateReslicePlane(base,[4,-2,7]);point(moved.origin,[6,8,13]);point(mprPlaneCenter(moved),[9,9.5,13]);assert.deepEqual(moved.u,base.u);assert.deepEqual(moved.v,base.v);assert.deepEqual(moved.size,base.size);assert.deepEqual(base,frozen);isIndependentClone(moved,base);
  moved.u[0]=42;assert.deepEqual(base,frozen);
});

test('a known quarter turn ignores displaced drag planes and rotates the exact physical rectangle around its center',()=>{
  const frozen=structuredClone(base),rotated=rotateReslicePlane(base,[9,11.5,80],[5,15.5,-200]);point(rotated.origin,[6.5,8.5,6]);point(rotated.u,[0,2,0]);point(rotated.v,[-3,0,0]);point(mprPlaneCenter(rotated),[5,11.5,6]);point(mprPlaneNormal(rotated),[0,0,1]);points(reslicePlaneFrame(rotated).corners,[[8,7.5,6],[8,15.5,6],[2,15.5,6],[2,7.5,6]]);assert.deepEqual(rotated.size,[4,2]);assert.deepEqual(base,frozen);isIndependentClone(rotated,base);
});

test('explicit world-axis rotation can tilt a plane without moving its center or changing its physical FOV',()=>{
  // Around +X, +Y turns into +Z; axial drag offsets disappear under axis projection.
  const rotated=rotateReslicePlane(base,[500,15.5,6],[-500,11.5,10],[2,0,0]);point(rotated.origin,[2,11.5,4.5]);point(rotated.u,[2,0,0]);point(rotated.v,[0,0,3]);point(mprPlaneCenter(rotated),[5,11.5,6]);point(mprPlaneNormal(rotated),[0,-1,0]);near(reslicePlaneFrame(rotated).width,8);near(reslicePlaneFrame(rotated).height,6);
});

test('symmetric side resize changes one full FOV and discards transverse and off-plane pointer displacement',()=>{
  const frozen=structuredClone(base),wider=resizeReslicePlane(base,'u-',[15,900,-200]);point(wider.origin,[-2.5,10,6]);point(wider.u,[5,0,0]);assert.deepEqual(wider.v,base.v);point(mprPlaneCenter(wider),[5,11.5,6]);near(reslicePlaneFrame(wider).width,20);near(reslicePlaneFrame(wider).height,6);assert.deepEqual(wider.size,[4,2]);
  const taller=resizeReslicePlane(base,'v+',[800,17.5,-900]);point(taller.origin,[2,8.5,6]);assert.deepEqual(taller.u,base.u);point(taller.v,[0,6,0]);near(reslicePlaneFrame(taller).height,12);assert.deepEqual(base,frozen);isIndependentClone(wider,base);isIndependentClone(taller,base);
});

test('corner resize updates both support dimensions, preserves signed orientation and uses the frozen center',()=>{
  const result=resizeReslicePlane(base,'corner--',[15,2.5,200]);point(result.origin,[-2.5,7,6]);point(result.u,[5,0,0]);point(result.v,[0,9,0]);point(mprPlaneCenter(result),[5,11.5,6]);near(reslicePlaneFrame(result).width,20);near(reslicePlaneFrame(result).height,18);point(mprPlaneNormal(result),[0,0,1]);
  assert.deepEqual(result,resizeReslicePlane(base,'corner++',[-5,20.5,-200]),'opposite-side drag positions resize symmetrically without mirroring the frame');
});

test('minimum field of view remains positive at a center crossing, including maximum-size sampling',()=>{
  const minimum=resizeReslicePlane(base,'corner++',[5,11.5,100]),frame=reslicePlaneFrame(minimum);near(frame.width,MIN_RESLICE_FIELD_OF_VIEW_MM);near(frame.height,MIN_RESLICE_FIELD_OF_VIEW_MM);point(frame.center,[5,11.5,6]);point(frame.u,[1,0,0]);point(frame.v,[0,1,0]);
  const custom=reslicePlaneFrame(resizeReslicePlane(base,'u+',[5,999,6],.25));near(custom.width,.25);near(custom.height,6);
  const maximum:MprPlane={origin:[0,0,0],u:[1,0,0],v:[0,1,0],size:[16384,1]},small=resizeReslicePlane(maximum,'u+',[8191.5,0,0],Number.MIN_VALUE);assert.ok(small.u[0]>1e-9);assert.ok(reslicePlaneFrame(small).width>0);assert.deepEqual(small.size,maximum.size);
});

test('no-op operations preserve exact uncanonicalized numeric fields and return independent validated clones',()=>{
  const rounded:MprPlane={origin:[-1.25,9.75,3.125],u:[-2,0,0],v:[1e-7,3,0],size:[4,5]},frozen=structuredClone(rounded),frame=reslicePlaneFrame(rounded);
  for(const noOp of [translateReslicePlane(rounded,[0,0,0]),rotateReslicePlane(rounded,frame.corners[0],frame.corners[0]),rotateReslicePlane(rounded,[frame.center[0]-2,frame.center[1],99],[frame.center[0]-20,frame.center[1],-99]),...reslicePlaneHandles(rounded,'resize').filter(h=>h.kind==='resize').map(h=>resizeReslicePlane(rounded,h.id,h.position))]){assert.deepEqual(noOp,rounded);isIndependentClone(noOp,rounded);}
  assert.deepEqual(rounded,frozen);
});

test('reflected and sheared source geometry yields a real physical RP and independent off-plane resizing',()=>{
  const grid:VolumeGrid={dims:[4,5,3],spacing:[3,Math.sqrt(5),Math.sqrt(16.3125)],affine:[[-3,1,.5,10],[0,2,.25,-20],[0,0,4,30]],data:new Float32Array(60)},plane=sourceSliceMprPlane(grid,2,1),frame=reslicePlaneFrame(plane);
  // Complete affine volume support projects to x span 12+5+1.5 and y span 10+.75 mm.
  point(frame.center,[8,-15.75,34]);point(frame.u,[-1,0,0]);point(frame.v,[0,1,0]);point(frame.normal,[0,0,-1]);near(frame.width,18.5);near(frame.height,10.75);points(frame.corners,[[17.25,-21.125,34],[-1.25,-21.125,34],[-1.25,-10.375,34],[17.25,-10.375,34]]);
  const resized=reslicePlaneFrame(resizeReslicePlane(plane,'u+',[-2,-15.75,999]));point(resized.center,[8,-15.75,34]);near(resized.width,20);near(resized.height,10.75);point(resized.u,[-1,0,0]);point(resized.normal,[0,0,-1]);
  const turned=rotateReslicePlane(plane,[-2,-15.75,999],[8,-5.75,-999]);point(turned.u,[0,4.625,0]);point(turned.v,[2.15,0,0]);point(mprPlaneCenter(turned),[8,-15.75,34]);
});

test('invalid planes, vectors, zero rotation axes and center-aligned rotation rays reject before a result is produced',()=>{
  const frozen=structuredClone(base),center:Vec3=[5,11.5,6];
  assert.throws(()=>reslicePlaneFrame({...base,u:[0,0,0]}),/长度/);
  assert.throws(()=>reslicePlaneFrame({...base,v:[1,3,0]}),/正交/);
  assert.throws(()=>reslicePlaneFrame({...base,size:[0,2]}),/尺寸/);
  assert.throws(()=>translateReslicePlane(base,[NaN,0,0]),/有限/);
  assert.throws(()=>translateReslicePlane(base,new Array(3) as Vec3),/有限/);
  assert.throws(()=>rotateReslicePlane(base,center,[9,11.5,6]),/不能为零/);
  assert.throws(()=>rotateReslicePlane(base,[5,11.5,99],[9,11.5,6]),/不能为零/);
  assert.throws(()=>rotateReslicePlane(base,[9,11.5,6],[5,15.5,6],[0,0,0]),/不能为零/);
  assert.throws(()=>rotateReslicePlane(base,[9,11.5,6],[Infinity,0,0]),/有限/);
  assert.throws(()=>resizeReslicePlane(base,'center',center),/控制点/);
  assert.throws(()=>resizeReslicePlane(base,'u+',center,0),/最小视野/);
  assert.throws(()=>resizeReslicePlane(base,'u+',center,Infinity),/最小视野/);
  assert.throws(()=>resizeReslicePlane(base,'u+',[0,NaN,0]),/有限/);
  assert.deepEqual(base,frozen);
});

test('finite input with unrepresentable physical dimensions or drag deltas rejects instead of publishing invalid geometry',()=>{
  const wide:MprPlane={origin:[0,0,0],u:[1e308,0,0],v:[0,1,0],size:[2,1]};validateMprPlane(wide);
  assert.throws(()=>reslicePlaneFrame(wide),/有限/);
  assert.throws(()=>translateReslicePlane(wide,[Number.MAX_VALUE,0,0]),/有限/);
  assert.throws(()=>resizeReslicePlane(base,'u+',[Number.MAX_VALUE,0,0]),/有限/);
});
