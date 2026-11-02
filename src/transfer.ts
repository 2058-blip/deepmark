export type TransferProgress={loaded:number;total:number|null;percent:number|null;complete?:boolean};
export type TransferOptions={signal?:AbortSignal;onProgress?:(progress:TransferProgress)=>void};

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
  const reader=response.body.getReader(),chunks:BlobPart[]=[];
  const abort=()=>{void reader.cancel(transferAborted()).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw transferAborted();
    for(;;){
      const {done,value}=await reader.read();
      if(signal?.aborted)throw transferAborted();
      if(done)break;
      loaded+=value.byteLength;chunks.push(value as Uint8Array<ArrayBuffer>);
      if(total!==null&&loaded>total)total=null;
      onProgress?.(transferProgress(loaded,total));
    }
    if(total!==null&&loaded!==total)total=null;
    onProgress?.(transferProgress(loaded,total,true));
    return new Blob(chunks,{type:response.headers.get('content-type')||'application/octet-stream'});
  }finally{
    signal?.removeEventListener('abort',abort);reader.releaseLock();
  }
}
