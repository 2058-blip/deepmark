import {levelRegion,partitionGray,regionOutline} from './grayRegions.ts';
import type {GrayMode,Partition,RegionOutline} from './grayRegions.ts';
type Request={type:'prepare';generation:number;width:number;height:number;data:ArrayBuffer;mode:GrayMode;bandWidth:number}|{type:'preview'|'select';generation:number;requestId:number;seed:number};
let data=new Float32Array(),width=0,height=0,generation=-1,mode:GrayMode='bands',partition:Partition|null=null;
const cache=new Map<string,{outline:RegionOutline;pixels:Uint32Array;seen?:Uint8Array;level?:number}>();
self.onmessage=(event:MessageEvent<Request>)=>{
  const request=event.data;
  try{
    if(request.type==='prepare'){
      generation=request.generation;width=request.width;height=request.height;data=new Float32Array(request.data);mode=request.mode;cache.clear();partition=mode==='bands'?partitionGray(data,width,height,request.bandWidth):null;
      const labels=partition?.labels.slice().buffer;self.postMessage({type:'ready',generation,labels},labels?{transfer:[labels]}:{});return;
    }
    if(request.generation!==generation||request.seed<0||request.seed>=data.length)return;
    let key:string,entry;
    if(partition){const id=partition.labels[request.seed];key=String(id);entry=cache.get(key);if(!entry){const pixels=partition.order.subarray(partition.offsets[id],partition.offsets[id+1]);entry={pixels,outline:regionOutline(data,width,height,pixels,i=>partition!.labels[i]===id)};}}
    else{
      for(const [candidate,value]of cache)if(value.level===data[request.seed]&&value.seen?.[request.seed]){key=candidate;entry=value;break;}
      if(!entry){const region=levelRegion(data,width,height,request.seed);key=`${region.level}:${request.seed}`;entry={pixels:region.pixels,seen:region.seen,level:region.level,outline:regionOutline(data,width,height,region.pixels,i=>!!region.seen[i])};}
    }
    cache.set(key!,entry);while(cache.size>12)cache.delete(cache.keys().next().value!);
    if(request.type==='select'){
      if(entry.outline.truncated){self.postMessage({type:'error',generation,requestId:request.requestId,message:'轮廓过于复杂，请增大灰度区间宽度。'});return;}
      const pixels=entry.pixels.slice();self.postMessage({type:'selected',generation,requestId:request.requestId,seed:request.seed,pixels:pixels.buffer},{transfer:[pixels.buffer]});
    }else self.postMessage({type:'preview',generation,requestId:request.requestId,seed:request.seed,regionId:key!,outline:entry.outline});
  }catch(reason){self.postMessage({type:'error',generation,requestId:'requestId' in request?request.requestId:undefined,message:(reason as Error).message});}
};
