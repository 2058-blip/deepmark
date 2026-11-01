import {unzipSync} from 'fflate';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { exportNifti, makeDemo, parseNifti } from '../src/core.ts';

// Pass a Playwright module path when using a shared development runtime.
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const artifacts = new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button',{name:'服务器数据集',exact:true}).click();
  const library=page.getByRole('dialog',{name:'服务器数据集',exact:true});
  const row=library.locator('.dataset-card').filter({hasText:'合成练习影像.nii.gz'});
  await row.waitFor();
  await page.getByLabel('搜索服务器数据集').fill('不存在的影像');await page.getByText('没有匹配的数据集',{exact:true}).waitFor();
  await page.getByLabel('搜索服务器数据集').fill('合成练习');
  const originalDownload=page.waitForEvent('download');await row.getByRole('link',{name:'仅下载原文件 ↓'}).click();
  const downloaded=await readFile(await (await originalDownload).path());assert.ok(downloaded[0]===31&&downloaded[1]===139);
  await row.getByRole('button',{name:'下载并标注',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已加载 合成练习影像.nii.gz'}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('canvas').count(),3);
  await page.getByRole('button',{name:'服务器数据集',exact:true}).click();await page.getByRole('dialog').waitFor();
  await page.screenshot({path:fileURLToPath(new URL('server-datasets.png',artifacts)),fullPage:true});
  await page.getByRole('button',{name:'关闭数据集窗口',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:'先用合成影像体验 →'}).click();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(500);
  const canvas = page.locator('canvas').first(), rect = await canvas.boundingBox();
  await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
  await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+28,rect.y+rect.height/2+15,{steps:10});await page.mouse.up();
  assert.equal(await page.getByRole('button',{name:'↶ 撤销',exact:true}).isEnabled(),true);
  async function exported(){
    const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出标注 ZIP ↗'}).click();
    const d=await wait;assert.match(d.suggestedFilename(),/\.zip$/);const files=unzipSync(await readFile(await d.path()));assert.ok(files['labels.json']);const bytes=files['segmentation.nii'];
    return parseNifti(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  }
  const painted=await exported();const count=painted.data.reduce((n,v)=>n+(v>0?1:0),0);assert.ok(count>10);
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click();assert.equal((await exported()).data.some(Boolean),false);
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click();assert.deepEqual((await exported()).data,painted.data);
  await page.screenshot({path:fileURLToPath(new URL('annotation-desktop.png',artifacts)),fullPage:true});
  await page.getByRole('button',{name:'阈值',exact:true}).click();
  await page.getByLabel('最小灰度',{exact:true}).fill('600');
  await page.getByLabel('最大灰度',{exact:true}).fill('650');
  // Preview never changes the exported segmentation or its undo history.
  assert.deepEqual((await exported()).data,painted.data);
  assert.equal(await page.locator('.preview-badge').count(),3);
  await page.getByLabel('最小灰度',{exact:true}).fill('700');
  assert.equal(await page.getByRole('button',{name:'应用阈值分割',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('.preview-badge').count(),0);
  await page.getByLabel('最小灰度',{exact:true}).fill('600');
  await page.getByLabel('预览选区（尚未写入标注）').uncheck();
  assert.equal(await page.locator('.preview-badge').count(),0);
  await page.getByLabel('预览选区（尚未写入标注）').check();
  await page.screenshot({path:fileURLToPath(new URL('threshold-preview.png',artifacts)),fullPage:true});
  await page.getByRole('button',{name:'应用阈值分割',exact:true}).click();
  await page.getByRole('status').filter({hasText:'阈值分割完成'}).waitFor();
  const thresholded=await exported(), originalDemo=makeDemo();
  assert.deepEqual(thresholded.data,originalDemo.data.map(value=>value>=600&&value<=650?1:0));
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click();assert.deepEqual((await exported()).data,painted.data);
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click();assert.deepEqual((await exported()).data,thresholded.data);
  const demo=makeDemo();const data=exportNifti(demo,new Uint16Array(demo.data.length));
  const gz=gzipSync(Buffer.from(data));await writeFile(new URL('sample.nii.gz',artifacts),gz);
  await page.locator('input[type=file]').first().setInputFiles({name:'sample.nii.gz',mimeType:'application/gzip',buffer:gz});
  await page.getByRole('status').filter({hasText:'已加载 sample.nii.gz'}).waitFor();
  await page.setViewportSize({width:600,height:900});await page.screenshot({path:fileURLToPath(new URL('annotation-mobile.png',artifacts)),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);console.log(`Browser checks passed: server catalog/search/download/open; ${count} painted voxels; threshold preview, validation, volume apply, undo/redo, export, gzip import and responsive layout.`);
} finally {await browser.close();}
