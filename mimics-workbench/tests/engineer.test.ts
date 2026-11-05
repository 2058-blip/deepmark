import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grayPixels} from '../src/sliceRenderer.ts';
import {extractSlice,fillSliceRegion,slicePixelsToVoxels} from '../src/sliceData.ts';
import {levelRegion,partitionGray,regionOutline} from '../src/grayRegions.ts';
test('gray partition distinguishes connected regions, negative grayscale and enclosed holes',()=>{
  const data=new Float32Array(25).fill(-1000);for(let y=1;y<4;y++)for(let x=1;x<4;x++)data[x+y*5]=40;data[12]=120;
  const before=data.slice(),p=partitionGray(data,5,5,100),soft=p.labels[6],lesion=p.labels[12];assert.notEqual(soft,lesion);assert.notEqual(soft,p.labels[0]);
  const pixels=p.order.subarray(p.offsets[soft],p.offsets[soft+1]);assert.equal(pixels.length,8);const outline=regionOutline(data,5,5,pixels,i=>p.labels[i]===soft);
  assert.match(outline.path,/M1,1H4/);assert.match(outline.path,/M2,2H3/);assert.equal(outline.minimum,40);assert.equal(outline.maximum,40);assert.equal(outline.truncated,false);assert.deepEqual(data,before);
  const disconnected=partitionGray(Float32Array.from([10,-1000,-1000,-1000,10]),5,1,100);assert.notEqual(disconnected.labels[0],disconnected.labels[4]);
  assert.throws(()=>partitionGray(data,5,5,0));assert.throws(()=>partitionGray(data,4,5,100));
});
test('level preview follows seed grayscale and its connected foreground only',()=>{
  const data=Float32Array.from([0,20,0,0,15,25,0,0,0]),region=levelRegion(data,3,3,4);assert.deepEqual([...region.pixels].sort(),[1,4,5]);assert.equal(region.level,15);assert.equal(region.seen[0],0);
  const outline=regionOutline(data,3,3,region.pixels,i=>!!region.seen[i]);assert.equal(outline.count,3);assert.equal(outline.minimum,15);assert.equal(outline.maximum,25);assert.ok(outline.path);
});
test('slice extraction and clicked region fill retain correct coordinates in all three planes',()=>{
  const dims:[number,number,number]=[3,4,2],data=Float32Array.from({length:24},(_,i)=>i);
  assert.deepEqual([...extractSlice({dims,data},2,1)],[21,22,23,18,19,20,15,16,17,12,13,14]);
  for(const [axis,slice,pixels,expected]of [[2,1,[0,11],[21,14]],[0,1,[0,7],[13,10]],[1,2,[0,5],[18,8]]] as const){
    const selected=Uint32Array.from(pixels),indices=slicePixelsToVoxels(dims,axis,slice,selected);assert.deepEqual([...indices],expected);
    const mask=new Uint16Array(24),change=fillSliceRegion(mask,dims,axis,slice,selected,3)!;assert.deepEqual([...change.indices],expected);assert.equal(mask.reduce((n,v)=>n+(v?1:0),0),2);
    change.indices.forEach((i,k)=>{mask[i]=change.before[k];});assert.equal(mask.some(Boolean),false);change.indices.forEach((i,k)=>{mask[i]=change.after[k];});assert.equal(mask[expected[0]],3);
    assert.equal(fillSliceRegion(mask,dims,axis,slice,selected,3),null);assert.ok(fillSliceRegion(mask,dims,axis,slice,selected,3,true));
  }
  const mask=new Uint16Array(24);assert.throws(()=>fillSliceRegion(mask,dims,2,1,Uint32Array.from([99]),1));assert.equal(mask.some(Boolean),false);
});
test('window display clamps values without modifying the raw grayscale used for region detection',()=>{
  const data=Float32Array.from([-1000,0,50,100,1000]),before=data.slice(),out=new Uint8ClampedArray(20);grayPixels(data,50,100,out);
  const gray=[...out.filter((_,i)=>i%4===0)];assert.deepEqual(gray.slice(0,2),[0,0]);assert.ok(Math.abs(gray[2]-127.5)<=.5);assert.deepEqual(gray.slice(3),[255,255]);assert.deepEqual(data,before);
});
