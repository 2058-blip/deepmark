import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,relative,resolve} from 'node:path';

// Read-only verification after a real Java-process restart. Never logs checkpoint credentials.
assert.ok(process.env.DEEPMARK_TEST_CHECKPOINT,'Set DEEPMARK_TEST_CHECKPOINT to the successful integration run checkpoint.');
assert.ok(process.env.DEEPMARK_TEST_URL,'Set DEEPMARK_TEST_URL to the restarted isolated Java server.');
assert.ok(process.env.DEEPMARK_TEST_DB,'Set DEEPMARK_TEST_DB to the same isolated SQLite file.');
const temporaryRoot=await realpath(tmpdir());
function assertTemporary(path,label){
  const inside=relative(temporaryRoot,path);
  assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),`${label} must be inside the OS temp directory.`);
}
const checkpointPath=await realpath(resolve(process.env.DEEPMARK_TEST_CHECKPOINT));
assertTemporary(checkpointPath,'Checkpoint');
const checkpointStat=await stat(checkpointPath);
assert.ok(checkpointStat.isFile(),'Checkpoint must be a regular file.');
if(process.platform!=='win32')assert.equal(checkpointStat.mode&0o077,0,'Checkpoint containing session credentials must be private (0600).');
let checkpoint;
try{checkpoint=JSON.parse(await readFile(checkpointPath,'utf8'));}
catch{throw new Error('Cannot read valid restart checkpoint JSON.');}
assert.equal(checkpoint.format,'deepmark-restart-1','Unknown checkpoint format.');
const origin=new URL(process.env.DEEPMARK_TEST_URL).origin;
assert.ok(['http:','https:'].includes(new URL(origin).protocol),'Expected an HTTP(S) test URL.');
assert.equal(origin,checkpoint.origin,'Restart verification must use the original origin; credentials cannot be sent to a different server.');
const databasePath=await realpath(resolve(process.env.DEEPMARK_TEST_DB));
assertTemporary(databasePath,'Database');
assert.equal(databasePath,checkpoint.databasePath,'Restart the service with the original test database.');
const {projectId,datasetId,expected,accounts}=checkpoint;
assert.ok(typeof projectId==='string'&&typeof datasetId==='string'&&expected&&accounts,'Incomplete restart checkpoint.');
assert.ok(expected.snapshots?.leader?.regions?.length>0,'Restart checkpoint must exercise a nonempty parallel region.');
assert.ok(checkpoint.sourcePath===`/api/datasets/${datasetId}/download`,'Unexpected source download path.');
let assertions=0;
function equal(actual,wanted,message){assert.deepEqual(actual,wanted,message);assertions++;}
function checked(value,message){assert.ok(value,message);assertions++;}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function request(path,account){
  const url=new URL(path,origin);
  assert.equal(url.origin,origin,'Test request must remain on the original origin.');
  const response=await fetch(url,{headers:account?{Cookie:account.cookie}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  let data=null;try{data=JSON.parse(bytes.toString('utf8'));}catch{}
  return {status:response.status,bytes,data,headers:response.headers};
}
async function json(path,account){
  const response=await request(path,account);equal(response.status,200,`GET ${path} must succeed after restart`);
  checked(response.data!==null,`GET ${path} must return JSON`);return response.data;
}

equal((await json('/api/health')).backend,'java');
for(const role of ['dispatcher','leader','nonmember','foreignDispatcher']){
  const account=accounts[role];
  checked(account&&typeof account.cookie==='string'&&account.cookie.startsWith('deepmark_session='),`Missing ${role} checkpoint session`);
  equal((await json('/api/auth/me',account)).user,account.user,`${role} cookie session must survive restart`);
}
equal((await json('/api/auth/me')).user,null,'Anonymous requests must remain anonymous');
console.log('✓ Persisted cookie sessions and roles survive the Java restart');

for(const role of ['dispatcher','leader']){
  const snapshot=await json(`/api/collaboration/projects/${projectId}`,accounts[role]);
  equal(snapshot,expected.snapshots[role],`${role} mask, labels, regions, ownership, revision and final status must survive restart`);
  equal(snapshot.canWrite,false,'Completed projects must remain locked after restart');
}
equal(await json(`/api/collaboration/projects/${projectId}/history`,accounts.leader),expected.history,'Revision history must survive restart');
equal(await json(`/api/collaboration/projects/${projectId}/events?after=0`,accounts.leader),expected.events,'Durable deltas must survive restart');
equal(await json(`/api/datasets/${datasetId}/status`,accounts.dispatcher),expected.dataset,'Dataset status, membership and activity must survive restart');
const provenance=[];
for(const before of expected.provenance){
  const after=await json(`/api/collaboration/projects/${projectId}/provenance?index=${before.index}&revision=${expected.snapshots.leader.revision}`,accounts.leader);
  equal(after,before,`Voxel ${before.index} author and parallel annotations must survive restart`);provenance.push(after);
}
equal(provenance.length,64,'Every voxel in the test fixture must have a persisted provenance result');
const authors=[...new Map(provenance.filter(item=>item.author).map(item=>[item.author.id,item.author])).values()].sort((a,b)=>a.id.localeCompare(b.id));
equal(authors,expected.authors,'Authenticated annotation authors must survive restart');
console.log('✓ Complete snapshots, all 64 voxel authors, parallel regions, deltas and history persist');

for(const role of ['dispatcher','leader']){
  const downloaded=await request(checkpoint.sourcePath,accounts[role]);
  equal(downloaded.status,200,`${role} must retain source download access`);
  equal(digest(downloaded.bytes),expected.sourceSha256,'Original NIfTI bytes must survive restart');
  const exported=await request(`/api/collaboration/projects/${projectId}/export`,accounts[role]);
  equal(exported.status,200,`${role} must retain completed ZIP access`);
  checked(/zip/i.test(exported.headers.get('content-type')||''),'Export must remain a ZIP');
  equal(digest(exported.bytes),expected.zipSha256,'Completed ZIP bytes and metadata must survive restart');
}
for(const [role,account,status] of [['anonymous',null,401],['nonmember',accounts.nonmember,403],['foreignDispatcher',accounts.foreignDispatcher,403]]){
  for(const path of [checkpoint.sourcePath,`/api/collaboration/projects/${projectId}`,`/api/collaboration/projects/${projectId}/export`]){
    equal((await request(path,account)).status,status,`${role} must still be denied protected source, project and export access`);
  }
}
console.log('✓ Original source and completed ZIP are identical; download and project permissions persist');
console.log(`Platform restart verification passed (${assertions} assertions; read-only checks).`);
