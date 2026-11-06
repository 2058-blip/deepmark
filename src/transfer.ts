export type TransferProgress={loaded:number;total:number|null;percent:number|null;complete?:boolean};
export type TransferOptions={signal?:AbortSignal;onProgress?:(progress:TransferProgress)=>void};
const TRANSFER_BLOB_SEGMENT_BYTES=8*1024*1024;

export function transferAborted(){return new DOMException('传输已取消。','AbortError');}
export function isTransferAborted(reason:unknown){return reason instanceof Error&&reason.name==='AbortError';}
export function transferProgress(loaded:number,total:number|null,complete=false):TransferProgress{
  const known=total!==null&&Number.isFinite(total)&&total>0&&loaded<=total?total:null;
  return {loaded,total:known,percent:known===null?null:Math.min(100,Math.floor(loaded/known*100)),complete};
}

/** Fetch decodes content encodings before yielding chunks, so only identity lengths are comparable. */
export async function readTransferBlob(response:Response,options:TransferOptions={}):Promise<Blob>{
  const {signal,onProgress}=options;
  if(signal?.aborted)throw transferAborted();
  const encoded=response.headers.get('content-encoding'),length=response.headers.get('content-length');
  let total=(!encoded||encoded.toLowerCase()==='identity')&&length!==null&&/^\d+$/.test(length)?Number(length):null;
  if(total!==null&&(!Number.isSafeInteger(total)||total<=0))total=null;
  let loaded=0;
  onProgress?.(transferProgress(loaded,total));
  if(!response.body){
    const blob=await response.blob();if(signal?.aborted)throw transferAborted();
    onProgress?.(transferProgress(blob.size,total===blob.size?total:null,true));return blob;
  }
  // Blob construction copies typed-array bytes. Seal bounded windows as we read,
  // then assemble only Blob references, instead of retaining the complete byte
  // stream and duplicating it at the end of a large CT download.
  const reader=response.body.getReader(),segments:Blob[]=[],chunks:Uint8Array<ArrayBuffer>[]=[];
  let segmentBytes=0,completed=false;
  const seal=()=>{if(segmentBytes){segments.push(new Blob(chunks));chunks.length=0;segmentBytes=0;}};
  const abort=()=>{void reader.cancel(transferAborted()).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw transferAborted();
    for(;;){
      const {done,value}=await reader.read();
      if(signal?.aborted)throw transferAborted();
      if(done)break;
      loaded+=value.byteLength;
      for(let start=0;start<value.byteLength;){
        const end=Math.min(value.byteLength,start+TRANSFER_BLOB_SEGMENT_BYTES-segmentBytes);
        chunks.push(value.subarray(start,end) as Uint8Array<ArrayBuffer>);segmentBytes+=end-start;start=end;
        if(segmentBytes===TRANSFER_BLOB_SEGMENT_BYTES)seal();
      }
      if(total!==null&&loaded>total)total=null;
      onProgress?.(transferProgress(loaded,total));
    }
    if(total!==null&&loaded!==total)total=null;
    if(signal?.aborted)throw transferAborted();seal();
    const blob=new Blob(segments,{type:response.headers.get('content-type')||'application/octet-stream'});
    completed=true;onProgress?.(transferProgress(loaded,total,true));return blob;
  }finally{
    signal?.removeEventListener('abort',abort);
    if(!completed)await reader.cancel().catch(()=>{});
    chunks.length=0;segments.length=0;reader.releaseLock();
  }
}
