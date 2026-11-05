import type {Volume} from '../core.ts';
import type {ProjectState} from './project.ts';

export interface WorkspaceSnapshot {id:string;volume:Volume;state:ProjectState;updatedAt:number;revision?:number}
export interface WorkspaceSummary {id:string;name:string;imageName:string;updatedAt:number;dims:[number,number,number];maskCount:number;partCount:number}
export interface WorkspaceRepository {
  save(snapshot:WorkspaceSnapshot):Promise<void>;
  list():Promise<WorkspaceSummary[]>;
  load(id:string):Promise<WorkspaceSnapshot|null>;
}
/** Local-only storage. Volumes are written once per document; state and view are atomic. */
export class IndexedDBWorkspaceRepository implements WorkspaceRepository {
  private database:Promise<IDBDatabase>|null=null;
  private name:string;
  constructor(name='deepmark-mimics-workspaces-v1'){this.name=name;}
  private open():Promise<IDBDatabase>{
    if(this.database)return this.database;
    this.database=new Promise((resolve,reject)=>{
      const request=indexedDB.open(this.name,1);
      request.onupgradeneeded=()=>{const db=request.result;for(const name of ['volumes','documents','summaries'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});};
      request.onerror=()=>{this.database=null;reject(request.error||new Error('无法打开本地工程缓存。'));};
      request.onblocked=()=>{this.database=null;reject(new Error('本地缓存升级被另一个页面占用，请关闭旧工作台后重试。'));};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();this.database=null;};resolve(db);};
    });
    return this.database;
  }
  async save(snapshot:WorkspaceSnapshot):Promise<void>{
    const db=await this.open();
    await new Promise<void>((resolve,reject)=>{
      const transaction=db.transaction(['volumes','documents','summaries'],'readwrite');
      transaction.oncomplete=()=>resolve();transaction.onabort=transaction.onerror=()=>reject(transaction.error||new Error('本地缓存写入失败，可能已达到浏览器存储限额。'));
      const volumeStore=transaction.objectStore('volumes'),existing=volumeStore.getKey(snapshot.id);
      existing.onsuccess=()=>{if(existing.result===undefined)volumeStore.put({id:snapshot.id,volume:snapshot.volume});};
      transaction.objectStore('documents').put({id:snapshot.id,state:snapshot.state,updatedAt:snapshot.updatedAt,revision:snapshot.revision});
      const summary:WorkspaceSummary={id:snapshot.id,name:snapshot.state.name,imageName:snapshot.volume.name,updatedAt:snapshot.updatedAt,dims:[...snapshot.volume.dims],maskCount:snapshot.state.masks.length,partCount:snapshot.state.parts.length};
      transaction.objectStore('summaries').put(summary);
    });
  }
  async list():Promise<WorkspaceSummary[]>{
    const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('summaries').objectStore('summaries').getAll();request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve((request.result as WorkspaceSummary[]).sort((a,b)=>b.updatedAt-a.updatedAt));});
  }
  async load(id:string):Promise<WorkspaceSnapshot|null>{
    const db=await this.open();return new Promise((resolve,reject)=>{
      const transaction=db.transaction(['volumes','documents']);let v:any,d:any;
      const vr=transaction.objectStore('volumes').get(id),dr=transaction.objectStore('documents').get(id);
      vr.onsuccess=()=>{v=vr.result;};dr.onsuccess=()=>{d=dr.result;};
      transaction.onabort=transaction.onerror=()=>reject(transaction.error||new Error('本地工程读取失败。'));
      transaction.oncomplete=()=>{if(!v&&!d){resolve(null);return;}if(!v?.volume||!d?.state){reject(new Error('本地工程数据不完整，请使用已导出的工程文件恢复。'));return;}resolve({id,volume:v.volume,state:d.state,updatedAt:d.updatedAt,revision:d.revision});};
    });
  }
}

/** Coalesce edits while a write is in flight; do not let an older write win. */
export class WorkspaceSaveQueue {
  private next=new Map<string,WorkspaceSnapshot>();
  private running:Promise<void>|null=null;
  private errors=new Map<string,unknown>();
  private repository:WorkspaceRepository;
  private saved?: (snapshot:WorkspaceSnapshot)=>void;
  private failed?: (error:unknown,snapshot:WorkspaceSnapshot)=>void;
  constructor(repository:WorkspaceRepository,saved?:(snapshot:WorkspaceSnapshot)=>void,failed?:(error:unknown,snapshot:WorkspaceSnapshot)=>void){this.repository=repository;this.saved=saved;this.failed=failed;}
  enqueue(snapshot:WorkspaceSnapshot){
    this.next.set(snapshot.id,snapshot);
    // Assign running before drain can complete, including a synchronously throwing repository.
    if(!this.running)this.running=Promise.resolve().then(()=>this.drain());
  }
  private async drain(){
    try{
      while(this.next.size){
        const [id,snapshot]=this.next.entries().next().value!;this.next.delete(id);
        try{await this.repository.save(snapshot);}
        catch(error){
          this.errors.set(id,error);
          // UI observers cannot stop pending writes or change their persistence outcome.
          try{this.failed?.(error,snapshot);}catch{}
          continue;
        }
        this.errors.delete(id);
        try{this.saved?.(snapshot);}catch{}
      }
    }finally{this.running=null;}
  }
  async flush(snapshot:WorkspaceSnapshot){this.enqueue(snapshot);while(this.running)await this.running;if(this.errors.has(snapshot.id))throw this.errors.get(snapshot.id);}
}
