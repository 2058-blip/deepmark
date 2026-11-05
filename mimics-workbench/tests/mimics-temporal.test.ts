import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptTemporalPhase,beginPhasePropagation,buildFramePhase,cancelPhasePropagation,createTemporalStudy,editFrameLink,editTemporalMask,estimateRigidTransform,findFrameLink,finishPhasePropagation,mapTargetToSource,propagateNextPhase,rebuildFramePhase,registerPhases,resamplePhaseImage,warpPhaseMask} from '../src/mimics/temporal.ts';
import type {FrameGraph,TemporalPhase} from '../src/mimics/temporal.ts';
import {physicalPoint,voxelIndex,voxelPoint} from '../src/mimics/types.ts';
import type {Vec3,VolumeGrid} from '../src/mimics/types.ts';
const close=(a:number,b:number,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
function gaussian(dims:Vec3=[23,23,23],center:Vec3=[11,11,11],radii:Vec3=[3,4,4]):VolumeGrid{return {dims,spacing:[1,1,1],data:Float32Array.from({length:dims[0]*dims[1]*dims[2]},(_,i)=>{const p=voxelPoint(i,dims);return 100*Math.exp(-p.reduce((s,n,a)=>s+((n-center[a]!)/radii[a]!)**2,0));})};}
const maskOf=(g:VolumeGrid)=>Uint8Array.from(g.data,v=>Number(v>=100/Math.E));
function dice(a:Uint8Array,b:Uint8Array){return 2*a.reduce((sum,v,i)=>sum+v*b[i]!,0)/(a.reduce((s,v)=>s+v,0)+b.reduce((s,v)=>s+v,0));}
const phase=(id:string,grid:VolumeGrid,masks:TemporalPhase['masks']=[]):TemporalPhase=>({id,name:id,grid,masks,revision:0,status:'unprocessed'});

test('Horn landmark initialization recovers six-degree rotations and translation in physical millimetres',()=>{
  const source:Vec3[]=[[0,0,0],[1,0,0],[0,2,0],[0,0,3],[2,3,1]],target=source.map(([x,y,z])=>[-y+4,x-2,z+6] as Vec3),transform=estimateRigidTransform(source,target);
  close(transform.landmarkRmsMm!,0,1e-10);source.forEach((p,i)=>transform.matrix.forEach((row,a)=>close(row[0]!*p[0]+row[1]!*p[1]+row[2]!*p[2]+row[3]!,target[i]![a]!,1e-10)));
  const halfTurn=estimateRigidTransform(source,source.map(([x,y,z])=>[-x+2,-y+4,z-1]));close(halfTurn.landmarkRmsMm!,0,1e-10);
  assert.throws(()=>estimateRigidTransform([[0,0,0],[1,0,0],[2,0,0]],[[0,0,0],[1,0,0],[2,0,0]]),/共线/);
});
test('dense nonrigid registration recovers changing shape beyond any translation-only mask copy',()=>{
  const source=gaussian(),target=gaussian([23,23,23],[11,11,11],[4.5,4,4]),sourceData=source.data.slice(),sourceMask=maskOf(source),expected=maskOf(target),transform=registerPhases(source,target,{iterations:70,stepMm:1.5,smoothingMm:.5}),warped=warpPhaseMask(source,sourceMask,target,transform);
  assert.ok(transform.meanSquaredError.at(-1)!<transform.meanSquaredError[0]!*.001);assert.ok(transform.meanSquaredError.every((v,i,a)=>!i||v<=a[i-1]!*(1+1e-9)));assert.ok(transform.minimumJacobian>=.05);assert.ok(transform.displacement.some(n=>Math.abs(n)>1));
  assert.ok(dice(warped,expected)>.94);assert.ok(dice(warped,expected)>dice(sourceMask,expected)+.1);
  assert.ok(transform.displacement[3*voxelIndex([16,11,11],source.dims)]!<-.5);assert.ok(transform.displacement[3*voxelIndex([6,11,11],source.dims)]!>.5);
  const resampled=resamplePhaseImage(source,target,transform),mse=resampled.reduce((s,n,i)=>s+(n-target.data[i]!)**2,0)/resampled.length;close(mse,transform.meanSquaredError.at(-1)!,1e-6);assert.deepEqual(source.data,sourceData);
  if(transform.termination==='line-search-stalled')assert.equal(transform.converged,false);
});
test('pull sampling respects different rotated voxel affines rather than copying same-index labels',()=>{
  const dims:Vec3=[11,11,11],source:VolumeGrid={dims,spacing:[1,1,1],affine:[[1,0,0,-5],[0,1,0,-5],[0,0,1,-5]],data:new Float32Array(1331)},target:VolumeGrid={dims,spacing:[1,1,1],affine:[[0,-1,0,5],[1,0,0,-5],[0,0,1,-5]],data:new Float32Array(1331)};
  for(const grid of [source,target])for(let i=0;i<grid.data.length;i++){const [x,y,z]=physicalPoint(voxelPoint(i,dims),grid);grid.data[i]=100*Math.exp(-((x/2)**2+(y/3)**2+(z/2)**2));}
  const transform=registerPhases(source,target,{initialization:'identity',iterations:0}),warped=warpPhaseMask(source,maskOf(source),target,transform);assert.deepEqual(warped,maskOf(target));assert.notDeepEqual(maskOf(source),warped);assert.deepEqual(mapTargetToSource(transform,[1,2,3]),[1,2,3]);
  assert.throws(()=>warpPhaseMask(source,maskOf(source),{...target,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]]},transform),/网格不一致/);
});
test('cardiac propagation uses the edited accepted phase as the next source and preserves independent overlapping masks',()=>{
  const a=gaussian([15,15,15],[6,7,7],[2,2,2]),b=gaussian([15,15,15],[7,7,7],[2,2,2]),c=gaussian([15,15,15],[8,7,7],[2,2,2]),mask=maskOf(a);
  let study=createTemporalStudy([phase('A',a,[{id:'heart',name:'腔室',data:mask,revision:3},{id:'overlap',name:'重叠',data:mask.slice(),revision:1}]),phase('B',b),phase('C',c)],'A');
  study=propagateNextPhase(study,'B',{registration:{iterations:0}});const target=study.phases.find(p=>p.id==='B')!;assert.equal(target.status,'needs_review');assert.equal(target.masks.length,2);assert.deepEqual(target.masks[0]!.data,target.masks[1]!.data);assert.notEqual(target.masks[0]!.data.buffer,target.masks[1]!.data.buffer);assert.equal(target.masks[0]!.name,'腔室');
  const edited=target.masks[0]!.data.slice();edited[voxelIndex([3,3,3],b.dims)]=1;study=editTemporalMask(study,'B',target.masks[0]!.id,edited);assert.equal(study.phases.find(p=>p.id==='B')!.segmentState,'invalidated');study=acceptTemporalPhase(study,'B');assert.equal(study.activeSourcePhaseId,'B');
  study=propagateNextPhase(study,'C',{registration:{iterations:0}});const last=study.phases.find(p=>p.id==='C')!;assert.equal(last.masks[0]!.origin!.sourcePhaseId,'B');assert.equal(last.masks[0]!.origin!.sourceRevision,1);assert.equal(last.masks[0]!.data[voxelIndex([4,3,3],c.dims)],1);assert.equal(study.referencePhaseId,'A');
});
test('frame propagation always starts from the original reference, independently of processed target order',()=>{
  const a=gaussian([15,15,15],[6,7,7],[2,2,2]),b=gaussian([15,15,15],[7,7,7],[2,2,2]),c=gaussian([15,15,15],[8,7,7],[2,2,2]);let study=createTemporalStudy([phase('A',a,[{id:'frame',name:'支架',data:maskOf(a),revision:0}]),phase('B',b),phase('C',c)],'A','frame-from-reference');
  study=propagateNextPhase(study,'B',{registration:{iterations:0}});const p=study.phases.find(p=>p.id==='B')!,data=p.masks[0]!.data.slice();data[voxelIndex([3,3,3],b.dims)]=1;study=acceptTemporalPhase(editTemporalMask(study,'B',p.masks[0]!.id,data),'B');study=propagateNextPhase(study,'C',{registration:{iterations:0}});
  const out=study.phases.find(p=>p.id==='C')!.masks[0]!;assert.equal(out.origin!.sourcePhaseId,'A');assert.equal(out.data[voxelIndex([4,3,3],c.dims)],0);assert.equal(study.activeSourcePhaseId,'A');
});
test('revision tickets reject stale work after edits and cancellation restores phase status without a mask commit',()=>{
  const g=gaussian([9,9,9],[4,4,4],[2,2,2]),mask=maskOf(g),study=createTemporalStudy([phase('A',g,[{id:'m',name:'M',data:mask,revision:0}]),phase('B',g)],'A'),pending=beginPhasePropagation(study,'B'),transform=registerPhases(g,g,{iterations:0});
  const canceled=cancelPhasePropagation(pending.study,pending.ticket);assert.equal(canceled.phases[1]!.status,'unprocessed');assert.equal(canceled.phases[1]!.masks.length,0);assert.throws(()=>finishPhasePropagation(canceled,pending.ticket,transform),/过期/);
  const edited=editTemporalMask(pending.study,'A','m',mask);assert.equal(edited.pending,undefined);assert.equal(edited.phases[1]!.status,'unprocessed');assert.throws(()=>finishPhasePropagation(edited,pending.ticket,transform),/过期/);assert.equal(study.phases[0]!.masks[0]!.revision,0);
  assert.throws(()=>finishPhasePropagation(pending.study,pending.ticket,transform,['m','m']),/1到10/);
});
test('Frame loop graph produces three distinct-state variants, and connectivity rebuild drops manual links as documented',()=>{
  const dims:Vec3=[15,15,7],source:VolumeGrid={dims,spacing:[1,1,1],data:new Float32Array(1575).fill(10)},target:VolumeGrid={dims,spacing:[1,1,1],data:new Float32Array(1575).fill(10)};
  const nodes=[{id:'a',position:[3,3,3] as Vec3},{id:'b',position:[9,3,3] as Vec3},{id:'c',position:[9,9,3] as Vec3},{id:'d',position:[3,9,3] as Vec3}],graph:FrameGraph={nodes,revision:0,links:nodes.map((n,i)=>({id:'link-'+i,from:n.id,to:nodes[(i+1)%4]!.id,points:[n.position,nodes[(i+1)%4]!.position]}))};
  for(let i=0;i<source.data.length;i++){const [x,y,z]=voxelPoint(i,dims),near=z===3&&((x>=3&&x<=9&&(Math.abs(y-3)<=1||Math.abs(y-9)<=1))||(y>=3&&y<=9&&(Math.abs(x-3)<=1||Math.abs(x-9)<=1)));if(near){source.data[i]=100;if(x+1<15&&y+1<15)target.data[voxelIndex([x+1,y+1,z],dims)]=100;}}
  const mask=Uint8Array.from(source.data,v=>Number(v===100)),transform=registerPhases(source,target,{initialTransform:{kind:'rigid',matrix:[[1,0,0,1],[0,1,0,1],[0,0,1,0]]},iterations:0}),state=buildFramePhase(source,mask,graph,target,transform,{connectivity:2,radiusMm:1.5,intensityFraction:.5},{phaseId:'source',maskId:'stent'});
  assert.equal(state.graph.links.length,4);assert.deepEqual(state.graph.nodes[0]!.position,[4,4,3]);assert.ok(state.frame.reduce((s,n)=>s+n,0)>state.skeleton.reduce((s,n)=>s+n,0));assert.ok(state.threshold.some(Boolean));assert.notEqual(state.skeleton.buffer,state.frame.buffer);
  const edited=editFrameLink(state,{removeId:'link-0'});assert.equal(edited.status,'needs_rebuild');assert.equal(edited.graph.links.length,3);assert.equal(state.graph.links.length,4);const rebuilt=rebuildFramePhase(edited,target);assert.equal(rebuilt.skeleton[voxelIndex([7,4,3],dims)],0);
  const reset=rebuildFramePhase(rebuilt,target,{...state.parameters,connectivity:3});assert.equal(reset.graph.links.length,4);assert.equal(reset.manualRemoved.length,0);assert.equal(reset.skeleton[voxelIndex([7,4,3],dims)],1);
  const shortcut={...graph,links:[{id:'false-diagonal',from:'a',to:'c',points:[nodes[0]!.position,nodes[2]!.position]}]};assert.throws(()=>buildFramePhase(source,mask,shortcut,target,transform,state.parameters,{phaseId:'A',maskId:'m'}),/真实连接路径/);
});
test('manual Frame link search follows bright image paths and cannot bridge a dark diagonal shortcut',()=>{
  const grid:VolumeGrid={dims:[11,11,5],spacing:[1,1,1],data:new Float32Array(605).fill(0)};for(let x=2;x<=8;x++)grid.data[voxelIndex([x,2,2],grid.dims)]=100;for(let y=2;y<=8;y++)grid.data[voxelIndex([8,y,2],grid.dims)]=100;
  const link=findFrameLink(grid,{id:'a',position:[2,2,2]},{id:'b',position:[8,8,2]},{minimumIntensity:50});assert.ok(link.points.length>10);assert.ok(link.points.every(p=>grid.data[voxelIndex(p,grid.dims)]===100));assert.equal(grid.data[voxelIndex([5,5,2],grid.dims)],0);
});
test('cancel, bad registration geometry/intensities and resource budgets publish no partial result',()=>{
  const g=gaussian([9,9,9],[4,4,4],[2,2,2]),data=g.data.slice();assert.throws(()=>registerPhases(g,g,{cancelled:()=>true}),/取消/);assert.deepEqual(g.data,data);assert.throws(()=>registerPhases(g,g,{maxVoxels:10}),/预算/);assert.throws(()=>registerPhases(g,g,{smoothingMm:1000}),/参数|预算/);
  const bad={...g,data:g.data.slice()};bad.data[0]=NaN;assert.throws(()=>registerPhases(g,bad),/非有限/);assert.throws(()=>registerPhases(g,g,{initialTransform:{kind:'rigid',matrix:[[2,0,0,0],[0,1,0,0],[0,0,1,0]]}}),/缩放/);
});
