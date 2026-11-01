import {pathToFileURL} from 'node:url';
import {writeFile,unlink,mkdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {unzipSync} from 'fflate';
import assert from 'node:assert/strict';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const origin=process.env.DEEPMARK_TEST_URL||'http://127.0.0.1:5173',count=512*512*64,bytes=Buffer.alloc(352+count*2),header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
header.setInt32(0,348,true);header.setInt16(40,3,true);[512,512,64].forEach((n,a)=>{header.setInt16(42+a*2,n,true);header.setFloat32(80+a*4,a===2?2:1,true);});header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setInt16(254,1,true);header.setFloat32(280,1,true);header.setFloat32(300,1,true);header.setFloat32(320,2,true);bytes.set([110,43,49,0],344);
const plane=Buffer.alloc(512*512*2);for(let y=0;y<512;y++)for(let x=0;x<512;x++)plane.writeInt16LE((x-256)**2+(y-256)**2<180**2?40:-1000,2*(x+y*512));for(let z=0;z<64;z++)plane.copy(bytes,352+z*plane.length);
const name=`实时同步测试-${randomUUID()}.nii.gz`,file=new URL('../server-data/datasets/'+name,import.meta.url);await writeFile(file,gzipSync(bytes));
const browser=await chromium.launch({channel:'msedge',headless:true}),aContext=await browser.newContext({viewport:{width:1600,height:1100}}),bContext=await browser.newContext({viewport:{width:1600,height:1100}}),a=await aContext.newPage(),b=await bContext.newPage(),errors=[];
for(const page of [a,b]){
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.addInitScript(()=>{
    window.__sent=[];window.__received=[];window.__up=0;
    window.addEventListener('pointerup',()=>{window.__up=Date.now();},true);
    const Original=window.WebSocket;
    window.WebSocket=class extends Original{
      constructor(...args){super(...args);this.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.type!=='delta')return;const record={op:value.op,revision:value.revision,receivedAt:Date.now(),renderedAt:0};window.__received.push(record);const section=document.querySelector('.slice-2'),before=Number(section?.dataset.renders);function inspect(){if(!section)return;if(Number(section.dataset.renders)>before)record.renderedAt=Date.now();else requestAnimationFrame(inspect);}requestAnimationFrame(inspect);});}
      send(data){const value=JSON.parse(data);if(value.type==='operation'||value.type==='label')window.__sent.push({op:value.requestId,type:value.type,at:Date.now(),up:window.__up,operation:value.operation});super.send(data);}
    };
  });
}
const healthy=page=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Condition timed out');}
async function open(page,nickname){await page.goto(origin);await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.locator('.dataset-card').filter({hasText:name}).getByRole('button',{name:'下载并标注',exact:true}).click();await page.getByRole('dialog',{name:'服务器数据集',exact:true}).waitFor({state:'hidden'});await page.getByLabel('团队昵称').fill(nickname);await page.getByRole('button',{name:'登录团队',exact:true}).click();await until(()=>healthy(page).count());await page.getByLabel('悬停显示灰度区域轮廓').uncheck();await page.locator('canvas').first().scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('.slice')].every(n=>+n.dataset.renderedSlice>=0));}
async function point(page,dx=0,dy=0){const r=await page.locator('canvas').first().boundingBox();return {x:r.x+r.width/2+dx,y:r.y+r.height/2+dy};}
async function mark(page,dx=0,dy=0){const p=await point(page,dx,dy);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+3,p.y+2);await page.mouse.up();await until(()=>healthy(page).count());return page.evaluate(()=>window.__sent.at(-1));}
const samples=[];let fullFetches=0;
try{
  await open(a,'实时 A');await open(b,'实时 B');
  for(const page of [a,b])page.on('request',r=>{if(r.method()==='GET'&&/\/api\/collaboration\/projects\/[a-f0-9]{32}(?:\?|$)/.test(r.url()))fullFetches++;});
  // An unfinished stroke must stay local, including during the 700 ms local safety checkpoint.
  const start=await point(a),before=await a.evaluate(()=>window.__sent.length),remoteBefore=await b.locator('.slice-2').getAttribute('data-renders');
  await a.mouse.move(start.x,start.y);await a.mouse.down();await a.mouse.move(start.x+20,start.y+5,{steps:8});await a.waitForTimeout(900);
  assert.equal(await a.evaluate(()=>window.__sent.length),before);assert.equal(await b.locator('.slice-2').getAttribute('data-renders'),remoteBefore);
  await a.mouse.up();await until(()=>healthy(a).count());assert.equal(await a.evaluate(()=>window.__sent.length),before+1);
  const first=await a.evaluate(()=>window.__sent.at(-1));assert.equal(first.type,'operation');assert.ok(first.operation.patch);assert.equal('pointer' in first.operation,false);await until(()=>b.evaluate(op=>window.__received.some(e=>e.op===op&&e.renderedAt),first.op));
  // Block IndexedDB writes for two seconds: the server must still receive and distribute the result immediately.
  await a.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('deepmark-workspaces',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});window.__holdUntil=Date.now()+2000;window.__holdDone=false;const tx=db.transaction(['queue','drafts','draftIndex'],'readwrite'),store=tx.objectStore('queue');function hold(){store.get('test-keepalive').onsuccess=()=>{if(Date.now()<window.__holdUntil)hold();};}hold();tx.oncomplete=()=>{window.__holdDone=true;db.close();};});
  const duringLock=await mark(a,-65,-35);await until(()=>b.evaluate(op=>window.__received.some(e=>e.op===op&&e.renderedAt),duringLock.op));assert.equal(await a.evaluate(()=>window.__holdDone),false);await until(()=>a.evaluate(()=>window.__holdDone));
  for(let n=0;n<20;n++){const entry=await mark(a,-95+(n%10)*18,45+Math.floor(n/10)*25);await until(()=>b.evaluate(op=>window.__received.some(e=>e.op===op&&e.renderedAt),entry.op));const rendered=await b.evaluate(op=>window.__received.find(e=>e.op===op).renderedAt,entry.op);samples.push(rendered-entry.up);}
  assert.equal(fullFetches,0,'Live edits must not download full masks');
  // Remote results remain live even while the receiving author is holding an unfinished brush stroke.
  const p=await point(b,85,-50),bSends=await b.evaluate(()=>window.__sent.length);await b.mouse.move(p.x,p.y);await b.mouse.down();const concurrent=await mark(a,-90,-75);await until(()=>b.evaluate(op=>window.__received.some(e=>e.op===op&&e.renderedAt),concurrent.op));assert.equal(await b.evaluate(()=>window.__sent.length),bSends);await b.mouse.up();await until(()=>healthy(b).count());
  await b.getByRole('button',{name:'橡皮擦',exact:true}).click();const erasePoint=await point(b,85,-50),eraseBefore=await b.evaluate(()=>window.__sent.length);await b.mouse.move(erasePoint.x,erasePoint.y);await b.mouse.down();await b.waitForTimeout(150);assert.equal(await b.evaluate(()=>window.__sent.length),eraseBefore);await b.mouse.up();await until(()=>healthy(b).count());
  await b.getByRole('button',{name:'新增标签',exact:true}).click();await b.getByLabel('标签 2名称',{exact:true}).waitFor();await b.getByRole('button',{name:'画笔',exact:true}).click();const overlap=await point(b,55,80);await b.mouse.move(overlap.x,overlap.y);await b.mouse.down();const otherOpinion=await mark(a,55,80);await until(()=>b.evaluate(op=>window.__received.some(e=>e.op===op&&e.renderedAt),otherOpinion.op));await b.mouse.up();await until(()=>healthy(b).count());await a.locator('.parallel-annotation').first().waitFor();
  const list=await (await a.request.get(origin+'/api/datasets')).json(),datasetId=list.datasets.find(d=>d.name===name).id,project=await (await a.request.post(origin+'/api/collaboration/projects',{headers:{'X-Deepmark-Request':'1'},data:{datasetId}})).json(),serverMask=gunzipSync(Buffer.from(project.mask,'base64'));
  for(const page of [a,b]){const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出本地副本',exact:true}).click();const files=unzipSync(await readFile(await (await download).path()));assert.deepEqual(Buffer.from(files['segmentation.nii']).subarray(352),serverMask);}
  assert.deepEqual(errors,[]);const sorted=[...samples].sort((a,b)=>a-b),result={volume:'512x512x64',transport:'WebSocket',samples:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),fullSnapshotRequestsDuringEdits:fullFetches,scope:'Two isolated browsers on one computer; no external network RTT'};
  const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});await writeFile(new URL('realtime-latency.json',artifacts),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  console.log('Verified: no drag/eraser trajectory uploads, one result operation at release, direct deltas, slow-cache independence and concurrent local-stroke protection.');
}catch(error){console.log('Realtime failure:',await a.locator('body').innerText());throw error;}finally{await browser.close();await unlink(file);}
