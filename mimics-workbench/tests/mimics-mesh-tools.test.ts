import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSurface, computeNormals, meshStats } from '../src/mimics/geometry.ts';
import { cutMeshByPlane, diagnoseMesh, fixMeshNormals, mergeMeshes, splitConnectedComponents, stitchMesh, surfacePath } from '../src/mimics/meshTools.ts';
import type { TriangleMesh, Vec3, VolumeGrid } from '../src/mimics/types.ts';

function cube(min: Vec3 = [0,0,0], max: Vec3 = [4,4,4], inward = false): TriangleMesh {
  const p = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].flatMap(c => c.map((x,k) => min[k]! + x * (max[k]! - min[k]!)));
  const indices = new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  if (inward) for (let f=0; f<indices.length; f+=3) [indices[f+1],indices[f+2]]=[indices[f+2]!,indices[f+1]!];
  const mesh = {positions:new Float32Array(p),indices}; return {...mesh,normals:computeNormals(mesh)};
}
function close(mesh: TriangleMesh, euler=2) { const s=meshStats(mesh);assert.equal(s.boundaryEdges,0);assert.equal(s.nonManifoldEdges,0);assert.equal(s.nonManifoldVertices,0);assert.equal(s.degenerateTriangles,0);assert.equal(s.inconsistentEdges,0);assert.ok(s.closed);assert.equal(s.eulerCharacteristic,euler);assert.ok(s.signedVolume>0);return s; }
function approx(a:number,b:number,tolerance=1e-5){assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);}

test('plane cut splits real triangles, shares intersections, closes caps and conserves cube volume',()=>{
  const source=cube(),positions=source.positions.slice(),indices=source.indices.slice();
  const result=cutMeshByPlane(source,{origin:[2,0,0],normal:[1,0,0]});
  approx(close(result.positive).volume,32);approx(close(result.negative).volume,32);
  assert.equal(result.contours.length,1);assert.equal(result.contours[0]!.length,9);assert.equal(result.openContours.length,0);assert.ok(result.capped);assert.ok(result.intersects);
  for(const p of result.contours[0]!)approx(p[0],2);
  assert.deepEqual(source.positions,positions);assert.deepEqual(source.indices,indices);
  const open=cutMeshByPlane(source,{origin:[2,0,0],normal:[1,0,0]},{cap:false});assert.equal(meshStats(open.positive).boundaryEdges,8);assert.equal(open.capped,false);
});

test('diagonal cuts through existing vertices/edges and arbitrary planes remain closed with correct winding',()=>{
  const source=cube();
  const planes=[{origin:[0,0,0]as Vec3,normal:[1,-1,0]as Vec3},{origin:[2,2,2]as Vec3,normal:[1,1,1]as Vec3},...Array.from({length:16},(_,i)=>({origin:[2,2,2]as Vec3,normal:[Math.sin(i+.3),Math.cos(i*.7),Math.sin(i*1.1+.2)]as Vec3}))];
  for(const plane of planes){const r=cutMeshByPlane(source,plane);const a=close(r.positive),b=close(r.negative);approx(a.volume+b.volume,64,2e-5);approx(a.volume,32,2e-5);for(let i=0;i<r.positive.positions.length;i+=3){let distance=0;for(let k=0;k<3;k++)distance+=(r.positive.positions[i+k]!-plane.origin[k]!)*plane.normal[k]!;assert.ok(distance>=-2e-6);}}
});

test('tangent and empty plane cuts return a complete untouched side without duplicate coplanar faces',()=>{
  for(const x of [0,4,8,-4]){const r=cutMeshByPlane(cube(),{origin:[x,0,0],normal:[1,0,0]});const nonempty=[r.positive,r.negative].filter(m=>m.indices.length);assert.equal(nonempty.length,1);approx(close(nonempty[0]!).volume,64);assert.equal(r.capped,false);assert.equal(r.contours.length,0);}
});

test('caps handle multiple disconnected contours and nested hollow contours without filling the cavity',()=>{
  const multiple=mergeMeshes([cube(),cube([0,8,0],[4,12,4])]);const r=cutMeshByPlane(multiple,{origin:[2,0,0],normal:[1,0,0]});
  assert.equal(r.contours.length,2);approx(close(r.positive,4).volume,64);assert.equal(splitConnectedComponents(r.positive).length,2);
  const hollow=mergeMeshes([cube(),cube([1,1,1],[3,3,3],true)]),h=cutMeshByPlane(hollow,{origin:[2,0,0],normal:[1,0,0]});
  assert.equal(h.contours.length,2);approx(close(h.positive).volume,28);approx(close(h.negative).volume,28);
  // Outer 4x4 section minus inner 2x2 section: the caps together contribute 24 mm².
  approx(meshStats(h.positive).area+meshStats(h.negative).area-meshStats(hollow).area,24);
  const twoHoles=mergeMeshes([cube([0,0,0],[10,10,10]),cube([1,1,1],[9,3,3],true),cube([1,6,6],[9,8,8],true)]),t=cutMeshByPlane(twoHoles,{origin:[5,0,0],normal:[1,0,0]});assert.equal(t.contours.length,3);approx(close(t.positive).volume,468);approx(close(t.negative).volume,468);
  const island=mergeMeshes([cube([0,0,0],[10,10,10]),cube([1,1,1],[9,9,9],true),cube([2,2,2],[8,8,8])]),nested=cutMeshByPlane(island,{origin:[5,0,0],normal:[1,0,0]});assert.equal(nested.contours.length,3);approx(close(nested.positive,4).volume,352);approx(close(nested.negative,4).volume,352);
});

test('concave L-section caps preserve all original contour edges and do not fill the missing corner',()=>{
  const polygon=[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]],p=[...polygon.flatMap(v=>[...v,0]),...polygon.flatMap(v=>[...v,3])];
  const ids=[0,2,1,0,3,2,0,5,3,3,5,4,6,7,8,6,8,9,6,9,11,9,10,11];for(let i=0;i<6;i++){const j=(i+1)%6;ids.push(i,j,j+6,i,j+6,i+6);}
  const source:TriangleMesh={positions:new Float32Array(p),indices:new Uint32Array(ids)};approx(close({...source,normals:computeNormals(source)}).volume,9);
  const r=cutMeshByPlane(source,{origin:[0,0,1.5],normal:[0,0,1]});approx(close(r.positive).volume,4.5);approx(close(r.negative).volume,4.5);assert.equal(r.contours.length,1);
});

test('open surface cuts remain open explicitly, while cap and invalid input failures are not disguised as repair',()=>{
  const triangle:TriangleMesh={positions:new Float32Array([0,0,0,2,0,0,0,2,0]),indices:new Uint32Array([0,1,2])};
  const r=cutMeshByPlane(triangle,{origin:[.5,0,0],normal:[1,0,0]},{cap:false});assert.equal(r.openContours.length,1);approx(meshStats(r.positive).area+meshStats(r.negative).area,2);
  assert.throws(()=>cutMeshByPlane(triangle,{origin:[.5,0,0],normal:[1,0,0]}),/闭合/);
  assert.throws(()=>cutMeshByPlane(cube(),{origin:[0,0,0],normal:[0,0,0]}),/平面/);
  assert.throws(()=>cutMeshByPlane(cube(),{origin:[2,0,0],normal:[1,0,0]},{cancelled:()=>true}),/取消/);
});

test('component split uses shared edges by default and can distinguish point-touch from vertex connectivity',()=>{
  const mesh=mergeMeshes([cube(),cube([8,0,0],[10,2,2])]),parts=splitConnectedComponents(mesh);assert.equal(parts.length,2);assert.ok(parts[0]!.indices.length>=parts[1]!.indices.length);approx(meshStats(parts[0]!).volume+meshStats(parts[1]!).volume,72);
  const touching:TriangleMesh={positions:new Float32Array([0,0,0,1,0,0,0,1,0,-1,0,0,0,-1,0]),indices:new Uint32Array([0,1,2,0,3,4])};
  assert.equal(splitConnectedComponents(touching).length,2);assert.equal(splitConnectedComponents(touching,{connectivity:'vertex'}).length,1);
  assert.throws(()=>splitConnectedComponents(mesh,{cancelled:()=>true}),/取消/);
});

test('surface path projects into triangle interiors, obeys via points and labels edge graph approximation',()=>{
  const patch:TriangleMesh={positions:new Float32Array([0,0,0,4,0,0,4,4,0,0,4,0]),indices:new Uint32Array([0,1,2,0,2,3])};
  const direct=surfacePath(patch,[[.5,.25,2],[3,.5,2]]);assert.equal(direct.method,'edge-graph');assert.equal(direct.approximate,true);approx(direct.length,Math.hypot(2.5,.25));assert.deepEqual(direct.projectionDistances,[2,2]);for(const p of direct.points)approx(p[2],0);
  const via=surfacePath(patch,[[.5,.25,0],[2,2,0],[.5,3,0]]);assert.ok(via.points.some(p=>Math.hypot(p[0]-2,p[1]-2,p[2])<1e-8));assert.ok(via.length>=via.chordLowerBound-1e-8);
  const across=surfacePath(patch,[[.5,3.5,0],[3.5,.5,0]]);assert.ok(across.length>across.chordLowerBound,'coarse edge graph must not be presented as the exact planar geodesic');
  assert.throws(()=>surfacePath(patch,[[0,0,3],[1,1,0]],{maxProjectionDistance:1}),/投影/);
  assert.throws(()=>surfacePath(mergeMeshes([cube(),cube([8,0,0],[12,4,4])]),[[0,2,2],[8,2,2]]),/不连通/);
});

test('edge paths on a faceted sphere lie on surface edges and bound the analytic arc without claiming equality',()=>{
  const dims:Vec3=[21,21,21],g:VolumeGrid={dims,spacing:[1,1,1],data:new Float32Array(21**3)},field=Float32Array.from(g.data,(_,i)=>{const x=i%21,y=Math.floor(i/21)%21,z=Math.floor(i/441);return 64-(x-10)**2-(y-10)**2-(z-10)**2;}),mask=Uint8Array.from(field,x=>+(x>=0));
  const mesh=calculateSurface(g,mask,{scalarField:field,threshold:0}),p=surfacePath(mesh,[[18,10,10],[10,18,10]]);assert.ok(p.length>=p.chordLowerBound);assert.ok(Math.abs(p.length/(4*Math.PI)-1)<.2);for(const point of p.points)assert.ok(Math.abs(Math.hypot(point[0]-10,point[1]-10,point[2]-10)-8)<.08);
});

test('normal repair corrects arbitrary triangle flips without changing positions or triangle count',()=>{
  const source=cube();for(let f=0;f<source.indices.length;f+=6)[source.indices[f+1],source.indices[f+2]]=[source.indices[f+2]!,source.indices[f+1]!];const before=source.indices.slice();
  assert.ok(meshStats(source).inconsistentEdges>0);const fixed=fixMeshNormals(source);approx(close(fixed).volume,64);assert.deepEqual(source.indices,before);assert.deepEqual(fixed.positions,source.positions);assert.equal(fixed.indices.length,source.indices.length);
});

test('normal repair preserves inward cavity walls through shell nesting, with an explicit separate-shell override',()=>{
  const wrong=mergeMeshes([cube([0,0,0],[6,6,6],true),cube([1,1,1],[5,5,5])]),fixed=fixMeshNormals(wrong);approx(close(fixed,4).volume,216-64);assert.equal(meshStats(fixed).components,2);
  const positiveShells=fixMeshNormals(wrong,{preserveCavities:false});approx(meshStats(positiveShells).volume,216+64);
});

test('boundary stitching welds a triangle soup to a closed cube, preserves coordinates, and refuses destructive tolerances',()=>{
  const source=cube(),p:number[]=[];for(const i of source.indices)p.push(...source.positions.subarray(i*3,i*3+3));const soup:TriangleMesh={positions:new Float32Array(p),indices:Uint32Array.from({length:p.length/3},(_,i)=>i)};
  assert.equal(meshStats(soup).boundaryEdges,36);const fixed=stitchMesh(soup,{tolerance:0});assert.equal(meshStats(fixed).vertices,8);approx(close(fixed).volume,64);assert.equal(soup.positions.length,108);
  assert.throws(()=>stitchMesh(soup,{tolerance:10}),/退化/);
  assert.throws(()=>stitchMesh(mergeMeshes([source,source]),{boundaryOnly:false,tolerance:0}),/重复面/);
});

test('hole diagnostics report boundary loops and retain the explicit self-intersection limitation',()=>{
  const box=cube(),open={positions:box.positions,indices:box.indices.subarray(6)},d=diagnoseMesh(open);assert.equal(d.boundaryLoops.length,1);assert.equal(d.openBoundaryChains.length,0);assert.equal(d.boundaryEdges,4);assert.equal(d.selfIntersections,'not-checked');
  assert.deepEqual(d.boundaryLoops[0]![0],d.boundaryLoops[0]!.at(-1));assert.equal(d.closed,false);
});
