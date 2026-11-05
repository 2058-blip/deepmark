/** Private cache encoding. Project ZIP/NIfTI formats and editor arrays stay unchanged. */
export const WORKSPACE_CHUNK_BYTES=16*1024*1024;
const INLINE_BYTES=64*1024;
type NumericArray=Uint8Array|Float32Array|Uint32Array;
export interface WorkspaceBinaryRef {
  __deepmarkBinary:'chunks-v1';owner:string;prefix:string;kind:'u8'|'f32'|'u32';length:number;keys:string[];
}
export interface PendingWorkspaceBinary {ref:WorkspaceBinaryRef;data:NumericArray}
function reference(value:unknown):value is WorkspaceBinaryRef {
  return !!value&&typeof value==='object'&&(value as WorkspaceBinaryRef).__deepmarkBinary==='chunks-v1';
}
function width(ref:WorkspaceBinaryRef){return ref.kind==='u8'?1:4;}
function validate(ref:WorkspaceBinaryRef,owner:string){
  if(ref.owner!==owner||!['u8','f32','u32'].includes(ref.kind)||!Number.isSafeInteger(ref.length)||ref.length<0
    ||!Number.isSafeInteger(ref.length*width(ref))||typeof ref.prefix!=='string'||!Array.isArray(ref.keys)
    ||ref.keys.length!==Math.ceil(ref.length*width(ref)/WORKSPACE_CHUNK_BYTES)
    ||ref.keys.some((key,i)=>key!==ref.prefix+':'+i))throw new Error('本地工程数据块引用无效。');
}
export function workspaceBinaryKeys(value:unknown):string[]{
  const keys=new Set<string>();
  const walk=(item:unknown)=>{
    if(!item||typeof item!=='object'||ArrayBuffer.isView(item))return;
    if(reference(item)){for(const key of item.keys)keys.add(key);return;}
    for(const child of Object.values(item))walk(child);
  };
  walk(value);return [...keys];
}
export class WorkspaceBinaryCodec {
  private arrays=new WeakMap<NumericArray,Map<string,WorkspaceBinaryRef>>();
  pack(value:unknown,owner:string,reusable:Set<string>=new Set()):{value:any;pending:PendingWorkspaceBinary[]}{
    const pending=new Map<string,PendingWorkspaceBinary>(),seen=new Set<object>();
    const walk=(item:any):any=>{
      if(item===null||typeof item!=='object')return item;
      if(ArrayBuffer.isView(item)){
        if(!(item instanceof Uint8Array||item instanceof Float32Array||item instanceof Uint32Array))throw new Error('本地工程包含不支持的数组类型。');
        // A short subview may still own a huge backing store: clone only its view.
        if(item.byteLength<=INLINE_BYTES)return item.slice();
        let owners=this.arrays.get(item);if(!owners){owners=new Map();this.arrays.set(item,owners);}
        let ref=owners.get(owner);
        if(!ref||!reusable.has(ref.prefix)&&!pending.has(ref.prefix)){
          const random=globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
          const prefix=owner+':'+random;
          ref={__deepmarkBinary:'chunks-v1',owner,prefix,kind:item instanceof Float32Array?'f32':item instanceof Uint32Array?'u32':'u8',length:item.length,
            keys:Array.from({length:Math.ceil(item.byteLength/WORKSPACE_CHUNK_BYTES)},(_,i)=>prefix+':'+i)};
          owners.set(owner,ref);pending.set(prefix,{ref,data:item});
        }
        return ref;
      }
      if(seen.has(item))throw new Error('本地工程包含循环元数据。');
      seen.add(item);
      const result=Array.isArray(item)?item.map(walk):Object.fromEntries(Object.entries(item).map(([key,child])=>[key,walk(child)]));
      seen.delete(item);return result;
    };
    return {value:walk(value),pending:[...pending.values()]};
  }
  async hydrate(value:unknown,owner:string,read:(key:string)=>Promise<Uint8Array>):Promise<any>{
    const loaded=new Map<string,NumericArray>();
    const walk=async(item:any):Promise<any>=>{
      if(item===null||typeof item!=='object'||ArrayBuffer.isView(item))return item;
      if(reference(item)){
        validate(item,owner);const cached=loaded.get(item.prefix);if(cached)return cached;
        let result:NumericArray;
        try{result=item.kind==='u8'?new Uint8Array(item.length):item.kind==='f32'?new Float32Array(item.length):new Uint32Array(item.length);}
        catch{throw new Error('可用内存不足，无法恢复本地工程数组。');}
        const bytes=new Uint8Array(result.buffer);
        for(let i=0;i<item.keys.length;i++){
          const chunk=await read(item.keys[i]!),expected=Math.min(WORKSPACE_CHUNK_BYTES,bytes.length-i*WORKSPACE_CHUNK_BYTES);
          if(!(chunk instanceof Uint8Array)||chunk.byteLength!==expected)throw new Error('本地工程数据块缺失或长度不一致。');
          bytes.set(chunk,i*WORKSPACE_CHUNK_BYTES);
        }
        let owners=this.arrays.get(result);if(!owners){owners=new Map();this.arrays.set(result,owners);}
        owners.set(owner,item);loaded.set(item.prefix,result);return result;
      }
      if(Array.isArray(item)){const result=[];for(const child of item)result.push(await walk(child));return result;}
      const result:Record<string,unknown>={};
      for(const [key,child] of Object.entries(item))result[key]=await walk(child);
      return result;
    };
    return walk(value);
  }
}
