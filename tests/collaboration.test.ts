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

test('personal spaces isolate author contributions and retain exit checkpoints through logout and resume',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-personal-')),filename=join(dir,'personal.sqlite');let store=openCollaborationStore(filename);
  try{
    const a=store.session('作者 A'),b=store.session('作者 B'),v=volume(),id=store.join('personal-test',v.bytes,v.volume).id;
    store.apply(id,a.person,{op:'a-personal',branch:'main',baseRevision:0,patch:patch([[0,0,1]])});
    store.apply(id,b.person,{op:'b-personal',branch:'main',baseRevision:0,patch:patch([[1,0,1]])});
    const readMask=(data:string)=>{const bytes=gunzipSync(Buffer.from(data,'base64'));return [...new Uint16Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))];};
    const ownA=store.workspace(id,a.person),ownB=store.workspace(id,b.person);assert.deepEqual(readMask(ownA.mask),[1,0,0,0,0,0,0,0]);assert.deepEqual(readMask(ownB.mask),[0,1,0,0,0,0,0,0]);assert.equal(ownA.touchedCount,1);
    assert.throws(()=>store.apply(id,b.person,{key:`${a.person.id}:${id}:wrong-author`,op:'wrong-author',branch:'main',baseRevision:0,patch:patch([[2,0,1]])}),/另一作者/);
    const shared=store.state(id),checkpoint={id:'checkpoint-a',generation:ownA.generation,revision:shared.revision,branch:'main',snapshot:shared.branches[0].mask,labels:shared.labels,view:{point:[1,0,1],selected:1,center:40,width:400,diameter:8,opacity:.45,tool:'paint'}};
    const saved=store.checkpoint(id,a.person,checkpoint);assert.equal(saved.generation,ownA.generation+1);assert.equal(store.checkpoint(id,a.person,checkpoint).duplicate,true);
    assert.equal(store.workspace(id,b.person).checkpoint,null);assert.deepEqual(store.workspace(id,a.person).checkpoint.view,checkpoint.view);assert.deepEqual(store.state(id),shared);
    assert.throws(()=>store.checkpoint(id,a.person,{...checkpoint,id:'stale-checkpoint'}),/已有更新/);assert.throws(()=>store.checkpoint(id,a.person,{...checkpoint,id:'bad-size',generation:saved.generation,snapshot:ownA.touched}),/尺寸|格式/);
    const revision=store.workspace(id,a.person).generation;store.apply(id,a.person,{op:'a-personal',branch:'main',baseRevision:0,patch:patch([[0,0,1]])});assert.equal(store.workspace(id,a.person).generation,revision);
    store.apply(id,a.person,{op:'a-erase',branch:'main',baseRevision:2,patch:patch([[0,1,0]])});assert.equal(readMask(store.workspace(id,a.person).mask)[0],0);assert.equal(gunzipSync(Buffer.from(store.workspace(id,a.person).touched,'base64'))[0],1);
    store.logout(a.token);assert.equal(store.person(a.token),undefined);const resumed=store.session('作者 A',{authorId:a.person.id,resumeKey:a.resumeKey});assert.equal(resumed.person.id,a.person.id);assert.throws(()=>store.session('作者 A',{authorId:a.person.id,resumeKey:'wrong'}),/身份恢复失败/);
    const before=store.workspace(id,a.person);store.close();store=openCollaborationStore(filename);assert.deepEqual(store.workspace(id,resumed.person),before);assert.equal(store.person(resumed.token).id,a.person.id);
    const out=store.exportPersonal(id,b.person);assert.deepEqual([...parseNifti(out.bytes.buffer.slice(out.bytes.byteOffset,out.bytes.byteOffset+out.bytes.byteLength)).data],[0,1,0,0,0,0,0,0]);
    const labelOp={op:'personal-label',id:1,name:'新的标签名',color:'#123456'};store.label(id,resumed.person,labelOp);const generation=store.workspace(id,resumed.person).generation;assert.equal(store.label(id,resumed.person,labelOp).duplicate,true);assert.equal(store.workspace(id,resumed.person).generation,generation);
  }finally{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
