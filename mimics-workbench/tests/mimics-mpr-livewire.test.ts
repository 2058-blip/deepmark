import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateMprLiveWire,MAX_MPR_LIVEWIRE_PIXELS} from '../src/mimics/mprLivewire.ts';
import {liveWirePath} from '../src/mimics/livewire.ts';
import type {MprPlane,Vec3,VolumeGrid} from '../src/mimics/types.ts';

const grid=(dims:Vec3=[5,5,1],spacing:Vec3=[1,1,1]):VolumeGrid=>({dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])});
const plane=(size:[number,number]=[5,5]):MprPlane=>({origin:[0,0,0],u:[1,0,0],v:[0,1,0],size});
const near=(actual:number,expected:number,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const values=(actual:ArrayLike<number>,expected:readonly number[])=>{assert.equal(actual.length,expected.length);Array.from(actual).forEach((n,k)=>near(n,expected[k]!));};

test('axial raw intensity ramp produces an analytic normalized cost map and local integer path tree',()=>{
  const source=grid([5,1,1]);source.data.set([0,1,2,3,4]);const tree=calculateMprLiveWire(source,plane([5,1]),[0,0,0],{gradientWeight:1});
  values(tree.gradientCost,[.5,0,0,0,.5]);values(tree.laplacianCost,[1,0,1,0,1]);near(tree.distances[4]!,Math.SQRT1_2/2+4*Number.EPSILON);
  assert.deepEqual(tree.plane,{axis:2,index:0});assert.deepEqual(tree.axes,[0,1]);assert.equal(tree.width,5);assert.equal(tree.height,1);assert.equal(tree.seedIndex,0);assert.deepEqual(liveWirePath(tree,[4,0,0]),[[0,0,0],[1,0,0],[2,0,0],[3,0,0],[4,0,0]]);assert.equal(tree.preprocessing,'recovered-gradient-crossing-independent-gaussian');
});

test('gradient weight and attraction reach the existing edge kernel without hidden rescaling',()=>{
  const source=grid([5,1,1]);source.data.set([0,1,2,3,4]);const tree=calculateMprLiveWire(source,plane([5,1]),[0,0,0],{gradientWeight:.4,attraction:Math.log(2)});
  near(tree.distances[1]!,2**(-.75)*(.3+.1*Math.SQRT1_2)+Number.EPSILON);
});

test('true oblique resampling of a world-linear field yields the independently expected local gradient costs',()=>{
  const source=grid([3,3,3]);for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)source.data[x+3*(y+3*z)]=x+y;
  const oblique:MprPlane={origin:[.5,.5,.5],u:[.5,.5,0],v:[-.25,.25,.5],size:[3,3]},tree=calculateMprLiveWire(source,oblique,[0,1,0],{gradientWeight:1});
  // Raw I=X+Y samples as [1,2,3] on every row; local physical u length=sqrt(.5).
  values(tree.gradientCost,[.5,0,.5,.5,0,.5,.5,0,.5]);near(tree.distances[5]!,Math.SQRT1_2/2+2*Number.EPSILON);assert.deepEqual(liveWirePath(tree,[2,1,0]),[[0,1,0],[1,1,0],[2,1,0]]);
});

test('full reflected sheared affine samples physical gray rather than treating source spacing as world axes',()=>{
  const source=grid([4,4,3],[2,Math.sqrt(10),4]);source.affine=[[2,1,0,100],[0,3,0,-20],[0,0,-4,50],[0,0,0,1]];
  for(let z=0;z<3;z++)for(let y=0;y<4;y++)for(let x=0;x<4;x++)source.data[x+4*(y+4*z)]=292+4*x-7*y-2*z;
  const physical:MprPlane={origin:[101.75,-17.75,49],u:[.5,0,0],v:[0,.75,0],size:[3,3]},tree=calculateMprLiveWire(source,physical,[1,1,0]),edgeX=1-Math.sqrt(10/13),edgeY=1-2.5/Math.sqrt(13);
  // World I=2X-3Y+.5Z+7 gives local step changes +1 and -2.25, physical derivatives +2 and -3.
  values(tree.gradientCost,[.5,edgeY,.5,edgeX,0,edgeX,.5,edgeY,.5]);assert.ok(tree.distances.every(Number.isFinite));
});

test('local physical sampling lengths drive anisotropic feature derivatives',()=>{
  const source=grid([5,5,1],[1,4,1]);for(let y=0;y<5;y++)for(let x=0;x<5;x++)source.data[x+5*y]=x*x+3*y*y;
  const anisotropic=calculateMprLiveWire(source,{...plane(),v:[0,4,0]},[2,2,0]),isotropic=calculateMprLiveWire({...source,spacing:[1,1,1]},plane(),[2,2,0]);
  // At local(0,2), anisotropic |G|=sqrt(.5^2+3^2), Gmax=7.5; isotropic |G|=sqrt(.5^2+12^2), Gmax=sqrt(360).
  near(anisotropic.gradientCost[10]!,1-Math.sqrt(37)/15);near(isotropic.gradientCost[10]!,1-Math.sqrt(577)/(12*Math.sqrt(10)));assert.notDeepEqual(anisotropic.gradientCost,isotropic.gradientCost);
});

test('linear and nearest gray interpolation produce distinct analytically known cost maps',()=>{
  const source=grid([6,1,1]);source.data.set([0,1,4,9,16,25]);const offset:MprPlane={origin:[.25,0,0],u:[1,0,0],v:[0,1,0],size:[5,1]};
  const linear=calculateMprLiveWire(source,offset,[0,0,0],{interpolation:'linear'}),nearest=calculateMprLiveWire(source,offset,[0,0,0],{interpolation:'nearest'}),defaultTree=calculateMprLiveWire(source,offset,[0,0,0]);
  // Sampled rows: linear [.25,1.75,5.25,10.75,18.25], nearest [0,1,4,9,16].
  values(linear.gradientCost,[23/26,8/13,4/13,0,11/26]);values(nearest.gradientCost,[11/12,2/3,1/3,0,5/12]);assert.deepEqual(defaultTree,linear);assert.notDeepEqual(linear.gradientCost,nearest.gradientCost);
});

test('a nonfinite raw source wall stays unreachable and never becomes a straight chord',()=>{
  const source=grid([5,3,1]);for(let y=0;y<3;y++)source.data[2+5*y]=NaN;
  for(const interpolation of ['linear','nearest'] as const){const tree=calculateMprLiveWire(source,plane([5,3]),[0,1,0],{interpolation});assert.deepEqual(liveWirePath(tree,[4,1,0]),[]);assert.equal(tree.distances[9],Infinity);assert.equal(tree.predecessors[9],-1);assert.deepEqual(liveWirePath(tree,[2,1,0]),[]);assert.throws(()=>calculateMprLiveWire(source,plane([5,3]),[2,1,0],{interpolation}),/有限原始灰度支持/);}
});

test('unsupported and half-voxel gray-invalid FOV samples are barriers even when nearest would clamp source coordinates',()=>{
  const source=grid([3,1,1]),wide:MprPlane={origin:[-1,0,0],u:[1,0,0],v:[0,1,0],size:[5,1]},tree=calculateMprLiveWire(source,wide,[1,0,0]);
  assert.deepEqual(liveWirePath(tree,[0,0,0]),[]);assert.deepEqual(liveWirePath(tree,[4,0,0]),[]);assert.deepEqual(liveWirePath(tree,[3,0,0]),[[1,0,0],[2,0,0],[3,0,0]]);
  for(const interpolation of ['linear','nearest'] as const){assert.throws(()=>calculateMprLiveWire(source,wide,[0,0,0],{interpolation}),/支持/);assert.throws(()=>calculateMprLiveWire(source,{...wide,origin:[-.25,0,0],size:[3,1]},[0,0,0],{interpolation}),/支持/);}
  assert.throws(()=>calculateMprLiveWire(source,{...wide,origin:[100,0,0]},[0,0,0]),/支持/);
});

test('constant gray keeps the recovered preprocessing label and analytic equal-step reachability',()=>{
  const source=grid([7,5,1]);source.data.fill(42);const tree=calculateMprLiveWire(source,plane([7,5]),[0,0,0]);assert.ok(tree.gradientCost.every(n=>n===0));assert.ok(tree.laplacianCost.every(n=>n===1));near(tree.distances[34]!,6*(.4+Number.EPSILON));const path=liveWirePath(tree,[6,4,0]);assert.equal(path.length,7);assert.deepEqual(path[0],[0,0,0]);assert.deepEqual(path.at(-1),[6,4,0]);
});

test('raw volume, affine, saved plane and seed remain unchanged and returned trees own their data',()=>{
  const source=grid(),raw=source.data.slice();source.affine=[[1,0,0,0],[0,1,0,0],[0,0,1,0]];const p=plane(),seed:Vec3=[2,2,0],frozen={dims:[...source.dims],spacing:[...source.spacing],affine:structuredClone(source.affine),p:structuredClone(p),seed:[...seed]},a=calculateMprLiveWire(source,p,seed),b=calculateMprLiveWire(source,p,seed);
  assert.deepEqual(source.data,raw);assert.deepEqual(source.dims,frozen.dims);assert.deepEqual(source.spacing,frozen.spacing);assert.deepEqual(source.affine,frozen.affine);assert.deepEqual(p,frozen.p);assert.deepEqual(seed,frozen.seed);
  assert.notEqual(a.distances,b.distances);assert.notEqual(a.gradientCost,b.gradientCost);a.seed[0]=0;a.gradientCost[0]=99;assert.deepEqual(seed,[2,2,0]);assert.notEqual(b.gradientCost[0],99);
});

test('the one-million-pixel cap rejects excess before sampling and accepts its exact boundary without silent downsampling',()=>{
  assert.equal(MAX_MPR_LIVEWIRE_PIXELS,1_048_576);const source=grid([1,1,1]),above=plane([1025,1024]);let checkpoints=0;
  assert.throws(()=>calculateMprLiveWire(source,above,[0,0,0],{progress:()=>checkpoints++}),/1048576像素预算/);assert.equal(checkpoints,0);
  // A maximal supported output whose seed has no gray support reaches the support error, never an automatic reduced size.
  assert.throws(()=>calculateMprLiveWire(source,{...plane([1024,1024]),origin:[2,0,0]},[0,0,0]),/有限原始灰度支持/);
});

test('cancellation is normalized to AbortError before work, inside resampling and in LiveWire progress',()=>{
  const source=grid([128,128,1]),p=plane([128,128]),raw=source.data.slice();
  assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{cancelled:()=>true}),{name:'AbortError'});
  let checks=0;assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{cancelled:()=>++checks>=4}),{name:'AbortError'});assert.equal(checks,4);
  let cancel=false;const events:number[]=[];assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{cancelled:()=>cancel,progress:f=>{events.push(f);if(f===.25)cancel=true;}}),{name:'AbortError'});assert.deepEqual(events,[0,.25]);assert.deepEqual(source.data,raw);
});

test('final progress cancellation prevents a completed tree from being published and progress stays monotonic',()=>{
  const source=grid(),events:number[]=[];let cancel=false;
  assert.throws(()=>calculateMprLiveWire(source,plane(),[0,0,0],{cancelled:()=>cancel,progress:f=>{events.push(f);if(f===1)cancel=true;}}),{name:'AbortError'});assert.equal(events[0],0);assert.equal(events.at(-1),1);assert.ok(events.every((n,i)=>n>=0&&n<=1&&(i===0||n>=events[i-1]!)));
});

test('invalid local seeds, interpolation, numerical options and callbacks reject before resampling',()=>{
  const source=grid(),p=plane();for(const seed of [[-.1,0,0],[0,0,1],[-1,0,0],[5,0,0],[0,5,0],[NaN,0,0],[0,Infinity,0]] as Vec3[])assert.throws(()=>calculateMprLiveWire(source,p,seed),/种子|有限/);
  assert.throws(()=>calculateMprLiveWire(source,p,new Array(3) as Vec3),/有限/);assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{interpolation:'cubic' as 'linear'}),/插值/);assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{interpolation:null as unknown as 'linear'}),/插值/);
  for(const weight of [-.1,1.1,NaN,Infinity,null as unknown as number])assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{gradientWeight:weight}),/梯度权重/);
  for(const attraction of [-51,51,NaN,Infinity,null as unknown as number])assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{attraction}),/吸引参数/);
  assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{cancelled:0 as unknown as ()=>boolean}),/回调/);assert.throws(()=>calculateMprLiveWire(source,p,[0,0,0],{progress:0 as unknown as ()=>void}),/回调/);
});

test('invalid source shape, source affine and physical plane reject without mutating raw samples',()=>{
  const source=grid(),p=plane(),seed:Vec3=[0,0,0];
  assert.throws(()=>calculateMprLiveWire({...source,dims:[0,5,1]},p,seed),/尺寸/);assert.throws(()=>calculateMprLiveWire({...source,spacing:[1,0,1]},p,seed),/间距/);assert.throws(()=>calculateMprLiveWire({...source,data:new Float32Array(1)},p,seed),/尺寸/);assert.throws(()=>calculateMprLiveWire({...source,data:new Uint32Array(25) as unknown as Float32Array},p,seed),/Float32/);
  assert.throws(()=>calculateMprLiveWire({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},p,seed),/不可逆/);assert.throws(()=>calculateMprLiveWire({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,NaN]]},p,seed),/矩阵/);assert.throws(()=>calculateMprLiveWire({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,1,1]]},p,seed),/透视/);assert.throws(()=>calculateMprLiveWire({...source,affine:[[1e308,0,0,0],[0,1,0,0],[0,0,1,0]]},p,seed),/有限/);
  assert.throws(()=>calculateMprLiveWire(source,{...p,u:[0,0,0]},seed),/长度/);assert.throws(()=>calculateMprLiveWire(source,{...p,v:[1,1,0]},seed),/正交/);assert.throws(()=>calculateMprLiveWire(source,{...p,size:[0,5]},seed),/尺寸/);assert.ok(source.data.every(n=>n===0));
});
