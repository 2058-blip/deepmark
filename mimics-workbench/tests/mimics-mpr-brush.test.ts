import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sweepMprBrush,MAX_MPR_BRUSH_SCAN_VISITS,MAX_MPR_BRUSH_CANDIDATES,type MprBrushStroke} from '../src/mimics/mprBrush.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const grid=(dims:Vec3=[7,7,3],spacing:Vec3=[1,1,1]):VolumeGrid=>({dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])});
const plane:MprPlane={origin:[0,0,1],u:[1,0,0],v:[0,1,0],size:[7,7]};
const stroke=(from:Vec3,to:Vec3=from,widthMm=2,heightMm=2,shape:'circle'|'square'='circle'):MprBrushStroke=>({from,to,widthMm,heightMm,shape});
const indices=(points:Vec3[],dims:Vec3):number[]=>points.map(([x,y,z])=>x+dims[0]*(y+dims[1]*z)).sort((a,b)=>a-b);
const xyRows=(rows:[number,number[]][],z=1):Vec3[]=>rows.flatMap(([y,xs])=>xs.map(x=>[x,y,z] as Vec3));
function matches(actual:ReturnType<typeof sweepMprBrush>,expected:Vec3[],dims:Vec3):void {
  assert.deepEqual([...actual.indices],indices(expected,dims));assert.equal(actual.candidateCount,expected.length);assert.equal(new Set(actual.indices).size,actual.indices.length);
}

test('aligned IJK-center circle selects only its exact source slice with physical anisotropic widths',()=>{
  const source=grid([5,5,3],[2,3,4]),aligned:MprPlane={origin:[0,0,4],u:[2,0,0],v:[0,3,0],size:[5,5]},result=sweepMprBrush(source,aligned,stroke([4,6,4],[4,6,4],8,6));
  matches(result,xyRows([[1,[2]],[2,[0,1,2,3,4]],[3,[2]]]),source.dims);assert.equal(result.scanVisits,15);
  const rectangle=sweepMprBrush(source,aligned,stroke([4,6,4],[4,6,4],8,6,'square'));
  matches(rectangle,xyRows([[1,[0,1,2,3,4]],[2,[0,1,2,3,4]],[3,[0,1,2,3,4]]]),source.dims);
});

test('continuous unequal-axis ellipse sweep fills long pointer gaps without endpoint-dab sampling',()=>{
  const source=grid(),result=sweepMprBrush(source,plane,stroke([1,3,1],[5,3,1],2,4));
  matches(result,xyRows([[1,[1,2,3,4,5]],[2,[1,2,3,4,5]],[3,[0,1,2,3,4,5,6]],[4,[1,2,3,4,5]],[5,[1,2,3,4,5]]]),source.dims);assert.equal(result.scanVisits,35);
});

test('continuous rectangle sweep includes its full swept edge and is independent of segment direction',()=>{
  const source=grid(),forward=sweepMprBrush(source,plane,stroke([1,3,1],[5,3,1],2,4,'square')),backward=sweepMprBrush(source,plane,stroke([5,3,1],[1,3,1],2,4,'square'));
  matches(forward,xyRows([[1,[0,1,2,3,4,5,6]],[2,[0,1,2,3,4,5,6]],[3,[0,1,2,3,4,5,6]],[4,[0,1,2,3,4,5,6]],[5,[0,1,2,3,4,5,6]]]),source.dims);assert.deepEqual(forward,backward);
});

test('diagonal ellipse and rectangle sweeps have distinct analytic source-center footprints',()=>{
  const source=grid(),circle=sweepMprBrush(source,plane,stroke([1,1,1],[4,4,1])),square=sweepMprBrush(source,plane,stroke([1,1,1],[4,4,1],2,2,'square'));
  matches(circle,xyRows([[0,[1]],[1,[0,1,2]],[2,[1,2,3]],[3,[2,3,4]],[4,[3,4,5]],[5,[4]]]),source.dims);
  matches(square,xyRows([[0,[0,1,2]],[1,[0,1,2,3]],[2,[0,1,2,3,4]],[3,[1,2,3,4,5]],[4,[2,3,4,5]],[5,[3,4,5]]]),source.dims);
});

test('closed source-cell slab retains tangencies on both sides of an exact half-layer plane',()=>{
  const source=grid([3,3,3]),between:MprPlane={origin:[0,0,.5],u:[1,0,0],v:[0,1,0],size:[3,3]},result=sweepMprBrush(source,between,stroke([1,1,.5],[1,1,.5],.5,.5));
  matches(result,[[1,1,0],[1,1,1]],source.dims);assert.equal(result.scanVisits,2);
  const onCenter=sweepMprBrush(source,{...between,origin:[0,0,1]},stroke([1,1,1],[1,1,1],.5,.5));matches(onCenter,[[1,1,1]],source.dims);
});

test('tilted slab includes the three x-z diagonals whose source cells intersect the plane',()=>{
  const source=grid([5,5,5]),s=Math.SQRT1_2,tilted:MprPlane={origin:[0,0,0],u:[s,0,s],v:[0,1,0],size:[7,5]},result=sweepMprBrush(source,tilted,stroke([2,2,2],[2,2,2],2*Math.SQRT2,2,'square'));
  const xz:[number,number][]=[[1,1],[1,2],[2,1],[2,2],[2,3],[3,2],[3,3]];
  matches(result,xz.flatMap(([x,z])=>[1,2,3].map(y=>[x,y,z] as Vec3)),source.dims);
  const circle=sweepMprBrush(source,tilted,stroke([2,2,2],[2,2,2],2*Math.SQRT2,2));matches(circle,[[1,2,1],[1,2,2],[2,2,1],[2,1,2],[2,2,2],[2,3,2],[2,2,3],[3,2,2],[3,2,3]],source.dims);
});

test('sheared reflected affine applies physical brush shape without interpreting spacing as world axes',()=>{
  const source=grid([5,5,3],[2,Math.sqrt(10),Math.sqrt(16.3125)]);source.affine=[[-2,1,.5,10],[0,3,.25,-20],[0,0,4,30]];
  const reflected:MprPlane={origin:[15,-22,34],u:[-1,0,0],v:[0,1,0],size:[20,20]},dab=stroke([8.5,-13.75,34],[8.5,-13.75,34],4,6,'square');
  matches(sweepMprBrush(source,reflected,dab),[[1,1,1],[2,1,1],[1,2,1],[2,2,1],[3,2,1],[2,3,1],[3,3,1]],source.dims);
  matches(sweepMprBrush(source,reflected,{...dab,shape:'circle'}),[[1,2,1],[2,2,1],[3,2,1]],source.dims);
});

test('oblique slab thickness uses every full affine column including shear and reflection',()=>{
  const source=grid([3,3,3],[2,Math.sqrt(10),Math.sqrt(16.3125)]);source.affine=[[-2,1,.5,10],[0,3,.25,-20],[0,0,4,30],[0,0,0,1]];
  const s=Math.SQRT1_2,oblique:MprPlane={origin:[8.5-10*s,-23.75,34-10*s],u:[s,0,s],v:[0,1,0],size:[21,21]},result=sweepMprBrush(source,oblique,stroke([8.5,-13.75,34],[8.5,-13.75,34],30,30,'square'));
  // After multiplying by sqrt(2), the slab inequality is |-2i+j-3.5k+5.5| <= 3.25.
  matches(result,[[2,0,0],[2,1,0],[0,0,1],[0,1,1],[1,0,1],[1,1,1],[1,2,1],[2,0,1],[2,1,1],[2,2,1],[0,0,2],[0,1,2],[0,2,2],[1,1,2],[1,2,2]],source.dims);
});

test('full physical MPR field of view clips source candidates at half-pixel support borders',()=>{
  const source=grid([5,5,3]),small:MprPlane={origin:[1.5,1.5,1],u:[1,0,0],v:[0,1,0],size:[1,1]},result=sweepMprBrush(source,small,stroke([1.5,1.5,1],[1.5,1.5,1],100,100,'square'));
  matches(result,[[1,1,1],[2,1,1],[1,2,1],[2,2,1]],source.dims);assert.equal(result.scanVisits,4);
  const none=sweepMprBrush(source,small,stroke([20,20,1],[21,21,1]));assert.equal(none.scanVisits,0);assert.equal(none.candidateCount,0);assert.equal(none.indices.length,0);
});

test('finite off-plane endpoints project into the frozen plane and do not displace its source-cell slab',()=>{
  const source=grid(),a=sweepMprBrush(source,plane,stroke([1,3,1],[5,3,1],2,4)),b=sweepMprBrush(source,plane,stroke([1,3,900],[5,3,-900],2,4));assert.deepEqual(a,b);
});

test('small high-frequency brush scans a conservative local box rather than the full source volume',()=>{
  const source=grid([128,128,64]),large:MprPlane={origin:[0,0,32],u:[1,0,0],v:[0,1,0],size:[128,128]},result=sweepMprBrush(source,large,stroke([64,64,32],[64,64,32],4,6));
  assert.equal(result.scanVisits,35);assert.equal(result.candidateCount,19);assert.ok(result.scanVisits<source.data.length/10_000);assert.equal(result.indices[0],64+128*(61+128*32));
});

test('scan and candidate caps reject the whole segment without exposing a partial candidate set or modifying input',()=>{
  const source=grid(),raw=source.data.slice(),frozenPlane=structuredClone(plane),dab=stroke([3,3,1],[3,3,1],4,4,'square'),frozenStroke=structuredClone(dab);
  assert.throws(()=>sweepMprBrush(source,plane,dab,{maxScanVisits:24}),/扫描.*预算24/);
  assert.throws(()=>sweepMprBrush(source,plane,dab,{maxCandidates:24}),/体素.*预算24/);
  const exact=sweepMprBrush(source,plane,dab,{maxScanVisits:25,maxCandidates:25});assert.equal(exact.scanVisits,25);assert.equal(exact.candidateCount,25);
  assert.deepEqual(source.data,raw);assert.deepEqual(plane,frozenPlane);assert.deepEqual(dab,frozenStroke);
});

test('cancellation is checked before work, during a bounded scan and before returning an empty result',()=>{
  const source=grid([80,80,3]),large:MprPlane={origin:[0,0,1],u:[1,0,0],v:[0,1,0],size:[80,80]},dab=stroke([40,40,1],[40,40,1],70,70,'square');let checks=0;
  assert.throws(()=>sweepMprBrush(source,large,dab,{cancelled:()=>true}),{name:'AbortError'});
  assert.throws(()=>sweepMprBrush(source,large,dab,{cancelled:()=>++checks>=3}),{name:'AbortError'});assert.equal(checks,3);assert.ok(source.data.every(n=>n===0));
  checks=0;assert.throws(()=>sweepMprBrush(source,large,stroke([200,200,1]),{cancelled:()=>++checks>=2}),{name:'AbortError'});
});

test('source gray values are never read or changed and result storage is independently owned',()=>{
  const source=grid();source.data.fill(NaN);const before=source.data.slice(),dab=stroke([3,3,1]),a=sweepMprBrush(source,plane,dab),b=sweepMprBrush(source,plane,dab);assert.equal(a.candidateCount,5);assert.deepEqual(source.data,before);a.indices[0]=0;assert.notEqual(b.indices[0],0);
});

test('invalid finite contracts, degenerate affine geometry and allocation budgets reject before any source write',()=>{
  const source=grid(),dab=stroke([3,3,1]);
  for(const bad of [0,-1,NaN,Infinity,Number.MIN_VALUE])assert.throws(()=>sweepMprBrush(source,plane,{...dab,widthMm:bad}),/宽高/);
  assert.throws(()=>sweepMprBrush(source,plane,{...dab,heightMm:0}),/宽高/);
  assert.throws(()=>sweepMprBrush(source,plane,{...dab,shape:'bad' as 'circle'}),/形状/);
  assert.throws(()=>sweepMprBrush(source,plane,{...dab,from:[NaN,0,0]}),/有限/);
  assert.throws(()=>sweepMprBrush(source,plane,{...dab,to:[0,0,Infinity]}),/有限/);
  assert.throws(()=>sweepMprBrush(source,plane,{...dab,from:new Array(3) as Vec3}),/有限/);
  assert.throws(()=>sweepMprBrush(source,{...plane,v:[1,1,0]},dab),/正交/);
  assert.throws(()=>sweepMprBrush({...source,spacing:[0,1,1]},plane,dab),/间距/);
  assert.throws(()=>sweepMprBrush({...source,dims:[7,7,0]},plane,dab),/尺寸/);
  assert.throws(()=>sweepMprBrush({...source,data:new Float32Array(2)},plane,dab),/尺寸/);
  assert.throws(()=>sweepMprBrush({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},plane,dab),/不可逆/);
  assert.throws(()=>sweepMprBrush({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,Infinity]]},plane,dab),/矩阵/);
  assert.throws(()=>sweepMprBrush({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,1,1]]},plane,dab),/透视/);
  for(const bad of [0,-1,1.5,NaN,Infinity,MAX_MPR_BRUSH_SCAN_VISITS+1])assert.throws(()=>sweepMprBrush(source,plane,dab,{maxScanVisits:bad}),/预算/);
  for(const bad of [0,-1,1.5,NaN,Infinity,MAX_MPR_BRUSH_CANDIDATES+1])assert.throws(()=>sweepMprBrush(source,plane,dab,{maxCandidates:bad}),/预算/);
  assert.throws(()=>sweepMprBrush(source,plane,dab,{cancelled:true as unknown as ()=>boolean}),/函数/);assert.ok(source.data.every(n=>n===0));
});

test('unrepresentable world geometry rejects instead of overflowing a conservative source bound',()=>{
  const source=grid(),dab=stroke([Number.MAX_VALUE,0,1],[Number.MAX_VALUE,0,1],Number.MAX_VALUE,1);
  assert.throws(()=>sweepMprBrush(source,plane,dab),/有限/);
  assert.throws(()=>sweepMprBrush({...source,affine:[[1e308,0,0,0],[0,1,0,0],[0,0,1,0]]},plane,stroke([3,3,1])),/有限|不可逆/);
});
