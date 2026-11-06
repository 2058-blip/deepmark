import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dynamicRegionGrow} from '../src/mimics/segmentation.ts';
import type {DynamicGrowOptions} from '../src/mimics/segmentation.ts';
import {VoxelFifo} from '../src/mimics/voxelFifo.ts';
import type {Vec3,VolumeGrid} from '../src/mimics/types.ts';

// Kept deliberately straightforward: this is the pre-optimization FIFO behavior,
// including z/y/x ordering, online mean drift and permanently rejected candidates.
function reference(g:VolumeGrid,seed:Vec3,o:DynamicGrowOptions){
 const mask=new Uint8Array(g.data.length),visited=new Set<number>(),queue=[seed[0]+g.dims[0]*(seed[1]+g.dims[1]*seed[2])];
 const min=o.roi?[...o.roi.min]:[0,0,0],max=o.roi?[...o.roi.max]:g.dims.map(n=>n-1);if(o.plane)min[o.plane.axis]=max[o.plane.axis]=o.plane.index;
 mask[queue[0]!]=1;visited.add(queue[0]!);let mean=g.data[queue[0]!]!,count=1;
 for(let head=0;head<queue.length;head++){
  const current=queue[head]!,x=current%g.dims[0],row=(current-x)/g.dims[0],y=row%g.dims[1],z=(row-y)/g.dims[1];
  for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   const distance=Math.abs(dx)+Math.abs(dy)+Math.abs(dz);if(!distance||(o.connectivity??6)===6&&distance!==1)continue;
   const p=[x+dx,y+dy,z+dz];if(p.some((v,a)=>v<min[a]!||v>max[a]!))continue;
   const i=p[0]!+g.dims[0]*(p[1]!+g.dims[1]*p[2]!);if(visited.has(i))continue;visited.add(i);
   const value=g.data[i]!;if(Number.isFinite(value)&&mean-o.lowerDeviation<value&&value<mean+o.upperDeviation){mask[i]=1;queue.push(i);if(o.updateMean)mean+=(value-mean)/(count+1);count++;}
  }
 }
 return{mask,count};
}

test('bounded FIFO preserves address order while recycling consumed blocks',()=>{
 const queue=new VoxelFifo(24,100,2);
 queue.push(0);queue.push(0xffffffff);queue.push(2);queue.push(3);
 assert.equal(queue.shift(),0);assert.equal(queue.shift(),0xffffffff);
 queue.push(4);queue.push(5);assert.equal(queue.allocatedBytes,16);
 assert.deepEqual(Array.from({length:4},()=>queue.shift()),[2,3,4,5]);
 for(let i=0;i<10000;i++){queue.push(i);assert.equal(queue.shift(),i);}
 assert.equal(queue.length,0);assert.equal(queue.shift(),undefined);assert.equal(queue.allocatedBytes,16);
 const limited=new VoxelFifo(8,100,2);limited.push(1);limited.push(2);assert.throws(()=>limited.push(3),/工作内存预算/);
});

test('dynamic growth exactly matches the previous algorithm for changing means, connectivity and domains',()=>{
 let random=93497;const next=()=>((random=Math.imul(random,1664525)+1013904223>>>0)/2**32);
 for(let n=0;n<120;n++){
  const dims:Vec3=[7,6,5],data=Float32Array.from({length:210},()=>Math.floor(next()*24)-12),g={dims,spacing:[1,2,3] as Vec3,data};
  for(let i=0;i<4;i++)data[Math.floor(next()*data.length)]=NaN;
  const seed:Vec3=[3,2,2];data[seed[0]+7*(seed[1]+6*seed[2])]=0;
  const options:DynamicGrowOptions={lowerDeviation:1+next()*15,upperDeviation:1+next()*15,updateMean:!!(n&1),connectivity:n&2?26:6};
  if(n%3===0)options.roi={min:[1,1,1],max:[5,4,3]};
  if(n%4===0)options.plane={axis:(n%3) as 0|1|2,index:seed[n%3]!};
  assert.deepEqual(dynamicRegionGrow(g,seed,options),reference(g,seed,options));
 }
});

test('single-slice and ROI visitation allocate one bit per domain voxel, not per full CT voxel',()=>{
 const dims:Vec3=[32,24,10],g={dims,spacing:[1,1,1] as Vec3,data:new Float32Array(32*24*10)};
 const Original=globalThis.Uint8Array,allocations:number[]=[];
 globalThis.Uint8Array=new Proxy(Original,{construct(target,args){if(typeof args[0]==='number')allocations.push(args[0]);return Reflect.construct(target,args);}});
 try{
  const result=dynamicRegionGrow(g,[16,12,4],{lowerDeviation:1,upperDeviation:1,plane:{axis:2,index:4}});
  assert.equal(result.count,32*24);assert.deepEqual(allocations,[g.data.length,32*24/8]);
  allocations.length=0;
  assert.equal(dynamicRegionGrow(g,[16,12,4],{lowerDeviation:1,upperDeviation:1,roi:{min:[15,11,3],max:[17,13,5]}}).count,27);
  assert.deepEqual(allocations,[g.data.length,4]);
 }finally{globalThis.Uint8Array=Original;}
});

test('a working-memory rejection or cancellation leaves the source intact and allows a later retry',()=>{
 const dims:Vec3=[32,32,8],g={dims,spacing:[1,1,1] as Vec3,data:new Float32Array(8192).fill(40)},before=g.data.slice();
 assert.throws(()=>dynamicRegionGrow(g,[16,16,4],{lowerDeviation:1,upperDeviation:1,maxWorkingBytes:16}),/工作内存预算/);
 assert.throws(()=>dynamicRegionGrow(g,[16,16,4],{lowerDeviation:1,upperDeviation:1,maxWorkingBytes:1056}),/工作内存预算/);
 assert.deepEqual(g.data,before);
 let calls=0;assert.throws(()=>dynamicRegionGrow(g,[16,16,4],{lowerDeviation:1,upperDeviation:1,cancelled:()=>++calls>8}),{name:'AbortError'});
 assert.deepEqual(g.data,before);assert.equal(dynamicRegionGrow(g,[16,16,4],{lowerDeviation:1,upperDeviation:1}).count,g.data.length);
});

test('dense multi-million-voxel growth completes under a small JavaScript heap without an N-sized number queue',()=>{
 const module=new URL('../src/mimics/segmentation.ts',import.meta.url).href;
 const code=`import {dynamicRegionGrow} from ${JSON.stringify(module)}; const data=new Float32Array(256*128*128).fill(40); const result=dynamicRegionGrow({dims:[256,128,128],spacing:[1,1,1],data},[128,64,64],{lowerDeviation:1,upperDeviation:1,updateMean:true,maxWorkingBytes:2*1024*1024}); if(result.count!==data.length)throw new Error('count mismatch'); console.log(result.count);`;
 const child=spawnSync(process.execPath,['--max-old-space-size=48','--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',timeout:60_000,maxBuffer:1024*1024});
 assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/4194304/);
});
