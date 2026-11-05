import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createResliceProjectGeometry,resliceProject,MAX_RESLICE_PROJECT_DIMENSION,MAX_RESLICE_PROJECT_VOXELS,MAX_RESLICE_PROJECT_BYTES,MAX_RESLICE_PROJECT_MASKS,type ResliceProjectGeometryOptions} from '../src/mimics/resliceProjectGeometry.ts';
import type {Vec3,VolumeGrid} from '../src/mimics/types.ts';

const grid=(dims:Vec3=[5,5,5],spacing:Vec3=[1,1,1]):VolumeGrid=>({dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])});
const options=(extra:Partial<ResliceProjectGeometryOptions>={}):ResliceProjectGeometryOptions=>({start:[2,2,1],end:[2,2,3.6],width:3,height:3,pixelSize:1,sliceDistance:1,...extra});
const near=(a:number,b:number,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const point=(a:readonly number[],b:readonly number[],tolerance=1e-9)=>{assert.equal(a.length,b.length);a.forEach((n,k)=>near(n,b[k]!,tolerance));};
const transform=(m:number[][],p:Vec3):Vec3=>[0,1,2].map(k=>m[k]![0]!*p[0]+m[k]![1]!*p[1]+m[k]![2]!*p[2]+m[k]![3]!) as Vec3;
const fillLinear=(source:VolumeGrid)=>{for(let z=0;z<source.dims[2];z++)for(let y=0;y<source.dims[1];y++)for(let x=0;x<source.dims[0];x++)source.data[x+source.dims[0]*(y+source.dims[1]*z)]=10*x+100*y+1000*z;return source;};

test('axial reslicing uses sample counts, first layer center, floor-plus-one endpoints and fresh independent masks',()=>{
  const source=fillLinear(grid()),a=new Uint8Array(125),b=new Uint8Array(125);for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<5;x++){const i=x+5*(y+5*z);a[i]=Number(x===y&&y===z);b[i]=Number(x===2);}
  const raw=source.data.slice(),beforeA=a.slice(),beforeB=b.slice(),config=options(),frozen=structuredClone(config),result=resliceProject(source,config,[{id:'a',data:a},{id:'overlap',data:b}]),expected:number[]=[];
  for(let z=1;z<=3;z++)for(let y=1;y<=3;y++)for(let x=1;x<=3;x++)expected.push(10*x+100*y+1000*z);
  point(result.data,expected);assert.deepEqual(result.dims,[3,3,3]);assert.deepEqual(result.spacing,[1,1,1]);assert.deepEqual(result.affine,[[1,0,0,1],[0,1,0,1],[0,0,1,1],[0,0,0,1]]);point(result.geometry.firstCenter,[2,2,1]);point(result.geometry.lastCenter,[2,2,3]);near(result.geometry.lineLength,2.6);near(result.geometry.lastSliceDistance,2);near(result.geometry.remainingDistance,.6);assert.equal(result.geometry.sliceCount,3);
  assert.equal(result.masks[0]!.count,3);assert.deepEqual([...result.masks[0]!.data.keys()].filter(i=>result.masks[0]!.data[i]),[0,13,26]);assert.equal(result.masks[1]!.count,9);assert.notEqual(result.masks[0]!.data,a);assert.notEqual(result.masks[1]!.data,b);assert.notEqual(result.masks[0]!.data,result.masks[1]!.data);assert.deepEqual(result.coverage,{totalVoxels:27,grayValid:27,grayOutside:0,grayNonfinite:0,maskSupported:27,maskOutside:0});
  assert.deepEqual(source.data,raw);assert.deepEqual(a,beforeA);assert.deepEqual(b,beforeB);assert.deepEqual(config,frozen);
});

test('geometry-only preview distinguishes sample-center extent and full voxel support even for one-sample dimensions',()=>{
  const result=createResliceProjectGeometry(options());assert.equal(result.geometry.sampleCenterCorners.length,8);assert.equal(result.geometry.supportCorners.length,8);point(result.physicalBounds.sourceWorld.min,[1,1,1]);point(result.physicalBounds.sourceWorld.max,[3,3,3]);point(result.supportBounds.sourceWorld.min,[.5,.5,.5]);point(result.supportBounds.sourceWorld.max,[3.5,3.5,3.5]);assert.deepEqual(result.physicalBounds.outputWorld,result.physicalBounds.sourceWorld);
  const single=createResliceProjectGeometry(options({width:1,height:1,end:[2,2,1.2],sliceDistance:2}));assert.deepEqual(single.dims,[1,1,1]);point(single.geometry.sourceOrigin,[2,2,1]);point(single.geometry.lastCenter,[2,2,1]);point(single.physicalBounds.sourceWorld.min,[2,2,1]);point(single.physicalBounds.sourceWorld.max,[2,2,1]);point(single.supportBounds.sourceWorld.min,[1.5,1.5,0]);point(single.supportBounds.sourceWorld.max,[2.5,2.5,2]);near(single.geometry.remainingDistance,.2);
});

test('last-layer policy never appends a stretched layer to reach a non-divisible end point',()=>{
  for(const [end,distance,count,last] of [[3.5,1,3,3],[3,1,3,3],[1.25,1,1,1],[3.5,.5,6,3.5]] as const){const plan=createResliceProjectGeometry(options({end:[2,2,end],sliceDistance:distance}));assert.equal(plan.dims[2],count);near(plan.geometry.lastCenter[2],last);assert.ok(plan.geometry.lastSliceDistance<=plan.geometry.lineLength);}
  // The floating quotient rounds to exactly3, while the third regular interval would lie beyond end.
  const edge=createResliceProjectGeometry(options({start:[0,0,0],end:[0,0,.003009027081243731],sliceDistance:.0010030090270812437,width:1,height:1}));assert.equal(edge.geometry.sliceCount,3);assert.ok(edge.geometry.remainingDistance>=0);assert.ok(edge.geometry.lastSliceDistance<=edge.geometry.lineLength);
});

test('full sheared reflected source affine samples an analytic world-linear field throughout the 3D output',()=>{
  const source=grid([4,4,3],[2,Math.sqrt(10),4]);source.affine=[[2,1,0,100],[0,3,0,-20],[0,0,-4,50],[0,0,0,1]];for(let z=0;z<3;z++)for(let y=0;y<4;y++)for(let x=0;x<4;x++)source.data[x+4*(y+4*z)]=292+4*x-7*y-2*z;
  const result=resliceProject(source,options({start:[102,-17,49],end:[102,-17,45.8],pixelSize:.5})),expected:number[]=[];for(let z=0;z<4;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)expected.push(289-x-1.5*y-.5*z);
  // I_world=2X-3Y+.5Z+7; u=-X, v=+Y, line=-Z.
  point(result.data,expected);assert.deepEqual(result.dims,[3,3,4]);point(result.geometry.sourceOrigin,[102.5,-17.5,49]);point(result.geometry.u,[-1,0,0]);point(result.geometry.v,[0,1,0]);point(result.geometry.normal,[0,0,-1]);point(result.affine[0]!,[-.5,0,0,102.5]);assert.equal(result.coverage.grayValid,36);
});

test('Update CS off preserves world coordinates while on maps the first pixel center to zero with positive image axes',()=>{
  const source=fillLinear(grid()),config=options({start:[2,2,3],end:[2,2,1],pixelSize:.5,rotationDegrees:90}),off=resliceProject(source,config),on=resliceProject(source,{...config,updateCoordinateSystem:true});
  assert.deepEqual(off.data,on.data);assert.deepEqual(on.affine,[[.5,0,0,0],[0,.5,0,0],[0,0,1,0],[0,0,0,1]]);assert.deepEqual(off.sourceWorldToOutputWorld,[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]);
  point(transform(on.sourceWorldToOutputWorld,on.geometry.sourceOrigin),[0,0,0]);point(transform(on.outputWorldToSourceWorld,[0,0,0]),on.geometry.sourceOrigin);
  point(transform(on.sourceWorldToOutputWorld,[2,2,2]),[.5,.5,1]);point(transform(on.outputWorldToSourceWorld,[.5,.5,1]),[2,2,2]);point(on.physicalBounds.outputWorld.min,[0,0,0]);point(on.physicalBounds.outputWorld.max,[1,1,2]);point(on.supportBounds.outputWorld.min,[-.25,-.25,-.5]);point(on.supportBounds.outputWorld.max,[1.25,1.25,2.5]);
  for(const sourcePoint of [[1,4,2],[5,-2,9],[-7,8,-3]] as Vec3[])point(transform(on.outputWorldToSourceWorld,transform(on.sourceWorldToOutputWorld,sourcePoint)),sourcePoint);
});

test('right-handed positive rotation and positive-row convention are explicit geometry policies',()=>{
  const source=fillLinear(grid()),result=resliceProject(source,options({width:3,height:5,end:[2,2,2],rotationDegrees:90}));point(result.geometry.u,[0,1,0]);point(result.geometry.v,[-1,0,0]);point(result.geometry.sourceOrigin,[4,1,1]);point(Array.from(result.data).slice(0,3),[1140,1240,1340]);
  assert.deepEqual(createResliceProjectGeometry(options({rotationDegrees:450})),createResliceProjectGeometry(options({rotationDegrees:90})));
});

test('parallel, zero or omitted row-up vectors use a stable fallback around a vertical reslice line',()=>{
  const config=options({start:[1,1,1],end:[1,3,1]}),fallback=createResliceProjectGeometry(config),parallel=createResliceProjectGeometry({...config,up:[0,5,0]}),zero=createResliceProjectGeometry({...config,up:[0,0,0]});point(fallback.geometry.u,[0,0,1]);point(fallback.geometry.v,[1,0,0]);point(fallback.geometry.normal,[0,1,0]);point(fallback.geometry.sourceOrigin,[0,1,0]);assert.deepEqual(parallel,fallback);assert.deepEqual(zero,fallback);
});

test('a genuinely oblique stack retains correct physical interpolation over every output layer',()=>{
  const source=grid();for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<5;x++)source.data[x+5*(y+5*z)]=x+2*y+3*z;
  const result=resliceProject(source,options({start:[1,2,1],end:[3,2,3],pixelSize:.5,sliceDistance:Math.SQRT2})),expected:number[]=[];for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)expected.push(Math.fround(7+Math.SQRT1_2-x*Math.SQRT1_2+y+4*z));
  point(result.data,expected,2e-6);assert.deepEqual(result.dims,[3,3,3]);point(result.geometry.lastCenter,[3,2,3]);assert.equal(result.coverage.grayValid,27);
});

test('center-box gray support, half-cell nearest Mask support and positive half-integer ties remain distinct',()=>{
  const source=grid([2,1,1]);source.data.set([10,20]);const a=new Uint8Array([1,0]),b=new Uint8Array([1,1]),config=options({start:[-.5,0,0],end:[2.5,0,0],width:1,height:1,sliceDistance:.5,background:-99}),linear=resliceProject(source,config,[{id:'a',data:a},{id:'b',data:b}]),nearest=resliceProject(source,{...config,interpolation:'nearest'},[{id:'a',data:a},{id:'b',data:b}]);
  point(linear.data,[-99,10,15,20,-99,-99,-99]);point(nearest.data,[-99,10,20,20,-99,-99,-99]);point(linear.masks[0]!.data,[1,1,0,0,0,0,0]);point(linear.masks[1]!.data,[1,1,1,1,1,0,0]);assert.deepEqual(linear.masks,nearest.masks);assert.equal(linear.masks[0]!.count,2);assert.equal(linear.masks[1]!.count,5);assert.deepEqual(linear.coverage,{totalVoxels:7,grayValid:3,grayOutside:4,grayNonfinite:0,maskSupported:5,maskOutside:2});
});

test('nonfinite raw contributors use background, independently of nearest Mask memberships',()=>{
  const source=grid([3,1,1]);source.data.set([10,NaN,30]);const config=options({start:[0,0,0],end:[2,0,0],width:1,height:1,sliceDistance:.5,background:-7}),mask=new Uint8Array([1,1,1]),linear=resliceProject(source,config,[{id:'m',data:mask}]),nearest=resliceProject(source,{...config,interpolation:'nearest'},[{id:'m',data:mask}]);
  point(linear.data,[10,-7,-7,-7,30]);point(nearest.data,[10,-7,-7,30,30]);assert.equal(linear.coverage.grayNonfinite,3);assert.equal(nearest.coverage.grayNonfinite,2);assert.equal(linear.coverage.grayOutside,0);assert.equal(linear.masks[0]!.count,5);assert.ok(Number.isNaN(source.data[1]));
});

test('a cross-section exceeding the 2D MPR cap is resampled as a bounded 3D volume without hidden reduction',()=>{
  const source=grid([1,1,1]),result=resliceProject(source,options({start:[0,0,0],end:[0,0,1],width:2049,height:2048,sliceDistance:2,background:-2}));
  assert.deepEqual(result.dims,[2049,2048,1]);assert.equal(result.data.length,4_196_352);assert.ok(result.data.length>4*1024*1024);assert.equal(result.coverage.grayValid,0);assert.equal(result.coverage.maskSupported,2);assert.equal(result.data[0],-2);
});

test('output voxel and typed-buffer budgets include every independent Mask before any output allocation',()=>{
  const source=grid(),mask=new Uint8Array(125),config=options();assert.throws(()=>resliceProject(source,{...config,maxVoxels:26}),/体素预算/);assert.throws(()=>resliceProject(source,{...config,maxBytes:107}),/内存预算/);assert.throws(()=>resliceProject(source,{...config,maxBytes:134},[{id:'a',data:mask}]),/内存预算/);
  const exact=resliceProject(source,{...config,maxVoxels:27,maxBytes:162},[{id:'a',data:mask},{id:'b',data:mask}]);assert.equal(exact.data.length,27);assert.equal(exact.masks.length,2);assert.notEqual(exact.masks[0]!.data,exact.masks[1]!.data);
  for(const [key,maximum] of [['maxVoxels',MAX_RESLICE_PROJECT_VOXELS],['maxBytes',MAX_RESLICE_PROJECT_BYTES]] as const)for(const bad of [0,-1,1.5,NaN,Infinity,maximum+1])assert.throws(()=>resliceProject(source,{...config,[key]:bad}),/预算/);
});

test('cancellation covers source-Mask validation, output scanning and final progress without modifying inputs',()=>{
  const source=fillLinear(grid()),raw=source.data.slice(),mask=new Uint8Array(125).fill(1),before=mask.slice();assert.throws(()=>resliceProject(source,{...options(),cancelled:()=>true}),{name:'AbortError'});
  for(const threshold of [0,.1,1]){let cancel=false;const progress:number[]=[];assert.throws(()=>resliceProject(source,{...options(),cancelled:()=>cancel,progress:f=>{progress.push(f);if(f>=threshold)cancel=true;}},[{id:'m',data:mask}]),{name:'AbortError'});assert.ok(progress.every((n,i)=>n>=0&&n<=1&&(!i||n>=progress[i-1]!)));}
  const large=grid([64,64,4]),largeMask=new Uint8Array(large.data.length);let checks=0;assert.throws(()=>resliceProject(large,{...options(),cancelled:()=>++checks>=5},[{id:'m',data:largeMask}]),{name:'AbortError'});assert.deepEqual(source.data,raw);assert.deepEqual(mask,before);
});

test('invalid mask IDs, binary bytes and shapes reject before producing a partially valid new project',()=>{
  const source=grid(),valid=new Uint8Array(125),nonbinary=valid.slice();nonbinary[124]=255;
  for(const masks of [[{id:'',data:valid}],[{id:'same',data:valid},{id:'same',data:valid}],[{id:'m',data:new Uint8Array(2)}],[{id:'m',data:nonbinary}],[{id:'m',data:new Float32Array(125) as unknown as Uint8Array}]])assert.throws(()=>resliceProject(source,options(),masks),/Mask/);
  assert.throws(()=>resliceProject(source,options(),new Array(MAX_RESLICE_PROJECT_MASKS+1)),/Mask/);assert.ok(valid.every(n=>n===0));assert.equal(nonbinary[124],255);
});

test('gray or Mask allocation failure returns no partial output and never modifies raw source arrays',()=>{
  const source=fillLinear(grid()),raw=source.data.slice(),mask=new Uint8Array(125).fill(1),before=mask.slice(),nativeFloat32=globalThis.Float32Array,nativeUint8=globalThis.Uint8Array;
  try{
    globalThis.Float32Array=new Proxy(nativeFloat32,{construct(){throw new RangeError('synthetic gray allocation failure');}});assert.throws(()=>resliceProject(source,options(),[{id:'m',data:mask}]),/输出分配失败/);globalThis.Float32Array=nativeFloat32;
    globalThis.Uint8Array=new Proxy(nativeUint8,{construct(){throw new RangeError('synthetic Mask allocation failure');}});assert.throws(()=>resliceProject(source,options(),[{id:'m',data:mask}]),/输出分配失败/);
  }finally{globalThis.Float32Array=nativeFloat32;globalThis.Uint8Array=nativeUint8;}
  assert.deepEqual(source.data,raw);assert.deepEqual(mask,before);
});

test('invalid line, row vectors, sample counts, physical options and controls reject explicitly',()=>{
  const source=grid(),base=options();assert.throws(()=>createResliceProjectGeometry({...base,end:[...base.start]}),/正有限长度/);assert.throws(()=>createResliceProjectGeometry({...base,start:[NaN,0,0]}),/有限/);assert.throws(()=>createResliceProjectGeometry({...base,up:[0,Infinity,0]}),/有限/);
  for(const width of [0,-1,1.5,NaN,Infinity,MAX_RESLICE_PROJECT_DIMENSION+1])assert.throws(()=>createResliceProjectGeometry({...base,width}),/样本数/);
  for(const pixelSize of [0,-1,NaN,Infinity])assert.throws(()=>createResliceProjectGeometry({...base,pixelSize}),/正有限毫米/);for(const sliceDistance of [0,-1,NaN,Infinity])assert.throws(()=>createResliceProjectGeometry({...base,sliceDistance}),/正有限毫米/);
  assert.throws(()=>createResliceProjectGeometry({...base,rotationDegrees:NaN}),/角/);assert.throws(()=>createResliceProjectGeometry({...base,updateCoordinateSystem:1 as unknown as boolean}),/布尔/);assert.throws(()=>resliceProject(source,{...base,interpolation:'cubic' as 'linear'}),/插值/);for(const background of [NaN,Infinity,1e40])assert.throws(()=>resliceProject(source,{...base,background}),/Float32/);
  assert.throws(()=>resliceProject(source,{...base,progress:true as unknown as ()=>void}),/回调/);assert.throws(()=>resliceProject(source,{...base,cancelled:true as unknown as ()=>boolean}),/回调/);assert.throws(()=>createResliceProjectGeometry({...base,end:[Number.MAX_VALUE,0,0],sliceDistance:1}),/样本数|长度/);
});

test('source affine singularities, overflow, malformed arrays and data shape reject without sampling',()=>{
  const source=grid(),config=options();assert.throws(()=>resliceProject({...source,dims:[5,5,0]},config),/尺寸/);assert.throws(()=>resliceProject({...source,spacing:[0,1,1]},config),/间距/);assert.throws(()=>resliceProject({...source,data:new Float32Array(1)},config),/尺寸/);assert.throws(()=>resliceProject({...source,data:new Uint32Array(125) as unknown as Float32Array},config),/Float32/);
  assert.throws(()=>resliceProject({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,0,0]]},config),/不可逆/);assert.throws(()=>resliceProject({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,Infinity]]},config),/矩阵/);assert.throws(()=>resliceProject({...source,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,1,1]]},config),/透视/);assert.throws(()=>resliceProject({...source,affine:[[1e308,0,0,0],[0,1,0,0],[0,0,1,0]]},config),/有限/);
});
