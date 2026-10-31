import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile,unlink,readFile,mkdir} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {makeDemo,parseNifti} from '../src/core.ts';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const name=`协同测试-${randomUUID()}.nii.gz`,file=new URL('../server-data/datasets/'+name,import.meta.url),demo=makeDemo(),bytes=Buffer.alloc(352+demo.data.length*2);bytes.set(demo.header);demo.data.forEach((n,i)=>bytes.writeInt16LE(n,352+i*2));await writeFile(file,gzipSync(bytes));
const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),aContext=await browser.newContext({viewport:{width:1440,height:1050}}),bContext=await browser.newContext({viewport:{width:1440,height:1050}}),a=await aContext.newPage(),b=await bContext.newPage(),errors=[];
a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
a.on('dialog',dialog=>dialog.accept());b.on('dialog',dialog=>dialog.accept());
const origin='http://127.0.0.1:5173',headers={'X-Deepmark-Request':'1'};
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error('Condition did not become true');}
const healthy=page=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function open(page,nickname){await page.goto(origin);await page.getByRole('button',{name:'服务器数据集',exact:true}).click();const row=page.locator('.dataset-card').filter({hasText:name});await row.waitFor();await row.getByRole('button',{name:'下载并标注',exact:true}).click();await page.locator('canvas').first().waitFor();await page.getByLabel('协同昵称').fill(nickname);await page.getByRole('button',{name:'加入实时协同',exact:true}).click();await until(()=>healthy(page).count());}
async function stroke(page,dx=0,dy=0){const rect=await page.locator('canvas').first().boundingBox(),x=rect.x+rect.width*.5+dx,y=rect.y+rect.height*.5+dy;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+14,y+9,{steps:5});await page.mouse.up();}
async function post(page,path,data){const response=await page.request.post(origin+'/api/collaboration'+path,{headers,data});assert.ok(response.ok(),await response.text());return response.json();}
function masks(state){return state.branches.map(branch=>{const bytes=gunzipSync(Buffer.from(branch.mask,'base64'));return new Uint16Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));});}
function patch(i,before,after){const b=Buffer.alloc(8);b.writeUInt32LE(i);b.writeUInt16LE(before,4);b.writeUInt16LE(after,6);return b.toString('base64');}
try{
  await open(a,'协同工程师 A');await open(b,'协同工程师 B');
  const list=await (await a.request.get(origin+'/api/datasets')).json(),datasetId=list.datasets.find(d=>d.name===name).id;
  const project=await post(a,'/projects',{datasetId}),id=project.id;
  const state=async()=>{const response=await a.request.get(origin+`/api/collaboration/projects/${id}`);return response.json();};
  const oldHash=await b.locator('canvas').first().evaluate(c=>c.toDataURL());
  await stroke(a);await until(async()=>masks(await state())[0].some(Boolean));
  await until(async()=>(await b.locator('canvas').first().evaluate(c=>c.toDataURL()))!==oldHash);
  const first=masks(await state())[0];
  await bContext.setOffline(true);await stroke(b,-45,28);await until(async()=>(await b.locator('.sync-indicator').innerText()).includes('待上传'));
  await until(()=>b.evaluate(async(projectId)=>{const request=indexedDB.open('deepmark-workspaces',1);const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return new Promise(resolve=>{const read=db.transaction('queue').objectStore('queue').getAll();read.onsuccess=()=>resolve(read.result.some(op=>op.project===projectId));});},id));
  await bContext.setOffline(false);await b.reload();await open(b,'协同工程师 B');await until(()=>healthy(b).count());
  await until(async()=>masks(await state())[0].reduce((n,v)=>n+(v?1:0),0)>first.reduce((n,v)=>n+(v?1:0),0));
  let current=await state();assert.ok(first.every((n,i)=>!n||masks(current)[0][i]===n));
  const label=await post(a,`/projects/${id}/labels`,{});assert.equal(label.label.id,2);
  await post(a,`/projects/${id}/operations`,{op:randomUUID(),branch:'main',baseRevision:0,patch:patch(0,0,1)});
  const centerIndex=48+96*(48+96*32);assert.equal(masks(await state())[0][centerIndex],1);
  const conflictPatch=Buffer.concat([Buffer.from(patch(0,0,2),'base64'),Buffer.from(patch(centerIndex,0,2),'base64')]).toString('base64');
  const conflict=await post(b,`/projects/${id}/operations`,{op:randomUUID(),branch:'main',baseRevision:0,patch:conflictPatch});assert.ok(conflict.forkId);
  await until(async()=>(await a.getByLabel('协同版本').locator('option').count())===2);
  current=await state();assert.equal(masks(current)[0][0],1);assert.equal(masks(current)[1][0],2);
  assert.equal(masks(current)[1][centerIndex],2);await stroke(a);await until(async()=>masks(await state()).every(mask=>mask[centerIndex]===1));
  await stroke(a,45,-25);await until(()=>healthy(a).count());
  current=await state();const finalMasks=masks(current);assert.equal(finalMasks[0][0],1);assert.equal(finalMasks[1][0],2);assert.deepEqual(finalMasks[0].slice(1),finalMasks[1].slice(1));
  await a.getByLabel('协同版本').selectOption(conflict.forkId);await until(async()=>(await a.getByLabel('协同版本').inputValue())===conflict.forkId);
  const waitDownload=a.waitForEvent('download');await a.getByRole('button',{name:'导出标注 ↗',exact:true}).click();const downloaded=await readFile(await (await waitDownload).path());const out=parseNifti(downloaded.buffer.slice(downloaded.byteOffset,downloaded.byteOffset+downloaded.byteLength));assert.equal(out.data[0],2);
  await a.getByRole('button',{name:'工作记录',exact:true}).click();await a.getByRole('button',{name:'查看初始版本',exact:true}).click();await until(()=>a.locator('.history-banner').count());assert.equal(await a.getByRole('button',{name:'画笔',exact:true}).isDisabled(),true);
  await a.getByRole('button',{name:'返回实时编辑',exact:true}).click();await until(async()=>!(await a.getByRole('button',{name:'画笔',exact:true}).isDisabled()));
  await a.screenshot({path:fileURLToPath(new URL('collaboration.png',artifacts)),fullPage:true});
  await b.reload();await open(b,'协同工程师 B');await b.getByRole('button',{name:'工作记录',exact:true}).click();await b.locator('.collaboration-history').getByText(/协同工程师 A/).first().waitFor();
  assert.deepEqual(errors,[]);console.log('Two browser contexts passed: live updates, offline queue retry, conflict branches, fan-out edits, server export, historical read-only view and resume.');
}finally{await browser.close();await unlink(file);}
