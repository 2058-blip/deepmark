import {parseNifti,type Volume} from '../core.ts';
import type {VolumeGrid} from './types.ts';

export interface NiftiReference {applicationToReference:number[][];frame:'RAS'|'source-aligned'}
export interface ResliceReferenceOptions {legacyResliced?:boolean}
export interface ResliceReferenceResult {reference:NiftiReference;code:number;warnings:string[]}
const knownCodes=[1,2,3,4,5];
function data(object:object,key:PropertyKey):unknown{const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!d.enumerable||!('value'in d))throw new Error('NIfTI 参考坐标只接受普通可枚举数据字段。');return d.value;}
function dense(value:unknown,length:number):unknown[]{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==length||Reflect.ownKeys(value).length!==length+1)throw new Error('NIfTI 参考坐标矩阵必须为普通稠密数组。');return Array.from({length},(_,i)=>data(value,String(i)));}
export function identityReferenceMatrix():number[][]{return[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];}
/** Metadata always stores a complete proper-rigid 4x4 mm transform. */
export function validateReferenceMatrix(input:unknown):number[][]{
  const matrix=dense(input,4).map(row=>dense(row,4).map(n=>{if(typeof n!=='number'||!Number.isFinite(n))throw new Error('NIfTI 参考矩阵必须包含有限数。');return n;}));
  if(matrix[3]!.some((n,i)=>n!==(i===3?1:0)))throw new Error('NIfTI 参考矩阵不能含透视分量。');
  for(let r=0;r<3;r++)for(let c=0;c<3;c++){let dot=0;for(let k=0;k<3;k++)dot+=matrix[r]![k]!*matrix[c]![k]!;if(Math.abs(dot-(r===c?1:0))>1e-8)throw new Error('NIfTI 参考矩阵必须为不含缩放或剪切的刚体。');}
  const [a,b,c]=matrix,det=a![0]!*(b![1]!*c![2]!-b![2]!*c![1]!)-a![1]!*(b![0]!*c![2]!-b![2]!*c![0]!)+a![2]!*(b![0]!*c![1]!-b![1]!*c![0]!);if(Math.abs(det-1)>1e-8)throw new Error('NIfTI 参考矩阵必须保持右手坐标系，不能反射。');return matrix;
}
export function validateNiftiReference(input:unknown):NiftiReference{
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('NIfTI 参考坐标元数据必须为普通对象。');
  const keys=Reflect.ownKeys(input);if(keys.length!==2||keys.some(k=>k!=='applicationToReference'&&k!=='frame'))throw new Error('NIfTI 参考坐标元数据字段无效。');
  const frame=data(input,'frame');if(frame!=='RAS'&&frame!=='source-aligned')throw new Error('NIfTI 参考坐标 frame 无效。');return{frame,applicationToReference:validateReferenceMatrix(data(input,'applicationToReference'))};
}
export function multiplyReferenceMatrices(a:number[][],b:number[][]):number[][]{const result=a.map(row=>[0,1,2,3].map(c=>row.reduce((sum,n,k)=>sum+n*b[k]![c]!,0)));if(result.flat().some(n=>!Number.isFinite(n)))throw new Error('NIfTI 参考坐标计算超出有限范围。');return result;}
export function inverseReferenceMatrix(input:number[][]):number[][]{const m=validateReferenceMatrix(input);return[...([0,1,2] as const).map(r=>[m[0]![r]!,m[1]![r]!,m[2]![r]!,-m.slice(0,3).reduce((sum,row)=>sum+row[r]!*row[3]!,0)]),[0,0,0,1]];}
export function applicationAffineMm(volume:Volume):number[][]{
  const a=volume.affine;if(!Array.isArray(a)||a.length!==3||a.some(row=>!Array.isArray(row)||row.length!==4||row.some(n=>!Number.isFinite(n))))throw new Error('应用影像仿射矩阵无效。');
  const unit=volume.header[123]!&7,scale=unit===1?1000:unit===3?.001:1;return[...a.map(row=>row.map(n=>n*scale)),[0,0,0,1]];
}
export function referenceAffineMm(volume:Volume):number[][]{const app=applicationAffineMm(volume);return volume.niftiReference===undefined?app:multiplyReferenceMatrices(validateNiftiReference(volume.niftiReference).applicationToReference,app);}
export function inspectReferenceHeader(volume:Pick<Volume,'header'|'little'>):Volume{
  if(!(volume.header instanceof Uint8Array)||volume.header.byteLength!==348)throw new Error('NIfTI 参考头无效。');
  const probe=new ArrayBuffer(360),h=new DataView(probe);new Uint8Array(probe).set(volume.header);for(let i=1;i<8;i++)h.setInt16(40+i*2,1,volume.little);h.setFloat32(108,352,volume.little);return parseNifti(probe,'NIfTI reference header probe');
}
/** Sform uses an exact Float32 coefficient certificate, never a large-origin
 * relative tolerance. Qform-derived matrices allow only Float64 arithmetic noise.
 */
export function validateReferenceHeader(volume:Volume,parsed?:Volume):NiftiReference|undefined{
  if(volume.niftiReference===undefined)return undefined;
  if(volume.unit!=='mm'||![1,2,3].includes(volume.header[123]!&7))throw new Error('NIfTI 参考坐标映射要求已经确认的毫米空间单位。');
  const reference=validateNiftiReference(volume.niftiReference);validateReferenceFrameCode(reference,headerReferenceCode(volume));
  const geometry=parsed??inspectReferenceHeader(volume),unit=volume.header[123]!&7,scale=unit===1?1000:unit===3?.001:1,expected=referenceAffineMm(volume),h=new DataView(volume.header.buffer,volume.header.byteOffset,volume.header.byteLength),sform=h.getInt16(254,volume.little)>0;
  for(let r=0;r<3;r++)for(let c=0;c<4;c++){
    const raw=expected[r]![c]!/scale,stored=geometry.affine[r]![c]!;
    if(sform?!Number.isFinite(Math.fround(raw))||Math.fround(raw)!==stored:Math.abs(raw-stored)>32*Number.EPSILON*Math.max(1,Math.abs(raw),Math.abs(stored)))throw new Error('NIfTI 参考头与应用坐标映射不符合存储精度证书。');
  }
  return reference;
}
/** Compare the verified file encoding for Ref volumes, so a real exported Mask
 * imports against the same rounded sform. Legacy volumes retain their old policy.
 */
export function exchangeGeometry(volume:Volume):VolumeGrid{
  if(volume.niftiReference===undefined)return{dims:[...volume.dims],spacing:[...volume.spacing],data:volume.data,affine:applicationAffineMm(volume).slice(0,3)};
  const geometry=inspectReferenceHeader(volume);validateReferenceHeader(volume,geometry);return{dims:[...volume.dims],spacing:[...geometry.spacing],data:volume.data,affine:applicationAffineMm(geometry).slice(0,3)};
}
/** Actual encoding error at voxel-support corners, measured in reference mm. */
export function referenceEncodingErrorMm(volume:Volume,parsed?:Volume):number{
  const geometry=parsed??inspectReferenceHeader(volume),expected=referenceAffineMm(volume),stored=applicationAffineMm(geometry),delta=expected.slice(0,3).map((row,r)=>row.map((n,c)=>n-stored[r]![c]!));let maximum=0;
  for(let bits=0;bits<8;bits++){const p=volume.dims.map((d,k)=>bits&(1<<k)?d-.5:-.5),error=delta.map(row=>row[3]!+row[0]!*p[0]!+row[1]!*p[1]!+row[2]!*p[2]!);maximum=Math.max(maximum,Math.hypot(...error));}if(!Number.isFinite(maximum))throw new Error('NIfTI 参考头量化误差超出有限范围。');return maximum;
}
export function affineIsOblique(affine:number[][]):boolean{return[0,1,2].some(c=>{const values=affine.slice(0,3).map(row=>Math.abs(row[c]!)),length=Math.hypot(...values);if(!Number.isFinite(length)||length<=0)throw new Error('应用影像方向矩阵不能退化。');return Math.max(...values)/length<.9999;});}
export function headerReferenceCode(volume:Pick<Volume,'header'|'little'>):number{if(!(volume.header instanceof Uint8Array)||volume.header.byteLength!==348)throw new Error('NIfTI 参考头无效。');const view=new DataView(volume.header.buffer,volume.header.byteOffset,volume.header.byteLength),sform=view.getInt16(254,volume.little),qform=view.getInt16(252,volume.little);return sform>0?sform:qform>0?qform:0;}
export function validateReferenceFrameCode(reference:NiftiReference,code:number):void{if(reference.frame==='RAS'?!knownCodes.includes(code):code!==2)throw new Error('NIfTI 参考 frame 与头内坐标代码不一致。');}
export function composeResliceReference(source:Volume,outputWorldToSourceWorld:number[][],options:ResliceReferenceOptions={}):ResliceReferenceResult{
  const inverse=validateReferenceMatrix(outputWorldToSourceWorld),code=headerReferenceCode(source),dicom=(source as Volume&{dicom?:{coordinateSystem?:string}}).dicom,warnings:string[]=[];let prior:NiftiReference,outputCode:number;
  if(source.niftiReference!==undefined){prior=validateReferenceHeader(source)!;outputCode=code;}
  else if(knownCodes.includes(code)&&dicom?.coordinateSystem!=='reslice-local'&&!(options.legacyResliced&&dicom?.coordinateSystem!=='RAS')){prior={applicationToReference:identityReferenceMatrix(),frame:'RAS'};outputCode=code;}
  else{prior={applicationToReference:identityReferenceMatrix(),frame:'source-aligned'};outputCode=2;warnings.push('旧影像参考方向或旧重切片父坐标不可恢复；NIfTI 仅标为与源文件坐标对齐，不声明患者 RAS 或扫描仪坐标。');}
  return{reference:{applicationToReference:validateReferenceMatrix(multiplyReferenceMatrices(prior.applicationToReference,inverse)),frame:prior.frame},code:outputCode,warnings};
}
