import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'fflate';
import {parseNifti,parseNiftiHeader} from '../src/core.ts';
import {decodeNiftiStream,NiftiStreamDecoder,readNiftiFile} from '../src/niftiIO.ts';
import {checkedVoxelCount,checkedVoxelLength} from '../src/volumeCapacity.ts';
import {OperationClient} from '../src/mimics/operationClient.ts';

const formats:{kind:number;bytes:number;setter:string;signed?:boolean;float?:boolean}[]=[
  {kind:2,bytes:1,setter:'setUint8'},{kind:4,bytes:2,setter:'setInt16',signed:true},
  {kind:8,bytes:4,setter:'setInt32',signed:true},{kind:16,bytes:4,setter:'setFloat32',float:true},
  {kind:64,bytes:8,setter:'setFloat64',float:true},{kind:256,bytes:1,setter:'setInt8',signed:true},
  {kind:512,bytes:2,setter:'setUint16'},{kind:768,bytes:4,setter:'setUint32'},
];
function header(dims=[3,2,2],format=formats[1]!,little=true,offset=413){
  const bytes=new Uint8Array(352),v=new DataView(bytes.buffer);
  v.setInt32(0,348,little);v.setInt16(40,3,little);
  dims.forEach((n,a)=>{v.setInt16(42+2*a,n,little);v.setFloat32(80+4*a,[.6,.7,1.5][a]!,little);});
  v.setInt16(70,format.kind,little);v.setInt16(72,format.bytes*8,little);
  v.setFloat32(108,offset,little);v.setFloat32(112,1.5,little);v.setFloat32(116,-3.25,little);
  v.setUint8(123,2);bytes.set([110,43,49,0],344);return bytes;
}
function fixture(format=formats[1]!,little=true){
  const bytes=new Uint8Array(413+12*format.bytes);bytes.set(header(undefined,format,little));
  const v=new DataView(bytes.buffer),write=(v[format.setter as keyof DataView] as (offset:number,value:number,little:boolean)=>void).bind(v);
  for(let i=0;i<12;i++)write(413+i*format.bytes,i-(format.signed?6:0)+(format.float?.25:0),little);
  return bytes;
}
function chunks(bytes:Uint8Array,sizes=[1,2,7,3,11]){
  let offset=0,part=0;
  return new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(bytes.length,offset+sizes[part++%sizes.length]!);controller.enqueue(bytes.subarray(offset,end));offset=end;}});
}
test('all supported scalar types, endianness, scaling and unaligned header/pixel chunks match the canonical parser',async()=>{
  for(const format of formats)for(const little of [true,false]){
    const bytes=fixture(format,little),expected=parseNifti(bytes.buffer,'sample.nii');
    const actual=await decodeNiftiStream(chunks(bytes),'sample.nii',{},bytes.length);
    assert.deepEqual(actual,expected);
  }
});
test('header planning accepts images beyond the old voxel quota without allocating a dummy image',()=>{
  for(const dims of [[513,512,512],[512,512,768],[1024,1024,1024]]){
    const bytes=header(dims),layout=parseNiftiHeader(bytes.buffer);
    assert.equal(layout.count,dims.reduce((a,b)=>a*b,1));assert.deepEqual(layout.volume.dims,dims);
  }
  assert.throws(()=>checkedVoxelCount([32767,32767,32767]),/32位/);
  assert.throws(()=>checkedVoxelCount([32768,2,2]),/32767/);
  assert.throws(()=>checkedVoxelLength(NaN),/无效/);
  assert.throws(()=>checkedVoxelLength(0),/无效/);
});
test('real raw and gzip Files stream without reading the whole file through arrayBuffer',async()=>{
  const raw=fixture(formats[4]!,false);
  for(const compressed of [false,true]){
    const file=new File([compressed?gzipSync(raw):raw],compressed?'image.nii.gz':'image.nii');
    Object.defineProperty(file,'arrayBuffer',{value:()=>{throw new Error('Whole-file read was attempted');}});
    const updates:number[]=[],actual=await readNiftiFile(file,{onProgress:p=>updates.push(p.fraction)});
    assert.deepEqual(actual,parseNifti(raw.buffer,file.name));assert.equal(updates.at(-1),1);
  }
});
test('truncated pixels, short headers, invalid metadata and nonfinite values are rejected',async()=>{
  const bytes=fixture();
  await assert.rejects(decodeNiftiStream(chunks(bytes.subarray(0,-1)),'truncated.nii'),/不完整/);
  await assert.rejects(decodeNiftiStream(chunks(bytes.subarray(0,200)),'short.nii'),/文件过短/);
  const invalid=fixture();new DataView(invalid.buffer).setFloat32(80,0,true);
  await assert.rejects(decodeNiftiStream(chunks(invalid),'spacing.nii'),/间距/);
  const invalidValue=fixture(formats[4]!);new DataView(invalidValue.buffer).setFloat64(413,Infinity,true);
  await assert.rejects(decodeNiftiStream(chunks(invalidValue),'value.nii'),/非有限/);
  const truncatedGzip=gzipSync(bytes).subarray(0,-4);
  await assert.rejects(readNiftiFile(new File([truncatedGzip],'truncated.nii.gz')));
});
test('aborting an import cancels the source stream and cannot publish a partially decoded image',async()=>{
  const control=new AbortController();let cancelled=false,pulls=0;
  const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array([0]));},cancel(){cancelled=true;}});
  await assert.rejects(decodeNiftiStream(stream,'cancel.nii',{signal:control.signal,onProgress:()=>control.abort()}),{name:'AbortError'});
  assert.equal(cancelled,true);assert.ok(pulls<10);
  const alreadyCancelled=new AbortController();alreadyCancelled.abort();
  await assert.rejects(decodeNiftiStream(chunks(fixture()),'cancelled.nii',{signal:alreadyCancelled.signal}),{name:'AbortError'});
});
test('stream decoder keeps a sample spanning multiple chunks and ignores permitted trailing bytes',()=>{
  const bytes=fixture(formats[4]!),decoder=new NiftiStreamDecoder('sample.nii');
  for(let i=0;i<bytes.length;i++)decoder.push(bytes.subarray(i,i+1));
  decoder.push(new Uint8Array([1,2,3]));assert.deepEqual(decoder.finish(),parseNifti(bytes.buffer,'sample.nii'));
});
test('loading a volume does not duplicate its voxel array in an unused compute worker',async()=>{
  const previous=globalThis.Worker,created:any[]=[];
  class FakeWorker{
    onmessage:any;onerror:any;messages:any[]=[];terminated=false;
    constructor(){created.push(this);}
    postMessage(message:any){this.messages.push(message);if(message.type==='run')queueMicrotask(()=>this.onmessage({data:{type:'result',id:message.id,result:42}}));}
    terminate(){this.terminated=true;}
  }
  globalThis.Worker=FakeWorker as any;
  const client=new OperationClient(),grid={dims:[2,2,2] as [number,number,number],spacing:[1,1,1] as [number,number,number],data:new Float32Array(8)};
  try{
    client.initialize(grid);assert.equal(created.length,0);
    assert.equal(await client.run({kind:'test'}),42);assert.equal(created.length,1);
    assert.equal(created[0].messages[0].grid,grid);
    client.initialize(grid);assert.equal(created[0].terminated,true);assert.equal(created.length,1);
  }finally{client.dispose();globalThis.Worker=previous;}
});
