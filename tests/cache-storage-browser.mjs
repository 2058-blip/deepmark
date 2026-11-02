import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
const server=await createServer({configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,watch:null}});await server.listen();
const origin=server.resolvedUrls.local[0];
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright'),browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();await page.goto(origin);
  const result=await page.evaluate(async()=>{
    const {writeLocal,readDraft,writeView}=await import('/src/localCache.ts'),mask=new Uint16Array(72*1024*1024);mask[0]=1;mask[123456]=7;mask[mask.length-1]=65535;
    const draft={key:'storage-test:large',author:{id:'storage-test',name:'缓存测试'},project:{id:'large',datasetId:'sample',revision:0,latestRevision:0,mask:'',regions:[],labels:[{id:1,name:'标注 1',color:'#ffffff'}],status:'editing'},name:'large.nii',mask:mask.buffer,segments:[{id:1,name:'标注 1',color:'#ffffff',visible:true}],view:{point:[1,2,3],selected:1,center:40,width:400,diameter:8,opacity:.45,tool:'paint'},updated:1,generation:0,pending:null,needsCheckpoint:false};
    await writeLocal({draft});const restored=await readDraft(draft.key),values=new Uint16Array(restored.mask);await writeView(draft.key,{...draft.view,point:[4,5,6]});const view=(await readDraft(draft.key)).view;
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('deepmark-workspaces',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const stored=await new Promise((resolve,reject)=>{const tx=db.transaction('drafts'),request=tx.objectStore('drafts').get(draft.key);request.onsuccess=()=>resolve({blob:request.result.mask instanceof Blob,size:request.result.mask.size});request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.objectStore('drafts').put({...draft,key:'storage-test:legacy',mask:Uint16Array.from([2,300,0]).buffer});});db.close();
    const legacy=await readDraft('storage-test:legacy');
    const encode=(index,value)=>{const raw=new Uint8Array(8),data=new DataView(raw.buffer);data.setUint32(0,index,true);data.setUint16(6,value,true);return btoa(String.fromCharCode(...raw));};
    await writeLocal({delta:{key:draft.key,generation:1,op:'remote-edit',patch:encode(123456,9),owners:[[123456,'other-author']],project:{...draft.project,revision:1},segments:draft.segments,view:draft.view,updated:10,needsCheckpoint:false}});
    const journal=await readDraft(draft.key),metadata=await readDraft(draft.key,false);
    // A snapshot must delete only incorporated patches, never a newer queued delta.
    await writeLocal({delta:{key:draft.key,generation:2,op:'newer',patch:encode(0,2),project:{...draft.project,revision:2},segments:draft.segments,view:draft.view,updated:11,needsCheckpoint:false}});
    await writeLocal({draft:journal});const compacted=await readDraft(draft.key);
    return {stored,bytes:restored.mask.byteLength,labels:[values[0],values[123456],values[values.length-1]],originalBytes:mask.byteLength,point:view.point,legacy:[...new Uint16Array(legacy.mask)],journalValue:new Uint16Array(journal.mask)[123456],revision:compacted.project.revision,compacted:[new Uint16Array(compacted.mask)[0],new Uint16Array(compacted.mask)[123456]],metadataBytes:metadata.mask.byteLength};
  });
  assert.equal(result.stored.blob,true);assert.equal(result.bytes,144*1024*1024);assert.equal(result.stored.size,result.bytes);assert.equal(result.originalBytes,result.bytes);assert.deepEqual(result.labels,[1,7,65535]);assert.deepEqual(result.point,[4,5,6]);assert.deepEqual(result.legacy,[2,300,0]);console.log('Verified 144 MB Blob draft round trip, intact voxel values, view metadata merge and legacy ArrayBuffer compatibility.');
  assert.equal(result.journalValue,9);assert.deepEqual(result.compacted,[2,9]);assert.equal(result.revision,2);assert.equal(result.metadataBytes,0);console.log('Verified incremental remote patches, snapshot compaction ordering and metadata-only resume.');
}finally{await browser.close();await server.close();}
