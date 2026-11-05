import type {TriangleMesh, Vec3} from './types.ts';
import {computeNormals} from './geometry.ts';
type GL = WebGLRenderingContext | WebGL2RenderingContext;
export interface MeshGPU {
  mesh: TriangleMesh; positions: WebGLBuffer; normals: WebGLBuffer; indices: WebGLBuffer;
  edges: WebGLBuffer | null; indexType: number; count: number; edgeCount: number; bytes: number;
}
export function sameMeshBuffers(a: TriangleMesh, b: TriangleMesh) {
  return a.positions === b.positions && a.indices === b.indices && a.normals === b.normals;
}
export function meshBounds(mesh: TriangleMesh) {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const id of mesh.indices) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, mesh.positions[3 * id + k]!);
    max[k] = Math.max(max[k]!, mesh.positions[3 * id + k]!);
  }
  if (!mesh.indices.length) { min.fill(0); max.fill(0); }
  return {min, max};
}
function uploadBuffer(gl: GL, target: number, data: ArrayBufferView): WebGLBuffer {
  const buffer = gl.createBuffer(); if (!buffer) throw new Error('显卡缓冲区分配失败，请减少同时显示的模型。');
  try {
    gl.bindBuffer(target, buffer); gl.bufferData(target, data, gl.STATIC_DRAW);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(error === gl.OUT_OF_MEMORY
      ? '显卡内存不足。模型数据已保留，可隐藏其他模型，或用 Custom 增大采样步长后重新生成。'
      : '模型缓冲区上传失败，请检查浏览器硬件加速或重新打开三维视图。');
    return buffer;
  } catch (error) { gl.deleteBuffer(buffer); throw error; }
}
export function uploadMesh(gl: GL, mesh: TriangleMesh, uint32: boolean): MeshGPU {
  if (!uint32 && mesh.positions.length / 3 > 65536) throw new Error('当前 WebGL 不支持大模型的 32 位索引，请使用支持 WebGL 2 的 Edge 或 Chrome。');
  const indices = uint32 ? mesh.indices : new Uint16Array(mesh.indices);
  const normals = mesh.normals?.length === mesh.positions.length ? mesh.normals : computeNormals(mesh);
  const allocated: WebGLBuffer[] = [];
  const add = (target: number, data: ArrayBufferView) => { const buffer = uploadBuffer(gl, target, data); allocated.push(buffer); return buffer; };
  try {
    return {mesh,positions:add(gl.ARRAY_BUFFER,mesh.positions),normals:add(gl.ARRAY_BUFFER,normals),
      indices:add(gl.ELEMENT_ARRAY_BUFFER,indices),edges:null,indexType:uint32?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,
      count:indices.length,edgeCount:0,bytes:mesh.positions.byteLength+normals.byteLength+indices.byteLength};
  } catch (error) { for (const buffer of allocated) gl.deleteBuffer(buffer); throw error; }
}
export function uploadMeshEdges(gl: GL, object: MeshGPU) {
  if (object.edges) return;
  const indices = object.mesh.indices, edges = object.indexType === gl.UNSIGNED_INT
    ? new Uint32Array(indices.length * 2) : new Uint16Array(indices.length * 2);
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    edges[2 * (i + j)] = indices[i + j]!;
    edges[2 * (i + j) + 1] = indices[i + (j + 1) % 3]!;
  }
  object.edges = uploadBuffer(gl,gl.ELEMENT_ARRAY_BUFFER,edges);
  object.edgeCount = edges.length; object.bytes += edges.byteLength;
}
export function clearMeshEdges(gl: GL, object: MeshGPU) {
  if (!object.edges) return;
  gl.deleteBuffer(object.edges); object.edges = null;
  object.bytes -= object.edgeCount * (object.indexType === gl.UNSIGNED_INT ? 4 : 2); object.edgeCount = 0;
}
export function disposeMeshGPU(gl: GL, object: MeshGPU) {
  for (const buffer of [object.positions,object.normals,object.indices,object.edges]) if (buffer) gl.deleteBuffer(buffer);
}
