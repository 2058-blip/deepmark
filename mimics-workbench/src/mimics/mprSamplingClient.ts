import type {MprPlane,VolumeGrid} from './types.ts';
import {validateMprPlane,type MprMaskInput,type MprSlice,type MprSamplingOptions} from './mpr.ts';

export interface MprSamplingSource {grid:VolumeGrid;masks:readonly (MprMaskInput&{revision?:number})[];revision:number}
export type MprSamplerRequest=
  |{type:'init';epoch:number;grid:VolumeGrid;masks:MprMaskInput[]}
  |{type:'masks';epoch:number;masks:{id:string;data?:Uint8Array}[]}
  |{type:'sample';epoch:number;owner:number;id:number;plane:MprPlane;interpolation:'linear'|'nearest';options?:Pick<MprSamplingOptions,'maxPixels'|'maxBytes'>}
  |{type:'cancel';epoch:number;owner:number};
export type MprSamplerResponse=
  |{type:'ready';epoch:number}
  |{type:'result';epoch:number;owner:number;id:number;result:MprSlice}
  |{type:'error'|'cancelled';epoch:number;owner:number;id:number;message:string}
  |{type:'fatal';epoch:number;message:string};
export class MprSamplingCancelled extends Error {constructor(){super('MPR采样请求已取消或过期。');this.name='MprSamplingCancelled';}}
export function mprSourceGeometry(grid:VolumeGrid){return JSON.stringify([grid.dims,grid.spacing,grid.affine??null]);}
export function sameMprSamplingSource(a:MprSamplingSource,b:MprSamplingSource){return a.grid.data===b.grid.data&&mprSourceGeometry(a.grid)===mprSourceGeometry(b.grid)&&a.masks.length===b.masks.length&&a.masks.every((m,i)=>m.id===b.masks[i]?.id&&m.data===b.masks[i]?.data&&m.revision===b.masks[i]?.revision);}
const pools=new WeakMap<object,ResidentSampler>();let ownerSerial=0;
interface Pending {id:number;resolve:(slice:MprSlice)=>void;reject:(error:Error)=>void}

/** One worker and one resident source copy per live document, shared by all MPR panes. */
class ResidentSampler {
  worker:Worker|null=null;source:MprSamplingSource|null=null;epoch=0;failure='';
  private updating:Promise<void>|null=null;private residentSource:MprSamplingSource|null=null;
  owners=new Map<number,MprSamplingOwner>();pending=new Map<number,Pending>();
  readonly document:object;
  constructor(document:object){this.document=document;}
  rejectPending(owner:number,error:Error){const pending=this.pending.get(owner);this.pending.delete(owner);pending?.reject(error);}
  terminate(){this.updating=null;this.residentSource=null;this.worker?.terminate();this.worker=null;for(const owner of this.pending.keys())this.rejectPending(owner,new MprSamplingCancelled());}
  fail(message:string){this.failure=message;this.worker?.terminate();this.worker=null;for(const owner of this.pending.keys())this.rejectPending(owner,new Error(message));for(const owner of this.owners.values())owner.invalidated(message);}
  ensureSource(owner:number,source:MprSamplingSource,retry:boolean){
    if(!Number.isSafeInteger(source.revision)||source.revision<0)throw new Error('MPR采样源版本无效。');
    const equal=this.source&&sameMprSamplingSource(this.source,source);
    if(this.source&&!equal&&source.revision<this.source.revision)throw new MprSamplingCancelled();
    if(this.failure&&equal&&!retry)throw new Error(this.failure);
    if(this.worker&&equal){this.source={...this.source!,revision:Math.max(source.revision,this.source!.revision)};return this.updating||undefined;}
    if(this.worker&&this.source&&this.source.grid.data===source.grid.data&&mprSourceGeometry(this.source.grid)===mprSourceGeometry(source.grid)){
      const previous=this.residentSource||this.source,worker=this.worker;
      for(const id of this.pending.keys())this.rejectPending(id,new MprSamplingCancelled());
      for(const item of this.owners.values())if(item.id!==owner)item.invalidated();
      this.source={grid:{...source.grid,dims:[...source.grid.dims],spacing:[...source.grid.spacing],...(source.grid.affine?{affine:source.grid.affine.map(row=>[...row])}:{})},masks:source.masks.map(mask=>({...mask})),revision:source.revision};
      const epoch=++this.epoch,current=this.source;
      const stage=(async()=>{
        try{
          const masks:{id:string;data?:Uint8Array}[]=[];
          for(const mask of source.masks){
            const old=previous.masks.find(item=>item.id===mask.id);
            if(old?.data===mask.data&&old.revision===mask.revision){masks.push({id:mask.id});continue;}
            const data=new Uint8Array(mask.data.length);
            for(let offset=0;offset<data.length;offset+=4*1024*1024){
              if(this.worker!==worker||this.epoch!==epoch)throw new MprSamplingCancelled();
              data.set(mask.data.subarray(offset,Math.min(data.length,offset+4*1024*1024)),offset);
              if(data.length>4*1024*1024)await new Promise<void>(resolve=>setTimeout(resolve,0));
            }
            masks.push({id:mask.id,data});
          }
          if(this.worker!==worker||this.epoch!==epoch)throw new MprSamplingCancelled();
          worker.postMessage({type:'masks',epoch,masks} satisfies MprSamplerRequest,masks.flatMap(mask=>mask.data?[mask.data.buffer]:[]));
          this.residentSource=current;
        }catch(error){if(error instanceof MprSamplingCancelled)throw error;const message=error instanceof Error?error.message:'MPR Mask 更新失败。';if(this.worker===worker&&this.epoch===epoch)this.fail(message);throw new Error(message);}
      })();
      const readiness=stage.finally(()=>{if(this.updating===readiness)this.updating=null;});
      this.updating=readiness;return readiness;
    }
    this.terminate();for(const item of this.owners.values())if(item.id!==owner)item.invalidated();
    this.source={grid:{...source.grid,dims:[...source.grid.dims],spacing:[...source.grid.spacing],...(source.grid.affine?{affine:source.grid.affine.map(row=>[...row])}:{})},masks:source.masks.map(mask=>({...mask})),revision:source.revision};this.failure='';const epoch=++this.epoch;
    try{
      if(typeof Worker==='undefined')throw new Error('当前环境无法启动MPR后台Worker。');
      const worker=new Worker(new URL('./mprSampling.worker.ts',import.meta.url),{type:'module'});this.worker=worker;
      worker.onmessage=({data}:MessageEvent<MprSamplerResponse>)=>{
        if(this.worker!==worker||data.epoch!==this.epoch)return;
        if(data.type==='fatal'){this.fail(data.message);return;}
        if(data.type==='ready')return;
        const pending=this.pending.get(data.owner);if(!pending||pending.id!==data.id)return;
        this.pending.delete(data.owner);if(data.type==='result')pending.resolve(data.result);else pending.reject(data.type==='cancelled'?new MprSamplingCancelled():new Error(data.message));
      };
      worker.onerror=event=>{if(this.worker===worker)this.fail(event.message||'MPR后台采样失败。');};
      worker.onmessageerror=()=>{if(this.worker===worker)this.fail('MPR后台结果无法读取。');};
      // Transfer only newly owned copies. Neither the original image nor any Mask can detach.
      const grid={...this.source.grid,data:this.source.grid.data.slice()},masks=this.source.masks.map(mask=>({id:mask.id,data:mask.data.slice()}));
      const message:MprSamplerRequest={type:'init',epoch,grid,masks};worker.postMessage(message,[grid.data.buffer,...masks.map(mask=>mask.data.buffer)]);this.residentSource=this.source;
    }catch(error){const message=error instanceof Error?error.message:'无法启动MPR后台采样。';this.fail(message);throw new Error(message);}
  }
  request(owner:MprSamplingOwner,source:MprSamplingSource,plane:MprPlane,interpolation:'linear'|'nearest',retry:boolean,options?:Pick<MprSamplingOptions,'maxPixels'|'maxBytes'>):Promise<MprSlice>{
    try{
      const id=++owner.serial,p=validateMprPlane(plane),readiness=this.ensureSource(owner.id,source,retry),epoch=this.epoch;
      const dispatch=()=>{
        if(!this.worker||epoch!==this.epoch||owner.serial!==id)throw new MprSamplingCancelled();
        this.rejectPending(owner.id,new MprSamplingCancelled());
        return new Promise<MprSlice>((resolve,reject)=>{this.pending.set(owner.id,{id,resolve,reject});try{const message:MprSamplerRequest={type:'sample',epoch,owner:owner.id,id,plane:p,interpolation,options};this.worker!.postMessage(message);}catch(error){this.pending.delete(owner.id);reject(error instanceof Error?error:new Error(String(error)));}});
      };
      return readiness?readiness.then(dispatch):dispatch();
    }catch(error){return Promise.reject(error);}
  }
  cancel(owner:number){const item=this.owners.get(owner);if(item)item.serial++;this.rejectPending(owner,new MprSamplingCancelled());if(this.worker){const message:MprSamplerRequest={type:'cancel',epoch:this.epoch,owner};this.worker.postMessage(message);}}
  remove(owner:number){this.cancel(owner);this.owners.delete(owner);if(!this.owners.size){this.terminate();pools.delete(this.document);}}
}

export class MprSamplingOwner {
  readonly id=++ownerSerial;serial=0;private disposed=false;
  private resident:ResidentSampler;readonly invalidated:(message?:string)=>void;
  constructor(resident:ResidentSampler,invalidated:(message?:string)=>void){this.resident=resident;this.invalidated=invalidated;resident.owners.set(this.id,this);}
  request(source:MprSamplingSource,plane:MprPlane,interpolation:'linear'|'nearest'='linear',retry=false,options?:Pick<MprSamplingOptions,'maxPixels'|'maxBytes'>){if(this.disposed)return Promise.reject(new MprSamplingCancelled());return this.resident.request(this,source,plane,interpolation,retry,options);}
  cancel(){if(!this.disposed)this.resident.cancel(this.id);}
  dispose(){if(this.disposed)return;this.disposed=true;this.resident.remove(this.id);}
}
export function acquireMprSamplingOwner(document:object,invalidated:(message?:string)=>void=()=>{}):MprSamplingOwner{
  let resident=pools.get(document);if(!resident){resident=new ResidentSampler(document);pools.set(document,resident);}return new MprSamplingOwner(resident,invalidated);
}
