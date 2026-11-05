import {MAX_MPR_DIMENSION,MAX_MPR_PIXELS,validateMprPlane} from './mpr.ts';
import type {AffinePlane,MprPlane,Vec3} from './types.ts';
export type {AffinePlane} from './types.ts';
export const MAX_AFFINE_PLANE_DIMENSION=32_767;
export const MAX_AFFINE_PLANE_PIXELS=128*1024*1024;
const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,n:number):Vec3=>[a[0]*n,a[1]*n,a[2]*n];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function data(object:object,key:PropertyKey):unknown{const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!('value'in d))throw new Error('仿射平面只接受普通数据字段，不能包含getter。');return d.value;}
function dense(input:unknown,length:number):number[]{if(!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length!==length||Reflect.ownKeys(input).length!==length+1)throw new Error('仿射平面需要无额外字段的普通稠密数组。');return Array.from({length},(_,i)=>{const n=data(input,String(i));if(typeof n!=='number'||!Number.isFinite(n))throw new Error('仿射平面数组必须包含有限数。');return n;});}
function finite(point:Vec3){if(point.some(n=>!Number.isFinite(n)))throw new Error('仿射平面物理坐标超出有限范围。');}
function frame(p:AffinePlane){const lu=Math.hypot(...p.u),lv=Math.hypot(...p.v);if(!Number.isFinite(lu)||!Number.isFinite(lv)||lu<=1e-9||lv<=1e-9)throw new Error('仿射平面步向量必须具有大于1e-9的有限长度。');const u=p.u.map(n=>n/lu) as Vec3,v=p.v.map(n=>n/lv) as Vec3,crossing=cross(u,v),sine=Math.hypot(...crossing);if(!Number.isFinite(sine)||sine*sine<=1e-12)throw new Error('仿射平面方向必须线性独立且Gram矩阵稳定。');return{lu,lv,u,v,cosine:dot(u,v),gram:sine*sine,normal:scale(crossing,1/sine)};}
function at(p:AffinePlane,x:number,y:number):Vec3{const world=add(p.origin,add(scale(p.u,x),scale(p.v,y)));finite(world);return world;}

/** Stores the exact sheared sample frame; validation never orthogonalizes it. */
export function validateAffinePlane(input:unknown):AffinePlane{
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('仿射平面必须是普通对象。');
  const keys=Reflect.ownKeys(input);if(keys.length!==4||keys.some(k=>typeof k!=='string'||!['origin','u','v','size'].includes(k)))throw new Error('仿射平面字段只允许origin/u/v/size。');
  const p:AffinePlane={origin:dense(data(input,'origin'),3) as Vec3,u:dense(data(input,'u'),3) as Vec3,v:dense(data(input,'v'),3) as Vec3,size:dense(data(input,'size'),2) as [number,number]};
  if(p.size.some(n=>!Number.isSafeInteger(n)||n<=0||n>MAX_AFFINE_PLANE_DIMENSION)||p.size[0]*p.size[1]>MAX_AFFINE_PLANE_PIXELS)throw new Error('仿射平面样本尺寸超过正整数/资源范围。');frame(p);for(const x of [-.5,p.size[0]-.5])for(const y of [-.5,p.size[1]-.5])at(p,x,y);return p;
}
export function affinePlanePixelToWorld(input:AffinePlane,pixel:[number,number]):Vec3{const p=validateAffinePlane(input),q=dense(pixel,2);return at(p,q[0]!,q[1]!);}
export function affinePlaneWorldToPixel(input:AffinePlane,world:Vec3):{pixel:[number,number];distance:number}{const p=validateAffinePlane(input),point=dense(world,3) as Vec3,delta=sub(point,p.origin),f=frame(p),du=dot(delta,f.u),dv=dot(delta,f.v),pixel:[number,number]=[(du-f.cosine*dv)/f.gram/f.lu,(dv-f.cosine*du)/f.gram/f.lv],distance=dot(delta,f.normal);if([...pixel,distance].some(n=>!Number.isFinite(n)))throw new Error('仿射平面逆坐标超出有限范围。');return{pixel,distance};}
export function affinePlaneNormal(input:AffinePlane):Vec3{return frame(validateAffinePlane(input)).normal;}
export function validateRigidTransform(input:unknown):number[][]{
  if(!Array.isArray(input)||![3,4].includes(input.length))throw new Error('物理坐标变换必须为3×4或4×4刚体矩阵。');
  const matrix=Array.from({length:input.length},(_,i)=>dense(data(input,String(i)),4));
  if(Reflect.ownKeys(input).length!==input.length+1||Object.getPrototypeOf(input)!==Array.prototype)throw new Error('物理坐标矩阵必须是普通稠密数组。');
  if(matrix.length===4&&matrix[3]!.some((n,k)=>n!==(k===3?1:0)))throw new Error('物理坐标变换不能有透视分量。');
  const rows=matrix.slice(0,3).map(row=>row.slice(0,3) as Vec3);for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(dot(rows[i]!,rows[j]!)-(i===j?1:0))>1e-8)throw new Error('物理坐标变换只允许正交刚体，不能缩放或剪切。');
  if(Math.abs(dot(rows[0]!,cross(rows[1]!,rows[2]!))-1)>1e-8)throw new Error('物理坐标变换必须保持右手方向，不能反射。');return[...matrix.slice(0,3),[0,0,0,1]];
}
export function transformAffinePlane(input:AffinePlane,transform:number[][]):AffinePlane{const p=validateAffinePlane(input),m=validateRigidTransform(transform);if(m.every((row,r)=>row.every((n,k)=>n===(r===k?1:0))))return p;const convert=(v:Vec3,point:boolean):Vec3=>m.slice(0,3).map(row=>row[0]!*v[0]+row[1]!*v[1]+row[2]!*v[2]+(point?row[3]!:0)) as Vec3;return validateAffinePlane({origin:convert(p.origin,true),u:convert(p.u,false),v:convert(p.v,false),size:[...p.size]});}
/** Orthogonal viewing rectangle fits all four full-support corners; stored parameters are untouched. */
export function affinePlaneViewingPlane(input:AffinePlane):MprPlane{
  const p=validateAffinePlane(input),f=frame(p),u=f.u,v=scale(cross(f.normal,u),1),center=at(p,(p.size[0]-1)/2,(p.size[1]-1)/2);let hu=0,hv=0;
  for(const x of [-.5,p.size[0]-.5])for(const y of [-.5,p.size[1]-.5]){const delta=sub(at(p,x,y),center);hu=Math.max(hu,Math.abs(dot(delta,u)));hv=Math.max(hv,Math.abs(dot(delta,v)));}
  let width=Math.min(p.size[0],MAX_MPR_DIMENSION),height=Math.min(p.size[1],MAX_MPR_DIMENSION);if(width*height>MAX_MPR_PIXELS){const factor=Math.sqrt(MAX_MPR_PIXELS/(width*height));width=Math.max(1,Math.floor(width*factor));height=Math.max(1,Math.floor(height*factor));}
  const pu=scale(u,2*hu/width),pv=scale(v,2*hv/height);return validateMprPlane({origin:sub(center,add(scale(pu,(width-1)/2),scale(pv,(height-1)/2))),u:pu,v:pv,size:[width,height]});
}
export function coplanarAffinePlanes(a:AffinePlane,b:AffinePlane,toleranceMm=1e-5):boolean{if(!Number.isFinite(toleranceMm)||toleranceMm<0)throw new Error('平面共面容差必须为非负有限毫米值。');const p=validateAffinePlane(a),q=validateAffinePlane(b),na=frame(p).normal,nb=frame(q).normal;return Math.min(Math.hypot(...sub(na,nb)),Math.hypot(...add(na,nb)))<=1e-8&&Math.abs(dot(sub(q.origin,p.origin),na))<=toleranceMm;}
export function sameAffinePlane(a:AffinePlane,b:AffinePlane,tolerance=1e-8):boolean{if(!Number.isFinite(tolerance)||tolerance<0)throw new Error('平面比较容差必须为非负有限值。');const p=validateAffinePlane(a),q=validateAffinePlane(b);return p.size.every((n,k)=>n===q.size[k])&&(['origin','u','v'] as const).every(key=>p[key].every((n,k)=>Math.abs(n-q[key][k]!)<=tolerance));}
