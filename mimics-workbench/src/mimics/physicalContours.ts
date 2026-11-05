import {MAX_VOXEL_ADDRESS_COUNT} from '../volumeCapacity.ts';
import {CONTOUR_PROVENANCE,extractSliceContours,type ContourRing,type ContourSet,type Point2} from './contours.ts';
import {affinePlaneNormal,affinePlaneViewingPlane,transformAffinePlane,validateAffinePlane,validateRigidTransform} from './affinePlane.ts';
import {rasterizeMprContour,MAX_MPR_CONTOUR_SCAN_VISITS,MAX_MPR_CONTOUR_EDGE_VISITS} from './mprContour.ts';
import {nearestVoxelCoordinate,worldToVoxel} from './measurements.ts';
import {physicalPoint,requireGrid,type AffinePlane,type AlgorithmControl,type BinaryMask,type MaskResult,type Vec3,type VolumeGrid} from './types.ts';

export const PHYSICAL_CONTOUR_PROVENANCE='independent-world-plane-contours' as const;
export interface PhysicalContourLayer {plane:AffinePlane;rings:ContourRing[];componentCount:number;sourceRevision?:number}
export interface PhysicalContourSet {provenance:typeof PHYSICAL_CONTOUR_PROVENANCE;layers:PhysicalContourLayer[]}
export interface PhysicalContourOptions extends AlgorithmControl {maxScanVisits?:number;maxEdgeVisits?:number;maxBytes?:number}
export interface UpdatePhysicalContourOptions extends PhysicalContourOptions {sourceRevision?:number}
export const MAX_PHYSICAL_CONTOUR_LAYERS=32_767,MAX_PHYSICAL_CONTOUR_RINGS=65_536,MAX_PHYSICAL_CONTOUR_POINTS=1_048_576;
export const DEFAULT_PHYSICAL_CONTOUR_SCAN_VISITS=8_000_000,MAX_PHYSICAL_CONTOUR_SCAN_VISITS=64_000_000;
export const DEFAULT_PHYSICAL_CONTOUR_EDGE_VISITS=32_000_000,MAX_PHYSICAL_CONTOUR_EDGE_VISITS=256_000_000;
export const DEFAULT_PHYSICAL_CONTOUR_BYTES=256*1024*1024,MAX_PHYSICAL_CONTOUR_BYTES=512*1024*1024;
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const length=(v:Vec3)=>Math.hypot(...v);
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function data(object:object,key:PropertyKey):unknown{const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!('value'in d))throw new Error('物理轮廓只允许数据字段，不允许getter。');return d.value;}
function object(input:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('物理轮廓需要普通对象。');const keys=Reflect.ownKeys(input);if(keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k))||required.some(k=>!keys.includes(k)))throw new Error('物理轮廓字段无效。');const result:Record<string,unknown>={};for(const key of keys)result[key as string]=data(input,key);return result;}
function array(input:unknown,maximum:number):unknown[]{if(!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>maximum||Reflect.ownKeys(input).length!==input.length+1)throw new Error('物理轮廓数组必须普通稠密且不超过预算。');return Array.from({length:input.length},(_,i)=>data(input,String(i)));}
function number(input:unknown):number{if(typeof input!=='number'||!Number.isFinite(input))throw new Error('物理轮廓必须包含有限数。');return input;}
function revision(input:unknown){if(!Number.isSafeInteger(input)||Number(input)<0)throw new Error('物理轮廓来源版本必须为非负安全整数。');return input as number;}
function budget(input:number,maximum:number){if(!Number.isSafeInteger(input)||input<=0||input>maximum)throw new Error(`物理轮廓预算必须为1至${maximum}的整数。`);return input;}
function control(options:PhysicalContourOptions){
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function'||options.progress!==undefined&&typeof options.progress!=='function')throw new Error('物理轮廓控制回调必须是函数。');
  const maxScan=budget(options.maxScanVisits??DEFAULT_PHYSICAL_CONTOUR_SCAN_VISITS,MAX_PHYSICAL_CONTOUR_SCAN_VISITS),maxEdge=budget(options.maxEdgeVisits??DEFAULT_PHYSICAL_CONTOUR_EDGE_VISITS,MAX_PHYSICAL_CONTOUR_EDGE_VISITS),maxBytes=budget(options.maxBytes??DEFAULT_PHYSICAL_CONTOUR_BYTES,MAX_PHYSICAL_CONTOUR_BYTES);let scans=0,edges=0,bytes=0;
  const check=(fraction?:number)=>{const abort=()=>{if(options.cancelled?.()){const error=new Error('物理轮廓操作已取消。');error.name='AbortError';throw error;}};abort();if(fraction!==undefined)options.progress?.(fraction);abort();};
  return{maxScan,maxEdge,maxBytes,check,usedBytes:()=>bytes,reserve(n:number){bytes+=n;if(bytes>maxBytes)throw new Error('物理轮廓元数据或缓冲区超过内存预算。');},remainingScan:()=>maxScan-scans,remainingEdge:()=>maxEdge-edges,scan(n=1){scans+=n;if(scans>maxScan)throw new Error('物理轮廓累计扫描超过预算。');if((scans&1023)===0)check();},edge(n=1){edges+=n;if(edges>maxEdge)throw new Error('物理轮廓累计边处理超过预算。');if((edges&1023)===0)check();}};
}
type Control=ReturnType<typeof control>;
const at=(plane:AffinePlane,p:Point2):Vec3=>[0,1,2].map(k=>plane.origin[k]!+plane.u[k]!*p[0]+plane.v[k]!*p[1]) as Vec3;
function ringArea(points:Point2[]){const a=points[0]!;let sum=0;for(let i=1;i+1<points.length;i++)sum+=(points[i]![0]-a[0])*(points[i+1]![1]-a[1])-(points[i]![1]-a[1])*(points[i+1]![0]-a[0]);return sum/2;}
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
function inside(p:Point2,points:Point2[],c:Control):boolean{let odd=false;for(let i=0,j=points.length-1;i<points.length;j=i++){c.edge();const a=points[j]!,b=points[i]!;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])odd=!odd;}return odd;}
function contained(child:Point2[],parent:Point2[],c:Control):boolean{
  const orient=(a:Point2,b:Point2,p:Point2)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  for(const p of child){let odd=false,boundary=false;for(let i=0,j=parent.length-1;i<parent.length;j=i++){c.edge();const a=parent[j]!,b=parent[i]!,crossing=orient(a,b,p);if(Math.abs(crossing)<=1e-10*Math.max(1,Math.abs(b[0]-a[0])+Math.abs(b[1]-a[1]))&&p[0]>=Math.min(a[0],b[0])-1e-10&&p[0]<=Math.max(a[0],b[0])+1e-10&&p[1]>=Math.min(a[1],b[1])-1e-10&&p[1]<=Math.max(a[1],b[1])+1e-10){boundary=true;break;}if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])odd=!odd;}if(!odd&&!boundary)return false;}
  for(let i=0;i<child.length;i++)for(let j=0;j<parent.length;j++){c.edge();const a=child[i]!,b=child[(i+1)%child.length]!,p=parent[j]!,q=parent[(j+1)%parent.length]!;if(orient(a,b,p)*orient(a,b,q)<0&&orient(p,q,a)*orient(p,q,b)<0)return false;}
  return true;
}
/** Provenance discriminator only; never invokes an input accessor or claims full validation. */
export function isPhysicalContourSet(input:unknown):input is PhysicalContourSet{if(!input||typeof input!=='object')return false;const d=Object.getOwnPropertyDescriptor(input,'provenance');return!!d&&'value'in d&&d.value===PHYSICAL_CONTOUR_PROVENANCE;}
function validated(input:unknown,c:Control):PhysicalContourSet{
  const set=object(input,['provenance','layers']);if(set.provenance!==PHYSICAL_CONTOUR_PROVENANCE)throw new Error('物理轮廓来源标识无效。');if(Array.isArray(set.layers))c.reserve(set.layers.length*512);const storedLayers=array(set.layers,MAX_PHYSICAL_CONTOUR_LAYERS),layers:PhysicalContourLayer[]=[],planes=new Set<string>();let totalRings=0,totalPoints=0;
  for(const value of storedLayers){c.check();const layer=object(value,['plane','rings','componentCount'],['sourceRevision']),plane=validateAffinePlane(layer.plane),key=JSON.stringify(plane);if(planes.has(key))throw new Error('物理轮廓包含重复存储平面。');planes.add(key);const sourceRevision=layer.sourceRevision===undefined?undefined:revision(layer.sourceRevision),componentCount=number(layer.componentCount);if(!Number.isSafeInteger(componentCount)||componentCount<0)throw new Error('物理轮廓分量数无效。');
    if(Array.isArray(layer.rings))c.reserve(layer.rings.length*256);const entries=array(layer.rings,MAX_PHYSICAL_CONTOUR_RINGS);totalRings+=entries.length;if(totalRings>MAX_PHYSICAL_CONTOUR_RINGS)throw new Error('物理轮廓累计环数超过预算。');const rings:ContourRing[]=[],areaScale=length(cross(plane.u,plane.v));if(!Number.isFinite(areaScale)||areaScale<=0)throw new Error('物理轮廓面积尺度无效。');
    for(const entry of entries){const ring=object(entry,['points','hole','parent','component','signedArea','areaMm2','perimeterMm']);if(Array.isArray(ring.points))c.reserve(ring.points.length*64);const rawPoints=array(ring.points,MAX_PHYSICAL_CONTOUR_POINTS);totalPoints+=rawPoints.length;if(rawPoints.length<3||totalPoints>MAX_PHYSICAL_CONTOUR_POINTS)throw new Error('物理轮廓顶点数无效或超过预算。');const points=rawPoints.map(value=>{c.edge();const p=array(value,2);if(p.length!==2)throw new Error('物理轮廓点需要两个参数坐标。');const point:Point2=[number(p[0]),number(p[1])];if(point[0]<-.5||point[0]>plane.size[0]-.5||point[1]<-.5||point[1]>plane.size[1]-.5)throw new Error('物理轮廓点超出保存平面的完整FOV。');return point;});
      const area=ringArea(points);if(!Number.isFinite(area)||area===0||typeof ring.hole!=='boolean'||(ring.parent!==null&&(!Number.isSafeInteger(ring.parent)||Number(ring.parent)<0||Number(ring.parent)>=entries.length))||!Number.isSafeInteger(ring.component)||Number(ring.component)<0||Number(ring.component)>=componentCount)throw new Error('物理轮廓面积、洞或父级/分量无效。');
      let perimeter=0;for(let i=0;i<points.length;i++){c.edge();const a=points[i]!,b=points[(i+1)%points.length]!,dx=b[0]-a[0],dy=b[1]-a[1];perimeter+=Math.hypot(...plane.u.map((n,k)=>n*dx+plane.v[k]!*dy));}
      const signedArea=number(ring.signedArea),areaMm2=number(ring.areaMm2),perimeterMm=number(ring.perimeterMm);if(!near(signedArea,area)||!near(areaMm2,Math.abs(area)*areaScale)||!near(perimeterMm,perimeter)||Math.sign(area)!==(ring.hole?-1:1))throw new Error('物理轮廓存储面积/周长/方向与仿射几何不一致。');rings.push({points,hole:ring.hole,parent:ring.parent as number|null,component:ring.component as number,signedArea,areaMm2,perimeterMm});
    }
    const components=new Set<number>(),boxes=rings.map(r=>{const min:Point2=[Infinity,Infinity],max:Point2=[-Infinity,-Infinity];for(const p of r.points){min[0]=Math.min(min[0],p[0]);min[1]=Math.min(min[1],p[1]);max[0]=Math.max(max[0],p[0]);max[1]=Math.max(max[1],p[1]);}return{min,max};});
    if(rings.length*rings.length>c.remainingEdge())throw new Error('物理轮廓父级验证超过边处理预算。');
    for(let i=0;i<rings.length;i++){const ring=rings[i]!;let parent=ring.parent,depth=0;while(parent!==null){c.edge();if(++depth>rings.length)throw new Error('物理轮廓父级关系存在循环。');parent=rings[parent]!.parent;}if(ring.hole!==(depth%2===1))throw new Error('物理轮廓洞标志与父级深度不一致。');if(!ring.hole){if(components.has(ring.component))throw new Error('物理轮廓前景分量重复。');components.add(ring.component);}else if(ring.parent===null||rings[ring.parent]!.component!==ring.component)throw new Error('物理轮廓洞必须归属其直接前景父环。');
      let probe:Point2|undefined;for(let k=0;k<ring.points.length;k++){const a=ring.points[k]!,b=ring.points[(k+1)%ring.points.length]!,dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy);c.edge();if(d){const sign=Math.sign(ring.signedArea);probe=[(a[0]+b[0])/2-sign*dy/d*1e-4,(a[1]+b[1])/2+sign*dx/d*1e-4];break;}}if(!probe)throw new Error('物理轮廓没有有效边。');let smallest=Infinity,actual:number|null=null;
      for(let j=0;j<rings.length;j++){c.edge();const other=rings[j]!,size=Math.abs(other.signedArea),box=boxes[j]!;if(size<=Math.abs(ring.signedArea)||size>=smallest||probe[0]<box.min[0]!||probe[0]>box.max[0]!||probe[1]<box.min[1]!||probe[1]>box.max[1]!)continue;if(inside(probe,other.points,c)){smallest=size;actual=j;}}if(actual!==ring.parent)throw new Error('物理轮廓父级不是实际最小包含环。');if(ring.parent!==null&&!contained(ring.points,rings[ring.parent]!.points,c))throw new Error('物理轮廓子环越过父环边界。');
    }
    if(components.size!==componentCount)throw new Error('物理轮廓分量数与前景环不一致。');layers.push({plane,rings,componentCount,...(sourceRevision!==undefined?{sourceRevision}:{})});
  }
  return{provenance:PHYSICAL_CONTOUR_PROVENANCE,layers};
}
export function validatePhysicalContourSet(input:unknown,options:PhysicalContourOptions={}):PhysicalContourSet{const c=control(options);c.check(0);const result=validated(input,c);c.check(1);return result;}

function sourceFrame(grid:VolumeGrid){
  for(const p of [grid.dims,grid.spacing])if(!Array.isArray(p)||p.length!==3||![p[0],p[1],p[2]].every(Number.isFinite))throw new Error('物理轮廓源几何无效。');const count=requireGrid(grid);if(!(grid.data instanceof Float32Array)||!Number.isSafeInteger(count)||count>MAX_VOXEL_ADDRESS_COUNT)throw new Error('物理轮廓源体积超过类型或容量范围。');
  if(grid.affine!==undefined&&(!Array.isArray(grid.affine)||![3,4].includes(grid.affine.length)||Array.from(grid.affine).some(row=>!Array.isArray(row)||row.length!==4||![row[0],row[1],row[2],row[3]].every(Number.isFinite))||grid.affine.length===4&&grid.affine[3]!.some((n,k)=>n!==(k===3?1:0))))throw new Error('物理轮廓源仿射矩阵无效。');
  const columns:[Vec3,Vec3,Vec3]=grid.affine?[0,1,2].map(k=>[grid.affine![0]![k]!,grid.affine![1]![k]!,grid.affine![2]![k]!]) as [Vec3,Vec3,Vec3]:[[grid.spacing[0],0,0],[0,grid.spacing[1],0],[0,0,grid.spacing[2]]],translation:Vec3=grid.affine?[grid.affine[0]![3]!,grid.affine[1]![3]!,grid.affine[2]![3]!]:[0,0,0],linear={spacing:grid.spacing,affine:[0,1,2].map(r=>[columns[0][r]!,columns[1][r]!,columns[2][r]!,0])},inverse=[worldToVoxel([1,0,0],linear),worldToVoxel([0,1,0],linear),worldToVoxel([0,0,1],linear)];
  const toVoxelVector=(d:Vec3):Vec3=>{const p=[0,1,2].map(k=>inverse[0]![k]!*d[0]+inverse[1]![k]!*d[1]+inverse[2]![k]!*d[2]) as Vec3;if(p.some(n=>!Number.isFinite(n)))throw new Error('物理轮廓源坐标逆变换超出有限范围。');return p;},toVoxel=(world:Vec3)=>toVoxelVector(sub(world,translation));toVoxel(translation);return{count,columns,toVoxel,toVoxelVector};
}
export function convertNativeContours(grid:VolumeGrid,input:ContourSet,sourceRevision?:number):PhysicalContourSet{
  const frame=sourceFrame(grid),native=object(input,['axis','dims','layers','provenance']),axis=native.axis,dims=array(native.dims,3);if(native.provenance!==CONTOUR_PROVENANCE||typeof axis!=='number'||![0,1,2].includes(axis)||dims.length!==3||dims.some((n,k)=>n!==grid.dims[k]))throw new Error('原始IJK轮廓与源影像不一致。');if(sourceRevision!==undefined)revision(sourceRevision);const axes=([0,1,2] as const).filter(a=>a!==axis);
  const layers=array(native.layers,MAX_PHYSICAL_CONTOUR_LAYERS).map(value=>{const layer=object(value,['plane','rings','componentCount','provenance']),slice=object(layer.plane,['axis','index']),index=slice.index;if(layer.provenance!==CONTOUR_PROVENANCE||slice.axis!==axis||!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=grid.dims[axis]!)throw new Error('原始IJK轮廓层无效。');const p:Vec3=[0,0,0];p[axis]=index as number;return{plane:{origin:physicalPoint(p,grid),u:[...frame.columns[axes[0]!]!] as Vec3,v:[...frame.columns[axes[1]!]!] as Vec3,size:[grid.dims[axes[0]!]!,grid.dims[axes[1]!]!] as [number,number]},rings:layer.rings,componentCount:layer.componentCount,...(sourceRevision!==undefined?{sourceRevision}:{})};});return validatePhysicalContourSet({provenance:PHYSICAL_CONTOUR_PROVENANCE,layers});
}
export function transformPhysicalContours(input:PhysicalContourSet,transform:number[][]):PhysicalContourSet{const set=validatePhysicalContourSet(input),t=validateRigidTransform(transform);return validatePhysicalContourSet({...set,layers:set.layers.map(layer=>({...layer,plane:transformAffinePlane(layer.plane,t)}))});}

/** Per-layer outer/hole/island overwrite, then union layers; a hole never clears another plane. */
export function physicalContoursToMask(grid:VolumeGrid,input:PhysicalContourSet,options:PhysicalContourOptions={}):MaskResult{
  const c=control(options);c.check(0);const frame=sourceFrame(grid),set=validated(input,c);c.reserve(frame.count);let mask:Uint8Array;try{mask=new Uint8Array(frame.count);}catch{throw new Error('物理轮廓Mask分配失败。');}let count=0;
  for(let li=0;li<set.layers.length;li++){
    const layer=set.layers[li]!,view=affinePlaneViewingPlane(layer.plane),pages=new Map<number,Uint32Array>();let pageBytes=0;
    const order=layer.rings.map((ring,index)=>{let parent=ring.parent,depth=0;while(parent!==null){depth++;parent=layer.rings[parent]!.parent;}return{ring,index,depth};}).sort((a,b)=>a.depth-b.depth||a.index-b.index);
    for(const {ring} of order){
      const scans=Math.min(c.remainingScan(),MAX_MPR_CONTOUR_SCAN_VISITS),edges=Math.min(c.remainingEdge(),MAX_MPR_CONTOUR_EDGE_VISITS);if(scans<=0||edges<=0)throw new Error('物理轮廓累计预算已耗尽。');const scratch=Math.min(scans,frame.count,4_000_000)*12;if(c.usedBytes()+pageBytes+scratch>c.maxBytes)throw new Error('物理轮廓候选缓冲区超过内存预算。');
      const result=rasterizeMprContour(grid,view,ring.points.map(p=>at(layer.plane,p)),{maxScanVisits:scans,maxEdgeVisits:edges,cancelled:options.cancelled});c.scan(result.scanVisits);c.edge(result.edgeVisits);
      for(const index of result.indices){c.scan();const key=index>>>12,offset=index&4095;let page=pages.get(key);if(!page&&!ring.hole){pageBytes+=576;if(c.usedBytes()+pageBytes+scratch>c.maxBytes)throw new Error('物理轮廓分层缓冲区超过内存预算。');try{page=new Uint32Array(128);}catch{throw new Error('物理轮廓分层缓冲区分配失败。');}pages.set(key,page);}if(page){const word=offset>>>5,bit=1<<(offset&31);page[word]=ring.hole?page[word]!&~bit:page[word]!|bit;}}
    }
    for(const [key,page] of pages)for(let word=0;word<page.length;word++){c.scan();let bits=page[word]!;while(bits){const bit=31-Math.clz32(bits&-bits),index=(key<<12)+(word<<5)+bit;c.scan();if(index<mask.length&&!mask[index]){mask[index]=1;count++;}bits=(bits&(bits-1))>>>0;}}
    c.check((li+1)/Math.max(1,set.layers.length));
  }
  c.check(1);return{mask,count};
}

/** Re-extract only one saved parametric layer by nearest source membership, retaining its exact basis. */
export function updatePhysicalContourLayer(grid:VolumeGrid,sourceMask:BinaryMask,input:PhysicalContourSet,index:number,options:UpdatePhysicalContourOptions={}):PhysicalContourSet{
  const c=control(options);c.check(0);const frame=sourceFrame(grid);if(!(sourceMask instanceof Uint8Array)||sourceMask.length!==frame.count)throw new Error('物理轮廓更新的源Mask尺寸或类型无效。');const set=validated(input,c);if(!Number.isSafeInteger(index)||index<0||index>=set.layers.length)throw new Error('物理轮廓更新层索引无效。');if(options.sourceRevision!==undefined)revision(options.sourceRevision);const plane=set.layers[index]!.plane,[width,height]=plane.size,n=width*height;if(n>4*1024*1024||n>c.remainingScan())throw new Error('物理轮廓更新采样超过像素/扫描预算。');if(n*14>c.maxBytes)throw new Error('物理轮廓更新局部图超过内存预算。');let sampled:Uint8Array;try{sampled=new Uint8Array(n);}catch{throw new Error('物理轮廓局部Mask分配失败。');}
  const origin=frame.toVoxel(plane.origin),du=frame.toVoxelVector(plane.u),dv=frame.toVoxelVector(plane.v);
  for(let y=0,i=0;y<height;y++)for(let x=0;x<width;x++,i++){c.scan();const p=origin.map((v,k)=>v+x*du[k]!+y*dv[k]!) as Vec3;if(p.some(v=>!Number.isFinite(v)))throw new Error('物理轮廓更新采样超出有限范围。');if(p.some((v,k)=>v<-.5||v>grid.dims[k]!-.5))continue;const q=p.map((v,k)=>Math.max(0,Math.min(grid.dims[k]!-1,nearestVoxelCoordinate(v)))) as Vec3,value=sourceMask[q[0]+grid.dims[0]*(q[1]+grid.dims[1]*q[2])]!;if(value!==0&&value!==1)throw new Error('物理轮廓源Mask必须是二值成员。');sampled[i]=value;}
  let boundary=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++){c.scan();const i=x+width*y;if(!sampled[i])continue;if(!x||!sampled[i-1])boundary++;if(x+1===width||!sampled[i+1])boundary++;if(!y||!sampled[i-width])boundary++;if(y+1===height||!sampled[i+width])boundary++;}c.edge(boundary);c.reserve(n*14+boundary*256);
  const normal=affinePlaneNormal(plane),local:VolumeGrid={dims:[width,height,1],spacing:[length(plane.u),length(plane.v),1],affine:[[plane.u[0],plane.v[0],normal[0],0],[plane.u[1],plane.v[1],normal[1],0],[plane.u[2],plane.v[2],normal[2],0]],data:new Float32Array(n)};const extracted=extractSliceContours(local,sampled,{axis:2,index:0},{cancelled:options.cancelled,progress:f=>c.check(.2+.6*f)});set.layers[index]={plane:validateAffinePlane(plane),rings:extracted.rings,componentCount:extracted.componentCount,...(options.sourceRevision!==undefined?{sourceRevision:options.sourceRevision}:{})};const result=validated(set,c);c.check(1);return result;
}
