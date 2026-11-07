import type {Axis,MaskObject,MprPlane,Vec3,VolumeGrid} from '../../mimics-workbench/src/mimics/types.ts';
import {screenToSlice} from '../../mimics-workbench/src/mimics/viewportGeometry.ts';
import type {SliceViewport} from '../../mimics-workbench/src/mimics/viewportGeometry.ts';
import type {WorkbenchClaims} from './claims.ts';
import {imageHoverIndex,mprHoverLookup} from './hover.ts';

type GridGeometry=Pick<VolumeGrid,'dims'|'spacing'|'affine'>;
export type GridIndexLookup=(x:number,y:number)=>number|null;
export type ForeignMaskLookup=(index:number)=>boolean|null;

/** Reuse sparse claims and original binary members; never allocate an ownership volume.
 * The caller rebuilds this lightweight lookup when mask visibility or claims change. */
export function foreignMaskLookup(masks:readonly MaskObject[],claims:WorkbenchClaims,userId:string):ForeignMaskLookup|null{
  const count=masks.reduce((max,mask)=>Math.max(max,mask.data.length),0);
  const shown=masks.filter(mask=>mask.visible&&mask.opacity>0&&claims.hasForeign(mask.id,userId));
  if(!shown.length)return null;
  return index=>{
    if(!Number.isSafeInteger(index)||index<0||index>=count)return null;
    return shown.some(mask=>mask.data[index]===1&&claims.foreignAt(mask.id,userId,index));
  };
}

/** Map CSS canvas coordinates through the same geometry and nearest membership as
 * the underlying image viewport. No DOM reads or image/volume-sized lookup tables. */
export function gridViewportLookup(input:{grid:GridGeometry;axis?:Axis;point?:Vec3;plane?:MprPlane;view:unknown}):GridIndexLookup{
  const none:GridIndexLookup=()=>null;
  if(!input.view||typeof input.view!=='object')return none;
  const view=input.view as Record<string,unknown>;
  if(input.plane){
    const {left,top,dx,dy,scale,ny}=view;
    if(![left,top,dx,dy,scale,ny].every(value=>typeof value==='number'&&Number.isFinite(value))||Number(dx)<=0||Number(dy)<=0||Number(scale)<=0||Number(ny)<=0)return none;
    try{
      const lookup=mprHoverLookup(input.grid,input.plane),sx=Number(dx)*Number(scale),sy=Number(dy)*Number(scale);
      return(x,y)=>Number.isFinite(x)&&Number.isFinite(y)?lookup([(x-Number(left))/sx-.5,Number(ny)-.5-(y-Number(top))/sy]):null;
    }catch{return none;}
  }
  const axis=input.axis,point=input.point;
  if(axis===undefined||![0,1,2].includes(axis)||!point||point.length!==3||!point.every(Number.isFinite)||view.axis!==axis)return none;
  const transform=view.transform;
  if(!Array.isArray(transform)||transform.length!==6||!transform.every(value=>typeof value==='number'&&Number.isFinite(value))||Number(transform[0])<=0||Number(transform[3])<=0)return none;
  if(![view.a,view.b].every(value=>typeof value==='number'&&[0,1,2].includes(value))||view.a===view.b||view.a===axis||view.b===axis||![view.nx,view.ny].every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0))return none;
  const slice=point[axis],geometry=input.view as SliceViewport;
  return(x,y)=>Number.isFinite(x)&&Number.isFinite(y)?imageHoverIndex(screenToSlice(geometry,[x,y],slice),input.grid.dims,axis,slice):null;
}

const HATCH_PERIOD=9,HATCH_HALF_WIDTH=.7*Math.SQRT2/2,HATCH_ALPHA=64;
/** Area of a rectangle below x+y=t. Integrating each pixel footprint retains
 * thin diagonal lines at reduced raster resolution without opaque aliasing. */
function sumArea(t:number,width:number,height:number):number{
  const positiveSquare=(value:number)=>value>0?value*value:0;
  return(positiveSquare(t)-positiveSquare(t-width)-positiveSquare(t-height)+positiveSquare(t-width-height))/(2*width*height);
}

/** Paint only grid-line samples, clipped to actual foreign Mask members. The
 * buffer is viewport-sized, fully cleared, and the source/claims stay untouched. */
export function paintForeignGrid(pixels:Uint8ClampedArray,width:number,height:number,logicalWidth:number,logicalHeight:number,indexAt:GridIndexLookup,lockedAt:ForeignMaskLookup):number{
  pixels.fill(0);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||pixels.length!==width*height*4||![logicalWidth,logicalHeight].every(value=>Number.isFinite(value)&&value>0))return 0;
  const sx=logicalWidth/width,sy=logicalHeight/height,half=(sx+sy)/2;
  const rising=new Float32Array(width),falling=new Float32Array(width),marked=new Uint8Array(width),touched:number[]=[];
  let painted=0;
  function sample(x:number,y:number,alpha:number){
    const index=indexAt((x+.5)*sx,(y+.5)*sy);
    if(index===null||!Number.isSafeInteger(index)||index<0||lockedAt(index)!==true)return;
    const offset=4*(x+y*width);
    pixels[offset]=255;pixels[offset+1]=255;pixels[offset+2]=255;pixels[offset+3]=alpha;
    painted++;
  }
  for(let y=0;y<height;y++){
    const centerY=(y+.5)*sy;
    for(const sign of [-1,1]){
      const row=sign===1?rising:falling,offset=sign*centerY;
      const first=Math.ceil((offset-sy/2-HATCH_HALF_WIDTH)/HATCH_PERIOD),last=Math.floor((logicalWidth+offset+sy/2+HATCH_HALF_WIDTH)/HATCH_PERIOD);
      for(let k=first;k<=last;k++){
        const centerX=k*HATCH_PERIOD-offset;
        const lo=Math.max(0,Math.floor((centerX-sy/2-HATCH_HALF_WIDTH)/sx)),hi=Math.min(width-1,Math.floor((centerX+sy/2+HATCH_HALF_WIDTH)/sx));
        for(let x=lo;x<=hi;x++){
          const distance=(x+.5)*sx-centerX;
          const coverage=sumArea(half+HATCH_HALF_WIDTH-distance,sx,sy)-sumArea(half-HATCH_HALF_WIDTH-distance,sx,sy);
          if(coverage<=0)continue;
          row[x]!+=coverage;
          if(!marked[x]){marked[x]=1;touched.push(x);}
        }
      }
    }
    for(const x of touched){
      // Crossings use the stronger family, never stack opacity over the image.
      const alpha=Math.round(HATCH_ALPHA*Math.min(1,Math.max(rising[x]!,falling[x]!)));
      if(alpha)sample(x,y,alpha);
      rising[x]=0;falling[x]=0;marked[x]=0;
    }
    touched.length=0;
  }
  return painted;
}
