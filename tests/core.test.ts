import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyThreshold, exportNifti, indexOf, makeDemo, paint, parseNifti, planePoint } from '../src/core.ts';

test('native 16-bit CT avoids a full Float32 copy while scaled grayscale stays exact',()=>{
  const buffer=new ArrayBuffer(368),view=new DataView(buffer);
  view.setInt32(0,348,true);view.setInt16(40,3,true);
  [2,2,2].forEach((size,axis)=>{view.setInt16(42+axis*2,size,true);view.setFloat32(80+axis*4,1,true);});
  view.setInt16(70,4,true);view.setInt16(72,16,true);view.setFloat32(108,352,true);view.setFloat32(112,1,true);
  new Uint8Array(buffer,344,4).set([110,43,49,0]);view.setInt16(352,-32768,true);view.setInt16(366,32767,true);
  const original=buffer.slice(0),volume=parseNifti(buffer);
  assert.equal(volume.data.byteLength,16);assert.equal(volume.min,-32768);assert.equal(volume.max,32767);
  const labels=new Uint16Array(8);applyThreshold(volume.data,labels,{minimum:-32768,maximum:-32768,label:1});assert.equal(labels[0],1);
  assert.deepEqual(buffer,original,'Displaying and thresholding must not modify source voxels');
  view.setFloat32(112,.5,true);view.setFloat32(116,-100,true);const scaled=parseNifti(buffer);
  assert.ok(scaled.data instanceof Float32Array);assert.equal(scaled.data[0],-16484);assert.equal(scaled.data[7],16283.5);
});

test('exported labels preserve voxel positions, spatial geometry and intent',()=>{
  const volume=makeDemo(), labels=new Uint16Array(volume.data.length);
  labels[indexOf([13,21,32],volume.dims)]=7;
  labels[indexOf([80,70,12],volume.dims)]=300;
  const bytes=exportNifti(volume,labels), restored=parseNifti(bytes);
  assert.deepEqual(restored.dims,volume.dims);
  assert.deepEqual(restored.affine,volume.affine);
  assert.deepEqual(restored.spacing,volume.spacing);
  assert.equal(restored.data[indexOf([13,21,32],volume.dims)],7);
  assert.equal(restored.data[indexOf([80,70,12],volume.dims)],300);
  assert.equal(restored.data.reduce((s,n)=>s+(n>0?1:0),0),2);
  assert.equal(new DataView(bytes).getInt16(68,true),1002);
});
test('brush affects the chosen plane, respects spacing and selectively erases',()=>{
  const volume={dims:[9,9,9] as [number,number,number],spacing:[1,2,3] as [number,number,number]};
  for(const axis of [0,1,2] as const){
    const mask=new Uint16Array(729), before=new Map<number,number>();
    paint(mask,volume,axis,4,4,4,4,2,before);
    assert.equal(mask[indexOf(planePoint(axis,4,4,4),volume.dims)],2);
    for(const i of before.keys()){
      const point=[i%9,Math.floor(i/9)%9,Math.floor(i/81)];assert.equal(point[axis],4);
    }
    const snapshot=mask.slice();
    paint(mask,volume,axis,4,4,4,4,0,new Map(),3);assert.deepEqual(mask,snapshot);
    paint(mask,volume,axis,4,4,4,4,0,before,2);assert.equal(mask.some(Boolean),false);
    for(const [i,value]of before)mask[i]=value;assert.equal(mask.some(Boolean),false);
  }
});
test('rejects truncated, 4D and malformed input instead of silently loading',()=>{
  assert.throws(()=>parseNifti(new ArrayBuffer(50)),/文件过短/);
  const good=exportNifti(makeDemo(),new Uint16Array(96*96*64));
  assert.throws(()=>parseNifti(good.slice(0,400)),/不完整/);
  const view=new DataView(good);view.setInt16(40,4,true);view.setInt16(48,2,true);
  assert.throws(()=>parseNifti(good),/时间序列/);
});
test('big endian input and label export preserve endian and affine',()=>{
  const buffer=new ArrayBuffer(368),v=new DataView(buffer);
  v.setInt32(0,348);v.setInt16(40,3);[2,2,2].forEach((n,a)=>{v.setInt16(42+a*2,n);v.setFloat32(80+a*4,2);});
  v.setInt16(70,4);v.setInt16(72,16);v.setFloat32(108,352);v.setFloat32(112,2);v.setFloat32(116,-100);
  new Uint8Array(buffer,344,4).set([110,43,49,0]);v.setInt16(352,50);v.setInt16(366,100);
  const volume=parseNifti(buffer);assert.equal(volume.little,false);assert.equal(volume.data[0],0);assert.equal(volume.data[7],100);
  const labels=new Uint16Array(8);labels[7]=500;
  const restored=parseNifti(exportNifti(volume,labels));assert.equal(restored.data[7],500);assert.equal(restored.data[0],0);
});
test('qform rotation and metre units have correct display spacing and original export geometry',()=>{
  const buffer=exportNifti(makeDemo(),new Uint16Array(96*96*64)),v=new DataView(buffer);
  v.setInt16(254,0,true);v.setInt16(252,1,true);v.setFloat32(264,Math.SQRT1_2,true);v.setFloat32(76,-1,true);v.setUint8(123,1);
  const volume=parseNifti(buffer);assert.ok(Math.abs(volume.affine[1][0]-1)<1e-5);assert.equal(volume.affine[2][2],-1.5);
  assert.ok(Math.abs(volume.spacing[0]-1000)<.001);assert.equal(volume.unit,'mm');
  const restored=parseNifti(exportNifti(volume,new Uint16Array(volume.data.length)));assert.deepEqual(restored.affine,volume.affine);
});

test('threshold includes both endpoints, replaces current label, preserves other labels outside range and is reversible',()=>{
  const data=Float32Array.from([-1,0,5,10,11,100]), mask=Uint16Array.from([1,2,2,0,1,3]), original=mask.slice();
  const {change,matched}=applyThreshold(data,mask,{minimum:0,maximum:10,label:1});
  assert.equal(matched,3);assert.deepEqual([...mask],[0,1,1,1,0,3]);assert.ok(change);
  const result=mask.slice();change.indices.forEach((i,k)=>{mask[i]=change.before[k];});assert.deepEqual(mask,original);
  change.indices.forEach((i,k)=>{mask[i]=change.after[k];});assert.deepEqual(mask,result);
  assert.equal(applyThreshold(data,mask,{minimum:0,maximum:10,label:1}).change,null);
});
test('single-value and fractional threshold ranges use scaled grayscale and no-match clears only current label',()=>{
  const data=Float32Array.from([-.5,.5,1.5]), mask=Uint16Array.from([8,0,3]);
  const {matched}=applyThreshold(data,mask,{minimum:.5,maximum:.5,label:8});
  assert.equal(matched,1);assert.deepEqual([...mask],[0,8,3]);
  const empty=applyThreshold(data,mask,{minimum:5,maximum:6,label:8});
  assert.equal(empty.matched,0);assert.deepEqual([...mask],[0,0,3]);
});
test('invalid threshold inputs do not mutate the labelmap',()=>{
  const data=Float32Array.from([1,2,3]),mask=Uint16Array.from([1,0,2]),original=mask.slice();
  for(const range of [{minimum:2,maximum:1,label:1},{minimum:NaN,maximum:3,label:1},{minimum:0,maximum:Infinity,label:1},{minimum:0,maximum:3,label:0}]) {
    assert.throws(()=>applyThreshold(data,mask,range));assert.deepEqual(mask,original);
  }
  assert.throws(()=>applyThreshold(new Float32Array(2),mask,{minimum:0,maximum:3,label:1}));assert.deepEqual(mask,original);
});

test('collaborative brush records same-color touches so other versions can converge',()=>{
  const volume={dims:[3,3,3] as [number,number,number],spacing:[1,1,1] as [number,number,number]},mask=new Uint16Array(27).fill(1);
  const ordinary=new Map<number,number>();paint(mask,volume,2,1,1,1,2,1,ordinary);assert.equal(ordinary.size,0);
  const shared=new Map<number,number>();paint(mask,volume,2,1,1,1,2,1,shared,undefined,true);assert.ok(shared.size>0);assert.equal([...shared.values()].every(n=>n===1),true);
});
