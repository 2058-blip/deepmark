import type {VolumeGrid, BinaryMask, TriangleMesh, Vec3} from './types.ts';
export interface OperationRequest {kind:string;mask?:BinaryMask;other?:BinaryMask;seed?:Vec3;mesh?:TriangleMesh;options?:Record<string,unknown>}
function plainOptions(value:unknown):unknown{
  if(value===undefined||value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('参数必须是有限数。');return value;}
  if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer)return value;
  if(Array.isArray(value))return value.map(plainOptions);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plainOptions(v)]));
  throw new Error('计算参数类型无效。');
}
export class OperationClient {
  private worker:Worker|null=null;
  private grid:VolumeGrid|null=null;
  private serial=0;
  private pending:{id:number;resolve:(value:unknown)=>void;reject:(e:Error)=>void;progress?:(value:number)=>void}|null=null;
  initialize(grid:VolumeGrid){this.cancel();this.grid=grid;}
  private start(){
    if(!this.grid)return;
    this.worker=new Worker(new URL('./operations.worker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const p=this.pending;if(!p||data.id!==p.id)return;
      if(data.type==='progress')p.progress?.(data.fraction);
      else if(data.type==='result'){this.pending=null;p.resolve(data.result);}
      else if(data.type==='error'){this.pending=null;p.reject(new Error(data.message));}
    };
    this.worker.onerror=event=>{const p=this.pending;this.pending=null;p?.reject(new Error(event.message||'后台计算失败。'));this.worker?.terminate();this.worker=null;};
    this.worker.postMessage({type:'init',grid:this.grid});
  }
  run<T>(request:OperationRequest,progress?:(value:number)=>void):Promise<T>{
    if(this.pending)return Promise.reject(new Error('已有计算正在进行。'));
    if(!this.worker)this.start();if(!this.worker)return Promise.reject(new Error('请先加载影像。'));
    const id=++this.serial;
    return new Promise<T>((resolve,reject)=>{this.pending={id,resolve:value=>resolve(value as T),reject,progress};try{this.worker!.postMessage({...request,options:plainOptions(request.options),seed:request.seed?[...request.seed]:undefined,type:'run',id});}catch(e){this.pending=null;reject(e);}});
  }
  cancel(){this.worker?.terminate();this.worker=null;const p=this.pending;this.pending=null;p?.reject(new Error('计算已取消，原对象未更改。'));}
  dispose(){this.cancel();this.grid=null;}
}
