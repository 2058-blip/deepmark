import type {Volume} from '../core.ts';
import {exchangeGeometry} from './niftiReference.ts';
import {physicalPoint,type Vec3} from './types.ts';

export function sameImageGeometry(a:Volume,b:Volume,tolerance=1e-5):boolean {
  if(!Number.isFinite(tolerance)||tolerance<0)throw new Error('几何比较容差无效。');
  if(a.dims.some((d,i)=>d!==b.dims[i])||a.unit!==b.unit)return false;
  let ga,gb;try{ga=exchangeGeometry(a);gb=exchangeGeometry(b);}catch{return false;}
  // Compare transformed voxel-support corners. A large world origin must not
  // turn a whole-voxel translation into an accepted relative rounding error.
  const allowed=Math.max(tolerance,Math.min(...ga.spacing,...gb.spacing)*1e-4);
  for(let bits=0;bits<8;bits++){
    const p=a.dims.map((d,i)=>bits&(1<<i)?d-.5:-.5) as Vec3,pa=physicalPoint(p,ga),pb=physicalPoint(p,gb);
    if(pa.some(x=>!Number.isFinite(x))||pb.some(x=>!Number.isFinite(x))||Math.hypot(...pa.map((x,i)=>x-pb[i]))>allowed)return false;
  }
  return true;
}
/** Preserve every categorical label as an independent binary mask. No silent union. */
export function splitImportedLabels(data:Float32Array,maxBytes=256*1024*1024):{label:number;data:Uint8Array}[]{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('分割导入内存预算无效。');
  const labels=new Set<number>();
  for(const value of data){
    if(!Number.isSafeInteger(value)||value<0||value>65535)throw new Error('导入分割需为0至65535的整数标签；概率图请先进行阈值分割。');
    if(value)labels.add(value);
    if(labels.size>256||labels.size*data.length>maxBytes)throw new Error('导入标签数超出当前内存预算，请拆分分割文件。');
  }
  if(!labels.size)throw new Error('分割文件中没有前景标签。');
  const masks=[...labels].sort((a,b)=>a-b).map(label=>({label,data:new Uint8Array(data.length)})),lookup=new Map(masks.map(m=>[m.label,m.data]));
  for(let i=0;i<data.length;i++)if(data[i])lookup.get(data[i])![i]=1;
  return masks;
}
