import {parseNifti,type Volume} from '../core.ts';
import {validateProject,volumeGrid,type ProjectState,type ProjectViewState} from './project.ts';
import type {DicomVolume} from './dicom.ts';
import type {AffinePlane,MprPlane,MeasurementObject,Vec3,VolumeGrid} from './types.ts';
import {physicalPoint} from './types.ts';
import {nearestVoxelCoordinate,worldToVoxel} from './measurements.ts';
import {validateMprPlane} from './mpr.ts';
import {validateAffinePlane,transformAffinePlane} from './affinePlane.ts';
import {isPhysicalContourSet,convertNativeContours,transformPhysicalContours} from './physicalContours.ts';
import type {ResliceProjectGeometryResult} from './resliceProjectGeometry.ts';
import {composeResliceReference,validateNiftiReference,multiplyReferenceMatrices,inverseReferenceMatrix,affineIsOblique,referenceEncodingErrorMm,type ResliceReferenceResult} from './niftiReference.ts';

export interface ReslicedProjectOptions {name:string;copyWorldObjects:boolean;updateCoordinateSystem?:boolean}
export interface ReslicedProjectData {volume:Volume;state:ProjectState;transformationText:string;warnings:string[]}
type Matrix=number[][];
const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,i)=>sum+n*b[i]!,0);
const length=(p:Vec3)=>Math.hypot(...p);
const sub=(a:Vec3,b:Vec3)=>a.map((n,i)=>n-b[i]!) as Vec3;
const scale=(a:Vec3,n:number)=>a.map(v=>v*n) as Vec3;
function finite(p:readonly number[]){if(p.some(n=>!Number.isFinite(n)))throw new Error('新重切片工程包含非有限坐标。');}
function point(matrix:Matrix,p:Vec3):Vec3{const out=matrix.slice(0,3).map(row=>dot(row.slice(0,3) as Vec3,p)+row[3]!) as Vec3;finite(out);return out;}
function vector(matrix:Matrix,p:Vec3):Vec3{const out=matrix.slice(0,3).map(row=>dot(row.slice(0,3) as Vec3,p)) as Vec3;finite(out);return out;}
function homogeneous(value:unknown,label:string):Matrix{
  if(!Array.isArray(value)||![3,4].includes(value.length)||value.some(row=>!Array.isArray(row)||row.length!==4||row.some(n=>typeof n!=='number'||!Number.isFinite(n))))throw new Error(`${label}必须为有限仿射矩阵。`);
  if(value.length===4&&value[3]!.some((n:number,i:number)=>n!==(i===3?1:0)))throw new Error(`${label}不能包含透视变换。`);
  return[...value.slice(0,3).map(row=>[...row]),[0,0,0,1]];
}
function multiply(a:Matrix,b:Matrix):Matrix{return a.map(row=>[0,1,2,3].map(col=>row.reduce((sum,n,k)=>sum+n*b[k]![col]!,0)));}
function rigid(value:unknown,label:string):Matrix{
  const m=homogeneous(value,label),rows=m.slice(0,3).map(row=>row.slice(0,3) as Vec3);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(dot(rows[i]!,rows[j]!)-(i===j?1:0))>1e-6)throw new Error(`${label}必须为刚体坐标变换。`);
  const [a,b,c]=rows,det=a![0]*(b![1]*c![2]-b![2]*c![1])-a![1]*(b![0]*c![2]-b![2]*c![0])+a![2]*(b![0]*c![1]-b![1]*c![0]);
  if(Math.abs(det-1)>1e-6)throw new Error(`${label}必须保持右手坐标系。`);return m;
}
function inverseGrid(grid:VolumeGrid):Matrix{
  const affine=homogeneous(grid.affine??[[grid.spacing[0],0,0,0],[0,grid.spacing[1],0,0],[0,0,grid.spacing[2],0]],'源图像方向'),linear={spacing:grid.spacing,affine:affine.slice(0,3).map(row=>[...row.slice(0,3),0])},columns=([0,1,2] as const).map(axis=>{const p:Vec3=[0,0,0];p[axis]=1;return worldToVoxel(p,linear);}),rotation=[0,1,2].map(row=>[columns[0]![row]!,columns[1]![row]!,columns[2]![row]!,0]),translation=vector([...rotation,[0,0,0,1]],affine.slice(0,3).map(row=>-row[3]!) as Vec3);
  return[...rotation.map((row,i)=>[...row.slice(0,3),translation[i]!]),[0,0,0,1]];
}
function sourceAffinePlane(grid:VolumeGrid,m:MeasurementObject):AffinePlane{
  const slice=m.plane!,axes=([0,1,2] as const).filter(axis=>axis!==slice.axis),p:Vec3=[0,0,0];p[slice.axis]=slice.index;const origin=physicalPoint(p,grid),a=[...p] as Vec3,b=[...p] as Vec3;a[axes[0]!]++;b[axes[1]!]++;
  return validateAffinePlane({origin,u:sub(physicalPoint(a,grid),origin),v:sub(physicalPoint(b,grid),origin),size:[grid.dims[axes[0]!]!,grid.dims[axes[1]!]!]});
}
function sourcePlane(grid:VolumeGrid,m:MeasurementObject):MprPlane{
  const native=sourceAffinePlane(grid,m),{origin,u}=native,rawV=native.v,cosine=dot(u,rawV)/(length(u)*length(rawV));
  const v=Math.abs(cosine)<=1e-6?rawV:scale(sub(rawV,scale(u,dot(rawV,u)/dot(u,u))),length(rawV)/length(sub(rawV,scale(u,dot(rawV,u)/dot(u,u)))));
  return validateMprPlane({origin,u,v,size:[...native.size]});
}
/** Metadata-only version checks; never visits source image/Mask cells. */
function validateObjectRevisions(state:ProjectState):void{
  const versions=new Map<string,number>();
  for(const mask of state.masks){
    if(!mask||typeof mask.id!=='string'||!mask.id||versions.has(mask.id)||!Number.isSafeInteger(mask.revision)||mask.revision<0)throw new Error('源 Mask 标识或版本无效。');
    if(!Number.isSafeInteger(mask.revision+1))throw new Error('Mask 版本已超出安全整数范围。');
    versions.set(mask.id,mask.revision);
  }
  for(const object of [...state.parts,...(state.centerlines??[]),...(state.polylines??[])]){
    if(!object||object.sourceRevision!==undefined&&(!Number.isSafeInteger(object.sourceRevision)||object.sourceRevision<0))throw new Error('历史对象来源版本无效。');
    if(object.sourceMaskId!==undefined&&typeof object.sourceMaskId!=='string')throw new Error('历史对象来源 Mask 标识无效。');
    if(object.sourceMaskId!==undefined&&object.sourceRevision!==undefined&&versions.has(object.sourceMaskId)&&object.sourceRevision>versions.get(object.sourceMaskId)!)throw new Error('工程来源Mask版本晚于现有来源。');
  }
  for(const object of state.polylines??[])if(isPhysicalContourSet(object.set)){
    if(!Array.isArray(object.set.layers))throw new Error('源物理 Polyline 层目录无效。');
    const source=object.sourceMaskId===undefined?undefined:versions.get(object.sourceMaskId);for(const layer of object.set.layers)if(layer.sourceRevision!==undefined&&(!Number.isSafeInteger(layer.sourceRevision)||layer.sourceRevision<0||source!==undefined&&layer.sourceRevision>source))throw new Error('源物理 Polyline 层来源版本无效或晚于现有来源。');
  }
}
/** Lightweight object/coordinate preflight for live preview; no voxel-buffer scan.
 * Full project validation belongs to the actual build, not each parameter edit.
 * Explicit independent retention policy; no native copy behavior is implied.
 */
export function validateResliceProjectObjects(sourceVolume:Volume,sourceState:ProjectState,copyWorldObjects:boolean):void{
  if(typeof copyWorldObjects!=='boolean')throw new Error('请选择是否复制物理对象。');
  if(!sourceVolume||sourceVolume.unit!=='mm')throw new Error('请先确认源影像空间单位。');
  if(!sourceState||!Array.isArray(sourceState.masks)||!Array.isArray(sourceState.parts)||!Array.isArray(sourceState.measurements)||sourceState.centerlines!==undefined&&!Array.isArray(sourceState.centerlines)||sourceState.polylines!==undefined&&!Array.isArray(sourceState.polylines))throw new Error('源工程对象目录无效。');
  if(!Array.isArray(sourceVolume.dims)||sourceVolume.dims.length!==3||sourceVolume.dims.some(n=>!Number.isSafeInteger(n)||n<=0)||!Array.isArray(sourceVolume.spacing)||sourceVolume.spacing.length!==3||sourceVolume.spacing.some(n=>!Number.isFinite(n)||n<=0)||!(sourceVolume.header instanceof Uint8Array)||sourceVolume.header.length!==348)throw new Error('源工程空间元数据无效。');
  homogeneous(sourceVolume.affine,'源图像方向');validateObjectRevisions(sourceState);
  if(!copyWorldObjects)return;
  const grid=volumeGrid(sourceVolume);for(const m of sourceState.measurements){if(!m||typeof m.kind!=='string')throw new Error('源测量对象类型无效。');if(m.densityPlane!==undefined)validateAffinePlane(m.densityPlane);if(m.plane){if(![0,1,2].includes(m.plane.axis)||!Number.isSafeInteger(m.plane.index)||m.plane.index<0||m.plane.index>=grid.dims[m.plane.axis])throw new Error('源测量切片上下文无效。');if(m.kind==='density-rectangle'||m.kind==='density-ellipse')sourceAffinePlane(grid,m);else sourcePlane(grid,m);}}
  for(const object of sourceState.polylines??[]){
    const set=object.set;if(isPhysicalContourSet(set)){if(!Array.isArray(set.layers))throw new Error('源物理 Polyline 层目录无效。');for(const layer of set.layers)validateAffinePlane(layer.plane);}
    else if(!set||set.provenance!=='independent-half-voxel-cell-boundary'||![0,1,2].includes(set.axis)||!Array.isArray(set.dims)||set.dims.some((n,i)=>n!==grid.dims[i]))throw new Error('源 Polyline 切片网格无效。');
  }
}
function transformPlane(m:Matrix,p:MprPlane):MprPlane{return validateMprPlane({origin:point(m,p.origin),u:vector(m,p.u),v:vector(m,p.v),size:[...p.size]});}
function transformMesh(values:Float32Array,m:Matrix,asVector=false):Float32Array{
  const result=new Float32Array(values.length);for(let i=0;i<values.length;i+=3){const converted=(asVector?vector:point)(m,[values[i]!,values[i+1]!,values[i+2]!]);if(converted.some(n=>!Number.isFinite(Math.fround(n))))throw new Error('转换后的网格坐标超出 Float32 范围。');result.set(converted,i);}return result;
}
function makeVolume(name:string,sampling:ResliceProjectGeometryResult,reference:ResliceReferenceResult):Volume{
  const dims=sampling.dims;if(!Array.isArray(dims)||dims.length!==3||dims.some(n=>!Number.isSafeInteger(n)||n<=0||n>32767))throw new Error('新工程尺寸超出 NIfTI-1 正整数范围。');const count=dims[0]*dims[1]*dims[2];
  if(!(sampling.data instanceof Float32Array)||sampling.data.length!==count||count>128*1024*1024)throw new Error('新工程灰度与尺寸不一致或超过预算。');
  const affine=homogeneous(sampling.affine,'新工程方向');if(sampling.spacing.length!==3||sampling.spacing.some(n=>!Number.isFinite(n)||n<=0))throw new Error('新工程物理间距无效。');
  const referenceAffine=multiplyReferenceMatrices(reference.reference.applicationToReference,affine),spacing=([0,1,2] as const).map(c=>Math.hypot(...affine.slice(0,3).map(row=>row[c]!))) as Vec3;
  const header=new Uint8Array(348),h=new DataView(header.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);for(let i=0;i<7;i++)h.setInt16(42+i*2,i<3?dims[i]!:1,true);h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(76,1,true);for(let i=0;i<3;i++)h.setFloat32(80+i*4,spacing[i]!,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setFloat32(116,0,true);h.setUint8(123,2);h.setInt16(252,0,true);h.setInt16(254,reference.code,true);for(let r=0;r<3;r++)for(let c=0;c<4;c++)h.setFloat32(280+r*16+c*4,referenceAffine[r]![c]!,true);header.set([110,43,49,0],344);
  // A one-voxel probe reuses the canonical parser's float-header geometry rules.
  // It never allocates or fills a second complete image just to parse the header.
  const probe=new ArrayBuffer(356),ph=new DataView(probe);new Uint8Array(probe).set(header);for(let i=0;i<3;i++)ph.setInt16(42+i*2,1,true);parseNifti(probe,name);const data=sampling.data.slice();let min=Infinity,max=-Infinity;for(const value of data){if(!Number.isFinite(value))throw new Error('新工程包含非有限灰度。');min=Math.min(min,value);max=Math.max(max,value);}
  return{name,dims:[...dims],spacing,affine:affine.slice(0,3).map(row=>[...row]),oblique:affineIsOblique(affine),unit:'mm',little:true,header,data,min,max,niftiReference:validateNiftiReference(reference.reference)};
}
function transformView(sourceVolume:Volume,source:ProjectViewState|undefined,volume:Volume,t:Matrix,copy:boolean):ProjectViewState{
  const view:ProjectViewState={...(source?.window?{window:{...source.window}}:{}),renderMode:source?.renderMode??'parts',tool:'navigate',tab:source?.tab??'segmentation',activeAxis:2};
  const old=source?.point??sourceVolume.dims.map(n=>Math.floor(n/2)) as Vec3,world=point(t,physicalPoint(old,volumeGrid(sourceVolume))),ijk=worldToVoxel(world,volumeGrid(volume));view.point=ijk.map((n,a)=>Math.max(0,Math.min(volume.dims[a]!-1,nearestVoxelCoordinate(n)))) as Vec3;
  if(copy&&source?.selectedMeasurementId!==undefined)view.selectedMeasurementId=source.selectedMeasurementId;
  if(copy&&source?.mpr)view.mpr={...source.mpr,plane:transformPlane(t,source.mpr.plane),...(source.mpr.crosshair?{crosshair:point(t,source.mpr.crosshair)}:{})};return view;
}
function textMatrix(label:string,m:Matrix){return`${label}\n${m.map(row=>row.map(n=>Object.is(n,-0)?'0':n.toPrecision(17)).join(' ')).join('\n')}\n`;}
export function buildReslicedProject(sourceVolume:Volume,sourceState:ProjectState,sampling:ResliceProjectGeometryResult,options:ReslicedProjectOptions):ReslicedProjectData{
  if(!options||typeof options.name!=='string'||!options.name.trim()||options.name.trim().length>512)throw new Error('新工程名称必须为1至512个字符。');if(options.updateCoordinateSystem!==undefined&&typeof options.updateCoordinateSystem!=='boolean')throw new Error('Update CS 必须为布尔值。');validateProject(sourceVolume,sourceState);validateResliceProjectObjects(sourceVolume,sourceState,options.copyWorldObjects);
  const t=rigid(sampling.sourceWorldToOutputWorld,'旧世界到新世界变换'),inverse=rigid(sampling.outputWorldToSourceWorld,'新世界到旧世界变换'),product=multiply(t,inverse);if(product.some((row,r)=>row.some((n,c)=>Math.abs(n-(r===c?1:0))>1e-6)))throw new Error('新旧坐标变换不互为逆矩阵。');
  const name=options.name.trim(),reference=composeResliceReference(sourceVolume,inverse,{legacyResliced:!!sourceState.resliceTransform}),volume=makeVolume(name,sampling,reference),worldChanged=t.some((row,r)=>row.some((n,c)=>Math.abs(n-(r===c?1:0))>1e-12)),updated=options.updateCoordinateSystem??worldChanged,metadata=(sourceVolume as DicomVolume).dicom;if(metadata)(volume as DicomVolume).dicom={...metadata,coordinateSystem:updated?'reslice-local':metadata.coordinateSystem};
  if(!Array.isArray(sampling.masks)||sampling.masks.length!==sourceState.masks.length||new Set(sampling.masks.map(m=>m.id)).size!==sampling.masks.length)throw new Error('重切片结果必须按 ID 包含全部独立 Mask。');
  // The source validator forbids a derived revision beyond its current Mask;
  // one increment therefore leaves every retained historical derivative stale.
  const masks=sourceState.masks.map(mask=>{const sampled=sampling.masks.find(m=>m.id===mask.id);if(!sampled||!(sampled.data instanceof Uint8Array)||sampled.data.length!==volume.data.length||sampled.data.some(n=>n!==0&&n!==1))throw new Error(`重切片 Mask「${mask.name}」标识或成员无效。`);return{...mask,data:sampled.data.slice(),threshold:mask.threshold?[...mask.threshold] as [number,number]:null,revision:mask.revision+1};});
  let state:ProjectState={name,masks,parts:[],measurements:[],selectedMaskId:sourceState.selectedMaskId,selectedPartId:''};const warnings=['对象保留和坐标转换是本应用独立政策；尚无原版 Reslice Project 对象继承证据。','新体积和 Mask 已重新采样；保留的历史几何不会自动重建，旧来源版本将显示过期。',...reference.warnings];
  const encodingError=referenceEncodingErrorMm(volume);if(encodingError>Math.max(1e-5,Math.min(...volume.spacing)*1e-3))warnings.push(`NIfTI Float32 参考头在视野角点的编码误差最大约 ${encodingError.toPrecision(6)} mm；应用标注仍保留数学坐标，文件不能表达更小的参考位移。`);
  if(options.copyWorldObjects){
    state={...sourceState,name,masks,...(sourceState.centerlines?{centerlines:structuredClone(sourceState.centerlines)}:{})};state.parts=sourceState.parts.map(p=>({...p,mesh:{positions:transformMesh(p.mesh.positions,t),indices:p.mesh.indices.slice(),...(p.mesh.normals?{normals:transformMesh(p.mesh.normals,t,true)}:{})}}));
    const grid=volumeGrid(sourceVolume);state.measurements=sourceState.measurements.map(m=>{const {plane:_plane,mprPlane:_mpr,densityPlane:_density,...rest}=m,isDensity=m.kind==='density-rectangle'||m.kind==='density-ellipse',density=m.densityPlane??(isDensity&&m.plane?sourceAffinePlane(grid,m):undefined),physical=density?undefined:m.mprPlane??(m.plane?sourcePlane(grid,m):undefined);return{...rest,points:m.points.map(p=>point(t,p)),...(m.controlPoints?{controlPoints:m.controlPoints.map(p=>point(t,p))}:{}),...(m.labelOffset?{labelOffset:vector(t,m.labelOffset)}:{}),...(m.pointPartIds?{pointPartIds:[...m.pointPartIds]}:{}),...(m.annotationStyle?{annotationStyle:{...m.annotationStyle}}:{}),...(density?{densityPlane:transformAffinePlane(density,t)}:{}),...(physical?{mprPlane:transformPlane(t,physical)}:{})};});
    if(state.centerlines)for(const c of state.centerlines){c.graph.nodes.forEach(n=>n.position=point(t,n.position));c.graph.branches.forEach(b=>b.points=b.points.map(p=>point(t,p)));}
    if(sourceState.resliceObjects)state.resliceObjects=sourceState.resliceObjects.map(rp=>({...rp,plane:transformPlane(t,rp.plane)}));
    if(sourceState.polylines)state.polylines=sourceState.polylines.map(o=>({...o,set:transformPhysicalContours(isPhysicalContourSet(o.set)?o.set:convertNativeContours(grid,o.set,o.sourceRevision),t)}));
    if(sourceState.measurements.some(m=>m.plane))warnings.push('原始 IJK 测量切片已转换为独立物理平面，密度 ROI 保留原始剪切基底；密度值将在重采样灰度上重新计算。');
    if(sourceState.polylines?.some(o=>!isPhysicalContourSet(o.set)))warnings.push('原始 IJK Polyline 已转换为独立物理平面，保留环、洞和历史来源版本；未从新 Mask 重算。');
  }else{
    warnings.push(`仅输出影像和全部 Mask；未复制 Part ${sourceState.parts.length}、测量 ${sourceState.measurements.length}、中心线 ${sourceState.centerlines?.length??0}、Polyline ${sourceState.polylines?.length??0}、RP ${sourceState.resliceObjects?.length??0} 个。原工程保留。`);
  }
  state.viewState=transformView(sourceVolume,sourceState.viewState,volume,t,options.copyWorldObjects);
  const oldFromNew=multiply(multiply(inverseGrid(volumeGrid(sourceVolume)),inverse),homogeneous(volume.affine,'新图像方向'));
  const transformationText=['Deepmark Reslice Project coordinate transforms (independent application format; not a vendor TXT format).',`Update CS: ${updated?'on':'off'}.`,'Coordinates use millimetres. Homogeneous column vectors; matrices printed row-major.','Voxel IJK coordinates refer to sample centers. Output [0,0,0] is the first stored sample center (application convention; native upper-left mapping unverified).','Old/new world below means application world, not necessarily patient RAS.','NIfTI sform stores a separate reference frame, with Float32 coefficient encoding.',`NIfTI reference frame: ${reference.reference.frame}; sform code: ${reference.code}.`,`Maximum reference-header encoding error at support corners: ${encodingError.toPrecision(17)} mm (not application geometry motion).`,'No automatic write to the original project folder is implied.','',textMatrix('old-world-mm -> new-world-mm (coordinate-system change T)',t),textMatrix('new-world-mm -> old-world-mm (inverse T)',inverse),textMatrix('new-IJK-sample-center -> old-IJK-sample-center (Aold^-1 * inverse(T) * Anew)',oldFromNew),textMatrix('application-world-mm -> NIfTI-reference-world-mm (L)',reference.reference.applicationToReference),textMatrix('NIfTI-reference-world-mm -> application-world-mm (inverse L)',inverseReferenceMatrix(reference.reference.applicationToReference))].join('\n');
  state.resliceTransform=transformationText;validateProject(volume,state);
  return{volume,state,transformationText,warnings};
}
