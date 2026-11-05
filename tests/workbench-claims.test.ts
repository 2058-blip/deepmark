import test from 'node:test';import assert from 'node:assert/strict';
import {ClaimBits} from '../src/workbench/claims.ts';
test('sparse ownership matches dense bits across partial words/pages and range clearing',()=>{
  const bits=new ClaimBits(),dense=new Uint8Array(100000);
  for(const[start,length,value]of [[0,1,1],[30,8,1],[32760,40,1],[65535,300,1],[31,2,0],[32767,5,0],[99990,10,1]]){
    bits.set(start!,length!,!!value);dense.fill(value!,start!,start!+length!);
    assert.equal(bits.count,dense.reduce((a,b)=>a+b,0));
    for(let i=0;i<dense.length;i++)assert.equal(bits.has(i),!!dense[i]);
    const restored=new Uint8Array(dense.length);bits.ranges((start,end)=>restored.fill(1,start,end));assert.deepEqual(restored,dense);
  }
});
