import { requireGrid, physicalPoint, voxelPoint, type AlgorithmControl, type BinaryMask, type Vec3, type VolumeGrid } from './types.ts';
import { sampleVolumeTrilinear, transformVolumePoint, volumeGeometry } from './volumeRendering.ts';

export interface AssemblyMask { id: string; name?: string; mask: BinaryMask; materialId?: number }
export interface AssemblyRegion { regionId: number; maskId: string; name: string; materialId: number }
export interface ResolvedAssembly {
  labels: Uint32Array;
  regions: AssemblyRegion[];
  assignedCounts: number[];
  overlapCounts: number[];
  occupiedCount: number;
}
export interface TetraFace {
  /** Winding points outward from owner. This shared face is stored once. */
  nodes: [number,number,number];
  owner: number;
  /** -1 for an exterior/void boundary. */
  neighbour: number;
  regionIds: [number,number];
  materialIds: [number,number];
}
export interface TetraVolumeMesh {
  positions: Float64Array;
  /** Four zero-based node indices per positive-volume linear tetrahedron. */
  elements: Uint32Array;
  regionIds: Uint32Array;
  materialIds: Uint32Array;
  /** 0xffffffff denotes unavailable source provenance after an interchange import. */
  sourceVoxelIds: Uint32Array;
  regions: AssemblyRegion[];
  boundaryFaces: TetraFace[];
  interfaceFaces: TetraFace[];
  strategy: 'voxel-freudenthal' | 'imported-tetra';
  /** Optional homogeneous, isotropic properties keyed by material ID; caller-declared units. */
  feaMaterials?: Record<number,FEAMaterial>;
}
export interface AssemblyOptions extends AlgorithmControl {maxLabelBytes?:number}
export interface VolumeMeshOptions extends AssemblyOptions {
  maxElements?: number;
  maxNodes?: number;
  /** Conservative allocation estimate, including face maps, not just typed buffers. */
  maxWorkingBytes?: number;
  maxImportTextBytes?: number;
}
export interface TetraQuality { volume:number; meanRatio:number; scaledJacobian:number; edgeAspectRatio:number; minDihedralDegrees:number }
export interface VolumeMeshStats {
  nodes:number;elements:number;regions:number;components:number;
  totalVolume:number;regionVolumes:Record<string,number>;materialVolumes:Record<string,number>;
  boundaryFaces:number;interfaceFaces:number;boundaryArea:number;interfaceArea:number;
  minVolume:number;maxVolume:number;minMeanRatio:number;minScaledJacobian:number;maxEdgeAspectRatio:number;minDihedralDegrees:number;
  invertedElements:number;degenerateElements:number;boundaryMetadataMismatches:number;
  interfaceMetadataMismatches:number;
  /** Imported meshes are not subjected to complete geometric hanging-node/intersection tests. */
  interiorConformity:'topological-only';
  qualityCertified:false;
}
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=(p:Vec3)=>Math.hypot(...p);
const position=(mesh:Pick<TetraVolumeMesh,'positions'>,i:number):Vec3=>[mesh.positions[3*i]!,mesh.positions[3*i+1]!,mesh.positions[3*i+2]!];
const check=(control:AlgorithmControl)=>{if(control.cancelled?.())throw new Error('操作已取消。');};
const positiveId=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const faceKey=(ids:readonly number[])=>[...ids].sort((a,b)=>a-b).join(',');
const faceLocal=[[1,2,3],[0,3,2],[0,1,3],[0,2,1]] as const;

/** Mimics Mask Assembly ordering: existing assignments win and later overlap is subtracted. */
export function resolveAssembly(grid:VolumeGrid,masks:readonly AssemblyMask[],control:AssemblyOptions={}):ResolvedAssembly {
  const count=requireGrid(grid);check(control);const maxLabelBytes=control.maxLabelBytes??256*1024*1024;if(!Number.isFinite(maxLabelBytes)||maxLabelBytes<4)throw new Error('Assembly标签内存限额无效。');if(count*4>maxLabelBytes)throw new Error('Assembly完整标签数组超过当前内存限额；未自动缩减影像。');const labels=new Uint32Array(count),regions:AssemblyRegion[]=[],assignedCounts:number[]=[],overlapCounts:number[]=[],seen=new Set<string>();let occupiedCount=0;
  masks.forEach((input,j)=>{
    requireGrid(grid,input.mask);if(!input.id||seen.has(input.id))throw new Error('Assembly Mask ID必须非空且唯一。');seen.add(input.id);
    const materialId=input.materialId??j+1;if(!positiveId(materialId))throw new Error('材料ID必须为正的32位整数，0保留给void。');
    const regionId=j+1;regions.push({regionId,maskId:input.id,name:input.name??input.id,materialId});let assigned=0,overlap=0;
    for(let i=0;i<count;i++){if(i%65536===0)check(control);if(!input.mask[i])continue;if(labels[i])overlap++;else{labels[i]=regionId;assigned++;}}
    assignedCounts.push(assigned);overlapCounts.push(overlap);occupiedCount+=assigned;control.progress?.((j+1)/Math.max(1,masks.length));
  });
  return {labels,regions,assignedCounts,overlapCounts,occupiedCount};
}

export function signedTetraVolume(a:Vec3,b:Vec3,c:Vec3,d:Vec3):number{return dot(sub(b,a),cross(sub(c,a),sub(d,a)))/6;}
function elementNodes(mesh:Pick<TetraVolumeMesh,'elements'>,i:number):[number,number,number,number]{return [mesh.elements[4*i]!,mesh.elements[4*i+1]!,mesh.elements[4*i+2]!,mesh.elements[4*i+3]!];}
function directionOfFace(nodes:readonly number[]):number {const min=Math.min(...nodes),i=nodes.indexOf(min);return nodes[(i+1)%3]!<nodes[(i+2)%3]!?1:-1;}
interface FaceRecord {nodes:[number,number,number];owner:number;neighbour:number}
function meshFaces(mesh:Pick<TetraVolumeMesh,'elements'|'regionIds'|'materialIds'>,control:AlgorithmControl={}):{boundaryFaces:TetraFace[];interfaceFaces:TetraFace[];adjacent:[number,number][]}{
  const map=new Map<string,FaceRecord>(),adjacent:[number,number][]=[];
  for(let i=0;i<mesh.elements.length/4;i++){
    if(i%4096===0)check(control);const ids=elementNodes(mesh,i);
    for(const local of faceLocal){const nodes=local.map(k=>ids[k]) as [number,number,number],key=faceKey(nodes),existing=map.get(key);
      if(!existing)map.set(key,{nodes,owner:i,neighbour:-1});
      else {if(existing.neighbour!==-1)throw new Error('一个四面体面被三个以上单元共享，体网格非流形。');if(directionOfFace(existing.nodes)===directionOfFace(nodes))throw new Error('相邻四面体共享面方向相同，存在重叠或反向单元。');existing.neighbour=i;adjacent.push([existing.owner,i]);}
    }
  }
  const boundaryFaces:TetraFace[]=[],interfaceFaces:TetraFace[]=[];
  for(const face of map.values()){
    const {owner,neighbour}=face,record:TetraFace={...face,regionIds:[mesh.regionIds[owner]!,neighbour<0?0:mesh.regionIds[neighbour]!],materialIds:[mesh.materialIds[owner]!,neighbour<0?0:mesh.materialIds[neighbour]!]};
    if(neighbour<0)boundaryFaces.push(record);else if(record.regionIds[0]!==record.regionIds[1])interfaceFaces.push(record);
  }
  return {boundaryFaces,interfaceFaces,adjacent};
}
function validateStructure(mesh:TetraVolumeMesh,control:AlgorithmControl={},requirePositive=true):void {
  check(control);
  if(!(mesh.positions instanceof Float64Array)||!(mesh.elements instanceof Uint32Array)||!(mesh.regionIds instanceof Uint32Array)||!(mesh.materialIds instanceof Uint32Array)||!(mesh.sourceVoxelIds instanceof Uint32Array)||!Array.isArray(mesh.regions)||!Array.isArray(mesh.boundaryFaces)||!Array.isArray(mesh.interfaceFaces)||!['voxel-freudenthal','imported-tetra'].includes(mesh.strategy))throw new Error('体网格缓冲区、面集合或策略类型无效。');
  if(mesh.positions.length%3||mesh.elements.length%4)throw new Error('体网格节点或四面体记录不完整。');const n=mesh.positions.length/3,e=mesh.elements.length/4;
  if(mesh.regionIds.length!==e||mesh.materialIds.length!==e||mesh.sourceVoxelIds.length!==e)throw new Error('体网格标签/来源尺寸不一致。');
  for(const value of mesh.positions)if(!Number.isFinite(value))throw new Error('体网格包含非有限坐标。');
  const regions=new Map<number,AssemblyRegion>();for(const r of mesh.regions){if(!r||typeof r.maskId!=='string'||!r.maskId||typeof r.name!=='string'||!positiveId(r.regionId)||!positiveId(r.materialId)||regions.has(r.regionId))throw new Error('体网格region定义无效或重复。');regions.set(r.regionId,r);}
  const seen=new Set<string>();
  for(let i=0;i<e;i++){
    if(i%4096===0)check(control);const ids=elementNodes(mesh,i);if(ids.some(id=>!Number.isSafeInteger(id)||id<0||id>=n)||new Set(ids).size!==4)throw new Error('四面体节点索引无效或重复。');
    const key=faceKey(ids);if(seen.has(key))throw new Error('体网格包含重复四面体。');seen.add(key);
    const region=regions.get(mesh.regionIds[i]!);if(!region||mesh.materialIds[i]!==region.materialId)throw new Error('体网格region/material标签与定义不一致。');
    const volume=signedTetraVolume(...ids.map(id=>position(mesh,id)) as [Vec3,Vec3,Vec3,Vec3]);
    if(!Number.isFinite(volume))throw new Error('体网格单元体积计算超出有限数值范围。');
    if(requirePositive&&volume<=0)throw new Error('体网格存在零体积或反向四面体。');
  }
  if(mesh.feaMaterials!==undefined){if(!mesh.feaMaterials||typeof mesh.feaMaterials!=='object'||Array.isArray(mesh.feaMaterials))throw new Error('体网格材料表无效。');for(const[id,material]of Object.entries(mesh.feaMaterials)){if(!positiveId(Number(id))||!mesh.regions.some(r=>r.materialId===Number(id)))throw new Error('材料属性引用不存在的材料ID。');validateFEAMaterial(material);}}
}
function faceMetadataMismatches(declared:readonly TetraFace[],actual:readonly TetraFace[]):number {
  const expected=new Map(actual.map(f=>[faceKey(f.nodes),f])),seen=new Set<string>();let mismatches=0;
  for(const face of declared){if(!face||!Array.isArray(face.nodes)||face.nodes.length!==3||!Array.isArray(face.regionIds)||face.regionIds.length!==2||!Array.isArray(face.materialIds)||face.materialIds.length!==2){mismatches++;continue;}const key=faceKey(face.nodes),reference=expected.get(key);if(seen.has(key)||!reference||face.owner!==reference.owner||face.neighbour!==reference.neighbour||directionOfFace(face.nodes)!==directionOfFace(reference.nodes)||face.regionIds.some((v,k)=>v!==reference.regionIds[k])||face.materialIds.some((v,k)=>v!==reference.materialIds[k]))mismatches++;seen.add(key);}
  for(const key of expected.keys())if(!seen.has(key))mismatches++;return mismatches;
}
export function validateVolumeMesh(mesh:TetraVolumeMesh,control:AlgorithmControl={}):void{validateStructure(mesh,control);const faces=meshFaces(mesh,control);if(faceMetadataMismatches(mesh.boundaryFaces,faces.boundaryFaces)||faceMetadataMismatches(mesh.interfaceFaces,faces.interfaceFaces))throw new Error('体网格边界/界面元数据与单元拓扑不一致。');}
function workingLimit(elements:number,nodes:number,labelBytes:number,options:VolumeMeshOptions):void {
  const limit=options.maxWorkingBytes??256*1024*1024;if(!Number.isFinite(limit)||limit<1)throw new Error('体网格工作内存限额无效。');
  if(elements*768+nodes*128+labelBytes>limit)throw new Error('体网格预计工作内存超过限额（含共享面拓扑）；未自动缩减影像。');
}

/** Conforming six-tet Freudenthal subdivision. Every occupied voxel uses the same body diagonal.
 * No smoothing or MC is applied: interfaces share global nodes and identical triangular faces. */
export function buildConformingVolumeMesh(grid:VolumeGrid,masks:readonly AssemblyMask[],options:VolumeMeshOptions={}):TetraVolumeMesh {
  const geometry=volumeGeometry(grid),assembly=resolveAssembly(grid,masks,{cancelled:options.cancelled,maxLabelBytes:options.maxLabelBytes,progress:p=>options.progress?.(p*.15)});
  const maxElements=options.maxElements??300000,maxNodes=options.maxNodes??1000000,elementCount=assembly.occupiedCount*6;
  if(!Number.isSafeInteger(maxElements)||maxElements<1||!Number.isSafeInteger(maxNodes)||maxNodes<1)throw new Error('体网格内存限额必须为正整数。');
  if(elementCount>maxElements)throw new Error(`当前体素策略需要 ${elementCount} 个四面体，超过 ${maxElements} 上限；未自动缩减影像或更改Mask。`);
  if(!Number.isSafeInteger((grid.dims[0]+1)*(grid.dims[1]+1)*(grid.dims[2]+1)))throw new Error('体网格格点编号超出安全整数范围。');
  workingLimit(elementCount,Math.min(maxNodes,assembly.occupiedCount*8),assembly.labels.byteLength,options);
  const positions:number[]=[],elements=new Uint32Array(elementCount*4),regionIds=new Uint32Array(elementCount),materialIds=new Uint32Array(elementCount),sourceVoxelIds=new Uint32Array(elementCount),nodes=new Map<number,number>();
  const lattice=[grid.dims[0]+1,grid.dims[1]+1,grid.dims[2]+1];
  const node=(p:Vec3)=>{const key=p[0]+lattice[0]!*(p[1]+lattice[1]!*p[2]);let id=nodes.get(key);if(id===undefined){id=positions.length/3;if(id>=maxNodes)throw new Error(`体网格节点超过 ${maxNodes} 上限。`);nodes.set(key,id);positions.push(...physicalPoint(p.map(v=>v-.5),{spacing:grid.spacing,affine:geometry.voxelToWorld}));}return id;};
  const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]],temporary={positions} as unknown as Pick<TetraVolumeMesh,'positions'>;let element=0;
  for(let i=0;i<assembly.labels.length;i++){
    if(i%8192===0){check(options);options.progress?.(.15+.6*i/Math.max(1,assembly.labels.length));}const regionId=assembly.labels[i]!;if(!regionId)continue;
    const p=voxelPoint(i,grid.dims),low=node(p),high=node(p.map(v=>v+1) as Vec3);
    for(const permutation of permutations){const a=[...p] as Vec3;a[permutation[0]!]++;const b=[...a] as Vec3;b[permutation[1]!]++;const ids:[number,number,number,number]=[low,node(a),node(b),high];let volume=signedTetraVolume(...ids.map(id=>position(temporary,id)) as [Vec3,Vec3,Vec3,Vec3]);
      if(volume<0){[ids[1],ids[2]]=[ids[2],ids[1]];volume=-volume;}if(!(volume>0)||!Number.isFinite(volume))throw new Error('物理坐标精度不足或 affine 退化，无法构造正体积单元。');
      elements.set(ids,4*element);regionIds[element]=regionId;materialIds[element]=assembly.regions[regionId-1]!.materialId;sourceVoxelIds[element]=i;element++;
    }
  }
  const base={positions:new Float64Array(positions),elements,regionIds,materialIds,sourceVoxelIds,regions:assembly.regions,strategy:'voxel-freudenthal' as const};
  const faces=meshFaces(base,options);options.progress?.(1);return {...base,boundaryFaces:faces.boundaryFaces,interfaceFaces:faces.interfaceFaces};
}

export function tetraQuality(mesh:Pick<TetraVolumeMesh,'positions'|'elements'>,element:number):TetraQuality {
  if(!Number.isSafeInteger(element)||element<0||4*element+3>=mesh.elements.length)throw new Error('四面体编号越界。');const original=elementNodes(mesh,element).map(i=>position(mesh,i));if(original.some(p=>p.some(v=>!Number.isFinite(v))))throw new Error('四面体坐标或节点索引无效。');
  const volume=signedTetraVolume(...original as [Vec3,Vec3,Vec3,Vec3]),scale=Math.max(...original.flatMap((a,i)=>original.slice(i+1).map(b=>norm(sub(a,b)))));if(!Number.isFinite(volume)||!Number.isFinite(scale))throw new Error('四面体质量计算超出有限数值范围。');
  const p=original.map(v=>sub(v,original[0]!).map(n=>scale?n/scale:0) as Vec3),lengths:number[]=[];for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)lengths.push(norm(sub(p[i]!,p[j]!)));const sum=lengths.reduce((s,v)=>s+v*v,0),normalizedVolume=signedTetraVolume(...p as [Vec3,Vec3,Vec3,Vec3]);
  const meanRatio=normalizedVolume>0&&sum>0?12*Math.pow(3*normalizedVolume,2/3)/sum:0;
  const corners=[[0,1,2,3],[1,0,3,2],[2,0,1,3],[3,0,2,1]],jacobians=corners.map(([i,j,k,l])=>{const x=sub(p[j!]!,p[i!]!),y=sub(p[k!]!,p[i!]!),z=sub(p[l!]!,p[i!]!),denominator=norm(x)*norm(y)*norm(z);return denominator?Math.SQRT2*dot(x,cross(y,z))/denominator:0;});
  const normals=faceLocal.map(face=>{const n=cross(sub(p[face[1]]!,p[face[0]]!),sub(p[face[2]]!,p[face[0]]!)),len=norm(n);return len?n.map(v=>v/len) as Vec3:[0,0,0] as Vec3;});let minDihedralDegrees=180;
  for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)minDihedralDegrees=Math.min(minDihedralDegrees,Math.acos(Math.max(-1,Math.min(1,-dot(normals[i]!,normals[j]!))))*180/Math.PI);
  return {volume,meanRatio,scaledJacobian:Math.min(...jacobians),edgeAspectRatio:Math.max(...lengths)/Math.min(...lengths),minDihedralDegrees};
}
function faceArea(mesh:Pick<TetraVolumeMesh,'positions'>,face:TetraFace):number{const[a,b,c]=face.nodes.map(i=>position(mesh,i));return norm(cross(sub(b!,a!),sub(c!,a!)))/2;}
export function volumeMeshStats(mesh:TetraVolumeMesh,control:AlgorithmControl={}):VolumeMeshStats {
  validateStructure(mesh,control,false);const faces=meshFaces(mesh,control),count=mesh.elements.length/4,parent=Array.from({length:count},(_,i)=>i),root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]!]!;i=parent[i]!;}return i;};for(const[a,b]of faces.adjacent)parent[root(a)]=root(b);
  let totalVolume=0,minVolume=Infinity,maxVolume=-Infinity,minMeanRatio=1,minScaledJacobian=Infinity,maxEdgeAspectRatio=0,minDihedralDegrees=180,invertedElements=0,degenerateElements=0;const regionVolumes:Record<string,number>={},materialVolumes:Record<string,number>={};
  for(let i=0;i<count;i++){if(i%4096===0){check(control);control.progress?.(i/Math.max(1,count));}const q=tetraQuality(mesh,i);totalVolume+=q.volume;minVolume=Math.min(minVolume,q.volume);maxVolume=Math.max(maxVolume,q.volume);minMeanRatio=Math.min(minMeanRatio,q.meanRatio);minScaledJacobian=Math.min(minScaledJacobian,q.scaledJacobian);maxEdgeAspectRatio=Math.max(maxEdgeAspectRatio,q.edgeAspectRatio);minDihedralDegrees=Math.min(minDihedralDegrees,q.minDihedralDegrees);if(q.volume<0)invertedElements++;if(q.volume===0)degenerateElements++;regionVolumes[mesh.regionIds[i]!]=(regionVolumes[mesh.regionIds[i]!]??0)+q.volume;materialVolumes[mesh.materialIds[i]!]=(materialVolumes[mesh.materialIds[i]!]??0)+q.volume;}
  if(!count){minVolume=maxVolume=minMeanRatio=minScaledJacobian=minDihedralDegrees=0;}
  const boundaryMetadataMismatches=faceMetadataMismatches(mesh.boundaryFaces,faces.boundaryFaces),interfaceMetadataMismatches=faceMetadataMismatches(mesh.interfaceFaces,faces.interfaceFaces);
  control.progress?.(1);return {nodes:mesh.positions.length/3,elements:count,regions:new Set(mesh.regionIds).size,components:new Set(parent.map((_,i)=>root(i))).size,totalVolume,regionVolumes,materialVolumes,boundaryFaces:faces.boundaryFaces.length,interfaceFaces:faces.interfaceFaces.length,boundaryArea:faces.boundaryFaces.reduce((s,f)=>s+faceArea(mesh,f),0),interfaceArea:faces.interfaceFaces.reduce((s,f)=>s+faceArea(mesh,f),0),minVolume,maxVolume,minMeanRatio,minScaledJacobian,maxEdgeAspectRatio,minDihedralDegrees,invertedElements,degenerateElements,boundaryMetadataMismatches,interfaceMetadataMismatches,interiorConformity:'topological-only',qualityCertified:false};
}

export interface GraySamplingOptions extends AlgorithmControl {mode?:'centroid'|'four-point';outside?:'error'|'clamp'}
export function sampleElementGrayValues(grid:VolumeGrid,mesh:TetraVolumeMesh,options:GraySamplingOptions={}):Float32Array {
  if(options.mode!==undefined&&!['centroid','four-point'].includes(options.mode)||options.outside!==undefined&&!['error','clamp'].includes(options.outside))throw new Error('灰度采样方法或边界策略无效。');
  requireGrid(grid);validateStructure(mesh,options);const inverse=volumeGeometry(grid).worldToVoxel,count=mesh.elements.length/4,result=new Float32Array(count),alpha=.5854101966249685,beta=.1381966011250105;
  for(let i=0;i<count;i++){
    if(i%2048===0){check(options);options.progress?.(i/Math.max(1,count));}const p=elementNodes(mesh,i).map(id=>position(mesh,id));
    const samples=options.mode==='four-point'?[0,1,2,3].map(j=>[0,1,2].map(k=>p.reduce((s,v,l)=>s+v[k]!*(j===l?alpha:beta),0)) as Vec3):[[0,1,2].map(k=>p.reduce((s,v)=>s+v[k]!/4,0)) as Vec3];let value=0;
    for(const sample of samples){const voxel=transformVolumePoint(inverse,sample);if(options.outside!=='clamp'&&voxel.some((v,k)=>v<-.5-1e-7||v>grid.dims[k]!-.5+1e-7))throw new Error('体网格采样点位于影像物理范围之外。');const scalar=sampleVolumeTrilinear(grid,voxel);if(!Number.isFinite(scalar))throw new Error('灰度采样产生非有限值。');value+=scalar/samples.length;}result[i]=value;if(!Number.isFinite(result[i]))throw new Error('灰度采样结果超出Float32范围。');
  }
  options.progress?.(1);return result;
}
export interface MaterialCalibration {
  densityFromGray:{slope:number;intercept:number;unit:string;min?:number;max?:number};
  youngFromDensity:{coefficient:number;exponent:number;offset?:number;unit:string};
  poissonRatio:number;
}
export interface CalibratedMaterials {gray:Float32Array;density:Float64Array;youngModulus:Float64Array;poissonRatio:Float64Array;units:{density:string;youngModulus:string}}
/** Explicit caller calibration; there is deliberately no default clinical HU→density/E formula. */
export function calibrateMaterials(values:Float32Array,calibration:MaterialCalibration,control:AlgorithmControl={}):CalibratedMaterials {
  const d=calibration.densityFromGray,e=calibration.youngFromDensity,p=calibration.poissonRatio;
  if(![d.slope,d.intercept,e.coefficient,e.exponent,e.offset??0,p].every(Number.isFinite)||!d.unit||!e.unit||p<=-1||p>=.5||e.coefficient<0||(d.min!==undefined&&(!Number.isFinite(d.min)||d.min<0))||(d.max!==undefined&&(!Number.isFinite(d.max)||d.max<(d.min??0))))throw new Error('材料校准参数、单位或泊松比无效。');
  const density=new Float64Array(values.length),youngModulus=new Float64Array(values.length),poissonRatio=new Float64Array(values.length).fill(p);
  for(let i=0;i<values.length;i++){if(i%4096===0)check(control);if(!Number.isFinite(values[i]))throw new Error('材料灰度含非有限值。');let rho=d.slope*values[i]!+d.intercept;if(d.min!==undefined)rho=Math.max(d.min,rho);if(d.max!==undefined)rho=Math.min(d.max,rho);const modulus=e.coefficient*Math.pow(rho,e.exponent)+(e.offset??0);if(!Number.isFinite(rho)||rho<0||!Number.isFinite(modulus)||modulus<=0)throw new Error('校准产生负密度或非正/非有限弹性模量，请核查标定关系。');density[i]=rho;youngModulus[i]=modulus;}
  control.progress?.(1);return {gray:values.slice(),density,youngModulus,poissonRatio,units:{density:d.unit,youngModulus:e.unit}};
}

function importLimits(nodes:number,elements:number,options:VolumeMeshOptions){const maxNodes=options.maxNodes??1000000,maxElements=options.maxElements??300000;if(!Number.isSafeInteger(maxNodes)||maxNodes<1||!Number.isSafeInteger(maxElements)||maxElements<1)throw new Error('导入体网格限额无效。');if(!Number.isSafeInteger(nodes)||nodes<0||!Number.isSafeInteger(elements)||elements<0)throw new Error('体网格节点或单元记录长度无效。');if(nodes>maxNodes||elements>maxElements)throw new Error('导入体网格超过当前节点/单元限额。');workingLimit(elements,nodes,0,options);}
function importTextLimit(text:string,options:VolumeMeshOptions){check(options);const limit=options.maxImportTextBytes??64*1024*1024;if(typeof text!=='string'||!Number.isFinite(limit)||limit<1||text.length*2>limit)throw new Error('体网格导入文本超过当前内存限额或类型无效。');}
function importedMesh(positions:Float64Array,elements:Uint32Array,regionIds:Uint32Array,materialIds:Uint32Array,sourceVoxelIds?:Uint32Array,regions?:AssemblyRegion[],options:VolumeMeshOptions={}):TetraVolumeMesh {
  importLimits(positions.length/3,elements.length/4,options);check(options);
  if(!regions){const ids=[...new Set(regionIds)].sort((a,b)=>a-b);regions=ids.map(id=>{const index=regionIds.indexOf(id);return {regionId:id,maskId:`imported-region-${id}`,name:`Region ${id}`,materialId:materialIds[index]!};});}
  const base:TetraVolumeMesh={positions,elements,regionIds,materialIds,sourceVoxelIds:sourceVoxelIds??new Uint32Array(elements.length/4).fill(0xffffffff),regions:regions.map(r=>({...r})),boundaryFaces:[],interfaceFaces:[],strategy:'imported-tetra'};
  validateStructure(base,options);const faces=meshFaces(base,options);return {...base,boundaryFaces:faces.boundaryFaces,interfaceFaces:faces.interfaceFaces};
}
function uintArray(values:unknown,name:string):Uint32Array {if(!Array.isArray(values)||values.some(v=>typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>0xffffffff))throw new Error(`${name}必须为32位非负整数数组。`);return new Uint32Array(values);}
function numberArray(values:unknown,name:string):Float64Array {if(!Array.isArray(values)||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error(`${name}必须为有限数数组。`);return new Float64Array(values);}
export interface VolumeMeshDocument {format:'deepmark-tetra-1';units:'mm';positions:number[];elements:number[];regionIds:number[];materialIds:number[];sourceVoxelIds:number[];regions:AssemblyRegion[];strategy:TetraVolumeMesh['strategy'];feaMaterials?:Record<number,FEAMaterial>}
/** Derived faces are rebuilt rather than trusted during decoding. No project state is mutated. */
export function encodeVolumeMesh(mesh:TetraVolumeMesh):VolumeMeshDocument {
  validateVolumeMesh(mesh);return {format:'deepmark-tetra-1',units:'mm',positions:[...mesh.positions],elements:[...mesh.elements],regionIds:[...mesh.regionIds],materialIds:[...mesh.materialIds],sourceVoxelIds:[...mesh.sourceVoxelIds],regions:mesh.regions.map(r=>({...r})),strategy:mesh.strategy,...(mesh.feaMaterials?{feaMaterials:Object.fromEntries(Object.entries(mesh.feaMaterials).map(([id,m])=>[id,{...m}]))}:{})};
}
export function decodeVolumeMesh(value:unknown,options:VolumeMeshOptions={}):TetraVolumeMesh {
  check(options);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('未知的体网格JSON格式。');const data=value as Record<string,unknown>;if(data.format!=='deepmark-tetra-1'||!Array.isArray(data.regions)||data.units!==undefined&&data.units!=='mm')throw new Error('未知的体网格JSON格式或坐标单位。');
  if(!Array.isArray(data.positions)||!Array.isArray(data.elements))throw new Error('体网格JSON缺少节点/单元数组。');importLimits(data.positions.length/3,data.elements.length/4,options);
  const regions=(data.regions as unknown[]).map(r=>{if(!r||typeof r!=='object')throw new Error('region元数据无效。');const d=r as AssemblyRegion;if(typeof d.maskId!=='string'||typeof d.name!=='string'||!positiveId(d.regionId)||!positiveId(d.materialId))throw new Error('region元数据字段无效。');return {...d};});
  const result=importedMesh(numberArray(data.positions,'positions'),uintArray(data.elements,'elements'),uintArray(data.regionIds,'regionIds'),uintArray(data.materialIds,'materialIds'),uintArray(data.sourceVoxelIds,'sourceVoxelIds'),regions,options);
  if(data.strategy!==undefined&&!['voxel-freudenthal','imported-tetra'].includes(data.strategy as string))throw new Error('体网格策略字段无效。');
  // This is preserved generation provenance, not proof that an imported file is geometrically conforming.
  if(data.strategy==='voxel-freudenthal')result.strategy='voxel-freudenthal';
  if(data.feaMaterials!==undefined){if(!data.feaMaterials||typeof data.feaMaterials!=='object'||Array.isArray(data.feaMaterials))throw new Error('体网格材料表无效。');result.feaMaterials={};for(const[id,m]of Object.entries(data.feaMaterials)){validateFEAMaterial(m as FEAMaterial);result.feaMaterials[Number(id)]={...m as FEAMaterial};}validateStructure(result,options);}
  return result;
}
export function exportVolumeMeshJSON(mesh:TetraVolumeMesh):string{return JSON.stringify(encodeVolumeMesh(mesh));}
export function parseVolumeMeshJSON(text:string,options:VolumeMeshOptions={}):TetraVolumeMesh {importTextLimit(text,options);return decodeVolumeMesh(JSON.parse(text),options);}

export interface FEAMaterial {name?:string;density?:number;youngModulus:number;poissonRatio:number}
function validateFEAMaterial(material:FEAMaterial):void {if(!material||typeof material!=='object'||(material.name!==undefined&&typeof material.name!=='string')||!Number.isFinite(material.youngModulus)||material.youngModulus<=0||!Number.isFinite(material.poissonRatio)||material.poissonRatio<=-1||material.poissonRatio>=.5||(material.density!==undefined&&(!Number.isFinite(material.density)||material.density<0)))throw new Error('Abaqus材料参数无效。');}
export interface AbaqusExportOptions extends AlgorithmControl {materials?:Record<number,FEAMaterial>}
/** Abaqus C3D4 mesh import, sets and optional explicit isotropic material data.
 * Does not invent load cases, boundary conditions, unit conversions or clinical calibrations. */
export function exportAbaqusVolumeMesh(mesh:TetraVolumeMesh,options:AbaqusExportOptions={}):string {
  validateVolumeMesh(mesh,options);const lines=['*HEADING','Independent conforming tetrahedral mesh; physical coordinates in mm','** DEEPMARK_TETRA 1'];
  for(const region of mesh.regions)lines.push(`** DEEPMARK_REGION ${encodeURIComponent(JSON.stringify(region))}`);
  lines.push('*NODE');for(let i=0;i<mesh.positions.length/3;i++){if(i%4096===0)check(options);lines.push(`${i+1}, ${position(mesh,i).join(', ')}`);}
  lines.push('*ELEMENT, TYPE=C3D4');for(let i=0;i<mesh.elements.length/4;i++){if(i%4096===0)check(options);lines.push(`${i+1}, ${elementNodes(mesh,i).map(id=>id+1).join(', ')}`);}
  const emitSet=(name:string,ids:number[])=>{if(!ids.length)return;lines.push(`*ELSET, ELSET=${name}`);for(let i=0;i<ids.length;i+=16)lines.push(ids.slice(i,i+16).join(', '));};
  for(const region of mesh.regions){const ids:number[]=[];mesh.regionIds.forEach((id,i)=>{if(id===region.regionId)ids.push(i+1);});emitSet(`REGION_${region.regionId}`,ids);}
  for(const materialId of [...new Set(mesh.materialIds)].sort((a,b)=>a-b)){
    const ids:number[]=[];mesh.materialIds.forEach((id,i)=>{if(id===materialId)ids.push(i+1);});emitSet(`MATERIAL_${materialId}`,ids);
    const material=(options.materials??mesh.feaMaterials)?.[materialId];if(material){
      validateFEAMaterial(material);
      const suffix=(material.name??'').replace(/[^A-Za-z0-9_]/g,'_').slice(0,50),name=`MAT_${materialId}${suffix?'_'+suffix:''}`;
      lines.push(`** DEEPMARK_MATERIAL_NAME ${materialId} ${encodeURIComponent(JSON.stringify(material.name??null))}`,`*MATERIAL, NAME=${name}`,'*ELASTIC',`${material.youngModulus}, ${material.poissonRatio}`);if(material.density!==undefined)lines.push('*DENSITY',String(material.density));lines.push(`*SOLID SECTION, ELSET=MATERIAL_${materialId}, MATERIAL=${name}`,',');
    }
  }
  return lines.join('\n')+'\n';
}
export function parseAbaqusVolumeMesh(text:string,options:VolumeMeshOptions={}):TetraVolumeMesh {
  importTextLimit(text,options);
  const nodes=new Map<number,Vec3>(),elements=new Map<number,[number,number,number,number]>(),sets=new Map<string,number[]>(),regions:AssemblyRegion[]=[],materialDefinitions=new Map<string,Partial<FEAMaterial>>(),sections:{set:string;material:string}[]=[],originalMaterialNames=new Map<number,string|undefined>();let mode='',setName='',elementSetName='',generate=false,materialName='',lineNumber=0,setEntries=0;
  const attribute=(line:string,name:string)=>line.match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,]+)`,'i'))?.[1]?.trim().toUpperCase();
  const addSet=(name:string,values:number[])=>{setEntries+=values.length;if(setEntries>(options.maxElements??300000)*16)throw new Error('Abaqus ELSET总记录超过内存限额。');const set=sets.get(name)??[];for(const id of values)set.push(id);sets.set(name,set);};
  for(const raw of text.split(/\r?\n/)){
    if(lineNumber++%4096===0)check(options);const line=raw.trim();if(!line)continue;if(line.startsWith('**')){const match=line.match(/^\*\*\s*DEEPMARK_REGION\s+(.+)$/);if(match){const region=JSON.parse(decodeURIComponent(match[1]!)) as AssemblyRegion;if(!region||typeof region.maskId!=='string'||typeof region.name!=='string')throw new Error('Abaqus region元数据无效。');regions.push(region);}const name=line.match(/^\*\*\s*DEEPMARK_MATERIAL_NAME\s+(\d+)\s+(.+)$/);if(name){const parsed=JSON.parse(decodeURIComponent(name[2]!));if(parsed!==null&&typeof parsed!=='string')throw new Error('Abaqus材料名称元数据无效。');originalMaterialNames.set(Number(name[1]),parsed??undefined);}continue;}
    if(line.startsWith('*')){
      const upper=line.toUpperCase();mode=upper.split(',')[0]!.trim();generate=/\bGENERATE\b/.test(upper);
      if(['*SYSTEM','*TRANSFORM','*NMAP','*NGEN','*NFILL','*NCOPY','*ELGEN','*ELCOPY','*INCLUDE','*INSTANCE','*PART','*ASSEMBLY'].includes(mode))throw new Error(`当前Abaqus导入不支持 ${mode} 几何/坐标作用域；请先展开为全局节点及C3D4单元。`);
      if(mode==='*ELEMENT'&&!/\bTYPE\s*=\s*C3D4\b/.test(upper))throw new Error('当前Abaqus导入仅支持线性四面体C3D4。');
      if(mode==='*ELEMENT')elementSetName=attribute(line,'ELSET')??'';
      if(mode==='*NODE'&&attribute(line,'SYSTEM')!==undefined&&attribute(line,'SYSTEM')!=='R')throw new Error('Abaqus节点仅支持全局直角坐标。');
      if(mode==='*ELSET'){const match=upper.match(/\bELSET\s*=\s*([^,]+)/);if(!match)throw new Error('Abaqus ELSET缺少名称。');setName=match[1]!.trim();if(!sets.has(setName))sets.set(setName,[]);}
      if(mode==='*MATERIAL'){materialName=attribute(line,'NAME')??'';if(!materialName||materialDefinitions.has(materialName))throw new Error('Abaqus材料名称无效或重复。');materialDefinitions.set(materialName,{name:materialName});}
      if(mode==='*ELASTIC'&&attribute(line,'TYPE')!==undefined&&attribute(line,'TYPE')!=='ISOTROPIC')throw new Error('Abaqus材料当前只支持各向同性ELASTIC。');
      if(mode==='*SOLID SECTION'){const set=attribute(line,'ELSET'),material=attribute(line,'MATERIAL');if(!set||!material)throw new Error('Abaqus SOLID SECTION缺少集合或材料名称。');sections.push({set,material});}
      continue;
    }
    if(!['*NODE','*ELEMENT','*ELSET','*ELASTIC','*DENSITY'].includes(mode))continue;const values=line.split(',').map(v=>v.trim()).filter(Boolean).map(Number);if(values.some(v=>!Number.isFinite(v)))throw new Error('Abaqus包含无效数值。');
    if(mode==='*NODE'){const[id,x,y,z]=values;if(values.length!==4||!positiveId(id!)||nodes.has(id!))throw new Error('Abaqus NODE记录无效或重复。');nodes.set(id!,[x!,y!,z!]);}
    else if(mode==='*ELEMENT'){if(values.length!==5||values.some(v=>!positiveId(v))||elements.has(values[0]!))throw new Error('Abaqus ELEMENT记录无效或重复。');elements.set(values[0]!,values.slice(1) as [number,number,number,number]);if(elementSetName)addSet(elementSetName,[values[0]!]);}
    else if(mode==='*ELASTIC'||mode==='*DENSITY'){const material=materialDefinitions.get(materialName);if(!material)throw new Error('Abaqus材料数据缺少MATERIAL定义。');if(mode==='*ELASTIC'){if(values.length!==2||material.youngModulus!==undefined)throw new Error('Abaqus仅支持一组不依赖温度的E/泊松比。');material.youngModulus=values[0];material.poissonRatio=values[1];}else{if(values.length!==1||material.density!==undefined)throw new Error('Abaqus仅支持一组常数密度。');material.density=values[0];}}
    else {if(values.some(v=>!positiveId(v)))throw new Error('Abaqus ELSET编号无效。');if(generate){if(values.length<2||values.length>3)throw new Error('Abaqus GENERATE记录无效。');const[first,last,step=1]=values;if(last!<first!||step<1)throw new Error('Abaqus GENERATE范围无效。');if((last!-first!)/step>(options.maxElements??300000))throw new Error('Abaqus ELSET展开超过单元限额。');const ids:number[]=[];for(let i=first!;i<=last!;i+=step)ids.push(i);addSet(setName,ids);}else addSet(setName,values);}
    importLimits(nodes.size,elements.size,options);if((nodes.size+elements.size)%4096===0)check(options);
  }
  const nodeMap=new Map<number,number>(),positions:number[]=[];for(const[id,p]of nodes){nodeMap.set(id,positions.length/3);positions.push(...p);}const elementMap=new Map<number,number>(),indices:number[]=[];for(const[id,ids]of elements){elementMap.set(id,indices.length/4);for(const source of ids){const node=nodeMap.get(source);if(node===undefined)throw new Error('Abaqus元素引用不存在的节点。');indices.push(node);}}
  const regionIds=new Uint32Array(elements.size).fill(1),materialIds=new Uint32Array(elements.size).fill(1),assignedRegions=new Uint8Array(elements.size),assignedMaterials=new Uint8Array(elements.size);
  for(const[name,ids]of sets){const match=name.match(/^(REGION|MATERIAL)_(\d+)$/);if(!match)continue;const label=Number(match[2]);if(!positiveId(label))throw new Error('Abaqus标签ID无效。');const labels=match[1]==='REGION'?regionIds:materialIds,assigned=match[1]==='REGION'?assignedRegions:assignedMaterials;for(const id of ids){const i=elementMap.get(id);if(i===undefined)throw new Error('Abaqus ELSET引用不存在的单元。');if(assigned[i]&&labels[i]!==label)throw new Error('同一Abaqus单元被分配到冲突region/material。');labels[i]=label;assigned[i]=1;}}
  const materialLabels=new Map<string,number>(),feaMaterials:Record<number,FEAMaterial>={};let nextLabel=1;
  for(const section of sections){const ids=sets.get(section.set),definition=materialDefinitions.get(section.material);if(!ids||!definition)throw new Error('Abaqus SOLID SECTION引用不存在的集合或材料。');validateFEAMaterial(definition as FEAMaterial);let label=materialLabels.get(section.material);const explicit=section.set.match(/^MATERIAL_(\d+)$/);if(label===undefined){if(explicit)label=Number(explicit[1]);else{while(Object.hasOwn(feaMaterials,nextLabel)||materialIds.includes(nextLabel)&&assignedMaterials.some(v=>v>0))nextLabel++;label=nextLabel++;}if(!positiveId(label))throw new Error('Abaqus材料标签ID无效。');materialLabels.set(section.material,label);feaMaterials[label]={...definition as FEAMaterial};if(originalMaterialNames.has(label)){const originalName=originalMaterialNames.get(label);if(originalName===undefined)delete feaMaterials[label]!.name;else feaMaterials[label]!.name=originalName;}}else if(explicit&&Number(explicit[1])!==label)throw new Error('一个Abaqus材料定义被映射到冲突材料ID。');for(const id of ids){const i=elementMap.get(id);if(i===undefined)throw new Error('Abaqus截面集合引用不存在的单元。');if(assignedMaterials[i]&&materialIds[i]!==label)throw new Error('Abaqus截面与材料集合冲突。');materialIds[i]=label;assignedMaterials[i]=1;}}
  if(!regions.length&&!assignedRegions.some(v=>v>0))regionIds.set(materialIds);
  if(regions.length){const byRegion=new Map(regions.map(r=>[r.regionId,r]));for(let i=0;i<materialIds.length;i++)if(!assignedMaterials[i])materialIds[i]=byRegion.get(regionIds[i]!)?.materialId??materialIds[i]!;}
  const result=importedMesh(new Float64Array(positions),new Uint32Array(indices),regionIds,materialIds,undefined,regions.length?regions:undefined,options);if(Object.keys(feaMaterials).length){result.feaMaterials=feaMaterials;validateStructure(result,options);}return result;
}

/** Standard VTK legacy ASCII unstructured grid, tetra cell type 10 and explicit cell labels. */
export function exportVTKVolumeMesh(mesh:TetraVolumeMesh,control:AlgorithmControl={}):string {
  validateVolumeMesh(mesh,control);const n=mesh.positions.length/3,e=mesh.elements.length/4,lines=['# vtk DataFile Version 3.0','Independent conforming tetra mesh; coordinates mm','ASCII','DATASET UNSTRUCTURED_GRID',`POINTS ${n} double`];
  for(let i=0;i<n;i++){if(i%4096===0)check(control);lines.push(position(mesh,i).join(' '));}lines.push(`CELLS ${e} ${e*5}`);for(let i=0;i<e;i++)lines.push(`4 ${elementNodes(mesh,i).join(' ')}`);lines.push(`CELL_TYPES ${e}`);for(let i=0;i<e;i++)lines.push('10');lines.push(`CELL_DATA ${e}`);
  for(const[name,values]of [['region_id',mesh.regionIds],['material_id',mesh.materialIds],['source_voxel_id',mesh.sourceVoxelIds]] as const){lines.push(`SCALARS ${name} unsigned_int 1`,'LOOKUP_TABLE default');for(let i=0;i<values.length;i+=16){check(control);lines.push([...values.subarray(i,i+16)].join(' '));}}
  return lines.join('\n')+'\n';
}
export function parseVTKVolumeMesh(text:string,options:VolumeMeshOptions={}):TetraVolumeMesh {
  importTextLimit(text,options);
  const lines=text.split(/\r?\n/);if(!/^# vtk DataFile Version/i.test(lines[0]??'')||lines[2]?.trim()!=='ASCII'||lines[3]?.trim()!=='DATASET UNSTRUCTURED_GRID')throw new Error('当前导入仅支持VTK legacy ASCII UNSTRUCTURED_GRID。');
  const tokens=lines.slice(4).join(' ').trim().split(/\s+/);let cursor=0;const expect=(word:string)=>{if(tokens[cursor++]!==word)throw new Error(`VTK缺少 ${word}。`);},integer=()=>{const v=Number(tokens[cursor++]);if(!Number.isSafeInteger(v)||v<0||v>0xffffffff)throw new Error('VTK整数记录无效。');return v;},scalar=()=>{const token=tokens[cursor++],v=Number(token);if(token===undefined||!Number.isFinite(v))throw new Error('VTK数值无效。');return v;};
  expect('POINTS');const n=integer();importLimits(n,0,options);const type=tokens[cursor++];if(!['double','float'].includes(type!))throw new Error('VTK节点类型不支持。');const positions=new Float64Array(n*3);for(let i=0;i<positions.length;i++)positions[i]=scalar();expect('CELLS');const e=integer(),size=integer();importLimits(n,e,options);if(size!==5*e)throw new Error('VTK四面体CELLS长度不一致。');const elements=new Uint32Array(e*4);for(let i=0;i<e;i++){if(i%4096===0)check(options);if(integer()!==4)throw new Error('VTK当前只支持四节点四面体。');for(let k=0;k<4;k++)elements[4*i+k]=integer();}expect('CELL_TYPES');if(integer()!==e)throw new Error('VTK CELL_TYPES计数不一致。');for(let i=0;i<e;i++)if(integer()!==10)throw new Error('VTK单元必须为tetra类型10。');
  const arrays=new Map<string,Uint32Array>();if(cursor<tokens.length){expect('CELL_DATA');if(integer()!==e)throw new Error('VTK CELL_DATA计数不一致。');while(cursor<tokens.length){expect('SCALARS');const name=tokens[cursor++]!,dataType=tokens[cursor++];if(!['unsigned_int','int','unsigned_long'].includes(dataType!))throw new Error('VTK标签需整数类型。');if(tokens[cursor]!=='LOOKUP_TABLE'&&integer()!==1)throw new Error('VTK当前只支持单分量标签。');expect('LOOKUP_TABLE');expect('default');const values=new Uint32Array(e);for(let i=0;i<e;i++)values[i]=integer();if(arrays.has(name))throw new Error('VTK含重复标签数组。');arrays.set(name,values);}}
  return importedMesh(positions,elements,arrays.get('region_id')??new Uint32Array(e).fill(1),arrays.get('material_id')??new Uint32Array(e).fill(1),arrays.get('source_voxel_id'),undefined,options);
}
