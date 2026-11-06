import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fillHoles} from '../src/mimics/segmentation.ts';
import type {GrowOptions} from '../src/mimics/segmentation.ts';
import type {Vec3,VolumeGrid} from '../src/mimics/types.ts';

// Classify every tiny background component independently. Unlike the optimized
// algorithm, this oracle does not start a combined flood from exterior seeds.
function reference(g:VolumeGrid,source:Uint8Array,o:GrowOptions){
 const result=Uint8Array.from(source,value=>value?1:0),seen=new Set<number>();
 const min=o.roi?[...o.roi.min]:[0,0,0],max=o.roi?[...o.roi.max]:g.dims.map(n=>n-1);if(o.plane)min[o.plane.axis]=max[o.plane.axis]=o.plane.index;
 const point=(i:number)=>{const x=i%g.dims[0],row=(i-x)/g.dims[0],y=row%g.dims[1];return[x,y,(row-y)/g.dims[1]];};
 for(let z=min[2]!;z<=max[2]!;z++)for(let y=min[1]!;y<=max[1]!;y++)for(let x=min[0]!;x<=max[0]!;x++){
  const first=x+g.dims[0]*(y+g.dims[1]*z);if(source[first]||seen.has(first))continue;
  const component=[first];seen.add(first);let exterior=false;
  for(let head=0;head<component.length;head++){
   const p=point(component[head]!);if(p.some((v,a)=>a!==o.plane?.axis&&(v===min[a]||v===max[a])))exterior=true;
   for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const distance=Math.abs(dx)+Math.abs(dy)+Math.abs(dz);if(!distance||(o.connectivity??6)===6&&distance!==1)continue;
    const q=[p[0]!+dx,p[1]!+dy,p[2]!+dz];if(q.some((v,a)=>v<min[a]!||v>max[a]!))continue;
    const i=q[0]!+g.dims[0]*(q[1]!+g.dims[1]*q[2]!);if(source[i]||seen.has(i))continue;seen.add(i);component.push(i);
   }
  }
  if(!exterior)for(const i of component)result[i]=1;
 }
 return result;
}

test('bounded hole filling matches component classification for 2D/3D, diagonal leakage and clipped ROIs',()=>{
 let random=4797;const next=()=>((random=Math.imul(random,1664525)+1013904223>>>0)/2**32);
 for(let n=0;n<120;n++){
  const dims:Vec3=[9,8,7],g={dims,spacing:[1,1,3] as Vec3,data:new Float32Array(9*8*7).fill(NaN)},source=Uint8Array.from(g.data,()=>next()<.6?2:0),before=source.slice();
  const options:GrowOptions={connectivity:n&1?26:6};
  if(n%3===0)options.roi={min:[1,2,1],max:[7,6,5]};
  if(n%4===0)options.plane={axis:(n%3) as 0|1|2,index:3};
  const expected=reference(g,source,options),actual=fillHoles(g,source,options);
  assert.deepEqual(actual.mask,expected);assert.equal(actual.count,expected.reduce((sum,value)=>sum+value,0));assert.deepEqual(source,before);
 }
});

test('hole-fill memory rejection and cancellation preserve the input and can be followed by a successful retry',()=>{
 const dims:Vec3=[32,32,8],g={dims,spacing:[1,1,1] as Vec3,data:new Float32Array(8192)},source=new Uint8Array(8192),before=source.slice();
 assert.throws(()=>fillHoles(g,source,{maxWorkingBytes:16}),/填充孔洞.*工作内存预算/);
 assert.throws(()=>fillHoles(g,source,{maxWorkingBytes:1056}),/填充孔洞.*工作内存预算/);
 assert.throws(()=>fillHoles(g,source,{maxWorkingBytes:NaN}),/预算无效/);
 let calls=0;assert.throws(()=>fillHoles(g,source,{cancelled:()=>++calls>8}),{name:'AbortError'});
 assert.deepEqual(source,before);assert.equal(fillHoles(g,source).count,0);
});

test('a planar hole flood only allocates its domain bitset and preserves other slices',()=>{
 const dims:Vec3=[32,24,10],g={dims,spacing:[1,1,1] as Vec3,data:new Float32Array(32*24*10)},source=new Uint8Array(g.data.length).fill(2);
 source[16+32*(12+24*4)]=0;source[16+32*(12+24*5)]=0;
 const Original=globalThis.Uint8Array,allocations:number[]=[];
 globalThis.Uint8Array=new Proxy(Original,{construct(target,args){if(typeof args[0]==='number')allocations.push(args[0]);return Reflect.construct(target,args);}});
 try{
  const result=fillHoles(g,source,{plane:{axis:2,index:4}});
  assert.deepEqual(allocations,[source.length,32*24/8]);assert.equal(result.mask[16+32*(12+24*4)],1);assert.equal(result.mask[16+32*(12+24*5)],0);
 }finally{globalThis.Uint8Array=Original;}
});

test('a highly fragmented multi-million-voxel background does not create millions of RLE objects',()=>{
 const module=new URL('../src/mimics/segmentation.ts',import.meta.url).href;
 const code=`import {fillHoles} from ${JSON.stringify(module)}; const dims=[256,128,128],count=dims[0]*dims[1]*dims[2],data=new Float32Array(count),source=new Uint8Array(count);let expected=count;for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++){const i=x+dims[0]*(y+dims[1]*z);source[i]=(x+y+z)%2;if(!source[i]&&(x===0||y===0||z===0||x===dims[0]-1||y===dims[1]-1||z===dims[2]-1))expected--;}const result=fillHoles({dims,spacing:[1,1,1],data},source,{connectivity:6,maxWorkingBytes:2*1024*1024});if(result.count!==expected)throw new Error('incorrect closed holes');if(source[0]!==0||source[1]!==1)throw new Error('source changed');console.log(result.count);`;
 const child=spawnSync(process.execPath,['--max-old-space-size=48','--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',timeout:60_000,maxBuffer:1024*1024});
 assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/\d+/);
});
