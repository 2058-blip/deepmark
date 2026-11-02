import type {Draft,DraftIndex,Identity,Operation,ViewState} from './collaborationTypes.ts';
let connection:Promise<IDBDatabase>|null=null;
let migration:Promise<void>|null=null;
const legacyKeys=new Set<string>();
export type DraftDelta={key:string;generation:number;patch:string;owners?:[number,string|null][];project:Draft['project'];segments:Draft['segments'];view:ViewState;updated:number;needsCheckpoint:boolean;op:string};
const patchKey=(key:string,generation:number)=>`${key}\0${String(generation).padStart(20,'0')}`;
function db(){return connection??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('deepmark-workspaces',2);
  request.onupgradeneeded=()=>{for(const name of ['queue','drafts','draftIndex','datasets','identities','patches'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:name==='identities'?'id':'key'});};
  request.onsuccess=()=>{const database=request.result;database.onversionchange=()=>database.close();resolve(database);};request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('本地缓存正在升级，请关闭旧版网页后重试。'));
});}
async function transaction<T>(names:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction)=>IDBRequest<T>|void):Promise<T>{
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction(names,mode);let result:T;
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||new Error('本地缓存写入失败。'));tx.onabort=()=>reject(tx.error||new Error('本地缓存写入中断。'));
    try{const request=run(tx);if(request)request.onsuccess=()=>{result=request.result;};}catch(reason){try{tx.abort();}catch{}reject(reason);}
  });
}
export function writeLocal({operation,operations,draft,removeOp,delta}:{operation?:Operation;operations?:Operation[];draft?:Draft;removeOp?:string;delta?:DraftDelta}){
  // Store large voxel buffers as Blob payloads, outside IndexedDB's metadata serialization path.
  const stored=draft?{...draft,mask:new Blob([draft.mask])}:null;
  const write=transaction<void>(['queue','drafts','draftIndex','patches'],'readwrite',tx=>{
    const queue=tx.objectStore('queue'),drafts=tx.objectStore('drafts'),indices=tx.objectStore('draftIndex');
    if(operations)for(const op of operations)queue.put(op);if(operation)queue.put(operation);if(removeOp)queue.delete(removeOp);
    if(delta){tx.objectStore('patches').put({key:patchKey(delta.key,delta.generation),delta});const request=indices.get(delta.key);request.onsuccess=()=>{if(request.result)indices.put({...request.result,updated:delta.updated,needsCheckpoint:delta.needsCheckpoint,view:delta.view,viewUpdated:delta.updated});};}
    if(draft&&stored){const index:DraftIndex={key:draft.key,author:draft.author,name:draft.name,updated:draft.updated,needsCheckpoint:draft.needsCheckpoint,projectId:draft.project.id,datasetId:draft.project.datasetId,view:draft.view,viewUpdated:draft.updated};indices.put(index);drafts.put(stored);tx.objectStore('patches').delete(IDBKeyRange.bound(patchKey(draft.key,0),patchKey(draft.key,draft.generation)));}
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
export const readDraft=async(key:string,materialize=true)=>{
  const database=await db();
  const {stored,patches,meta}=await new Promise<{stored?:(Omit<Draft,'mask'>&{mask:ArrayBuffer|Blob});patches:{delta:DraftDelta}[];meta?:DraftIndex}>((resolve,reject)=>{
    const tx=database.transaction(['drafts','patches','draftIndex']);
    const base=tx.objectStore('drafts').get(key),changes=tx.objectStore('patches').getAll(IDBKeyRange.bound(`${key}\0`,`${key}\0\uffff`)),index=tx.objectStore('draftIndex').get(key);
    tx.oncomplete=()=>resolve({stored:base.result,patches:changes.result,meta:index.result});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  if(!stored)return undefined;
  const draft:Draft={...stored,mask:!materialize?new ArrayBuffer(0):stored.mask instanceof Blob?await stored.mask.arrayBuffer():stored.mask};
  const mask=new Uint16Array(draft.mask),owned=draft.ownedMask?new Uint8Array(draft.ownedMask):undefined;
  for(const {delta}of patches){
    if(delta.generation<=draft.generation)continue;
    if(materialize){
      const bytes=Uint8Array.from(atob(delta.patch),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
      for(let p=0;p<bytes.length;p+=8)mask[view.getUint32(p,true)]=view.getUint16(p+6,true);
      if(owned)for(const [i,author]of delta.owners||[])if(author===draft.author.id)owned[i>>>3]|=1<<(i&7);else owned[i>>>3]&=~(1<<(i&7));
    }
    draft.project=delta.project;draft.segments=delta.segments;draft.view=delta.view;draft.updated=delta.updated;draft.generation=delta.generation;draft.needsCheckpoint=delta.needsCheckpoint;
    if(draft.pending?.op===delta.op)draft.pending=null;
  }
  return meta?.view&&(meta.viewUpdated||0)>=draft.updated?{...draft,view:meta.view,updated:Math.max(draft.updated,meta.updated)}:draft;
};
export const writeView=(key:string,view:ViewState)=>transaction<void>(['draftIndex'],'readwrite',tx=>{const store=tx.objectStore('draftIndex'),request=store.get(key);request.onsuccess=()=>{if(request.result)store.put({...request.result,view,viewUpdated:Date.now(),updated:Date.now()});};});
export const listDrafts=()=>transaction<DraftIndex[]>(['draftIndex'],'readonly',tx=>tx.objectStore('draftIndex').getAll());
export const cacheDataset=(key:string,file:File,fingerprint?:string)=>transaction<void>(['datasets'],'readwrite',tx=>{tx.objectStore('datasets').put({key,name:file.name,file,fingerprint});});
export const readDataset=(key:string)=>transaction<{key:string;name:string;file:File;fingerprint?:string}|undefined>(['datasets'],'readonly',tx=>tx.objectStore('datasets').get(key));
export const saveIdentity=(identity:Identity)=>transaction<void>(['identities'],'readwrite',tx=>{tx.objectStore('identities').put(identity);});
export const allIdentities=()=>transaction<Identity[]>(['identities'],'readonly',tx=>tx.objectStore('identities').getAll());
export async function cacheStats(key:string){const [draft,ops]=await Promise.all([readDraft(key),allOperations()]);return {draft,pending:ops.filter(op=>op.key.startsWith(key+':')).length};}
