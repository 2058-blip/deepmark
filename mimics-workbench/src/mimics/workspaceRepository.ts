import {WorkspaceBinaryCodec,workspaceBinaryKeys,WORKSPACE_CHUNK_BYTES} from './workspaceBinary.ts';
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
  private binary=new WorkspaceBinaryCodec();
  constructor(name='deepmark-mimics-workspaces-v1'){this.name=name;}
  private open():Promise<IDBDatabase>{
    if(this.database)return this.database;
    this.database=new Promise((resolve,reject)=>{
      const request=indexedDB.open(this.name,2);
      request.onupgradeneeded=()=>{const db=request.result;for(const name of ['volumes','documents','summaries','binary-manifests'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});if(!db.objectStoreNames.contains('binary-chunks'))db.createObjectStore('binary-chunks',{keyPath:'id'}).createIndex('owner','owner');};
      request.onerror=()=>{this.database=null;reject(request.error||new Error('无法打开本地工程缓存。'));};
      request.onblocked=()=>{this.database=null;reject(new Error('本地缓存升级被另一个页面占用，请关闭旧工作台后重试。'));};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();this.database=null;};resolve(db);};
    });
    return this.database;
  }
  private async exclusive<T>(id:string,run:(locked:boolean)=>Promise<T>):Promise<T>{
    const locks=typeof navigator!=='undefined'?navigator.locks:undefined;
    return locks?await locks.request('deepmark-cache:'+this.name+':'+id,()=>run(true)):await run(false);
  }
  private async writeChunk(db:IDBDatabase,id:string,owner:string,bytes:Uint8Array){
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('binary-chunks','readwrite');tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本地数据块保存失败。'));tx.objectStore('binary-chunks').put({id,owner,bytes});});
  }
  private async cleanup(db:IDBDatabase,owner:string,live:Set<string>){
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('binary-chunks','readwrite');tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);const store=tx.objectStore('binary-chunks'),request=store.index('owner').getAllKeys(owner);request.onsuccess=()=>{for(const key of request.result)if(typeof key==='string'&&!live.has(key))store.delete(key);};});
  }
  async save(snapshot:WorkspaceSnapshot):Promise<void>{
    return this.exclusive(snapshot.id,async locked=>{
      const db=await this.open();
      const previous=await new Promise<{exists:boolean;document:any;manifest:any}>((resolve,reject)=>{
        const tx=db.transaction(['volumes','documents','binary-manifests']);let exists=false,document:any,manifest:any;
        tx.objectStore('volumes').getKey(snapshot.id).onsuccess=e=>{exists=(e.target as IDBRequest).result!==undefined;};
        tx.objectStore('documents').get(snapshot.id).onsuccess=e=>{document=(e.target as IDBRequest).result;};
        tx.objectStore('binary-manifests').get(snapshot.id).onsuccess=e=>{manifest=(e.target as IDBRequest).result;};
        tx.oncomplete=()=>resolve({exists,document,manifest});tx.onerror=tx.onabort=()=>reject(tx.error);
      });
      const reusable=new Set<string>();
      if(locked&&previous.document?.storage==='chunks-v1'){
        const visit=(item:any)=>{if(!item||typeof item!=='object'||ArrayBuffer.isView(item))return;if(item.__deepmarkBinary==='chunks-v1'){reusable.add(item.prefix);return;}for(const child of Object.values(item))visit(child);};visit(previous.document.state);
      }
      const state=this.binary.pack(snapshot.state,snapshot.id,reusable),volume=previous.exists?null:this.binary.pack(snapshot.volume,snapshot.id);
      const pending=[...(volume?.pending||[]),...state.pending];
      const volumeKeys:string[]=volume?workspaceBinaryKeys(volume.value):previous.manifest?.volumeKeys||[];
      const stateKeys=workspaceBinaryKeys(state.value),live=new Set([...volumeKeys,...stateKeys]);
      try{
        for(const item of pending){
          const bytes=new Uint8Array(item.data.buffer,item.data.byteOffset,item.data.byteLength);
          for(let i=0;i<item.ref.keys.length;i++)await this.writeChunk(db,item.ref.keys[i]!,snapshot.id,bytes.slice(i*WORKSPACE_CHUNK_BYTES,(i+1)*WORKSPACE_CHUNK_BYTES));
        }
        await new Promise<void>((resolve,reject)=>{
          const tx=db.transaction(['volumes','documents','summaries','binary-manifests'],'readwrite');
          tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本地工程保存失败，可能已达到浏览器存储限额。'));
          try{
            if(volume)tx.objectStore('volumes').put({id:snapshot.id,volume:volume.value,storage:'chunks-v1'});
            tx.objectStore('documents').put({id:snapshot.id,state:state.value,storage:'chunks-v1',updatedAt:snapshot.updatedAt,revision:snapshot.revision});
            tx.objectStore('binary-manifests').put({id:snapshot.id,volumeKeys,stateKeys});
            const summary:WorkspaceSummary={id:snapshot.id,name:snapshot.state.name,imageName:snapshot.volume.name,updatedAt:snapshot.updatedAt,dims:[...snapshot.volume.dims],maskCount:snapshot.state.masks.length,partCount:snapshot.state.parts.length};tx.objectStore('summaries').put(summary);
          }catch(error){tx.abort();reject(error);}
        });
      }catch(error){if(locked)await this.cleanup(db,snapshot.id,new Set([...(previous.manifest?.volumeKeys||[]),...(previous.manifest?.stateKeys||[])])).catch(()=>{});throw error;}
      // Publish manifests only after all chunks have committed. The same cross-tab
      // lock protects readers while obsolete/orphaned chunks are collected.
      if(locked)await this.cleanup(db,snapshot.id,live).catch(()=>{});
    });
  }
  async list():Promise<WorkspaceSummary[]>{
    const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('summaries').objectStore('summaries').getAll();request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve((request.result as WorkspaceSummary[]).sort((a,b)=>b.updatedAt-a.updatedAt));});
  }
  async load(id:string):Promise<WorkspaceSnapshot|null>{
    return this.exclusive(id,async()=>{
      const db=await this.open();
      const records=await new Promise<{v:any;d:any}>((resolve,reject)=>{
        const tx=db.transaction(['volumes','documents']);let v:any,d:any;
        tx.objectStore('volumes').get(id).onsuccess=e=>{v=(e.target as IDBRequest).result;};tx.objectStore('documents').get(id).onsuccess=e=>{d=(e.target as IDBRequest).result;};
        tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本地工程读取失败。'));tx.oncomplete=()=>resolve({v,d});
      });
      const {v,d}=records;if(!v&&!d)return null;if(!v?.volume||!d?.state)throw new Error('本地工程数据不完整，请使用已导出的工程文件恢复。');
      const read=(key:string)=>new Promise<Uint8Array>((resolve,reject)=>{const request=db.transaction('binary-chunks').objectStore('binary-chunks').get(key);request.onsuccess=()=>{const row=request.result;if(row?.owner!==id||!(row.bytes instanceof Uint8Array)){reject(new Error('本地工程数据块缺失。'));return;}resolve(row.bytes);};request.onerror=()=>reject(request.error);});
      const volume=v.storage==='chunks-v1'?await this.binary.hydrate(v.volume,id,read):v.volume;
      const state=d.storage==='chunks-v1'?await this.binary.hydrate(d.state,id,read):d.state;
      return {id,volume,state,updatedAt:d.updatedAt,revision:d.revision};
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
