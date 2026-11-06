import type {Axis,MaskObject,MprPlane,Vec3,VolumeGrid} from '../../mimics-workbench/src/mimics/types.ts';
import {worldToVoxel,nearestVoxelCoordinate} from '../../mimics-workbench/src/mimics/measurements.ts';
import {validateMprPlane} from '../../mimics-workbench/src/mimics/mpr.ts';
import type {WorkbenchClaims} from './claims.ts';

export interface AnnotationAuthor {id:string;name:string}
export interface HoverAnnotation {id:string;name:string;color:string;authors:AnnotationAuthor[]}

/** Point queries read one member per Mask and each matching author's sparse bits. */
export function annotationsAtVoxel(masks:readonly MaskObject[],index:number,claims:WorkbenchClaims,names:ReadonlyMap<string,string>):HoverAnnotation[]{
  if(!Number.isSafeInteger(index)||index<0)return[];
  return masks.filter(mask=>mask.visible&&mask.opacity>0&&mask.data[index]===1).map(mask=>({
    id:mask.id,name:mask.name,color:mask.color,
    authors:claims.authorsAt(mask.id,index).map(id=>({id,name:names.get(id)||'未记录姓名'})),
  }));
}

export function imageHoverIndex(point:Vec3|null,dims:Vec3,axis:Axis,slice:number):number|null{
  if(!point||!point.every(Number.isFinite)||!Number.isSafeInteger(slice)||slice<0||slice>=dims[axis])return null;
  const ijk=[...point];ijk[axis]=slice;
  if(ijk.some((value,k)=>value<-.5||value>dims[k]!-.5))return null;
  const p=ijk.map((value,k)=>Math.max(0,Math.min(dims[k]!-1,Math.round(value))));
  return p[0]!+dims[0]*(p[1]!+dims[1]*p[2]!);
}

/** Match the rendered MPR pixel's nearest Mask sample, including half-cell support
 * and reflected/sheared affine rounding. No CT scan or plane-sized allocation. */
export function mprHoverLookup(grid:Pick<VolumeGrid,'dims'|'spacing'|'affine'>,input:MprPlane){
  const plane=validateMprPlane(input),translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0];
  const linear={spacing:grid.spacing,...(grid.affine?{affine:grid.affine.map((row,r)=>r<3?[row[0]!,row[1]!,row[2]!,0]:[...row])}:{})};
  const inverse=([[1,0,0],[0,1,0],[0,0,1]] as Vec3[]).map(axis=>worldToVoxel(axis,linear));
  const vector=(v:Vec3):Vec3=>[0,1,2].map(k=>inverse[0]![k]!*v[0]+inverse[1]![k]!*v[1]+inverse[2]![k]!*v[2]) as Vec3;
  const origin=vector(plane.origin.map((value,k)=>value-translation[k]!) as Vec3),u=vector(plane.u),v=vector(plane.v),[nx,ny]=grid.dims;
  return(pixel:readonly number[]|null):number|null=>{
    if(!pixel||pixel.length!==2||!pixel.every(Number.isFinite)||pixel.some((value,k)=>value<-.5||value>plane.size[k]!-.5))return null;
    const x=Math.max(0,Math.min(plane.size[0]-1,Math.round(pixel[0]!))),y=Math.max(0,Math.min(plane.size[1]-1,Math.round(pixel[1]!)));
    const q=origin.map((value,k)=>value+x*u[k]!+y*v[k]!);
    if(q.some((value,k)=>!Number.isFinite(value)||value<-.5||value>grid.dims[k]!-.5))return null;
    const ijk=q.map((value,k)=>Math.max(0,Math.min(grid.dims[k]!-1,nearestVoxelCoordinate(value))));
    return ijk[0]!+nx*(ijk[1]!+ny*ijk[2]!);
  };
}
