import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rasterizeMprContour,MAX_MPR_CONTOUR_SCAN_VISITS,MAX_MPR_CONTOUR_CANDIDATES,MAX_MPR_CONTOUR_EDGE_VISITS,MAX_MPR_CONTOUR_POINTS} from '../src/mimics/mprContour.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const grid=(dims:Vec3=[7,7,3],spacing:Vec3=[1,1,1]):VolumeGrid=>({dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])});
const plane:MprPlane={origin:[0,0,1],u:[1,0,0],v:[0,1,0],size:[7,7]};
const square:Vec3[]=[[1,1,1],[5,1,1],[5,5,1],[1,5,1]];
const xyz=(points:readonly [number,number][],z=1):Vec3[]=>points.map(([x,y])=>[x,y,z]);
const rows=(input:readonly [number,number[]][],z=1):Vec3[]=>input.flatMap(([y,xs])=>xs.map(x=>[x,y,z] as Vec3));
const ids=(points:readonly Vec3[],dims:Vec3)=>points.map(([x,y,z])=>x+dims[0]*(y+dims[1]*z)).sort((a,b)=>a-b);
function matches(actual:ReturnType<typeof rasterizeMprContour>,expected:Vec3[],dims:Vec3):void {
  assert.deepEqual([...actual.indices],ids(expected,dims));assert.equal(actual.candidateCount,expected.length);assert.equal(new Set(actual.indices).size,actual.indices.length);
}

test('an aligned source-center contour fills its original IJK slice and includes all polygon borders',()=>{
  const source=grid([5,5,3],[2,3,4]),aligned:MprPlane={origin:[0,0,4],u:[2,0,0],v:[0,3,0],size:[5,5]},contour:Vec3[]=[[2,3,4],[6,3,4],[6,9,4],[2,9,4]],result=rasterizeMprContour(source,aligned,contour);
  matches(result,rows([[1,[1,2,3]],[2,[1,2,3]],[3,[1,2,3]]]),source.dims);assert.equal(result.scanVisits,9);assert.ok(result.edgeVisits>=contour.length);
});

test('a triangle counts half-open ray crossings once and retains edge and vertex voxel centers',()=>{
  const source=grid(),result=rasterizeMprContour(source,plane,xyz([[0,0],[4,0],[0,4]]));
  matches(result,rows([[0,[0,1,2,3,4]],[1,[0,1,2,3]],[2,[0,1,2]],[3,[0,1]],[4,[0]]]),source.dims);assert.equal(result.scanVisits,25);
});

test('normalized boundary tolerance repairs floating rotation noise without filling an exterior point 1e-11 beyond a sloped edge',()=>{
  const source=grid(),exact=rasterizeMprContour(source,plane,xyz([[0,0],[4,0],[0,4]])),outside=rasterizeMprContour(source,plane,xyz([[0,0],[4,0],[0,4-1e-11]]));
  assert.ok(exact.indices.includes(2+7*(2+7)));assert.equal(outside.indices.includes(2+7*(2+7)),false);assert.ok(outside.indices.includes(1+7*(1+7)));
});

test('concave L fill excludes the open notch and candidate budget applies to polygon rather than bounding rectangle',()=>{
  const source=grid(),contour=xyz([[1,1],[5,1],[5,2],[2,2],[2,5],[1,5]]),result=rasterizeMprContour(source,plane,contour,{maxCandidates:16});
  matches(result,rows([[1,[1,2,3,4,5]],[2,[1,2,3,4,5]],[3,[1,2]],[4,[1,2]],[5,[1,2]]]),source.dims);assert.equal(result.scanVisits,25);
  assert.throws(()=>rasterizeMprContour(source,plane,contour,{maxCandidates:15}),/候选体素.*预算15/);
});

test('self-intersecting zero-signed-area bow tie uses even-odd fill and includes its central crossing',()=>{
  const source=grid(),bowtie=xyz([[1,1],[5,5],[1,5],[5,1]]),result=rasterizeMprContour(source,plane,bowtie);
  matches(result,rows([[1,[1,2,3,4,5]],[2,[2,3,4]],[3,[3]],[4,[2,3,4]],[5,[1,2,3,4,5]]]),source.dims);assert.equal(result.scanVisits,25);
  assert.deepEqual([...rasterizeMprContour(source,plane,[...bowtie].reverse()).indices],[...result.indices]);
});

test('consecutive duplicates and a repeated closing point do not alter membership or mutate the source contour',()=>{
  const source=grid(),repeated=[square[0]!,square[0]!,square[1]!,square[2]!,square[2]!,square[3]!,square[0]!].map(p=>[...p] as Vec3),before=structuredClone(repeated),a=rasterizeMprContour(source,plane,repeated),b=rasterizeMprContour(source,plane,square);
  assert.deepEqual(a.indices,b.indices);assert.deepEqual(repeated,before);assert.equal(a.edgeVisits-b.edgeVisits,3);
});

test('nonconsecutive repeated vertices retain even-odd multiple-loop semantics rather than deduplicating the path',()=>{
  const source=grid(),twice=[...square,...square],result=rasterizeMprContour(source,plane,twice);
  matches(result,rows([[1,[1,2,3,4,5]],[2,[1,5]],[3,[1,5]],[4,[1,5]],[5,[1,2,3,4,5]]]),source.dims);
});

test('closed source-cell slab includes both tangential half-layers while a source-center plane includes one',()=>{
  const source=grid([3,3,3]),between:MprPlane={origin:[0,0,.5],u:[1,0,0],v:[0,1,0],size:[3,3]},contour=xyz([[.75,.75],[1.25,.75],[1.25,1.25],[.75,1.25]],.5);
  matches(rasterizeMprContour(source,between,contour),[[1,1,0],[1,1,1]],source.dims);matches(rasterizeMprContour(source,{...between,origin:[0,0,1]},contour),[[1,1,1]],source.dims);
});

test('tilted rectangle includes precisely the three x-z diagonals whose source cells meet the plane',()=>{
  const source=grid([5,5,5]),s=Math.SQRT1_2,tilted:MprPlane={origin:[0,0,0],u:[s,0,s],v:[0,1,0],size:[7,5]},contour:Vec3[]=[[1,1,1],[3,1,3],[3,3,3],[1,3,1]],result=rasterizeMprContour(source,tilted,contour);
  const diagonals:[number,number][]=[[1,1],[1,2],[2,1],[2,2],[2,3],[3,2],[3,3]];
  matches(result,diagonals.flatMap(([x,z])=>[1,2,3].map(y=>[x,y,z] as Vec3)),source.dims);
});

test('a 90-degree reflected plane frame changes orientation without moving the physical polygon footprint',()=>{
  const source=grid(),turned:MprPlane={origin:[6,0,1],u:[0,1,0],v:[-1,0,0],size:[7,7]},reflected:MprPlane={origin:[6,0,1],u:[-1,0,0],v:[0,1,0],size:[7,7]};
  const expected=rows([[1,[1,2,3,4,5]],[2,[1,2,3,4,5]],[3,[1,2,3,4,5]],[4,[1,2,3,4,5]],[5,[1,2,3,4,5]]]);
  matches(rasterizeMprContour(source,turned,square),expected,source.dims);matches(rasterizeMprContour(source,reflected,square),expected,source.dims);
});

test('sheared reflected source affine projects true physical voxel centers into the contour',()=>{
  const source=grid([5,5,3],[2,Math.sqrt(10),Math.sqrt(16.3125)]);source.affine=[[-2,1,.5,10],[0,3,.25,-20],[0,0,4,30]];
  const reflected:MprPlane={origin:[15,-22,34],u:[-1,0,0],v:[0,1,0],size:[20,20]},contour:Vec3[]=[[6.5,-16.75,34],[10.5,-16.75,34],[10.5,-10.75,34],[6.5,-10.75,34]];
  matches(rasterizeMprContour(source,reflected,contour),[[1,1,1],[2,1,1],[1,2,1],[2,2,1],[3,2,1],[2,3,1],[3,3,1]],source.dims);
});

test('oblique contour slab accounts for all affine columns rather than only nominal slice spacing',()=>{
  const source=grid([3,3,3],[2,Math.sqrt(10),Math.sqrt(16.3125)]);source.affine=[[-2,1,.5,10],[0,3,.25,-20],[0,0,4,30],[0,0,0,1]];
  const s=Math.SQRT1_2,oblique:MprPlane={origin:[8.5-10*s,-23.75,34-10*s],u:[s,0,s],v:[0,1,0],size:[21,21]},contour:Vec3[]=[[8.5-15*s,-28.75,34-15*s],[8.5+15*s,-28.75,34+15*s],[8.5+15*s,1.25,34+15*s],[8.5-15*s,1.25,34-15*s]];
  // Source-center slab simplifies independently to |-2i+j-3.5k+5.5| <= 3.25.
  matches(rasterizeMprContour(source,oblique,contour),[[2,0,0],[2,1,0],[0,0,1],[0,1,1],[1,0,1],[1,1,1],[1,2,1],[2,0,1],[2,1,1],[2,2,1],[0,0,2],[0,1,2],[0,2,2],[1,1,2],[1,2,2]],source.dims);
});

test('full half-pixel FOV clips a large polygon, including both support borders of a single sample',()=>{
  const source=grid([5,5,3]),small:MprPlane={origin:[1.5,1.5,1],u:[1,0,0],v:[0,1,0],size:[1,1]},large=xyz([[-20,-20],[20,-20],[20,20],[-20,20]]),result=rasterizeMprContour(source,small,large);
  matches(result,[[1,1,1],[2,1,1],[1,2,1],[2,2,1]],source.dims);assert.equal(result.scanVisits,4);
  const empty=rasterizeMprContour(source,small,xyz([[20,20],[21,20],[21,21],[20,21]]));assert.equal(empty.scanVisits,0);assert.equal(empty.candidateCount,0);assert.ok(empty.edgeVisits>=4);
});

test('finite off-plane contour vertices project into the frozen plane without moving its editing slab',()=>{
  const source=grid(),offplane=square.map(([x,y],i)=>[x,y,i%2?-900:900] as Vec3),a=rasterizeMprContour(source,plane,square),b=rasterizeMprContour(source,plane,offplane);assert.deepEqual(a,b);
});

test('small contour uses a bounded local source box and returns independently owned sorted storage',()=>{
  const source=grid([128,128,64]),large:MprPlane={origin:[0,0,32],u:[1,0,0],v:[0,1,0],size:[128,128]},contour=xyz([[63,62],[65,62],[65,66],[63,66]],32),a=rasterizeMprContour(source,large,contour),b=rasterizeMprContour(source,large,contour);
  assert.equal(a.scanVisits,15);assert.equal(a.candidateCount,15);assert.ok(a.scanVisits<source.data.length/10_000);assert.notEqual(a.indices,b.indices);a.indices[0]=0;assert.notEqual(b.indices[0],0);
});

test('geometry preprocessing and worst-case point-edge work are budgeted before returning any indices',()=>{
  const source=grid(),raw=source.data.slice(),frozen=structuredClone(square);
  assert.throws(()=>rasterizeMprContour(source,plane,square,{maxScanVisits:24}),/扫描.*预算24/);
  assert.throws(()=>rasterizeMprContour(source,plane,square,{maxEdgeVisits:3}),/边处理.*预算3/);
  assert.throws(()=>rasterizeMprContour(source,plane,square,{maxEdgeVisits:100}),/边处理预算100/);
  const exact=rasterizeMprContour(source,plane,square,{maxScanVisits:25,maxCandidates:25,maxEdgeVisits:107});assert.equal(exact.candidateCount,25);assert.ok(exact.edgeVisits<=107);
  assert.deepEqual(source.data,raw);assert.deepEqual(square,frozen);
});

test('cancellation at progress checkpoints or while many edges are projected returns no partial set',()=>{
  const source=grid(),before=source.data.slice();let cancelled=false,events:number[]=[];
  assert.throws(()=>rasterizeMprContour(source,plane,square,{cancelled:()=>true}),{name:'AbortError'});
  assert.throws(()=>rasterizeMprContour(source,plane,square,{progress:fraction=>{events.push(fraction);if(fraction===.55)cancelled=true;},cancelled:()=>cancelled}),{name:'AbortError'});assert.deepEqual(events,[0,.1,.55]);
  cancelled=false;events=[];assert.throws(()=>rasterizeMprContour(source,plane,square,{progress:fraction=>{events.push(fraction);if(fraction===1)cancelled=true;},cancelled:()=>cancelled}),{name:'AbortError'});assert.equal(events.at(-1),1);
  const repeated=Array.from({length:2050},(_,i)=>square[i%4]!);let checks=0;assert.throws(()=>rasterizeMprContour(source,plane,repeated,{cancelled:()=>++checks>=3}),{name:'AbortError'});assert.deepEqual(source.data,before);
});

test('preallocation failure and gray NaNs cannot mutate sources or expose a partial contour result',()=>{
  const source=grid();source.data.fill(NaN);const raw=source.data.slice(),frozen=structuredClone(square),before=rasterizeMprContour(source,plane,square),nativeSlice=Uint32Array.prototype.slice;
  try{
    Uint32Array.prototype.slice=function(){throw new RangeError('synthetic allocation failure');};assert.throws(()=>rasterizeMprContour(source,plane,square),/分配失败/);
    let allocations=0;Uint32Array.prototype.slice=function(start?:number,end?:number){if(++allocations===2)throw new RangeError('synthetic final-result allocation failure');return nativeSlice.call(this,start,end);};assert.throws(()=>rasterizeMprContour(source,plane,square),/轮廓结果分配失败/);assert.equal(allocations,2);
  }finally{Uint32Array.prototype.slice=nativeSlice;}
  assert.equal(before.candidateCount,25);assert.deepEqual(source.data,raw);assert.deepEqual(square,frozen);
});

test('too few distinct or collinear projected points reject while all finite world coordinates are enforced',()=>{
  const source=grid();
  assert.throws(()=>rasterizeMprContour(source,plane,[]),/需要3/);
  assert.throws(()=>rasterizeMprContour(source,plane,[[1,1,1],[1,1,9],[2,2,1]]),/不同/);
  assert.throws(()=>rasterizeMprContour(source,plane,xyz([[1,1],[2,2],[3,3],[4,4]])),/共线/);
  assert.throws(()=>rasterizeMprContour(source,plane,xyz([[1,1],[2,1],[3,1]])),/共线/);
  assert.throws(()=>rasterizeMprContour(source,plane,[[1,1,1],[NaN,2,1],[3,1,1]]),/有限/);
  assert.throws(()=>rasterizeMprContour(source,plane,[[1,1,1],[2,2,Infinity],[3,1,1]]),/有限/);
  assert.throws(()=>rasterizeMprContour(source,plane,[square[0]!,new Array(3) as Vec3,square[2]!]),/有限/);
  assert.throws(()=>rasterizeMprContour(source,plane,new Array(3) as Vec3[]),/有限/);
  assert.throws(()=>rasterizeMprContour(source,plane,new Array(MAX_MPR_CONTOUR_POINTS+1) as Vec3[]),/65536/);
});

test('invalid source, plane, callbacks and all hard-limit budgets reject without source writes',()=>{
  const source=grid();
  assert.throws(()=>rasterizeMprContour(source,{...plane,u:[0,0,0]},square),/长度/);
  assert.throws(()=>rasterizeMprContour({...source,spacing:[0,1,1]},plane,square),/间距/);
  assert.throws(()=>rasterizeMprContour({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},plane,square),/不可逆/);
  assert.throws(()=>rasterizeMprContour({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,Infinity]]},plane,square),/矩阵/);
  assert.throws(()=>rasterizeMprContour({...source,data:new Float32Array(2)},plane,square),/尺寸/);
  for(const [key,maximum] of [['maxScanVisits',MAX_MPR_CONTOUR_SCAN_VISITS],['maxCandidates',MAX_MPR_CONTOUR_CANDIDATES],['maxEdgeVisits',MAX_MPR_CONTOUR_EDGE_VISITS]] as const)for(const bad of [0,-1,1.5,NaN,Infinity,maximum+1])assert.throws(()=>rasterizeMprContour(source,plane,square,{[key]:bad}),/预算/);
  assert.throws(()=>rasterizeMprContour(source,plane,square,{cancelled:true as unknown as ()=>boolean}),/回调/);
  assert.throws(()=>rasterizeMprContour(source,plane,square,{progress:true as unknown as ()=>void}),/回调/);assert.ok(source.data.every(n=>n===0));
});

test('finite endpoints whose projection or bbox arithmetic overflows reject rather than emit invalid indices',()=>{
  const source=grid();assert.throws(()=>rasterizeMprContour(source,plane,[[Number.MAX_VALUE,0,1],[-Number.MAX_VALUE,0,1],[0,1,1]]),/有限/);
  assert.throws(()=>rasterizeMprContour({...source,affine:[[1e308,0,0,0],[0,1,0,0],[0,0,1,0]]},plane,square),/有限|不可逆/);
});
