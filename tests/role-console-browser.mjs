import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

// Run against the built Java application, optionally supplying a Playwright module path.
// DEEPMARK_BROWSER_URL=http://localhost:8787 node tests/role-console-browser.mjs <playwright/index.mjs>
const origin=(process.env.DEEPMARK_BROWSER_URL||'http://localhost:8787').replace(/\/$/,'');
const playwrightPath=process.argv[2]||process.env.DEEPMARK_PLAYWRIGHT_PATH;
const {chromium}=await import(playwrightPath?pathToFileURL(playwrightPath).href:'playwright');
const run=randomUUID().replaceAll('-','').slice(0,12);
const password=`RcE2E!${randomUUID()}`;
const datasetName=`role-console-${run}.nii.gz`,groupName=`browser-team-${run}`;
const dimensions=[32,32,8],voxelCount=dimensions.reduce((a,b)=>a*b,1);

function syntheticNifti(){
  const bytes=Buffer.alloc(352+voxelCount*2),header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  header.setInt32(0,348,true);header.setInt16(40,3,true);
  dimensions.forEach((size,axis)=>{header.setInt16(42+axis*2,size,true);header.setFloat32(80+axis*4,axis===2?2:1,true);});
  header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);
  header.setUint8(123,2);header.setInt16(254,1,true);header.setFloat32(280,1,true);header.setFloat32(300,1,true);header.setFloat32(320,2,true);
  bytes.set([110,43,49,0],344);
  for(let z=0;z<8;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    bytes.writeInt16LE(x>=4&&x<28&&y>=4&&y<28?40:-1000,352+2*(x+32*(y+32*z)));
  }
  return gzipSync(bytes);
}

const source=syntheticNifti();
const browser=await chromium.launch({channel:process.env.DEEPMARK_BROWSER_CHANNEL||'msedge',headless:true});
const contexts=[],pages=[],pageErrors=[],authRequests=[],socketMessages=new Map();
let datasetId,projectId,latestRevision=0;

async function until(check,description,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timed out: ${description}`);
}
async function newPage(){
  const context=await browser.newContext({viewport:{width:1600,height:1150},acceptDownloads:true});
  contexts.push(context);const page=await context.newPage();pages.push(page);socketMessages.set(page,{sent:[],received:[]});
  page.setDefaultTimeout(30000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  page.on('request',request=>{
    if(request.method()==='POST'&&/\/api\/auth\/(?:register|login)$/.test(request.url())){
      const body=request.postDataJSON();
      authRequests.push({body,bodyContainsPassword:request.postData()?.includes(password)});
    }
  });
  page.on('websocket',socket=>{
    const record=socketMessages.get(page);
    const capture=(list,frame)=>{try{list.push(JSON.parse(String(frame.payload)));}catch{}};
    socket.on('framesent',frame=>capture(record.sent,frame));socket.on('framereceived',frame=>capture(record.received,frame));
  });
  return page;
}
async function navigate(page){
  while(true){
    try{const response=await page.goto(origin,{waitUntil:'domcontentloaded'});if(response&&response.status()>=500)continue;return;}
    catch(error){if(!/net::|ECONN|EPIPE|TLS|ERR_|Timeout.*navigat/i.test(error.message))throw error;}
  }
}
async function request(page,path,{method='GET',data,expected=200}={}){
  while(true){
    let response;
    try{response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data}),headers:method==='GET'?{}:{'X-Deepmark-Request':'1'}});}
    catch(error){if(!/ECONN|EPIPE|TLS|ERR_|socket|connect|Timeout/i.test(error.message))throw error;continue;}
    if(method==='GET'&&(response.status()===429||response.status()>=500)&&response.status()!==expected)continue;
    assert.equal(response.status(),expected,`${method} ${path}: ${await response.text()}`);
    return response;
  }
}
async function json(page,path,options){return (await request(page,path,options)).json();}
function row(page){return page.locator('.console-dataset').filter({hasText:datasetName});}
async function refresh(page){
  const button=page.locator('.console-heading > button');await button.waitFor();
  await until(async()=>await button.isEnabled(),'console refresh ready');
  const loaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/datasets'&&response.request().method()==='GET');
  await button.click();assert.equal((await loaded).status(),200);await until(async()=>await button.isEnabled(),'console refresh completed');
}
async function register(page,role,suffix){
  await navigate(page);await page.getByRole('button',{name:'注册账号',exact:true}).click();
  await page.getByLabel('用户名',{exact:true}).fill(`rc_${run}_${suffix}`);
  await page.getByLabel('显示名称',{exact:true}).fill(`${suffix}-${run}`);
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);
  await page.locator(`input[type=radio][value="${role}"]`).check();
  const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/register');
  await page.getByRole('button',{name:'注册并进入工作台',exact:true}).click();
  const response=await responsePromise;assert.equal(response.status(),201,await response.text());
  const {user}=await response.json();assert.equal(user.role,role);
  await page.locator('.console-page').waitFor();
  assert.match(await page.locator('.console-brand').innerText(),role==='dispatcher'?/派活工作台/:/干活工作台/);
  assert.equal((await json(page,'/api/auth/me')).user.id,user.id);
  const cookie=(await page.context().cookies()).find(item=>item.name==='deepmark_session');
  assert.ok(cookie?.httpOnly,'Session cookie must be HttpOnly');assert.equal(cookie.sameSite,'Lax');
  if(origin.startsWith('https:'))assert.equal(cookie.secure,true);
  assert.equal(await page.evaluate(()=>document.cookie.includes('deepmark_session=')),false);
  await page.reload();await page.locator('.console-page').waitFor();
  return user;
}
const healthy=page=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function openEditor(page,readOnly=false){
  await refresh(page);await row(page).getByRole('button',{name:readOnly?'只读监看':'进入协同标注',exact:true}).click();
  await page.locator('.slice-2 canvas').waitFor();await until(()=>healthy(page).count(),'live project connected');
  await until(()=>page.locator('.slice-2 canvas').evaluate(canvas=>{
    const rectangle=canvas.getBoundingClientRect();return +canvas.closest('.slice').dataset.renderedSlice>=0&&Math.abs(canvas.width-devicePixelRatio*rectangle.width)<2;
  }),'canvas rendered');
  const preview=page.getByLabel('悬停显示灰度区域轮廓',{exact:true});if(await preview.count())await preview.uncheck();
}
async function stroke(page,u=16,v=16){
  const canvas=page.locator('.slice-2 canvas');await canvas.scrollIntoViewIfNeeded();
  const point=await canvas.evaluate((element,{u,v})=>{
    const rectangle=element.getBoundingClientRect(),zoom=+element.closest('.slice').dataset.zoom;
    const scale=Math.min((rectangle.width-36)/32,(rectangle.height-36)/32)*zoom,w=32*scale;
    return {x:rectangle.left+(rectangle.width-w)/2+(u+.5)/32*w,y:rectangle.top+(rectangle.height-w)/2+(32-v-.5)/32*w};
  },{u,v});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+3,point.y+2,{steps:3});await page.mouse.up();
}
async function state(page){return json(page,`/api/collaboration/projects/${projectId}`);}
function maskOf(project){return gunzipSync(Buffer.from(project.mask,'base64'));}
async function deniedMutations(page,status){
  const patch=Buffer.alloc(8);patch.writeUInt32LE(0);patch.writeUInt16LE(1,6);
  await request(page,`/api/collaboration/projects/${projectId}/operations`,{method:'POST',expected:status,data:{op:`forbidden-${randomUUID()}`,baseRevision:latestRevision,patch:patch.toString('base64')}});
  await request(page,`/api/collaboration/projects/${projectId}/labels`,{method:'POST',expected:status,data:{op:`forbidden-label-${randomUUID()}`,id:1,name:'forbidden',color:'#112233'}});
}
async function assertReadOnly(page){
  for(const name of ['画笔','橡皮擦','阈值','灰度分区','新增标签']){
    const control=page.getByRole('button',{name,exact:true});
    assert.equal(await control.count(),1,`${name} must remain present in the shared editor`);
    assert.equal(await control.isEnabled(),false,`${name} must be disabled in read-only view`);
  }
  const names=page.locator('.segment-list input:not([type=color])');
  for(let i=0;i<await names.count();i++)assert.equal(await names.nth(i).isEnabled(),false,'Shared labels must be read-only');
  const before=await state(page),sent=socketMessages.get(page).sent.filter(message=>['operation','label'].includes(message.type)).length;
  assert.equal(await page.getByTestId('annotation-editor').getAttribute('data-readonly'),'true');
  if((await page.getByTestId('editor-mode').innerText()).includes('派活')&&before.datasetStatus!=='completed'){
    assert.equal(await page.locator('.top-actions > button.primary').isEnabled(),false,'Dispatcher export must wait for task completion');
  }
  await page.keyboard.press('b');await stroke(page,21,16);await page.keyboard.press('Control+z');
  const after=await state(page);assert.equal(after.revision,before.revision);assert.deepEqual(maskOf(after),maskOf(before));
  assert.equal(socketMessages.get(page).sent.filter(message=>['operation','label'].includes(message.type)).length,sent);
  // Read-only retains navigation and window controls.
  const windowInput=page.getByLabel('窗位',{exact:true});assert.equal(await windowInput.isEnabled(),true);
  await windowInput.fill('60');assert.equal(await windowInput.inputValue(),'60');
  const slider=page.locator('.slice-2 footer input[type=range]');assert.equal(await slider.isEnabled(),true);
}
async function readDownload(download){
  const stream=await download.createReadStream();assert.ok(stream);const chunks=[];let total=0;
  for await(const chunk of stream){total+=chunk.length;assert.ok(total<5*1024*1024,'Synthetic export unexpectedly exceeds 5 MiB');chunks.push(chunk);}
  const result=Buffer.concat(chunks);await download.delete();return result;
}

try{
  const dispatcher=await newPage(),leader=await newPage(),member=await newPage(),anonymous=await newPage();
  assert.equal((await json(anonymous,'/api/health')).backend,'java');
  await navigate(anonymous);await anonymous.locator('.auth-page').waitFor();assert.equal(await anonymous.locator('canvas').count(),0);
  await request(anonymous,'/api/datasets',{expected:401});await request(anonymous,'/api/groups',{expected:401});
  const publisher=await register(dispatcher,'dispatcher','publisher');
  assert.equal(await dispatcher.locator('.console-upload').count(),1);assert.equal(await dispatcher.getByLabel('小组名称',{exact:true}).count(),0);
  await request(dispatcher,'/api/groups',{method:'POST',data:{name:'forbidden'},expected:403});
  await dispatcher.getByLabel('影像文件',{exact:true}).setInputFiles({name:datasetName,mimeType:'application/gzip',buffer:source});
  const uploaded=dispatcher.waitForResponse(response=>new URL(response.url()).pathname==='/api/datasets/upload');
  await dispatcher.getByRole('button',{name:'上传并发布',exact:true}).click();
  const uploadResponse=await uploaded;assert.equal(uploadResponse.status(),201,await uploadResponse.text());
  const {dataset}=await uploadResponse.json();datasetId=dataset.id;assert.equal(dataset.ownerId,publisher.id);assert.equal(dataset.status,'unassigned');
  await row(dispatcher).waitFor();assert.match(await row(dispatcher).innerText(),/未标注/);
  const captain=await register(leader,'worker','leader');
  assert.equal(await leader.locator('.console-upload').count(),0);
  await request(leader,'/api/datasets/upload',{method:'POST',data:{},expected:403});
  await leader.getByLabel('小组名称',{exact:true}).fill(groupName);
  const created=leader.waitForResponse(response=>new URL(response.url()).pathname==='/api/groups'&&response.request().method()==='POST');
  await leader.getByRole('button',{name:'创建并成为组长',exact:true}).click();
  const {group}=await (await created).json();assert.equal(group.leaderId,captain.id);assert.equal(group.isLeader,true);
  await leader.locator('.console-group').filter({hasText:groupName}).waitFor();
  const worker=await register(member,'worker','member');
  await request(member,`/api/datasets/${datasetId}/download`,{expected:403});
  await request(member,`/api/datasets/${datasetId}/claim`,{method:'POST',data:{groupId:group.id},expected:403});
  await member.getByLabel('小组邀请码',{exact:true}).fill(group.code);
  const joined=member.waitForResponse(response=>new URL(response.url()).pathname==='/api/groups/join');
  await member.getByRole('button',{name:'加入小组',exact:true}).click();
  const joinedGroup=(await (await joined).json()).group;assert.equal(joinedGroup.isLeader,false);assert.ok(joinedGroup.members.some(item=>item.id===worker.id));
  await refresh(member);assert.equal(await row(member).getByRole('button',{name:'组长认领',exact:true}).isEnabled(),false);
  await refresh(leader);
  const claimResponse=leader.waitForResponse(response=>new URL(response.url()).pathname===`/api/datasets/${datasetId}/claim`&&response.request().method()==='POST');
  await row(leader).getByRole('button',{name:'组长认领',exact:true}).click();assert.equal((await claimResponse).status(),200);
  await until(async()=>(await json(leader,`/api/datasets/${datasetId}/status`)).dataset.status==='in_progress','leader claim persisted');
  await request(dispatcher,`/api/datasets/${datasetId}/claim`,{method:'POST',data:{groupId:group.id},expected:403});
  await request(member,`/api/datasets/${datasetId}/complete`,{method:'POST',data:{revision:0},expected:403});
  await openEditor(member);
  await until(async()=>{projectId=(await json(dispatcher,`/api/datasets/${datasetId}/status`)).dataset.projectId;return !!projectId;},'shared project created');
  assert.equal((await state(member)).canWrite,true);assert.equal(maskOf(await state(member)).some(value=>value!==0),false);
  await request(anonymous,`/api/collaboration/projects/${projectId}`,{expected:401});
  await openEditor(dispatcher,true);assert.equal((await state(dispatcher)).canWrite,false);
  await assertReadOnly(dispatcher);await deniedMutations(dispatcher,403);
  const beforeCanvas=await dispatcher.locator('.slice-2 canvas').evaluate(canvas=>canvas.toDataURL());
  const receivedBefore=socketMessages.get(dispatcher).received.length;
  await member.getByRole('button',{name:'画笔',exact:true}).click();await stroke(member);
  await until(async()=>{const project=await state(member);latestRevision=project.revision;return latestRevision>0&&maskOf(project).some(value=>value!==0);},'real pointer stroke persisted');
  await until(()=>healthy(member).count(),'worker edit fully synced');
  await until(async()=>socketMessages.get(dispatcher).received.slice(receivedBefore).some(message=>message.type==='delta')&&(await dispatcher.locator('.slice-2 canvas').evaluate(canvas=>canvas.toDataURL()))!==beforeCanvas,'dispatcher live read-only canvas updated');
  assert.deepEqual(maskOf(await state(dispatcher)),maskOf(await state(member)));
  await assertReadOnly(dispatcher);
  await refresh(leader);
  const completedResponse=leader.waitForResponse(response=>new URL(response.url()).pathname===`/api/datasets/${datasetId}/complete`&&response.request().method()==='POST');
  await row(leader).getByRole('button',{name:'提交完成',exact:true}).click();assert.equal((await completedResponse).status(),200);
  await until(async()=>(await json(leader,`/api/datasets/${datasetId}/status`)).dataset.status==='completed','leader completion persisted');
  await until(async()=>await member.getByRole('button',{name:'画笔',exact:true}).isDisabled(),'already open worker editor locked after completion');
  await assertReadOnly(member);await deniedMutations(member,423);
  const completed=await state(dispatcher);assert.equal(completed.canWrite,false);assert.ok(maskOf(completed).some(value=>value!==0));
  await navigate(dispatcher);await dispatcher.locator('.console-page').waitFor();await refresh(dispatcher);
  assert.match(await row(dispatcher).innerText(),/已完成/);
  const downloadPromise=dispatcher.waitForEvent('download');await row(dispatcher).getByRole('button',{name:'下载成果',exact:true}).click();
  const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.zip$/i);
  const files=unzipSync(await readDownload(download));assert.ok(files['segmentation.nii']);assert.ok(files['labels.json']);
  const segmentation=Buffer.from(files['segmentation.nii']);assert.deepEqual(segmentation.subarray(352),maskOf(completed));
  assert.equal(segmentation.readInt32LE(0),348);assert.equal(segmentation.readInt16LE(70),512);
  const previousCookie=(await dispatcher.context().cookies()).find(cookie=>cookie.name==='deepmark_session');
  await dispatcher.getByRole('button',{name:'退出登录',exact:true}).click();await dispatcher.locator('.auth-page').waitFor();
  assert.equal((await json(dispatcher,'/api/auth/me')).user,null);await request(dispatcher,`/api/datasets/${datasetId}/status`,{expected:401});
  const oldSessionResponse=await anonymous.request.get(origin+'/api/auth/me',{headers:{Cookie:`deepmark_session=${previousCookie.value}`}});assert.equal((await oldSessionResponse.json()).user,null);
  await dispatcher.getByLabel('用户名',{exact:true}).fill(publisher.username);await dispatcher.getByLabel('密码',{exact:true}).fill(password);
  await dispatcher.locator('.auth-card form').getByRole('button',{name:'登录',exact:true}).click();await dispatcher.locator('.console-page').waitFor();
  assert.equal((await json(dispatcher,'/api/auth/me')).user.id,publisher.id);
  for(const entry of authRequests){assert.equal(Object.hasOwn(entry.body,'password'),false);assert.equal(entry.bodyContainsPassword,false);assert.equal(Buffer.from(entry.body.encryptedPassword,'base64').length,512);assert.ok(entry.body.challengeId);}
  assert.equal(new Set(authRequests.map(entry=>entry.body.challengeId)).size,authRequests.length,'Each login must use a fresh one-time challenge');
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({result:'passed',backend:'java',datasetId,projectId,revision:latestRevision,sourceBytes:source.length,workflow:'dispatcher upload → leader group → member join → leader claim → real member pointer drawing → dispatcher read-only live monitor → leader complete → immutable ZIP export',checks:['role routing','encrypted password transport','HttpOnly session','session reload/login/logout/revocation','unauthenticated ACL','leader-only claim/completion','dispatcher UI/API read-only','live canvas update','open editor completion lock','ZIP mask equals server state']},null,2));
}catch(error){
  for(let i=0;i<pages.length;i++)console.error(`Browser ${i}:`,(await pages[i].locator('body').innerText().catch(()=>'' )).slice(0,7000));
  throw error;
}finally{await Promise.all(contexts.map(context=>context.close()));await browser.close();}
