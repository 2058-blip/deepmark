import type {Volume} from '../core.ts';
import {planeAxes} from '../core.ts';
import type {Axis,MaskObject,Vec3} from './types.ts';
export interface DraftBounds {min:Vec3;max:Vec3}
export interface SlicePixelInput {
  volume:Volume;axis:Axis;slice:number;masks:MaskObject[];revision:number;center:number;width:number;
  displayInverted?:boolean;preview?:Uint8Array|null;temporarySelection?:Uint8Array|null;previewReplacesActive?:boolean;
  draft?:Uint8Array|null;draftRevision?:number;draftBounds?:DraftBounds|null;activeMaskId:string;
}
export interface PixelRect {x:number;y:number;width:number;height:number}
const changed=(a:unknown[],b:unknown[])=>a.length!==b.length||a.some((value,i)=>value!==b[i]);
/** Exact original blend order, with a cached floating-point grey slice and
 * bounded repaint of the current stroke. Cursor/camera movement does no voxel work. */
export class SlicePixels {
  pixels:Uint8ClampedArray=new Uint8ClampedArray(0);
  width=0;height=0;
  private grey=new Float64Array(0);
  private greyKey:unknown[]=[];
  private maskKey:unknown[]=[];
  private previousDraft:Uint8Array|null|undefined;
  private previousStamp:number|undefined;
  render(input:SlicePixelInput,target?:Uint8ClampedArray):PixelRect|null {
    const {volume,axis,slice}=input,[a,b]=planeAxes(axis),nx=volume.dims[a],ny=volume.dims[b];
    const strides=[1,volume.dims[0],volume.dims[0]*volume.dims[1]],sa=strides[a]!,sb=strides[b]!,base=slice*strides[axis]!;
    const greyKey=[volume,volume.data,axis,slice,nx,ny,input.center,input.width,input.displayInverted];
    const refreshGrey=changed(greyKey,this.greyKey);
    if(this.width!==nx||this.height!==ny||target&&target!==this.pixels){
      this.width=nx;this.height=ny;this.pixels=target||new Uint8ClampedArray(nx*ny*4);this.grey=new Float64Array(nx*ny);
      this.maskKey=[];
    }
    if(refreshGrey){
      for(let y=0;y<ny;y++){
        const row=base+(ny-1-y)*sb;
        for(let x=0;x<nx;x++){
          let value=Math.max(0,Math.min(255,(volume.data[row+x*sa]!-input.center+input.width/2)/Math.max(1,input.width)*255));
          if(input.displayInverted)value=255-value;
          this.grey[x+y*nx]=value;
        }
      }
      this.greyKey=greyKey;
    }
    const maskKey:unknown[]=[input.revision,input.activeMaskId,input.preview,input.temporarySelection,input.previewReplacesActive,
      !input.draft&&input.temporarySelection?input.draftRevision:null];
    for(const mask of input.masks)maskKey.push(mask.id,mask.data,mask.visible,mask.color,mask.opacity);
    let rect:PixelRect|null={x:0,y:0,width:nx,height:ny};
    const newMasks=refreshGrey||changed(maskKey,this.maskKey),newDraft=input.draft!==this.previousDraft;
    if(!newMasks&&!newDraft){
      if(input.draftRevision===this.previousStamp)return null;
      if(input.draft&&input.draftBounds){
        const {min,max}=input.draftBounds;
        if(slice<min[axis]||slice>max[axis])rect=null;
        else{
          const x0=Math.max(0,min[a]),x1=Math.min(nx-1,max[a]),y0=Math.max(0,ny-1-max[b]),y1=Math.min(ny-1,ny-1-min[b]);
          rect=x0<=x1&&y0<=y1?{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1}:null;
        }
      }
    }
    this.maskKey=maskKey;this.previousDraft=input.draft;this.previousStamp=input.draftRevision;
    if(!rect)return null;
    const masks=input.masks.filter(mask=>mask.visible).map(mask=>({
      data:mask.id===input.activeMaskId&&input.draft?input.draft:mask.data,
      skip:!!input.preview&&input.previewReplacesActive&&mask.id===input.activeMaskId,
      alpha:mask.opacity,r:parseInt(mask.color.slice(1,3),16),g:parseInt(mask.color.slice(3,5),16),b:parseInt(mask.color.slice(5,7),16),
    }));
    const active=input.masks.find(mask=>mask.id===input.activeMaskId)?.data,out=this.pixels;
    for(let y=rect.y;y<rect.y+rect.height;y++){
      const row=base+(ny-1-y)*sb;
      for(let x=rect.x;x<rect.x+rect.width;x++){
        const idx=row+x*sa,pixel=x+y*nx,k=4*pixel;
        let r=this.grey[pixel]!,g=r,b=r;
        for(const mask of masks)if(!mask.skip&&mask.data[idx]){
          r=r*(1-mask.alpha)+mask.r*mask.alpha;g=g*(1-mask.alpha)+mask.g*mask.alpha;b=b*(1-mask.alpha)+mask.b*mask.alpha;
        }
        if(input.temporarySelection?.[idx]){
          if(active?.[idx]){r=r*.35+255*.65;g=g*.35+205*.65;b=b*.35+60*.65;}
          else{r=r*.35+184*.65;g=g*.35+98*.65;b=b*.35+235*.65;}
        }
        if(input.preview?.[idx]){r=r*.45+255*.55;g=g*.45+205*.55;b=b*.45+60*.55;}
        out[k]=r;out[k+1]=g;out[k+2]=b;out[k+3]=255;
      }
    }
    return rect;
  }
}
