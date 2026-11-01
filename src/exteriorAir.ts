import type {Axis,Volume} from './core.ts';
import {extractSlice,sliceLayout} from './sliceData.ts';
// Eight-connected air touching a 2D slice edge is outside. Enclosed lung air stays editable.
export function exteriorAir(data:Float32Array,width:number,height:number,threshold=-900):Uint8Array{
  if(!Number.isInteger(width)||!Number.isInteger(height)||data.length!==width*height||width<1||height<1||!Number.isFinite(threshold))throw new Error('空气排除参数无效。');
  const excluded=new Uint8Array(data.length),queue=new Uint32Array(data.length);let head=0,tail=0;
  const add=(i:number)=>{if(!excluded[i]&&data[i]<=threshold){excluded[i]=1;queue[tail++]=i;}};
  for(let x=0;x<width;x++){add(x);add(x+(height-1)*width);}for(let y=1;y<height-1;y++){add(y*width);add(y*width+width-1);}
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<width&&yy>=0&&yy<height)add(xx+yy*width);}}
  return excluded;
}
export class ExteriorAirCache{
  private slices=new Map<string,Uint8Array>();
  private axialBits=new Map<number,Uint8Array>();
  private volume:Volume;private threshold:number;
  constructor(volume:Volume,threshold=-900){this.volume=volume;this.threshold=threshold;}
  slice(axis:Axis,slice:number){const key=`${axis}:${slice}`,old=this.slices.get(key);if(old){this.slices.delete(key);this.slices.set(key,old);return old;}const l=sliceLayout(this.volume,axis,slice),result=exteriorAir(extractSlice(this.volume,axis,slice),l.width,l.height,this.threshold);this.slices.set(key,result);while(this.slices.size>12)this.slices.delete(this.slices.keys().next().value!);return result;}
  voxel(index:number){
    if(this.volume.data[index]>this.threshold)return false;
    const [nx,ny]=this.volume.dims,plane=nx*ny,z=Math.floor(index/plane),offset=index-z*plane;
    let bits=this.axialBits.get(z);
    if(!bits){const excluded=this.slice(2,z);bits=new Uint8Array(Math.ceil(plane/8));for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const i=x+y*nx;if(excluded[x+(ny-1-y)*nx])bits[i>>>3]|=1<<(i&7);}this.axialBits.set(z,bits);}
    return !!(bits[offset>>>3]&(1<<(offset&7)));
  }
}
