import {worldToVoxel,nearestVoxelCoordinate} from './measurements.ts';
import type {PhysicalDensityPlane} from './measurements.ts';
import {physicalPoint,requireGrid,type MprPlane,type Vec3,type VolumeGrid} from './types.ts';

/** Independent resampling policy, not a recovered native Mimics interpolation kernel. */
export const MAX_MPR_PIXELS=4*1024*1024;
export const MAX_MPR_DIMENSION=16384;
export const MAX_MPR_BYTES=128*1024*1024;
const EPS=1e-9,ORTHOGONAL_TOLERANCE=1e-6,CENTER_TOLERANCE=1e-7;
type Pixel=[number,number];
const add=(a:Vec3,b:Vec3):Vec3=>a.map((v,k)=>v+b[k]!) as Vec3;
const sub=(a:Vec3,b:Vec3):Vec3=>a.map((v,k)=>v-b[k]!) as Vec3;
const scale=(a:Vec3,n:number):Vec3=>a.map(v=>v*n) as Vec3;
const dot=(a:Vec3,b:Vec3)=>a.reduce((s,v,k)=>s+v*b[k]!,0);
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function finiteVector(p:readonly number[]){if(p.length!==3||p.some(v=>!Number.isFinite(v)))throw new Error('MPR世界坐标必须是有限三维向量。');}
function unit(p:Vec3):Vec3{finiteVector(p);const n=Math.hypot(...p);if(!Number.isFinite(n)||n<=EPS)throw new Error('MPR方向向量长度必须大于1e-9。');return scale(p,1/n);}

function dataProperty(object:object,key:PropertyKey):unknown{
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  if(!descriptor||!('value'in descriptor))throw new Error('MPR平面只接受普通数据字段，不允许getter。');
  return descriptor.value;
}
function denseNumbers(value:unknown,length:number):number[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==length||Reflect.ownKeys(value).length!==length+1)throw new Error('MPR平面向量或尺寸必须是无额外字段的普通稠密数组。');
  return Array.from({length},(_,i)=>{const n=dataProperty(value,String(i));if(typeof n!=='number'||!Number.isFinite(n))throw new Error('MPR平面数组必须包含有限数值。');return n;});
}
/** Validate and clone the shared PhysicalDensityPlane shape without changing physical steps. */
export function validateMprPlane(input:unknown):MprPlane{
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('MPR平面必须是普通对象。');
  const keys=Reflect.ownKeys(input),expected=['origin','u','v','size'];
  if(keys.length!==4||keys.some(key=>typeof key!=='string'||!expected.includes(key)))throw new Error('MPR平面字段无效，只允许origin/u/v/size。');
  const origin=denseNumbers(dataProperty(input,'origin'),3) as Vec3,u=denseNumbers(dataProperty(input,'u'),3) as Vec3,v=denseNumbers(dataProperty(input,'v'),3) as Vec3,size=denseNumbers(dataProperty(input,'size'),2) as Pixel;
  if(size.some(n=>!Number.isSafeInteger(n)||n<=0||n>MAX_MPR_DIMENSION)||size[0]*size[1]>MAX_MPR_PIXELS)throw new Error(`MPR输出尺寸须为正整数，每边不超过${MAX_MPR_DIMENSION}，总像素不超过${MAX_MPR_PIXELS}。`);
  const nu=unit(u),nv=unit(v);if(Math.abs(dot(nu,nv))>ORTHOGONAL_TOLERANCE)throw new Error('MPR两个像素步进方向必须正交。');
  for(const x of [-.5,size[0]-.5])for(const y of [-.5,size[1]-.5])finiteVector(add(origin,add(scale(u,x),scale(v,y))));
  return{origin,u,v,size};
}
function normalOf(plane:MprPlane):Vec3{return unit(cross(unit(plane.u),unit(plane.v)));}
function centerOf(plane:MprPlane):Vec3{return add(plane.origin,add(scale(plane.u,(plane.size[0]-1)/2),scale(plane.v,(plane.size[1]-1)/2)));}
export function mprPlaneNormal(plane:MprPlane):Vec3{return normalOf(validateMprPlane(plane));}
export function mprPlaneCenter(plane:MprPlane):Vec3{return centerOf(validateMprPlane(plane));}
export function mprPixelToWorld(plane:MprPlane,pixel:Pixel):Vec3{
  const p=validateMprPlane(plane);if(pixel.length!==2||pixel.some(v=>!Number.isFinite(v)))throw new Error('MPR像素坐标必须是两个有限数。');
  const world=add(p.origin,add(scale(p.u,pixel[0]),scale(p.v,pixel[1])));finiteVector(world);return world;
}
export function mprWorldToPixel(plane:MprPlane,world:Vec3):{pixel:Pixel;distance:number}{
  const p=validateMprPlane(plane);finiteVector(world);const delta=sub(world,p.origin),u=unit(p.u),v=unit(p.v),cosine=dot(u,v),du=dot(delta,u),dv=dot(delta,v);
  // Invert the tiny residual Gram cross-term too, so accepted rounded frames round-trip.
  const lu=Math.hypot(...p.u),lv=Math.hypot(...p.v),denominator=1-cosine*cosine,pixel:Pixel=[(du-cosine*dv)/denominator/lu,(dv-cosine*du)/denominator/lv],distance=dot(delta,normalOf(p));
  if([...pixel,distance].some(n=>!Number.isFinite(n)))throw new Error('MPR平面坐标超出有限数值范围。');return{pixel,distance};
}
export function scrollMprPlane(plane:MprPlane,distanceMm:number):MprPlane{
  const p=validateMprPlane(plane);if(!Number.isFinite(distanceMm))throw new Error('MPR滚动距离必须是有限毫米值。');
  return validateMprPlane({...p,origin:add(p.origin,scale(normalOf(p),distanceMm))});
}

export interface MprOrientation {normal?:Vec3;up?:Vec3;/** Degrees; extrinsic world X, then Y, then Z. */angles?:Vec3}
function orientation(options:MprOrientation):{u:Vec3;v:Vec3;normal:Vec3}{
  if(options.angles){
    if(options.normal||options.up)throw new Error('MPR角度与normal/up方向不能同时指定。');finiteVector(options.angles);
    const [rx,ry,rz]=options.angles.map(v=>(v%360)*Math.PI/180),sx=Math.sin(rx!),cx=Math.cos(rx!),sy=Math.sin(ry!),cy=Math.cos(ry!),sz=Math.sin(rz!),cz=Math.cos(rz!);
    const rotate=(p:Vec3):Vec3=>{const x=p[0],y=p[1]*cx-p[2]*sx,z=p[1]*sx+p[2]*cx,xx=x*cy+z*sy,zz=-x*sy+z*cy;return[xx*cz-y*sz,xx*sz+y*cz,zz];};
    return{u:rotate([1,0,0]),v:rotate([0,1,0]),normal:rotate([0,0,1])};
  }
  const normal=unit(options.normal??[0,0,1]),up=options.up??(Math.abs(normal[1])<.9?[0,1,0]:[1,0,0]);finiteVector(up);
  const v=unit(sub(up,scale(normal,dot(up,normal)))),u=unit(cross(v,normal));return{u,v,normal};
}
export interface CreateMprPlaneOptions extends MprOrientation {center:Vec3;size:Pixel;pixelSpacing:Pixel}
export function createMprPlane(options:CreateMprPlaneOptions):MprPlane{
  finiteVector(options.center);const {u,v}=orientation(options);
  if(options.pixelSpacing.length!==2||options.pixelSpacing.some(n=>!Number.isFinite(n)||n<=EPS))throw new Error('MPR输出像素间距必须为正毫米值。');
  const pu=scale(u,options.pixelSpacing[0]),pv=scale(v,options.pixelSpacing[1]);
  return validateMprPlane({origin:sub(options.center,add(scale(pu,(options.size[0]-1)/2),scale(pv,(options.size[1]-1)/2))),u:pu,v:pv,size:options.size});
}
export interface FitMprPlaneOptions extends MprOrientation {size:Pixel;center?:Vec3}
/** Project all eight half-voxel support corners, including full affine shear/reflection. */
export function fitMprPlane(grid:VolumeGrid,options:FitMprPlaneOptions):MprPlane{
  requireGrid(grid);const {u,v}=orientation(options),center=options.center??physicalPoint(grid.dims.map(n=>(n-1)/2) as Vec3,grid);finiteVector(center);
  let halfU=0,halfV=0;
  for(const x of [-.5,grid.dims[0]-.5])for(const y of [-.5,grid.dims[1]-.5])for(const z of [-.5,grid.dims[2]-.5]){
    const corner=physicalPoint([x,y,z],grid);finiteVector(corner);const delta=sub(corner,center);halfU=Math.max(halfU,Math.abs(dot(delta,u)));halfV=Math.max(halfV,Math.abs(dot(delta,v)));
  }
  // Validate invertibility through the shared affine inverse before presenting a fitted view.
  const voxelCenter=worldToVoxel(center,grid);finiteVector(voxelCenter);
  return createMprPlane({center,size:options.size,pixelSpacing:[2*halfU/options.size[0],2*halfV/options.size[1]],normal:cross(u,v),up:v});
}
export function orthogonalMprPlanes(grid:VolumeGrid,base:MprPlane):[MprPlane,MprPlane,MprPlane]{
  const p=validateMprPlane(base),center=centerOf(p),u=unit(p.u),v=unit(p.v),normal=normalOf(p);
  const secondary=([[v,normal],[normal,u]] as [Vec3,Vec3][]).map(([horizontal,vertical])=>fitMprPlane(grid,{size:[...p.size],center,normal:cross(horizontal,vertical),up:vertical}));
  return[p,secondary[0]!,secondary[1]!];
}

export interface MprMaskInput {id:string;data:Uint8Array}
export interface MprSamplingOptions {interpolation?:'linear'|'nearest';cancelled?:()=>boolean;maxPixels?:number;maxBytes?:number}
export interface MprSlice {plane:MprPlane;gray:Float32Array;valid:Uint8Array;support:Uint8Array;masks:MprMaskInput[]}
/** Structural compatibility lets densityStatistics consume the exact same output sampling frame. */
export function mprDensityPlane(plane:MprPlane):PhysicalDensityPlane{return validateMprPlane(plane);}
export function sampleMprSlice(grid:VolumeGrid,plane:MprPlane,masks:readonly MprMaskInput[]=[],options:MprSamplingOptions={}):MprSlice{
  return prepareMprSampler(grid,masks).sample(plane,options);
}
/** Worker-internal resident preparation. Its source arrays must remain privately immutable. */
export function prepareMprSampler(input:VolumeGrid,inputMasks:readonly MprMaskInput[]=[]){
  const count=requireGrid(input),grid:VolumeGrid={...input,dims:[...input.dims],spacing:[...input.spacing],...(input.affine?{affine:input.affine.map(row=>[...row])}:{})},masks=inputMasks.map(mask=>({id:mask.id,data:mask.data}));
  const ids=new Set<string>();for(const mask of masks){if(typeof mask.id!=='string'||!mask.id||ids.has(mask.id)||!(mask.data instanceof Uint8Array)||mask.data.length!==count)throw new Error('MPR独立Mask标识或尺寸无效。');ids.add(mask.id);}
  const translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0];finiteVector(translation);
  const linear={spacing:grid.spacing,...(grid.affine?{affine:grid.affine.map((row,r)=>r<3?[row[0]!,row[1]!,row[2]!,0]:[...row])}:{})};
  const inverse=([ [1,0,0],[0,1,0],[0,0,1] ] as Vec3[]).map(axis=>worldToVoxel(axis,linear));inverse.forEach(finiteVector);
  const vectorToVoxel=(v:Vec3):Vec3=>[0,1,2].map(k=>inverse[0]![k]!*v[0]+inverse[1]![k]!*v[1]+inverse[2]![k]!*v[2]) as Vec3;
  function* scan(plane:MprPlane,options:MprSamplingOptions):Generator<void,MprSlice,void>{
  const p=validateMprPlane(plane),pixels=p.size[0]*p.size[1],maxPixels=options.maxPixels??MAX_MPR_PIXELS,maxBytes=options.maxBytes??MAX_MPR_BYTES;
  if(!Number.isSafeInteger(maxPixels)||maxPixels<=0||maxPixels>MAX_MPR_PIXELS||pixels>maxPixels)throw new Error('MPR输出超过像素预算。');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX_MPR_BYTES||pixels*(6+masks.length)>maxBytes)throw new Error('MPR输出超过内存预算。');
  if(options.interpolation!==undefined&&!['linear','nearest'].includes(options.interpolation))throw new Error('MPR灰度插值方式无效。');
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function')throw new Error('MPR取消回调无效。');
  const check=()=>{if(options.cancelled?.())throw new Error('MPR重采样已取消。');};check();
  const origin=vectorToVoxel(sub(p.origin,translation)),du=vectorToVoxel(p.u),dv=vectorToVoxel(p.v);[origin,du,dv].forEach(finiteVector);
  const gray=new Float32Array(pixels);gray.fill(NaN);const valid=new Uint8Array(pixels),support=new Uint8Array(pixels),sampledMasks=masks.map(mask=>({id:mask.id,data:new Uint8Array(pixels)})),[nx,ny,nz]=grid.dims;
  for(let y=0,i=0;y<p.size[1];y++)for(let x=0;x<p.size[0];x++,i++){
    if(i>0&&(i&4095)===0)yield;
    if((i&255)===0)check();
    const vx=origin[0]+x*du[0]+y*dv[0],vy=origin[1]+x*du[1]+y*dv[1],vz=origin[2]+x*du[2]+y*dv[2];
    if(!Number.isFinite(vx)||!Number.isFinite(vy)||!Number.isFinite(vz))continue;
    if(vx<-.5||vx>nx-.5||vy<-.5||vy>ny-.5||vz<-.5||vz>nz-.5)continue;
    support[i]=1;
    const ix=Math.max(0,Math.min(nx-1,nearestVoxelCoordinate(vx))),iy=Math.max(0,Math.min(ny-1,nearestVoxelCoordinate(vy))),iz=Math.max(0,Math.min(nz-1,nearestVoxelCoordinate(vz))),nearest=ix+nx*(iy+ny*iz);
    for(let k=0;k<masks.length;k++)sampledMasks[k]!.data[i]=masks[k]!.data[nearest]!;
    // Match densityStatistics' physical-plane center support, rather than inventing edge gray.
    if(vx<-CENTER_TOLERANCE||vx>nx-1+CENTER_TOLERANCE||vy<-CENTER_TOLERANCE||vy>ny-1+CENTER_TOLERANCE||vz<-CENTER_TOLERANCE||vz>nz-1+CENTER_TOLERANCE)continue;
    let value:number;
    if(options.interpolation==='nearest')value=grid.data[nearest]!;
    else{
      const qx=Math.max(0,Math.min(nx-1,vx)),qy=Math.max(0,Math.min(ny-1,vy)),qz=Math.max(0,Math.min(nz-1,vz)),x0=Math.floor(qx),y0=Math.floor(qy),z0=Math.floor(qz),x1=Math.min(nx-1,x0+1),y1=Math.min(ny-1,y0+1),z1=Math.min(nz-1,z0+1),fx=qx-x0,fy=qy-y0,fz=qz-z0;
      value=0;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const weight=(dx?fx:1-fx)*(dy?fy:1-fy)*(dz?fz:1-fz);if(weight<=0)continue;
        const sample=grid.data[(dx?x1:x0)+nx*((dy?y1:y0)+ny*(dz?z1:z0))]!;if(!Number.isFinite(sample)){value=NaN;continue;}value+=weight*sample;
      }
    }
    if(Number.isFinite(value)){gray[i]=value;if(Number.isFinite(gray[i]))valid[i]=1;else gray[i]=NaN;}
  }
  check();return{plane:p,gray,valid,support,masks:sampledMasks};
  }
  function sample(plane:MprPlane,options:MprSamplingOptions={}):MprSlice{const iterator=scan(plane,options);let next=iterator.next();while(!next.done)next=iterator.next();return next.value;}
  async function sampleAsync(plane:MprPlane,options:MprSamplingOptions={},yieldControl:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))):Promise<MprSlice>{const iterator=scan(plane,options);let next=iterator.next();while(!next.done){await yieldControl();next=iterator.next();}return next.value;}
  return{sample,sampleAsync};
}
