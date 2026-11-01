import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exteriorAir,ExteriorAirCache} from '../src/exteriorAir.ts';
import {applyThreshold,paint,indexOf} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import {partitionGray,levelRegion} from '../src/grayRegions.ts';
import {sliceBox,sliceCoords,dragZoom} from '../src/sliceGeometry.ts';

function phantom(){const plane=new Float32Array(49).fill(-1000);for(let y=1;y<6;y++)for(let x=1;x<6;x++)plane[x+y*7]=40;for(let y=2;y<5;y++)for(let x=2;x<5;x++)plane[x+y*7]=-1000;return plane;}
test('exterior-air filtering preserves enclosed air and follows eight-connected slice borders',()=>{
  const plane=phantom(),air=exteriorAir(plane,7,7);assert.equal(air[0],1);assert.equal(air[3+3*7],0);assert.equal(air[1+3*7],0);assert.equal(air.reduce((sum,v)=>sum+v,0),24);
  plane[1+7]=-1000;assert.equal(exteriorAir(plane,7,7)[3+3*7],1);assert.throws(()=>exteriorAir(plane,7,7,NaN));
});
test('threshold and paint omit exterior air while preserving old results and allowing erasure',()=>{
  const data=new Float32Array(147);for(let z=0;z<3;z++)data.set(phantom(),z*49);
  const volume={dims:[7,7,3],spacing:[1,1,1],data} as Volume,cache=new ExteriorAirCache(volume),mask=new Uint16Array(147);mask[0]=1;mask[1]=2;
  const result=applyThreshold(data,mask,{minimum:-1000,maximum:-900,label:1},i=>cache.voxel(i));assert.equal(result.matched,27);assert.equal(mask[0],1);assert.equal(mask[1],2);assert.equal(mask[indexOf([3,3,1],volume.dims)],1);assert.equal(mask[indexOf([6,6,1],volume.dims)],0);
  const excluded=cache.slice(2,0),before=new Map<number,number>();paint(mask,volume,2,0,6,0,1,2,before,undefined,false,(x,y)=>!!excluded[x+(6-y)*7]);assert.equal(mask[6],0);assert.equal(before.size,0);
  paint(mask,volume,2,0,1,0,1,0,before,2,false,()=>true);assert.equal(mask[1],0);assert.equal(before.size,1);
});
test('excluded regions cannot connect two otherwise separated gray selections',()=>{
  const data=new Float32Array(9),excluded=Uint8Array.from([0,1,0,0,1,0,0,1,0]),partition=partitionGray(data,3,3,100,excluded);assert.equal(partition.count,2);assert.equal(partition.labels[1],0);assert.notEqual(partition.labels[0],partition.labels[2]);
  assert.deepEqual([...levelRegion(data,3,3,3,excluded).pixels].sort((a,b)=>a-b),[0,3,6]);
});
test('zoomed slice coordinates and physical brush sizes stay aligned',()=>{
  for(const zoom of [.25,1,2.5,8]){const box=sliceBox([600,420],96,64,.7,1.4,zoom),point=[27.25,39.5],screen=[box.ox+(point[0]+.5)/96*box.w,box.oy+(64-point[1]-.5)/64*box.h],restored=sliceCoords(box,...screen as [number,number])!;assert.ok(Math.abs(restored[0]-point[0])<1e-10);assert.ok(Math.abs(restored[1]-point[1])<1e-10);assert.ok(Math.abs(8/.7*box.w/96-8/1.4*box.h/64)<1e-10);assert.equal(sliceCoords(box,box.ox-1,box.oy),null);}
  assert.ok(dragZoom(1,300,200)>1);assert.ok(dragZoom(1,200,300)<1);assert.equal(dragZoom(1,10000,0),8);assert.equal(dragZoom(1,0,10000),.25);
});

test('collaborative erasure targets only a personal opinion and waits for the server before changing the combined mask',()=>{
  const dims:[number,number,number]=[3,3,1],volume={dims,spacing:[1,1,1] as [number,number,number]},mask=new Uint16Array(9).fill(1),before=new Map<number,number>();
  paint(mask,volume,2,0,1,1,1,0,before,1,true,undefined,{personalValue:()=>null,deferErase:true});assert.equal(before.size,0);assert.equal(mask[4],1);
  paint(mask,volume,2,0,1,1,1,0,before,2,true,undefined,{personalValue:()=>2,deferErase:true});assert.equal(before.get(4),2);assert.equal(mask[4],1);
  const result=applyThreshold(new Float32Array(9).fill(40),mask,{minimum:100,maximum:200,label:2},undefined,i=>i===4?2:null,true);assert.deepEqual([...result.change!.indices],[4]);assert.equal(result.change!.before[0],2);assert.equal(result.change!.after[0],0);assert.equal(mask[4],1);
});
