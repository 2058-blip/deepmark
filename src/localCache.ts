import type {Draft,DraftIndex,Identity,Operation} from './collaborationTypes.ts';
let connection:Promise<IDBDatabase>|null=null;
let migration:Promise<void>|null=null;
const legacyKeys=new Set<string>();
function db(){return connection??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('deepmark-workspaces',1);
  request.onupgradeneeded=()=>{for(const name of ['queue','drafts','draftIndex','datasets','identities'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:name==='identities'?'id':'key'});};
  request.onsuccess=()=>{const database=request.result;database.onversionchange=()=>database.close();resolve(database);};request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('本地缓存正在升级，请关闭旧版网页后重试。'));
});}
async function transaction<T>(names:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction)=>IDBRequest<T>|void):Promise<T>{
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction(names,mode);let result:T;const request=run(tx);if(request)request.onsuccess=()=>{result=request.result;};
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||new Error('本地缓存写入失败。'));tx.onabort=()=>reject(tx.error||new Error('本地缓存写入中断。'));
  });
}
export function writeLocal({operation,operations,draft,removeOp}:{operation?:Operation;operations?:Operation[];draft?:Draft;removeOp?:string}){
  const write=transaction<void>(['queue','drafts','draftIndex'],'readwrite',tx=>{
    if(operations)for(const op of operations)tx.objectStore('queue').put(op);if(operation)tx.objectStore('queue').put(operation);if(removeOp)tx.objectStore('queue').delete(removeOp);
    if(draft){tx.objectStore('drafts').put(draft);const index:DraftIndex={key:draft.key,author:draft.author,name:draft.name,updated:draft.updated,needsCheckpoint:draft.needsCheckpoint,projectId:draft.project.id,datasetId:draft.project.datasetId};tx.objectStore('draftIndex').put(index);}
  });
  return write.then(async()=>{if(removeOp&&legacyKeys.has(removeOp)){const old=await legacy();if(old.objectStoreNames.contains('queue'))await new Promise<void>((resolve,reject)=>{const tx=old.transaction('queue','readwrite');tx.objectStore('queue').delete(removeOp);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});old.close();legacyKeys.delete(removeOp);}});
}
function legacy():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('deepmark-collaboration');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function migrateLegacy(){
  const old=await legacy();if(!old.objectStoreNames.contains('queue')){old.close();return;}
  const rows=await new Promise<Operation[]>((resolve,reject)=>{const request=old.transaction('queue').objectStore('queue').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});old.close();
  if(rows.length)await transaction<void>(['queue'],'readwrite',tx=>{for(const op of rows){legacyKeys.add(op.key);const store=tx.objectStore('queue'),request=store.get(op.key);request.onsuccess=()=>{if(!request.result)store.put(op);};}});
}
export const allOperations=async()=>{await (migration??=migrateLegacy());return transaction<Operation[]>(['queue'],'readonly',tx=>tx.objectStore('queue').getAll());};
export const readDraft=(key:string)=>transaction<Draft|undefined>(['drafts'],'readonly',tx=>tx.objectStore('drafts').get(key));
export const listDrafts=()=>transaction<DraftIndex[]>(['draftIndex'],'readonly',tx=>tx.objectStore('draftIndex').getAll());
export const cacheDataset=(key:string,file:File)=>transaction<void>(['datasets'],'readwrite',tx=>{tx.objectStore('datasets').put({key,name:file.name,file});});
export const readDataset=(key:string)=>transaction<{key:string;name:string;file:File}|undefined>(['datasets'],'readonly',tx=>tx.objectStore('datasets').get(key));
export const saveIdentity=(identity:Identity)=>transaction<void>(['identities'],'readwrite',tx=>{tx.objectStore('identities').put(identity);});
export const allIdentities=()=>transaction<Identity[]>(['identities'],'readonly',tx=>tx.objectStore('identities').getAll());
export async function cacheStats(key:string){const [draft,ops]=await Promise.all([readDraft(key),allOperations()]);return {draft,pending:ops.filter(op=>op.key.startsWith(key+':')).length};}
