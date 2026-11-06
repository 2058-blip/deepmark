import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addMask,makeMask,ProjectHistory,replaceMask} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';

function emptyProject():ProjectState {
  return {name:'Allocation regression',masks:[],parts:[],measurements:[],selectedMaskId:'',selectedPartId:''};
}

test('completed algorithm results become Masks without a discarded volume-sized blank allocation',()=>{
  const NativeUint8Array=globalThis.Uint8Array,result=Uint8Array.from([0,1,1,0,1,0,0,1]);
  const before=emptyProject();let volumeAllocations=0;
  // An exhausted browser may still receive an already allocated worker result.
  // Adopting that result must work even when another same-sized allocation fails.
  globalThis.Uint8Array=new Proxy(NativeUint8Array,{
    construct(target,args,newTarget){
      if(args[0]===result.length){volumeAllocations++;throw new RangeError('simulated exhausted mask allocation');}
      return Reflect.construct(target,args,newTarget);
    },
  });
  try{
    const after=addMask(before,result.length,'Dynamic region',result);
    const direct=makeMask(result.length,'Calculated mask','#59b8b3',result);
    assert.strictEqual(direct.data,result);
    assert.strictEqual(after.masks[0]!.data,result);
    assert.equal(after.selectedMaskId,after.masks[0]!.id);
    assert.equal(volumeAllocations,0);
    assert.equal(before.masks.length,0);
    assert.deepEqual([...result],[0,1,1,0,1,0,0,1]);
  }finally{globalThis.Uint8Array=NativeUint8Array;}
});

test('adopted result buffers retain independent immutable history across later edits',()=>{
  const source=Uint8Array.from([1,0,0,0]),first=makeMask(4,'Source','#59b8b3',source);
  const before={...emptyProject(),masks:[first],selectedMaskId:first.id};
  const result=Uint8Array.from([0,1,0,0]),after=addMask(before,4,'Region',result);
  const history=new ProjectHistory(1000000);
  history.push('Create calculated Mask',before,after);
  assert.strictEqual(history.undo()!.masks[0]!.data,source);
  const restored=history.redo()!;
  assert.strictEqual(restored.masks[1]!.data,result);
  const edited=result.slice();edited[2]=1;
  const next=replaceMask(restored,restored.selectedMaskId,edited);
  history.push('Edit calculated Mask',restored,next);
  assert.deepEqual([...result],[0,1,0,0]);
  assert.strictEqual(history.undo()!.masks[1]!.data,result);
  assert.strictEqual(history.redo()!.masks[1]!.data,edited);
  assert.strictEqual(before.masks[0]!.data,source);
  assert.deepEqual([...source],[1,0,0,0]);
});

test('adopting an existing result preserves size, type and binary membership validation',()=>{
  const before=emptyProject();
  for(const result of [new Uint8Array(3),new Uint8Array([0,1,2,0]),new Int8Array(4)] as unknown as Uint8Array[]){
    assert.throws(()=>makeMask(4,'Invalid','#59b8b3',result),/尺寸|存储类型|二值/);
    assert.throws(()=>addMask(before,4,'Invalid',result),/尺寸|存储类型|二值/);
  }
  assert.throws(()=>makeMask(0,'Invalid','#59b8b3',new Uint8Array()),/尺寸|数量/);
  assert.throws(()=>makeMask(4,'Invalid','not-a-color',new Uint8Array(4)),/名称或颜色/);
  assert.deepEqual(before,emptyProject());
});

test('a new empty Mask still allocates a separate zero-filled buffer when no result is provided',()=>{
  const first=makeMask(8),second=makeMask(8);
  assert.deepEqual([...first.data],new Array(8).fill(0));
  assert.notStrictEqual(first.data,second.data);
  first.data[0]=1;assert.equal(second.data[0],0);
});
