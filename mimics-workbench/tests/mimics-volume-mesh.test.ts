import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConformingVolumeMesh,calibrateMaterials,exportAbaqusVolumeMesh,exportVolumeMeshJSON,exportVTKVolumeMesh,parseAbaqusVolumeMesh,parseVolumeMeshJSON,parseVTKVolumeMesh,resolveAssembly,sampleElementGrayValues,signedTetraVolume,tetraQuality,validateVolumeMesh,volumeMeshStats,type AssemblyMask,type TetraVolumeMesh} from '../src/mimics/volumeMesh.ts';
import {type Vec3,type VolumeGrid,voxelIndex} from '../src/mimics/types.ts';
const near=(a:number,b:number,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
function grid(dims:Vec3=[2,1,1],spacing:Vec3=[1,1,1]):VolumeGrid{return {dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])};}
function mask(g:VolumeGrid,id:string,predicate:(x:number,y:number,z:number)=>boolean,materialId?:number):AssemblyMask{const data=new Uint8Array(g.data.length);for(let z=0;z<g.dims[2];z++)for(let y=0;y<g.dims[1];y++)for(let x=0;x<g.dims[0];x++)data[voxelIndex([x,y,z],g.dims)]=+predicate(x,y,z);return {id,name:`材料 ${id}`,mask:data,materialId};}
function twoRegions(){const g=grid();return {g,mesh:buildConformingVolumeMesh(g,[mask(g,'A',x=>x===0,10),mask(g,'B',x=>x===1,20)])};}
function point(mesh:TetraVolumeMesh,i:number):Vec3{return [mesh.positions[3*i]!,mesh.positions[3*i+1]!,mesh.positions[3*i+2]!];}
const sub=(a:Vec3,b:Vec3):Vec3=>a.map((v,k)=>v-b[k]!) as Vec3;
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:Vec3,b:Vec3)=>a.reduce((s,v,k)=>s+v*b[k]!,0);
function centroid(mesh:TetraVolumeMesh,i:number):Vec3{return [0,1,2].map(k=>[0,1,2,3].reduce((s,j)=>s+mesh.positions[3*mesh.elements[4*i+j]!+k]!/4,0)) as Vec3;}

test('Mask Assembly priority is first-added wins and later masks retain only unassigned voxels',()=>{
  const g=grid([4,1,1]),inputs=[mask(g,'A',x=>x<2,7),mask(g,'B',x=>x>=1&&x<=2,9),mask(g,'C',x=>x>=2)],before=inputs.map(m=>m.mask.slice());
  const assembly=resolveAssembly(g,inputs);assert.deepEqual([...assembly.labels],[1,1,2,3]);assert.deepEqual(assembly.assignedCounts,[2,1,1]);assert.deepEqual(assembly.overlapCounts,[0,1,1]);assert.equal(assembly.occupiedCount,4);inputs.forEach((m,i)=>assert.deepEqual(m.mask,before[i]));
  const reversed=resolveAssembly(g,[inputs[2]!,inputs[1]!,inputs[0]!]);assert.deepEqual([...reversed.labels],[3,2,1,1]);
});

test('a voxel becomes six positive Freudenthal tetrahedra with exact support volume and twelve exterior triangles',()=>{
  const g=grid([1,1,1],[2,3,4]),mesh=buildConformingVolumeMesh(g,[mask(g,'all',()=>true)]),s=volumeMeshStats(mesh);validateVolumeMesh(mesh);
  assert.equal(s.nodes,8);assert.equal(s.elements,6);assert.equal(s.boundaryFaces,12);assert.equal(s.interfaceFaces,0);near(s.totalVolume,24);near(s.boundaryArea,52);near(s.minVolume,4);near(s.maxVolume,4);assert.equal(s.invertedElements,0);assert.equal(s.degenerateElements,0);assert.equal(s.qualityCertified,false);
  assert.ok(s.minMeanRatio>0&&s.minMeanRatio<=1);assert.ok(s.minScaledJacobian>0&&s.minScaledJacobian<=1);assert.equal(s.boundaryMetadataMismatches,0);
});

test('adjacent materials share global nodes and one copy of each matching interface triangle',()=>{
  const {mesh}=twoRegions(),s=volumeMeshStats(mesh);assert.equal(s.nodes,12);assert.equal(s.elements,12);assert.equal(s.boundaryFaces,20);assert.equal(s.interfaceFaces,2);near(s.totalVolume,2);near(s.interfaceArea,1);near(s.boundaryArea,10);near(s.regionVolumes['1']!,1);near(s.regionVolumes['2']!,1);assert.equal(s.components,1);
  const keys=new Set<string>();for(const face of mesh.interfaceFaces){const key=[...face.nodes].sort((a,b)=>a-b).join(',');assert.ok(!keys.has(key));keys.add(key);assert.notEqual(face.regionIds[0],face.regionIds[1]);assert.ok(face.neighbour>=0);for(const id of face.nodes){assert.ok([...mesh.elements.subarray(face.owner*4,face.owner*4+4)].includes(id));assert.ok([...mesh.elements.subarray(face.neighbour*4,face.neighbour*4+4)].includes(id));}const[a,b,c]=face.nodes.map(id=>point(mesh,id));assert.ok(dot(cross(sub(b!,a!),sub(c!,a!)),sub(centroid(mesh,face.neighbour),centroid(mesh,face.owner)))>0);}
  assert.ok(mesh.boundaryFaces.every(face=>!face.nodes.every(id=>point(mesh,id)[0]===.5)),'the interior contact plane must not be emitted as a void boundary');
});

test('a multi-voxel grid has conforming matching faces in all three directions, even for equal material IDs',()=>{
  const g=grid([3,4,2]),mesh=buildConformingVolumeMesh(g,[mask(g,'even',x=>x%2===0,5),mask(g,'odd',x=>x%2===1,5)]),s=volumeMeshStats(mesh);validateVolumeMesh(mesh);
  assert.equal(s.nodes,60);assert.equal(s.elements,144);assert.equal(s.boundaryFaces,104);assert.equal(s.interfaceFaces,32);near(s.totalVolume,24);near(s.interfaceArea,16);assert.ok(mesh.interfaceFaces.every(face=>face.materialIds[0]===5&&face.materialIds[1]===5));
  for(const face of mesh.boundaryFaces)assert.ok([0,1,2].some(axis=>[-.5,g.dims[axis]!-.5].some(bound=>face.nodes.every(id=>point(mesh,id)[axis]===bound))));
});

test('full reflected/sheared affine controls physical volume and all generated elements retain positive orientation',()=>{
  const g={...grid([2,2,1],[4,5,6]),affine:[[-2,.2,0,10],[0,3,.3,-20],[0,0,4,30],[0,0,0,1]]},mesh=buildConformingVolumeMesh(g,[mask(g,'all',()=>true)]),s=volumeMeshStats(mesh);
  near(s.totalVolume,96,1e-11);near(s.minVolume,4,1e-11);near(s.maxVolume,4,1e-11);assert.equal(s.invertedElements,0);validateVolumeMesh(mesh);
});

test('a void voxel remains a cavity, and spatially disconnected domains do not acquire tetrahedra between them',()=>{
  const g=grid([3,3,3]),hollow=buildConformingVolumeMesh(g,[mask(g,'shell',(x,y,z)=>!(x===1&&y===1&&z===1))]),s=volumeMeshStats(hollow);near(s.totalVolume,26);assert.equal(s.elements,156);assert.equal(s.boundaryFaces,120);assert.equal(s.components,1);
  const cavity=hollow.boundaryFaces.filter(face=>face.nodes.every(id=>point(hollow,id).every(v=>v>=.5&&v<=1.5)));assert.equal(cavity.length,12);
  const g2=grid([3,1,1]),separated=buildConformingVolumeMesh(g2,[mask(g2,'ends',x=>x!==1)]),s2=volumeMeshStats(separated);assert.equal(s2.components,2);assert.equal(s2.nodes,16);near(s2.totalVolume,2);assert.equal(s2.boundaryFaces,24);
});

test('quality measures identify a regular tetrahedron and expose anisotropy rather than certifying poor elements',()=>{
  const document={format:'deepmark-tetra-1',positions:[0,0,0,1,0,0,.5,Math.sqrt(3)/2,0,.5,Math.sqrt(3)/6,Math.sqrt(2/3)],elements:[0,1,2,3],regionIds:[1],materialIds:[1],sourceVoxelIds:[0],regions:[{regionId:1,materialId:1,maskId:'tet',name:'tet'}]},mesh=parseVolumeMeshJSON(JSON.stringify(document)),q=tetraQuality(mesh,0);
  near(q.volume,Math.sqrt(2)/12);near(q.meanRatio,1);near(q.scaledJacobian,1);near(q.edgeAspectRatio,1);near(q.minDihedralDegrees,Math.acos(1/3)*180/Math.PI);
  const a=grid([1,1,1]),b=grid([1,1,1],[.1,1,9]);const regular=volumeMeshStats(buildConformingVolumeMesh(a,[mask(a,'a',()=>true)])),stretched=volumeMeshStats(buildConformingVolumeMesh(b,[mask(b,'b',()=>true)]));assert.ok(stretched.minMeanRatio<regular.minMeanRatio);assert.ok(stretched.maxEdgeAspectRatio>regular.maxEdgeAspectRatio);assert.equal(stretched.qualityCertified,false);
});

test('centroid and four-point tetra sampling reproduce a linear gray field under physical affine transforms',()=>{
  const g=grid([5,5,5]);for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<5;x++)g.data[voxelIndex([x,y,z],g.dims)]=100+3*x+7*y+11*z;
  g.affine=[[-.7,.1,0,30],[0,1.2,.2,-40],[0,0,2.5,50],[0,0,0,1]];const mesh=buildConformingVolumeMesh(g,[mask(g,'center',(x,y,z)=>x===2&&y===2&&z===2)]),a=sampleElementGrayValues(g,mesh),b=sampleElementGrayValues(g,mesh,{mode:'four-point'});
  near(a[0]!,140,1e-5);for(let i=0;i<a.length;i++)near(a[i]!,b[i]!,1e-5);near([...a].reduce((s,v)=>s+v,0)/a.length,142,1e-5);
});

test('material calibration requires explicit units and coefficients and refuses nonphysical output',()=>{
  const values=new Float32Array([0,200]),before=values.slice(),calibration={densityFromGray:{slope:.001,intercept:.8,unit:'g/cm3'},youngFromDensity:{coefficient:2000,exponent:2,unit:'MPa'},poissonRatio:.3},result=calibrateMaterials(values,calibration);
  near(result.density[0]!,.8);near(result.density[1]!,1);near(result.youngModulus[0]!,1280);near(result.youngModulus[1]!,2000);assert.deepEqual([...result.poissonRatio],[.3,.3]);assert.deepEqual(values,before);
  assert.throws(()=>calibrateMaterials(new Float32Array([-1000]),calibration),/负密度/);assert.throws(()=>calibrateMaterials(values,{...calibration,poissonRatio:.5}),/泊松/);
  const clamped=calibrateMaterials(new Float32Array([-1000]),{...calibration,densityFromGray:{...calibration.densityFromGray,min:.1}});near(clamped.density[0]!,.1);near(clamped.youngModulus[0]!,20);
});

test('JSON roundtrip retains all labels/provenance and rebuilds one-copy interface topology',()=>{
  const {mesh}=twoRegions(),parsed=parseVolumeMeshJSON(exportVolumeMeshJSON(mesh));assert.deepEqual(parsed.positions,mesh.positions);assert.deepEqual(parsed.elements,mesh.elements);assert.deepEqual(parsed.regionIds,mesh.regionIds);assert.deepEqual(parsed.materialIds,mesh.materialIds);assert.deepEqual(parsed.sourceVoxelIds,mesh.sourceVoxelIds);assert.deepEqual(parsed.regions,mesh.regions);assert.deepEqual(parsed.interfaceFaces,mesh.interfaceFaces);near(volumeMeshStats(parsed).totalVolume,2);
});

test('VTK legacy tetra type 10 roundtrip preserves element labels and source voxel IDs',()=>{
  const {mesh}=twoRegions(),text=exportVTKVolumeMesh(mesh),parsed=parseVTKVolumeMesh(text);assert.match(text,/UNSTRUCTURED_GRID/);assert.match(text,/CELL_TYPES 12\n10/);assert.deepEqual(parsed.positions,mesh.positions);assert.deepEqual(parsed.elements,mesh.elements);assert.deepEqual(parsed.regionIds,mesh.regionIds);assert.deepEqual(parsed.materialIds,mesh.materialIds);assert.deepEqual(parsed.sourceVoxelIds,mesh.sourceVoxelIds);assert.equal(parsed.interfaceFaces.length,2);validateVolumeMesh(parsed);
  assert.throws(()=>parseVTKVolumeMesh(text.replace('CELL_TYPES 12\n10','CELL_TYPES 12\n12')),/类型10/);
});

test('Abaqus C3D4 roundtrip preserves region/material sets and explicit material data without inventing provenance',()=>{
  const {mesh}=twoRegions(),text=exportAbaqusVolumeMesh(mesh,{materials:{10:{youngModulus:1200,poissonRatio:.3,density:1e-9,name:'bone'},20:{youngModulus:40,poissonRatio:.45}}}),parsed=parseAbaqusVolumeMesh(text);
  assert.match(text,/TYPE=C3D4/);assert.match(text,/\*ELASTIC\n1200, 0.3/);assert.match(text,/\*DENSITY\n1e-9/);assert.deepEqual(parsed.positions,mesh.positions);assert.deepEqual(parsed.elements,mesh.elements);assert.deepEqual(parsed.regionIds,mesh.regionIds);assert.deepEqual(parsed.materialIds,mesh.materialIds);assert.deepEqual(parsed.regions,mesh.regions);assert.ok([...parsed.sourceVoxelIds].every(v=>v===0xffffffff));assert.equal(parsed.interfaceFaces.length,2);near(volumeMeshStats(parsed).totalVolume,2);
  assert.throws(()=>parseAbaqusVolumeMesh(text.replace('TYPE=C3D4','TYPE=C3D10')),/C3D4/);
});

test('assembly, element limits, malformed indices and cancellation fail explicitly without changing source masks',()=>{
  const g=grid(),m=mask(g,'all',()=>true);assert.throws(()=>resolveAssembly(g,[m,m]),/唯一/);assert.throws(()=>resolveAssembly(g,[m],{maxLabelBytes:4}),/内存/);assert.throws(()=>buildConformingVolumeMesh(g,[m],{maxElements:6}),/未自动缩减/);assert.throws(()=>buildConformingVolumeMesh(g,[m],{cancelled:()=>true}),/取消/);
  const {mesh}=twoRegions(),json=JSON.parse(exportVolumeMeshJSON(mesh));json.elements[0]=-1;assert.throws(()=>parseVolumeMeshJSON(JSON.stringify(json)),/整数数组/);json.elements[0]=999;assert.throws(()=>parseVolumeMeshJSON(JSON.stringify(json)),/索引/);
  assert.equal(m.mask.reduce((s,v)=>s+v,0),2);assert.equal(signedTetraVolume([0,0,0],[0,1,0],[1,0,0],[0,0,1]),-1/6);
});
