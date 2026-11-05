import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {gzipSync} from 'fflate';import {makeDemo} from '../mimics-workbench/src/core.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const volume=makeDemo(),raw=new Uint8Array(352+volume.data.length*2);raw.set(volume.header);const h=new DataView(raw.buffer);h.setInt16(70,4,true);h.setInt16(72,16,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setFloat32(116,0,true);
const voxels=new Int16Array(raw.buffer,352);for(let i=0;i<voxels.length;i++)voxels[i]=volume.data[i];
const fixture=process.env.WORKBENCH_TEST_NIFTI||'artifacts/workbench-browser-fixture.nii.gz';if(!process.env.WORKBENCH_TEST_NIFTI)fs.writeFileSync(fixture,gzipSync(raw,{level:1}));
const browser=await chromium.launch({channel:'msedge',headless:true}),contexts=[],errors=[],run=Date.now().toString(36),name='WB-CT-'+run;
const base=process.env.WORKBENCH_TEST_URL||'http://127.0.0.1:8787',performanceReports=[];
async function actor(role,suffix){
 const context=await browser.newContext({viewport:{width:1600,height:1050}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(suffix+': '+e.message));
 await page.goto(base);await page.getByTestId('auth-mode-register').click();await page.locator('[name=username]').fill('wb_'+suffix+'_'+run);await page.locator('[name=name]').fill('测试'+suffix);
 await page.getByLabel('密码',{exact:true}).fill('Workbench123456!');await page.getByLabel('确认密码',{exact:true}).fill('Workbench123456!');
 await page.locator('input[type=radio][value='+role+']').check();await page.getByTestId('auth-submit').click();await page.getByTestId('auth-form').waitFor({state:'hidden'});
 return{context,page};
}
async function json(page,url,method='GET',body){
 return page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,headers:{'X-Deepmark-Request':'1',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw new Error(JSON.stringify(value));return value;},{url,method,body});
}
async function choose(page){await page.getByRole('searchbox',{name:'搜索数据集'}).fill(name);await page.getByText(name,{exact:true}).first().click();}
async function enter(page){await choose(page);await page.getByRole('button',{name:'进入协同标注',exact:true}).click();await page.locator('.native-sync-bar[data-connected=true]').waitFor();await page.locator('.busy-overlay').waitFor({state:'hidden'});}
async function settle(page){await page.waitForFunction(()=>!document.querySelector('.native-sync-state')?.textContent?.includes('待同步')&&!document.querySelector('.native-sync-state')?.textContent?.includes('准备'));await page.waitForFunction(()=>document.querySelector('.mw-object-properties')?.getAttribute('data-mask-statistics-pending')!=='true');}
async function stroke(page,index=4,x=.45,y=.5){
 await page.locator('.mw-tool-grid button').nth(index).click();const box=await page.locator('canvas').first().boundingBox();
 await page.mouse.move(box.x+box.width*x,box.y+box.height*y);await page.mouse.down();await page.mouse.move(box.x+box.width*(x+.1),box.y+box.height*y,{steps:8});await page.mouse.up();
}
async function measuredStroke(page,index=4){
 await page.locator('.mw-tool-grid button').nth(index).click();
 if(index===6){await page.getByLabel('自定义 1 Threshold 1',{exact:true}).fill('-10000');await page.getByLabel('自定义 1 Threshold 2',{exact:true}).fill('10000');await page.getByLabel('选择自定义阈值 1',{exact:true}).check();}
 const box=await page.locator('canvas').first().boundingBox(),x=box.x+box.width*.35,y=box.y+box.height*.4;
 await page.mouse.move(x,y);const down=performance.now();await page.mouse.down();const downMs=performance.now()-down;
 const frame=await page.evaluate(async({x,y,w,h})=>{const canvas=document.querySelector('canvas'),frames=[],handlers=[];let previous=performance.now();
   for(let i=0;i<60;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const now=performance.now();frames.push(now-previous);previous=now;const t=performance.now();canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,button:-1,buttons:1,clientX:x+i/60*w*.35,clientY:y+Math.sin(i*.22)*h*.1,bubbles:true}));handlers.push(performance.now()-t);}
   frames.sort((a,b)=>a-b);handlers.sort((a,b)=>a-b);return{frameMedian:frames[30],frameP95:frames[57],handlerP95:handlers[57],max:frames.at(-1)};
 },{x,y,w:box.width,h:box.height});const up=performance.now();await page.mouse.up();const upMs=performance.now()-up;
 performanceReports.push({index,downMs,upMs,...frame});console.log(JSON.stringify(performanceReports.at(-1)));
}
try{
 const owner=await actor('dispatcher','owner');console.log('Owner registered through real login UI');
 await owner.page.locator('input[type=file]').setInputFiles(path.resolve(fixture));await owner.page.getByLabel('显示名称',{exact:true}).fill(name);
 const uploadResponse=owner.page.waitForResponse(r=>r.url().endsWith('/api/datasets/upload')&&r.request().method()==='POST');
 await owner.page.getByRole('button',{name:'上传并发布',exact:true}).click();const uploaded=await(await uploadResponse).json();if(!uploaded.dataset)throw new Error(JSON.stringify(uploaded));
 const a=await actor('worker','A'),b=await actor('worker','B');
 const groupName='WB-Team-'+run;await a.page.getByLabel('小组名称',{exact:true}).fill(groupName);
 const groupResponse=a.page.waitForResponse(r=>r.url().endsWith('/api/groups')&&r.request().method()==='POST');await a.page.getByRole('button',{name:'创建并成为组长',exact:true}).click();const group=(await(await groupResponse).json()).group;
 await b.page.getByLabel('小组邀请码',{exact:true}).fill(group.code);await b.page.getByRole('button',{name:'加入小组',exact:true}).click();await b.page.getByText('已加入“'+group.name+'”。',{exact:true}).waitFor();
 await choose(a.page);await a.page.getByRole('button',{name:'组长认领',exact:true}).click();await a.page.getByRole('button',{name:'进入协同标注',exact:true}).waitFor();
 await a.page.getByRole('button',{name:'进入协同标注',exact:true}).click();await a.page.locator('.native-sync-bar[data-connected=true]').waitFor();await a.page.locator('.busy-overlay').waitFor({state:'hidden'});
 await b.page.getByRole('button',{name:'刷新工作台',exact:true}).click();await enter(b.page);
 console.log('Two isolated account sessions opened the same native workbench');
 if(process.env.WORKBENCH_PERF)for(const page of [a.page,b.page]){await page.waitForFunction(()=>document.querySelector('.mw-status')?.textContent?.includes('本地副本已保存'));await settle(page);}
 if(process.env.WORKBENCH_PERF_MPR){await a.page.getByRole('button',{name:'显示 MPR 三正交视图',exact:true}).click();await a.page.waitForTimeout(1500);}
 if(process.env.WORKBENCH_PERF)await measuredStroke(a.page);else await stroke(a.page);await a.page.waitForFunction(()=>Number(document.querySelector('.mw-object-properties dd')?.textContent?.replaceAll(',',''))>0);await settle(a.page);
 await b.page.waitForFunction(()=>Number(document.querySelector('.mw-object-properties dd')?.textContent?.replaceAll(',',''))>0);await settle(b.page);
 const countA=await a.page.locator('.mw-object-properties dd').first().innerText(),countB=await b.page.locator('.mw-object-properties dd').first().innerText();
 console.log('A result synchronized to B: '+countA+' / '+countB);if(countA!==countB)throw new Error('Different shared result counts');
 if(process.env.WORKBENCH_PERF){
   for(const index of [5,6]){await measuredStroke(a.page,index);await settle(a.page);const count=await a.page.locator('.mw-object-properties dd').first().innerText();await b.page.waitForFunction(value=>document.querySelector('.mw-object-properties dd')?.textContent===value,count);performanceReports.at(-1).count=count;}
   if(Number(performanceReports.at(-1).count?.replaceAll(',',''))<=0)throw new Error('Local threshold performance path did not produce an outcome');
   fs.writeFileSync('artifacts/workbench-integrated-performance'+(process.env.WORKBENCH_PERF_MPR?'-mpr':'')+'.json',JSON.stringify({performanceReports,errors},null,2));if(errors.length)throw new Error(errors.join('\n'));
 }else{
 await stroke(b.page,5);await settle(b.page);if(await b.page.locator('.mw-object-properties dd').first().innerText()!==countA)throw new Error('B deleted A annotation');
 console.log('Foreign-author erasure protected');
 await b.page.getByRole('button',{name:'＋ 新建',exact:true}).click();await settle(b.page);await stroke(b.page);await settle(b.page);
 await a.page.waitForFunction(()=>document.querySelectorAll('.mw-mask-row').length===2);
 await a.page.locator('.mw-mask-row').nth(1).locator('small').click();await settle(a.page);
 // An unavailable upload path must not lose completed outcomes across reload.
 const operationRoute='**/api/collaboration/workbenches/**/operations**';
 await b.page.route(operationRoute,route=>route.abort());await stroke(b.page,4,.65,.65);
 await b.page.waitForFunction(()=>document.querySelector('.native-sync-state')?.textContent?.includes('待同步')||document.querySelector('.native-sync-state')?.textContent?.includes('异常'));
 await b.page.waitForFunction(()=>document.querySelector('.mw-status')?.textContent?.includes('本地副本已保存'));
 const offlineCount=await b.page.locator('.mw-object-properties dd').first().innerText();
 await b.page.reload();await enter(b.page);await b.page.locator('.mw-mask-row').nth(1).locator('small').click();await settle(b.page).catch(()=>{});
 if(await b.page.locator('.mw-object-properties dd').first().innerText()!==offlineCount)throw new Error('Pending outcome was lost across reload');
 await b.page.unroute(operationRoute);await settle(b.page);
 await a.page.waitForFunction(count=>document.querySelector('.mw-object-properties dd')?.textContent===count,offlineCount);
 console.log('Pending outcomes survived reload and synchronized after transport recovery');
 // Lose the HTTP acknowledgement after the server commits. Retrying is idempotent.
 let discarded=false;await a.page.route('**/api/collaboration/workbenches/**/operations',async route=>{if(discarded)return route.continue();discarded=true;await route.fetch();await route.abort();});
 await stroke(a.page,4,.3,.65);await settle(a.page);await a.page.unroute('**/api/collaboration/workbenches/**/operations');
 const ackCount=await a.page.locator('.mw-object-properties dd').first().innerText();await b.page.waitForFunction(count=>document.querySelector('.mw-object-properties dd')?.textContent===count,ackCount);
 // Historical views must be isolated from live updates and cannot edit the team.
 await a.page.getByRole('button',{name:'操作记录',exact:true}).click();await a.page.getByRole('button',{name:'查看修订 1',exact:true}).click();
 await a.page.getByText('历史只读',{exact:true}).waitFor();await a.page.locator('.busy-overlay').waitFor({state:'hidden'});
 if(await a.page.locator('.mw-mask-row').count()!==1)throw new Error('Historical view is not revision one');
 if(!await a.page.getByRole('button',{name:'＋ 新建',exact:true}).isDisabled())throw new Error('Historical view permits edits');
 await a.page.getByRole('button',{name:'返回实时成果',exact:true}).click();await a.page.locator('.native-sync-bar[data-connected=true]').waitFor();await a.page.locator('.busy-overlay').waitFor({state:'hidden'});
 if(await a.page.locator('.mw-mask-row').count()!==2)throw new Error('Returning from history did not restore current outcome');
 console.log('History read-only navigation and return to current outcome passed');
 await a.page.getByRole('button',{name:'测量与注释',exact:true}).click();await a.page.locator('.mw-tool-grid button').filter({hasText:'文字标注'}).click();
 const annotationBox=await a.page.locator('canvas').first().boundingBox();await a.page.mouse.click(annotationBox.x+annotationBox.width*.5,annotationBox.y+annotationBox.height*.5);
 await a.page.getByRole('dialog').getByLabel('Text · 注释',{exact:true}).fill('账号协同注释测试');await a.page.getByRole('dialog').getByRole('button',{name:'Apply · 应用',exact:true}).click();await settle(a.page);
 await b.page.locator('.mw-object-tabs button').filter({hasText:'测量'}).click();await b.page.getByText('账号协同注释测试',{exact:true}).first().waitFor();
 await a.page.getByRole('button',{name:'三维重建',exact:true}).click();await a.page.getByRole('button',{name:'Calculate 3D…',exact:true}).click();
 await a.page.getByRole('dialog').getByRole('button',{name:'Calculate',exact:true}).click();await a.page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).waitFor({state:'visible'});
 await a.page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await settle(a.page);
 await b.page.locator('.mw-object-tabs button').filter({hasText:'3D'}).click();await b.page.locator('.mw-part-row').first().waitFor();
 console.log('Native annotation metadata and generated 3D mesh resources synchronized');
 const projects=(await json(a.page,'/api/datasets')).datasets,project=projects.find(x=>x.id===uploaded.dataset.id);
 await a.page.screenshot({path:'artifacts/workbench-collaboration-A.png',fullPage:true});await b.page.screenshot({path:'artifacts/workbench-collaboration-B.png',fullPage:true});
 const report={dataset:uploaded.dataset.id,project:project.projectId,revision:project.revision,countA,countB,foreignEraseProtected:true,independentMasks:2,reloadRecovery:true,lostAcknowledgement:discarded,historyNavigation:true,annotations:true,models:true,errors};
 await json(a.page,'/api/datasets/'+uploaded.dataset.id+'/complete','POST',{revision:project.revision});
 await b.page.waitForFunction(()=>document.querySelector('.mimics-workbench')?.getAttribute('data-readonly')==='true');
 await owner.page.getByRole('button',{name:'刷新工作台',exact:true}).click();await choose(owner.page);
 const download=owner.page.waitForEvent('download');await owner.page.getByRole('button',{name:'下载成果',exact:true}).click();const artifact=await download;if(!artifact.suggestedFilename().endsWith('.zip'))throw new Error('Native completed result is not a ZIP');
 report.completedReadOnly=true;report.completedExport=artifact.suggestedFilename();console.log('Completed-task lock and dispatcher native ZIP download passed');
 fs.writeFileSync('artifacts/workbench-browser-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(errors.length)throw new Error(errors.join('\n'));
 }
}catch(error){
 console.log('FAIL: '+error.message);
 for(let i=0;i<contexts.length;i++){const page=contexts[i].pages()[0];console.log('PAGE '+i+': '+(await page.locator('body').innerText().catch(()=>'' )).slice(-2500));await page.screenshot({path:'artifacts/workbench-failure-'+i+'.png',fullPage:true}).catch(()=>{});}
 throw error;
}finally{await browser.close();}
