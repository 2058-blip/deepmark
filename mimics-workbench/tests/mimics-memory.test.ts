import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadMesh,uploadMeshEdges,clearMeshEdges,disposeMeshGPU,sameMeshBuffers} from '../src/mimics/meshGPU.ts';
import {resultTransfers} from '../src/mimics/transferBuffers.ts';
import type {TriangleMesh} from '../src/mimics/types.ts';

function mockGL(failAt=Infinity) {
  const uploads:{target:number;data:ArrayBufferView}[]=[],deleted:number[]=[];let serial=0;
  const gl={ARRAY_BUFFER:1,ELEMENT_ARRAY_BUFFER:2,STATIC_DRAW:3,UNSIGNED_INT:4,UNSIGNED_SHORT:5,NO_ERROR:0,OUT_OF_MEMORY:1285,
    createBuffer:()=>++serial,bindBuffer:()=>{},bufferData:(target:number,data:ArrayBufferView)=>uploads.push({target,data}),
    getError:()=>uploads.length===failAt?1285:0,deleteBuffer:(buffer:number)=>deleted.push(buffer)};
  return{gl:gl as unknown as WebGL2RenderingContext,uploads,deleted};
}
function mesh():TriangleMesh{return{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2])};}
test('surface display uploads indexed source buffers without expanding triangles or constructing wire edges',()=>{
  const {gl,uploads,deleted}=mockGL(),source=mesh(),object=uploadMesh(gl,source,true);
  assert.equal(uploads.length,3);assert.equal(uploads[0]!.data,source.positions);assert.equal(uploads[1]!.data,source.normals);
  assert.equal(uploads[2]!.data,source.indices);assert.equal(object.bytes,84);assert.equal(object.edges,null);
  assert.equal(sameMeshBuffers(source,{...source}),true);
  assert.equal(sameMeshBuffers(source,{...source,indices:source.indices.slice()}),false);
  disposeMeshGPU(gl,object);assert.equal(deleted.length,3);
});
test('wire edges are allocated once on demand and released independently when hidden',()=>{
  const {gl,uploads,deleted}=mockGL(),object=uploadMesh(gl,mesh(),true);
  uploadMeshEdges(gl,object);uploadMeshEdges(gl,object);assert.equal(uploads.length,4);
  assert.deepEqual(uploads[3]!.data,new Uint32Array([0,1,1,2,2,0]));assert.equal(object.bytes,108);
  clearMeshEdges(gl,object);assert.equal(object.edges,null);assert.equal(object.bytes,84);assert.equal(deleted.length,1);
  disposeMeshGPU(gl,object);assert.equal(deleted.length,4);
});
test('GPU allocation failure cleans all partial buffers and leaves original mesh arrays intact',()=>{
  const {gl,deleted}=mockGL(2),source=mesh();
  assert.throws(()=>uploadMesh(gl,source,true),/显卡内存不足/);assert.equal(deleted.length,2);
  assert.deepEqual(source.indices,new Uint32Array([0,1,2]));assert.equal(source.positions.byteLength,36);
});
test('WebGL 1 fallback uses 16 bit indices only when the full vertex range fits',()=>{
  const {gl,uploads}=mockGL();uploadMesh(gl,mesh(),false);
  assert.ok(uploads[2]!.data instanceof Uint16Array);
  assert.throws(()=>uploadMesh(gl,{positions:new Float32Array(65537*3),indices:new Uint32Array([0,1,65536])},false),/32 位索引/);
  assert.equal(uploads.length,3);
});
test('nested worker results transfer each owned buffer once while preserving the resident grid',()=>{
  const sourceGrid=new Float32Array([1,2]),geometry=mesh(),result:any={items:[{mesh:geometry}],mask:new Uint8Array([1,0]),grid:sourceGrid};
  result.self=result;result.alias=geometry.positions;
  const transfers=resultTransfers(result,new Set([sourceGrid.buffer]));
  assert.equal(transfers.length,4);
  const received=structuredClone(result,{transfer:transfers});
  assert.equal(geometry.positions.byteLength,0);assert.equal(geometry.indices.byteLength,0);assert.equal(result.mask.byteLength,0);
  assert.equal(sourceGrid.byteLength,8);assert.deepEqual(received.items[0].mesh.indices,new Uint32Array([0,1,2]));
  assert.equal(received.items[0].mesh.positions,received.alias);assert.equal(received.self,received);
});
