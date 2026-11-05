import {api,authenticatedFetch,responseError,fingerprint} from '../api.ts';
import type {ProjectState} from '../../mimics-workbench/src/mimics/project.ts';
import type {MaskObject} from '../../mimics-workbench/src/mimics/types.ts';
import {readMaskRuns,applyMaskPackets} from './maskRuns.ts';
export const WORKBENCH_BASE='/api/collaboration/workbenches';
export const COLLECTIONS=['masks','parts','measurements','centerlines','polylines','resliceObjects'] as const;
export type Collection=typeof COLLECTIONS[number];
export interface HistoryView {kind:'native'|'legacy';revision:number}
export type Manifest={name:string;resliceTransform?:string;sourceUnit?:number;rawUnit?:number}&Record<Collection,Record<string,any>[]>;
export interface MetaChanges {name?:string;resliceTransform?:string|null;sourceUnit?:number;upserts?:Partial<Record<Collection,Record<string,any>[]>>;removals?:Partial<Record<Collection,string[]>>}
export interface SharedWorkbench {
  id:string;datasetId:string;fingerprint:string;count:number;revision:number;latestRevision:number;
  manifest:Manifest;canWrite:boolean;datasetStatus:string;maskBase:string;resourceBase:string;claims:{mask:string;author:string;name:string}[];historicalKind?:'legacy';
}
export interface SharedEvent {revision:number;op:string;author:string;name:string;kind:string;time:string;changes:MetaChanges;renamed:Record<string,string>;parts:{n:number;mask:string;scope?:'union'|'claim';author?:string}[]}
export function emptyManifest():Manifest{return{name:'',masks:[],parts:[],measurements:[],centerlines:[],polylines:[],resliceObjects:[]};}
function localField(key:string){return key==='visible'||key==='opacity';}
export function metadataChanges(before:Manifest,after:Manifest):MetaChanges{
  const changes:MetaChanges={upserts:{},removals:{}};
  if(before.name!==after.name)changes.name=after.name;
  if(before.resliceTransform!==after.resliceTransform)changes.resliceTransform=after.resliceTransform??null;
  if(before.sourceUnit!==after.sourceUnit&&after.sourceUnit)changes.sourceUnit=after.sourceUnit;
  for(const key of COLLECTIONS){
    const old=new Map(before[key].map(item=>[item.id,item])),next=new Map(after[key].map(item=>[item.id,item]));
    const added=after[key].filter(item=>JSON.stringify(old.get(item.id))!==JSON.stringify(item));
    const deleted=before[key].filter(item=>!next.has(item.id)).map(item=>String(item.id));
    if(added.length)changes.upserts![key]=added;
    if(deleted.length)changes.removals![key]=deleted;
  }
  return changes;
}
export function hasMetadataChanges(changes:MetaChanges){return changes.name!==undefined||changes.resliceTransform!==undefined||changes.sourceUnit!==undefined||Object.values(changes.upserts||{}).some(items=>!!items?.length)||Object.values(changes.removals||{}).some(items=>!!items?.length);}
export function applyMetadata(before:Manifest,changes:MetaChanges):Manifest{
  const next={...before};
  if(changes.name!==undefined)next.name=changes.name;
  if(changes.sourceUnit!==undefined)next.sourceUnit=changes.sourceUnit;
  if(changes.resliceTransform===null)delete next.resliceTransform;else if(changes.resliceTransform!==undefined)next.resliceTransform=changes.resliceTransform;
  for(const key of COLLECTIONS){
    const values=new Map(before[key].map(item=>[item.id,item]));
    for(const id of changes.removals?.[key]||[])values.delete(id);
    for(const item of changes.upserts?.[key]||[])values.set(item.id,item);
    next[key]=[...values.values()];
  }
  return next;
}
/** Immutable binary resources are shared, while tool objects stay native. */
export class WorkbenchResources {
  private packed=new WeakMap<object,Promise<any>>();
  private loaded=new Map<string,Promise<unknown>>();
  readonly base:string;
  private author:string;
  private controller=new AbortController();
  constructor(project:string,author=''){this.base=WORKBENCH_BASE+'/'+project+'/resources/';this.author=author;}
  dispose(){this.controller.abort();}
  async pack(value:any):Promise<any>{
    if(value===null||typeof value!=='object')return value;
    if(ArrayBuffer.isView(value)){
      const old=this.packed.get(value);if(old)return old;
      const task=(async()=>{
        const kind=value instanceof Float32Array?'f32':value instanceof Uint32Array?'u32':value instanceof Uint8Array?'u8':null;
        if(!kind)throw new Error('协同资源数组类型不受支持。');
        const bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength),blob=new Blob([bytes as Uint8Array<ArrayBuffer>]);
        const id=kind+'-'+await fingerprint(blob),response=await authenticatedFetch(this.base+id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Workbench-Author':encodeURIComponent(this.author)},body:blob,signal:this.controller.signal});
        if(!response.ok)throw await responseError(response);
        const ref=await response.json();this.loaded.set(id,Promise.resolve(value));return{__workbenchResource:ref};
      })();this.packed.set(value,task);try{return await task;}catch(error){this.packed.delete(value);throw error;}
    }
    if(Array.isArray(value)){
      if(value.length>4096){
        const old=this.packed.get(value);if(old)return old;
        const task=(async()=>{const blob=new Blob([JSON.stringify(value)],{type:'application/json'}),id='json-'+await fingerprint(blob);
          const response=await authenticatedFetch(this.base+id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Workbench-Author':encodeURIComponent(this.author)},body:blob,signal:this.controller.signal});if(!response.ok)throw await responseError(response);
          const ref=await response.json();this.loaded.set(id,Promise.resolve(value));return{__workbenchResource:ref};})();this.packed.set(value,task);try{return await task;}catch(error){this.packed.delete(value);throw error;}
      }
      return Promise.all(value.map(item=>this.pack(item)));
    }
    const entries=await Promise.all(Object.entries(value).map(async([key,item])=>[key,await this.pack(item)] as const));return Object.fromEntries(entries);
  }
  async unpack(value:any):Promise<any>{
    if(value===null||typeof value!=='object')return value;
    if(value.__workbenchResource){
      const ref=value.__workbenchResource;
      if(!/^(f32|u32|u8|json)-[a-f0-9]{64}$/.test(ref.id))throw new Error('协同资源引用无效。');
      let loaded=this.loaded.get(ref.id);
      if(!loaded){loaded=(async()=>{
        const response=await authenticatedFetch(this.base+ref.id,{signal:this.controller.signal});if(!response.ok)throw await responseError(response);
        const bytes=await response.arrayBuffer();
        if(ref.kind==='json'){const result=JSON.parse(new TextDecoder().decode(bytes));this.packed.set(result,Promise.resolve({__workbenchResource:ref}));return result;}
        const result=ref.kind==='f32'?new Float32Array(bytes):ref.kind==='u32'?new Uint32Array(bytes):new Uint8Array(bytes);
        if(result.length!==ref.length)throw new Error('协同资源长度不一致。');this.packed.set(result,Promise.resolve({__workbenchResource:ref}));return result;
      })();this.loaded.set(ref.id,loaded);loaded.catch(()=>this.loaded.delete(ref.id));}
      return loaded;
    }
    if(Array.isArray(value))return Promise.all(value.map(item=>this.unpack(item)));
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await this.unpack(item)] as const)));
  }
  async manifest(state:ProjectState):Promise<Manifest>{
    const result=emptyManifest();result.name=state.name;if(state.resliceTransform!==undefined)result.resliceTransform=state.resliceTransform;
    for(const key of COLLECTIONS){
      result[key]=await Promise.all((state[key]||[]).map(async(item:any)=>{
        const plain=Object.fromEntries(Object.entries(item).filter(([name])=>!localField(name)&&!(key==='masks'&&name==='data')));
        return this.pack(plain);
      }));
    }
    return result;
  }
}
/** Decode bounded framed snapshots without concatenating the complete stream. */
export async function* maskSnapshotPackets(url:string,count:number,signal?:AbortSignal):AsyncGenerator<Uint8Array>{
  const response=await authenticatedFetch(url,{signal});if(!response.ok)throw await responseError(response);
  if(!response.body)throw new Error('共享标注响应没有数据。');
  const reader=response.body.getReader();let pending=new Uint8Array(0),length:number|null=null,terminated=false;
  try{
    while(!terminated){
      signal?.throwIfAborted();const{value,done}=await reader.read();
      if(done)break;
      const next=new Uint8Array(pending.length+value.length);next.set(pending);next.set(value,pending.length);pending=next;
      while(true){
        if(length===null){if(pending.length<4)break;length=new DataView(pending.buffer,pending.byteOffset,4).getUint32(0,true);pending=pending.subarray(4);if(length===0){terminated=true;break;}if(length>4*1024*1024)throw new Error('共享标注分块过大。');}
        if(pending.length<length)break;
        const packet=pending.subarray(0,length);readMaskRuns(packet,count);yield packet.slice();
        pending=pending.subarray(length);length=null;
      }
    }
    if(!terminated)throw new Error('共享标注流未完整接收。');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function nativeState(manifest:Manifest,masks:Map<string,Uint8Array>,resources:WorkbenchResources,previous:ProjectState):Promise<ProjectState>{
  const result:any={name:manifest.name,masks:[],parts:[],measurements:[],selectedMaskId:previous.selectedMaskId,selectedPartId:previous.selectedPartId};
  for(const key of COLLECTIONS){
    const old=new Map((previous[key]||[]).map((item:any)=>[item.id,item]));
    result[key]=await Promise.all(manifest[key].map(async item=>{
      const value=await resources.unpack(item),local=old.get(item.id) as any;
      if(key==='masks'){
        const data=masks.get(item.id);if(!data)throw new Error('共享 Mask 数据尚未准备好。');
        return{...value,data,visible:local?.visible??true,opacity:local?.opacity??.45} satisfies MaskObject;
      }
      return{...value,...(key==='resliceObjects'?{}:{visible:local?.visible??true}),...(key==='parts'?{opacity:local?.opacity??1}:{})};
    }));
  }
  if(manifest.resliceTransform!==undefined)result.resliceTransform=manifest.resliceTransform;
  if(previous.viewState)result.viewState=previous.viewState;
  for(const[key,collection]of [['selectedMaskId','masks'],['selectedPartId','parts'],['selectedCenterlineId','centerlines'],['selectedPolylineId','polylines'],['selectedResliceId','resliceObjects']]){
    const selected=(previous as any)[key];result[key]=result[collection].some((item:any)=>item.id===selected)?selected:result[collection][0]?.id||'';
  }
  return result;
}

export async function readMaskSnapshot(url:string,count:number,signal?:AbortSignal):Promise<Uint8Array>{const target=new Uint8Array(count);for await(const packet of maskSnapshotPackets(url,count,signal))await applyMaskPackets(target,[packet],signal);return target;}
