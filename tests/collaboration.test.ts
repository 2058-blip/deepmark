import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {openCollaborationStore} from '../server/collaboration.mjs';
import {parseNifti} from '../src/core.ts';
function volume(){const bytes=new ArrayBuffer(368),v=new DataView(bytes);v.setInt32(0,348,true);v.setInt16(40,3,true);for(let a=0;a<3;a++){v.setInt16(42+a*2,2,true);v.setFloat32(80+a*4,1,true);}v.setInt16(70,4,true);v.setInt16(72,16,true);v.setFloat32(108,352,true);new Uint8Array(bytes,344,4).set([110,43,49,0]);return {bytes:Buffer.from(bytes),volume:parseNifti(bytes)};}
function patch(entries:number[][]){const bytes=Buffer.alloc(entries.length*8);entries.sort((a,b)=>a[0]-b[0]).forEach(([i,b,a],n)=>{bytes.writeUInt32LE(i,n*8);bytes.writeUInt16LE(b,n*8+4);bytes.writeUInt16LE(a,n*8+6);});return bytes.toString('base64');}
function masks(state:any){return state.branches.map((b:any)=>{const bytes=gunzipSync(Buffer.from(b.mask,'base64'));return {id:b.id,data:[...new Uint16Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))]};});}
test('collaboration preserves conflicts, fans later edits out to every version, and persists replayable history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-history-')),filename=join(dir,'history.sqlite');let store=openCollaborationStore(filename);
  try{
    const a=store.session('工程师 A'),b=store.session('工程师 B'),v=volume();assert.equal(store.person(a.token).id,a.person.id);
    const project=store.join('test-dataset',v.bytes,v.volume),id=project.id;
    function apply(person:any,op:string,entries:number[][],branch='main',kind='edit'){return store.apply(id,person,{op,branch,baseRevision:0,patch:patch(entries),kind});}
    apply(a.person,'a1',[[0,0,1]]);apply(b.person,'b1',[[1,0,1]]);assert.deepEqual(masks(store.state(id))[0].data,[1,1,0,0,0,0,0,0]);
    const label=store.label(id,b.person,{});assert.equal(label.label.id,2);
    const conflict=apply(b.person,'conflict',[[0,0,2]]);assert.equal(conflict.conflicts,1);assert.ok(conflict.forkId);
    let current=masks(store.state(id));assert.equal(current.length,2);assert.equal(current[0].data[0],1);assert.equal(current[1].data[0],2);
    apply(a.person,'fan-out',[[2,0,1]]);current=masks(store.state(id));assert.equal(current[0].data[2],1);assert.equal(current[1].data[2],1);assert.equal(current[0].data[0],1);assert.equal(current[1].data[0],2);
    const historic=masks(store.state(id,4));assert.equal(historic.length,2);assert.equal(historic[0].data[0],1);assert.equal(historic[1].data[0],2);assert.equal(historic.every((b:any)=>b.data[2]===0),true);
    apply(a.person,'redraw-same-value',[[0,1,1]]);assert.equal(masks(store.state(id)).every((b:any)=>b.data[0]===1),true);
    apply(a.person,'redraw-difference',[[0,1,2]]);assert.equal(masks(store.state(id)).every((b:any)=>b.data[0]===2),true);
    const undo=apply(a.person,'undo-a',[[0,1,0]],'main','undo');assert.ok(undo.forkId);current=masks(store.state(id));assert.equal(current[0].data[0],2);assert.equal(current.at(-1)!.data[0],0);
    const revision=store.state(id).revision;assert.equal(apply(a.person,'undo-a',[[0,1,0]],'main','undo').duplicate,true);assert.equal(store.state(id).revision,revision);
    const previous=store.state(id);assert.throws(()=>apply(a.person,'invalid',[[9,0,1]]));assert.throws(()=>apply(a.person,'unknown-label',[[3,0,100]]));assert.deepEqual(store.state(id),previous);
    for(let r=0;r<=revision;r++)assert.equal(store.state(id,r).revision,r);
    assert.equal(store.history(id)[0].kind,'撤销');assert.ok(store.history(id).some((event:any)=>event.name==='工程师 B'));
    const exported=store.export(id,'main');assert.deepEqual([...parseNifti(exported.bytes.buffer.slice(exported.bytes.byteOffset,exported.bytes.byteOffset+exported.bytes.byteLength)).data],current[0].data);
    const persisted=store.state(id);store.close();store=openCollaborationStore(filename);assert.deepEqual(store.state(id),persisted);assert.equal(store.person(a.token).name,'工程师 A');
  }finally{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
