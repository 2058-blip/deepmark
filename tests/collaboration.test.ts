import {test} from 'node:test';
import {unzipSync} from 'fflate';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {openCollaborationStore} from '../server/collaboration.mjs';
import {parseNifti} from '../src/core.ts';
const adminKey='test-only-administrator-key';
function volume(){const bytes=new ArrayBuffer(368),v=new DataView(bytes);v.setInt32(0,348,true);v.setInt16(40,3,true);for(let a=0;a<3;a++){v.setInt16(42+a*2,2,true);v.setFloat32(80+a*4,1,true);}v.setInt16(70,4,true);v.setInt16(72,16,true);v.setFloat32(108,352,true);new Uint8Array(bytes,344,4).set([110,43,49,0]);return {bytes:Buffer.from(bytes),volume:parseNifti(bytes)};}
function patch(entries:number[][]){const bytes=Buffer.alloc(entries.length*8);entries.sort((a,b)=>a[0]-b[0]).forEach(([i,b,a],n)=>{bytes.writeUInt32LE(i,n*8);bytes.writeUInt16LE(b,n*8+4);bytes.writeUInt16LE(a,n*8+6);});return bytes.toString('base64');}
function values(state:any){const b=gunzipSync(Buffer.from(state.mask,'base64'));return [...new Uint16Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))];}

test('engineers can replace their own opinions but cannot erase another author through any operation channel',()=>{
  const store=openCollaborationStore(':memory:',{adminKey});try{
    const a=store.session('A').person,b=store.session('B').person,c=store.session('C').person,v=volume(),id=store.join('protected',v.bytes,v.volume).id;
    const edit=(person:any,op:string,entries:number[][],extra={})=>store.apply(id,person,{op,baseRevision:store.state(id).revision,patch:patch(entries),...extra});
    edit(a,'a-paint',[[0,0,1]]);store.label(id,b,{});store.label(id,c,{});
    const denied=edit(b,'b-erase-foreign',[[0,1,0]]);assert.equal(denied.protectedCount,1);assert.equal(values(store.state(id))[0],1);assert.equal(store.state(id).regions.length,0);
    edit(b,'b-opinion',[[0,1,2]]);edit(c,'c-opinion',[[0,1,3]]);edit(b,'b-withdraw-own',[[0,2,0]]);let state=store.state(id);assert.deepEqual(state.regions[0].annotations.map((row:any)=>row.author).sort(),[a.id,c.id].sort());assert.equal(values(state)[0],1);
    edit(a,'a-withdraw-own',[[0,1,0]]);state=store.state(id);assert.equal(values(state)[0],3);assert.equal(state.regions.length,0);assert.equal(store.provenance(id,0,state.revision).author.id,c.id);
    edit(b,'b-erase-again',[[0,3,0]],{kind:'undo'});assert.equal(values(store.state(id))[0],3);
    edit(b,'b-own-second',[[1,0,2]]);const mixed=edit(b,'b-mixed-threshold',[[0,3,0],[1,2,0]]);assert.equal(mixed.protectedCount,1);assert.deepEqual(values(store.state(id)).slice(0,2),[3,0]);
    assert.throws(()=>edit(b,'forged-review',[[0,3,0]],{review:true}),(error:any)=>error.status===403);assert.throws(()=>edit(b,'a-paint',[[0,3,0]]),(error:any)=>error.status===409);
    const ownership=store.state(id,undefined,c.id);assert.equal(ownership.ownershipAuthor,c.id);assert.equal(gunzipSync(Buffer.from(ownership.ownedVoxels,'base64'))[0]&1,1);assert.equal(gunzipSync(Buffer.from(store.state(id,undefined,b.id).ownedVoxels,'base64'))[0]&1,0);
    edit(c,'c-erase-own',[[0,3,0]]);assert.equal(values(store.state(id))[0],0);assert.equal(store.provenance(id,0,store.state(id).revision).author,null);
  }finally{store.close();}
});

test('deleting a shared same-color claim preserves the other author without reviving withdrawn claims',()=>{
  const store=openCollaborationStore(':memory:',{adminKey});try{
    const a=store.session('A').person,b=store.session('B').person,v=volume(),id=store.join('same-color',v.bytes,v.volume).id;
    const edit=(person:any,op:string,index:number,before:number,after:number)=>store.apply(id,person,{op,baseRevision:store.state(id).revision,patch:patch([[index,before,after]])});
    edit(a,'a1',0,0,1);edit(b,'b1',0,1,1);edit(a,'a-remove',0,1,0);assert.equal(values(store.state(id))[0],1);assert.equal(store.provenance(id,0,store.state(id).revision).author.id,b.id);edit(b,'b-remove',0,1,0);assert.equal(values(store.state(id))[0],0);
    edit(a,'a2',1,0,1);edit(b,'b2',1,1,1);edit(b,'b-withdraw',1,1,0);edit(a,'a-last',1,1,0);assert.equal(values(store.state(id))[1],0);
  }finally{store.close();}
});

test('voxel provenance identifies ordinary and parallel authors at the requested revision',()=>{
  const store=openCollaborationStore(':memory:',{adminKey});try{
    const a=store.session('作者 A').person,b=store.session('作者 B').person,v=volume(),id=store.join('author-source',v.bytes,v.volume).id;
    store.apply(id,a,{op:'source-a',baseRevision:0,patch:patch([[0,0,1]])});assert.equal(store.provenance(id,0,1).author.id,a.id);
    store.label(id,b,{});assert.throws(()=>store.provenance(id,0,1),(error:any)=>error.status===409);assert.equal(store.provenance(id,0,1,true).author.id,a.id);assert.equal(store.provenance(id,0,0,true).author,null);
    store.apply(id,b,{op:'source-b',baseRevision:2,patch:patch([[0,1,2]])});const current=store.provenance(id,0,3);assert.equal(current.label,1);assert.deepEqual(current.annotations.map((row:any)=>[row.name,row.label]).sort(),[['作者 A',1],['作者 B',2]]);
    assert.equal(store.provenance(id,7,3).author,null);assert.throws(()=>store.provenance(id,8,3),(error:any)=>error.status===400);
  }finally{store.close();}
});
test('one shared result preserves region-level parallel opinions, including sequential edits by different authors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-shared-')),filename=join(dir,'shared.sqlite');let store=openCollaborationStore(filename,{adminKey});
  try{
    const a=store.session('工程师 A').person,b=store.session('工程师 B').person,v=volume(),id=store.join('shared-data',v.bytes,v.volume).id;
    const apply=(person:any,op:string,entries:number[][],extra={})=>store.apply(id,person,{op,baseRevision:store.state(id).revision,patch:patch(entries),...extra});
    apply(a,'a1',[[0,0,1]]);apply(b,'b1',[[1,0,1]]);assert.deepEqual(values(store.state(id)),[1,1,0,0,0,0,0,0]);
    store.label(id,b,{});const conflict=apply(b,'b2',[[0,1,2]]);assert.equal(conflict.parallelCount,1);
    let shared=store.state(id);assert.equal('branches' in shared,false);assert.equal(shared.regions.length,1);assert.equal(shared.regions[0].annotations.length,2);assert.equal(shared.regions[0].annotations.find((r:any)=>r.author===a.id).values[0][1],1);assert.equal(shared.regions[0].annotations.find((r:any)=>r.author===b.id).values[0][1],2);
    const regionId=shared.regions[0].id;apply(b,'b3',[[0,2,1]]);shared=store.state(id);assert.equal(shared.regions[0].id,regionId);assert.equal(shared.regions[0].annotations.length,2);assert.equal(shared.regions[0].annotations.find((r:any)=>r.author===b.id).values[0][1],1);
    apply(a,'initial-same',[[4,0,1]]);apply(b,'agree-same',[[4,1,1]]);apply(a,'changed-opinion',[[4,1,2]]);assert.ok(store.state(id).regions.some((r:any)=>r.indices.includes(4)&&r.annotations.some((o:any)=>o.author===b.id&&o.values.some(([i,v]:number[])=>i===4&&v===1))));
    apply(b,'b4',[[0,1,2]]);apply(a,'elsewhere',[[2,0,1]]);shared=store.state(id);assert.equal(values(shared)[2],1);assert.equal(shared.regions[0].annotations.find((r:any)=>r.author===b.id).values[0][1],2);
    const rev=shared.revision;assert.equal(apply(a,'elsewhere',[[2,0,1]]).duplicate,true);assert.equal(store.state(id).revision,rev);
    assert.throws(()=>apply(a,'invalid',[[9,0,1]]));assert.throws(()=>apply(a,'wrong-owner',[[3,0,1]],{key:`${b.id}:${id}:wrong-owner`}));assert.deepEqual(store.state(id),shared);
    const review=store.export(id);assert.equal(review.extension,'zip');assert.equal(review.type,'application/zip');const files=unzipSync(review.bytes);assert.ok(files['segmentation.nii']);assert.ok(files['labels.json']);assert.equal(JSON.parse(new TextDecoder().decode(files['parallel-annotations.json'])).parallelRegions[0].annotations.length,2);
    for(let r=0;r<=rev;r++)assert.equal(store.state(id,r).revision,r);
    const persisted=store.state(id);store.close();store=openCollaborationStore(filename,{adminKey});assert.deepEqual(store.state(id),persisted);assert.equal('workspace' in store,false);
  }finally{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
test('only administrator can resolve, make authoritative edits and finalize the single result',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-review-')),filename=join(dir,'review.sqlite'),store=openCollaborationStore(filename,{adminKey});
  try{
    const a=store.session('A').person,b=store.session('B').person,pretend=store.session('管理员').person,v=volume(),id=store.join('review-data',v.bytes,v.volume).id;
    const edit=(person:any,op:string,entries:number[][],review=false)=>store.apply(id,person,{op,baseRevision:store.state(id).revision,patch:patch(entries),review});
    edit(a,'a',[[0,0,1]]);store.label(id,b,{});edit(b,'b',[[0,1,2]]);
    assert.throws(()=>store.adminSession('wrong'),/密钥不正确/);assert.equal(pretend.role,'engineer');assert.throws(()=>store.projects(pretend),/只有管理员/);assert.throws(()=>edit(a,'fake-review',[[0,1,0]],true),/只有管理员/);
    const admin=store.adminSession(adminKey).person;assert.equal(admin.role,'admin');let state=store.state(id);
    assert.throws(()=>store.finalize(id,admin,{revision:state.revision}),/并列标注未审定/);assert.throws(()=>store.resolve(id,a,{revision:state.revision,regionId:state.regions[0].id,annotationId:state.regions[0].annotations[0].id}),/只有管理员/);
    const selected=state.regions[0].annotations.find((r:any)=>r.author===b.id);store.resolve(id,admin,{revision:state.revision,regionId:state.regions[0].id,annotationId:selected.id});state=store.state(id);assert.equal(state.regions.length,0);assert.equal(values(state)[0],2);
    edit(admin,'review-edit',[[1,0,1]],true);assert.equal(store.state(id).regions.length,0);assert.throws(()=>store.finalize(id,admin,{revision:0}),/已有新操作/);
    const finalized=store.finalize(id,admin,{revision:store.state(id).revision});assert.equal(store.state(id).status,'finalized');assert.throws(()=>edit(a,'after-final',[[2,0,1]]),/已定稿/);assert.throws(()=>store.reopen(id,a,{revision:finalized.revision}),/只有管理员/);
    const finalBytes=store.export(id).bytes;store.reopen(id,admin,{revision:finalized.revision});edit(admin,'new-review',[[0,2,0]],true);store.finalize(id,admin,{revision:store.state(id).revision});assert.deepEqual(store.export(id,finalized.revision).bytes,finalBytes);assert.equal(store.state(id,finalized.revision).finalRevision,finalized.revision);assert.equal(store.projects(admin)[0].contributors.length,3);
  }finally{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
test('upgrade backs up old personal spaces and converts branch differences to shared parallel regions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-migration-')),filename=join(dir,'old.sqlite'),v=volume();
  const old=new DatabaseSync(filename),pack=(value:any)=>gzipSync(Buffer.from(JSON.stringify(value))),a=new Uint16Array(8),b=new Uint16Array(8);a[0]=1;b[0]=2;b[2]=1;
  old.exec('CREATE TABLE people(token TEXT PRIMARY KEY,id TEXT,name TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,dataset TEXT,fingerprint TEXT,count INTEGER,header BLOB,labels TEXT,revision INTEGER); CREATE TABLE branches(project TEXT,id TEXT,name TEXT,mask BLOB); CREATE TABLE personal(project TEXT,author TEXT,checkpoint BLOB); CREATE TABLE events(project TEXT,revision INTEGER,op TEXT,author TEXT,name TEXT,kind TEXT,time TEXT,details BLOB,PRIMARY KEY(project,revision),UNIQUE(project,op));');
  old.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?)').run('old-project','source','hash',8,v.volume.header,JSON.stringify([{id:1,name:'A',color:'#123456'},{id:2,name:'B',color:'#abcdef'}]),0);
  old.prepare('INSERT INTO branches VALUES(?,?,?,?)').run('old-project','main','原结果',pack(gzipSync(Buffer.from(a.buffer)).toString('base64')));old.prepare('INSERT INTO branches VALUES(?,?,?,?)').run('old-project','other','旧冲突',pack(gzipSync(Buffer.from(b.buffer)).toString('base64')));old.prepare('INSERT INTO personal VALUES(?,?,?)').run('old-project','author',pack({old:true}));old.close();
  const store=openCollaborationStore(filename,{adminKey});try{const state=store.state('old-project');assert.deepEqual(values(state),[1,0,0,0,0,0,0,0]);assert.equal('branches' in state,false);assert.ok(state.regions.flatMap((r:any)=>r.annotations).some((row:any)=>row.values.some(([i,n]:number[])=>i===0&&n===2)));assert.ok(state.regions.flatMap((r:any)=>r.annotations).some((row:any)=>row.values.some(([i,n]:number[])=>i===2&&n===1)));}finally{store.close();}
  const active=new DatabaseSync(filename);assert.equal(active.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('personal','branches')").get().n,0);active.close();const backup=join(dir,'migrations','before-single-result.sqlite');assert.ok((await stat(backup)).size>0);const archived=new DatabaseSync(backup);assert.equal(archived.prepare('SELECT COUNT(*) AS n FROM personal').get().n,1);archived.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});
});
