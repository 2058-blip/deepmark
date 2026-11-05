import { physicalPoint, requireGrid, voxelIndex, type Vec3, type VolumeGrid } from './types.ts';

export interface TransferPoint { value: number; color: Vec3; opacity: number }
export type VolumePreset = 'bone' | 'soft' | 'both';
export interface RenderingLimits { max3DTextureSize?: number; maxTextureBytes?: number }
export interface VolumeGeometry {
  voxelToWorld: number[][];
  worldToVoxel: number[][];
  worldToTexture: number[][];
  physicalVoxelSize: Vec3;
  bounds: { min: Vec3; max: Vec3; center: Vec3; size: Vec3; radius: number };
}
export interface VolumeRenderingInfo extends VolumeGeometry { voxelCount: number; textureBytes: number; min: number; max: number }
const dot = (a: Vec3, b: Vec3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = (p: Vec3) => Math.hypot(...p);
function finitePoint(p: readonly number[], name: string) { if(p.length!==3||p.some(v=>!Number.isFinite(v)))throw new Error(`${name}必须是有限三维坐标。`); }

/** Full affine geometry of the physical voxel support, from -0.5 to dims-0.5 centres. */
export function volumeGeometry(grid: Pick<VolumeGrid,'dims'|'spacing'|'affine'>): VolumeGeometry {
  if(grid.dims.length!==3||grid.spacing.length!==3||grid.dims.some(d=>!Number.isSafeInteger(d)||d<1)||grid.spacing.some(s=>!Number.isFinite(s)||s<=0))throw new Error('体绘制尺寸或间距无效。');
  const a=grid.affine ? grid.affine.map(r=>[...r]) : [[grid.spacing[0],0,0,0],[0,grid.spacing[1],0,0],[0,0,grid.spacing[2],0],[0,0,0,1]];
  if(a.length<3||a.slice(0,3).some(r=>r.length<4||r.slice(0,4).some(v=>!Number.isFinite(v))))throw new Error('体绘制 affine 无效。');
  if(a.length>3&&(a[3]!.length<4||a[3]!.slice(0,4).some((v,k)=>!Number.isFinite(v)||Math.abs(v-(k===3?1:0))>1e-12)))throw new Error('体绘制只接受仿射矩阵。');
  a[3]=[0,0,0,1];
  const x:Vec3=[a[0]![0]!,a[1]![0]!,a[2]![0]!],y:Vec3=[a[0]![1]!,a[1]![1]!,a[2]![1]!],z:Vec3=[a[0]![2]!,a[1]![2]!,a[2]![2]!];
  const determinant=dot(x,cross(y,z));
  if(Math.abs(determinant)<=Number.EPSILON*norm(x)*norm(y)*norm(z)*32)throw new Error('体绘制 affine 不可逆或接近奇异。');
  const inverseRows=[cross(y,z),cross(z,x),cross(x,y)].map(row=>row.map(v=>v/determinant));
  const b=inverseRows.map(row=>[...row,-row.reduce((s,v,k)=>s+v*a[k]![3]!,0)]);b.push([0,0,0,1]);
  const worldToTexture=b.map((row,r)=>r<3?row.map((v,c)=>(v+(c===3?.5:0))/grid.dims[r]!):[...row]);
  const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
  for(let code=0;code<8;code++){
    const p=physicalPoint([0,1,2].map(k=>(code&(1<<k))?grid.dims[k]!-.5:-.5),{spacing:grid.spacing,affine:a});
    for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,p[k]!);max[k]=Math.max(max[k]!,p[k]!);}
  }
  const size=max.map((v,k)=>v-min[k]!) as Vec3,center=min.map((v,k)=>(v+max[k]!)/2) as Vec3;
  return {voxelToWorld:a,worldToVoxel:b,worldToTexture,physicalVoxelSize:[norm(x),norm(y),norm(z)],bounds:{min,max,center,size,radius:Math.max(1e-6,norm(size)/2)}};
}
export function transformVolumePoint(matrix: readonly (readonly number[])[], p: Vec3, direction=false): Vec3 {
  return [0,1,2].map(r=>matrix[r]![0]!*p[0]+matrix[r]![1]!*p[1]+matrix[r]![2]!*p[2]+(direction?0:matrix[r]![3]!)) as Vec3;
}
export function columnMajor(matrix: readonly (readonly number[])[]): Float32Array {
  return new Float32Array([0,1,2,3].flatMap(c=>[0,1,2,3].map(r=>matrix[r]![c]!)));
}
/** Relative world coordinates avoid losing precision to a large DICOM world translation. */
export function relativeWorldToTexture(geometry: VolumeGeometry): number[][] {
  return geometry.worldToTexture.map((row,r)=>r<3?[row[0]!,row[1]!,row[2]!,row[3]!+dot(row.slice(0,3) as Vec3,geometry.bounds.center)]:[...row]);
}
export function inspectVolumeForRendering(grid: VolumeGrid, limits: RenderingLimits={}): VolumeRenderingInfo {
  const count=requireGrid(grid),textureBytes=count*4,maxBytes=limits.maxTextureBytes??256*1024*1024,maxSize=limits.max3DTextureSize??Infinity;
  if(!(maxBytes>0)||!Number.isFinite(maxBytes)||!(maxSize>=1))throw new Error('体纹理内存/尺寸限制无效。');
  if(grid.dims.some(d=>d>maxSize))throw new Error(`影像尺寸 ${grid.dims.join('×')} 超过当前 GPU 的 MAX_3D_TEXTURE_SIZE=${maxSize}；未做降采样。`);
  if(textureBytes>maxBytes)throw new Error(`R32F 体纹理需要 ${(textureBytes/1048576).toFixed(1)} MiB，超过当前 ${(maxBytes/1048576).toFixed(0)} MiB 上限；未做降采样。`);
  let min=Infinity,max=-Infinity;for(const value of grid.data){if(!Number.isFinite(value))throw new Error('体绘制数据包含 NaN 或无穷值。');min=Math.min(min,value);max=Math.max(max,value);}
  return {...volumeGeometry(grid),voxelCount:count,textureBytes,min,max};
}

export interface RayInterval { enter: number; exit: number }
/** Ray parameter interval; a unit world direction gives source physical units (mm only when known). */
export function rayBoxIntersection(origin: Vec3,direction: Vec3,min: Vec3,max: Vec3): RayInterval|null {
  [origin,direction,min,max].forEach((p,i)=>finitePoint(p,['射线原点','射线方向','包围盒下界','包围盒上界'][i]!));
  if(norm(direction)<1e-15||min.some((v,k)=>v>max[k]!))throw new Error('射线方向或包围盒无效。');
  let enter=0,exit=Infinity;
  for(let k=0;k<3;k++){
    if(Math.abs(direction[k]!)<1e-15){if(origin[k]!<min[k]!||origin[k]!>max[k]!)return null;}
    else {const a=(min[k]!-origin[k]!)/direction[k]!,b=(max[k]!-origin[k]!)/direction[k]!;enter=Math.max(enter,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));if(enter>exit)return null;}
  }
  return exit<0?null:{enter,exit};
}
export function intersectVolumeRay(grid: Pick<VolumeGrid,'dims'|'spacing'|'affine'>,origin: Vec3,direction: Vec3): RayInterval|null {
  finitePoint(origin,'射线原点');finitePoint(direction,'射线方向');const geometry=volumeGeometry(grid),len=norm(direction);if(len<1e-15)throw new Error('射线方向不能为零。');
  const d=direction.map(v=>v/len) as Vec3;
  return rayBoxIntersection(transformVolumePoint(geometry.worldToVoxel,origin),transformVolumePoint(geometry.worldToVoxel,d,true),[-.5,-.5,-.5],grid.dims.map(v=>v-.5) as Vec3);
}

/** Matches the shader's clamp-to-edge, voxel-centred manual trilinear interpolation. */
export function sampleVolumeTrilinear(grid: VolumeGrid,voxel: Vec3): number {
  requireGrid(grid);finitePoint(voxel,'采样坐标');
  const lo=voxel.map(Math.floor),t=voxel.map((v,k)=>v-lo[k]!);let sum=0;
  for(let code=0;code<8;code++){
    const corner=[0,1,2].map(k=>Math.max(0,Math.min(grid.dims[k]!-1,lo[k]!+((code>>k)&1))));
    const weight=t.reduce((s,v,k)=>s*((code&(1<<k))?v:1-v),1);sum+=grid.data[voxelIndex(corner,grid.dims)]!*weight;
  }
  return sum;
}
export function sampleVolumeAtWorld(grid: VolumeGrid,world: Vec3): number|undefined {
  const geometry=volumeGeometry(grid),voxel=transformVolumePoint(geometry.worldToVoxel,world);
  if(voxel.some((v,k)=>v<-.5||v>grid.dims[k]!-.5))return undefined;return sampleVolumeTrilinear(grid,voxel);
}
export function renderingSampleCount(lengthMm: number,stepMm: number,maxSamples=4096): number {
  if(!Number.isFinite(lengthMm)||lengthMm<0||!Number.isFinite(stepMm)||stepMm<=0||!Number.isSafeInteger(maxSamples)||maxSamples<1)throw new Error('体绘制采样距离或步长无效。');
  const count=Math.ceil(lengthMm/stepMm);if(count>maxSamples)throw new Error(`当前步长需要 ${count} 次采样，超过 ${maxSamples} 次上限；请增大采样步长。`);return count;
}

export function normalizeTransferPoints(points: readonly TransferPoint[]): TransferPoint[] {
  if(points.length<2)throw new Error('传递函数至少需要两个控制点。');
  const result=points.map(p=>{if(!Number.isFinite(p.value)||!Number.isFinite(p.opacity)||p.opacity<0||p.opacity>1||p.color.length!==3||p.color.some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('传递函数控制点无效。');return {value:p.value,color:[...p.color] as Vec3,opacity:p.opacity};}).sort((a,b)=>a.value-b.value);
  if(result.some((p,i)=>i>0&&p.value===result[i-1]!.value))throw new Error('传递函数控制点灰度值不能重复。');return result;
}
/** Preset names match the documented categories. Numeric curves are independent CT examples. */
export function presetTransferFunction(preset: VolumePreset): TransferPoint[] {
  const make=(rows: number[][])=>rows.map(([value,r,g,b,opacity])=>({value:value!,color:[r!,g!,b!] as Vec3,opacity:opacity!}));
  if(preset==='bone')return make([[-1024,0,0,0,0],[100,.5,.3,.15,0],[225,.75,.5,.3,.015],[450,.94,.78,.54,.16],[1000,1,.96,.85,.5],[3000,1,1,1,.72]]);
  if(preset==='soft')return make([[-1024,0,0,0,0],[-300,.4,.2,.18,0],[-100,.65,.3,.25,.035],[40,.86,.49,.4,.14],[120,.95,.66,.48,.2],[225,.92,.76,.61,.015],[350,1,.9,.75,0],[3000,1,1,1,0]]);
  return make([[-1024,0,0,0,0],[-300,.4,.2,.18,0],[-100,.65,.3,.25,.02],[40,.82,.44,.36,.065],[120,.94,.63,.45,.1],[225,.78,.57,.38,.035],[450,.95,.8,.58,.18],[1000,1,.97,.87,.55],[3000,1,1,1,.75]]);
}
export function evaluateTransferFunction(points: readonly TransferPoint[],value: number): {color:Vec3;opacity:number} {
  if(!Number.isFinite(value))throw new Error('传递函数采样值无效。');const sorted=normalizeTransferPoints(points);
  if(value<=sorted[0]!.value)return {color:[...sorted[0]!.color],opacity:sorted[0]!.opacity};
  if(value>=sorted[sorted.length-1]!.value){const p=sorted[sorted.length-1]!;return {color:[...p.color],opacity:p.opacity};}
  const upper=sorted.findIndex(p=>p.value>=value),a=sorted[upper-1]!,b=sorted[upper]!,t=(value-a.value)/(b.value-a.value);
  return {color:a.color.map((v,k)=>v+t*(b.color[k]!-v)) as Vec3,opacity:a.opacity+t*(b.opacity-a.opacity)};
}
export interface TransferLUT { data: Float32Array; domain:[number,number]; size:number }
export function buildTransferLUT(points: readonly TransferPoint[],domain?:[number,number],size=1024): TransferLUT {
  const sorted=normalizeTransferPoints(points),range=domain??[sorted[0]!.value,sorted[sorted.length-1]!.value];
  if(!Number.isSafeInteger(size)||size<2||size>16384||!range.every(Number.isFinite)||range[1]<=range[0])throw new Error('传递纹理尺寸或灰度范围无效。');
  const data=new Float32Array(size*4);let j=1;
  for(let i=0;i<size;i++){const value=range[0]+i/(size-1)*(range[1]-range[0]);while(j<sorted.length-1&&value>sorted[j]!.value)j++;const a=sorted[Math.max(0,j-1)]!,b=sorted[j]!,t=Math.max(0,Math.min(1,(value-a.value)/(b.value-a.value)));for(let k=0;k<3;k++)data[4*i+k]=a.color[k]!+t*(b.color[k]!-a.color[k]!);data[4*i+3]=a.opacity+t*(b.opacity-a.opacity);}
  return {data,domain:[...range],size};
}
/** Alpha at a reference distance becomes optical depth; step changes preserve attenuation. */
export function opacityForStep(opacity: number,distanceMm: number,referenceMm=1): number {
  if(!Number.isFinite(opacity)||opacity<0||opacity>1||!Number.isFinite(distanceMm)||distanceMm<0||!Number.isFinite(referenceMm)||referenceMm<=0)throw new Error('不透明度或参考采样距离无效。');
  return distanceMm===0?0:1-Math.pow(1-opacity,distanceMm/referenceMm);
}
export function compositeVolumeSamples(samples: readonly {color:Vec3;opacity:number;distanceMm:number}[],opacityScale=1,referenceMm=1): {color:Vec3;opacity:number} {
  if(!Number.isFinite(opacityScale)||opacityScale<0||opacityScale>1)throw new Error('全局不透明度必须位于0到1。');
  const color:Vec3=[0,0,0];let opacity=0;
  for(const sample of samples){finitePoint(sample.color,'颜色');if(sample.color.some(v=>v<0||v>1)||!Number.isFinite(sample.opacity)||sample.opacity<0||sample.opacity>1)throw new Error('样本颜色或不透明度超出0到1。');const alpha=opacityForStep(sample.opacity*opacityScale,sample.distanceMm,referenceMm),weight=(1-opacity)*alpha;for(let k=0;k<3;k++)color[k]+=weight*sample.color[k]!;opacity+=weight;}
  return {color,opacity};
}
export function windowNormalized(value: number,center: number,width: number): number {
  if(![value,center,width].every(Number.isFinite)||width<=0)throw new Error('窗宽必须为正数，窗位和灰度必须有限。');return Math.max(0,Math.min(1,(value-center)/width+.5));
}
