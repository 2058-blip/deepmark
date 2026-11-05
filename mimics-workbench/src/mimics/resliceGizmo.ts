import {mprPlaneCenter,mprPlaneNormal,mprWorldToPixel,validateMprPlane} from './mpr.ts';
import type {MprPlane,Vec3} from './types.ts';

/** Independent interaction policy; native help establishes handles but not a 3D drag mapping. */
export const MIN_RESLICE_FIELD_OF_VIEW_MM=1e-3;
export type ReslicePlaneResizeHandleId='u-'|'u+'|'v-'|'v+'|'corner--'|'corner+-'|'corner++'|'corner-+';
export type ReslicePlaneRotateHandleId='rotate--'|'rotate+-'|'rotate++'|'rotate-+';
export interface ReslicePlaneHandle {id:'center'|ReslicePlaneResizeHandleId|ReslicePlaneRotateHandleId;kind:'move'|'rotate'|'resize';position:Vec3;axis?:'normal'}
export interface ReslicePlaneFrame {
  center:Vec3;u:Vec3;v:Vec3;normal:Vec3;width:number;height:number;
  /** Full pixel support in --, +-, ++, -+ order, not sample-center bounds. */
  corners:[Vec3,Vec3,Vec3,Vec3];
}
const EPS=1e-9;
const add=(a:Vec3,b:Vec3):Vec3=>a.map((n,k)=>n+b[k]!) as Vec3;
const sub=(a:Vec3,b:Vec3):Vec3=>a.map((n,k)=>n-b[k]!) as Vec3;
const scale=(a:Vec3,n:number):Vec3=>a.map(v=>v*n) as Vec3;
const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,k)=>sum+n*b[k]!,0);
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function finite(v:Vec3):void {if(!Array.isArray(v)||v.length!==3||![v[0],v[1],v[2]].every(Number.isFinite))throw new Error('RP交互坐标必须是有限三维向量。');}
function unit(v:Vec3):Vec3 {finite(v);const length=Math.hypot(...v);if(!Number.isFinite(length)||length<=EPS)throw new Error('RP旋转轴或拖拽方向不能为零。');return scale(v,1/length);}
const unchanged=(a:number,b:number)=>Math.abs(a-b)<=1e-12*Math.max(Math.abs(a),Math.abs(b),EPS);
function withCenter(plane:MprPlane,center:Vec3,u:Vec3,v:Vec3):MprPlane {
  return validateMprPlane({origin:sub(center,add(scale(u,(plane.size[0]-1)/2),scale(v,(plane.size[1]-1)/2))),u,v,size:plane.size});
}

export function reslicePlaneFrame(input:MprPlane):ReslicePlaneFrame {
  const plane=validateMprPlane(input),center=mprPlaneCenter(plane),width=plane.size[0]*Math.hypot(...plane.u),height=plane.size[1]*Math.hypot(...plane.v);
  if(!Number.isFinite(width)||!Number.isFinite(height))throw new Error('RP物理视野必须是有限毫米值。');
  const u=unit(plane.u),v=unit(plane.v),at=(x:number,y:number)=>add(center,add(scale(plane.u,x*plane.size[0]/2),scale(plane.v,y*plane.size[1]/2)));
  const corners:[Vec3,Vec3,Vec3,Vec3]=[at(-1,-1),at(1,-1),at(1,1),at(-1,1)];
  finite(center);corners.forEach(finite);return{center,u,v,normal:mprPlaneNormal(plane),width,height,corners};
}

/** Rotate mode exposes center/corner handles; resize mode exposes center, four sides and four corners. */
export function reslicePlaneHandles(input:MprPlane,mode:'rotate'|'resize'):ReslicePlaneHandle[] {
  const frame=reslicePlaneFrame(input),center:ReslicePlaneHandle={id:'center',kind:'move',position:[...frame.center]};
  if(mode==='rotate')return[center,...(['rotate--','rotate+-','rotate++','rotate-+'] as const).map((id,k)=>({id,kind:'rotate' as const,position:[...frame.corners[k]!] as Vec3,axis:'normal' as const}))];
  if(mode!=='resize')throw new Error('未知RP操作模式。');
  const midpoint=(a:Vec3,b:Vec3)=>add(scale(a,.5),scale(b,.5));
  return[center,
    {id:'u-',kind:'resize',position:midpoint(frame.corners[0],frame.corners[3])},
    {id:'u+',kind:'resize',position:midpoint(frame.corners[1],frame.corners[2])},
    {id:'v-',kind:'resize',position:midpoint(frame.corners[0],frame.corners[1])},
    {id:'v+',kind:'resize',position:midpoint(frame.corners[3],frame.corners[2])},
    ...(['corner--','corner+-','corner++','corner-+'] as const).map((id,k)=>({id,kind:'resize' as const,position:[...frame.corners[k]!] as Vec3})),
  ];
}

/** A center drag is a physical world translation; the viewport chooses its frozen drag plane. */
export function translateReslicePlane(input:MprPlane,deltaWorld:Vec3):MprPlane {
  const plane=validateMprPlane(input);finite(deltaWorld);
  if(deltaWorld.every(n=>n===0))return plane;
  return validateMprPlane({...plane,origin:add(plane.origin,deltaWorld)});
}

/** Project both rays perpendicular to the chosen world axis and rotate around the frozen physical center. */
export function rotateReslicePlane(input:MprPlane,fromWorld:Vec3,toWorld:Vec3,axis?:Vec3):MprPlane {
  const plane=validateMprPlane(input),center=mprPlaneCenter(plane),normal=axis!==undefined?unit(axis):mprPlaneNormal(plane);
  finite(fromWorld);finite(toWorld);
  const ray=(point:Vec3)=>{const delta=sub(point,center);finite(delta);return unit(sub(delta,scale(normal,dot(delta,normal))));};
  const from=ray(fromWorld),to=ray(toWorld),angle=Math.atan2(dot(cross(from,to),normal),dot(from,to));
  if(Math.abs(angle)<=1e-14)return plane;
  const cosine=Math.cos(angle),sine=Math.sin(angle),rotate=(v:Vec3)=>add(add(scale(v,cosine),scale(cross(normal,v),sine)),scale(normal,dot(normal,v)*(1-cosine)));
  return withCenter(plane,center,rotate(plane.u),rotate(plane.v));
}

/** Opposite borders move symmetrically. Crossing the center cannot flip the saved orientation. */
export function resizeReslicePlane(input:MprPlane,handleId:string,worldPosition:Vec3,minimumFieldOfViewMm=MIN_RESLICE_FIELD_OF_VIEW_MM):MprPlane {
  const plane=validateMprPlane(input);finite(worldPosition);
  if(!Number.isFinite(minimumFieldOfViewMm)||minimumFieldOfViewMm<=0)throw new Error('RP最小视野必须是正有限毫米值。');
  const resizeU=handleId==='u-'||handleId==='u+'||['corner--','corner+-','corner++','corner-+'].includes(handleId);
  const resizeV=handleId==='v-'||handleId==='v+'||['corner--','corner+-','corner++','corner-+'].includes(handleId);
  if(!resizeU&&!resizeV)throw new Error('未知RP缩放控制点。');
  const {pixel}=mprWorldToPixel(plane,worldPosition),stepU=Math.hypot(...plane.u),stepV=Math.hypot(...plane.v),width=plane.size[0]*stepU,height=plane.size[1]*stepV;
  const requestedWidth=resizeU?2*Math.abs(pixel[0]-(plane.size[0]-1)/2)*stepU:width;
  const requestedHeight=resizeV?2*Math.abs(pixel[1]-(plane.size[1]-1)/2)*stepV:height;
  if(!Number.isFinite(requestedWidth)||!Number.isFinite(requestedHeight))throw new Error('RP物理视野必须是有限毫米值。');
  // A click preserves the original frame exactly, including accepted rounded near-orthogonal axes.
  if(unchanged(requestedWidth,width)&&unchanged(requestedHeight,height))return plane;
  // MPR validation also requires each pixel step to exceed 1e-9 mm, even at maximum sample counts.
  const nextWidth=resizeU?Math.max(requestedWidth,minimumFieldOfViewMm,plane.size[0]*2*EPS):width;
  const nextHeight=resizeV?Math.max(requestedHeight,minimumFieldOfViewMm,plane.size[1]*2*EPS):height;
  const u=resizeU&&!unchanged(nextWidth,width)?scale(plane.u,nextWidth/width):plane.u;
  const v=resizeV&&!unchanged(nextHeight,height)?scale(plane.v,nextHeight/height):plane.v;
  return withCenter(plane,mprPlaneCenter(plane),u,v);
}
