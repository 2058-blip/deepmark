import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID,publicEncrypt,createPublicKey,constants} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

// Run only against an isolated test server: creates disposable accounts, a group and a CT task.
const origin=process.env.DEEPMARK_BROWSER_URL||'http://127.0.0.1:8084';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const run=randomUUID().slice(0,8),name=`performance-${run}.nii.gz`;
let dims=[256,256,128],spacing=[1,1,1],source;
if(process.env.DEEPMARK_PERF_SOURCE){
  source=await readFile(process.env.DEEPMARK_PERF_SOURCE);
  const raw=gunzipSync(source),little=raw.readInt32LE(0)===348;
  dims=[0,1,2].map(i=>little?raw.readInt16LE(42+i*2):raw.readInt16BE(42+i*2));
  spacing=[0,1,2].map(i=>Math.abs(little?raw.readFloatLE(80+i*4):raw.readFloatBE(80+i*4)));
}else{
  const raw=Buffer.alloc(352+dims.reduce((a,b)=>a*b)*2);
  raw.writeInt32LE(348,0);raw.writeInt16LE(3,40);
  dims.forEach((n,i)=>{raw.writeInt16LE(n,42+i*2);raw.writeFloatLE(1,80+i*4);});
  raw.writeInt16LE(4,70);raw.writeInt16LE(16,72);raw.writeFloatLE(352,108);raw.set([110,43,49,0],344);source=gzipSync(raw);
}
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true});
const contexts=[],errors=[],timings={},downloads=new Map();
const until=async(test,label,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,15));}throw new Error('Timed out: '+label);};
async function request(page,path,data){
  const response=await page.request.fetch(origin+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{data,headers:{'X-Deepmark-Request':'1'}}),timeout:120000});
  assert.ok(response.ok(),`${path}: ${await response.text()}`);return response.json();
}
async function account(role,suffix){
  const context=await browser.newContext({viewport:{width:1600,height:1100}});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());downloads.set(page,0);
  page.on('request',request=>{if(request.url().endsWith('/download'))downloads.set(page,downloads.get(page)+1);});
  await page.addInitScript(()=>{
    window.__deltas=[];window.__sent=[];window.__ups=[];window.__workers=[];window.__maxLongTask=0;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker{constructor(...args){super(...args);const record={url:String(args[0]),started:performance.now()};window.__workers.push(record);this.addEventListener('message',()=>record.duration=performance.now()-record.started);}};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__maxLongTask=Math.max(window.__maxLongTask,entry.duration);}).observe({type:'longtask',buffered:true});
    document.addEventListener('pointerup',()=>window.__ups.push(performance.timeOrigin+performance.now()),true);
    const Native=window.WebSocket;
    window.WebSocket=class extends Native{
      constructor(...args){super(...args);this.addEventListener('message',event=>{
        const message=JSON.parse(event.data);if(message.type!=='delta')return;
        const section=document.querySelector('.slice-2'),renders=Number(section?.dataset.renders);
        const record={...message,receivedAt:performance.timeOrigin+performance.now()};window.__deltas.push(record);
        const check=()=>{if(Number(section?.dataset.renders)>renders)record.renderedAt=performance.timeOrigin+performance.now();else requestAnimationFrame(check);};requestAnimationFrame(check);
      });}
      send(data){const message=JSON.parse(data);window.__sent.push({...message,sentAt:performance.timeOrigin+performance.now()});super.send(data);}
    };
  });
  const challenge=await request(page,'/api/auth/challenge');
  const key=createPublicKey({key:Buffer.from(challenge.publicKey,'base64'),format:'der',type:'spki'});
  const encryptedPassword=publicEncrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(JSON.stringify({challengeId:challenge.challengeId,password:'Performance!'+run}))).toString('base64');
  await request(page,'/api/auth/register',{username:`perf_${run}_${suffix}`,name:suffix,role,challengeId:challenge.challengeId,encryptedPassword});
  await page.goto(origin);await page.locator('.console-page').waitFor();return page;
}
async function open(page,readOnly=false){
  await page.locator('.console-heading > button').click();
  const row=page.locator('.console-dataset').filter({hasText:name});await row.waitFor();
  const start=performance.now();await row.getByRole('button',{name:readOnly?'只读监看':'进入协同标注',exact:true}).click();
  await page.locator('.slice-2 canvas').waitFor({timeout:120000});
  await until(()=>page.locator('.collaboration-panel[data-online="true"][data-error="false"]').count(),'editor connected',120000);
  if(!readOnly){await page.getByLabel('排除外围空气',{exact:true}).uncheck();await page.getByLabel('悬停显示灰度区域轮廓',{exact:true}).uncheck();}
  return performance.now()-start;
}
async function paint(page,step){
  const position=await page.locator('.slice-2 canvas').evaluate((canvas,{dims,spacing,step})=>{
    const r=canvas.getBoundingClientRect(),scale=Math.min((r.width-36)/(dims[0]*spacing[0]),(r.height-36)/(dims[1]*spacing[1]));
    return {x:r.left+r.width/2+(step-6)*3*spacing[0]*scale,y:r.top+r.height/2};
  },{dims,spacing,step});
  await page.mouse.move(position.x,position.y);await page.mouse.down();await page.mouse.move(position.x+1,position.y+1);await page.mouse.up();
}
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
try{
  const dispatcher=await account('dispatcher','dispatcher'),a=await account('worker','author_a'),b=await account('worker','author_b');
  const group=(await request(a,'/api/groups',{name:'Performance '+run})).group;
  await request(b,'/api/groups/join',{code:group.code});
  const started=performance.now();
  const upload=await dispatcher.request.post(origin+'/api/datasets/upload',{headers:{'X-Deepmark-Request':'1'},multipart:{file:{name,mimeType:'application/gzip',buffer:source}},timeout:120000});
  assert.equal(upload.status(),201,await upload.text());const dataset=(await upload.json()).dataset;timings.uploadMs=performance.now()-started;
  await request(a,`/api/datasets/${dataset.id}/claim`,{groupId:group.id});
  timings.firstOpenMs=await open(a);timings.secondAuthorOpenMs=await open(b);timings.monitorOpenMs=await open(dispatcher,true);
  const samples=[];
  async function sample(i){
    const before=await a.evaluate(()=>window.__sent.filter(m=>m.type==='operation').length);
    await paint(a,i);
    await until(()=>a.evaluate(before=>window.__sent.filter(m=>m.type==='operation').length>before,before),'new operation sent');
    const sent=await a.evaluate(()=>window.__sent.filter(m=>m.type==='operation').at(-1));assert.ok(sent,'Pointer must send an operation');
    await until(()=>b.evaluate(op=>window.__deltas.some(m=>m.op===op&&m.renderedAt),sent.requestId),'remote rendered');
    await until(()=>dispatcher.evaluate(op=>window.__deltas.some(m=>m.op===op&&m.renderedAt),sent.requestId),'monitor rendered');
    const [up,remote,monitor]=await Promise.all([a.evaluate(()=>window.__ups.at(-1)),b.evaluate(op=>window.__deltas.find(m=>m.op===op),sent.requestId),dispatcher.evaluate(op=>window.__deltas.find(m=>m.op===op),sent.requestId)]);
    const measured={receiveMs:remote.receivedAt-up,renderMs:remote.renderedAt-up,monitorRenderMs:monitor.renderedAt-up};assert.ok(measured.receiveMs>=0,'Latency must correspond to the newly submitted stroke');samples.push(measured);return measured;
  }
  for(let i=0;i<12;i++)await sample(i);
  const active=(await request(a,`/api/datasets/${dataset.id}`)).dataset;
  const projectId=active.projectId;
  // Cross the periodic full-checkpoint boundary with all three clients still rendering live deltas.
  for(let revision=active.revision;revision<127;revision++){
    const patch=Buffer.alloc(8);patch.writeUInt32LE(dims.reduce((a,b)=>a*b)-1);patch.writeUInt16LE(revision===active.revision?0:1,4);patch.writeUInt16LE(1,6);
    await request(a,`/api/collaboration/projects/${projectId}/operations`,{op:`stress-${revision}`,baseRevision:revision,patch:patch.toString('base64')});
  }
  await until(()=>b.evaluate(()=>window.__deltas.at(-1)?.revision===127),'stress deltas applied');
  timings.checkpointBoundary=await sample(12);
  const snapshot=request(dispatcher,`/api/collaboration/projects/${projectId}`);
  timings.duringFullSnapshot=await sample(13);await snapshot;
  // Reopen while keeping this browser's original CT: permissions and newest results still come from the server.
  await b.getByTestId('editor-back').click();await b.locator('.console-page').waitFor();
  const before=downloads.get(b);timings.cachedReopenMs=await open(b);assert.equal(downloads.get(b),before,'Reopening must not download the immutable CT again');
  const [{dataset:current}]=await Promise.all([request(a,`/api/datasets/${dataset.id}`)]);assert.ok(current.revision>=12);
  const report={sourceBytes:source.length,dims,timings,samples,medianRenderMs:percentile(samples.map(s=>s.renderMs),.5),p95RenderMs:percentile(samples.map(s=>s.renderMs),.95),longTasks:await Promise.all([a,b,dispatcher].map(page=>page.evaluate(()=>window.__maxLongTask))),workers:await Promise.all([a,b,dispatcher].map(page=>page.evaluate(()=>window.__workers))),errors};
  assert.deepEqual(errors,[]);await mkdir('artifacts',{recursive:true});await writeFile('artifacts/collaboration-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
