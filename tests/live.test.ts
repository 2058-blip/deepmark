import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import WebSocket from 'ws';
import {gunzipSync} from 'node:zlib';
import {createDatasetServer} from '../server/server.mjs';
import {openCollaborationStore} from '../server/collaboration.mjs';

function message(ws:WebSocket,predicate:(value:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{ws.off('message',read);reject(new Error('Missing live message'));},3000);function read(raw:any){const value=JSON.parse(raw.toString());if(predicate(value)){clearTimeout(timeout);ws.off('message',read);resolve(value);}}ws.on('message',read);});}
function patch(index:number,before:number,after:number){const bytes=Buffer.alloc(8);bytes.writeUInt32LE(index);bytes.writeUInt16LE(before,4);bytes.writeUInt16LE(after,6);return bytes.toString('base64');}

test('live result deltas are authoritative, idempotent, authenticated and recoverable from the durable journal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deepmark-live-')),datasets=join(dir,'datasets'),stateDir=join(dir,'state');await mkdir(datasets);
  const bytes=Buffer.alloc(368),header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);header.setInt32(0,348,true);header.setInt16(40,3,true);for(let a=0;a<3;a++){header.setInt16(42+a*2,2,true);header.setFloat32(80+a*4,1,true);}header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);bytes.set([110,43,49,0],344);await writeFile(join(datasets,'live.nii'),bytes);
  const server=createDatasetServer({datasetDir:datasets,stateDir});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number},origin=`http://127.0.0.1:${address.port}`,prefix=origin+'/api/collaboration',sockets:WebSocket[]=[];
  let closed=false;
  try{
    async function session(name:string){const response=await fetch(prefix+'/session',{method:'POST',headers:{'X-Deepmark-Request':'1'},body:JSON.stringify({name})});return {person:(await response.json()).person,headers:{Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-Deepmark-Request':'1'}};}
    const a=await session('A'),b=await session('B'),list=await (await fetch(origin+'/api/datasets')).json(),joined=await (await fetch(prefix+'/projects',{method:'POST',headers:a.headers,body:JSON.stringify({datasetId:list.datasets[0].id})})).json(),id=joined.id;
    async function connect(client:typeof a){const ws=new WebSocket(`ws://127.0.0.1:${address.port}/api/collaboration/socket?project=${id}`,{headers:client.headers});sockets.push(ws);await message(ws,m=>m.type==='ready');return ws;}
    const first=await connect(a),second=await connect(b),one={op:'live-a',baseRevision:0,patch:patch(0,0,1)};
    const ackA=message(first,m=>m.type==='ack'&&m.requestId===one.op),deltaB=message(second,m=>m.type==='delta'&&m.op===one.op);first.send(JSON.stringify({type:'operation',author:a.person.id,requestId:one.op,operation:one}));
    assert.equal((await ackA).revision,1);const update=await deltaB;assert.equal('mask' in update,false);assert.equal(Buffer.from(update.patch,'base64').readUInt16LE(6),1);assert.equal(update.revision,1);
    const label=await (await fetch(prefix+`/projects/${id}/labels`,{method:'POST',headers:b.headers,body:'{}'})).json();assert.equal(label.label.id,2);
    const two={op:'live-b',baseRevision:2,patch:patch(0,1,2)},ackB=message(second,m=>m.type==='ack'&&m.requestId===two.op),conflict=message(first,m=>m.type==='delta'&&m.op===two.op);second.send(JSON.stringify({type:'operation',author:b.person.id,requestId:two.op,operation:two}));
    assert.equal((await ackB).parallelCount,1);const parallel=await conflict;assert.equal(parallel.regions[0].annotations.length,2);assert.equal(Buffer.from(parallel.patch,'base64').readUInt16LE(6),1);
    const duplicate=message(second,m=>m.type==='ack'&&m.requestId===two.op);second.send(JSON.stringify({type:'operation',author:b.person.id,requestId:two.op,operation:two}));assert.equal((await duplicate).duplicate,true);
    const denied=message(first,m=>m.type==='error');first.send(JSON.stringify({type:'operation',author:b.person.id,requestId:'forged',operation:{op:'forged',baseRevision:3,patch:patch(1,0,1)}}));assert.equal((await denied).status,401);
    const replay=await (await fetch(prefix+`/projects/${id}/events?after=0`,{headers:a.headers})).json();assert.deepEqual(replay.events.map((e:any)=>e.revision),[1,2,3]);assert.equal(replay.events.every((e:any)=>!('mask' in e)),true);assert.equal(replay.more,false);
    const current=await (await fetch(prefix+`/projects/${id}`,{headers:a.headers})).json(),reader=new DatabaseSync(join(stateDir,'deepmark.sqlite'));assert.equal(reader.prepare('SELECT revision FROM shared_data WHERE project=?').get(id)!.revision,0);reader.close();
    for(const ws of sockets)ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));closed=true;
    const restored=openCollaborationStore(join(stateDir,'deepmark.sqlite'));try{const state=restored.state(id);assert.equal(state.revision,3);assert.equal(gunzipSync(Buffer.from(state.mask,'base64')).readUInt16LE(0),1);assert.deepEqual(state.regions,current.regions);assert.deepEqual(state.labels,current.labels);}finally{restored.close();}
  }finally{if(!closed){for(const ws of sockets)ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
