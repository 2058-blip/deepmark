import {readMaskRuns} from './maskRuns.ts';
function popcount(x:number){x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return(((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24;}
function trailing(x:number){return x?31-Math.clz32(x&-x):32;}
/** Sparse 32K-voxel pages: a small brush does not allocate a volume-sized owner map. */
export class ClaimBits {
  private pages=new Map<number,{words:Uint32Array;count:number}>();
  count=0;
  has(index:number){return !!(this.pages.get(index>>>15)?.words[(index&32767)>>>5]!&(1<<(index&31)));}
  intersects(start:number,end:number){
    if(!this.count)return false;
    for(const[id,page]of this.pages){
      const first=Math.max(start,id*32768),last=Math.min(end,(id+1)*32768);if(first>=last)continue;
      for(let i=first;i<last;){
        const base=Math.floor(i/32)*32,next=Math.min(last,base+32),mask=(0xffffffff<<(i-base))&(0xffffffff>>>(32-(next-base)));
        if(page.words[(i&32767)>>>5]!&mask)return true;i=next;
      }
    }
    return false;
  }
  set(start:number,length:number,value:boolean){
    const end=start+length;
    for(let i=start;i<end;){
      const pageId=i>>>15,word=(i&32767)>>>5,base=Math.floor(i/32)*32,next=Math.min(end,base+32),lo=i-base,hi=next-base;
      let page=this.pages.get(pageId);
      if(!page){if(!value){i=next;continue;}page={words:new Uint32Array(1024),count:0};this.pages.set(pageId,page);}
      const mask=(0xffffffff<<lo)&(0xffffffff>>>(32-hi)),before=page.words[word]!,after=value?(before|mask)>>>0:(before&~mask)>>>0;
      const delta=popcount(after)-popcount(before);page.words[word]=after;page.count+=delta;this.count+=delta;
      if(!page.count)this.pages.delete(pageId);i=next;
    }
  }
  apply(packet:Uint8Array,count:number){for(const run of readMaskRuns(packet,count))this.set(run.start,run.length,!!run.after);}
  ranges(visit:(start:number,end:number)=>void){
    let pending=-1,end=-1;
    for(const id of [...this.pages.keys()].sort((a,b)=>a-b)){
      const page=this.pages.get(id)!;
      for(let i=0;i<page.words.length;i++){
        let word=page.words[i]!;
        while(word){
          const lo=trailing(word),shifted=word>>>lo,len=Math.min(32-lo,trailing(~shifted)),start=id*32768+i*32+lo,next=start+len;
          if(pending>=0&&start===end)end=next;else{if(pending>=0)visit(pending,end);pending=start;end=next;}
          const hi=lo+len;word=(word&~((0xffffffff<<lo)&(0xffffffff>>>(32-hi))))>>>0;
        }
      }
    }
    if(pending>=0)visit(pending,end);
  }
}
export class WorkbenchClaims {
  private masks=new Map<string,Map<string,ClaimBits>>();
  private bits(mask:string,author:string){let authors=this.masks.get(mask);if(!authors){authors=new Map();this.masks.set(mask,authors);}let bits=authors.get(author);if(!bits){bits=new ClaimBits();authors.set(author,bits);}return bits;}
  apply(mask:string,author:string,packet:Uint8Array,count:number){this.bits(mask,author).apply(packet,count);}
  authorsAt(mask:string,index:number){return[...this.masks.get(mask)||[]].filter(([,bits])=>bits.has(index)).map(([author])=>author);}
  foreignAt(mask:string,user:string,index:number){for(const[author,bits]of this.masks.get(mask)||[])if(author!==user&&bits.has(index))return true;return false;}
  hasForeign(mask:string,user:string){for(const[author,bits]of this.masks.get(mask)||[])if(author!==user&&bits.count)return true;return false;}
  foreignIntersects(mask:string,user:string,start:number,end:number){for(const[author,bits]of this.masks.get(mask)||[])if(author!==user&&bits.intersects(start,end))return true;return false;}
  protect(mask:string,user:string,target:Uint8Array){for(const[author,bits]of this.masks.get(mask)||[])if(author!==user)bits.ranges((start,end)=>target.fill(1,start,end));}
  remove(mask:string){this.masks.delete(mask);}
}
