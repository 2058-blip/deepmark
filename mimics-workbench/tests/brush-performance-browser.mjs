import fs from 'node:fs';import path from 'node:path';import {pathToFileURL}from'node:url';
const {chromium}=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href):await import('playwright');
const mode=process.argv[2]||'current',file=process.argv[3]||'artifacts/Deepmark-Studio-离线测试.html';
const fixture=process.env.PERF_NIFTI||'artifacts/large-import-512x512x768.nii.gz';
fs.mkdirSync('artifacts/brush-performance',{recursive:true});
if(mode==='before')fs.copyFileSync(file,'artifacts/brush-performance/before.html');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1050}});
page.setDefaultTimeout(120000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(pathToFileURL(path.resolve(file)).href);
 await page.locator('input[type=file]').first().setInputFiles(path.resolve(fixture));
 await page.waitForFunction(()=>document.querySelector('.mw-status')?.textContent.includes('本地副本已保存'));
 if(process.argv[4]==='mpr'){await page.getByRole('button',{name:'显示 MPR 三正交视图',exact:true}).click();await page.waitForTimeout(1500);}
 const box=await page.locator('canvas').first().boundingBox(),x=box.x+box.width*.35,y=box.y+box.height*.4;
 const reports=[];
 for(const [tool,index] of [['paint',4],['erase',5],['local-threshold',6]]){
  await page.locator('.mw-tool-grid button').nth(index).click();
  await page.mouse.move(x,y);const down=performance.now();await page.mouse.down();const downMs=performance.now()-down;
  const result=await page.evaluate(async({x,y,w,h})=>{
   const canvas=document.querySelector('canvas'),frames=[],handlers=[];let previous=performance.now();
   for(let i=0;i<60;i++){
    await new Promise(resolve=>requestAnimationFrame(resolve));const now=performance.now();frames.push(now-previous);previous=now;
    const t=performance.now();canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,button:-1,buttons:1,clientX:x+i/60*w*.35,clientY:y+Math.sin(i*.22)*h*.1,bubbles:true}));handlers.push(performance.now()-t);
   }
   frames.sort((a,b)=>a-b);handlers.sort((a,b)=>a-b);
   return{frames,frameMedian:frames[30],frameP95:frames[57],handlerP95:handlers[57],max:frames.at(-1)};
  },{x,y,w:box.width,h:box.height});
  const up=performance.now();await page.mouse.up();const upMs=performance.now()-up;
  await page.waitForFunction(()=>document.querySelector('.mw-status')?.textContent.includes('本地副本已保存'));
  await page.waitForFunction(()=>document.querySelector('.mw-object-properties')?.getAttribute('data-mask-statistics-pending')!=='true');
  const count=await page.locator('.mw-object-properties dd').first().innerText();
  reports.push({tool,downMs,upMs,count,...result});console.log(JSON.stringify({mode,tool,downMs,upMs,count,...result,frames:undefined}));
 }
 fs.writeFileSync('artifacts/brush-performance/'+mode+'.json',JSON.stringify({mode,reports,errors},null,2));
 if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser.close();}
