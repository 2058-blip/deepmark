import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseNifti} from '../src/core.ts';
import {createProject,ProjectHistory} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';

type Operation='push'|'undo'|'redo';

function fixture(){
  const bytes=new Uint8Array(360),header=new DataView(bytes.buffer);
  header.setInt32(0,348,true);header.setInt16(40,3,true);
  for(let axis=0;axis<3;axis++){header.setInt16(42+axis*2,2,true);header.setFloat32(80+axis*4,1,true);}
  header.setInt16(70,2,true);header.setInt16(72,8,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setUint8(123,2);bytes.set([110,43,49,0],344);
  const state={...createProject(parseNifti(bytes.buffer,'history.nii')),name:'A',polylines:[]} satisfies ProjectState;
  return{a:state,b:{...state,name:'B'},c:{...state,name:'C'},branch:{...state,name:'different branch'}};
}

function setup(operation:Operation){
  const states=fixture(),history=new ProjectHistory(1000000);
  history.push('A to B',states.a,states.b);history.push('B to C',states.b,states.c);
  if(operation!=='undo')assert.equal(history.undo()!.name,'B');
  return{history,states};
}

function current(history:ProjectHistory){return(history as unknown as {current?:ProjectState}).current;}
function checkpoint(history:ProjectHistory){
  const bytes=history.bytesUsed;
  return{past:history.past,future:history.future,current:current(history),entries:[...history.past,...history.future].map(entry=>({entry,bytes:entry.bytes})),bytes};
}
function unchanged(history:ProjectHistory,before:ReturnType<typeof checkpoint>){
  assert.equal(history.past,before.past,'past stack was published after a failed operation');
  assert.equal(history.future,before.future,'future stack was published after a failed operation');
  assert.equal(current(history),before.current,'current position changed after a failed operation');
  assert.deepEqual([...history.past,...history.future],before.entries.map(value=>value.entry));
  for(const value of before.entries)assert.equal(value.entry.bytes,value.bytes,'an existing entry budget changed before commit');
  assert.equal(history.bytesUsed,before.bytes);
}
function perform(operation:Operation,history:ProjectHistory,states:ReturnType<typeof fixture>){
  if(operation==='push')history.push('branch',states.b,states.branch);
  else if(operation==='undo')return history.undo();
  else return history.redo();
}
function recover(operation:Operation,history:ProjectHistory,states:ReturnType<typeof fixture>){
  if(operation==='push'){
    assert.equal(history.redo()!.name,'C','failed push must preserve the original redo branch');
    assert.equal(history.undo()!.name,'B');history.push('branch',states.b,states.branch);
    assert.equal(history.undo()!.name,'B');assert.equal(history.redo()!.name,'different branch');
  }else{
    assert.equal(perform(operation,history,states)!.name,operation==='undo'?'B':'C');
    assert.equal(operation==='undo'?history.redo()!.name:history.undo()!.name,operation==='undo'?'C':'B');
  }
}

for(const operation of ['push','undo','redo'] as const){
  test(`history ${operation} leaves stacks, current position and accounting intact when a snapshot cannot be allocated`,()=>{
    const{history,states}=setup(operation),before=checkpoint(history),clone=globalThis.structuredClone;
    let count=0;
    try{
      globalThis.structuredClone=((...args:Parameters<typeof structuredClone>)=>{
        if(++count===(operation==='push'?2:1))throw new Error('synthetic snapshot allocation failure');
        return clone(...args);
      }) as typeof structuredClone;
      assert.throws(()=>perform(operation,history,states),/snapshot allocation failure/);
    }finally{globalThis.structuredClone=clone;}
    unchanged(history,before);recover(operation,history,states);
  });

  test(`history ${operation} does not publish pruning or partial accounting when budget estimation fails`,()=>{
    const{history,states}=setup(operation);
    history.maxEntries=1;
    const before=checkpoint(history),stringify=JSON.stringify;
    // A cache miss must remain harmless, including Redo after a previously measured Undo.
    (history as unknown as {metadataSizes:WeakMap<ProjectState,number>}).metadataSizes=new WeakMap();
    try{
      JSON.stringify=((value:unknown,...args:unknown[])=>{
        if(value&&typeof value==='object'&&Array.isArray((value as ProjectState).masks))throw new Error('synthetic budget estimation failure');
        return(stringify as (...values:unknown[])=>string)(value,...args);
      }) as typeof JSON.stringify;
      assert.throws(()=>perform(operation,history,states),/budget estimation failure/);
    }finally{JSON.stringify=stringify;}
    unchanged(history,before);recover(operation,history,states);
  });
}
