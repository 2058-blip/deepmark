import test from 'node:test';
import assert from 'node:assert/strict';
import {diffMaskPackets,applyMaskPackets,readMaskRuns,MASK_RUN_HEADER_BYTES} from '../src/workbench/maskRuns.ts';
async function packets(before:Uint8Array,after:Uint8Array,dims:number[],options:Parameters<typeof diffMaskPackets>[3]={}){
  const result:Uint8Array[]=[];for await(const packet of diffMaskPackets(before,after,dims,options))result.push(packet);return result;
}
test('independent overlapping Mask changes round trip without a single-label projection',async()=>{
  const beforeA=new Uint8Array(125),beforeB=new Uint8Array(125),a=beforeA.slice(),b=beforeB.slice();
  a.fill(1,10,40);b.fill(1,25,60);
  const pa=await packets(beforeA,a,[5,5,5]),pb=await packets(beforeB,b,[5,5,5]);
  const receivedA=beforeA.slice(),receivedB=beforeB.slice();await applyMaskPackets(receivedA,pa);await applyMaskPackets(receivedB,pb);
  assert.deepEqual(receivedA,a);assert.deepEqual(receivedB,b);assert.equal(receivedA[30],1);assert.equal(receivedB[30],1);
  assert.equal(beforeA.some(Boolean),false);assert.equal(beforeB.some(Boolean),false);
});
test('bounded native brush patches preserve untouched coordinates and stable unsigned voxel order',async()=>{
  const before=new Uint8Array(7*5*4).fill(1),after=before.slice();
  for(let z=1;z<=2;z++)for(let y=1;y<=3;y++)for(let x=2;x<=4;x++)after[x+7*(y+5*z)]=0;
  const encoded=await packets(before,after,[7,5,4],{bounds:{min:[2,1,1],max:[4,3,2]},maxPacketBytes:36});
  assert.ok(encoded.length>1);assert.ok(encoded.every(bytes=>bytes.byteLength<=36));
  const restored=before.slice();await applyMaskPackets(restored,encoded);assert.deepEqual(restored,after);
});
test('generic full-volume changes split bounded packets and leave original history buffers attached',async()=>{
  const before=Uint8Array.from({length:10000},(_,i)=>i%2),after=Uint8Array.from(before,value=>value?0:1);
  const encoded=await packets(before,after,[10,10,100],{maxPacketBytes:1020,budgetMs:0});
  assert.ok(encoded.length>1);const restored=before.slice();await applyMaskPackets(restored,encoded);assert.deepEqual(restored,after);
  assert.equal(before.byteLength,10000);assert.equal(after.byteLength,10000);
  assert.deepEqual(await packets(after,after,[10,10,100]),[]);
});
test('invalid run headers, binary values, dimensions, ordering and truncated packets are rejected',async()=>{
  await assert.rejects(packets(new Uint8Array(8),new Uint8Array(8),[2,2,3]),/尺寸/);
  await assert.rejects(packets(new Uint8Array(8),new Uint8Array(8).fill(2),[2,2,2]),/二值/);
  const encoded=await packets(new Uint8Array(8),new Uint8Array(8).fill(1),[2,2,2]),good=encoded[0]!;
  assert.throws(()=>readMaskRuns(good.subarray(0,-1),8),/格式|长度/);
  const corrupt=good.slice();new DataView(corrupt.buffer).setUint32(MASK_RUN_HEADER_BYTES+4,9,true);
  assert.throws(()=>readMaskRuns(corrupt,8),/越界/);
  await assert.rejects(applyMaskPackets(new Uint8Array(8),[good,good]),/顺序/);
  const control=new AbortController();control.abort();
  await assert.rejects(packets(new Uint8Array(8),new Uint8Array(8).fill(1),[2,2,2],{signal:control.signal}),{name:'AbortError'});
});
