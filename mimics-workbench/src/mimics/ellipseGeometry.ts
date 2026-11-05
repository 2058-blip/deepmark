import { evaluateMeasurement } from './measurements.ts';
import type { MeasurementObject, Vec3 } from './types.ts';

export interface EllipseFrame { center: Vec3; u: Vec3; v: Vec3; normal: Vec3; a: number; b: number }
export type EllipseHandleId = 'u-'|'u+'|'v-'|'v+'|'center'|'rotate--'|'rotate-+'|'rotate++'|'rotate+-';
export interface EllipseHandle { id: EllipseHandleId; kind: 'resize'|'move'|'rotate'; position: Vec3 }
const EPS = 1e-9;
const add = (a: Vec3, b: Vec3): Vec3 => a.map((n,k)=>n+b[k]!) as Vec3;
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((n,k)=>n-b[k]!) as Vec3;
const scale = (a: Vec3, n: number): Vec3 => a.map(v=>v*n) as Vec3;
const dot = (a: Vec3, b: Vec3) => a.reduce((s,n,k)=>s+n*b[k]!,0);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function finite(p: readonly number[]): void { if(p.length!==3||p.some(n=>!Number.isFinite(n)))throw new Error('椭圆坐标必须是有限三维向量。'); }
const onPlane = (p: Vec3, normal: Vec3) => sub(p,scale(normal,dot(p,normal)));

/** Keep the stored axis order; D1/D2 sorting belongs only to the evaluator. */
export function ellipseFrame(points: readonly Vec3[]): EllipseFrame {
  if(points.length!==3)throw new Error('椭圆需要三个世界坐标点。');
  points.forEach(finite);
  const center=add(scale(points[0]!,.5),scale(points[1]!,.5)),axis=sub(points[1]!,points[0]!),a=Math.hypot(...axis)/2;
  if(!Number.isFinite(a)||a<=EPS)throw new Error('椭圆第一轴不能为零。');
  const u=scale(axis,1/(2*a)),delta=sub(points[2]!,center),perpendicular=sub(delta,scale(u,dot(delta,u))),b=Math.hypot(...perpendicular);
  if(!Number.isFinite(b)||b<=EPS)throw new Error('椭圆第二轴不能为零。');
  const v=scale(perpendicular,1/b),normal=cross(u,v);finite(center);finite(normal);
  return {center,u,v,normal,a,b};
}

export function ellipsePoints(frame: EllipseFrame): [Vec3,Vec3,Vec3] {
  const {center,u,v,a,b}=frame;
  [center,u,v,frame.normal].forEach(finite);
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<=EPS||b<=EPS)throw new Error('椭圆轴长度必须大于零。');
  const points:[Vec3,Vec3,Vec3]=[sub(center,scale(u,a)),add(center,scale(u,a)),add(center,scale(v,b))];
  points.forEach(finite);return points;
}

export function ellipseHandles(points: readonly Vec3[]): EllipseHandle[] {
  const f=ellipseFrame(points),at=(x:number,y:number)=>add(f.center,add(scale(f.u,x*f.a),scale(f.v,y*f.b)));
  return [
    {id:'u-',kind:'resize',position:at(-1,0)},{id:'u+',kind:'resize',position:at(1,0)},
    {id:'v-',kind:'resize',position:at(0,-1)},{id:'v+',kind:'resize',position:at(0,1)},
    {id:'center',kind:'move',position:[...f.center]},
    {id:'rotate--',kind:'rotate',position:at(-1,-1)},{id:'rotate-+',kind:'rotate',position:at(-1,1)},
    {id:'rotate++',kind:'rotate',position:at(1,1)},{id:'rotate+-',kind:'rotate',position:at(1,-1)},
  ];
}

export function moveEllipse(points: readonly Vec3[], delta: Vec3): [Vec3,Vec3,Vec3] {
  finite(delta);const f=ellipseFrame(points);return ellipsePoints({...f,center:add(f.center,onPlane(delta,f.normal))});
}

/** Opposite axis ends move symmetrically about the frozen center. */
export function resizeEllipse(points: readonly Vec3[], handleId: string, worldPosition: Vec3): [Vec3,Vec3,Vec3] {
  finite(worldPosition);const f=ellipseFrame(points),delta=sub(worldPosition,f.center);
  if(handleId==='u-'||handleId==='u+')f.a=Math.abs(dot(delta,f.u));
  else if(handleId==='v-'||handleId==='v+')f.b=Math.abs(dot(delta,f.v));
  else throw new Error('未知椭圆轴端点。');
  return ellipsePoints(f);
}

export function rotateEllipse(points: readonly Vec3[], fromWorld: Vec3, toWorld: Vec3): [Vec3,Vec3,Vec3] {
  finite(fromWorld);finite(toWorld);const f=ellipseFrame(points),from=onPlane(sub(fromWorld,f.center),f.normal),to=onPlane(sub(toWorld,f.center),f.normal);
  if(Math.hypot(...from)<=EPS||Math.hypot(...to)<=EPS)throw new Error('旋转方向不能位于椭圆中心。');
  const angle=Math.atan2(dot(cross(from,to),f.normal),dot(from,to)),c=Math.cos(angle),s=Math.sin(angle);
  return ellipsePoints({...f,u:add(scale(f.u,c),scale(f.v,s)),v:add(scale(f.v,c),scale(f.u,-s))});
}

/** World anchor shared by image and Part labels. Invalid previews retain a finite fallback. */
export function measurementLabelAnchor(measurement: MeasurementObject): Vec3 {
  const p=measurement.points.filter(q=>q.length===3&&q.every(Number.isFinite));
  if(!p.length)return[0,0,0];
  if(measurement.kind==='annotation')return[...p[Math.min(1,p.length-1)]!];
  if(measurement.kind==='angle')return[...p[Math.min(1,p.length-1)]!];
  if(measurement.kind==='ellipse'&&p.length===3)return add(scale(p[0]!,.5),scale(p[1]!,.5));
  if(measurement.kind==='area'){
    const result=evaluateMeasurement('area',p),centroid=result.details.centroid as Vec3|undefined;
    if(result.valid&&centroid)return[...centroid];
  }
  return p.reduce((sum,q)=>add(sum,scale(q,1/p.length)),[0,0,0] as Vec3);
}
export function measurementLabelPosition(measurement: MeasurementObject): Vec3 {
  const offset=measurement.kind==='annotation'?[0,0,0] as Vec3:measurement.labelOffset??[0,0,0];finite(offset);
  return add(measurementLabelAnchor(measurement),offset);
}
