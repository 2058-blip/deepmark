import test from 'node:test';import assert from 'node:assert/strict';
import {ClaimBits,WorkbenchClaims} from '../src/workbench/claims.ts';
import {diffMaskPackets} from '../src/workbench/maskRuns.ts';
test('sparse ownership matches dense bits across partial words/pages and range clearing',()=>{
  const bits=new ClaimBits(),dense=new Uint8Array(100000);
  for(const[start,length,value]of [[0,1,1],[30,8,1],[32760,40,1],[65535,300,1],[31,2,0],[32767,5,0],[99990,10,1]]){
    bits.set(start!,length!,!!value);dense.fill(value!,start!,start!+length!);
    assert.equal(bits.count,dense.reduce((a,b)=>a+b,0));
    for(let i=0;i<dense.length;i++)assert.equal(bits.has(i),!!dense[i]);
    const restored=new Uint8Array(dense.length);bits.ranges((start,end)=>restored.fill(1,start,end));assert.deepEqual(restored,dense);
  }
});

test('Mask contributors include only nonempty claims and never classify the current author as foreign',async()=>{
  const claims=new WorkbenchClaims(),empty=new Uint8Array(32),a=empty.slice(),b=empty.slice();a.fill(1,2,8);b.fill(1,5,10);
  async function apply(author:string,before:Uint8Array,after:Uint8Array){
    for await(const packet of diffMaskPackets(before,after,[4,4,2]))claims.apply('mask',author,packet,32);
  }
  await apply('A',empty,a);assert.deepEqual(claims.authors('mask'),['A']);assert.equal(claims.hasForeign('mask','A'),false);
  await apply('B',empty,b);assert.deepEqual(claims.authors('mask'),['A','B']);assert.equal(claims.hasForeign('mask','A'),true);
  await apply('B',b,empty);assert.deepEqual(claims.authors('mask'),['A']);assert.equal(claims.hasForeign('mask','A'),false);
  claims.remove('mask');assert.deepEqual(claims.authors('mask'),[]);assert.equal(claims.hasForeign('mask','A'),false);
});
