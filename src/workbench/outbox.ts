import type {MetaChanges} from './wire.ts';
export interface WorkbenchOperation {
  key:string;project:string;op:string;baseRevision:number;kind:string;changes:MetaChanges;
  created:number;parts:number;status:'encoding'|'ready';nativeRevision:number;
}
export interface OperationPart {key:string;operation:string;n:number;mask:string;packet:Uint8Array}
/** Per-account outcome queue. It stores bounded result packets, never pointer paths
 * or a private server workspace. Native full progress remains in its own cache. */
export class WorkbenchOutbox {
  private database:Promise<IDBDatabase>|null=null;
  readonly user:string;
  constructor(user:string){this.user=user;}
  private open():Promise<IDBDatabase>{
    if(this.database)return this.database;
    this.database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('deepmark-native-outbox-'+this.user,2);
      request.onupgradeneeded=()=>{const db=request.result;
        if(!db.objectStoreNames.contains('operations')){const ops=db.createObjectStore('operations',{keyPath:'key'});ops.createIndex('project','project');}
        if(!db.objectStoreNames.contains('parts')){const parts=db.createObjectStore('parts',{keyPath:'key'});parts.createIndex('operation','operation');}
        if(!db.objectStoreNames.contains('workspace-meta'))db.createObjectStore('workspace-meta',{keyPath:'project'});
      };
      request.onerror=()=>{this.database=null;reject(request.error);};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();this.database=null;};resolve(db);};
    });return this.database;
  }
  private async write(stores:string[],action:(transaction:IDBTransaction)=>void){
    const db=await this.open();await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(stores,'readwrite');tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||new Error('待同步操作缓存失败。'));
      try{action(tx);}catch(error){tx.abort();reject(error);}
    });
  }
  async begin(operation:WorkbenchOperation){await this.write(['operations'],tx=>tx.objectStore('operations').put(operation));}
  async part(operation:WorkbenchOperation,n:number,mask:string,packet:Uint8Array){
    const record:OperationPart={key:operation.key+':'+n,operation:operation.key,n,mask,packet};
    await this.write(['operations','parts'],tx=>{tx.objectStore('parts').put(record);tx.objectStore('operations').put({...operation,parts:n+1});});
  }
  async ready(operation:WorkbenchOperation,parts:number){await this.write(['operations'],tx=>tx.objectStore('operations').put({...operation,status:'ready',parts}));}
  async list(project:string):Promise<WorkbenchOperation[]>{
    const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('operations').objectStore('operations').index('project').getAll(project);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve((request.result as WorkbenchOperation[]).sort((a,b)=>a.created-b.created));});
  }
  async parts(operation:string):Promise<OperationPart[]>{
    const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('parts').objectStore('parts').index('operation').getAll(operation);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve((request.result as OperationPart[]).sort((a,b)=>a.n-b.n));});
  }
  async remove(key:string){
    await this.write(['operations','parts'],tx=>{
      tx.objectStore('operations').delete(key);
      const request=tx.objectStore('parts').index('operation').openKeyCursor(IDBKeyRange.only(key));
      request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;tx.objectStore('parts').delete(cursor.primaryKey);cursor.continue();};
    });
  }
  async mark(project:string,serverRevision:number,nativeRevision:number){await this.write(['workspace-meta'],tx=>tx.objectStore('workspace-meta').put({project,serverRevision,nativeRevision}));}
  async marker(project:string):Promise<{project:string;serverRevision:number;nativeRevision:number}|null>{
    const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('workspace-meta').objectStore('workspace-meta').get(project);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result||null);});
  }
}
