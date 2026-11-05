import fs from 'node:fs';import {build} from 'esbuild';import path from 'node:path';import {pathToFileURL} from 'node:url';
const bundle=await build({entryPoints:['src/mimics/workspaceRepository.ts'],bundle:true,format:'iife',globalName:'CacheAPI',write:false,platform:'browser',target:'es2022'});
fs.writeFileSync('artifacts/cache-repository-fixture.html','<!doctype html><meta charset="utf-8"><script>'+bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')+'</script>');
const{chromium}=process.argv[2]?await import(pathToFileURL(path.resolve(process.argv[2])).href):await import('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
try{
 await page.goto(pathToFileURL(path.resolve('artifacts/cache-repository-fixture.html')).href);
 const report=await page.evaluate(async()=>{
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const name='cache-migration-'+Date.now(),id='legacy',data=new Float32Array(90000),mask=new Uint8Array(90000);data[5]=123;mask[7]=1;
  const volume={name:'legacy.nii',dims:[300,300,1],spacing:[1,1,1],data,header:new Uint8Array(348),little:true,min:0,max:123,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],oblique:false,unit:'mm'};
  const state={name:'legacy',masks:[{id:'mask',name:'Mask',color:'#fff',visible:true,opacity:.45,data:mask,threshold:null,revision:0}],parts:[],measurements:[],selectedMaskId:'mask',selectedPartId:''};
  await new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{for(const key of ['volumes','documents','summaries'])r.result.createObjectStore(key,{keyPath:'id'});};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['volumes','documents','summaries'],'readwrite');tx.objectStore('volumes').put({id,volume});tx.objectStore('documents').put({id,state,updatedAt:1,revision:0});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  const repository=new CacheAPI.IndexedDBWorkspaceRepository(name),legacy=await repository.load(id);
  check(legacy.volume.data[5]===123&&legacy.state.masks[0].data[7]===1,'Legacy read failed');
  const changed=legacy.state.masks[0].data.slice();changed[8]=1;
  const updated={...legacy,updatedAt:2,state:{...legacy.state,masks:[{...legacy.state.masks[0],data:changed}]}};
  const original=IDBObjectStore.prototype.put;let chunkWrites=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='binary-chunks')chunkWrites++;return original.apply(this,args);};
  await repository.save(updated);const firstWrites=chunkWrites;
  await repository.save({...updated,updatedAt:3,state:{...updated.state,viewState:{point:[0,0,0]}}});
  const viewOnlyWrites=chunkWrites-firstWrites;IDBObjectStore.prototype.put=original;
  check(firstWrites===1&&viewOnlyWrites===0,'View-only save rewrote the mask');
  const failedMask=changed.slice();failedMask[9]=1;
  let failed=false,newFailed=false;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='documents')throw new DOMException('Injected publication failure','QuotaExceededError');return original.apply(this,args);};
  try{await repository.save({...updated,updatedAt:4,state:{...updated.state,masks:[{...updated.state.masks[0],data:failedMask}]}});}catch{failed=true;}
  try{await repository.save({...updated,id:'new-doc',updatedAt:5});}catch{newFailed=true;}
  IDBObjectStore.prototype.put=original;
  const restored=await repository.load(id),missing=await repository.load('new-doc');
  check(failed&&newFailed&&missing===null,'Failed publication left a partial document');
  check(restored.volume.data[5]===123&&restored.state.masks[0].data[8]===1&&restored.state.masks[0].data[9]===0,'Failed save damaged previous work');
  const inventory=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('binary-chunks'),q=tx.objectStore('binary-chunks').getAllKeys();q.onsuccess=()=>{const result={version:db.version,chunkCount:q.result.length};db.close();resolve(result);};};});
  check(!navigator.locks||inventory.chunkCount===1,'Orphaned mask/source chunks were not collected');
  return {legacyUpgrade:true,firstWrites,viewOnlyWrites,failedSavePreserved:true,newFailureAtomic:true,locks:!!navigator.locks,...inventory};
 });
 fs.writeFileSync('artifacts/large-import-cache-migration-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
