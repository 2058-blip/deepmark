import {validateMprPlane,mprPlaneNormal} from './mpr.ts';
import type {MprPlane,Vec3} from './types.ts';
import type {WorldReferenceLine} from './resliceProjectTypes.ts';

const subtract=(a:Vec3,b:Vec3):Vec3=>a.map((n,k)=>n-b[k]!) as Vec3;
const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,k)=>sum+n*b[k]!,0);
const finite=(point:Vec3)=>Array.isArray(point)&&point.length===3&&point.every(Number.isFinite);

/** Physical slice intersections, never a projection of the complete 3D wireframe.
 * Only root's explicit reslice-project-box:N ids are grouped as one convex box. */
export function resliceProjectReferenceLines(lines:readonly WorldReferenceLine[],input:MprPlane):WorldReferenceLine[]{
  const plane=validateMprPlane(input),normal=mprPlaneNormal(plane),output:WorldReferenceLine[]=[],box=lines.filter(line=>/^reslice-project-box:\d+$/.test(line.id));
  let coordinateScale=Math.max(1,...plane.origin.map(Math.abs));for(const line of lines)for(const point of line.points)if(finite(point))for(const n of point)coordinateScale=Math.max(coordinateScale,Math.abs(n));const tolerance=Math.max(1e-7,Number.EPSILON*64*coordinateScale);
  function cut(a:Vec3,b:Vec3):Vec3[]{
    const da=dot(subtract(a,plane.origin),normal),db=dot(subtract(b,plane.origin),normal),onA=Math.abs(da)<=tolerance,onB=Math.abs(db)<=tolerance;
    if(onA&&onB)return[[...a],[...b]];
    if(onA)return[[...a]];if(onB)return[[...b]];if(da*db>=0)return[];
    const t=da/(da-db);return[a.map((n,k)=>n+t*(b[k]!-n)) as Vec3];
  }
  function unique(points:Vec3[]){const result:Vec3[]=[];for(const point of points)if(!result.some(other=>Math.hypot(...subtract(point,other))<=tolerance))result.push(point);return result;}
  if(box.length){
    const crossings:Vec3[]=[];for(const line of box){if(line.points.some(point=>!finite(point)))continue;for(let i=1;i<line.points.length;i++)crossings.push(...cut(line.points[i-1]!,line.points[i]!));}
    const points=unique(crossings);if(points.length>=3){
      const center=points.reduce((sum,p)=>sum.map((n,k)=>n+p[k]!/points.length) as Vec3,[0,0,0] as Vec3),u=plane.u.map(n=>n/Math.hypot(...plane.u)) as Vec3,v=plane.v.map(n=>n/Math.hypot(...plane.v)) as Vec3;
      points.sort((a,b)=>Math.atan2(dot(subtract(a,center),v),dot(subtract(a,center),u))-Math.atan2(dot(subtract(b,center),v),dot(subtract(b,center),u)));points.push([...points[0]!]);
    }
    if(points.length)output.push({id:'reslice-project-box-section',points,color:box[0]!.color,...(box[0]!.label?{label:box[0]!.label}:{})});
  }
  for(const line of lines){if(/^reslice-project-box:\d+$/.test(line.id)||line.points.some(point=>!finite(point)))continue;for(let i=1;i<line.points.length;i++){const points=unique(cut(line.points[i-1]!,line.points[i]!));if(points.length)output.push({...line,id:`${line.id}-section-${i}`,points});}}
  return output;
}
