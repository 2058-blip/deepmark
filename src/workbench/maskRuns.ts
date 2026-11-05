/** Transport only. Native independent binary Masks and their editing kernels
 * remain unchanged; each packet belongs to one stable Mask id. */
export interface MaskRun {start:number;length:number;before:0|1;after:0|1}
export interface VoxelBounds {min:[number,number,number];max:[number,number,number]}
export const MASK_RUN_MAGIC=0x31574244; // DBW1, little endian
export const MASK_RUN_HEADER_BYTES=12;
export const MASK_RUN_BYTES=12;
export const MASK_PACKET_BYTES=256*1024;
export function readMaskRuns(bytes:Uint8Array,count:number):MaskRun[]{
  if(!Number.isSafeInteger(count)||count<1||count>0xffffffff||bytes.byteLength<MASK_RUN_HEADER_BYTES)throw new Error('标注操作头无效。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),records=view.getUint32(8,true);
  if(view.getUint32(0,true)!==MASK_RUN_MAGIC||view.getUint32(4,true)!==MASK_RUN_BYTES||bytes.byteLength!==MASK_RUN_HEADER_BYTES+records*MASK_RUN_BYTES)
    throw new Error('标注操作格式或长度无效。');
  const result:MaskRun[]=[];let end=0;
  for(let i=0;i<records;i++){
    const offset=MASK_RUN_HEADER_BYTES+i*MASK_RUN_BYTES,start=view.getUint32(offset,true),length=view.getUint32(offset+4,true),flags=view.getUint32(offset+8,true);
    if(!length||start<end||start+length>count||(flags!==1&&flags!==2))throw new Error('标注操作包含重叠、越界或无效体素。');
    result.push({start,length,before:(flags&1) as 0|1,after:((flags>>>1)&1) as 0|1});end=start+length;
  }
  return result;
}
function packet(runs:MaskRun[]):Uint8Array{
  const bytes=new Uint8Array(MASK_RUN_HEADER_BYTES+runs.length*MASK_RUN_BYTES),view=new DataView(bytes.buffer);
  view.setUint32(0,MASK_RUN_MAGIC,true);view.setUint32(4,MASK_RUN_BYTES,true);view.setUint32(8,runs.length,true);
  runs.forEach((run,i)=>{const offset=MASK_RUN_HEADER_BYTES+i*MASK_RUN_BYTES;view.setUint32(offset,run.start,true);view.setUint32(offset+4,run.length,true);view.setUint32(offset+8,run.before|(run.after<<1),true);});
  return bytes;
}
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
/** Compare semantic changes, independent of server/client packet boundaries. */
export function sameMaskPackets(a:Uint8Array[],b:Uint8Array[],count:number):boolean{
  function* runs(packets:Uint8Array[]){for(const packet of packets)yield* readMaskRuns(packet,count);}
  const left=runs(a),right=runs(b);let x=left.next(),y=right.next(),usedX=0,usedY=0;
  while(!x.done&&!y.done){
    if(x.value.start+usedX!==y.value.start+usedY||x.value.before!==y.value.before||x.value.after!==y.value.after)return false;
    const n=Math.min(x.value.length-usedX,y.value.length-usedY);usedX+=n;usedY+=n;
    if(usedX===x.value.length){x=left.next();usedX=0;}if(usedY===y.value.length){y=right.next();usedY=0;}
  }
  return !!x.done&&!!y.done;
}
/** Bounds are a hint only for a proven native brush clone. Other operations scan
 * cooperatively, including growth, Boolean operations, undo and imported Masks. */
export async function* diffMaskPackets(before:Uint8Array|null,after:Uint8Array,dims:readonly number[],
  options:{bounds?:VoxelBounds;signal?:AbortSignal;maxPacketBytes?:number;budgetMs?:number}={}):AsyncGenerator<Uint8Array>{
  const count=dims.reduce((a,b)=>a*b,1);
  if(dims.length!==3||dims.some(n=>!Number.isSafeInteger(n)||n<1)||!Number.isSafeInteger(count)||count>0xffffffff||before&&before.length!==count||after.length!==count)
    throw new Error('协同 Mask 尺寸无效。');
  if(before===after)return;
  const maxBytes=options.maxPacketBytes??MASK_PACKET_BYTES,limit=Math.floor((maxBytes-MASK_RUN_HEADER_BYTES)/MASK_RUN_BYTES);
  if(!Number.isSafeInteger(maxBytes)||limit<1||maxBytes>4*1024*1024)throw new Error('协同操作分块大小无效。');
  const bounds=options.bounds??{min:[0,0,0],max:dims.map(n=>n-1)};
  if(bounds.min.length!==3||bounds.max.length!==3||bounds.min.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>bounds.max[i]!||bounds.max[i]!>=dims[i]!)||bounds.max.some(n=>!Number.isSafeInteger(n)))
    throw new Error('协同笔画范围无效。');
  let runs:MaskRun[]=[],current:MaskRun|null=null,visits=0,lastYield=performance.now();
  for(let z=bounds.min[2]!;z<=bounds.max[2]!;z++)for(let y=bounds.min[1]!;y<=bounds.max[1]!;y++)for(let x=bounds.min[0]!;x<=bounds.max[0]!;x++){
    const i=x+dims[0]!*(y+dims[1]!*z),a=before?.[i]??0,b=after[i]!;
    if(a>1||b>1)throw new Error('协同 Mask 必须保持独立二值成员。');
    if(a!==b){
      if(current&&current.start+current.length===i&&current.before===a&&current.after===b)current.length++;
      else{if(current)runs.push(current);current={start:i,length:1,before:a as 0|1,after:b as 0|1};}
    }else if(current){runs.push(current);current=null;}
    if(runs.length>=limit){yield packet(runs);runs=[];}
    if((++visits&16383)===0){
      options.signal?.throwIfAborted();
      if(performance.now()-lastYield>=(options.budgetMs??3)){await pause();lastYield=performance.now();}
    }
  }
  options.signal?.throwIfAborted();if(current)runs.push(current);
  if(runs.length)yield packet(runs);
}
/** Applied to an owned copy, never to an editor/history/source array. */
export async function applyMaskPackets(target:Uint8Array,packets:Iterable<Uint8Array>,signal?:AbortSignal):Promise<void>{
  let previousEnd=0,lastYield=performance.now();
  for(const bytes of packets)for(const run of readMaskRuns(bytes,target.length)){
    if(run.start<previousEnd)throw new Error('标注分块顺序或范围无效。');previousEnd=run.start+run.length;
    for(let start=run.start;start<previousEnd;start+=1024*1024){
      signal?.throwIfAborted();target.fill(run.after,start,Math.min(start+1024*1024,previousEnd));
      if(performance.now()-lastYield>=3){await pause();lastYield=performance.now();}
    }
  }
}
