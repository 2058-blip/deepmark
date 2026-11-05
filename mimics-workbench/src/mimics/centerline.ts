import {physicalPoint,requireGrid,voxelIndex,voxelPoint} from './types.ts';
import type {AlgorithmControl,BinaryMask,TriangleMesh,Vec3,VolumeGrid} from './types.ts';
import {worldToVoxel} from './measurements.ts';
import {maskFromMesh,meshStats} from './geometry.ts';

export interface CenterlineNode {id:string;position:Vec3;kind:'root'|'endpoint'|'junction'|'control'}
export interface CenterlineBranch {id:string;startNodeId:string;endNodeId:string;points:Vec3[];radiiMm:number[];controlPointIndices:number[]}
export interface CenterlineBranchSet {id:string;branchIds:string[];estimatedVolumeMm3:number}
export interface CenterlineGraph {
  nodes:CenterlineNode[];branches:CenterlineBranch[];branchSets:CenterlineBranchSet[];rootNodeId:string;
  coordinateSystem:'world-mm';algorithm:'independent-clearance-shortest-path';
  /** Loops in a source volume are projected to a rooted shortest-path tree, not recovered as loop graphs. */
  cyclePolicy:'rooted-shortest-path-tree';warnings:string[];
}
export interface FitCenterlineOptions extends AlgorithmControl {
  root:Vec3;endpoints:Vec3[];coordinateSpace?:'world'|'voxel';controlSpacingMm?:number;
  centerWeight?:number;clearancePower?:number;maxVoxels?:number;
}
export interface CenterlineDomain {grid:VolumeGrid;mask:BinaryMask}
export interface CenterlineEditOptions extends AlgorithmControl {influenceMm?:number;domain?:CenterlineDomain}
export interface CenterlineSmoothOptions extends AlgorithmControl {factor:number;domain?:CenterlineDomain;maxPointsPerBranch?:number}
type Vec2=[number,number];
const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul=(a:Vec3,s:number):Vec3=>[a[0]*s,a[1]*s,a[2]*s];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length=(a:Vec3)=>Math.hypot(...a);
function unit(a:Vec3):Vec3 {const n=length(a);if(!Number.isFinite(n)||n<1e-12)throw new Error('中心线方向不能为零。');return mul(a,1/n);}
function check(control:AlgorithmControl,fraction?:number){if(control.cancelled?.())throw new Error('中心线操作已取消。');if(fraction!==undefined)control.progress?.(Math.max(0,Math.min(1,fraction)));if(control.cancelled?.())throw new Error('中心线操作已取消。');}
const distance=(a:Vec3,b:Vec3)=>length(sub(a,b));
function arcLengths(points:Vec3[]){const s=[0];for(let i=1;i<points.length;i++)s.push(s[i-1]!+distance(points[i]!,points[i-1]!));return s;}
function controlIndices(points:Vec3[],spacing:number){const result=[0],s=arcLengths(points);let previous=0;for(let i=1;i<points.length-1;i++)if(s[i]!-previous>=spacing){result.push(i);previous=s[i]!;}if(points.length>1)result.push(points.length-1);return result;}
function cloneGraph(graph:CenterlineGraph):CenterlineGraph{return {...graph,nodes:graph.nodes.map(n=>({...n,position:[...n.position]})),branches:graph.branches.map(b=>({...b,points:b.points.map(p=>[...p]),radiiMm:[...b.radiiMm],controlPointIndices:[...b.controlPointIndices]})),branchSets:graph.branchSets.map(s=>({...s,branchIds:[...s.branchIds]})),warnings:[...graph.warnings]};}

class MinHeap {
  ids:number[]=[];values:number[]=[];
  push(id:number,value:number){let i=this.ids.length;this.ids.push(id);this.values.push(value);while(i){const p=(i-1)>>1;if(this.values[p]!<value||this.values[p]===value&&this.ids[p]!<=id)break;this.ids[i]=this.ids[p]!;this.values[i]=this.values[p]!;i=p;}this.ids[i]=id;this.values[i]=value;}
  pop():[number,number]|null{if(!this.ids.length)return null;const result:[number,number]=[this.ids[0]!,this.values[0]!],id=this.ids.pop()!,value=this.values.pop()!;if(!this.ids.length)return result;let i=0;while(2*i+1<this.ids.length){let c=2*i+1;if(c+1<this.ids.length&&(this.values[c+1]!<this.values[c]!||this.values[c+1]===this.values[c]&&this.ids[c+1]!<this.ids[c]!))c++;if(value<this.values[c]!||value===this.values[c]&&id<=this.ids[c]!)break;this.ids[i]=this.ids[c]!;this.values[i]=this.values[c]!;i=c;}this.ids[i]=id;this.values[i]=value;return result;}
}
interface Step {delta:Vec3;mm:number}
function physicalBasis(grid:VolumeGrid):Vec3[]{const o=physicalPoint([0,0,0],grid);return [0,1,2].map(a=>{const p:Vec3=[0,0,0];p[a]=1;return sub(physicalPoint(p,grid),o);});}
function neighbours(grid:VolumeGrid):Step[]{const basis=physicalBasis(grid),out:Step[]=[];for(let z=-1;z<=1;z++)for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++)if(x||y||z)out.push({delta:[x,y,z],mm:length(add(add(mul(basis[0]!,x),mul(basis[1]!,y)),mul(basis[2]!,z)))});return out;}
function inBounds(p:Vec3,grid:VolumeGrid){return p.every((n,a)=>n>=0&&n<grid.dims[a]!);}
/** All corners of a diagonal move must be foreground, preventing corner/edge tunnelling. */
function safeStep(p:Vec3,d:Vec3,grid:VolumeGrid,mask:BinaryMask){
  const axes=[0,1,2].filter(a=>d[a]!==0);
  for(let bits=1;bits<1<<axes.length;bits++){const q=[...p] as Vec3;axes.forEach((a,j)=>{if(bits&1<<j)q[a]+=d[a]!;});if(!inBounds(q,grid)||!mask[voxelIndex(q,grid.dims)])return false;}
  return true;
}
/** A graph-distance clearance estimate in mm, not an exact Euclidean signed-distance transform. */
export function centerlineClearance(grid:VolumeGrid,mask:BinaryMask,control:AlgorithmControl={}):Float64Array {
  const n=requireGrid(grid,mask);worldToVoxel(physicalPoint([0,0,0],grid),grid);check(control,0);
  const basis=physicalBasis(grid),det=Math.abs(dot(basis[0]!,cross(basis[1]!,basis[2]!)));
  const heights=[det/length(cross(basis[1]!,basis[2]!)),det/length(cross(basis[2]!,basis[0]!)),det/length(cross(basis[0]!,basis[1]!))];
  const field=new Float64Array(n);field.fill(Infinity);const heap=new MinHeap(),steps=neighbours(grid);let members=0;
  for(let i=0;i<n;i++){
    if(!(i%4096))check(control,i/n*.15);
    if(!mask[i]){field[i]=0;continue;}members++;const p=voxelPoint(i,grid.dims);let seed=Infinity;
    for(let a=0;a<3;a++)for(const sign of [-1,1]){const q=[...p] as Vec3;q[a]+=sign;if(!inBounds(q,grid)||!mask[voxelIndex(q,grid.dims)])seed=Math.min(seed,heights[a]!/2);}
    if(Number.isFinite(seed)){field[i]=seed;heap.push(i,seed);}
  }
  if(!members)throw new Error('中心线需要非空Mask。');
  let visited=0;
  while(heap.ids.length){const [i,value]=heap.pop()!;if(value!==field[i])continue;const p=voxelPoint(i,grid.dims);if(!(visited++%2048))check(control,.15+.85*visited/members);
    for(const step of steps){const q=add(p,step.delta);if(!inBounds(q,grid))continue;const j=voxelIndex(q,grid.dims);if(!mask[j]||!safeStep(p,step.delta,grid,mask))continue;const next=value+step.mm;if(next<field[j]!){field[j]=next;heap.push(j,next);}}
  }
  check(control,1);return field;
}
function updateGraph(graph:CenterlineGraph):CenterlineGraph{
  const used=new Set(graph.branches.flatMap(b=>[b.startNodeId,b.endNodeId]));used.add(graph.rootNodeId);graph.nodes=graph.nodes.filter(n=>used.has(n.id));
  const adjacent=new Map(graph.nodes.map(n=>[n.id,[] as CenterlineBranch[]]));for(const b of graph.branches){adjacent.get(b.startNodeId)?.push(b);adjacent.get(b.endNodeId)?.push(b);}
  graph.nodes.forEach(n=>n.kind=n.id===graph.rootNodeId?'root':adjacent.get(n.id)!.length>2?'junction':adjacent.get(n.id)!.length===1?'endpoint':'control');
  const seen=new Set<string>(),sets:CenterlineBranchSet[]=[];
  for(const node of graph.nodes){if(seen.has(node.id))continue;const queue=[node.id],ids=new Set<string>();seen.add(node.id);for(let i=0;i<queue.length;i++)for(const b of adjacent.get(queue[i]!)??[]){ids.add(b.id);const next=b.startNodeId===queue[i]?b.endNodeId:b.startNodeId;if(!seen.has(next)){seen.add(next);queue.push(next);}}
    if(ids.size){let volume=0;for(const b of graph.branches)if(ids.has(b.id))for(let i=1;i<b.points.length;i++){const r=(b.radiiMm[i-1]!+b.radiiMm[i]!)/2;volume+=Math.PI*r*r*distance(b.points[i-1]!,b.points[i]!);}sets.push({id:`set-${sets.length+1}`,branchIds:[...ids],estimatedVolumeMm3:volume});}
  }
  sets.sort((a,b)=>b.estimatedVolumeMm3-a.estimatedVolumeMm3||a.id.localeCompare(b.id));graph.branchSets=sets;return graph;
}
export function validateCenterline(graph:CenterlineGraph):void{
  if(graph.coordinateSystem!=='world-mm'||graph.algorithm!=='independent-clearance-shortest-path'||graph.cyclePolicy!=='rooted-shortest-path-tree'||!Array.isArray(graph.nodes)||!Array.isArray(graph.branches)||!Array.isArray(graph.branchSets)||!Array.isArray(graph.warnings)||graph.warnings.some(s=>typeof s!=='string'))throw new Error('中心线格式无效。');
  const ids=new Set<string>(),nodes=new Map<string,CenterlineNode>();for(const n of graph.nodes){if(!n||typeof n.id!=='string'||!n.id||ids.has(n.id)||!['root','endpoint','junction','control'].includes(n.kind)||!Array.isArray(n.position)||n.position.length!==3||n.position.some(x=>!Number.isFinite(x)))throw new Error('中心线节点损坏。');ids.add(n.id);nodes.set(n.id,n);}
  if(!nodes.has(graph.rootNodeId))throw new Error('中心线根节点不存在。');
  const parent=new Map(graph.nodes.map(n=>[n.id,n.id]));const root=(id:string):string=>{let p=id;while(parent.get(p)!==p)p=parent.get(p)!;return p;};
  for(const b of graph.branches){if(!b||typeof b.id!=='string'||!b.id||ids.has(b.id)||!nodes.has(b.startNodeId)||!nodes.has(b.endNodeId)||!Array.isArray(b.points)||!Array.isArray(b.radiiMm)||!Array.isArray(b.controlPointIndices)||b.points.length<2||b.points.length!==b.radiiMm.length||b.points.some(p=>!Array.isArray(p)||p.length!==3||p.some(n=>!Number.isFinite(n)))||b.radiiMm.some(r=>!Number.isFinite(r)||r<0)||b.controlPointIndices.some((point,i)=>!Number.isSafeInteger(point)||point<0||point>=b.points.length||i>0&&point<=b.controlPointIndices[i-1]!)||b.controlPointIndices[0]!==0||b.controlPointIndices.at(-1)!==b.points.length-1)throw new Error('中心线分支损坏。');ids.add(b.id);
    if(distance(b.points[0]!,nodes.get(b.startNodeId)!.position)>1e-7||distance(b.points.at(-1)!,nodes.get(b.endNodeId)!.position)>1e-7||b.points.some((p,i)=>i>0&&(!Number.isFinite(distance(p,b.points[i-1]!))||distance(p,b.points[i-1]!)<1e-10)))throw new Error('中心线端点或路径无效。');
    const a=root(b.startNodeId),c=root(b.endNodeId);if(a===c)throw new Error('当前中心线编辑器不接受非树/闭环图；请显式拆分环。');parent.set(a,c);
  }
  const branchIDs=new Set(graph.branches.map(b=>b.id)),covered=new Set<string>(),setIDs=new Set<string>();for(const set of graph.branchSets){if(!set||typeof set.id!=='string'||!set.id||setIDs.has(set.id)||!Number.isFinite(set.estimatedVolumeMm3)||set.estimatedVolumeMm3<0||!Array.isArray(set.branchIds))throw new Error('中心线分支集合损坏。');setIDs.add(set.id);for(const id of set.branchIds){if(!branchIDs.has(id)||covered.has(id))throw new Error('中心线分支集合引用损坏。');covered.add(id);}}if(covered.size!==branchIDs.size)throw new Error('中心线分支集合不完整。');
}
export function fitCenterline(grid:VolumeGrid,mask:BinaryMask,options:FitCenterlineOptions):CenterlineGraph{
  const n=requireGrid(grid,mask),limit=options.maxVoxels??2_000_000,spacing=options.controlSpacingMm??Math.min(...grid.spacing)*2,weight=options.centerWeight??2,power=options.clearancePower??2;
  if(!Number.isSafeInteger(limit)||limit<1||n>limit||!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(weight)||weight<0||!Number.isFinite(power)||power<0||power>8||!options.endpoints?.length)throw new Error('中心线参数无效、未指定终点或超过体素预算。');
  const seed=(point:Vec3)=>{if(point?.length!==3||point.some(x=>!Number.isFinite(x)))throw new Error('中心线种子坐标无效。');const p=(options.coordinateSpace==='voxel'?point:worldToVoxel(point,grid)).map(Math.round) as Vec3;if(!inBounds(p,grid)||!mask[voxelIndex(p,grid.dims)])throw new Error('中心线端点必须在Mask内，不能以表面外点直接穿越体积。');return voxelIndex(p,grid.dims);};
  const start=seed(options.root),targets=new Set(options.endpoints.map(seed));if(targets.has(start)||targets.size!==options.endpoints.length)throw new Error('中心线端点重复或与根节点相同。');
  const field=centerlineClearance(grid,mask,{cancelled:options.cancelled,progress:f=>options.progress?.(f*.4)}),cost=new Float64Array(n),previous=new Int32Array(n);cost.fill(Infinity);previous.fill(-1);cost[start]=0;
  let radius=0;for(let i=0;i<n;i++)if(mask[i]&&Number.isFinite(field[i]))radius=Math.max(radius,field[i]!);
  const heap=new MinHeap();heap.push(start,0);const steps=neighbours(grid),remaining=new Set(targets);let popped=0;
  while(heap.ids.length&&remaining.size){const [i,value]=heap.pop()!;if(value!==cost[i])continue;remaining.delete(i);if(!(popped++%2048))check(options,.4+.5*(1-remaining.size/targets.size));const p=voxelPoint(i,grid.dims);
    for(const step of steps){const q=add(p,step.delta);if(!inBounds(q,grid)||!safeStep(p,step.delta,grid,mask))continue;const j=voxelIndex(q,grid.dims),clearance=(field[i]!+field[j]!)/2;
      const next=value+step.mm*(1+weight*(radius/Math.max(clearance,1e-12))**power);if(next<cost[j]!){cost[j]=next;previous[j]=i;heap.push(j,next);}}
  }
  if(remaining.size)throw new Error('中心线端点不在同一安全连通体内；不会以直线连接分离区域。');
  const selected=new Set<number>([start]);for(const target of targets){let i=target,guard=0;while(i!==start){if(i<0||guard++>n)throw new Error('中心线路径回溯损坏。');selected.add(i);i=previous[i]!;}}
  const children=new Map<number,number[]>();for(const i of selected)children.set(i,[]);for(const i of selected)if(i!==start)children.get(previous[i]!)!.push(i);
  const critical=new Set([...selected].filter(i=>i===start||targets.has(i)||children.get(i)!.length!==1));
  const nodes:CenterlineNode[]=[...critical].sort((a,b)=>a-b).map(i=>({id:`node-${i}`,position:physicalPoint(voxelPoint(i,grid.dims),grid),kind:i===start?'root':children.get(i)!.length>1?'junction':'endpoint'}));
  const branches:CenterlineBranch[]=[];for(const i of critical)for(const child of children.get(i)!){const route=[i,child];let last=child;while(!critical.has(last)){last=children.get(last)![0]!;route.push(last);}const points=route.map(j=>physicalPoint(voxelPoint(j,grid.dims),grid));branches.push({id:`branch-${i}-${last}`,startNodeId:`node-${i}`,endNodeId:`node-${last}`,points,radiiMm:route.map(j=>field[j]!),controlPointIndices:controlIndices(points,spacing)});}
  const graph=updateGraph({nodes,branches,branchSets:[],rootNodeId:`node-${start}`,coordinateSystem:'world-mm',algorithm:'independent-clearance-shortest-path',cyclePolicy:'rooted-shortest-path-tree',warnings:['Explicit endpoint-guided independent extraction; automatic native branch discovery is not implemented.','Any source-volume loop is projected to a rooted shortest-path tree; loop topology is not reconstructed.','Clearance is a physical graph-distance estimate, not an exact Euclidean medial-axis radius.']});
  validateCenterline(graph);check(options,1);return graph;
}
export function fitCenterlineFromMesh(grid:VolumeGrid,mesh:TriangleMesh,options:FitCenterlineOptions):CenterlineGraph{
  check(options,0);const mask=maskFromMesh(grid,mesh,{cancelled:options.cancelled,progress:f=>options.progress?.(f*.2)});return fitCenterline(grid,mask,{...options,progress:f=>options.progress?.(.2+f*.8)});
}
function pointInside(p:Vec3,domain:CenterlineDomain){const v=worldToVoxel(p,domain.grid).map(Math.round) as Vec3;return inBounds(v,domain.grid)&&!!domain.mask[voxelIndex(v,domain.grid.dims)];}
function domainCheck(graph:CenterlineGraph,domain:CenterlineDomain,control:AlgorithmControl={}){
  requireGrid(domain.grid,domain.mask);let counter=0;for(const branch of graph.branches)for(let i=0;i<branch.points.length;i++){
    if(!(counter++%1024))check(control);if(!pointInside(branch.points[i]!,domain))throw new Error('编辑/平滑结果越出Mask，已拒绝提交。');
    if(i){const a=worldToVoxel(branch.points[i-1]!,domain.grid),b=worldToVoxel(branch.points[i]!,domain.grid),delta=sub(b,a),cuts=[0,1];
      for(let axis=0;axis<3;axis++)if(Math.abs(delta[axis]!)>1e-14)for(let k=Math.ceil(Math.min(a[axis]!,b[axis]!)-.5);k<=Math.floor(Math.max(a[axis]!,b[axis]!)-.5);k++){const t=(k+.5-a[axis]!)/delta[axis]!;if(t>0&&t<1)cuts.push(t);}
      cuts.sort((x,y)=>x-y);for(let j=1;j<cuts.length;j++){const t=(cuts[j-1]!+cuts[j]!)/2,q=add(a,mul(delta,t)).map(Math.round) as Vec3;if(!inBounds(q,domain.grid)||!domain.mask[voxelIndex(q,domain.grid.dims)])throw new Error('中心线段穿过Mask外部，已拒绝提交。');}
    }
  }
}
export function moveCenterlineControlPoint(graph:CenterlineGraph,branchId:string,pointIndex:number,position:Vec3,options:CenterlineEditOptions={}):CenterlineGraph{
  validateCenterline(graph);check(options);const branch=graph.branches.find(b=>b.id===branchId),influence=options.influenceMm??5;
  if(!branch||!Number.isSafeInteger(pointIndex)||pointIndex<0||pointIndex>=branch.points.length||position.length!==3||position.some(n=>!Number.isFinite(n))||!Number.isFinite(influence)||influence<0)throw new Error('中心线编辑参数无效。');
  const next=cloneGraph(graph),delta=sub(position,branch.points[pointIndex]!),nodeId=pointIndex===0?branch.startNodeId:pointIndex===branch.points.length-1?branch.endNodeId:undefined;
  for(const b of next.branches){let index=b.id===branchId?pointIndex:nodeId===b.startNodeId?0:nodeId===b.endNodeId?b.points.length-1:-1;if(index<0)continue;const s=arcLengths(b.points),at=s[index]!;
    b.points=b.points.map((p,i)=>{if((i===0||i===b.points.length-1)&&i!==index)return p;const w=i===index?1:influence?Math.max(0,1-Math.abs(s[i]!-at)/influence):0;return add(p,mul(delta,w));});
  }
  if(nodeId)next.nodes.find(n=>n.id===nodeId)!.position=[...position];
  if(options.domain)domainCheck(next,options.domain,options);else next.warnings.push('Edited points have not been checked against the source volume.');
  next.warnings.push('Stored clearance radii refer to extraction; recompute sectional metrics after editing.');validateCenterline(next);check(options,1);return updateGraph(next);
}
export function smoothCenterline(graph:CenterlineGraph,options:CenterlineSmoothOptions):CenterlineGraph{
  validateCenterline(graph);if(!Number.isFinite(options.factor)||options.factor<0||options.factor>1)throw new Error('Fourier平滑因子必须为0到1。');const next=cloneGraph(graph),limit=options.maxPointsPerBranch??2048;
  next.branches.forEach((branch,branchIndex)=>{
    check(options,branchIndex/Math.max(1,next.branches.length));const n=branch.points.length;if(n<3||options.factor===0)return;if(n>limit)throw new Error('中心线Fourier平滑超过当前点数预算。');
    const original=branch.points.map(p=>[...p] as Vec3),baseline=original.map((_,i)=>add(original[0]!,mul(sub(original.at(-1)!,original[0]!),i/(n-1)))),residual=original.map((p,i)=>sub(p,baseline[i]!));
    const threshold=options.factor*branch.radiiMm.reduce((s,r)=>s+r,0)/n,coeff:Vec3[]=[];
    for(let k=1;k<n-1;k++){const c:Vec3=[0,0,0];for(let j=1;j<n-1;j++)for(let a=0;a<3;a++)c[a]+=2/(n-1)*residual[j]![a]!*Math.sin(Math.PI*k*j/(n-1));coeff[k]=c;}
    let current=original;
    for(let k=n-2;k>=1;k--){check(options);const candidate=current.map((p,j)=>j===0||j===n-1?p:sub(p,mul(coeff[k]!,Math.sin(Math.PI*k*j/(n-1)))));
      if(candidate.some((p,j)=>distance(p,original[j]!)>threshold+1e-10))break;
      if(options.domain){const probe={...next,branches:[{...branch,points:candidate}]};try{domainCheck(probe,options.domain,options);}catch(error){check(options);break;}}
      current=candidate;
    }
    branch.points=current;
  });
  if(!options.domain)next.warnings.push('Fourier-smoothed points have not been checked against the source volume.');next.warnings.push('Independent endpoint-fixed sine/Fourier low-pass; native spectrum, redistribution and exact threshold path are not reproduced.');validateCenterline(next);check(options,1);return updateGraph(next);
}
export function filterShortBranches(graph:CenterlineGraph,thresholdMm:number,options:{preserveRoot?:boolean}&AlgorithmControl={}):CenterlineGraph{
  validateCenterline(graph);if(!Number.isFinite(thresholdMm)||thresholdMm<0)throw new Error('短枝过滤长度无效。');const next=cloneGraph(graph);let changed=true;
  while(changed){check(options);changed=false;const degree=new Map(next.nodes.map(n=>[n.id,0]));for(const b of next.branches){degree.set(b.startNodeId,degree.get(b.startNodeId)!+1);degree.set(b.endNodeId,degree.get(b.endNodeId)!+1);}
    next.branches=next.branches.filter(b=>{const peripheral=degree.get(b.startNodeId)===1||degree.get(b.endNodeId)===1,protectedRoot=options.preserveRoot!==false&&(b.startNodeId===next.rootNodeId||b.endNodeId===next.rootNodeId);const remove=peripheral&&!protectedRoot&&arcLengths(b.points).at(-1)!<=thresholdMm;if(remove)changed=true;return !remove;});
  }
  check(options,1);return updateGraph(next);
}
function graphComponents(graph:CenterlineGraph):CenterlineGraph[]{const updated=updateGraph(graph),out:CenterlineGraph[]=[];for(const set of updated.branchSets){const branches=updated.branches.filter(b=>set.branchIds.includes(b.id)),ids=new Set(branches.flatMap(b=>[b.startNodeId,b.endNodeId])),nodes=updated.nodes.filter(n=>ids.has(n.id));const rootNodeId=ids.has(graph.rootNodeId)?graph.rootNodeId:nodes[0]!.id;out.push(updateGraph({...cloneGraph(updated),branches,nodes,rootNodeId,branchSets:[]}));}return out;}
export function splitCenterline(graph:CenterlineGraph,branchId:string,pointIndex:number):CenterlineGraph[]{
  validateCenterline(graph);if(graph.branchSets.length!==1)throw new Error('请先选择一个连通中心线进行拆分。');const next=cloneGraph(graph),branch=next.branches.find(b=>b.id===branchId);
  if(!branch||!Number.isSafeInteger(pointIndex)||pointIndex<1||pointIndex>=branch.points.length-1)throw new Error('请在分支内部控制点拆分。');
  const left=`split-left-${branch.id}-${pointIndex}`,right=`split-right-${branch.id}-${pointIndex}`,position=branch.points[pointIndex]!;
  next.nodes.push({id:left,position:[...position],kind:'endpoint'},{id:right,position:[...position],kind:'endpoint'});
  const first={...branch,id:branch.id+'-left',endNodeId:left,points:branch.points.slice(0,pointIndex+1),radiiMm:branch.radiiMm.slice(0,pointIndex+1)},second={...branch,id:branch.id+'-right',startNodeId:right,points:branch.points.slice(pointIndex),radiiMm:branch.radiiMm.slice(pointIndex)};
  first.controlPointIndices=controlIndices(first.points,Math.max(1e-9,arcLengths(first.points).at(-1)!/Math.max(1,first.points.length-1)));second.controlPointIndices=controlIndices(second.points,Math.max(1e-9,arcLengths(second.points).at(-1)!/Math.max(1,second.points.length-1)));
  next.branches=[...next.branches.filter(b=>b.id!==branchId),first,second];return graphComponents(next).map(g=>{validateCenterline(g);return g;});
}
export function deleteCenterlineBranch(graph:CenterlineGraph,branchId:string):CenterlineGraph{
  validateCenterline(graph);if(!graph.branches.some(b=>b.id===branchId))throw new Error('中心线分支不存在。');const next=cloneGraph(graph);next.branches=next.branches.filter(b=>b.id!==branchId);return updateGraph(next);
}
let growthSerial=0;
export function growCenterlineBranch(graph:CenterlineGraph,grid:VolumeGrid,mask:BinaryMask,options:{branchId:string;pointIndex:number;end:Vec3;controlSpacingMm?:number;centerWeight?:number}&AlgorithmControl):CenterlineGraph{
  validateCenterline(graph);const original=graph.branches.find(b=>b.id===options.branchId);if(!original||!Number.isSafeInteger(options.pointIndex)||!original.points[options.pointIndex])throw new Error('新增分支的连接点无效。');
  const routed=fitCenterline(grid,mask,{root:original.points[options.pointIndex]!,endpoints:[options.end],controlSpacingMm:options.controlSpacingMm,centerWeight:options.centerWeight,cancelled:options.cancelled,progress:options.progress});
  const route=routed.branches[0]!;if(routed.branches.length!==1)throw new Error('新增分支路由拓扑异常。');
  const existing=new Map<string,{branchId:string;pointIndex:number}>();const key=(p:Vec3)=>worldToVoxel(p,grid).map(Math.round).join(',');for(const b of graph.branches)b.points.forEach((p,i)=>existing.set(key(p),{branchId:b.id,pointIndex:i}));
  let last=0,attachment={branchId:options.branchId,pointIndex:options.pointIndex};for(let i=0;i<route.points.length;i++){const match=existing.get(key(route.points[i]!));if(match){last=i;attachment=match;}}
  if(last>=route.points.length-1)throw new Error('新终点已在中心线上；添加会产生闭环或重复分支，已拒绝。');
  const next=cloneGraph(graph),branch=next.branches.find(b=>b.id===attachment.branchId)!,at=attachment.pointIndex,serial=++growthSerial;
  let attachId=at===0?branch.startNodeId:at===branch.points.length-1?branch.endNodeId:`junction-grow-${serial}`;
  if(at>0&&at<branch.points.length-1){next.nodes.push({id:attachId,position:[...branch.points[at]!],kind:'junction'});const left={...branch,id:branch.id+`-a${serial}`,endNodeId:attachId,points:branch.points.slice(0,at+1),radiiMm:branch.radiiMm.slice(0,at+1)},right={...branch,id:branch.id+`-b${serial}`,startNodeId:attachId,points:branch.points.slice(at),radiiMm:branch.radiiMm.slice(at)};for(const piece of [left,right])piece.controlPointIndices=controlIndices(piece.points,options.controlSpacingMm??Math.min(...grid.spacing)*2);next.branches=[...next.branches.filter(b=>b.id!==branch.id),left,right];}
  const endId=`endpoint-grow-${serial}`,points=route.points.slice(last);points[0]=[...next.nodes.find(n=>n.id===attachId)!.position];next.nodes.push({id:endId,position:[...points.at(-1)!],kind:'endpoint'});next.branches.push({id:`branch-grow-${serial}`,startNodeId:attachId,endNodeId:endId,points,radiiMm:route.radiiMm.slice(last),controlPointIndices:controlIndices(points,options.controlSpacingMm??Math.min(...grid.spacing)*2)});
  domainCheck(next,{grid,mask},options);updateGraph(next);validateCenterline(next);return next;
}

export interface CenterlineKinematics {tangent:Vec3;normal:Vec3|null;binormal:Vec3|null;curvature:number;curvatureRadiusMm:number;distanceAlongMm:number;tortuosity:number}
function pointAtArc(points:Vec3[],s:number[],at:number):Vec3{let i=1;while(i<s.length-1&&s[i]!<at)i++;const span=s[i]!-s[i-1]!,t=span?(at-s[i-1]!)/span:0;return add(points[i-1]!,mul(sub(points[i]!,points[i-1]!),Math.max(0,Math.min(1,t))));}
export function centerlineKinematics(points:Vec3[],index:number,windowMm?:number):CenterlineKinematics{
  if(points.length<2||!Number.isSafeInteger(index)||index<0||index>=points.length||points.some((p,i)=>p.length!==3||p.some(n=>!Number.isFinite(n))||i>0&&distance(p,points[i-1]!)<1e-10)||windowMm!==undefined&&(!Number.isFinite(windowMm)||windowMm<=0))throw new Error('中心线微分参数无效。');
  const s=arcLengths(points);let velocity:Vec3,acceleration:Vec3=[0,0,0];
  if(points.length===2)velocity=sub(points[1]!,points[0]!);else {const first=Math.max(0,Math.min(points.length-3,index-1)),times=s.slice(first,first+3),at=s[index]!;velocity=[0,0,0];for(let i=0;i<3;i++){const j=(i+1)%3,k=(i+2)%3,den=(times[i]!-times[j]!)*(times[i]!-times[k]!);velocity=add(velocity,mul(points[first+i]!,((at-times[j]!)+(at-times[k]!))/den));acceleration=add(acceleration,mul(points[first+i]!,2/den));}}
  const tangent=unit(velocity),curvature=length(cross(velocity,acceleration))/length(velocity)**3,n=sub(acceleration,mul(tangent,dot(acceleration,tangent))),normal=length(n)>1e-10?unit(n):null,binormal=normal?unit(cross(tangent,normal)):null;
  const total=s.at(-1)!,lo=windowMm===undefined?0:Math.max(0,s[index]!-windowMm/2),hi=windowMm===undefined?total:Math.min(total,s[index]!+windowMm/2),arc=hi-lo;
  return {tangent,normal,binormal,curvature:curvature<1e-12?0:curvature,curvatureRadiusMm:curvature>1e-12?1/curvature:Infinity,distanceAlongMm:s[index]!,tortuosity:arc?Math.max(0,1-distance(pointAtArc(points,s,lo),pointAtArc(points,s,hi))/arc):0};
}
export function distanceOverCenterline(graph:CenterlineGraph,from:{branchId:string;pointIndex:number},to:{branchId:string;pointIndex:number}):{lengthMm:number;points:Vec3[];tortuosity:number}{
  validateCenterline(graph);const nodes=new Map<string,{point:Vec3;edges:{id:string;mm:number}[]}>(),ids=new Map<string,string>();
  for(const branch of graph.branches)for(let i=0;i<branch.points.length;i++){const id=i===0?'node:'+branch.startNodeId:i===branch.points.length-1?'node:'+branch.endNodeId:`sample:${branch.id}@${i}`;ids.set(`${branch.id}@${i}`,id);if(!nodes.has(id))nodes.set(id,{point:branch.points[i]!,edges:[]});if(i){const previous=ids.get(`${branch.id}@${i-1}`)!,mm=distance(branch.points[i-1]!,branch.points[i]!);nodes.get(id)!.edges.push({id:previous,mm});nodes.get(previous)!.edges.push({id,mm});}}
  const start=ids.get(`${from.branchId}@${from.pointIndex}`),end=ids.get(`${to.branchId}@${to.pointIndex}`);if(!start||!end)throw new Error('沿中心线距离的端点无效。');
  const queue=[start],previous=new Map<string,string>(),distances=new Map<string,number>([[start,0]]);for(let i=0;i<queue.length;i++){const id=queue[i]!;if(id===end)break;for(const edge of nodes.get(id)!.edges)if(!distances.has(edge.id)){distances.set(edge.id,distances.get(id)!+edge.mm);previous.set(edge.id,id);queue.push(edge.id);}}
  if(!distances.has(end))throw new Error('两个中心线点属于分离分支集合。');const route=[end];while(route[route.length-1]!==start)route.push(previous.get(route[route.length-1]!)!);route.reverse();const points=route.map(id=>[...nodes.get(id)!.point] as Vec3),lengthMm=distances.get(end)!;
  return {lengthMm,points,tortuosity:lengthMm?Math.max(0,1-distance(points[0]!,points.at(-1)!)/lengthMm):0};
}

export interface CenterlineSection {point:Vec3;tangent:Vec3;contour:Vec3[];area:number;perimeter:number;Area:number;Scf:number;Dfit:number;Dmin:number;Dmax:number;Dh:number;Xh:number;E:number;fitCenter:Vec3;ellipseRadiiMm?:[number,number];fitMethod:string}
export interface SectionOptions {toleranceMm?:number;fitSamples?:number}
function solve(matrix:number[][],rhs:number[]):number[]|null{const n=rhs.length,m=matrix.map((row,i)=>[...row,rhs[i]!]);let scale=0;for(const row of matrix)for(const x of row)scale=Math.max(scale,Math.abs(x));for(let col=0;col<n;col++){let pivot=col;for(let r=col+1;r<n;r++)if(Math.abs(m[r]![col]!)>Math.abs(m[pivot]![col]!))pivot=r;if(Math.abs(m[pivot]![col]!)<=1e-12*Math.max(1,scale))return null;[m[pivot],m[col]]=[m[col]!,m[pivot]!];const d=m[col]![col]!;for(let c=col;c<=n;c++)m[col]![c]/=d;for(let r=0;r<n;r++)if(r!==col){const factor=m[r]![col]!;for(let c=col;c<=n;c++)m[r]![c]-=factor*m[col]![c]!;}}return m.map(row=>row[n]!);}
function leastSquares(rows:number[][],values:number[]){const n=rows[0]!.length,a=Array.from({length:n},()=>Array(n).fill(0) as number[]),b=Array(n).fill(0) as number[];rows.forEach((row,i)=>{for(let j=0;j<n;j++){b[j]+=row[j]!*values[i]!;for(let k=0;k<n;k++)a[j]![k]+=row[j]!*row[k]!;}});return solve(a,b);}
function polygonContains(points:Vec2[],p:Vec2,tolerance=1e-10){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j]!,b=points[i]!,dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));if(Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<=tolerance)return true;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function sectionInternal(mesh:TriangleMesh,point:Vec3,normalInput:Vec3,options:SectionOptions):CenterlineSection{
  if(point.length!==3||point.some(n=>!Number.isFinite(n)))throw new Error('截面中心坐标无效。');const tangent=unit(normalInput),helper:Vec3=Math.abs(tangent[0])<.8?[1,0,0]:[0,1,0],u=unit(cross(tangent,helper)),v=cross(tangent,u),tolerance=options.toleranceMm??1e-5,samples=options.fitSamples??256;
  if(!Number.isFinite(tolerance)||tolerance<=0||!Number.isSafeInteger(samples)||samples<16||samples>8192)throw new Error('截面采样/容差无效。');
  const vertices:Vec2[]=[],buckets=new Map<string,number[]>(),edges=new Set<string>(),adjacent=new Map<number,Set<number>>();
  const weld=(p:Vec3)=>{const d=sub(p,point),xy:Vec2=[dot(d,u),dot(d,v)],cell=xy.map(x=>Math.round(x/tolerance));for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++)for(const i of buckets.get(`${cell[0]!+x},${cell[1]!+y}`)??[])if(Math.hypot(vertices[i]![0]-xy[0],vertices[i]![1]-xy[1])<=tolerance)return i;const i=vertices.length,key=cell.join(',');vertices.push(xy);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key)!.push(i);adjacent.set(i,new Set());return i;};
  const segment=(a:Vec3,b:Vec3)=>{if(distance(a,b)<=tolerance)return;const x=weld(a),y=weld(b);if(x===y)return;const key=x<y?`${x},${y}`:`${y},${x}`;if(edges.has(key))return;edges.add(key);adjacent.get(x)!.add(y);adjacent.get(y)!.add(x);};
  for(let t=0;t<mesh.indices.length;t+=3){const tri=[0,1,2].map(j=>{const i=mesh.indices[t+j]!*3;return [mesh.positions[i]!,mesh.positions[i+1]!,mesh.positions[i+2]!] as Vec3;}),d=tri.map(p=>dot(sub(p,point),tangent));if(d.every(n=>n>tolerance)||d.every(n=>n< -tolerance)||d.every(n=>Math.abs(n)<=tolerance))continue;const hits:Vec3[]=[];
    for(let j=0;j<3;j++){const a=tri[j]!,b=tri[(j+1)%3]!,da=d[j]!,db=d[(j+1)%3]!;if(Math.abs(da)<=tolerance&&Math.abs(db)<=tolerance){segment(a,b);continue;}if(Math.abs(da)<=tolerance)hits.push(a);else if(da*db<0)hits.push(add(a,mul(sub(b,a),da/(da-db))));}
    const unique:Vec3[]=[];for(const hit of hits)if(!unique.some(p=>distance(p,hit)<=tolerance))unique.push(hit);if(unique.length===2)segment(unique[0]!,unique[1]!);
  }
  if(!edges.size||[...adjacent.values()].some(n=>n.size!==2))throw new Error('截面未形成唯一闭合轮廓拓扑，可能切触顶点/退化或存在开放表面。');
  const loops:Vec2[][]=[],seen=new Set<number>();for(let start=0;start<vertices.length;start++){if(seen.has(start))continue;const loop:Vec2[]=[];let previous=-1,current=start;do{if(seen.has(current))throw new Error('截面轮廓自接触。');seen.add(current);loop.push(vertices[current]!);const next=[...adjacent.get(current)!].find(i=>i!==previous)!;previous=current;current=next;}while(current!==start);if(loop.length<3)throw new Error('截面轮廓退化。');loops.push(loop);}
  const signedArea=(p:Vec2[])=>p.reduce((s,a,i)=>{const b=p[(i+1)%p.length]!;return s+a[0]*b[1]-a[1]*b[0];},0)/2;
  const containing=loops.filter(p=>polygonContains(p,[0,0],tolerance)).sort((a,b)=>Math.abs(signedArea(a))-Math.abs(signedArea(b)));if(!containing.length||containing.length%2===0)throw new Error('中心线点不在截面实体内部。');const contour=containing[0]!;
  if(loops.some(p=>p!==contour&&polygonContains(contour,p[0]!,tolerance)))throw new Error('带孔截面尚未实现；不会把内腔面积误算为实体。');
  let perimeter=0,min=Infinity,max=0;const cumulative=[0];for(let i=0;i<contour.length;i++){const a=contour[i]!,b=contour[(i+1)%contour.length]!,dx=b[0]-a[0],dy=b[1]-a[1],ds=Math.hypot(dx,dy),t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/(ds*ds)));min=Math.min(min,Math.hypot(a[0]+t*dx,a[1]+t*dy));max=Math.max(max,Math.hypot(...a));perimeter+=ds;cumulative.push(perimeter);}
  const fit:Vec2[]=[];let edge=0;for(let i=0;i<samples;i++){const at=perimeter*i/samples;while(edge<contour.length-1&&cumulative[edge+1]!<at)edge++;const a=contour[edge]!,b=contour[(edge+1)%contour.length]!,t=(at-cumulative[edge]!)/(cumulative[edge+1]!-cumulative[edge]!);fit.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
  const mean:Vec2=[fit.reduce((s,p)=>s+p[0],0)/samples,fit.reduce((s,p)=>s+p[1],0)/samples],size=Math.max(1e-12,max),normalized=fit.map(p=>[(p[0]-mean[0])/size,(p[1]-mean[1])/size] as Vec2);
  const circle=leastSquares(normalized.map(([x,y])=>[x,y,1]),normalized.map(([x,y])=>-x*x-y*y));if(!circle)throw new Error('截面圆拟合退化。');const cc:Vec2=[-circle[0]!/2,-circle[1]!/2],radius=Math.sqrt(Math.max(0,cc[0]**2+cc[1]**2-circle[2]!))*size,fitCenter=add(point,add(mul(u,mean[0]+cc[0]*size),mul(v,mean[1]+cc[1]*size)));
  const ellipse=leastSquares(normalized.map(([x,y])=>[x*x,x*y,y*y,x,y]),normalized.map(()=>1));let E=NaN,ellipseRadiiMm:[number,number]|undefined;
  if(ellipse){const [a,b,c,d,e]=ellipse as [number,number,number,number,number],det=a*c-b*b/4;if(det>1e-12){const cx=-(c*d-b*e/2)/(2*det),cy=-(a*e-b*d/2)/(2*det),level=1+a*cx*cx+b*cx*cy+c*cy*cy,delta=Math.hypot(a-c,b),lo=(a+c-delta)/2,hi=(a+c+delta)/2;if(lo>0&&level>0){ellipseRadiiMm=[Math.sqrt(level/lo)*size,Math.sqrt(level/hi)*size];E=Math.sqrt(Math.max(0,1-lo/hi));}}}
  const area=Math.abs(signedArea(contour)),Dh=4*area/perimeter,Dmax=2*max;
  return {point:[...point],tangent,contour:contour.map(p=>add(point,add(mul(u,p[0]),mul(v,p[1])))),area,perimeter,Area:area,Scf:perimeter,Dfit:2*radius,Dmin:2*min,Dmax,Dh,Xh:Dh/Dmax,E,fitCenter,...(ellipseRadiiMm?{ellipseRadiiMm}:{}),fitMethod:'uniform-arclength samples; algebraic least-squares circle and conic ellipse (independent)'};
}
export function sectionAt(mesh:TriangleMesh,point:Vec3,tangent:Vec3,options:SectionOptions={}):CenterlineSection{
  const stats=meshStats(mesh);if(!stats.closed||stats.degenerateTriangles)throw new Error('截面分析需要闭合、定向一致且非退化的网格。');return sectionInternal(mesh,point,tangent,{toleranceMm:options.toleranceMm??Math.max(1,...stats.bounds.size)*1e-6,fitSamples:options.fitSamples});
}
export interface CenterlineMeasurementRow extends CenterlineKinematics {branchId:string;pointIndex:number;position:Vec3;section?:CenterlineSection;error?:string}
export function measureCenterline(graph:CenterlineGraph,mesh:TriangleMesh,options:{branchIds?:string[];controlPointsOnly?:boolean;tortuosityWindowMm?:number}&SectionOptions&AlgorithmControl={}):CenterlineMeasurementRow[]{
  validateCenterline(graph);const stats=meshStats(mesh);if(!stats.closed||stats.degenerateTriangles)throw new Error('中心线截面测量需要闭合、定向一致且非退化的网格。');const rows:CenterlineMeasurementRow[]=[];const branches=graph.branches.filter(b=>!options.branchIds||options.branchIds.includes(b.id));let counter=0;
  for(const branch of branches){const indices=options.controlPointsOnly===false?branch.points.map((_,i)=>i):branch.controlPointIndices;for(const i of indices){check(options,counter++/Math.max(1,branches.reduce((s,b)=>s+b.points.length,0)));const row:CenterlineMeasurementRow={branchId:branch.id,pointIndex:i,position:[...branch.points[i]!],...centerlineKinematics(branch.points,i,options.tortuosityWindowMm)};try{row.section=sectionInternal(mesh,row.position,row.tangent,{...options,toleranceMm:options.toleranceMm??Math.max(1,...stats.bounds.size)*1e-6});}catch(error){row.error=error instanceof Error?error.message:String(error);}rows.push(row);}}
  check(options,1);return rows;
}
export function exportCenterlineCSV(graph:CenterlineGraph,measurements?:CenterlineMeasurementRow[]):string{
  validateCenterline(graph);const rows=measurements??graph.branches.flatMap(b=>b.controlPointIndices.map(i=>({branchId:b.id,pointIndex:i,position:b.points[i]!,...centerlineKinematics(b.points,i)}))),columns=['BranchSet','Branch','PointIndex','Px_mm','Py_mm','Pz_mm','Tx','Ty','Tz','Nx','Ny','Nz','BNx','BNy','BNz','Dd_mm','C_1_per_mm','T','Dfit_mm','Dmin_mm','Dmax_mm','Scf_mm','Area_mm2','Dh_mm','Xh','E','SectionError'];
  const cell=(v:unknown)=>{if(typeof v==='number')return Number.isFinite(v)?String(v):'';const s=v===undefined?'':String(v);return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  return [columns.join(','),...rows.map(row=>{const s=('section'in row?row.section:undefined) as CenterlineSection|undefined;return [graph.branchSets.find(set=>set.branchIds.includes(row.branchId))?.id,row.branchId,row.pointIndex,...row.position,...row.tangent,...(row.normal??['','','']),...(row.binormal??['','','']),row.distanceAlongMm,row.curvature,row.tortuosity,s?.Dfit,s?.Dmin,s?.Dmax,s?.Scf,s?.Area,s?.Dh,s?.Xh,s?.E,'error'in row?row.error:''].map(cell).join(',');})].join('\r\n')+'\r\n';
}
