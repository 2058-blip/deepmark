import {parseNifti,parseNiftiHeader,readNiftiValues} from './core.ts';
import type {NiftiLayout,Volume} from './core.ts';
import {allocateVolumeData} from './volumeCapacity.ts';

export interface NiftiReadProgress {fraction:number;loadedVoxels:number;totalVoxels:number;stage:string}
export interface NiftiReadOptions {signal?:AbortSignal;onProgress?:(progress:NiftiReadProgress)=>void}

/** Keep only a 352-byte header, a partial scalar, and the final Float32 volume.
 * Gzip output is consumed incrementally rather than concatenated into another
 * whole decompressed image. Chunk boundaries need not align to pixels. */
export class NiftiStreamDecoder {
  private header=new Uint8Array(352);
  private headerLength=0;
  private carry=new Uint8Array(8);
  private carryLength=0;
  private layout:NiftiLayout|null=null;
  private data:Float32Array|null=null;
  private decodedBytes=0;
  private written=0;
  private min=Infinity;
  private max=-Infinity;
  private name:string;
  private totalBytes?:number;
  constructor(name:string,totalBytes?:number){this.name=name;this.totalBytes=totalBytes;}
  get progress():NiftiReadProgress {
    const count=this.layout?.count||0,fraction=count?this.written/count:0;
    return {fraction,loadedVoxels:this.written,totalVoxels:count,stage:count?'正在读取影像 · '+Math.floor(fraction*100)+'%':'正在读取影像头信息'};
  }
  private values(view:DataView,count:number) {
    const range=readNiftiValues(view,this.layout!,this.data!,this.written,count);
    this.written+=count;this.min=Math.min(this.min,range.min);this.max=Math.max(this.max,range.max);
  }
  push(chunk:Uint8Array) {
    const beginning=this.decodedBytes;this.decodedBytes+=chunk.byteLength;
    if(!this.layout){
      const length=Math.min(this.header.length-this.headerLength,chunk.length);
      this.header.set(chunk.subarray(0,length),this.headerLength);this.headerLength+=length;
      if(this.headerLength<this.header.length)return;
      this.layout=parseNiftiHeader(this.header.buffer,this.name,this.totalBytes);
      this.data=allocateVolumeData(this.layout.count);
    }
    const {offset,bytes,count}=this.layout;
    let start=Math.max(0,offset-beginning);
    if(start>=chunk.length||this.written===count)return;
    const end=start+Math.min(chunk.length-start,(count-this.written)*bytes-this.carryLength);
    if(this.carryLength){
      const length=Math.min(bytes-this.carryLength,end-start);
      this.carry.set(chunk.subarray(start,start+length),this.carryLength);this.carryLength+=length;start+=length;
      if(this.carryLength<bytes)return;
      this.values(new DataView(this.carry.buffer,0,bytes),1);this.carryLength=0;
    }
    const whole=Math.floor((end-start)/bytes);
    if(whole){this.values(new DataView(chunk.buffer,chunk.byteOffset+start,whole*bytes),whole);start+=whole*bytes;}
    if(start<end){this.carryLength=end-start;this.carry.set(chunk.subarray(start,end));}
  }
  finish():Volume {
    if(!this.layout||!this.data)throw new Error('文件过短，不是完整的 NIfTI-1 文件。');
    if(this.written!==this.layout.count||this.carryLength)throw new Error('影像数据不完整或数据偏移无效。');
    return {...this.layout.volume,data:this.data,min:this.min,max:this.max};
  }
}

export async function decodeNiftiStream(stream:ReadableStream<Uint8Array>,name:string,options:NiftiReadOptions={},totalBytes?:number):Promise<Volume>{
  const decoder=new NiftiStreamDecoder(name,totalBytes),reader=stream.getReader();
  let lastProgress=0,lastYield=Date.now();
  const abort=()=>{void reader.cancel(options.signal?.reason).catch(()=>{});};
  try{
    options.signal?.throwIfAborted();options.signal?.addEventListener('abort',abort,{once:true});
    while(true){
      options.signal?.throwIfAborted();
      const {value,done}=await reader.read();options.signal?.throwIfAborted();
      if(done)break;
      decoder.push(value);
      const now=Date.now();
      if(now-lastProgress>=80){options.onProgress?.(decoder.progress);lastProgress=now;}
      if(now-lastYield>=16){await new Promise<void>(resolve=>setTimeout(resolve,0));lastYield=Date.now();}
    }
    const volume=decoder.finish();options.onProgress?.(decoder.progress);return volume;
  }catch(error){await reader.cancel(error).catch(()=>{});throw error;}
  finally{options.signal?.removeEventListener('abort',abort);reader.releaseLock();}
}

export async function readNiftiFile(file:File,options:NiftiReadOptions={}):Promise<Volume>{
  options.signal?.throwIfAborted();
  // Legacy adapters may provide only arrayBuffer. Real browser Files take the
  // streaming path and never call arrayBuffer() on the entire file.
  if(typeof file.stream!=='function'||typeof file.slice!=='function'){
    const buffer=await file.arrayBuffer();options.signal?.throwIfAborted();
    const signature=new Uint8Array(buffer,0,Math.min(2,buffer.byteLength));
    if(signature[0]!==31||signature[1]!==139)return parseNifti(buffer,file.name);
    if(typeof DecompressionStream==='undefined')throw new Error('此浏览器不支持 gzip 解压，请使用新版 Chrome/Edge，或先解压为 .nii。');
    return decodeNiftiStream(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),file.name,options);
  }
  const signature=new Uint8Array(await file.slice(0,2).arrayBuffer());options.signal?.throwIfAborted();
  const compressed=signature[0]===31&&signature[1]===139;
  let stream=file.stream();
  if(compressed){
    if(typeof DecompressionStream==='undefined')throw new Error('此浏览器不支持 gzip 解压，请使用新版 Chrome/Edge，或先解压为 .nii。');
    stream=stream.pipeThrough(new DecompressionStream('gzip'));
  }
  return decodeNiftiStream(stream,file.name,options,compressed?undefined:file.size);
}
