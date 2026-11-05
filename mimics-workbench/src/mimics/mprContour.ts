import {sweepMprBrush,DEFAULT_MPR_BRUSH_MAX_SCAN_VISITS,DEFAULT_MPR_BRUSH_MAX_CANDIDATES,MAX_MPR_BRUSH_SCAN_VISITS,MAX_MPR_BRUSH_CANDIDATES} from './mprBrush.ts';
import {validateMprPlane} from './mpr.ts';
import type {AlgorithmControl,MprPlane,Vec3,VolumeGrid} from './types.ts';

/** Independent source-grid contour policy; the native arbitrary-RP writeback kernel is unknown. */
export interface MprContourOptions extends AlgorithmControl {maxScanVisits?:number;maxCandidates?:number;maxEdgeVisits?:number}
export interface MprContourCandidates {indices:Uint32Array;candidateCount:number;scanVisits:number;edgeVisits:number}
export const DEFAULT_MPR_CONTOUR_MAX_SCAN_VISITS=DEFAULT_MPR_BRUSH_MAX_SCAN_VISITS;
export const DEFAULT_MPR_CONTOUR_MAX_CANDIDATES=DEFAULT_MPR_BRUSH_MAX_CANDIDATES;
export const MAX_MPR_CONTOUR_SCAN_VISITS=MAX_MPR_BRUSH_SCAN_VISITS;
export const MAX_MPR_CONTOUR_CANDIDATES=MAX_MPR_BRUSH_CANDIDATES;
export const DEFAULT_MPR_CONTOUR_MAX_EDGE_VISITS=8_000_000;
export const MAX_MPR_CONTOUR_EDGE_VISITS=64_000_000;
export const MAX_MPR_CONTOUR_POINTS=65_536;
const ROUNDING=32*Number.EPSILON;
type Vec2=[number,number];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,n:number):Vec3=>[a[0]*n,a[1]*n,a[2]*n];
function finite(values:readonly number[]):void {if(values.some(n=>!Number.isFinite(n)))throw new Error('MPR轮廓几何必须是有限数值。');}
function finitePoint(point:unknown):asserts point is Vec3 {if(!Array.isArray(point)||point.length!==3||![point[0],point[1],point[2]].every(Number.isFinite))throw new Error('MPR轮廓点必须是有限三维世界坐标。');}
function budget(value:number,maximum:number):number {if(!Number.isSafeInteger(value)||value<=0||value>maximum)throw new Error(`MPR轮廓预算必须是1至${maximum}的整数。`);return value;}
function check(control:MprContourOptions,fraction?:number):void {
  const cancelled=()=>{if(control.cancelled?.()){const error=new Error('MPR轮廓操作已取消。');error.name='AbortError';throw error;}};
  cancelled();if(fraction!==undefined)control.progress?.(fraction);cancelled();
}
const close=(a:number,b:number)=>Math.abs(a-b)<=ROUNDING*Math.max(1,Math.abs(a),Math.abs(b));
const within=(n:number,a:number,b:number)=>(n>=a||close(n,a))&&(n<=b||close(n,b));
function collinear(a:Vec2,b:Vec2,p:Vec2,boundary=false):boolean {
  const x=(b[0]-a[0])*(p[1]-a[1]),y=(b[1]-a[1])*(p[0]-a[0]);
  return Math.abs(x-y)<=ROUNDING*Math.max(boundary?1:0,Math.abs(x)+Math.abs(y));
}

/**
 * Boundary-inclusive even-odd fill at source centers projected into the saved physical plane.
 * Self intersections are allowed; fewer than three distinct points or a collinear contour reject.
 * Uses the brush helper's full-affine closed source-cell slab/FOV and local inverse-affine box.
 * No gray reads or Mask writes; budgets, cancellation and allocation errors return no partial set.
 */
export function rasterizeMprContour(grid:VolumeGrid,input:MprPlane,worldPoints:readonly Vec3[],options:MprContourOptions={}):MprContourCandidates {
  const plane=validateMprPlane(input);
  if(!Array.isArray(worldPoints)||worldPoints.length<3||worldPoints.length>MAX_MPR_CONTOUR_POINTS)throw new Error(`MPR轮廓需要3至${MAX_MPR_CONTOUR_POINTS}个世界坐标点。`);
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function'||options.progress!==undefined&&typeof options.progress!=='function')throw new Error('MPR轮廓控制回调必须是函数。');
  const maxScanVisits=budget(options.maxScanVisits??DEFAULT_MPR_CONTOUR_MAX_SCAN_VISITS,MAX_MPR_CONTOUR_SCAN_VISITS),maxCandidates=budget(options.maxCandidates??DEFAULT_MPR_CONTOUR_MAX_CANDIDATES,MAX_MPR_CONTOUR_CANDIDATES),maxEdgeVisits=budget(options.maxEdgeVisits??DEFAULT_MPR_CONTOUR_MAX_EDGE_VISITS,MAX_MPR_CONTOUR_EDGE_VISITS);
  check(options,0);let edgeVisits=0;
  const edgeStep=()=>{if(++edgeVisits>maxEdgeVisits)throw new Error(`MPR轮廓边处理超过预算${maxEdgeVisits}，未返回任何修改。`);if((edgeVisits&1023)===0)check(options);};
  const stepU=Math.hypot(...plane.u),stepV=Math.hypot(...plane.v),u=scale(plane.u,1/stepU),v=scale(plane.v,1/stepV),cosine=dot(u,v),gram=1-cosine*cosine;
  const project=(delta:Vec3):Vec2=>{finite(delta);const du=dot(delta,u),dv=dot(delta,v),point:Vec2=[(du-cosine*dv)/gram,(dv-cosine*du)/gram];finite(point);return point;};
  const points:Vec2[]=[],distinct=new Set<string>();let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
  for(let i=0;i<worldPoints.length;i++){
    edgeStep();const world=worldPoints[i];finitePoint(world);const point=project(sub(world,plane.origin)),last=points.at(-1);
    if(last&&point[0]===last[0]&&point[1]===last[1])continue;
    points.push(point);distinct.add(`${point[0]},${point[1]}`);left=Math.min(left,point[0]);right=Math.max(right,point[0]);bottom=Math.min(bottom,point[1]);top=Math.max(top,point[1]);
  }
  if(points.length>1&&points[0]![0]===points.at(-1)![0]&&points[0]![1]===points.at(-1)![1])points.pop();
  if(distinct.size<3)throw new Error('MPR轮廓至少需要三个不同的投影点。');
  const width=right-left,height=top-bottom,extent=Math.max(width,height);finite([width,height,extent]);
  if(width<=0||height<=0)throw new Error('MPR轮廓投影点不能全部共线。');
  // Normalize only for predicates: this avoids overflow while retaining physical bbox dimensions.
  const normalized=points.map(point=>[(point[0]-left)/extent,(point[1]-bottom)/extent] as Vec2),first=normalized[0]!,second=normalized.find(point=>point[0]!==first[0]||point[1]!==first[1]);
  if(!second)throw new Error('MPR轮廓投影点不能全部共线。');
  let noncollinear=false;
  for(const point of normalized){edgeStep();if(!collinear(first,second,point)){noncollinear=true;break;}}
  if(!noncollinear)throw new Error('MPR轮廓投影点不能全部共线。');
  check(options,.1);
  // Conservative rectangle may exceed a budget before the smaller exact polygon would do so.
  const cx=left/2+right/2,cy=bottom/2+top/2,padX=ROUNDING*Math.max(Math.abs(left),Math.abs(right),width),padY=ROUNDING*Math.max(Math.abs(bottom),Math.abs(top),height);
  const center:Vec3=[plane.origin[0]+u[0]*cx+v[0]*cy,plane.origin[1]+u[1]*cx+v[1]*cy,plane.origin[2]+u[2]*cx+v[2]*cy];finitePoint(center);
  const superset=sweepMprBrush(grid,plane,{from:center,to:center,widthMm:width+2*padX,heightMm:height+2*padY,shape:'square'},{maxScanVisits,maxCandidates:MAX_MPR_BRUSH_CANDIDATES,cancelled:options.cancelled});
  const worstEdges=superset.candidateCount*normalized.length;
  if(!Number.isSafeInteger(worstEdges)||worstEdges>maxEdgeVisits-edgeVisits)throw new Error(`MPR轮廓候选与边数量超过边处理预算${maxEdgeVisits}，未返回任何修改。`);
  check(options,.55);
  const columns:Vec3[]=grid.affine?[0,1,2].map(k=>[grid.affine![0]![k]!,grid.affine![1]![k]!,grid.affine![2]![k]!]):[[grid.spacing[0],0,0],[0,grid.spacing[1],0],[0,0,grid.spacing[2]]];
  const translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0],base=project(sub(translation,plane.origin)),localColumns=columns.map(project);
  const inside=(x:number,y:number):boolean=>{
    const p:Vec2=[(x-left)/extent,(y-bottom)/extent];finite(p);let odd=false;
    for(let i=0;i<normalized.length;i++){
      edgeStep();const a=normalized[i]!,b=normalized[(i+1)%normalized.length]!;
      if(collinear(a,b,p,true)&&within(p[0],Math.min(a[0],b[0]),Math.max(a[0],b[0]))&&within(p[1],Math.min(a[1],b[1]),Math.max(a[1],b[1])))return true;
      // Half-open Y crossings count a shared vertex once; exact edge hits were handled above.
      if((a[1]>p[1])!==(b[1]>p[1])){
        const hit=a[0]+(p[1]-a[1])/(b[1]-a[1])*(b[0]-a[0]);if(p[0]<hit)odd=!odd;
      }
    }
    return odd;
  };
  let count=0;
  for(let i=0;i<superset.indices.length;i++){
    const index=superset.indices[i]!,x=index%grid.dims[0],row=(index-x)/grid.dims[0],y=row%grid.dims[1],z=Math.floor(row/grid.dims[1]);
    const px=base[0]+localColumns[1]![0]*y+localColumns[2]![0]*z+localColumns[0]![0]*x,py=base[1]+localColumns[1]![1]*y+localColumns[2]![1]*z+localColumns[0]![1]*x;
    if(inside(px,py)){if(count===maxCandidates)throw new Error(`MPR轮廓候选体素超过预算${maxCandidates}，未返回任何修改。`);superset.indices[count++]=index;}
    if((i&1023)===0)check(options,.55+.45*(i+1)/Math.max(1,superset.indices.length));
  }
  check(options,1);
  try{return{indices:superset.indices.slice(0,count),candidateCount:count,scanVisits:superset.scanVisits,edgeVisits};}catch{throw new Error('MPR轮廓结果分配失败，未返回任何修改。');}
}
