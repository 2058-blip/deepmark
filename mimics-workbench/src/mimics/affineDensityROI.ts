import {validateAffinePlane,affinePlaneWorldToPixel} from './affinePlane.ts';
import {normalizeDensityROI,densityROIOutline,densityROIMarkers,densityROIHasArea,moveDensityROI,resizeDensityROI,type DensityROIKind,type DensityROIPoints,type DensityROIHandle} from './roiGeometry.ts';
import type {AffinePlane,Vec3} from './types.ts';

const localPlane={axis:2,index:0} as const;
const at=(plane:AffinePlane,point:Vec3):Vec3=>plane.origin.map((v,k)=>v+plane.u[k]!*point[0]+plane.v[k]!*point[1]) as Vec3;
const local=(plane:AffinePlane,world:Vec3):Vec3=>{const result=affinePlaneWorldToPixel(plane,world);if(Math.abs(result.distance)>1e-5)throw new Error('密度 ROI 角点不在保存的仿射平面上。');return[...result.pixel,0];};
function pointsOnPlane(plane:AffinePlane,points:readonly Vec3[]):DensityROIPoints{return normalizeDensityROI(points.map(point=>local(plane,point)),localPlane);}

/** Pixel parameters stay in the saved affine frame; world geometry preserves its full shear. */
export function affineDensityROI(kind:DensityROIKind,points:readonly Vec3[],input:AffinePlane){
  const plane=validateAffinePlane(input),parameters=pointsOnPlane(plane,points),outline=densityROIOutline(kind,parameters,localPlane).map(point=>at(plane,point)),markers=densityROIMarkers(kind,parameters,localPlane).map(marker=>({...marker,point:at(plane,marker.point)}));
  return{plane,parameters,points:parameters.map(point=>at(plane,point)) as DensityROIPoints,outline,markers,hasArea:densityROIHasArea(parameters,localPlane)};
}

/** Resize retains the hit-area grab offset. Both operations clip in the old half-cell FOV. */
export function editAffineDensityROI(input:AffinePlane,points:readonly Vec3[],start:Vec3,current:Vec3,action:'move'|'resize',handle?:DensityROIHandle):DensityROIPoints{
  const plane=validateAffinePlane(input),initial=pointsOnPlane(plane,points),from=local(plane,start),to=local(plane,current),dims:Vec3=[...plane.size,1];let next:DensityROIPoints;
  if(current.every((value,k)=>value===start[k]))return points.map(point=>[...point]) as DensityROIPoints;
  if(action==='move')next=moveDensityROI(initial,from,to,localPlane,dims);
  else{const marker=densityROIMarkers('density-rectangle',initial,localPlane).find(marker=>marker.key===handle);if(!marker)throw new Error('未知仿射密度 ROI 缩放控点。');const position=marker.point.map((v,k)=>v+to[k]!-from[k]!) as Vec3;next=resizeDensityROI(initial,handle!,position,localPlane,dims);}
  return next.map(point=>at(plane,point)) as DensityROIPoints;
}

export function hitAffineDensityROI(shape:ReturnType<typeof affineDensityROI>,project:(point:Vec3)=>[number,number],pointer:[number,number],tolerance=6){
  const center=project(shape.points[0].map((v,k)=>(v+shape.points[1][k]!)/2) as Vec3);
  for(const marker of shape.markers){const point=project(marker.point);if(Math.hypot(point[0]-pointer[0],point[1]-pointer[1])<=tolerance+2){const angle=Math.atan2(point[1]-center[1],point[0]-center[0]),index=((Math.round(angle/(Math.PI/4))%4)+4)%4;return{action:'resize' as const,handle:marker.key,cursor:['ew-resize','nwse-resize','ns-resize','nesw-resize'][index]!};}}
  const outline=shape.outline.map(project);for(let i=0;i<outline.length;i++){const p=outline[i]!,q=outline[(i+1)%outline.length]!,dx=q[0]-p[0],dy=q[1]-p[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((pointer[0]-p[0])*dx+(pointer[1]-p[1])*dy)/length)):0;if(Math.hypot(pointer[0]-p[0]-t*dx,pointer[1]-p[1]-t*dy)<=tolerance)return{action:'move' as const,handle:undefined,cursor:'grab'};}
  return null;
}
