import assert from 'node:assert/strict';
import {constants,createHash,createPublicKey,pbkdf2Sync,publicEncrypt,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import WebSocket from 'ws';
import {unzipSync} from 'fflate';

// Run only against a dedicated Java server and a database under the OS temp directory.
// The suite creates random accounts, groups and datasets, and never deletes existing data.
const configured=process.env.DEEPMARK_TEST_URL;
assert.ok(configured,'Set DEEPMARK_TEST_URL to an isolated Java test server.');
const origin=new URL(configured).origin;
assert.ok(['http:','https:'].includes(new URL(origin).protocol),'Expected an HTTP(S) test URL.');
assert.ok(process.env.DEEPMARK_TEST_DB,'Set DEEPMARK_TEST_DB to the isolated server SQLite file.');
const databasePath=await realpath(resolve(process.env.DEEPMARK_TEST_DB));
const temporaryRoot=await realpath(tmpdir()),databaseRelative=relative(temporaryRoot,databasePath);
assert.ok(databaseRelative&&!databaseRelative.startsWith('..')&&!isAbsolute(databaseRelative),
  'Integration tests require a database inside the OS temp directory; production data is not accepted.');
let checkpointPath=null;
if(process.env.DEEPMARK_TEST_CHECKPOINT){
  const requested=resolve(process.env.DEEPMARK_TEST_CHECKPOINT),parent=await realpath(dirname(requested)),inside=relative(temporaryRoot,parent);
  assert.ok((!inside||!inside.startsWith('..'))&&!isAbsolute(inside),'Restart checkpoints must be inside the OS temp directory.');
  checkpointPath=resolve(parent,basename(requested));
}
const run=randomUUID().replaceAll('-','').slice(0,12),sockets=new Set(),accounts=[];
const password=`Dm-${randomBytes(18).toString('base64url')}!42`;
let assertions=0;
function checked(condition,message){assert.ok(condition,message);assertions++;}
function equal(actual,expected,message){assert.deepEqual(actual,expected,message);assertions++;}
const delay=ms=>new Promise(done=>setTimeout(done,ms));

class Client {
  constructor(name){this.name=name;this.cookie='';this.user=null;this.username='';this.password='';}
  async request(path,{method='GET',body,headers={},marker=true}={}){
    const requestHeaders={...(this.cookie?{Cookie:this.cookie}:{}),...(method==='GET'||method==='HEAD'||!marker?{}:{'X-Deepmark-Request':'1'}),...headers};
    let content=body;
    if(body!==undefined&&!(body instanceof FormData)){requestHeaders['Content-Type']='application/json';content=JSON.stringify(body);}
    const response=await fetch(origin+path,{method,headers:requestHeaders,body:content,signal:AbortSignal.timeout(15000)});
    const setCookie=response.headers.get('set-cookie');
    if(setCookie){this.cookie=setCookie.split(';')[0];this.setCookie=setCookie;}
    const bytes=Buffer.from(await response.arrayBuffer());
    let data=null;try{data=JSON.parse(bytes.toString('utf8'));}catch{}
    return {status:response.status,data,bytes,headers:response.headers};
  }
  async json(path,options={},expected=200){
    const result=await this.request(path,options);
    equal(result.status,expected,`${this.name}: ${options.method||'GET'} ${path}: ${JSON.stringify(result.data)}`);
    checked(result.data!==null,`${path} must return JSON`);return result.data;
  }
}
const anonymous=new Client('anonymous');
async function challenge(){
  const value=await anonymous.json('/api/auth/challenge');
  equal(value.algorithm,'RSA-OAEP-256');checked(value.challengeId&&value.publicKey,'Challenge must include ID and SPKI public key');
  checked(Number.isFinite(value.expiresAt)&&value.expiresAt>Date.now(),'Challenge must have a future expiry');return value;
}
function encrypted(value,secret){
  const key=createPublicKey({key:Buffer.from(value.publicKey,'base64'),format:'der',type:'spki'});
  return publicEncrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},
    Buffer.from(JSON.stringify({challengeId:value.challengeId,password:secret}),'utf8')).toString('base64');
}
async function credentials(username,secret,value){
  value??=await challenge();
  return {username,challengeId:value.challengeId,encryptedPassword:encrypted(value,secret)};
}
async function register(suffix,role){
  const client=new Client(suffix);client.username=`it_${run}_${suffix}`;client.password=password;
  const data=await client.json('/api/auth/register',{method:'POST',body:{...await credentials(client.username,client.password),name:`集成测试 ${suffix}`,role}},201);
  client.user=data.user;equal(client.user.role,role);equal(client.user.username,client.username);
  checked(client.cookie.startsWith('deepmark_session='),'Registration must establish a session cookie');
  checked(/HttpOnly/i.test(client.setCookie)&&/SameSite=Lax/i.test(client.setCookie),'Session cookie must be HttpOnly and SameSite=Lax');
  if(new URL(origin).protocol==='https:')checked(/(?:^|;\s*)Secure(?:;|$)/i.test(client.setCookie),'HTTPS session cookies must be Secure');
  equal((await client.json('/api/auth/me')).user.id,client.user.id);accounts.push(client);return client;
}
function nifti(){
  const bytes=Buffer.alloc(352+4*4*4*2),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  view.setInt32(0,348,true);view.setInt16(40,3,true);
  for(let axis=0;axis<3;axis++){view.setInt16(42+2*axis,4,true);view.setFloat32(80+4*axis,1,true);}
  view.setInt16(70,4,true);view.setInt16(72,16,true);view.setFloat32(108,352,true);view.setFloat32(112,1,true);
  view.setInt16(254,1,true);view.setFloat32(280,1,true);view.setFloat32(300,1,true);view.setFloat32(320,1,true);
  view.setUint8(123,2);bytes.set([110,43,49,0],344);
  for(let index=0;index<64;index++)view.setInt16(352+index*2,index*10,true);return bytes;
}
const source=nifti(),fingerprint=createHash('sha256').update(source).digest('hex');
function invalidNifti(kind){
  if(kind==='pixelNaN'){
    const bytes=Buffer.alloc(352+64*4);source.copy(bytes,0,0,352);
    bytes.writeInt16LE(16,70);bytes.writeInt16LE(32,72);bytes.writeFloatLE(NaN,352);return bytes;
  }
  const bytes=Buffer.from(source);
  if(kind==='qformNaN'){bytes.writeInt16LE(0,254);bytes.writeInt16LE(1,252);bytes.writeFloatLE(NaN,256);}
  else if(kind==='sformzero')bytes.fill(0,280,328);
  else throw new Error('Unknown invalid NIfTI fixture');return bytes;
}
async function upload(client,suffix){
  const body=new FormData();body.append('file',new Blob([source],{type:'application/octet-stream'}),`integration-${run}-${suffix}.nii`);
  const response=await client.request('/api/datasets/upload',{method:'POST',body});
  checked([200,201].includes(response.status),`Upload failed: ${response.status} ${JSON.stringify(response.data)}`);
  const dataset=response.data?.dataset;checked(dataset?.id,'Upload must return a dataset');equal(dataset.status,'unassigned');return dataset;
}
function patch(entries){
  const bytes=Buffer.alloc(entries.length*8);[...entries].sort((a,b)=>a[0]-b[0]).forEach(([index,before,after],offset)=>{
    bytes.writeUInt32LE(index,offset*8);bytes.writeUInt16LE(before,offset*8+4);bytes.writeUInt16LE(after,offset*8+6);
  });return bytes.toString('base64');
}
function operation(revision,index,before,after,suffix){return {op:`it-${run}-${suffix}`,baseRevision:revision,patch:patch([[index,before,after]]),kind:'edit'};}
function values(state){const raw=gunzipSync(Buffer.from(state.mask,'base64'));return Array.from({length:raw.length/2},(_,i)=>raw.readUInt16LE(i*2));}

class Channel {
  constructor(client,project){
    this.messages=[];this.waiters=[];this.denial=null;this.received=0;
    const url=new URL('/api/collaboration/socket',origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('project',project);
    this.socket=new WebSocket(url,{headers:{Cookie:client.cookie,Origin:origin}});sockets.add(this.socket);
    this.socket.on('message',raw=>{this.received++;let message;try{message=JSON.parse(raw.toString());}catch(error){this.fail(error);return;}
      const index=this.waiters.findIndex(waiter=>waiter.predicate(message));
      if(index<0)this.messages.push(message);else{const [waiter]=this.waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message);}
    });
    this.socket.on('unexpected-response',(_request,response)=>{this.denial=response.statusCode;response.resume();this.fail(Object.assign(new Error(`WebSocket HTTP ${response.statusCode}`),{status:response.statusCode}));});
    this.socket.on('error',error=>this.fail(error));
    this.socket.on('close',(code,reason)=>{sockets.delete(this.socket);this.fail(Object.assign(new Error(`WebSocket closed (${code}: ${reason.toString()})`),{status:this.denial,closeCode:code}));});
  }
  fail(error){this.failure=error;for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(error);}}
  wait(predicate,timeout=8000){
    const index=this.messages.findIndex(predicate);if(index>=0)return Promise.resolve(this.messages.splice(index,1)[0]);
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{this.waiters=this.waiters.filter(item=>item!==waiter);reject(new Error('Timed out waiting for WebSocket event'));},timeout)};this.waiters.push(waiter);});
  }
  send(client,op){this.socket.send(JSON.stringify({type:'operation',requestId:op.op,author:client.user.id,operation:op}));}
}
async function connect(client,project){const channel=new Channel(client,project);const ready=await channel.wait(value=>value.type==='ready');equal(ready.projectId,project);return channel;}
async function deniedSocket(client,project){
  const channel=new Channel(client,project);
  try{await channel.wait(value=>value.type==='ready');assert.fail('Unauthorized WebSocket was accepted');}
  catch(error){
    checked([401,403].includes(error.status),`Expected HTTP 401/403 before WebSocket upgrade, got ${error.message}`);
    equal(channel.received,0,'An unauthorized socket must not receive ready, deltas or any other application data');
  }
  finally{channel.socket.terminate();}
}

try{
  equal((await anonymous.json('/api/health')).backend,'java');
  equal((await anonymous.json('/api/auth/me')).user,null);
  equal((await anonymous.request('/api/datasets')).status,401,'Anonymous dataset catalog must be protected');
  const expired=await challenge();
  checked(expired.expiresAt-Date.now()<=10000,'Start the test server with DEEPMARK_CHALLENGE_TTL_SECONDS=3 to test expiry without a long wait.');

  const dispatcher=await register('dispatch','dispatcher'),foreignDispatcher=await register('dispatch_b','dispatcher'),leader=await register('leader_a','worker'),member=await register('member','worker'),otherLeader=await register('leader_b','worker'),outsider=await register('outsider','worker');
  console.log('✓ RSA registration, role selection and independent cookie sessions');

  equal((await anonymous.request('/api/auth/login',{method:'POST',body:{username:leader.username,password:leader.password}})).status,400,'Plaintext password fields must be rejected');
  const oldLeaderCookie=leader.cookie,loginPayload=await credentials(leader.username,leader.password);
  equal((await leader.json('/api/auth/login',{method:'POST',body:loginPayload})).user.id,leader.user.id);
  const revoked=new Client('revoked-session');revoked.cookie=oldLeaderCookie;
  equal((await revoked.json('/api/auth/me')).user,null,'Successful login must rotate the current browser session');
  equal((await anonymous.request('/api/auth/login',{method:'POST',body:loginPayload})).status,400,'A consumed challenge must not be replayable');
  equal((await anonymous.request('/api/auth/login',{method:'POST',body:await credentials(leader.username,'wrong-password-42')})).status,401);
  const noMarker=await credentials(leader.username,leader.password);
  equal((await anonymous.request('/api/auth/login',{method:'POST',body:noMarker,marker:false})).status,403);
  const crossOrigin=await credentials(leader.username,leader.password);
  equal((await anonymous.request('/api/auth/login',{method:'POST',body:crossOrigin,headers:{Origin:'https://foreign.invalid'}})).status,403);
  await delay(Math.max(0,expired.expiresAt-Date.now()+80));
  equal((await anonymous.request('/api/auth/login',{method:'POST',body:await credentials(leader.username,leader.password,expired)})).status,400,'Expired challenges must fail');
  console.log('✓ Challenge one-time use/expiry, incorrect password, plaintext and cross-origin rejection');

  const group=(await leader.json('/api/groups',{method:'POST',body:{name:`测试组 A ${run}`}},201)).group;
  const rival=(await otherLeader.json('/api/groups',{method:'POST',body:{name:`测试组 B ${run}`}},201)).group;
  equal(group.leaderId,leader.user.id);equal(group.isLeader,true);
  const joined=(await member.json('/api/groups/join',{method:'POST',body:{code:group.code}})).group;
  equal(joined.isLeader,false);checked(joined.members.some(user=>user.id===member.user.id),'Joined group must contain the new member');
  equal((await member.json('/api/groups')).groups.length,1);equal((await outsider.json('/api/groups')).groups.length,0);
  equal((await dispatcher.request('/api/groups',{method:'POST',body:{name:'forbidden'}})).status,403);
  equal((await dispatcher.request('/api/groups/join',{method:'POST',body:{code:group.code}})).status,403);
  equal((await leader.request('/api/groups',{method:'POST',body:{name:'without-marker'},marker:false})).status,403);

  const beforeInvalid=(await dispatcher.json('/api/datasets')).datasets.map(item=>item.id).sort();
  for(const kind of ['qformNaN','sformzero','pixelNaN']){
    const body=new FormData();body.append('file',new Blob([invalidNifti(kind)],{type:'application/octet-stream'}),`invalid-${run}-${kind}.nii`);
    equal((await dispatcher.request('/api/datasets/upload',{method:'POST',body})).status,400,`Invalid ${kind} upload must be rejected`);
    equal((await dispatcher.json('/api/datasets')).datasets.map(item=>item.id).sort(),beforeInvalid,'Rejected uploads must not leave ghost datasets');
  }
  const dataset=await upload(dispatcher,'main'),race=await upload(dispatcher,'race');
  checked(!(await foreignDispatcher.json('/api/datasets')).datasets.some(item=>item.id===dataset.id),'Dispatchers must only list their own published datasets');
  equal((await member.request('/api/datasets/upload',{method:'POST',body:new FormData()})).status,403,'Workers cannot publish datasets');
  equal((await anonymous.request(dataset.downloadUrl)).status,401,'Anonymous source download must be protected');
  equal((await member.request(`/api/datasets/${dataset.id}/claim`,{method:'POST',body:{groupId:group.id}})).status,403,'Only a group leader can claim');
  equal((await dispatcher.request(`/api/datasets/${dataset.id}/claim`,{method:'POST',body:{groupId:group.id}})).status,403);
  equal((await outsider.request(`/api/datasets/${dataset.id}/claim`,{method:'POST',body:{groupId:group.id}})).status,403);
  const claimed=(await leader.json(`/api/datasets/${dataset.id}/claim`,{method:'POST',body:{groupId:group.id}})).dataset;
  equal(claimed.status,'in_progress');equal(claimed.groupId,group.id);
  const contested=await Promise.all([
    leader.request(`/api/datasets/${race.id}/claim`,{method:'POST',body:{groupId:group.id}}),
    otherLeader.request(`/api/datasets/${race.id}/claim`,{method:'POST',body:{groupId:rival.id}}),
  ]);
  equal(contested.map(reply=>reply.status).sort(),[200,409],'A concurrent claim must have exactly one winner');
  const winner=contested[0].status===200?group.id:rival.id;
  equal((await dispatcher.json(`/api/datasets/${race.id}/status`)).dataset.groupId,winner);
  equal((await member.request(dataset.downloadUrl)).bytes,source);
  equal((await outsider.request(dataset.downloadUrl)).status,403,'Nonmembers cannot download assigned source data');
  equal((await foreignDispatcher.request(dataset.downloadUrl)).status,403,'Another dispatcher cannot read the publisher source');
  console.log('✓ Group membership, dispatcher/worker permissions and atomic leader-only claiming');

  const opened=await leader.json('/api/collaboration/projects',{method:'POST',body:{datasetId:dataset.id,fingerprint}}),projectId=opened.id;
  checked(projectId,'Opening a claimed dataset must return a project');equal(opened.canWrite,true);
  equal((await dispatcher.json(`/api/collaboration/projects/${projectId}`)).canWrite,false);
  equal((await outsider.request(`/api/collaboration/projects/${projectId}`)).status,403);
  equal((await foreignDispatcher.request(`/api/collaboration/projects/${projectId}`)).status,403);
  equal((await leader.request('/api/collaboration/projects',{method:'POST',body:{datasetId:dataset.id,fingerprint:'0'.repeat(64)}})).status,409,'Source fingerprint mismatches must fail');
  const monitor=await connect(dispatcher,projectId),workerSocket=await connect(member,projectId),leaderSocket=await connect(leader,projectId);
  await deniedSocket(anonymous,projectId);await deniedSocket(outsider,projectId);await deniedSocket(foreignDispatcher,projectId);
  const first=operation(opened.revision,1,0,1,'http');
  const monitoredFirst=monitor.wait(value=>value.type==='delta'&&value.op===first.op);
  const reply=await member.json(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:first});
  equal(reply.revision,opened.revision+1);equal((await monitoredFirst).revision,reply.revision);
  const duplicate=await member.json(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:first});
  equal(duplicate.duplicate,true);equal(duplicate.revision,reply.revision);
  equal((await leader.request(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:first})).status,409,'Another author cannot reuse an operation ID');
  const second=operation(reply.revision,0,0,1,'socket'),secondAck=leaderSocket.wait(value=>value.type==='ack'&&value.requestId===second.op),secondMonitor=monitor.wait(value=>value.type==='delta'&&value.op===second.op);
  leaderSocket.send(leader,second);equal((await secondAck).revision,reply.revision+1);await secondMonitor;
  let state=await member.json(`/api/collaboration/projects/${projectId}`);equal(values(state).slice(0,3),[1,1,0]);
  let revision=state.revision;
  const forbidden=operation(revision,2,0,1,'forbidden-http');
  equal((await dispatcher.request(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:forbidden})).status,403);
  equal((await outsider.request(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:forbidden})).status,403);
  equal((await dispatcher.request(`/api/collaboration/projects/${projectId}/labels`,{method:'POST',body:{}})).status,403);
  const forbiddenSocket=operation(revision,2,0,1,'forbidden-socket'),monitorError=monitor.wait(value=>value.type==='error'&&value.requestId===forbiddenSocket.op);
  monitor.send(dispatcher,forbiddenSocket);equal((await monitorError).status,403);
  const forged=operation(revision,2,0,1,'forged-author'),forgedError=workerSocket.wait(value=>value.type==='error'&&value.requestId===forged.op);
  workerSocket.socket.send(JSON.stringify({type:'operation',requestId:forged.op,author:leader.user.id,operation:forged}));
  checked([401,403].includes((await forgedError).status),'WebSocket author must match its cookie session');
  state=await member.json(`/api/collaboration/projects/${projectId}`);equal(state.revision,revision);equal(values(state).slice(0,3),[1,1,0]);
  const events=await member.json(`/api/collaboration/projects/${projectId}/events?after=${opened.revision}`);
  equal(events.events.map(event=>event.revision),[opened.revision+1,opened.revision+2]);
  const history=await member.json(`/api/collaboration/projects/${projectId}/history`);
  checked(history.events.some(event=>event.author===member.user.id),'History must identify the authenticated member');
  console.log('✓ HTTP/WS collaboration, read-only live monitoring, author validation and idempotent revisions');

  const label=await leader.json(`/api/collaboration/projects/${projectId}/labels`,{method:'POST',body:{op:`it-${run}-parallel-label`,name:'Parallel opinion',color:'#12ab34'}});
  equal(label.label.id,2);equal(label.revision,revision+1);
  const parallel=operation(label.revision,0,1,2,'parallel-opinion');
  const parallelReply=await member.json(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:parallel});
  equal(parallelReply.revision,label.revision+1);checked(parallelReply.parallelCount>0,'A different member opinion must create a parallel region');
  state=await leader.json(`/api/collaboration/projects/${projectId}`);revision=state.revision;
  equal(revision,parallelReply.revision);equal(values(state).slice(0,3),[1,1,0],'Parallel opinions must preserve the canonical label map');
  checked(state.regions.length>0&&state.regions.some(region=>region.indices.includes(0)),'The completed fixture must retain a nonempty parallel region');
  const parallelProvenance=await leader.json(`/api/collaboration/projects/${projectId}/provenance?index=0&revision=${revision}`);
  equal(parallelProvenance.author.id,leader.user.id,'Canonical voxel ownership must remain with its original author');
  checked(parallelProvenance.annotations.some(row=>row.author===leader.user.id&&row.label===1)&&parallelProvenance.annotations.some(row=>row.author===member.user.id&&row.label===2),'Parallel provenance must preserve both authenticated opinions');

  equal((await member.request(`/api/datasets/${dataset.id}/complete`,{method:'POST',body:{revision}})).status,403);
  equal((await dispatcher.request(`/api/datasets/${dataset.id}/complete`,{method:'POST',body:{revision}})).status,403);
  equal((await otherLeader.request(`/api/datasets/${dataset.id}/complete`,{method:'POST',body:{revision}})).status,403);
  for(const body of [{},{revision:null},{revision:-1},{revision:1.5},{revision:String(revision)},{revision:1e30}]){
    equal((await leader.request(`/api/datasets/${dataset.id}/complete`,{method:'POST',body})).status,400,'Completion requires an explicit nonnegative integer revision');
    equal((await leader.json(`/api/datasets/${dataset.id}/status`)).dataset.status,'in_progress','Invalid completion must not finalize the dataset');
  }
  equal((await leader.request(`/api/datasets/${dataset.id}/complete`,{method:'POST',body:{revision:revision-1}})).status,409,'Completion at a stale revision must fail');
  equal((await member.json(`/api/collaboration/projects/${projectId}`)).revision,revision,'Invalid or stale completion must preserve the project revision');
  const finalizedEvent=monitor.wait(value=>value.type==='delta'&&value.status==='finalized');
  const completed=(await leader.json(`/api/datasets/${dataset.id}/complete`,{method:'POST',body:{revision}})).dataset;
  equal(completed.status,'completed');await finalizedEvent;
  const locked=operation(revision,2,0,1,'after-complete-http');
  equal((await member.request(`/api/collaboration/projects/${projectId}/operations`,{method:'POST',body:locked})).status,423);
  equal((await member.request(`/api/collaboration/projects/${projectId}/labels`,{method:'POST',body:{}})).status,423);
  const liveLocked=operation(revision,2,0,1,'after-complete-socket'),lockedAck=workerSocket.wait(value=>value.type==='error'&&value.requestId===liveLocked.op);
  workerSocket.send(member,liveLocked);equal((await lockedAck).status,423,'An already-connected socket must respect completion locks');
  const exported=await dispatcher.request(`/api/collaboration/projects/${projectId}/export`);
  equal(exported.status,200);checked(/zip/i.test(exported.headers.get('content-type')||''),'Completed export must be a ZIP');
  const files=unzipSync(exported.bytes);for(const filename of ['segmentation.nii','labels.json','manifest.json','parallel-annotations.json'])checked(files[filename],`Missing ${filename}`);
  const segmentation=Buffer.from(files['segmentation.nii']);equal(segmentation.readInt32LE(0),348);equal(segmentation.readUInt16LE(352),1);equal(segmentation.readUInt16LE(354),1);equal(segmentation.readUInt16LE(356),0);
  checked(JSON.parse(Buffer.from(files['labels.json']).toString('utf8')).segments.some(label=>label.id===1),'Export must preserve labels');
  checked(JSON.parse(Buffer.from(files['labels.json']).toString('utf8')).segments.some(label=>label.id===2&&label.name==='Parallel opinion'&&label.color==='#12ab34'),'Export must preserve edited label metadata');
  equal(JSON.parse(Buffer.from(files['parallel-annotations.json']).toString('utf8')).parallelRegions,state.regions,'Export must preserve nonempty parallel opinions');
  equal((await dispatcher.json(`/api/datasets/${dataset.id}/status`)).dataset.status,'completed');
  console.log('✓ Leader-only completion, existing-socket locks and readable completed ZIP export');

  const database=new DatabaseSync(databasePath,{readOnly:true});
  try{
    const salts=new Set(),hashes=new Set();
    for(const client of accounts){
      const row=database.prepare('SELECT password_hash,password_salt,password_iterations FROM users WHERE username=?').get(client.username);
      checked(row,`Missing account verifier for ${client.username}`);
      const hash=Buffer.from(row.password_hash),salt=Buffer.from(row.password_salt);
      equal(hash.length,32);checked(salt.length>=16,'Password salt must contain at least 128 random bits');
      checked(row.password_iterations>=600000,'PBKDF2 iteration count must meet the configured policy');
      const derived=pbkdf2Sync(client.password,salt,row.password_iterations,hash.length,'sha256');
      checked(timingSafeEqual(hash,derived),'Stored verifier must be salted PBKDF2-SHA256');
      checked(!hash.includes(Buffer.from(client.password))&&!salt.includes(Buffer.from(client.password)),'Passwords must not be stored in plaintext');
      salts.add(salt.toString('hex'));hashes.add(hash.toString('hex'));
    }
    equal(salts.size,accounts.length,'Equal passwords must still receive distinct salts');equal(hashes.size,accounts.length,'Equal passwords must have distinct salted hashes');
    const token=leader.cookie.split('=')[1],session=database.prepare('SELECT token_hash FROM sessions WHERE user_id=? AND token_hash=?').get(leader.user.id,createHash('sha256').update(token).digest('hex'));
    checked(session,'Only a SHA256 session-token hash should be persisted');checked(session.token_hash!==token,'A raw session token must not be stored');
  }finally{database.close();}
  await outsider.json('/api/auth/logout',{method:'POST',body:{}});equal((await outsider.json('/api/auth/me')).user,null);
  console.log('✓ Random per-account salts, verified password hashes, hashed sessions and logout');
  if(checkpointPath){
    const snapshots={dispatcher:await dispatcher.json(`/api/collaboration/projects/${projectId}`),leader:await leader.json(`/api/collaboration/projects/${projectId}`)};
    checked(snapshots.leader.regions.length>0,'Restart checkpoint must include nonempty parallel regions');
    const provenance=[];
    for(let index=0;index<64;index++)provenance.push(await leader.json(`/api/collaboration/projects/${projectId}/provenance?index=${index}&revision=${snapshots.leader.revision}`));
    const authors=[...new Map(provenance.filter(item=>item.author).map(item=>[item.author.id,item.author])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    const checkpoint={format:'deepmark-restart-1',origin,databasePath,projectId,datasetId:dataset.id,sourcePath:dataset.downloadUrl,
      accounts:Object.fromEntries([['dispatcher',dispatcher],['leader',leader],['nonmember',otherLeader],['foreignDispatcher',foreignDispatcher]].map(([role,client])=>[role,{cookie:client.cookie,user:client.user}])),
      expected:{snapshots,provenance,authors,history:await leader.json(`/api/collaboration/projects/${projectId}/history`),
        events:await leader.json(`/api/collaboration/projects/${projectId}/events?after=0`),dataset:await dispatcher.json(`/api/datasets/${dataset.id}/status`),
        sourceSha256:fingerprint,zipSha256:createHash('sha256').update(exported.bytes).digest('hex')}};
    await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    console.log('✓ Private restart checkpoint written; restart the Java service with the same data directories, then run tests/platform-restart.mjs');
  }
  console.log(`Platform integration passed (${assertions} assertions; fixtures ${run}; database retained for inspection).`);
}finally{
  for(const socket of sockets)socket.terminate();
}
