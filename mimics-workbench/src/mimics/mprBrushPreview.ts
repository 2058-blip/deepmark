import {worldToVoxel,nearestVoxelCoordinate} from './measurements.ts';
import {validateMprPlane} from './mpr.ts';
import type {MprPlane,Vec3,VolumeGrid} from './types.ts';

let lastMprBrushStrokeId=0;
/** Shared by every MPR pane; ids never wrap or restart for a component setup. */
export function nextMprBrushStrokeId():number{
  if(lastMprBrushStrokeId>=Number.MAX_SAFE_INTEGER)throw new Error('MPR 笔画标识已耗尽，请重新加载页面。');
  return ++lastMprBrushStrokeId;
}

/** Current-plane display lookup only. Never scans/copies a source Mask or samples gray values. */
export function mprBrushPreviewIndices(grid:Pick<VolumeGrid,'dims'|'spacing'|'affine'>,input:MprPlane):Int32Array{
  const plane=validateMprPlane(input),count=grid.dims.reduce((a,b)=>a*b,1);
  if(grid.dims.length!==3||grid.dims.some(n=>!Number.isSafeInteger(n)||n<=0)||!Number.isSafeInteger(count)||count>0x7fffffff)throw new Error('MPR 笔画预览的源尺寸无效或超出索引范围。');
  const translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0];
  if(translation.some(n=>!Number.isFinite(n)))throw new Error('MPR 笔画预览的空间平移必须为有限数。');
  const linear={spacing:grid.spacing,...(grid.affine?{affine:grid.affine.map((row,r)=>r<3?[row[0]!,row[1]!,row[2]!,0]:[...row])}:{})};
  // Match prepareMprSampler's relative affine arithmetic, including two-ULP half ties.
  const inverse=([[1,0,0],[0,1,0],[0,0,1]] as Vec3[]).map(axis=>worldToVoxel(axis,linear));
  const vectorToVoxel=(v:Vec3):Vec3=>[0,1,2].map(k=>inverse[0]![k]!*v[0]+inverse[1]![k]!*v[1]+inverse[2]![k]!*v[2]) as Vec3;
  const origin=vectorToVoxel(plane.origin.map((n,k)=>n-translation[k]!) as Vec3),u=vectorToVoxel(plane.u),v=vectorToVoxel(plane.v),[nx,ny,nz]=grid.dims;
  const indices=new Int32Array(plane.size[0]*plane.size[1]);indices.fill(-1);
  for(let y=0,i=0;y<plane.size[1];y++)for(let x=0;x<plane.size[0];x++,i++){
    const a=origin[0]+x*u[0]+y*v[0],b=origin[1]+x*u[1]+y*v[1],c=origin[2]+x*u[2]+y*v[2];
    if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(c)||a<-.5||a>nx-.5||b<-.5||b>ny-.5||c<-.5||c>nz-.5)continue;
    // Support includes the outer half-cell. A rounded border is clamped exactly as Mask sampling.
    const ix=Math.max(0,Math.min(nx-1,nearestVoxelCoordinate(a))),iy=Math.max(0,Math.min(ny-1,nearestVoxelCoordinate(b))),iz=Math.max(0,Math.min(nz-1,nearestVoxelCoordinate(c)));
    indices[i]=ix+nx*(iy+ny*iz);
  }
  return indices;
}
