import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const origin=(process.env.DEEPMARK_BROWSER_URL||'http://localhost:8082').replace(/\/$/,''),modulePath=process.argv[2]||process.env.DEEPMARK_PLAYWRIGHT_PATH;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:531,height:976},deviceScaleFactor:1.5}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByRole('button',{name:'注册账号',exact:true}).click();
 const password='LayoutTest!'+randomUUID();
 await page.getByLabel('用户名',{exact:true}).fill('layout_'+randomUUID().slice(0,8));
 await page.getByLabel('显示名称',{exact:true}).fill('界面刷新回归测试');
 await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);
 await page.locator('input[value="worker"]').check();await page.getByRole('button',{name:'注册并进入工作台',exact:true}).click();
 await page.locator('.console-page').waitFor();await page.locator('.console-heading>button[aria-busy="false"]').waitFor();
 let requests=0;
 await page.route('**/api/datasets',async route=>{requests++;await new Promise(resolve=>setTimeout(resolve,600));await route.continue();});
 await page.getByLabel('小组名称',{exact:true}).fill('保持未提交的输入');
 await page.getByLabel('小组名称',{exact:true}).focus();
 const samples=await page.evaluate(async()=>{
  const samples=[],end=performance.now()+11500;
  while(performance.now()<end){await new Promise(requestAnimationFrame);const heading=document.querySelector('.console-heading'),button=heading.querySelector('button'),card=document.querySelector('.console-team-grid');samples.push({label:button.textContent,disabled:button.disabled,headingHeight:heading.getBoundingClientRect().height,cardTop:card.getBoundingClientRect().top+scrollY,scrollY});}
  return samples;
 });
 assert.ok(requests>=2,'The regression must span multiple actual automatic refreshes.');
 assert.ok(samples.every(row=>row.label==='刷新工作台'&&!row.disabled),'Background polling must not change or flash the manual button.');
 for(const property of ['headingHeight','cardTop','scrollY'])assert.ok(Math.max(...samples.map(row=>row[property]))-Math.min(...samples.map(row=>row[property]))<.5,property+' moved during polling');
 assert.equal(await page.getByLabel('小组名称',{exact:true}).inputValue(),'保持未提交的输入');
 assert.equal(await page.getByLabel('小组名称',{exact:true}).evaluate(input=>document.activeElement===input),true);
 await page.locator('.console-heading>button').click();await page.locator('.console-heading>button[aria-busy="true"]').waitFor();
 assert.equal(await page.locator('.console-heading>button').innerText(),'刷新工作台');await page.locator('.console-heading>button[aria-busy="false"]').waitFor();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',automaticRefreshes:requests,stableHeading:true,stableScroll:true,inputPreserved:true,manualRefresh:true}));
}finally{await browser.close();}
