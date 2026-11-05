import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import WebSocket from 'ws';
import {createDatasetServer} from '../server/server.mjs';

const environmentKeys=['COOKIE_NAME','COOKIE_PATH','COOKIE_SECURE','PUBLIC_BASE_PATH'] as const;
async function environment(values:Partial<Record<typeof environmentKeys[number],string>>,run:()=>Promise<void>){
  const previous=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
  for(const key of environmentKeys){if(values[key]===undefined)delete process.env[key];else process.env[key]=values[key];}
  try{await run();}finally{for(const key of environmentKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
}
function sample(){
  const bytes=Buffer.alloc(368),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  view.setInt32(0,348,true);view.setInt16(40,3,true);
  for(let axis=0;axis<3;axis++){view.setInt16(42+axis*2,2,true);view.setFloat32(80+axis*4,1,true);}
  view.setInt16(70,4,true);view.setInt16(72,16,true);view.setFloat32(108,352,true);
  bytes.set([110,43,49,0],344);return bytes;
}
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'deepmark-deployment-paths-'));
  const datasetDir=join(directory,'datasets'),distDir=join(directory,'dist'),stateDir=join(directory,'state');
  await Promise.all([mkdir(datasetDir),mkdir(distDir)]);
  const bytes=sample();await writeFile(join(datasetDir,'synthetic.nii'),bytes);await writeFile(join(distDir,'index.html'),'<h1>Deployment test</h1>');
  const server=createDatasetServer({datasetDir,distDir,stateDir});
  const sockets:WebSocket[]=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,base=origin+'/api/collaboration';
  const post=(path:string,body:unknown,cookie?:string)=>fetch(base+path,{method:'POST',headers:{'X-Deepmark-Request':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  return {server,sockets,origin,base,post,bytes,port};
}
function websocketReady(socket:WebSocket){
  return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('WebSocket did not authenticate'));},3000);
    socket.once('message',data=>{clearTimeout(timer);resolve(JSON.parse(data.toString()));});
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}
function websocketRejected(socket:WebSocket){
  return new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('Unauthenticated WebSocket was not rejected'));},3000);
    socket.once('open',()=>{clearTimeout(timer);socket.terminate();reject(new Error('Wrong cookie authenticated WebSocket'));});
    socket.once('error',()=>{clearTimeout(timer);resolve();});
    socket.once('close',()=>{clearTimeout(timer);resolve();});
  });
}

test('default deployment retains root API, session cookie and download URLs',async t=>{
  await environment({},async()=>{
    const app=await fixture(t),list=await (await fetch(app.origin+'/api/datasets')).json();
    assert.equal(list.datasets.length,1);assert.match(list.datasets[0].downloadUrl,/^\/api\/datasets\/[a-f0-9]{64}\/download$/);
    assert.deepEqual(Buffer.from(await (await fetch(app.origin+list.datasets[0].downloadUrl)).arrayBuffer()),app.bytes);
    const session=await app.post('/session',{name:'Default engineer'}),header=session.headers.get('set-cookie')!;
    assert.equal(session.status,200);assert.match(header,/^deepmark_session=[a-f0-9]{64};/);assert.match(header,/; Path=\/;/);assert.doesNotMatch(header,/; Secure/);
    const response=await fetch(app.base+'/session',{headers:{Cookie:header.split(';')[0]}});
    assert.equal((await response.json()).person.name,'Default engineer');
  });
});

test('mounted deployment isolates cookies for HTTP, WebSocket and logout',async t=>{
  await environment({COOKIE_NAME:'deepmark_mimics_session',COOKIE_PATH:'/mimics/',COOKIE_SECURE:'1',PUBLIC_BASE_PATH:'/mimics/'},async()=>{
    const app=await fixture(t),list=await (await fetch(app.origin+'/api/datasets')).json(),dataset=list.datasets[0];
    assert.match(dataset.downloadUrl,/^\/mimics\/api\/datasets\/[a-f0-9]{64}\/download$/);
    // The proxy removes the mount prefix before the server receives the request.
    assert.deepEqual(Buffer.from(await (await fetch(app.origin+dataset.downloadUrl.slice('/mimics'.length))).arrayBuffer()),app.bytes);
    const session=await app.post('/session',{name:'Mounted engineer'}),header=session.headers.get('set-cookie')!,token=header.split(';')[0].split('=')[1];
    assert.equal(session.status,200);assert.match(header,/^deepmark_mimics_session=[a-f0-9]{64};/);assert.match(header,/; Path=\/mimics\/;/);assert.match(header,/; HttpOnly;/);assert.match(header,/; SameSite=Lax;/);assert.match(header,/; Secure$/);
    const cookie=`deepmark_session=${'f'.repeat(64)}; deepmark_mimics_session=${token}`;
    // Cookie options belong to this running server, not mutable process state.
    process.env.COOKIE_NAME='another_cookie';
    assert.equal((await (await fetch(app.base+'/session',{headers:{Cookie:cookie}})).json()).person.name,'Mounted engineer');
    process.env.COOKIE_NAME='deepmark_mimics_session';
    assert.equal((await (await fetch(app.base+'/session',{headers:{Cookie:`deepmark_session=${token}`}})).json()).person,null);
    const joined=await app.post('/projects',{datasetId:dataset.id},cookie),project=await joined.json();assert.equal(joined.status,200);
    const socket=new WebSocket(`ws://127.0.0.1:${app.port}/api/collaboration/socket?project=${project.id}`,{headers:{Cookie:cookie,Origin:app.origin}});app.sockets.push(socket);
    assert.equal((await websocketReady(socket)).ready,true);
    const wrong=new WebSocket(`ws://127.0.0.1:${app.port}/api/collaboration/socket?project=${project.id}`,{headers:{Cookie:`deepmark_session=${token}`,Origin:app.origin}});app.sockets.push(wrong);await websocketRejected(wrong);
    const closed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Logout did not close its WebSocket')),3000);socket.once('close',()=>{clearTimeout(timer);resolve();});});
    const logout=await app.post('/logout',{},cookie);assert.equal(logout.status,200);
    assert.equal(logout.headers.get('set-cookie'),'deepmark_mimics_session=; HttpOnly; SameSite=Lax; Path=/mimics/; Max-Age=0; Secure');
    await closed;
    assert.equal((await (await fetch(app.base+'/session',{headers:{Cookie:cookie}})).json()).person,null);
    assert.equal((await fetch(app.base+`/projects/${project.id}/history`,{headers:{Cookie:cookie}})).status,401);
  });
});

test('root public base remains compatible and invalid deployment values fail before opening state',async t=>{
  await environment({PUBLIC_BASE_PATH:'/'},async()=>{
    const app=await fixture(t),list=await (await fetch(app.origin+'/api/datasets')).json();
    assert.match(list.datasets[0].downloadUrl,/^\/api\//);
  });
  const directory=await mkdtemp(join(tmpdir(),'deepmark-invalid-deployment-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const invalid:{key:typeof environmentKeys[number];value:string}[]=[
    ...['9invalid','bad name','bad;name','bad\r\nname','a'.repeat(81)].map(value=>({key:'COOKIE_NAME' as const,value})),
    ...['mimics','/mimics; Secure','/mimics\r\nInjected','//mimics/','/mimics/../','/mimics/./','/mimics?query','/mimics#hash','/mimics\\x'].map(value=>({key:'COOKIE_PATH' as const,value})),
    ...['mimics','/mimics;bad','//mimics','/mimics/../','/mimics/./','/mimics?query','/mimics#hash','/mimics%2fescape'].map(value=>({key:'PUBLIC_BASE_PATH' as const,value})),
  ];
  for(const [index,entry]of invalid.entries()){
    await environment({[entry.key]:entry.value},async()=>{
      const stateDir=join(directory,String(index));
      assert.throws(()=>createDatasetServer({datasetDir:directory,distDir:directory,stateDir}),new RegExp(entry.key));
      await assert.rejects(access(stateDir),{code:'ENOENT'});
    });
  }
});

test('health GET and HEAD work without scanning missing dataset or static directories',async t=>{
  await environment({},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'deepmark-deployment-health-'));
    const datasetDir=join(directory,'missing-datasets'),distDir=join(directory,'missing-dist');
    const server=createDatasetServer({datasetDir,distDir,stateDir:join(directory,'state')});
    t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const get=await fetch(origin+'/api/health');assert.equal(get.status,200);assert.deepEqual(await get.json(),{status:'ok',backend:'node',pid:process.pid});
    const head=await fetch(origin+'/api/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
    assert.equal((await fetch(origin+'/api/datasets')).status,503,'the dataset directory really is unavailable');
    await assert.rejects(access(datasetDir),{code:'ENOENT'});await assert.rejects(access(distDir),{code:'ENOENT'});
  });
});
