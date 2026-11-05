import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceBinaryCodec,workspaceBinaryKeys,WORKSPACE_CHUNK_BYTES} from '../src/mimics/workspaceBinary.ts';
function storage(pending:ReturnType<WorkspaceBinaryCodec['pack']>['pending']){
  const map=new Map<string,Uint8Array>();
  for(const {ref,data} of pending){const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);ref.keys.forEach((key,i)=>map.set(key,bytes.slice(i*WORKSPACE_CHUNK_BYTES,(i+1)*WORKSPACE_CHUNK_BYTES)));}
  return map;
}
test('chunked float, index and mask arrays round trip exactly with bounded records and retained aliases',async()=>{
  const codec=new WorkspaceBinaryCodec(),values=new Float32Array(WORKSPACE_CHUNK_BYTES/4+7);
  values[0]=-1024.5;values[values.length-1]=650.25;
  const indices=Uint32Array.from({length:20000},(_,i)=>i),mask=new Uint8Array(100001);mask[100000]=1;
  const packed=codec.pack({values,alias:values,indices,mask,header:new Uint8Array([1,2,3])},'document'),map=storage(packed.pending);
  assert.equal(packed.pending.length,3);assert.equal(map.size,4);assert.ok([...map.values()].every(chunk=>chunk.byteLength<=WORKSPACE_CHUNK_BYTES));
  assert.equal(workspaceBinaryKeys(packed.value).length,4);
  const restored=await codec.hydrate(packed.value,'document',async key=>map.get(key)!);
  assert.deepEqual(restored.values,values);assert.deepEqual(restored.indices,indices);assert.deepEqual(restored.mask,mask);
  assert.equal(restored.values,restored.alias);assert.deepEqual(restored.header,new Uint8Array([1,2,3]));
});
test('view-only saves reuse live binary references; an older array cannot reuse already-collected chunks',()=>{
  const codec=new WorkspaceBinaryCodec(),mask=new Uint8Array(100000),first=codec.pack({mask},'doc');
  const ref=first.pending[0]!.ref;
  const same=codec.pack({mask,view:{slice:99}},'doc',new Set([ref.prefix]));assert.equal(same.pending.length,0);
  assert.equal(same.value.mask,ref);
  const old=codec.pack({mask},'doc',new Set());assert.equal(old.pending.length,1);assert.notEqual(old.pending[0]!.ref.prefix,ref.prefix);
  assert.equal(codec.pack({mask},'other-doc').pending.length,1);
});
test('large backing stores are not serialized through short typed subviews',()=>{
  const source=new Uint8Array(1024*1024),view=source.subarray(700000,700003);view.set([8,9,10]);
  const packed=new WorkspaceBinaryCodec().pack({view},'doc');
  assert.equal(packed.pending.length,0);assert.deepEqual(packed.value.view,new Uint8Array([8,9,10]));
  assert.equal(packed.value.view.buffer.byteLength,3);assert.notEqual(packed.value.view.buffer,source.buffer);
});
test('missing, cross-document and truncated binary references fail without returning partial data',async()=>{
  const codec=new WorkspaceBinaryCodec(),packed=codec.pack({mask:new Uint8Array(100000)},'doc'),map=storage(packed.pending);
  await assert.rejects(codec.hydrate(packed.value,'other',async key=>map.get(key)!),/引用无效/);
  await assert.rejects(codec.hydrate(packed.value,'doc',async()=>new Uint8Array(1)),/长度不一致/);
  const corrupt=structuredClone(packed.value);corrupt.mask.length++;
  await assert.rejects(codec.hydrate(corrupt,'doc',async key=>map.get(key)!),/长度不一致/);
  assert.throws(()=>{const cycle:any={};cycle.self=cycle;codec.pack(cycle,'doc');},/循环/);
});
test('arrays hydrated from a valid manifest remain reusable without rewriting their payload',async()=>{
  const codec=new WorkspaceBinaryCodec(),packed=codec.pack({mask:new Uint8Array(100000)},'doc'),map=storage(packed.pending);
  const restored=await codec.hydrate(packed.value,'doc',async key=>map.get(key)!);
  assert.equal(codec.pack(restored,'doc',new Set(packed.pending.map(item=>item.ref.prefix))).pending.length,0);
});
