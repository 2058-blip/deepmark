import type {Axis,MaskObject,MprPlane,Vec3,VolumeGrid} from '../../mimics-workbench/src/mimics/types.ts';
import {worldToVoxel,nearestVoxelCoordinate} from '../../mimics-workbench/src/mimics/measurements.ts';
import {validateMprPlane} from '../../mimics-workbench/src/mimics/mpr.ts';
import type {WorkbenchClaims} from './claims.ts';

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
  const view=input.view as Record<string,unknown>,[nx,ny,nz]=input.grid.dims;
  if(![nx,ny,nz].every(value=>Number.isSafeInteger(value)&&value>0))return none;
  if(input.plane){
    const {left,top,dx,dy,scale,ny:viewHeight}=view;
    if(![left,top,dx,dy,scale,viewHeight].every(value=>typeof value==='number'&&Number.isFinite(value))||Number(dx)<=0||Number(dy)<=0||Number(scale)<=0||Number(viewHeight)<=0)return none;
    try{
      // Match mprHoverLookup's inverse, operation order and nearest tie policy.
      // Snapshot proxies once: a hot sample must not read Vue props or allocate vectors.
      const plane=validateMprPlane(input.plane),affine=input.grid.affine?.map(row=>[...row]);
      const translation:Vec3=affine?[affine[0]![3]!,affine[1]![3]!,affine[2]![3]!]:[0,0,0];
      const linear={spacing:[...input.grid.spacing] as Vec3,...(affine?{affine:affine.map((row,r)=>r<3?[row[0]!,row[1]!,row[2]!,0]:[...row])}:{})};
      const inverse=([[1,0,0],[0,1,0],[0,0,1]] as Vec3[]).map(axis=>worldToVoxel(axis,linear));
      const vector=(v:Vec3):Vec3=>[0,1,2].map(k=>inverse[0]![k]!*v[0]+inverse[1]![k]!*v[1]+inverse[2]![k]!*v[2]) as Vec3;
      const [o0,o1,o2]=vector(plane.origin.map((value,k)=>value-translation[k]!) as Vec3),[u0,u1,u2]=vector(plane.u),[v0,v1,v2]=vector(plane.v);
      const sx=Number(dx)*Number(scale),sy=Number(dy)*Number(scale),ox=Number(left),oy=Number(top),rows=Number(viewHeight),pw=plane.size[0],ph=plane.size[1];
      return(x,y)=>{
        if(!Number.isFinite(x)||!Number.isFinite(y))return null;
        const px=(x-ox)/sx-.5,py=rows-.5-(y-oy)/sy;
        if(!Number.isFinite(px)||!Number.isFinite(py)||px<-.5||px>pw-.5||py<-.5||py>ph-.5)return null;
        const a=Math.max(0,Math.min(pw-1,Math.round(px))),b=Math.max(0,Math.min(ph-1,Math.round(py)));
        const q0=o0+a*u0+b*v0,q1=o1+a*u1+b*v1,q2=o2+a*u2+b*v2;
        if(!Number.isFinite(q0)||!Number.isFinite(q1)||!Number.isFinite(q2)||q0<-.5||q0>nx-.5||q1<-.5||q1>ny-.5||q2<-.5||q2>nz-.5)return null;
        const i=Math.max(0,Math.min(nx-1,nearestVoxelCoordinate(q0))),j=Math.max(0,Math.min(ny-1,nearestVoxelCoordinate(q1))),k=Math.max(0,Math.min(nz-1,nearestVoxelCoordinate(q2)));
        return i+nx*(j+ny*k);
      };
    }catch{return none;}
  }
  const axis=input.axis,point=input.point;
  if(axis===undefined||![0,1,2].includes(axis)||!point||point.length!==3||!point.every(Number.isFinite)||view.axis!==axis)return none;
  const transform=view.transform;
  if(!Array.isArray(transform)||transform.length!==6||!transform.every(value=>typeof value==='number'&&Number.isFinite(value))||Number(transform[0])<=0||Number(transform[3])<=0)return none;
  if(![view.a,view.b].every(value=>typeof value==='number'&&[0,1,2].includes(value))||view.a===view.b||view.a===axis||view.b===axis||![view.nx,view.ny].every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0))return none;
  const slice=point[axis];if(!Number.isSafeInteger(slice)||slice<0||slice>=[nx,ny,nz][axis]!)return none;
  const [a,,c,d,e,f]=transform as number[],va=Number(view.a),vb=Number(view.b),columns=Number(view.nx),rows=Number(view.ny);
  const strides=[1,nx,nx*ny],base=slice*strides[axis]!,sa=strides[va]!,sb=strides[vb]!,dimA=[nx,ny,nz][va]!,dimB=[nx,ny,nz][vb]!;
  return(x,y)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y))return null;
    const yy=(y-f!)/d!,xx=(x-e!-c!*yy)/a!;
    if(!Number.isFinite(xx)||!Number.isFinite(yy)||xx < -1e-9||yy < -1e-9||xx>columns+1e-9||yy>rows+1e-9)return null;
    const qa=Math.max(0,Math.min(columns-1,xx-.5)),qb=Math.max(0,Math.min(rows-1,rows-.5-yy));
    if(qa>dimA-.5||qb>dimB-.5)return null;
    const ia=Math.max(0,Math.min(dimA-1,Math.round(qa))),ib=Math.max(0,Math.min(dimB-1,Math.round(qb)));
    return base+ia*sa+ib*sb;
  };
}

const HATCH_PERIOD=9,HATCH_HALF_WIDTH=.7*Math.SQRT2/2,HATCH_ALPHA=64;
/** Area of a rectangle below x+y=t. Integrating each pixel footprint retains
 * thin diagonal lines at reduced raster resolution without opaque aliasing. */
function sumArea(t:number,width:number,height:number):number{
  const positiveSquare=(value:number)=>value>0?value*value:0;
  return(positiveSquare(t)-positiveSquare(t-width)-positiveSquare(t-height)+positiveSquare(t-width-height))/(2*width*height);
}

export interface ForeignGridPattern {
  readonly width:number;readonly height:number;readonly logicalWidth:number;readonly logicalHeight:number;
  /** Sparse pixel addresses and exact alpha, immutable after construction. */
  readonly samples:Uint32Array;readonly alphas:Uint8Array;
}
const MAX_PATTERN_PIXELS=4*1024*1024;
function validPatternSize(width:number,height:number,logicalWidth:number,logicalHeight:number){
  return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width*height<=MAX_PATTERN_PIXELS&&[logicalWidth,logicalHeight].every(value=>Number.isFinite(value)&&value>0);
}

/** Build the screen-fixed hatch once per viewport size. No CT or ownership copy.
 * Temporary alpha is one viewport byte per pixel; final storage is sparse typed data. */
export function createForeignGridPattern(width:number,height:number,logicalWidth:number,logicalHeight:number):ForeignGridPattern{
  if(!validPatternSize(width,height,logicalWidth,logicalHeight))throw new RangeError('网格缓存尺寸无效或超出视口预算。');
  const sx=logicalWidth/width,sy=logicalHeight/height,half=(sx+sy)/2;
  const rising=new Float32Array(width),falling=new Float32Array(width),marked=new Uint8Array(width),touched:number[]=[];
  const alphaPixels=new Uint8Array(width*height);let count=0;
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
      if(alpha){alphaPixels[x+y*width]=alpha;count++;}
      rising[x]=0;falling[x]=0;marked[x]=0;
    }
    touched.length=0;
  }
  const samples=new Uint32Array(count),alphas=new Uint8Array(count);let n=0;
  for(let i=0;i<alphaPixels.length;i++)if(alphaPixels[i]){samples[n]=i;alphas[n]=alphaPixels[i]!;n++;}
  return{width,height,logicalWidth,logicalHeight,samples,alphas};
}

/** Paint only cached grid-line samples, clipped to actual foreign Mask members.
 * Optional caches with different raster/logical dimensions are never reused. */
export function paintForeignGrid(pixels:Uint8ClampedArray,width:number,height:number,logicalWidth:number,logicalHeight:number,indexAt:GridIndexLookup,lockedAt:ForeignMaskLookup,pattern?:ForeignGridPattern):number{
  pixels.fill(0);
  if(!validPatternSize(width,height,logicalWidth,logicalHeight)||pixels.length!==width*height*4)return 0;
  if(!pattern||pattern.width!==width||pattern.height!==height||pattern.logicalWidth!==logicalWidth||pattern.logicalHeight!==logicalHeight||!(pattern.samples instanceof Uint32Array)||!(pattern.alphas instanceof Uint8Array)||pattern.samples.length!==pattern.alphas.length||pattern.samples.length>width*height)
    pattern=createForeignGridPattern(width,height,logicalWidth,logicalHeight);
  const sx=logicalWidth/width,sy=logicalHeight/height;let painted=0,rowStart=-width,centerY=0;
  for(let n=0;n<pattern.samples.length;n++){
    const pixel=pattern.samples[n]!;if(pixel>=width*height)continue;
    if(pixel<rowStart||pixel>=rowStart+width){rowStart=Math.floor(pixel/width)*width;centerY=(rowStart/width+.5)*sy;}
    const index=indexAt((pixel-rowStart+.5)*sx,centerY);
    if(index===null||!Number.isSafeInteger(index)||index<0||lockedAt(index)!==true)continue;
    const offset=4*pixel;
    pixels[offset]=255;pixels[offset+1]=255;pixels[offset+2]=255;pixels[offset+3]=pattern.alphas[n]!;painted++;
  }
  return painted;
}
