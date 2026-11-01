import {unzipSync} from 'fflate';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile,unlink,readFile,mkdir} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {makeDemo} from '../src/core.ts';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const name=`统一标注测试-${randomUUID()}.nii.gz`,file=new URL('../server-data/datasets/'+name,import.meta.url),demo=makeDemo(),bytes=Buffer.alloc(352+demo.data.length*2);bytes.set(demo.header);demo.data.forEach((n,i)=>bytes.writeInt16LE(n,352+i*2));await writeFile(file,gzipSync(bytes));
const browser=await chromium.launch({channel:'msedge',headless:true}),aContext=await browser.newContext({viewport:{width:1440,height:1050}}),bContext=await browser.newContext({viewport:{width:1440,height:1050}}),a=await aContext.newPage(),b=await bContext.newPage(),errors=[];
for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());}
const origin=process.env.DEEPMARK_TEST_URL||'http://127.0.0.1:5173';
async function until(fn){const end=Date.now()+18000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error('Condition timed out');}
const healthy=page=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function open(page,nickname){await page.goto(origin);await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.locator('.dataset-card').filter({hasText:name}).getByRole('button',{name:'下载并标注',exact:true}).click();await page.getByLabel('协同昵称').fill(nickname);await page.getByRole('button',{name:'加入实时协同',exact:true}).click();await until(()=>healthy(page).count());}
async function stroke(page,dx=0,dy=0){await page.locator('canvas').first().scrollIntoViewIfNeeded();await until(()=>page.locator('canvas').first().evaluate(c=>Math.abs(c.height-window.devicePixelRatio*c.getBoundingClientRect().height)<2));const r=await page.locator('canvas').first().boundingBox(),x=r.x+r.width/2+dx,y=r.y+r.height/2+dy;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+14,y+8,{steps:6});await page.mouse.up();}
function mask(state){const b=gunzipSync(Buffer.from(state.mask,'base64'));return new Uint16Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
try{
  await open(a,'工程师 A');await open(b,'工程师 B');
  if(process.env.DEEPMARK_EXPECT_INSECURE==='1'){assert.equal(await a.evaluate(()=>isSecureContext),false);assert.equal(await a.evaluate(()=>typeof crypto.randomUUID),'undefined');}
  const list=await (await a.request.get(origin+'/api/datasets')).json(),datasetId=list.datasets.find(d=>d.name===name).id;
  const joined=await (await a.request.post(origin+'/api/collaboration/projects',{headers:{'X-Deepmark-Request':'1'},data:{datasetId}})).json(),id=joined.id;
  const state=async(page=a)=>(await page.request.get(origin+`/api/collaboration/projects/${id}`)).json();
  const before=await b.locator('canvas').first().evaluate(c=>c.toDataURL());await stroke(a);await until(async()=>mask(await state()).some(Boolean));await until(async()=>(await b.locator('canvas').first().evaluate(c=>c.toDataURL()))!==before);
  await b.getByRole('button',{name:'新增标签',exact:true}).click();await until(async()=>await b.getByLabel('标签 2名称',{exact:true}).count()===1);await until(()=>healthy(b).count());
  await stroke(b);await until(async()=>(await state()).regions.length>0);await until(()=>a.locator('.parallel-annotation').count());
  let shared=await state();assert.equal('branches' in shared,false);assert.ok(shared.regions.some(r=>r.annotations.some(o=>o.name==='工程师 A')&&r.annotations.some(o=>o.name==='工程师 B')));assert.equal(await a.getByLabel('协同版本').count(),0);
  await until(()=>healthy(a).count());const reviewWait=a.waitForEvent('download');await a.getByRole('button',{name:'导出审阅 ZIP',exact:true}).click();const reviewDownload=await reviewWait;assert.match(reviewDownload.suggestedFilename(),/\.zip$/);const reviewFiles=unzipSync(await readFile(await reviewDownload.path()));assert.ok(reviewFiles['segmentation.nii']);assert.ok(reviewFiles['labels.json']);const review=JSON.parse(new TextDecoder().decode(reviewFiles['parallel-annotations.json']));assert.equal(review.format,'deepmark-parallel-1');assert.ok(review.parallelRegions.length);
  await bContext.setOffline(true);await stroke(b,-50,25);await until(async()=>Number(await b.locator('.collaboration-panel').getAttribute('data-pending'))>0);await bContext.setOffline(false);await until(()=>healthy(b).count());
  await stroke(a,55,-25);await until(()=>healthy(a).count());shared=await state();const latestRevision=shared.revision;
  await b.reload();await open(b,'工程师 B');await until(()=>b.evaluate(async({id,revision})=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('deepmark-workspaces',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return new Promise(resolve=>{const request=db.transaction('drafts').objectStore('drafts').getAll();request.onsuccess=()=>resolve(request.result.some(d=>d.project.id===id&&d.project.revision>=revision));});},{id,revision:latestRevision}));
  assert.equal((await b.request.get(origin+`/api/collaboration/projects/${id}/workspace`)).status(),410);
  assert.equal(await a.getByRole('button',{name:'管理员工作台',exact:true}).count(),0);await b.getByRole('button',{name:'操作记录',exact:true}).click();await b.locator('.collaboration-history').getByText(/工程师 A/).first().waitFor();await b.locator('.collaboration-history').getByText(/工程师 B/).first().waitFor();
  assert.deepEqual(await state(a),await state(b));const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});await a.screenshot({path:fileURLToPath(new URL('engineer-parallel.png',artifacts)),fullPage:true});assert.deepEqual(errors,[]);
  console.log('Shared engineer browser checks passed: parallel region opinions, no branches/private spaces, latest complete join, offline retry, operation history and complete review export.');
}catch(reason){console.log('Browser failure:',await a.locator('body').innerText());throw reason;}finally{await browser.close();await unlink(file);}
