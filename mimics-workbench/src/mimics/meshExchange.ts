import {validateMesh} from './geometry.ts';
import {validateNiftiReference,inverseReferenceMatrix,type NiftiReference} from './niftiReference.ts';
import type {TriangleMesh} from './types.ts';

export type MeshCoordinateFrame='reference'|'application';

function meshBuffers(input:TriangleMesh):TriangleMesh{
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('STL 网格必须是普通对象。');
  const keys=Reflect.ownKeys(input);if(keys.some(key=>typeof key!=='string'||!['positions','indices','normals'].includes(key)))throw new Error('STL 网格字段无效。');
  const read=(key:string):unknown=>{const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||!('value'in descriptor))throw new Error('STL 网格只接受数据字段。');return descriptor.value;};
  const positions=read('positions'),indices=read('indices'),normals=keys.includes('normals')?read('normals'):undefined;
  if(!(positions instanceof Float32Array)||!(indices instanceof Uint32Array)||normals!==undefined&&!(normals instanceof Float32Array))throw new Error('STL 网格需要 Float32 顶点/法线与 Uint32 索引。');
  for(const array of [positions,indices,...(normals?[normals]:[])]){
    const buffer=array.buffer;if(!(buffer instanceof ArrayBuffer)||(buffer as ArrayBuffer&{resizable?:boolean}).resizable)throw new Error('STL 网格需要固定且独立的 ArrayBuffer。');
    try{new Uint8Array(buffer,0,0);}catch{throw new Error('STL 网格缓冲区已分离。');}
  }
  const mesh:TriangleMesh={positions,indices,...(normals!==undefined?{normals}:{})};validateMesh(mesh);
  if(normals!==undefined&&(normals.length!==positions.length||normals.some(value=>!Number.isFinite(value))))throw new Error('STL 网格法线长度或数值无效。');
  return mesh;
}
function convert(input:TriangleMesh,reference:NiftiReference|undefined,frame:MeshCoordinateFrame,inverse:boolean):TriangleMesh{
  if(frame!=='reference'&&frame!=='application')throw new Error('STL 坐标选项必须为 reference 或 application。');
  const metadata=reference===undefined?undefined:validateNiftiReference(reference),mesh=meshBuffers(input),matrix=frame==='reference'&&metadata?(inverse?inverseReferenceMatrix(metadata.applicationToReference):metadata.applicationToReference):undefined;
  const transform=(values:Float32Array,point:boolean)=>{
    const result=new Float32Array(values.length);if(!matrix){result.set(values);return result;}
    for(let index=0;index<values.length;index+=3)for(let row=0;row<3;row++){
      const coefficients=matrix[row]!,value=coefficients[0]!*values[index]!+coefficients[1]!*values[index+1]!+coefficients[2]!*values[index+2]!+(point?coefficients[3]!:0);
      if(!Number.isFinite(value)||!Number.isFinite(Math.fround(value)))throw new Error('STL 坐标变换超出有限 Float32 范围。');result[index+row]=value;
    }
    return result;
  };
  // Publish only complete owned arrays. Normals are vectors: translation never applies.
  const positions=transform(mesh.positions,true),normals=mesh.normals===undefined?undefined:transform(mesh.normals,false),indices=mesh.indices.slice();
  return{positions,indices,...(normals!==undefined?{normals}:{})};
}
/** Default standalone STL coordinates align with the image/Mask NIfTI reference frame. */
export function meshToReference(mesh:TriangleMesh,niftiReference?:NiftiReference,frame:MeshCoordinateFrame='reference'):TriangleMesh{return convert(mesh,niftiReference,frame,false);}
/** Apply the inverse mapping when a standalone reference-coordinate STL re-enters the app. */
export function meshFromReference(mesh:TriangleMesh,niftiReference?:NiftiReference,frame:MeshCoordinateFrame='reference'):TriangleMesh{return convert(mesh,niftiReference,frame,true);}
