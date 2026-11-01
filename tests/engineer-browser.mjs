import {unzipSync} from 'fflate';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile,unlink,readFile,mkdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseNifti} from '../src/core.ts';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const dims=[512,512,24],count=dims[0]*dims[1]*dims[2],bytes=Buffer.alloc(352+count*2),header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);header.setInt32(0,348,true);header.setInt16(40,3,true);dims.forEach((n,a)=>{header.setInt16(42+a*2,n,true);header.setFloat32(80+a*4,a===2?2:1,true);});header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setInt16(254,1,true);header.setFloat32(280,1,true);header.setFloat32(300,1,true);header.setFloat32(320,2,true);header.setUint8(123,2);bytes.set([110,43,49,0],344);
for(let z=0;z<dims[2];z++)for(let y=0;y<512;y++)for(let x=0;x<512;x++){const r=((x-256)/180)**2+((y-256)/160)**2;let value=r<1?40:-1000;if(r>.88&&r<1)value=650;if((x-256)**2+(y-256)**2<32**2)value=135;bytes.writeInt16LE(value,352+2*(x+512*(y+512*z)));}
const name=`工程师性能-${randomUUID()}.nii.gz`,file=new URL('../server-data/datasets/'+name,import.meta.url);await writeFile(file,gzipSync(bytes));
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Condition timed out');}
const healthy=()=>page.locator('.collaboration-panel[data-online="true"][data-pending="0"][data-error="false"]');
async function exported(){const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出标注 ZIP ↗',exact:true}).click();const data=unzipSync(await readFile(await (await wait).path()))['segmentation.nii'];return parseNifti(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));}
async function center(){const canvas=page.locator('canvas').first();await canvas.scrollIntoViewIfNeeded();await until(()=>canvas.evaluate(c=>Math.abs(c.height-window.devicePixelRatio*c.getBoundingClientRect().height)<2));const rect=await canvas.boundingBox();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};}
try{
  await page.goto('http://127.0.0.1:5173/');assert.equal(await page.getByRole('button',{name:'管理员工作台',exact:true}).count(),0);
  await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.locator('.dataset-card').filter({hasText:name}).getByRole('button',{name:'下载并标注',exact:true}).click();await page.getByRole('dialog',{name:'服务器数据集',exact:true}).waitFor({state:'hidden'});await page.getByLabel('团队昵称').fill('性能测试工程师');await page.getByRole('button',{name:'登录团队',exact:true}).click();await until(()=>healthy().count());
  const initial=await exported();assert.equal(initial.data.some(Boolean),false);
  const before=await page.locator('.slice').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.grayBuilds)));
  const burst=await page.locator('canvas').first().evaluate(async canvas=>{const view=canvas.closest('.slice');for(let i=0;i<80;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));const end=performance.now()+3000;while(Number(view.dataset.renderedSlice)!==23&&performance.now()<end)await new Promise(requestAnimationFrame);return {slice:Number(view.dataset.renderedSlice),builds:Number(view.dataset.grayBuilds)};});assert.equal(burst.slice,23);
  const after=await page.locator('.slice').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.grayBuilds)));assert.ok(after[0]-before[0]<=2);assert.equal(after[1],before[1]);assert.equal(after[2],before[2]);
  const timings=await page.locator('canvas').first().evaluate(async canvas=>{const view=canvas.closest('.slice'),times=[];let current=23;for(let n=0;n<30;n++){const step=n<15?-1:1,target=Math.max(0,Math.min(23,current+step));canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:step*100,bubbles:true,cancelable:true}));const end=performance.now()+3000;while(Number(view.dataset.renderedSlice)!==target&&performance.now()<end)await new Promise(requestAnimationFrame);if(Number(view.dataset.renderedSlice)!==target)throw new Error('Scroll did not settle');times.push(Number(view.dataset.renderMs));current=target;}return times;});
  await page.getByRole('button',{name:'灰度分区',exact:true}).click();let point=await center();await page.mouse.move(point.x,point.y);await page.locator('.slice-2 .gray-region-outline path').waitFor();const outline=await page.locator('.slice-2 .gray-region-outline path').getAttribute('d');assert.ok(outline.length>8);
  const stillEmpty=await exported();assert.equal(stillEmpty.data.some(Boolean),false);
  point=await center();await page.mouse.move(point.x,point.y);await page.locator('.slice-2 .gray-region-outline path').waitFor();
  const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});await page.screenshot({path:fileURLToPath(new URL('gray-hover-preview.png',artifacts)),fullPage:true});
  await page.mouse.click(point.x,point.y);await until(()=>healthy().count());await page.getByRole('status').filter({hasText:'本切片灰度区域已加入'}).waitFor();const filled=await exported();const selected=[...filled.data.keys()].filter(i=>filled.data[i]>0);assert.ok(selected.length>100);assert.ok(selected.every(i=>Math.floor(i/(512*512))===23));
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click();await until(()=>healthy().count());assert.equal((await exported()).data.some(Boolean),false);
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click();await until(()=>healthy().count());assert.deepEqual((await exported()).data,filled.data);
  await page.getByLabel('灰度分区方式').selectOption('level');point=await center();await page.mouse.move(point.x+1,point.y);await page.locator('.slice-2 .gray-region-outline path').waitFor();assert.ok(await page.locator('.slice-2 .gray-region-outline path').getAttribute('d'));
  assert.deepEqual(errors,[]);const sorted=timings.sort((a,b)=>a-b);console.log(`Engineer browser checks passed: 512×512×24 volume; 80 wheel events coalesced; unchanged views reused; render p95=${sorted[Math.floor(sorted.length*.95)]} ms; hover-only preview, current-slice fill, undo/redo and level mode.`);
}catch(reason){console.log('Engineer failure:',await page.locator('body').innerText());throw reason;}finally{await browser.close();await unlink(file);}
