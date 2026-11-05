import {nearestVoxelCoordinate,worldToVoxel} from './measurements.ts';
import {physicalPoint,requireGrid,type AlgorithmControl,type Vec3,type VolumeGrid} from './types.ts';

export const MAX_RESLICE_PROJECT_DIMENSION=32_767;
export const DEFAULT_RESLICE_PROJECT_MAX_VOXELS=16*1024*1024;
export const MAX_RESLICE_PROJECT_VOXELS=128*1024*1024;
export const DEFAULT_RESLICE_PROJECT_MAX_BYTES=256*1024*1024;
export const MAX_RESLICE_PROJECT_BYTES=512*1024*1024;
export const MAX_RESLICE_PROJECT_MASKS=1024;
/** Width/height are output sample counts. Native dialog physical dimensions need explicit UI quantization. */
export interface ResliceProjectGeometryOptions extends AlgorithmControl {
  start:Vec3;end:Vec3;up?:Vec3;rotationDegrees?:number;width:number;height:number;
  pixelSize:number;sliceDistance:number;updateCoordinateSystem?:boolean;
  interpolation?:'linear'|'nearest';background?:number;maxVoxels?:number;maxBytes?:number;
}
export interface ResliceProjectMaskInput {id:string;data:Uint8Array}
export interface ResliceProjectMaskOutput extends ResliceProjectMaskInput {count:number}
export interface ResliceProjectBounds {min:Vec3;max:Vec3}
export interface ResliceProjectGeometry {
  sliceCount:number;lineLength:number;lastSliceDistance:number;remainingDistance:number;
  /** Source-world centers/origin, and source-world unit column/row/stack directions. */
  firstCenter:Vec3;lastCenter:Vec3;sourceOrigin:Vec3;u:Vec3;v:Vec3;normal:Vec3;
  sampleCenterCorners:Vec3[];supportCorners:Vec3[];
}
export interface ResliceProjectPlan {
  dims:Vec3;spacing:Vec3;affine:number[][];
  sourceWorldToOutputWorld:number[][];outputWorldToSourceWorld:number[][];
  geometry:ResliceProjectGeometry;
  physicalBounds:{sourceWorld:ResliceProjectBounds;outputWorld:ResliceProjectBounds};
  supportBounds:{sourceWorld:ResliceProjectBounds;outputWorld:ResliceProjectBounds};
}
export interface ResliceProjectGeometryResult extends ResliceProjectPlan {
  data:Float32Array;masks:ResliceProjectMaskOutput[];
  coverage:{totalVoxels:number;grayValid:number;grayOutside:number;grayNonfinite:number;maskSupported:number;maskOutside:number};
}
const CENTER_TOLERANCE=1e-7;
const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,n:number):Vec3=>[a[0]*n,a[1]*n,a[2]*n];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function finiteVector(v:unknown):asserts v is Vec3 {if(!Array.isArray(v)||v.length!==3||![v[0],v[1],v[2]].every(Number.isFinite))throw new Error('Reslice Project坐标必须是有限三维向量。');}
function unit(v:Vec3):Vec3 {finiteVector(v);const length=Math.hypot(...v);if(!Number.isFinite(length)||length===0)throw new Error('Reslice Project方向或线段必须具有正有限长度。');return[v[0]/length,v[1]/length,v[2]/length];}
function budget(n:number,maximum:number):number {if(!Number.isSafeInteger(n)||n<=0||n>maximum)throw new Error(`Reslice Project预算必须是1至${maximum}的整数。`);return n;}
function dimension(n:number):number {if(!Number.isSafeInteger(n)||n<=0||n>MAX_RESLICE_PROJECT_DIMENSION)throw new Error(`Reslice Project每维样本数须为1至${MAX_RESLICE_PROJECT_DIMENSION}的整数。`);return n;}
function check(options:AlgorithmControl,fraction?:number):void {const abort=()=>{if(options.cancelled?.()){const error=new Error('Reslice Project已取消，源工程未修改。');error.name='AbortError';throw error;}};abort();if(fraction!==undefined)options.progress?.(fraction);abort();}
const identity=()=>[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
const matrix=(u:Vec3,v:Vec3,n:Vec3,origin:Vec3)=>[[u[0],v[0],n[0],origin[0]],[u[1],v[1],n[1],origin[1]],[u[2],v[2],n[2],origin[2]],[0,0,0,1]];
function bounds(points:Vec3[]):ResliceProjectBounds {points.forEach(finiteVector);return{min:[0,1,2].map(k=>Math.min(...points.map(p=>p[k]!))) as Vec3,max:[0,1,2].map(k=>Math.max(...points.map(p=>p[k]!))) as Vec3};}
function optionsValid(options:ResliceProjectGeometryOptions):void {
  finiteVector(options.start);finiteVector(options.end);if(options.up!==undefined)finiteVector(options.up);
  dimension(options.width);dimension(options.height);
  if(!Number.isFinite(options.pixelSize)||options.pixelSize<=0||!Number.isFinite(options.sliceDistance)||options.sliceDistance<=0)throw new Error('Reslice Project像素尺寸与层距必须是正有限毫米值。');
  if(options.rotationDegrees!==undefined&&!Number.isFinite(options.rotationDegrees))throw new Error('Reslice Project绕线角必须是有限角度。');
  if(options.updateCoordinateSystem!==undefined&&typeof options.updateCoordinateSystem!=='boolean')throw new Error('Reslice Project Update CS必须为布尔值。');
  if(options.interpolation!==undefined&&options.interpolation!=='linear'&&options.interpolation!=='nearest')throw new Error('Reslice Project灰度插值方式无效。');
  if(options.background!==undefined&&(!Number.isFinite(options.background)||!Number.isFinite(Math.fround(options.background))))throw new Error('Reslice Project背景值必须可表示为有限Float32。');
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function'||options.progress!==undefined&&typeof options.progress!=='function')throw new Error('Reslice Project控制回调必须是函数。');
  budget(options.maxVoxels??DEFAULT_RESLICE_PROJECT_MAX_VOXELS,MAX_RESLICE_PROJECT_VOXELS);budget(options.maxBytes??DEFAULT_RESLICE_PROJECT_MAX_BYTES,MAX_RESLICE_PROJECT_BYTES);
}

/** No image allocation: source-world geometry, transforms and both center/support bounding boxes. */
export function createResliceProjectGeometry(options:ResliceProjectGeometryOptions):ResliceProjectPlan {
  optionsValid(options);check(options);
  const delta=sub(options.end,options.start),lineLength=Math.hypot(...delta),normal=unit(delta);
  let intervals=Math.floor(lineLength/options.sliceDistance);
  // Division can round a just-below-integer quotient upward; retain a strictly non-overshooting grid.
  if(Number.isFinite(intervals)&&intervals*options.sliceDistance>lineLength)intervals--;
  const sliceCount=dimension(intervals+1),dims:Vec3=[options.width,options.height,sliceCount],count=dims[0]*dims[1]*dims[2];
  if(!Number.isSafeInteger(count)||count>(options.maxVoxels??DEFAULT_RESLICE_PROJECT_MAX_VOXELS))throw new Error('Reslice Project输出超过体素预算。');
  if(count*4>(options.maxBytes??DEFAULT_RESLICE_PROJECT_MAX_BYTES))throw new Error('Reslice Project输出超过内存预算。');
  const fallback:Vec3=Math.abs(normal[1])<.9?[0,1,0]:[1,0,0];
  let chosen=options.up??fallback,chosenLength=Math.hypot(...chosen);if(!Number.isFinite(chosenLength))throw new Error('Reslice Project行方向超出有限数值范围。');
  chosen=chosenLength?unit(chosen):fallback;
  let projected=sub(chosen,scale(normal,dot(chosen,normal)));if(Math.hypot(...projected)<=1e-10)projected=sub(fallback,scale(normal,dot(fallback,normal)));
  const row=unit(projected),column=unit(cross(row,normal)),angle=((options.rotationDegrees??0)%360)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),u=add(scale(column,c),scale(row,s)),v=add(scale(row,c),scale(column,-s));
  const stepU=scale(u,options.pixelSize),stepV=scale(v,options.pixelSize),stepN=scale(normal,options.sliceDistance),lastSliceDistance=intervals*options.sliceDistance;
  const sourceOrigin=sub(options.start,add(scale(stepU,(dims[0]-1)/2),scale(stepV,(dims[1]-1)/2))),lastCenter=add(options.start,scale(normal,lastSliceDistance));finiteVector(sourceOrigin);finiteVector(lastCenter);
  const corners=(support:boolean)=>{const result:Vec3[]=[];for(const z of support?[-.5,dims[2]-.5]:[0,dims[2]-1])for(const y of support?[-.5,dims[1]-.5]:[0,dims[1]-1])for(const x of support?[-.5,dims[0]-.5]:[0,dims[0]-1])result.push(add(sourceOrigin,add(scale(stepU,x),add(scale(stepV,y),scale(stepN,z)))));result.forEach(finiteVector);return result;};
  const sampleCenterCorners=corners(false),supportCorners=corners(true),update=options.updateCoordinateSystem===true;
  const toOutput=update?[[...u,-dot(u,sourceOrigin)],[...v,-dot(v,sourceOrigin)],[...normal,-dot(normal,sourceOrigin)],[0,0,0,1]]:identity(),toSource=update?matrix(u,v,normal,sourceOrigin):identity();
  if([...toOutput.flat(),...toSource.flat()].some(n=>!Number.isFinite(n)))throw new Error('Reslice Project坐标变换超出有限数值范围。');
  const outputCorners=(support:boolean)=>{const result:Vec3[]=[];for(const z of support?[-.5,dims[2]-.5]:[0,dims[2]-1])for(const y of support?[-.5,dims[1]-.5]:[0,dims[1]-1])for(const x of support?[-.5,dims[0]-.5]:[0,dims[0]-1])result.push([x*options.pixelSize,y*options.pixelSize,z*options.sliceDistance]);return result;};
  return{dims,spacing:[options.pixelSize,options.pixelSize,options.sliceDistance],affine:update?[[options.pixelSize,0,0,0],[0,options.pixelSize,0,0],[0,0,options.sliceDistance,0],[0,0,0,1]]:matrix(stepU,stepV,stepN,sourceOrigin),sourceWorldToOutputWorld:toOutput,outputWorldToSourceWorld:toSource,
    geometry:{sliceCount,lineLength,lastSliceDistance,remainingDistance:lineLength-lastSliceDistance,firstCenter:[...options.start],lastCenter,sourceOrigin,u,v,normal,sampleCenterCorners,supportCorners},physicalBounds:{sourceWorld:bounds(sampleCenterCorners),outputWorld:bounds(update?outputCorners(false):sampleCenterCorners)},supportBounds:{sourceWorld:bounds(supportCorners),outputWorld:bounds(update?outputCorners(true):supportCorners)}};
}

/** New 3D gray and independent nearest Mask volumes; never changes source buffers or creates headers. */
export function resliceProject(grid:VolumeGrid,options:ResliceProjectGeometryOptions,inputMasks:readonly ResliceProjectMaskInput[]=[]):ResliceProjectGeometryResult {
  const plan=createResliceProjectGeometry(options);check(options,0);finiteVector(grid.dims);finiteVector(grid.spacing);const sourceCount=requireGrid(grid);
  if(!(grid.data instanceof Float32Array)||!Number.isSafeInteger(sourceCount)||sourceCount<=0)throw new Error('Reslice Project源数据必须是有效Float32体积。');
  if(grid.affine!==undefined){
    if(!Array.isArray(grid.affine)||![3,4].includes(grid.affine.length)||Array.from(grid.affine).some(row=>!Array.isArray(row)||row.length!==4||![row[0],row[1],row[2],row[3]].every(Number.isFinite)))throw new Error('Reslice Project源方向矩阵必须是有限3×4或4×4。');
    if(grid.affine.length===4&&grid.affine[3]!.some((n,k)=>n!==(k===3?1:0)))throw new Error('Reslice Project不支持透视方向矩阵。');
  }
  if(!Array.isArray(inputMasks)||inputMasks.length>MAX_RESLICE_PROJECT_MASKS)throw new Error(`Reslice Project最多支持${MAX_RESLICE_PROJECT_MASKS}个独立Mask。`);
  const ids=new Set<string>();for(const mask of inputMasks){if(!mask||typeof mask.id!=='string'||!mask.id||ids.has(mask.id)||!(mask.data instanceof Uint8Array)||mask.data.length!==sourceCount)throw new Error('Reslice Project独立Mask标识、类型或尺寸无效。');ids.add(mask.id);}
  const count=plan.dims[0]*plan.dims[1]*plan.dims[2],bytes=count*(4+inputMasks.length);if(!Number.isSafeInteger(bytes)||bytes>(options.maxBytes??DEFAULT_RESLICE_PROJECT_MAX_BYTES))throw new Error('Reslice Project灰度和独立Mask输出超过内存预算。');
  const sourceMaskBytes=sourceCount*inputMasks.length;if(!Number.isSafeInteger(sourceMaskBytes))throw new Error('Reslice Project源Mask验证工作量超出安全整数范围。');
  for(let m=0;m<inputMasks.length;m++)for(let i=0;i<sourceCount;i++){
    if((i&65535)===0)check(options,.1*(m*sourceCount+i)/sourceMaskBytes);
    const member=inputMasks[m]!.data[i];if(member!==0&&member!==1)throw new Error('Reslice Project源Mask必须只含0/1二进制成员。');
  }
  check(options,.1);
  for(const x of [-.5,grid.dims[0]-.5])for(const y of [-.5,grid.dims[1]-.5])for(const z of [-.5,grid.dims[2]-.5])finiteVector(physicalPoint([x,y,z],grid));
  const translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0],linear={spacing:grid.spacing,...(grid.affine?{affine:grid.affine.slice(0,3).map(row=>[row[0]!,row[1]!,row[2]!,0])}:{})};
  const inverse=[worldToVoxel([1,0,0],linear),worldToVoxel([0,1,0],linear),worldToVoxel([0,0,1],linear)];inverse.forEach(finiteVector);
  const toVoxel=(v:Vec3):Vec3=>[0,1,2].map(k=>inverse[0]![k]!*v[0]+inverse[1]![k]!*v[1]+inverse[2]![k]!*v[2]) as Vec3;
  const origin=toVoxel(sub(plan.geometry.sourceOrigin,translation)),du=toVoxel(scale(plan.geometry.u,options.pixelSize)),dv=toVoxel(scale(plan.geometry.v,options.pixelSize)),dn=toVoxel(scale(plan.geometry.normal,options.sliceDistance));[origin,du,dv,dn].forEach(finiteVector);
  for(const z of [-.5,plan.dims[2]-.5])for(const y of [-.5,plan.dims[1]-.5])for(const x of [-.5,plan.dims[0]-.5])finiteVector(add(origin,add(scale(du,x),add(scale(dv,y),scale(dn,z)))));
  let data:Float32Array,masks:ResliceProjectMaskOutput[];try{data=new Float32Array(count);data.fill(options.background??0);masks=inputMasks.map(mask=>({id:mask.id,data:new Uint8Array(count),count:0}));}catch{throw new Error('Reslice Project输出分配失败，源工程未修改。');}
  const coverage={totalVoxels:count,grayValid:0,grayOutside:0,grayNonfinite:0,maskSupported:0,maskOutside:0},[nx,ny,nz]=grid.dims,nearest=options.interpolation==='nearest';
  for(let z=0,index=0;z<plan.dims[2];z++)for(let y=0;y<plan.dims[1];y++)for(let x=0;x<plan.dims[0];x++,index++){
    if((index&4095)===0)check(options,.1+.9*index/count);
    const vx=origin[0]+x*du[0]+y*dv[0]+z*dn[0],vy=origin[1]+x*du[1]+y*dv[1]+z*dn[1],vz=origin[2]+x*du[2]+y*dv[2]+z*dn[2];
    if(!Number.isFinite(vx)||!Number.isFinite(vy)||!Number.isFinite(vz))throw new Error('Reslice Project采样坐标超出有限数值范围。');
    let sourceIndex=-1;
    if(vx>=-.5&&vx<=nx-.5&&vy>=-.5&&vy<=ny-.5&&vz>=-.5&&vz<=nz-.5){
      coverage.maskSupported++;const ix=Math.max(0,Math.min(nx-1,nearestVoxelCoordinate(vx))),iy=Math.max(0,Math.min(ny-1,nearestVoxelCoordinate(vy))),iz=Math.max(0,Math.min(nz-1,nearestVoxelCoordinate(vz)));sourceIndex=ix+nx*(iy+ny*iz);
      for(let m=0;m<masks.length;m++){const value=inputMasks[m]!.data[sourceIndex]!;masks[m]!.data[index]=value;if(value)masks[m]!.count++;}
    }else coverage.maskOutside++;
    if(vx<-CENTER_TOLERANCE||vx>nx-1+CENTER_TOLERANCE||vy<-CENTER_TOLERANCE||vy>ny-1+CENTER_TOLERANCE||vz<-CENTER_TOLERANCE||vz>nz-1+CENTER_TOLERANCE){coverage.grayOutside++;continue;}
    let value:number;
    if(nearest){
      if(sourceIndex<0)throw new Error('Reslice Project源支持数值状态无效。');value=grid.data[sourceIndex]!;
    }else{
      const qx=Math.max(0,Math.min(nx-1,vx)),qy=Math.max(0,Math.min(ny-1,vy)),qz=Math.max(0,Math.min(nz-1,vz)),x0=Math.floor(qx),y0=Math.floor(qy),z0=Math.floor(qz),x1=Math.min(nx-1,x0+1),y1=Math.min(ny-1,y0+1),z1=Math.min(nz-1,z0+1),fx=qx-x0,fy=qy-y0,fz=qz-z0;value=0;
      for(let az=0;az<2;az++)for(let ay=0;ay<2;ay++)for(let ax=0;ax<2;ax++){
        const weight=(ax?fx:1-fx)*(ay?fy:1-fy)*(az?fz:1-fz);if(weight<=0)continue;
        const sample=grid.data[(ax?x1:x0)+nx*((ay?y1:y0)+ny*(az?z1:z0))]!;if(!Number.isFinite(sample)){value=NaN;continue;}value+=weight*sample;
      }
    }
    if(Number.isFinite(value)&&Number.isFinite(Math.fround(value))){data[index]=value;coverage.grayValid++;}else coverage.grayNonfinite++;
  }
  check(options,1);return{...plan,data,masks,coverage};
}
