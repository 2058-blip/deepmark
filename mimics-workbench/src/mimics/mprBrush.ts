import {worldToVoxel} from './measurements.ts';
import {mprPlaneNormal,validateMprPlane} from './mpr.ts';
import {physicalPoint,requireGrid,type MprPlane,type Vec3,type VolumeGrid} from './types.ts';

/** Independent physical MPR editing policy, not a recovered native Mimics brush kernel. */
export interface MprBrushStroke {from:Vec3;to:Vec3;widthMm:number;heightMm:number;shape:'circle'|'square'}
export interface MprBrushOptions {maxScanVisits?:number;maxCandidates?:number;cancelled?:()=>boolean}
export interface MprBrushCandidates {indices:Uint32Array;candidateCount:number;scanVisits:number}
export const DEFAULT_MPR_BRUSH_MAX_SCAN_VISITS=1_000_000;
export const DEFAULT_MPR_BRUSH_MAX_CANDIDATES=1_000_000;
export const MAX_MPR_BRUSH_SCAN_VISITS=8_000_000;
export const MAX_MPR_BRUSH_CANDIDATES=4_000_000;
const ROUNDING=32*Number.EPSILON;
type Vec2=[number,number];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,n:number):Vec3=>[a[0]*n,a[1]*n,a[2]*n];
function finiteVector(v:unknown):asserts v is Vec3 {if(!Array.isArray(v)||v.length!==3||![v[0],v[1],v[2]].every(Number.isFinite))throw new Error('MPR画笔空间坐标必须是有限三维向量。');}
function finiteNumbers(values:readonly number[]):void {if(values.some(n=>!Number.isFinite(n)))throw new Error('MPR画笔物理几何超出有限数值范围。');}
function budget(value:number,maximum:number):number {if(!Number.isSafeInteger(value)||value<=0||value>maximum)throw new Error(`MPR画笔预算必须是1至${maximum}的整数。`);return value;}
function checkCancelled(options:MprBrushOptions):void {if(options.cancelled?.()){const error=new Error('MPR画笔操作已取消。');error.name='AbortError';throw error;}}
const tolerance=(a:number,b:number)=>ROUNDING*Math.max(Math.abs(a),Math.abs(b));
const lessEqual=(a:number,b:number)=>a<=b||Number.isFinite(a)&&Number.isFinite(b)&&a-b<=tolerance(a,b);

/** Validate geometry without reading gray values or allocating a source-volume-sized buffer. */
function sourceGeometry(grid:VolumeGrid):{columns:[Vec3,Vec3,Vec3];translation:Vec3;inverse:[Vec3,Vec3,Vec3]} {
  finiteVector(grid.dims);finiteVector(grid.spacing);requireGrid(grid);
  const count=grid.dims[0]*grid.dims[1]*grid.dims[2];
  if(!(grid.data instanceof Float32Array)||!Number.isSafeInteger(count)||count>0xffffffff)throw new Error('MPR画笔源影像必须是有效Float32体积且体素索引不超过32位。');
  if(grid.affine){
    if(!Array.isArray(grid.affine)||![3,4].includes(grid.affine.length)||Array.from(grid.affine).some(row=>!Array.isArray(row)||row.length!==4||![row[0],row[1],row[2],row[3]].every(Number.isFinite)))throw new Error('MPR画笔方向矩阵必须是有限3×4或4×4仿射矩阵。');
    if(grid.affine.length===4&&grid.affine[3]!.some((n,k)=>n!==(k===3?1:0)))throw new Error('MPR画笔不支持透视方向矩阵。');
  }
  const columns:[Vec3,Vec3,Vec3]=grid.affine?[0,1,2].map(k=>[grid.affine![0]![k]!,grid.affine![1]![k]!,grid.affine![2]![k]!]) as [Vec3,Vec3,Vec3]:[[grid.spacing[0],0,0],[0,grid.spacing[1],0],[0,0,grid.spacing[2]]];
  const translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0];
  // Invert the linear part alone: large physical translations must not destroy unit increments.
  const linear={spacing:grid.spacing,...(grid.affine?{affine:grid.affine.slice(0,3).map(row=>[row[0]!,row[1]!,row[2]!,0])}:{})};
  const inverse=[worldToVoxel([1,0,0],linear),worldToVoxel([0,1,0],linear),worldToVoxel([0,0,1],linear)] as [Vec3,Vec3,Vec3];
  inverse.forEach(finiteVector);
  for(const x of [-.5,grid.dims[0]-.5])for(const y of [-.5,grid.dims[1]-.5])for(const z of [-.5,grid.dims[2]-.5])finiteVector(physicalPoint([x,y,z],grid));
  return{columns,translation,inverse};
}

/**
 * Continuous ellipse/rectangle sweep over source voxel centers, clipped to full pixel-support FOV.
 * The closed normal slab includes source cells tangent to the plane. It can touch two layers at
 * a half-layer boundary; a plane through an aligned IJK voxel-center slice selects one layer.
 * Pure/all-or-throw: cancellation, numeric failure or budget exhaustion never return a partial set.
 */
export function sweepMprBrush(grid:VolumeGrid,input:MprPlane,stroke:MprBrushStroke,options:MprBrushOptions={}):MprBrushCandidates {
  const plane=validateMprPlane(input);finiteVector(stroke.from);finiteVector(stroke.to);
  if(!Number.isFinite(stroke.widthMm)||!Number.isFinite(stroke.heightMm)||stroke.widthMm<=0||stroke.heightMm<=0||stroke.widthMm/2===0||stroke.heightMm/2===0)throw new Error('MPR画笔宽高必须是正有限毫米值。');
  if(stroke.shape!=='circle'&&stroke.shape!=='square')throw new Error('未知MPR画笔形状。');
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function')throw new Error('MPR画笔取消检查必须是函数。');
  const maxScanVisits=budget(options.maxScanVisits??DEFAULT_MPR_BRUSH_MAX_SCAN_VISITS,MAX_MPR_BRUSH_SCAN_VISITS),maxCandidates=budget(options.maxCandidates??DEFAULT_MPR_BRUSH_MAX_CANDIDATES,MAX_MPR_BRUSH_CANDIDATES);
  checkCancelled(options);
  const {columns,translation,inverse}=sourceGeometry(grid),stepU=Math.hypot(...plane.u),stepV=Math.hypot(...plane.v),u=scale(plane.u,1/stepU),v=scale(plane.v,1/stepV),normal=mprPlaneNormal(plane),cosine=dot(u,v),gram=1-cosine*cosine;
  const project=(delta:Vec3):Vec2=>{const du=dot(delta,u),dv=dot(delta,v),point:Vec2=[(du-cosine*dv)/gram,(dv-cosine*du)/gram];finiteNumbers(point);return point;};
  const a=project(sub(stroke.from,plane.origin)),b=project(sub(stroke.to,plane.origin)),rx=stroke.widthMm/2,ry=stroke.heightMm/2;
  const fov:[number,number,number,number]=[-stepU/2,(plane.size[0]-.5)*stepU,-stepV/2,(plane.size[1]-.5)*stepV];
  const extent:[number,number,number,number]=[Math.min(a[0],b[0])-rx,Math.max(a[0],b[0])+rx,Math.min(a[1],b[1])-ry,Math.max(a[1],b[1])+ry];
  const slabHalfWidth=columns.reduce((sum,column)=>sum+Math.abs(dot(normal,column))/2,0);
  finiteNumbers([...a,...b,...fov,...extent,slabHalfWidth]);
  if(slabHalfWidth<=0)throw new Error('MPR画笔源体素的物理厚度必须大于零。');
  const left=Math.max(fov[0],extent[0]),right=Math.min(fov[1],extent[1]),bottom=Math.max(fov[2],extent[2]),top=Math.min(fov[3],extent[3]);
  const empty=():MprBrushCandidates=>{checkCancelled(options);return{indices:new Uint32Array(0),candidateCount:0,scanVisits:0};};
  if(left>right||bottom>top)return empty();
  const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity];
  for(const x of [left,right])for(const y of [bottom,top])for(const z of [-slabHalfWidth,slabHalfWidth]){
    const delta:Vec3=[plane.origin[0]-translation[0]+u[0]*x+v[0]*y+normal[0]*z,plane.origin[1]-translation[1]+u[1]*x+v[1]*y+normal[1]*z,plane.origin[2]-translation[2]+u[2]*x+v[2]*y+normal[2]*z];finiteVector(delta);
    const voxel:Vec3=[0,1,2].map(k=>inverse[0][k]!*delta[0]+inverse[1][k]!*delta[1]+inverse[2][k]!*delta[2]) as Vec3;finiteVector(voxel);
    voxel.forEach((n,k)=>{low[k]=Math.min(low[k]!,n);high[k]=Math.max(high[k]!,n);});
  }
  const min=low.map((n,k)=>Math.max(0,Math.ceil(n-tolerance(n,high[k]!)))) as Vec3,max=high.map((n,k)=>Math.min(grid.dims[k]!-1,Math.floor(n+tolerance(n,low[k]!)))) as Vec3;
  if(min.some((n,k)=>n>max[k]!))return empty();
  const scanVisits=(max[0]-min[0]+1)*(max[1]-min[1]+1)*(max[2]-min[2]+1);
  if(!Number.isSafeInteger(scanVisits)||scanVisits>maxScanVisits)throw new Error(`MPR画笔候选扫描超过单段预算${maxScanVisits}，请缩小画笔或分段。`);
  // All remaining storage is bounded by these caps, including the final compact result copy.
  let buffer:Uint32Array;
  try{buffer=new Uint32Array(Math.min(scanVisits,maxCandidates));}catch{throw new Error('MPR画笔候选缓冲区分配失败，本段未返回任何修改。');}
  const localBase=project(sub(translation,plane.origin)),localColumns=columns.map(project),normalBase=dot(sub(translation,plane.origin),normal),normalColumns=columns.map(column=>dot(column,normal));
  finiteNumbers([...localBase,...localColumns.flat(),normalBase,...normalColumns]);
  const dx=(b[0]-a[0])/rx,dy=(b[1]-a[1])/ry,length=Math.hypot(dx,dy),ux=length?dx/length:0,uy=length?dy/length:0;finiteNumbers([dx,dy,length,ux,uy]);
  const inFootprint=(x:number,y:number):boolean=>{
    const qx=(x-a[0])/rx,qy=(y-a[1])/ry;
    if(!Number.isFinite(qx)||!Number.isFinite(qy))throw new Error('MPR画笔物理几何超出有限数值范围。');
    if(stroke.shape==='circle'){
      const along=qx*ux+qy*uy,distance=length?Math.max(0,Math.min(length,along)):0,radius=Math.hypot(qx-distance*ux,qy-distance*uy);
      if(!Number.isFinite(along)||!Number.isFinite(radius))throw new Error('MPR画笔物理几何超出有限数值范围。');
      return lessEqual(radius,1);
    }
    let start=0,end=1;
    if(dx===0){if(!lessEqual(Math.abs(qx),1))return false;}
    else{const t0=(qx-1)/dx,t1=(qx+1)/dx;start=Math.max(start,Math.min(t0,t1));end=Math.min(end,Math.max(t0,t1));if(!lessEqual(start,end))return false;}
    if(dy===0)return lessEqual(Math.abs(qy),1);
    const t0=(qy-1)/dy,t1=(qy+1)/dy;start=Math.max(start,Math.min(t0,t1));end=Math.min(end,Math.max(t0,t1));return lessEqual(start,end);
  };
  checkCancelled(options);let count=0,visited=0;
  for(let z=min[2];z<=max[2];z++)for(let y=min[1];y<=max[1];y++){
    const rowX=localBase[0]+localColumns[1]![0]*y+localColumns[2]![0]*z,rowY=localBase[1]+localColumns[1]![1]*y+localColumns[2]![1]*z,rowN=normalBase+normalColumns[1]!*y+normalColumns[2]!*z,rowIndex=grid.dims[0]*(y+grid.dims[1]*z);
    for(let x=min[0];x<=max[0];x++){
      const px=rowX+localColumns[0]![0]*x,py=rowY+localColumns[0]![1]*x,distance=rowN+normalColumns[0]!*x;
      if(!Number.isFinite(px)||!Number.isFinite(py)||!Number.isFinite(distance))throw new Error('MPR画笔物理几何超出有限数值范围。');
      if(lessEqual(Math.abs(distance),slabHalfWidth)&&lessEqual(fov[0],px)&&lessEqual(px,fov[1])&&lessEqual(fov[2],py)&&lessEqual(py,fov[3])&&inFootprint(px,py)){
        if(count===maxCandidates)throw new Error(`MPR画笔候选体素超过单段预算${maxCandidates}，本段未返回任何修改。`);
        buffer[count++]=rowIndex+x;
      }
      if((++visited&1023)===0)checkCancelled(options);
    }
  }
  checkCancelled(options);
  try{return{indices:buffer.slice(0,count),candidateCount:count,scanVisits:visited};}catch{throw new Error('MPR画笔候选结果分配失败，本段未返回任何修改。');}
}
