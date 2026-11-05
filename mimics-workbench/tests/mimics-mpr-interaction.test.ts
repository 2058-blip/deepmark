import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interactiveMprAxes,translateMpr,rotateMpr,sourceSliceMprPlane} from '../src/mimics/mprInteraction.ts';
import {mprPlaneCenter,mprPlaneNormal,mprWorldToPixel} from '../src/mimics/mpr.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const base:MprPlane={origin:[-2,-3,5],u:[2,0,0],v:[0,3,0],size:[3,3]};
const source:MprPlane={origin:[-4,-4,9],u:[1,0,0],v:[0,1,0],size:[9,9]};
const pivot:Vec3=[0,0,5];
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
const point=(actual:Vec3,expected:Vec3)=>actual.forEach((n,i)=>near(n,expected[i]!));

test('blue axes are physical plane intersections and remain independent of slice-normal displacement',()=>{
  const a=interactiveMprAxes(base,source,pivot,0),b=interactiveMprAxes(base,{...source,origin:[-4,-4,100]},pivot,0);assert.deepEqual(a,b);assert.deepEqual(a.map(line=>line.id),['axis-0','axis-1']);point(a[0]!.direction,[0,1,0]);point(a[1]!.direction,[-1,0,0]);assert.deepEqual(base.origin,[-2,-3,5]);
});

test('rotation uses the real independent pivot while mouse vectors lie on a displaced source plane',()=>{
  const result=rotateMpr(base,pivot,source,[2,0,9],[0,2,9]);point(result.plane.origin,[3,-2,5]);point(result.plane.u,[0,2,0]);point(result.plane.v,[-3,0,0]);point(result.crosshair,pivot);point(mprPlaneCenter(result.plane),pivot);assert.deepEqual(result.plane.size,[3,3]);near(Math.hypot(...result.plane.u),2);near(Math.hypot(...result.plane.v),3);point(mprPlaneNormal(result.plane),[0,0,1]);
});

test('translation preserves the blue pivot normal offset, dimensions and complete step vectors without source changes',()=>{
  const before=structuredClone(base),result=translateMpr(base,pivot,[4,-2,0]);point(result.plane.origin,[2,-5,5]);point(result.crosshair,[4,-2,5]);point(result.plane.u,[2,0,0]);point(result.plane.v,[0,3,0]);near(source.origin[2]-result.crosshair[2],4);assert.deepEqual(base,before);result.plane.origin[0]=100;assert.deepEqual(base,before);
});

test('no-op axis clicks preserve the exact uncanonicalized frame and degenerate rotations reject',()=>{
  const result=rotateMpr(base,pivot,source,[2,0,9],[2,0,9]);assert.deepEqual(result.plane,base);assert.notEqual(result.plane,base);assert.throws(()=>rotateMpr(base,pivot,source,[0,0,9],[1,1,9]),/中心/);assert.throws(()=>translateMpr(base,pivot,[NaN,0,0]),/有限/);
});

test('raw reflected/sheared IJK views produce a valid orthogonal interaction context on the actual slice plane',()=>{
  const grid:VolumeGrid={dims:[4,5,3],spacing:[3,Math.sqrt(5),Math.sqrt(16.3125)],affine:[[-3,1,.5,10],[0,2,.25,-20],[0,0,4,30]],data:new Float32Array(60)};
  const plane=sourceSliceMprPlane(grid,2,1);point(mprPlaneNormal(plane),[0,0,-1]);assert.deepEqual(plane.size,[4,5]);for(const world of [[10.5,-19.75,34],[5.5,-11.75,34]] as Vec3[])near(mprWorldToPixel(plane,world).distance,0);near(plane.u.reduce((sum,n,i)=>sum+n*plane.v[i]!,0),0);assert.throws(()=>sourceSliceMprPlane(grid,2,3),/位置/);
});
