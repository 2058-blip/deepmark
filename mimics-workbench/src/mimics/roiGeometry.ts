import { planeAxes } from '../core.ts';
import type { Axis, SlicePlane, Vec3 } from './types.ts';
import { sliceToScreen, type Point2, type SliceViewport } from './viewportGeometry.ts';

export type DensityROIKind='density-rectangle'|'density-ellipse';
export type DensityROIHandle='nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w';
export type DensityROIPoints=[Vec3,Vec3];
export const isDensityROI=(kind:string):kind is DensityROIKind=>kind==='density-rectangle'||kind==='density-ellipse';
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const handleSides:Record<DensityROIHandle,[number,number]>={nw:[-1,1],n:[0,1],ne:[1,1],e:[1,0],se:[1,-1],s:[0,-1],sw:[-1,-1],w:[-1,0]};
export function normalizeDensityROI(points:readonly Vec3[],plane:SlicePlane):DensityROIPoints {
  if(points.length!==2||points.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v))))throw new Error('密度 ROI 需要两个有限三维角点。');
  const [a,b]=planeAxes(plane.axis),lo=[...points[0]!] as Vec3,hi=[...points[1]!] as Vec3;
  lo[a]=Math.min(points[0]![a],points[1]![a]);hi[a]=Math.max(points[0]![a],points[1]![a]);lo[b]=Math.min(points[0]![b],points[1]![b]);hi[b]=Math.max(points[0]![b],points[1]![b]);lo[plane.axis]=hi[plane.axis]=plane.index;return[lo,hi];
}
export function densityROIFromDrag(start:Vec3,end:Vec3,plane:SlicePlane,dims:Vec3):DensityROIPoints {
  const [a,b]=planeAxes(plane.axis),points=[start,end].map(p=>{const q=[...p] as Vec3;q[a]=clamp(q[a],-.5,dims[a]-.5);q[b]=clamp(q[b],-.5,dims[b]-.5);return q;});return normalizeDensityROI(points,plane);
}
/** Application default spans voxel-axis coordinates; clipping at image support is explicit. */
export function defaultDensityROI(center:Vec3,size:Point2,plane:SlicePlane,dims:Vec3):DensityROIPoints {
  if(size.some(value=>!Number.isFinite(value)||value<=0))throw new Error('密度 ROI 初始宽高须为有限正数。');
  const [a,b]=planeAxes(plane.axis),lo=[...center] as Vec3,hi=[...center] as Vec3;lo[a]-=size[0]/2;hi[a]+=size[0]/2;lo[b]-=size[1]/2;hi[b]+=size[1]/2;return densityROIFromDrag(lo,hi,plane,dims);
}
export function moveDensityROI(points:DensityROIPoints,start:Vec3,current:Vec3,plane:SlicePlane,dims:Vec3):DensityROIPoints {
  const [a,b]=planeAxes(plane.axis),[lo,hi]=normalizeDensityROI(points,plane);for(const axis of [a,b]){const delta=clamp(current[axis]-start[axis],-.5-lo[axis],dims[axis]-.5-hi[axis]);lo[axis]+=delta;hi[axis]+=delta;}return[lo,hi];
}
export function resizeDensityROI(points:DensityROIPoints,handle:DensityROIHandle,current:Vec3,plane:SlicePlane,dims:Vec3):DensityROIPoints {
  const [a,b]=planeAxes(plane.axis),[lo,hi]=normalizeDensityROI(points,plane),sides=handleSides[handle];for(const [index,axis] of [a,b].entries()){const value=clamp(current[axis],-.5,dims[axis]-.5);if(sides[index]===-1)lo[axis]=value;else if(sides[index]===1)hi[axis]=value;}return normalizeDensityROI([lo,hi],plane);
}
export function densityROIHasArea(points:DensityROIPoints,plane:SlicePlane):boolean {
  const [a,b]=planeAxes(plane.axis),epsilon=Number.EPSILON*32*Math.max(1,...points.flat().map(Math.abs));return Math.abs(points[1][a]-points[0][a])>epsilon&&Math.abs(points[1][b]-points[0][b])>epsilon;
}
export function densityROIOutline(kind:DensityROIKind,points:DensityROIPoints,plane:SlicePlane):Vec3[] {
  const [a,b]=planeAxes(plane.axis),[lo,hi]=normalizeDensityROI(points,plane),cx=(lo[a]+hi[a])/2,cy=(lo[b]+hi[b])/2,rx=(hi[a]-lo[a])/2,ry=(hi[b]-lo[b])/2;
  const unit=kind==='density-rectangle'?[[-1,-1],[1,-1],[1,1],[-1,1]]:Array.from({length:128},(_,i)=>[Math.cos(i*Math.PI/64),Math.sin(i*Math.PI/64)]);return unit.map(([x,y])=>{const p=[...lo] as Vec3;p[a]=cx+rx*x!;p[b]=cy+ry*y!;return p;});
}
export function densityROIMarkers(kind:DensityROIKind,points:DensityROIPoints,plane:SlicePlane){
  const [a,b]=planeAxes(plane.axis),[lo,hi]=normalizeDensityROI(points,plane),keys:DensityROIHandle[]=kind==='density-ellipse'?['n','e','s','w']:['nw','n','ne','e','se','s','sw','w'];return keys.map(key=>{const [u,v]=handleSides[key],point=[...lo] as Vec3;point[a]=(lo[a]+hi[a])/2+u*(hi[a]-lo[a])/2;point[b]=(lo[b]+hi[b])/2+v*(hi[b]-lo[b])/2;return{key,point};});
}
export function densityROIPointer(view:SliceViewport,point:Point2,slice:number,clip=false):Vec3|null {
  const [a,,c,d,e,f]=view.transform,y=(point[1]-f)/d,x=(point[0]-e-c*y)/a;
  if(!clip&&(x < -1e-9||y < -1e-9||x>view.nx+1e-9||y>view.ny+1e-9))return null;
  const p:Vec3=[0,0,0];p[view.axis]=slice;p[view.a]=clamp(x-.5,-.5,view.nx-.5);p[view.b]=clamp(view.ny-.5-y,-.5,view.ny-.5);return p;
}
export function hitDensityROI(view:SliceViewport,kind:DensityROIKind,points:DensityROIPoints,plane:SlicePlane,point:Point2,tolerance=6):{action:'move'|'resize';handle?:DensityROIHandle;cursor:string}|null {
  const [a,b]=planeAxes(plane.axis),center=[...points[0]] as Vec3;center[a]=(points[0][a]+points[1][a])/2;center[b]=(points[0][b]+points[1][b])/2;const sc=sliceToScreen(view,center);
  for(const marker of densityROIMarkers(kind,points,plane)){const p=sliceToScreen(view,marker.point);if(Math.hypot(p[0]-point[0],p[1]-point[1])<=tolerance+2){const angle=(Math.atan2(p[1]-sc[1],p[0]-sc[0])+Math.PI*2)%Math.PI,index=Math.round(angle/(Math.PI/4))%4;return{action:'resize',handle:marker.key,cursor:['ew-resize','nwse-resize','ns-resize','nesw-resize'][index]!};}}
  const outline=densityROIOutline(kind,points,plane).map(p=>sliceToScreen(view,p));for(let i=0;i<outline.length;i++){const p=outline[i]!,q=outline[(i+1)%outline.length]!,dx=q[0]-p[0],dy=q[1]-p[1],length=dx*dx+dy*dy,t=length?clamp(((point[0]-p[0])*dx+(point[1]-p[1])*dy)/length,0,1):0;if(Math.hypot(point[0]-p[0]-t*dx,point[1]-p[1]-t*dy)<=tolerance)return{action:'move',cursor:'grab'};}return null;
}
