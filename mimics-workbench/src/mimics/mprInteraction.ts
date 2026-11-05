import {planeAxes} from '../core.ts';
import type {Axis,MprPlane,Vec3,VolumeGrid} from './types.ts';
import {physicalPoint} from './types.ts';
import {validateMprPlane,mprPlaneNormal,fitMprPlane} from './mpr.ts';

const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,k)=>sum+n*b[k]!,0);
const add=(a:Vec3,b:Vec3)=>a.map((n,k)=>n+b[k]!) as Vec3;
const sub=(a:Vec3,b:Vec3)=>a.map((n,k)=>n-b[k]!) as Vec3;
const scale=(v:Vec3,n:number)=>v.map(value=>value*n) as Vec3;
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v:Vec3)=>scale(v,1/Math.hypot(...v));
function finite(v:Vec3){if(!Array.isArray(v)||v.length!==3||v.some(n=>!Number.isFinite(n)))throw new Error('交互平面坐标必须是有限世界向量。');}
function inPlane(v:Vec3,n:Vec3){return sub(v,scale(n,dot(v,n)));}
export interface MprInteractionResult {plane:MprPlane;crosshair:Vec3}

/** Two physical intersection lines; choosing their identity on a raw view is an application policy. */
export function interactiveMprAxes(base:MprPlane,source:MprPlane,pivot:Vec3,viewId?:number):{id:string;direction:Vec3}[]{
  const b=validateMprPlane(base);validateMprPlane(source);finite(pivot);
  const normals=[unit(b.u),unit(b.v),mprPlaneNormal(b)],displayNormal=mprPlaneNormal(source);
  const excluded=viewId!==undefined&&[0,1,2].includes(viewId)?[2,0,1][viewId]!:normals.reduce((best,n,i)=>Math.abs(dot(n,displayNormal))>Math.abs(dot(normals[best]!,displayNormal))?i:best,0);
  return normals.flatMap((normal,i)=>{if(i===excluded)return[];const d=cross(displayNormal,normal);return Math.hypot(...d)>1e-10?[{id:`axis-${i}`,direction:unit(d)}]:[];});
}

export function translateMpr(base:MprPlane,pivot:Vec3,delta:Vec3):MprInteractionResult{
  const plane=validateMprPlane(base);finite(pivot);finite(delta);
  return{plane:validateMprPlane({...plane,origin:add(plane.origin,delta)}),crosshair:add(pivot,delta)};
}

/** Rotate the saved RP about the real blue pivot, even when the current slice is displaced from it. */
export function rotateMpr(base:MprPlane,pivot:Vec3,source:MprPlane,startWorld:Vec3,endWorld:Vec3):MprInteractionResult{
  const plane=validateMprPlane(base);validateMprPlane(source);[pivot,startWorld,endWorld].forEach(finite);
  const normal=mprPlaneNormal(source),a=inPlane(sub(startWorld,pivot),normal),b=inPlane(sub(endWorld,pivot),normal);
  if(Math.hypot(...a)<=1e-9||Math.hypot(...b)<=1e-9)throw new Error('请从蓝色轴线抓取旋转，不能以中心确定旋转角。');
  const angle=Math.atan2(dot(cross(a,b),normal),dot(a,b));
  if(Math.abs(angle)<1e-14)return{plane,crosshair:[...pivot]};
  const cosine=Math.cos(angle),sine=Math.sin(angle),rotate=(v:Vec3)=>add(add(scale(v,cosine),scale(cross(normal,v),sine)),scale(normal,dot(normal,v)*(1-cosine)));
  return{plane:validateMprPlane({...plane,origin:add(pivot,rotate(sub(plane.origin,pivot))),u:rotate(plane.u),v:rotate(plane.v)}),crosshair:[...pivot]};
}

/** An orthogonal mathematical context for an original sheared IJK display; it does not resample that display. */
export function sourceSliceMprPlane(grid:VolumeGrid,axis:Axis,index:number):MprPlane{
  if(![0,1,2].includes(axis)||!Number.isSafeInteger(index)||index<0||index>=grid.dims[axis])throw new Error('原始切片位置无效。');
  const [a,b]=planeAxes(axis),p:Vec3=[0,0,0];p[axis]=index;const origin=physicalPoint(p,grid),pu=[...p] as Vec3,pv=[...p] as Vec3;pu[a]++;pv[b]++;
  const u=sub(physicalPoint(pu,grid),origin),rawV=sub(physicalPoint(pv,grid),origin),normal=cross(u,rawV),up=cross(normal,u),center=[...p] as Vec3;center[a]=(grid.dims[a]-1)/2;center[b]=(grid.dims[b]-1)/2;
  return fitMprPlane(grid,{size:[grid.dims[a],grid.dims[b]],center:physicalPoint(center,grid),normal,up});
}
