import {pathToFileURL} from 'node:url';
import {writeFile,unlink,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {unzipSync} from 'fflate';
import assert from 'node:assert/strict';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright'),origin=process.env.DEEPMARK_TEST_URL||'http://127.0.0.1:8080';
const suffix=randomUUID(),names=[`切换测试-1-${suffix}.nii.gz`,`切换测试-2-${suffix}.nii.gz`],files=names.map(name=>new URL('../server-data/datasets/'+name,import.meta.url)),raw=await readFile(new URL('../server-data/datasets/合成练习影像.nii.gz',import.meta.url));for(const file of files)await writeFile(file,raw);
const browser=await chromium.launch({channel:'msedge',headless:true}),contexts=await Promise.all([0,1,2].map(()=>browser.newContext({viewport:{width:1500,height:1100}}))),[a,b,c]=await Promise.all(contexts.map(context=>context.newPage())),errors=[];
const sessionPosts=[0,0],logoutPosts=[0,0];for(const [index,page]of [a,b].entries())page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/collaboration/session'))sessionPosts[index]++;if(request.method()==='POST'&&request.url().endsWith('/api/collaboration/logout'))logoutPosts[index]++;});
for(const page of [a,b,c]){page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());}
const healthy=page=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Condition timed out');}
async function open(page,name){await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.locator('.dataset-card').filter({hasText:name}).getByRole('button',{name:'下载并标注',exact:true}).click();await page.getByRole('dialog',{name:'服务器数据集',exact:true}).waitFor({state:'hidden'});}
async function login(page,name){await page.getByLabel('团队昵称').fill(name);await page.getByRole('button',{name:'登录团队',exact:true}).click();await page.getByRole('button',{name:'退出团队',exact:true}).waitFor();}
async function person(page){return (await (await page.request.get(origin+'/api/collaboration/session')).json()).person;}
async function paint(page,dx=0){await page.locator('canvas').first().scrollIntoViewIfNeeded();await until(()=>page.locator('canvas').first().evaluate(canvas=>Math.abs(canvas.height-devicePixelRatio*canvas.getBoundingClientRect().height)<2));const r=await page.locator('canvas').first().boundingBox();await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+dx+10,r.y+r.height/2+6);await page.mouse.up();}
async function localMask(page){const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出本地副本',exact:true}).click();return Buffer.from(unzipSync(await readFile(await (await wait).path()))['segmentation.nii']).subarray(352);}
try{
  for(const [page,name]of [[a,'切换作者 A'],[b,'切换作者 B']]){await page.goto(origin);await login(page,name);await open(page,names[0]);await until(()=>healthy(page).count());}
  const originalA=await person(a),originalB=await person(b);assert.notEqual(originalA.id,originalB.id);
  await open(a,names[1]);assert.equal(await a.getByRole('button',{name:'登录团队',exact:true}).count(),0,'Switching a dataset must keep the author in collaboration');await until(()=>healthy(a).count());assert.equal((await person(a)).id,originalA.id);
  await paint(a);await until(()=>healthy(a).count());
  const list=await (await a.request.get(origin+'/api/datasets')).json(),datasetId=list.datasets.find(d=>d.name===names[1]).id,state=await (await a.request.post(origin+'/api/collaboration/projects',{headers:{'X-Deepmark-Request':'1'},data:{datasetId}})).json(),expected=gunzipSync(Buffer.from(state.mask,'base64'));assert.ok(expected.some(Boolean));
  await open(b,names[1]);await until(()=>healthy(b).count());assert.equal((await person(b)).id,originalB.id);assert.deepEqual(await localMask(b),expected,'B must open the existing complete result');
  const before=await a.locator('canvas').first().evaluate(canvas=>canvas.toDataURL());await paint(b,-60);await until(()=>healthy(b).count());await until(async()=>(await a.locator('canvas').first().evaluate(canvas=>canvas.toDataURL()))!==before);
  await c.goto(origin);await open(c,names[1]);assert.equal(await c.getByRole('button',{name:'画笔',exact:true}).isDisabled(),true);await paint(c,60);assert.equal(await c.getByRole('button',{name:'↶ 撤销',exact:true}).isDisabled(),true);await login(c,'切换作者 C');await until(()=>healthy(c).count());const latest=await (await c.request.get(origin+`/api/collaboration/projects/${state.id}`)).json();assert.deepEqual(await localMask(c),gunzipSync(Buffer.from(latest.mask,'base64')));
  await b.reload();await open(b,names[1]);await until(()=>healthy(b).count());assert.equal((await person(b)).id,originalB.id);assert.equal(await b.getByRole('button',{name:'登录团队',exact:true}).count(),0);
  await a.locator('input[type=file]').first().setInputFiles({name:'local-practice.nii.gz',mimeType:'application/gzip',buffer:raw});await a.getByRole('status').filter({hasText:'已加载 local-practice.nii.gz'}).waitFor();assert.equal((await person(a)).id,originalA.id);assert.equal(await a.getByRole('button',{name:'画笔',exact:true}).isEnabled(),true);await open(a,names[1]);await until(()=>healthy(a).count());assert.deepEqual(sessionPosts,[1,1]);assert.deepEqual(logoutPosts,[0,0]);
  assert.deepEqual(errors,[]);console.log('Dataset switch verified: stable independent identities, automatic rejoin, B receives A’s existing result, fresh users cannot silently edit outside collaboration, and reload restores the server result.');
}catch(error){console.log('Dataset switch state:',await a.locator('.collaboration-panel').innerText());throw error;}finally{await browser.close();for(const file of files)await unlink(file);}
