import {test} from 'node:test';
import assert from 'node:assert/strict';
import {centerlineClearance,centerlineKinematics,deleteCenterlineBranch,distanceOverCenterline,exportCenterlineCSV,filterShortBranches,fitCenterline,fitCenterlineFromMesh,growCenterlineBranch,measureCenterline,moveCenterlineControlPoint,sectionAt,smoothCenterline,splitCenterline,validateCenterline} from '../src/mimics/centerline.ts';
import type {CenterlineGraph} from '../src/mimics/centerline.ts';
import {calculateSurface} from '../src/mimics/geometry.ts';
import {physicalPoint,voxelIndex,voxelPoint} from '../src/mimics/types.ts';
import type {Vec3,VolumeGrid,TriangleMesh} from '../src/mimics/types.ts';
const close=(a:number,b:number,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const dist=(a:Vec3,b:Vec3)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
function grid(dims:Vec3,spacing:Vec3=[1,1,1]):VolumeGrid{return {dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2])};}
function maskOf(g:VolumeGrid,predicate:(p:Vec3)=>boolean){return Uint8Array.from(g.data,(_,i)=>Number(predicate(voxelPoint(i,g.dims))));}
function polyLength(points:Vec3[]){return points.reduce((s,p,i)=>i?s+dist(p,points[i-1]!):0,0);}
function capsuleDistance(p:Vec3,a:Vec3,b:Vec3){const d=b.map((n,i)=>n-a[i]!) as Vec3,t=Math.max(0,Math.min(1,p.reduce((s,n,i)=>s+(n-a[i]!)*d[i]!,0)/d.reduce((s,n)=>s+n*n,0)));return dist(p,a.map((n,i)=>n+t*d[i]!) as Vec3);}
function yFixture(){const g=grid([25,25,9]),root:Vec3=[12,3,4],junction:Vec3=[12,13,4],left:Vec3=[4,21,4],right:Vec3=[20,21,4],mask=maskOf(g,p=>Math.min(capsuleDistance(p,root,junction),capsuleDistance(p,junction,left),capsuleDistance(p,junction,right))<=2.1);return {g,mask,root,junction,left,right};}
function cylinder(rx=5,ry=rx,height=20,center:Vec3=[0,0,0],segments=128):TriangleMesh{
  const positions:number[]=[],indices:number[]=[];
  for(const z of [-height/2,height/2])for(let i=0;i<segments;i++){const t=2*Math.PI*i/segments;positions.push(center[0]+rx*Math.cos(t),center[1]+ry*Math.sin(t),center[2]+z);}
  const bottom=2*segments,top=bottom+1;positions.push(center[0],center[1],center[2]-height/2,center[0],center[1],center[2]+height/2);
  for(let i=0;i<segments;i++){const j=(i+1)%segments;indices.push(i,j,segments+j,i,segments+j,segments+i,bottom,j,i,top,segments+i,segments+j);}
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
function simpleGraph(points:Vec3[],radius=2):CenterlineGraph{return {nodes:[{id:'root',position:[...points[0]!],kind:'root'},{id:'end',position:[...points.at(-1)!],kind:'endpoint'}],branches:[{id:'main',startNodeId:'root',endNodeId:'end',points,radiiMm:points.map(()=>radius),controlPointIndices:points.map((_,i)=>i)}],branchSets:[{id:'set-1',branchIds:['main'],estimatedVolumeMm3:1}],rootNodeId:'root',coordinateSystem:'world-mm',algorithm:'independent-clearance-shortest-path',cyclePolicy:'rooted-shortest-path-tree',warnings:[]};}

test('straight extraction retains physical affine/anisotropy and control sampling without mutating a source',()=>{
  const g=grid([11,11,31],[.7,.8,1.5]);g.affine=[[0,-.8,0,10],[.7,0,0,-15],[0,0,1.5,5]];
  const mask=maskOf(g,([x,y])=>(x-5)**2+(y-5)**2<=9),before=mask.slice(),graph=fitCenterline(g,mask,{root:[5,5,1],endpoints:[[5,5,29]],coordinateSpace:'voxel',controlSpacingMm:4});
  validateCenterline(graph);assert.equal(graph.branches.length,1);const b=graph.branches[0]!;close(polyLength(b.points),42);assert.ok(b.points.every(p=>Math.abs(p[0]-6)<1e-8&&Math.abs(p[1]+11.5)<1e-8));
  assert.deepEqual(b.points[0],physicalPoint([5,5,1],g));assert.deepEqual(b.points.at(-1),physicalPoint([5,5,29],g));assert.ok(b.controlPointIndices.length<b.points.length);assert.ok(b.radiiMm.every(r=>r>0));assert.deepEqual(mask,before);
  close(centerlineKinematics(b.points,10).curvature,0);close(centerlineKinematics(b.points,10).tortuosity,0);assert.equal(centerlineKinematics(b.points,10).normal,null);
});
test('bent tubular paths stay inside rather than connecting endpoints by a straight chord',()=>{
  const g=grid([41,41,9]),mask=maskOf(g,([x,y,z])=>Math.hypot(Math.hypot(x-20,y-20)-12,z-4)<=2.2&&y>=20),graph=fitCenterline(g,mask,{root:[32,20,4],endpoints:[[8,20,4]],coordinateSpace:'voxel'}),points=graph.branches[0]!.points;
  assert.equal(mask[voxelIndex([20,20,4],g.dims)],0);assert.ok(polyLength(points)>34);assert.ok(points.some(p=>p[1]>30));assert.ok(points.every(p=>mask[voxelIndex(p,g.dims)]));
  const path=distanceOverCenterline(graph,{branchId:graph.branches[0]!.id,pointIndex:0},{branchId:graph.branches[0]!.id,pointIndex:points.length-1});close(path.lengthMm,polyLength(points));assert.ok(path.lengthMm>dist(points[0]!,points.at(-1)!));assert.ok(path.tortuosity>.25);
  const halves=splitCenterline(graph,graph.branches[0]!.id,Math.floor(points.length/2));assert.equal(halves.length,2);halves.forEach(validateCenterline);close(halves.reduce((s,h)=>s+h.branches.reduce((a,b)=>a+polyLength(b.points),0),0),polyLength(points));
});
test('multiple endpoints form a shared tree and branch growth joins the existing internal path',()=>{
  const {g,mask,root,left,right,junction}=yFixture(),graph=fitCenterline(g,mask,{root,endpoints:[left,right],coordinateSpace:'voxel'});validateCenterline(graph);assert.equal(graph.branches.length,3);assert.equal(graph.nodes.filter(n=>n.kind==='junction').length,1);assert.equal(graph.branches.length,graph.nodes.length-1);
  const first=fitCenterline(g,mask,{root,endpoints:[left],coordinateSpace:'voxel'}),b=first.branches[0]!,attach=b.points.reduce((best,p,i)=>dist(p,junction)<dist(b.points[best]!,junction)?i:best,0),grown=growCenterlineBranch(first,g,mask,{branchId:b.id,pointIndex:attach,end:right});
  validateCenterline(grown);assert.equal(grown.branches.length,3);assert.equal(first.branches.length,1);assert.ok(grown.nodes.some(n=>dist(n.position,right)<1e-8));
  assert.throws(()=>growCenterlineBranch(grown,g,mask,{branchId:grown.branches[0]!.id,pointIndex:0,end:right}),/已在中心线/);
  const junctionNode=graph.nodes.find(n=>n.kind==='junction')!,incident=graph.branches.filter(b=>b.startNodeId===junctionNode.id||b.endNodeId===junctionNode.id),branch=incident[0]!,index=branch.startNodeId===junctionNode.id?0:branch.points.length-1,position=junctionNode.position.map((n,a)=>n+(a===2?.2:0)) as Vec3;
  const moved=moveCenterlineControlPoint(graph,branch.id,index,position,{influenceMm:4,domain:{grid:g,mask}});validateCenterline(moved);for(const b of moved.branches.filter(b=>b.startNodeId===junctionNode.id||b.endNodeId===junctionNode.id))assert.deepEqual(b.startNodeId===junctionNode.id?b.points[0]:b.points.at(-1),position);
  assert.throws(()=>moveCenterlineControlPoint(graph,branch.id,index,[100,100,100],{domain:{grid:g,mask}}),/越出|穿过/);assert.deepEqual(graph.nodes.find(n=>n.id===junctionNode.id)!.position,junctionNode.position);
});
test('loops are explicitly projected to a shortest-path tree, disconnected seeds and non-tree graph edits are rejected',()=>{
  const g=grid([31,31,5]),mask=maskOf(g,([x,y,z])=>Math.hypot(Math.hypot(x-15,y-15)-9,z-2)<=1.5),graph=fitCenterline(g,mask,{root:[24,15,2],endpoints:[[6,15,2]],coordinateSpace:'voxel'});
  assert.equal(graph.cyclePolicy,'rooted-shortest-path-tree');assert.ok(graph.warnings.some(s=>s.includes('loop')));assert.ok(polyLength(graph.branches[0]!.points)>25);assert.equal(graph.branches.length,graph.nodes.length-1);
  assert.throws(()=>validateCenterline({...graph,branches:[...graph.branches,{...graph.branches[0]!,id:'closing-loop'}]}),/非树|闭环/);
  const separated=new Uint8Array(mask.length);separated[voxelIndex([0,0,0],g.dims)]=1;separated[voxelIndex([30,30,4],g.dims)]=1;
  assert.throws(()=>fitCenterline(g,separated,{root:[0,0,0],endpoints:[[30,30,4]],coordinateSpace:'voxel'}),/同一安全连通/);
});
test('Fourier smoothing preserves endpoints and deviation limits; peripheral branch filtering and deletion preserve valid topology',()=>{
  const points:Vec3[]=Array.from({length:33},(_,i)=>[0,i,i===0||i===32?0:(i%2?.3:-.3)]),graph=simpleGraph(points),smoothed=smoothCenterline(graph,{factor:.25}),before=graph.branches[0]!.points,after=smoothed.branches[0]!.points;
  assert.deepEqual(after[0],before[0]);assert.deepEqual(after.at(-1),before.at(-1));assert.ok(after.every((p,i)=>dist(p,before[i]!)<=.5+1e-8));
  const roughness=(p:Vec3[])=>p.slice(1,-1).reduce((s,_,j)=>s+(p[j]![2]-2*p[j+1]![2]+p[j+2]![2])**2,0);assert.ok(roughness(after)<roughness(before)*.1);assert.deepEqual(graph.branches[0]!.points,points);
  const {g,mask,root,left,right}=yFixture(),tree=fitCenterline(g,mask,{root,endpoints:[left,right],coordinateSpace:'voxel'}),filtered=filterShortBranches(tree,20);assert.equal(filtered.branches.length,1);validateCenterline(filtered);
  const deleted=deleteCenterlineBranch(tree,tree.branches[0]!.id);validateCenterline(deleted);assert.equal(deleted.branches.length,2);
});
test('circular/elliptical mesh sections give physical area, circumference, least-squares diameter and hydraulic measurements',()=>{
  const round=sectionAt(cylinder(),[0,0,0],[0,0,1]);close(round.Area,25*Math.PI,.04);close(round.Scf,10*Math.PI,.004);close(round.Dfit,10,.006);close(round.Dmin,10,.004);close(round.Dmax,10,1e-6);close(round.Dh,4*round.Area/round.Scf);close(round.Xh,round.Dh/round.Dmax);close(round.E,0,1e-3);
  const offset=sectionAt(cylinder(),[1,0,0],[0,0,1]);close(offset.Dfit,10,.006);close(offset.Dmin,8,.004);close(offset.Dmax,12,1e-6);offset.fitCenter.forEach(n=>close(n,0,.001));
  const ellipse=sectionAt(cylinder(5,3),[0,0,0],[0,0,1]);close(ellipse.Area,15*Math.PI,.025);close(ellipse.Dmax,10,1e-6);close(ellipse.Dmin,6,.003);close(ellipse.E,.8,.001);close(ellipse.ellipseRadiiMm![0],5,.005);close(ellipse.ellipseRadiiMm![1],3,.005);
});
test('section selection respects physical oblique planes and separate shells; open or outside sections fail explicitly',()=>{
  const source=cylinder(),angle=.65,c=Math.cos(angle),s=Math.sin(angle),rotated:TriangleMesh={positions:Float32Array.from(source.positions,(_,i)=>{const at=i-i%3,x=source.positions[at]!,y=source.positions[at+1]!,z=source.positions[at+2]!;return i%3===0?x+100:i%3===1?c*y-s*z-50:s*y+c*z+30;}),indices:source.indices};
  const section=sectionAt(rotated,[100,-50,30],[0,-s,c]);close(section.Area,25*Math.PI,.04);close(section.Dfit,10,.006);
  const other=cylinder(3,3,20,[30,0,0]),both={positions:new Float32Array([...source.positions,...other.positions]),indices:new Uint32Array([...source.indices,...other.indices.map(i=>i+source.positions.length/3)])};close(sectionAt(both,[0,0,0],[0,0,1]).Area,25*Math.PI,.04);
  assert.throws(()=>sectionAt({...source,indices:source.indices.slice(0,-3)},[0,0,0],[0,0,1]),/闭合/);assert.throws(()=>sectionAt(source,[20,0,0],[0,0,1]),/实体内部/);
});
test('quadratic curvature, tangent/normal/binormal and arclength tortuosity have analytic circle fixtures',()=>{
  const points:Vec3[]=Array.from({length:41},(_,i)=>[10*Math.cos(i*.025),10*Math.sin(i*.025),0]),k=centerlineKinematics(points,20);
  close(k.curvature,.1,.00002);close(k.curvatureRadiusMm,10,.002);close(k.tangent.reduce((s,n,i)=>s+n*[-Math.sin(.5),Math.cos(.5),0][i]!,0),1,1e-8);assert.ok(k.normal);assert.ok(k.binormal);close(k.binormal![2],1);close(k.tortuosity,1-Math.sin(.5)/(.5),.00003);
});
test('mask/mesh extraction and measured control-point CSV roundtrip use actual contour metrics and explicit units',()=>{
  const g=grid([15,15,31]),mask=maskOf(g,([x,y])=>(x-7)**2+(y-7)**2<=9),mesh=cylinder(3,3,30,[7,7,15]),graph=fitCenterline(g,mask,{root:[7,7,2],endpoints:[[7,7,28]],coordinateSpace:'voxel',controlSpacingMm:5}),rows=measureCenterline(graph,mesh);
  assert.ok(rows.length>=6);assert.ok(rows.every(r=>!r.error&&r.section));rows.forEach(r=>close(r.section!.Dfit,6,.004));const csv=exportCenterlineCSV(graph,rows),lines=csv.trim().split('\r\n');assert.equal(lines.length,rows.length+1);assert.ok(lines[0]!.includes('Area_mm2'));assert.ok(lines[0]!.includes('C_1_per_mm'));assert.ok(lines.every(line=>line.split(',').length===27));
  const extracted=fitCenterlineFromMesh(g,calculateSurface(g,mask),{root:[7,7,2],endpoints:[[7,7,28]],coordinateSpace:'voxel'});validateCenterline(extracted);assert.ok(extracted.branches[0]!.points.length>20);
});
test('cancellation, invalid seeds, budgets and diagonal-only contacts leave inputs unchanged',()=>{
  const g=grid([5,5,5]),mask=new Uint8Array(125).fill(1),before=mask.slice();assert.throws(()=>fitCenterline(g,mask,{root:[1,1,1],endpoints:[[3,3,3]],coordinateSpace:'voxel',cancelled:()=>true}),/取消/);assert.deepEqual(mask,before);
  assert.throws(()=>fitCenterline(g,mask,{root:[1,1,1],endpoints:[[3,3,3]],coordinateSpace:'voxel',maxVoxels:10}),/预算/);assert.throws(()=>fitCenterline(g,mask,{root:[-1,1,1],endpoints:[[3,3,3]],coordinateSpace:'voxel'}),/Mask内/);
  const corners=new Uint8Array(125);corners[voxelIndex([1,1,1],g.dims)]=1;corners[voxelIndex([2,2,1],g.dims)]=1;assert.throws(()=>fitCenterline(g,corners,{root:[1,1,1],endpoints:[[2,2,1]],coordinateSpace:'voxel'}),/安全连通/);
  const field=centerlineClearance(g,mask);close(field[voxelIndex([0,2,2],g.dims)]!,.5);close(field[voxelIndex([2,2,2],g.dims)]!,2.5);
});
