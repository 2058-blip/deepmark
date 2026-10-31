import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile,unlink,mkdir} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {makeDemo} from '../src/core.ts';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const name=`缓存测试-${randomUUID()}.nii.gz`,file=new URL('../server-data/datasets/'+name,import.meta.url),demo=makeDemo(),bytes=Buffer.alloc(352+demo.data.length*2);bytes.set(demo.header);demo.data.forEach((n,i)=>bytes.writeInt16LE(n,352+i*2));const compressed=gzipSync(bytes);await writeFile(file,compressed);
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1050}});let page=await context.newPage();
const errors=[],origin='http://127.0.0.1:5173';function observe(p){p.on('pageerror',e=>errors.push(e.message));p.on('dialog',dialog=>dialog.accept());}observe(page);
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error('Condition timed out');}
const healthy=()=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function api(path){const response=await page.request.get(origin+'/api/collaboration'+path);assert.ok(response.ok());return response.json();}
async function local(store){return page.evaluate(store=>new Promise((resolve,reject)=>{const r=indexedDB.open('deepmark-workspaces',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(store),read=tx.objectStore(store).getAll();read.onsuccess=()=>resolve(read.result.map(row=>store==='drafts'?{...row,mask:Array.from(new Uint16Array(row.mask))}:store==='datasets'?{key:row.key,name:row.name,file:{size:row.file.size}}:row));read.onerror=()=>reject(read.error);tx.oncomplete=()=>db.close();};}),store);}
async function stroke(dx=0,dy=0){const r=await page.locator('canvas').first().boundingBox(),x=r.x+r.width/2+dx,y=r.y+r.height/2+dy;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+10,{steps:8});await page.mouse.up();}
function mask(value){const raw=gunzipSync(Buffer.from(value,'base64'));return new Uint16Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));}
try{
  await page.goto(origin);await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.locator('.dataset-card').filter({hasText:name}).getByRole('button',{name:'下载并标注',exact:true}).click();
  await page.getByLabel('协同昵称').fill('缓存作者 A');await page.getByRole('button',{name:'加入实时协同',exact:true}).click();await until(()=>healthy().count());
  const authorA=(await api('/session')).person;
  await page.getByLabel('轴位切片',{exact:true}).evaluate(element=>{element.value='20';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await stroke();await until(()=>healthy().count());
  await until(async()=>{const rows=await local('drafts');return rows.some(d=>d.author.id===authorA.id&&new Uint16Array(d.mask).some(Boolean)&&d.view.point[2]===20);});
  const initial=(await local('drafts')).find(d=>d.author.id===authorA.id),id=initial.project.id;
  assert.equal((await local('datasets')).find(d=>d.key===initial.project.datasetId).file.size,compressed.length);
  assert.equal(await page.getByText('已保存到服务器',{exact:true}).count(),0);
  await page.getByRole('button',{name:'保存并退出',exact:true}).click();await page.getByRole('button',{name:'加入实时协同',exact:true}).waitFor();
  assert.equal((await api('/session')).person,null);assert.equal((await local('drafts')).find(d=>d.author.id===authorA.id).needsCheckpoint,false);
  await page.getByRole('button',{name:'本地工作缓存',exact:true}).click();await page.locator('.dataset-card').filter({hasText:'缓存作者 A'}).getByRole('button',{name:'恢复工作',exact:true}).click();await until(()=>healthy().count());
  assert.equal((await api('/session')).person.id,authorA.id);assert.equal(await page.getByLabel('轴位切片',{exact:true}).inputValue(),'20');
  const savedOwn=await api(`/projects/${id}/workspace`);assert.ok(savedOwn.checkpoint);assert.equal(savedOwn.checkpoint.view.point[2],20);
  await context.route('**/api/**',route=>route.abort());
  await stroke(45,25);await page.getByLabel('标签 1名称',{exact:true}).fill('离线标签');await page.getByLabel('标签 1名称',{exact:true}).press('Tab');
  await until(async()=>{const drafts=await local('drafts'),queue=await local('queue');return queue.length>=2&&drafts.some(d=>d.author.id===authorA.id&&d.segments[0].name==='离线标签');});
  const offline=(await local('drafts')).find(d=>d.author.id===authorA.id),offlineMask=new Uint16Array(offline.mask);
  await page.getByRole('button',{name:'保存并退出',exact:true}).click();await page.getByRole('dialog',{name:'个人成果尚未全部上传',exact:true}).waitFor();await page.getByRole('button',{name:'保留本地缓存并退出',exact:true}).click();await page.getByRole('button',{name:'加入实时协同',exact:true}).waitFor();assert.ok((await local('queue')).length>=2);
  await page.close({runBeforeUnload:false});page=await context.newPage();observe(page);await page.goto(origin);
  let originalDownloads=0;page.on('request',request=>{if(/\/api\/datasets\/.+\/download/.test(request.url()))originalDownloads++;});
  await page.getByRole('button',{name:'本地工作缓存',exact:true}).click();await page.locator('.dataset-card').filter({hasText:'缓存作者 A'}).getByRole('button',{name:'恢复工作',exact:true}).click();await page.locator('canvas').first().waitFor();
  assert.equal(await page.getByLabel('标签 1名称',{exact:true}).inputValue(),'离线标签');assert.equal(await page.getByLabel('轴位切片',{exact:true}).inputValue(),'20');assert.equal(originalDownloads,0);
  assert.deepEqual(new Uint16Array((await local('drafts')).find(d=>d.author.id===authorA.id).mask),offlineMask);
  const rect=await page.locator('canvas').first().boundingBox();await page.mouse.move(rect.x+rect.width/2-45,rect.y+rect.height/2-20);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2-25,rect.y+rect.height/2-12,{steps:5});
  await until(async()=>!!(await local('drafts')).find(d=>d.author.id===authorA.id)?.pending);
  const partial=(await local('drafts')).find(d=>d.author.id===authorA.id),partialCount=new Uint16Array(partial.mask).reduce((n,v)=>n+(v?1:0),0);
  await page.close({runBeforeUnload:false});page=await context.newPage();observe(page);await page.goto(origin);await page.getByRole('button',{name:'本地工作缓存',exact:true}).click();await page.locator('.dataset-card').filter({hasText:'缓存作者 A'}).getByRole('button',{name:'恢复工作',exact:true}).click();await page.locator('canvas').first().waitFor();
  assert.ok(new Uint16Array((await local('drafts')).find(d=>d.author.id===authorA.id).mask).reduce((n,v)=>n+(v?1:0),0)>=partialCount);
  await context.unroute('**/api/**');await until(()=>healthy().count());
  const finalA=await api(`/projects/${id}/workspace`);assert.equal(finalA.authorId,authorA.id);assert.ok(finalA.touchedCount>savedOwn.touchedCount);assert.equal((await api(`/projects/${id}`)).labels[0].name,'离线标签');
  await page.getByRole('button',{name:'保存并退出',exact:true}).click();await page.getByRole('button',{name:'加入实时协同',exact:true}).waitFor();
  await page.getByLabel('协同昵称').fill('缓存作者 B');await page.getByRole('button',{name:'加入实时协同',exact:true}).click();await until(()=>healthy().count());
  const authorB=(await api('/session')).person;assert.notEqual(authorA.id,authorB.id);assert.equal((await api(`/projects/${id}/workspace`)).touchedCount,0);
  await stroke(-40,-25);await until(()=>healthy().count());const ownB=await api(`/projects/${id}/workspace`);assert.ok(ownB.touchedCount>0);assert.notDeepEqual(mask(ownB.mask),mask(finalA.mask));
  await page.getByRole('button',{name:'保存并退出',exact:true}).click();await page.getByRole('button',{name:'加入实时协同',exact:true}).waitFor();
  await page.getByRole('button',{name:'本地工作缓存',exact:true}).click();assert.equal(await page.locator('.dataset-card').count(),2);
  const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});await page.screenshot({path:fileURLToPath(new URL('local-workspaces.png',artifacts)),fullPage:true});
  assert.deepEqual(errors,[]);console.log('Workspace browser checks passed: complete local image/mask/view cache, quiet UI, personal checkpoint before logout, stable author resume, failed-exit retention, tab-close recovery without image download, offline label queue and separate author spaces.');
}catch(reason){console.log('Workspace failure:',{page:await page.locator('body').innerText(),drafts:(await local('drafts')).map(d=>({author:d.author.name,point:d.view.point,painted:new Uint16Array(d.mask).reduce((n,v)=>n+(v?1:0),0)}))});const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});await page.screenshot({path:fileURLToPath(new URL('workspace-failure.png',artifacts)),fullPage:true});throw reason;}finally{await browser.close();await unlink(file);}
