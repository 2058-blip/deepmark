import {checkedVoxelLength,checkedVoxelCount,MAX_ZIP32_BYTES,NATIVE_LITTLE_ENDIAN} from '../volumeCapacity.ts';
import {zipSync, unzipSync, strToU8, strFromU8} from 'fflate';
import {parseNifti} from '../core.ts';
import type {Volume} from '../core.ts';
import type {DicomVolume} from './dicom.ts';
import {validateCenterline} from './centerline.ts';
import type {CenterlineGraph} from './centerline.ts';
import {CONTOUR_PROVENANCE} from './contours.ts';
import type {ContourSet} from './contours.ts';
import type {MaskObject, PartObject, MeasurementObject, VolumeGrid, Vec3, BinaryMask, TriangleMesh, Axis, MprPlane, ReslicePlaneObject} from './types.ts';
import {physicalPoint} from './types.ts';
import {measurementPartIds} from './measurementAttachments.ts';
import {validateMprPlane} from './mpr.ts';
import {validateAffinePlane,affinePlaneWorldToPixel} from './affinePlane.ts';
import {isPhysicalContourSet,validatePhysicalContourSet} from './physicalContours.ts';
import type {PhysicalContourSet} from './physicalContours.ts';
import {validateNiftiReference,validateReferenceHeader,applicationAffineMm,affineIsOblique} from './niftiReference.ts';

export interface CenterlineObject {id:string;name:string;color:string;visible:boolean;graph:CenterlineGraph;sourceMaskId?:string;sourceRevision?:number;sourcePartId?:string}
export interface PolylineObject {id:string;name:string;color:string;visible:boolean;set:ContourSet|PhysicalContourSet;sourceMaskId?:string;sourceRevision?:number}
/** Independent display frame; step and precise optional crosshair use world millimetres. */
export interface ProjectMprViewState {enabled:boolean;plane:MprPlane;step:number;interpolation:'nearest'|'linear';crosshair?:Vec3}
/** Optional v1 display state. point retains integral native IJK; measurements and MPR use world mm. */
export interface ProjectViewState {
  point?:Vec3;
  window?:{center:number;width:number};
  activeAxis?:Axis;
  renderMode?:'parts'|'volume';
  tool?:string;
  selectedMeasurementId?:string;
  tab?:'segmentation'|'surface'|'measurements'|'analysis';
  mpr?:ProjectMprViewState;
}
export interface ProjectState {
  name: string;
  masks: MaskObject[];
  parts: PartObject[];
  measurements: MeasurementObject[];
  selectedMaskId: string;
  selectedPartId: string;
  centerlines?:CenterlineObject[];
  polylines?:PolylineObject[];
  selectedCenterlineId?:string;
  selectedPolylineId?:string;
  resliceObjects?:ReslicePlaneObject[];
  /** The selected object is the active RP definition; MPR enabled/disabled is independent view state. */
  selectedResliceId?:string;
  /** Current resliced project's explicit coordinate transform; mirrored by a fixed ZIP text entry. */
  resliceTransform?:string;
  viewState?:ProjectViewState;
}
function assertKeys(value:unknown,keys:string,label:string):asserts value is Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error(`工程${label}对象无效。`);
  const allowed=new Set(keys.split(' '));
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!allowed.has(key))throw new Error(`工程${label}包含未支持字段：${String(key)}。`);
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!descriptor.enumerable||!('value' in descriptor))throw new Error(`工程${label}包含未支持的属性。`);
  }
}
function validateAnnotationStyle(style:unknown,kind:unknown){
  assertKeys(style,'arrow rotation align','标注样式');
  if(kind!=='annotation'||!['none','arrow','dot'].includes(style.arrow)||!['left','center','right'].includes(style.align)||typeof style.rotation!=='number'||!Number.isFinite(style.rotation)||style.rotation< -360||style.rotation>360)throw new Error('工程标注样式无效，仅文字标注支持有限的[-360,360]度旋转。');
}
function validatePointPartIds(m:Record<string,any>){
  if(m.pointPartIds===undefined)return;
  const ids=m.pointPartIds;
  if(m.kind==='surface-distance'||!Array.isArray(ids)||ids.length!==m.points?.length)throw new Error('工程逐点Part来源数量/类型无效，曲面路径仅使用单一Part。');
  for(let i=0;i<ids.length;i++)if(!Object.hasOwn(ids,i)||ids[i]!==null&&(typeof ids[i]!=='string'||!ids[i]||ids[i].length>256))throw new Error('工程逐点Part来源ID无效。');
  if(m.partId!==undefined&&ids.some(id=>id!==m.partId))throw new Error('工程单一Part摘要与逐点来源不一致。');
}
function validateLabelOffset(m:Record<string,any>){
  const offset=m.labelOffset;if(offset===undefined)return;
  if(m.kind==='annotation'||!Array.isArray(offset)||Object.getPrototypeOf(offset)!==Array.prototype||offset.length!==3||Reflect.ownKeys(offset).length!==4)throw new Error('工程测量标签偏移无效，仅非文字标注支持普通三维数组。');
  for(let i=0;i<3;i++){
    const descriptor=Object.getOwnPropertyDescriptor(offset,String(i));
    if(!descriptor||!('value' in descriptor)||!descriptor.enumerable||typeof descriptor.value!=='number'||!Number.isFinite(descriptor.value))throw new Error('工程测量标签偏移必须是三个有限数。');
  }
}
function validateMprMeasurement(m:Record<string,any>){
  if(m.densityPlane!==undefined){
    if(!['density-rectangle','density-ellipse'].includes(m.kind)||m.plane!==undefined||m.mprPlane!==undefined)throw new Error('独立密度平面仅用于密度 ROI，且不能与原始切片或 MPR 平面并存。');
    const plane=validateAffinePlane(m.densityPlane),corners=denseDataArray(m.points,2,'密度 ROI 角点').map(p=>denseDataArray(p,3,'密度 ROI 世界角点').map(n=>{if(typeof n!=='number'||!Number.isFinite(n))throw new Error('密度 ROI 角点必须是有限数。');return n;}) as Vec3),pixels=corners.map(p=>affinePlaneWorldToPixel(plane,p));
    if(pixels.some(p=>Math.abs(p.distance)>1e-5)||pixels[0]!.pixel.some((n,i)=>Math.abs(n-pixels[1]!.pixel[i]!)<=64*Number.EPSILON*Math.max(1,Math.abs(n),Math.abs(pixels[1]!.pixel[i]!))))throw new Error('密度 ROI 两个角点必须共面，且参数宽高不能为零。');
  }
  if(m.mprPlane===undefined)return;
  if(m.plane!==undefined)throw new Error('工程测量不能同时使用原始切片和MPR平面。');
  validateMprPlane(m.mprPlane);
}
function denseDataArray(value:unknown,length:number,label:string):unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==length||Reflect.ownKeys(value).length!==length+1)throw new Error(`${label}必须是无额外字段的普通稠密数组。`);
  return Array.from({length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!('value'in d))throw new Error(`${label}不接受稀疏数组或访问器。`);return d.value;});
}
function validateMprView(value:unknown):asserts value is ProjectMprViewState{
  assertKeys(value,'enabled plane step interpolation crosshair','MPR视图');
  if(typeof value.enabled!=='boolean'||typeof value.step!=='number'||!Number.isFinite(value.step)||value.step<=0||!['nearest','linear'].includes(value.interpolation))throw new Error('工程MPR视图显隐/步长/插值无效。');
  validateMprPlane(value.plane);
  if(value.crosshair!==undefined){
    const point=value.crosshair;
    if(!Array.isArray(point)||Object.getPrototypeOf(point)!==Array.prototype||point.length!==3||Reflect.ownKeys(point).length!==4)throw new Error('工程MPR世界十字线必须是普通三维数组。');
    for(let i=0;i<3;i++){const descriptor=Object.getOwnPropertyDescriptor(point,String(i));if(!descriptor||!('value' in descriptor)||!descriptor.enumerable||typeof descriptor.value!=='number'||!Number.isFinite(descriptor.value))throw new Error('工程MPR世界十字线必须是三个有限数。');}
  }
}
function cloneViewState(view:ProjectViewState):ProjectViewState{
  return{...view,...(view.point?{point:[...view.point] as Vec3}:{}),...(view.window?{window:{...view.window}}:{}),...(view.mpr?{mpr:{...view.mpr,plane:validateMprPlane(view.mpr.plane),...(view.mpr.crosshair!==undefined?{crosshair:[...view.mpr.crosshair] as Vec3}:{})}}:{})};
}
export function validateResliceObject(value:unknown):asserts value is ReslicePlaneObject{
  assertKeys(value,'id name kind plane','重切片对象');
  if(typeof value.id!=='string'||!value.id||value.id.length>256||typeof value.name!=='string'||!value.name.trim()||value.name.length>512||value.kind!=='plane')throw new Error('工程重切片对象ID、名称或类型无效。');
  validateMprPlane(value.plane);
}
export function cloneResliceObject(object:ReslicePlaneObject):ReslicePlaneObject{
  validateResliceObject(object);return{id:object.id,name:object.name,kind:'plane',plane:validateMprPlane(object.plane)};
}
function assertProjectSchema(state:unknown,archive:boolean):asserts state is ProjectState{
  assertKeys(state,'name masks parts measurements selectedMaskId selectedPartId centerlines polylines selectedCenterlineId selectedPolylineId resliceObjects selectedResliceId resliceTransform viewState','对象目录');
  if(state.resliceTransform!==undefined&&(typeof state.resliceTransform!=='string'||!state.resliceTransform.trim()||state.resliceTransform.length>65536||strToU8(state.resliceTransform).byteLength>65536))throw new Error('工程重切片变换说明必须是1至65536字节的文本。');
  if(!Array.isArray(state.masks)||!Array.isArray(state.parts)||!Array.isArray(state.measurements))throw new Error('工程对象目录损坏。');
  for(const m of state.masks){assertKeys(m,`id name color visible opacity threshold revision sourcePartId ${archive?'path':'data'}`,'Mask');if(m.sourcePartId!==undefined&&(typeof m.sourcePartId!=='string'||!m.sourcePartId||m.sourcePartId.length>256))throw new Error('工程Mask来源Part ID无效。');}
  for(const p of state.parts){
    assertKeys(p,`id name color visible opacity sourceMaskId sourceRevision ${archive?'positions indices normals':'mesh'}`,'Part');
    if(!archive)assertKeys(p.mesh,'positions indices normals','网格');
  }
  for(const m of state.measurements){assertKeys(m,'id name kind points plane mprPlane densityPlane partId pointPartIds labelOffset controlPoints pathMethod text annotationStyle visible color','测量');if(m.plane!==undefined)assertKeys(m.plane,'axis index','测量平面');validateMprMeasurement(m);if(m.annotationStyle!==undefined)validateAnnotationStyle(m.annotationStyle,m.kind);validatePointPartIds(m);validateLabelOffset(m);}
  if(state.resliceObjects!==undefined&&!Array.isArray(state.resliceObjects))throw new Error('工程重切片对象目录无效。');
  for(const object of state.resliceObjects??[])validateResliceObject(object);
  if(state.selectedResliceId!==undefined&&(typeof state.selectedResliceId!=='string'||state.selectedResliceId.length>256||state.selectedResliceId&&!state.resliceObjects?.some((object:ReslicePlaneObject)=>object.id===state.selectedResliceId)))throw new Error('工程活动重切片对象引用无效。');
  for(const key of ['centerlines','polylines'] as const)if(state[key]!==undefined&&!Array.isArray(state[key]))throw new Error('工程中心线/Polyline目录无效。');
  for(const o of state.centerlines??[]){
    assertKeys(o,'id name color visible graph sourceMaskId sourceRevision sourcePartId','中心线');
    assertKeys(o.graph,'nodes branches branchSets rootNodeId coordinateSystem algorithm cyclePolicy warnings','中心线图');
    if(Array.isArray(o.graph.nodes))for(const node of o.graph.nodes)assertKeys(node,'id position kind','中心线节点');
    if(Array.isArray(o.graph.branches))for(const branch of o.graph.branches)assertKeys(branch,'id startNodeId endNodeId points radiiMm controlPointIndices','中心线分支');
    if(Array.isArray(o.graph.branchSets))for(const set of o.graph.branchSets)assertKeys(set,'id branchIds estimatedVolumeMm3','中心线分支集合');
  }
  for(const o of state.polylines??[]){
    assertKeys(o,'id name color visible set sourceMaskId sourceRevision','Polyline');
    if(isPhysicalContourSet(o.set)){const set=validatePhysicalContourSet(o.set),source=state.masks.find(mask=>mask.id===o.sourceMaskId);if(source&&set.layers.some(layer=>layer.sourceRevision!==undefined&&layer.sourceRevision>source.revision))throw new Error('工程物理 Polyline 层来源版本晚于现有来源。');continue;}
    assertKeys(o.set,'axis dims layers provenance','Polyline集合');
    if(Array.isArray(o.set.layers))for(const layer of o.set.layers){
      assertKeys(layer,'plane rings componentCount provenance','Polyline层');assertKeys(layer.plane,'axis index','Polyline平面');
      if(Array.isArray(layer.rings))for(const ring of layer.rings)assertKeys(ring,'points hole parent component signedArea areaMm2 perimeterMm','Polyline环');
    }
  }
  if(state.viewState!==undefined){assertKeys(state.viewState,'point window activeAxis renderMode tool selectedMeasurementId tab mpr','视图');if(state.viewState.window!==undefined)assertKeys(state.viewState.window,'center width','视图窗宽窗位');if(state.viewState.mpr!==undefined)validateMprView(state.viewState.mpr);}
  const allObjects=[...state.masks,...state.parts,...state.measurements,...(state.centerlines??[]),...(state.polylines??[]),...(state.resliceObjects??[])];
  if(new Set(allObjects.map(object=>object.id)).size!==allObjects.length)throw new Error('工程包含重复对象ID。');
  const allIds=new Set(allObjects.map(object=>object.id)),livePartIds=new Set(state.parts.map(part=>part.id)),liveMaskIds=new Set(state.masks.map(mask=>mask.id));
  const partReferences=[...state.masks.map(mask=>mask.sourcePartId),...state.measurements.flatMap(measurementPartIds),...(state.centerlines??[]).map((object:CenterlineObject)=>object.sourcePartId)];
  if(partReferences.some(id=>id!==undefined&&!livePartIds.has(id)&&allIds.has(id)))throw new Error('工程Part来源/逐点附件引用了其他类型对象。');
  const maskReferences=[...state.parts,...(state.centerlines??[]),...(state.polylines??[])].map(object=>object.sourceMaskId);
  if(maskReferences.some(id=>id!==undefined&&!liveMaskIds.has(id)&&allIds.has(id)))throw new Error('工程来源Mask引用了其他类型对象。');
}
/** Do not let JSON.stringify silently turn NaN, sparse arrays or unsupported objects into different data. */
function assertJSONMetadata(value:unknown,parents=new Set<object>()):void{
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
  if(!value||typeof value!=='object'||parents.has(value))throw new Error('工程元数据不是有限、无环的JSON数据。');
  parents.add(value);
  if(Array.isArray(value)){
    for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor)throw new Error('工程元数据包含稀疏数组。');if(!('value' in descriptor))throw new Error('工程元数据包含未支持的属性。');assertJSONMetadata(descriptor.value,parents);}
    if(Reflect.ownKeys(value).length!==value.length+1)throw new Error('工程元数据数组包含未支持字段。');
  }else{
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('工程元数据包含未支持的对象类型。');
    for(const key of Reflect.ownKeys(value)){
      if(typeof key!=='string')throw new Error('工程元数据包含未支持字段。');
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(!('value' in descriptor)||!descriptor.enumerable)throw new Error('工程元数据包含未支持的属性。');
      if(descriptor.value!==undefined)assertJSONMetadata(descriptor.value,parents);
    }
  }
  parents.delete(value);
}
/** Shared object validation for properties editing and project I/O; cross-object references are checked by validateProject. */
export function validateMeasurementObject(m:unknown,dims:Vec3):asserts m is MeasurementObject{
  assertKeys(m,'id name kind points plane mprPlane densityPlane partId pointPartIds labelOffset controlPoints pathMethod text annotationStyle visible color','测量');
  validateMprMeasurement(m);
  const kinds=new Set(['distance','angle','diameter','ellipse','area','density-rectangle','density-ellipse','annotation','surface-distance']);
  if(!kinds.has(m.kind)||!Array.isArray(m.points)||m.points.some((p:number[])=>!Array.isArray(p)||p.length!==3||p.some(x=>!Number.isFinite(x))))throw new Error('工程测量类型/坐标损坏。');
  const minimum=m.kind==='area'?3:m.kind==='annotation'?1:['angle','diameter','ellipse'].includes(m.kind)?3:2;
  if(m.points.length<minimum||!['area','surface-distance'].includes(m.kind)&&m.points.length!==minimum)throw new Error('工程测量控制点数量无效。');
  const identifier=(value:unknown,label:string)=>{if(typeof value!=='string'||!value||value.length>256)throw new Error(`工程${label}无效。`);};
  identifier(m.id,'Measurement ID');
  if(typeof m.name!=='string')throw new Error('工程测量名称无效。');
  if(typeof m.visible!=='boolean')throw new Error('工程测量显隐无效。');
  if(typeof m.color!=='string'||!/^#[0-9a-f]{6}$/i.test(m.color))throw new Error('工程对象颜色无效。');
  if(m.plane!==undefined){assertKeys(m.plane,'axis index','测量平面');if(![0,1,2].includes(m.plane.axis)||!Number.isSafeInteger(m.plane.index)||m.plane.index<0||m.plane.index>=dims[m.plane.axis])throw new Error('工程测量平面无效。');}
  validateMprMeasurement(m);
  if(m.partId!==undefined)identifier(m.partId,'测量附件ID');
  validatePointPartIds(m);
  validateLabelOffset(m);
  if(m.text!==undefined&&typeof m.text!=='string')throw new Error('工程标注文字无效。');
  if(m.controlPoints!==undefined&&(!Array.isArray(m.controlPoints)||m.controlPoints.length<2||m.controlPoints.some((p:unknown)=>!Array.isArray(p)||p.length!==3||p.some(n=>!Number.isFinite(n)))))throw new Error('工程曲面测量约束点无效。');
  if(m.pathMethod!==undefined&&(m.kind!=='surface-distance'||m.pathMethod!=='edge-graph'))throw new Error('工程曲面测量路径方法无效。');
  if(m.annotationStyle!==undefined)validateAnnotationStyle(m.annotationStyle,m.kind);
  assertJSONMetadata(m);
}
export interface HistoryEntry {name:string; before:ProjectState; after:ProjectState; bytes:number}
const colors=['#48d7ae','#ffb35c','#8daaff','#ed83c6','#e8d76a','#82d7ef'];
let counter=0;
export function objectId(prefix:string){return `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;}
function maskLength(length:number){checkedVoxelLength(length,'Mask');}
function binaryMask(data:BinaryMask,length:number){if(!(data instanceof Uint8Array)||data.length!==length)throw new Error('Mask尺寸或存储类型不一致。');if(data.some(n=>n!==0&&n!==1))throw new Error('Mask必须是独立二值成员数据。');}
function thresholdRange(threshold:[number,number]|null){if(threshold!==null&&(!Array.isArray(threshold)||threshold.length!==2||!threshold.every(Number.isFinite)||!Object.hasOwn(threshold,0)||!Object.hasOwn(threshold,1)||threshold[0]>threshold[1]))throw new Error('Mask阈值范围无效。');}
function validMesh(mesh:TriangleMesh){
  assertKeys(mesh,'positions indices normals','网格');
  if(!(mesh.positions instanceof Float32Array)||!(mesh.indices instanceof Uint32Array)||mesh.normals!==undefined&&!(mesh.normals instanceof Float32Array))throw new Error('工程网格存储类型无效。');
  if(mesh.positions.length%3||mesh.indices.length%3||mesh.positions.some(n=>!Number.isFinite(n))||mesh.indices.some(n=>n>=mesh.positions.length/3)||mesh.normals!==undefined&&(mesh.normals.length!==mesh.positions.length||mesh.normals.some(n=>!Number.isFinite(n))))throw new Error('工程网格损坏。');
}
/** A completed algorithm result is already owned by the new immutable state.
 * Adopt it directly instead of briefly allocating another volume-sized mask.
 * As with replaceMask, later edits must publish a new buffer, never mutate it. */
export function makeMask(length:number, name='Mask 1', color=colors[0],data?:BinaryMask):MaskObject {
  maskLength(length);if(typeof name!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw new Error('Mask名称或颜色无效。');
  if(data!==undefined)binaryMask(data,length);
  return {id:objectId('mask'),name,color,visible:true,opacity:.45,data:data??new Uint8Array(length),threshold:null,revision:0};
}
export function createProject(volume:Volume):ProjectState {
  const mask=makeMask(volume.data.length);
  return {name:volume.name.replace(/\.nii(\.gz)?$/i,''),masks:[mask],parts:[],measurements:[],selectedMaskId:mask.id,selectedPartId:''};
}
export function volumeGrid(volume:Volume):VolumeGrid {
  // core.Volume preserves native NIfTI affine units for round-trip export.
  const unit=volume.header[123]!&7, scale=unit===1?1000:unit===3?.001:1;
  return {dims:volume.dims,spacing:volume.spacing,data:volume.data,affine:volume.affine.map(row=>row.map(v=>v*scale))};
}
export class ProjectHistory {
  past:HistoryEntry[]=[]; future:HistoryEntry[]=[];
  maxBytes:number;
  maxEntries:number;
  private current:ProjectState|undefined;
  private metadataSizes=new WeakMap<ProjectState,number>();
  /** Budget counts retained typed-array backing stores plus serialized metadata estimates, not the live state. Voxel/mesh buffers are immutable. */
  constructor(maxBytes=256*1024*1024,maxEntries=1000){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.checkBudget();}
  private checkBudget(){if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<0||!Number.isSafeInteger(this.maxEntries)||this.maxEntries<0)throw new Error('撤销内存预算无效。');}
  get bytesUsed(){const result=this.measure(this.past,this.future,this.current);for(const [entry,bytes]of result.entries)entry.bytes=bytes;return result.total;}
  private measure(past:HistoryEntry[],future:HistoryEntry[],current:ProjectState|undefined){
    const seen=new Set<ArrayBufferLike>(),states=new Set<ProjectState>(),entries=new Map<HistoryEntry,number>();let total=0;if(current)states.add(current);
    if(current)for(const buffer of stateBuffers(current))seen.add(buffer);
    for(const entry of [...past,...future]){
      let bytes=0;
      for(const state of [entry.before,entry.after]){
        if(!states.has(state)){
          states.add(state);let size=this.metadataSizes.get(state);
          if(size===undefined){size=strToU8(JSON.stringify({...state,masks:state.masks.map(m=>({...m,data:undefined})),parts:state.parts.map(p=>({...p,mesh:undefined}))})).byteLength;this.metadataSizes.set(state,size);}
          bytes+=size;
        }
        for(const buffer of stateBuffers(state))if(!seen.has(buffer)){seen.add(buffer);bytes+=buffer.byteLength;}
      }
      entries.set(entry,bytes);total+=bytes;
    }
    return{entries,total};
  }
  private prepare(past:HistoryEntry[],future:HistoryEntry[],current:ProjectState){
    // Snapshot, budget and prune candidates before publishing stacks or entry accounting.
    while(past.length+future.length>this.maxEntries){if(past.length)past.shift();else future.shift();}
    let size=this.measure(past,future,current);
    while(size.total>this.maxBytes){if(past.length)past.shift();else if(future.length)future.shift();else break;size=this.measure(past,future,current);}
    return{past,future,current,entries:size.entries};
  }
  private publish(prepared:ReturnType<ProjectHistory['prepare']>){
    for(const [entry,bytes]of prepared.entries)entry.bytes=bytes;
    this.past=prepared.past;this.future=prepared.future;this.current=prepared.current;
  }
  push(name:string,before:ProjectState,after:ProjectState){
    this.checkBudget();
    if(typeof name!=='string')throw new Error('撤销事务名称无效。');
    const previous=snapshotState(before),next=snapshotState(after);
    this.publish(this.prepare([...this.past,{name,before:previous,after:next,bytes:0}],[],next));
  }
  undo(){this.checkBudget();const e=this.past.at(-1);if(!e)return;const snapshot=snapshotState(e.before),prepared=this.prepare(this.past.slice(0,-1),[...this.future,e],e.before);this.publish(prepared);return snapshot;}
  redo(){this.checkBudget();const e=this.future.at(-1);if(!e)return;const snapshot=snapshotState(e.after),prepared=this.prepare([...this.past,e],this.future.slice(0,-1),e.after);this.publish(prepared);return snapshot;}
  clear(){this.past=[];this.future=[];this.current=undefined;}
}
function stateBuffers(state:ProjectState):ArrayBufferLike[]{
  return [...state.masks.map(m=>m.data.buffer),...state.parts.flatMap(p=>[p.mesh.positions.buffer,p.mesh.indices.buffer,...(p.mesh.normals?[p.mesh.normals.buffer]:[])])];
}
function snapshotState(state:ProjectState):ProjectState{
  // Snapshot/serialization failures must happen before a transaction changes either stack.
  assertProjectSchema(state,false);
  assertJSONMetadata({...state,masks:state.masks.map(({data,...m})=>m),parts:state.parts.map(({mesh,...p})=>p)});
  return {...state,masks:state.masks.map(m=>({...m,threshold:m.threshold?[...m.threshold] as [number,number]:null})),parts:state.parts.map(p=>({...p,mesh:{...p.mesh}})),measurements:state.measurements.map(m=>({...m,points:m.points.map(p=>[...p] as Vec3),...(m.pointPartIds!==undefined?{pointPartIds:[...m.pointPartIds]}:{}),...(m.labelOffset!==undefined?{labelOffset:[...m.labelOffset] as Vec3}:{}),...(m.controlPoints?{controlPoints:m.controlPoints.map(p=>[...p] as Vec3)}:{}),...(m.plane?{plane:{...m.plane}}:{}),...(m.mprPlane!==undefined?{mprPlane:validateMprPlane(m.mprPlane)}:{}),...(m.densityPlane!==undefined?{densityPlane:validateAffinePlane(m.densityPlane)}:{}),...(m.annotationStyle?{annotationStyle:{...m.annotationStyle}}:{})})),...(state.centerlines?{centerlines:structuredClone(state.centerlines)}:{}),...(state.polylines?{polylines:structuredClone(state.polylines)}:{}),...(state.resliceObjects?{resliceObjects:state.resliceObjects.map(cloneResliceObject)}:{}),...(state.viewState?{viewState:cloneViewState(state.viewState)}:{})};
}
export function replaceMask(state:ProjectState,id:string,data:BinaryMask,threshold?:[number,number]|null):ProjectState {
  const found=state.masks.find(m=>m.id===id);if(!found)throw new Error('目标Mask已不存在。');
  binaryMask(data,found.data.length);if(threshold!==undefined)thresholdRange(threshold);
  if(!Number.isSafeInteger(found.revision)||found.revision<0||found.revision===Number.MAX_SAFE_INTEGER)throw new Error('Mask版本无效或已超过安全整数范围。');
  return {...state,masks:state.masks.map(m=>m.id===id?{...m,data,revision:m.revision+1,threshold:threshold===undefined?m.threshold:threshold}:m)};
}
export function addMask(state:ProjectState,length:number,name?:string,data?:BinaryMask,source?:PartObject):ProjectState {
  maskLength(length);if(state.masks.some(m=>m.data.length!==length))throw new Error('Mask尺寸不一致。');
  if(source!==undefined&&(!source||!state.parts.some(part=>part.id===source.id&&part.mesh===source.mesh)))throw new Error('来源Part或其几何已不存在。');
  const mask=makeMask(length,name||`Mask ${state.masks.length+1}`,colors[state.masks.length%colors.length],data);
  if(source)mask.sourcePartId=source.id;
  return {...state,masks:[...state.masks,mask],selectedMaskId:mask.id};
}
export function addPart(state:ProjectState,mesh:TriangleMesh,source?:MaskObject):ProjectState {
  validMesh(mesh);
  if(source&&!state.masks.some(m=>m.id===source.id&&m.revision===source.revision))throw new Error('来源Mask或版本已不存在。');
  const part:PartObject={id:objectId('part'),name:`${source?.name||'Part'} 3D ${state.parts.length+1}`,color:source?.color||'#8daaff',opacity:1,visible:true,mesh,sourceMaskId:source?.id,sourceRevision:source?.revision};
  return {...state,parts:[...state.parts,part],selectedPartId:part.id};
}
function numericBytes(a:Float32Array|Uint32Array){if(NATIVE_LITTLE_ENDIAN)return new Uint8Array(a.buffer,a.byteOffset,a.byteLength);const out=new Uint8Array(a.length*4),view=new DataView(out.buffer);for(let i=0;i<a.length;i++)if(a instanceof Float32Array)view.setFloat32(i*4,a[i]!,true);else view.setUint32(i*4,a[i]!,true);return out;}
type NumericArrays=Record<string,Float32Array|Uint32Array>;
function projectArchive(volume:Volume,state:ProjectState,encodeNumbers:boolean){
  assertKeys(volume,'name dims spacing data header little min max affine oblique unit dicom niftiReference','影像');
  if(volume.niftiReference!==undefined)validateNiftiReference(volume.niftiReference);
  assertProjectSchema(state,false);
  if(!(volume.data instanceof Float32Array)||!(volume.header instanceof Uint8Array))throw new Error('工程影像存储类型无效。');
  const arrays:NumericArrays={};
  const files:Record<string,Uint8Array>={'image/header.bin':volume.header};
  if(state.resliceTransform!==undefined)files['reslice-transform.txt']=strToU8(state.resliceTransform);
  function numeric(path:string,data:Float32Array|Uint32Array){arrays[path]=data;files[path]=encodeNumbers?numericBytes(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);return path;}
  numeric('image/values.f32',volume.data);
  const masks=state.masks.map((m,i)=>{const {data,...descriptor}=m;if(!(data instanceof Uint8Array))throw new Error('工程Mask存储类型无效。');const path=`masks/${i}.u8`;files[path]=data;return {...descriptor,path};});
  const parts=state.parts.map((p,i)=>{
    const {mesh,...descriptor}=p;
    if(!(mesh.positions instanceof Float32Array)||!(mesh.indices instanceof Uint32Array)||mesh.normals!==undefined&&!(mesh.normals instanceof Float32Array))throw new Error('工程网格存储类型无效。');
    const positions=numeric(`parts/${i}.positions.f32`,mesh.positions),indices=numeric(`parts/${i}.indices.u32`,mesh.indices);
    const normals=mesh.normals?numeric(`parts/${i}.normals.f32`,mesh.normals):undefined;
    return {...descriptor,positions,indices,...(normals!==undefined?{normals}:{})};
  });
  const {data:_data,header:_header,...descriptor}=volume;
  const metadata={format:'deepmark-mimics-workbench',version:1,endianness:'little',volume:descriptor,project:{...state,masks,parts}};
  return {files,metadata,arrays};
}
/** Validate trusted in-memory/IndexedDB input with exactly the ZIP restore rules, without compression or image copies. */
export function validateProject(volume:Volume,state:ProjectState):void {
  const {files,metadata,arrays}=projectArchive(volume,state,false);
  restoreProject(metadata,files,arrays);
  const descriptor=projectDescriptor(metadata),entries=Object.values(files);
  if(entries.length+1>10000||entries.some(file=>file.byteLength>MAX_ZIP32_BYTES)||entries.reduce((sum,file)=>sum+file.byteLength,descriptor.byteLength)>MAX_ZIP32_BYTES)throw new Error('工程数据超过默认工程资源预算。');
}
function projectDescriptor(metadata:unknown){
  assertJSONMetadata(metadata);
  const descriptor=strToU8(JSON.stringify(metadata));
  if(descriptor.byteLength>8*1024*1024)throw new Error('工程对象元数据超过当前8 MiB预算，请减少控制点或拆分工程。');
  return descriptor;
}
export function encodeProject(volume:Volume,state:ProjectState):Uint8Array {
  // Validate before allocating endian-converted copies of large image/mesh buffers.
  validateProject(volume,state);
  const {files,metadata}=projectArchive(volume,state,true);
  files['project.json']=projectDescriptor(metadata);
  const archive=zipSync(files,{level:1});if(archive.byteLength>MAX_ZIP32_BYTES)throw new Error('工程压缩包超过默认内存限制。');return archive;
}
export interface ProjectDecodeLimits {maxArchiveBytes?:number;maxUncompressedBytes?:number;maxEntryBytes?:number;maxFiles?:number}
function validateContourSet(set:any,grid:VolumeGrid):asserts set is ContourSet{
  if(!set||set.provenance!==CONTOUR_PROVENANCE||![0,1,2].includes(set.axis)||!Array.isArray(set.dims)||set.dims.length!==3||set.dims.some((n:unknown,a:number)=>n!==grid.dims[a])||!Array.isArray(set.layers))throw new Error('工程Polyline尺寸/轴向/来源无效。');
  const axes=[0,1,2].filter(a=>a!==set.axis),origin=physicalPoint([0,0,0],grid),basis=axes.map(a=>{const p:Vec3=[0,0,0];p[a]=1;return physicalPoint(p,grid).map((n,r)=>n-origin[r]!);}),[u,v]=basis;
  const areaScale=Math.hypot(u![1]!*v![2]!-u![2]!*v![1]!,u![2]!*v![0]!-u![0]!*v![2]!,u![0]!*v![1]!-u![1]!*v![0]!);const close=(a:number,b:number)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b)),layers=new Set<number>();
  const contains=(points:number[][],p:number[])=>{let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j]!,b=points[i]!;if((a[1]!>p[1]!)!==(b[1]!>p[1]!)&&p[0]!<(b[0]!-a[0]!)*(p[1]!-a[1]!)/(b[1]!-a[1]!)+a[0]!)inside=!inside;}return inside;};
  for(const layer of set.layers){
    if(!layer||layer.provenance!==CONTOUR_PROVENANCE||!layer.plane||layer.plane.axis!==set.axis||!Number.isSafeInteger(layer.plane.index)||layer.plane.index<0||layer.plane.index>=grid.dims[set.axis]!||layers.has(layer.plane.index)||!Array.isArray(layer.rings)||!Number.isSafeInteger(layer.componentCount)||layer.componentCount<0)throw new Error('工程Polyline切片/分量无效。');layers.add(layer.plane.index);
    const components=new Set<number>();
    for(let r=0;r<layer.rings.length;r++){const ring=layer.rings[r];
      if(!ring||!Array.isArray(ring.points)||ring.points.length<3||ring.points.some((p:unknown)=>!Array.isArray(p)||p.length!==2||p.some((n:unknown,a:number)=>typeof n!=='number'||!Number.isFinite(n)||n<-.5-1e-8||n>grid.dims[axes[a]!]!-.5+1e-8))||typeof ring.hole!=='boolean'||!Number.isSafeInteger(ring.component)||ring.component<0||ring.component>=layer.componentCount||ring.parent!==null&&(!Number.isSafeInteger(ring.parent)||ring.parent<0||ring.parent>=layer.rings.length||ring.parent===r)||![ring.signedArea,ring.areaMm2,ring.perimeterMm].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)))throw new Error('工程Polyline环/坐标/parent无效。');
      components.add(ring.component);let twice=0,perimeter=0;ring.points.forEach((a:number[],i:number)=>{const b=ring.points[(i+1)%ring.points.length],dx=b[0]-a[0]!,dy=b[1]-a[1]!;if(Math.hypot(dx,dy)<1e-10)throw new Error('工程Polyline包含重复相邻点。');twice+=a[0]!*b[1]-a[1]!*b[0];perimeter+=Math.hypot(...u!.map((n,k)=>n*dx+v![k]!*dy));});
      if(!twice||!close(ring.signedArea,twice/2)||!close(ring.areaMm2,Math.abs(twice/2)*areaScale)||!close(ring.perimeterMm,perimeter)||ring.areaMm2<=0||ring.perimeterMm<=0)throw new Error('工程Polyline面积/周长与坐标不一致。');
    }
    if(components.size!==layer.componentCount)throw new Error('工程Polyline分量目录不一致。');
    for(let r=0;r<layer.rings.length;r++){const ring=layer.rings[r];let current=ring.parent,depth=0;const seen=new Set<number>([r]);while(current!==null){if(seen.has(current))throw new Error('工程Polyline parent关系存在环。');seen.add(current);const parent=layer.rings[current];if(!parent||Math.abs(parent.signedArea)<=Math.abs(ring.signedArea))throw new Error('工程Polyline parent包围关系无效。');depth++;current=parent.parent;}
      if(ring.hole!==(depth%2===1)||(ring.signedArea<0)!==ring.hole)throw new Error('工程Polyline洞/方向与parent不一致。');
      if(ring.parent!==null){const parent=layer.rings[ring.parent],a=ring.points[0],b=ring.points[1],dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy),sign=Math.sign(ring.signedArea),probe=[(a[0]+b[0])/2-sign*dy/d*1e-4,(a[1]+b[1])/2+sign*dx/d*1e-4];if(!contains(parent.points,probe))throw new Error('工程Polyline parent不包含子轮廓。');}
    }
  }
}
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let bit=0;bit<8;bit++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
/** fflate inflation alone does not verify ZIP CRCs. Validate every central-directory record before accepting a project. */
function verifyZipChecksums(bytes:Uint8Array,files:Record<string,Uint8Array>){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let footer=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(view.getUint32(p,true)===0x06054b50&&p+22+view.getUint16(p+20,true)===bytes.length){footer=p;break;}
  if(footer<0||view.getUint16(footer+4,true)!==0||view.getUint16(footer+6,true)!==0||view.getUint16(footer+8,true)!==view.getUint16(footer+10,true))throw new Error('工程ZIP目录损坏或分卷不受支持。');
  const count=view.getUint16(footer+10,true),directorySize=view.getUint32(footer+12,true),start=view.getUint32(footer+16,true);
  if(count===0xffff||start===0xffffffff||directorySize===0xffffffff||start+directorySize>footer)throw new Error('工程ZIP64或目录布局不受支持。');
  let position=start;const seen=new Set<string>();
  for(let i=0;i<count;i++){
    if(position+46>footer||view.getUint32(position,true)!==0x02014b50)throw new Error('工程ZIP目录损坏。');
    const nameLength=view.getUint16(position+28,true),extraLength=view.getUint16(position+30,true),commentLength=view.getUint16(position+32,true),end=position+46+nameLength+extraLength+commentLength;
    if(end>start+directorySize)throw new Error('工程ZIP文件目录被截断。');
    const name=strFromU8(bytes.subarray(position+46,position+46+nameLength)),data=files[name];
    if(!data||seen.has(name)||data.byteLength!==view.getUint32(position+24,true))throw new Error('工程ZIP数据长度或路径损坏。');seen.add(name);
    let crc=0xffffffff;for(const value of data)crc=crcTable[(crc^value)&255]!^(crc>>>8);
    if(((crc^0xffffffff)>>>0)!==view.getUint32(position+16,true))throw new Error(`工程ZIP校验失败：${name}`);
    position=end;
  }
  if(position!==start+directorySize||seen.size!==Object.keys(files).length)throw new Error('工程ZIP对象目录不一致。');
}
export function decodeProject(bytes:Uint8Array,limits:ProjectDecodeLimits={}):{volume:Volume;state:ProjectState}{
  const archiveLimit=limits.maxArchiveBytes??MAX_ZIP32_BYTES,totalLimit=limits.maxUncompressedBytes??MAX_ZIP32_BYTES,entryLimit=limits.maxEntryBytes??MAX_ZIP32_BYTES,fileLimit=limits.maxFiles??10000;
  if([archiveLimit,totalLimit,entryLimit,fileLimit].some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('工程资源限制无效。');
  if(bytes.byteLength>archiveLimit)throw new Error('工程压缩包超过内存限制。');
  let declaredTotal=0;const paths=new Set<string>();
  const files=unzipSync(bytes,{filter:file=>{
    if(paths.has(file.name)||file.name.startsWith('/')||file.name.includes('\\')||file.name.split('/').some(p=>p==='..')||file.name.includes(':'))throw new Error('工程包含重复或无效数据路径。');
    paths.add(file.name);declaredTotal+=file.originalSize;
    if(paths.size>fileLimit||!Number.isSafeInteger(file.originalSize)||file.originalSize<0||file.originalSize>entryLimit||declaredTotal>totalLimit||file.name==='project.json'&&file.originalSize>8*1024*1024)throw new Error('工程解压数据超过内存限制。');
    return true;
  }});verifyZipChecksums(bytes,files);const descriptor=files['project.json'];
  if(!descriptor)throw new Error('工程缺少project.json。');
  let meta:any;try{meta=JSON.parse(strFromU8(descriptor));}catch{throw new Error('工程project.json内容损坏。');}
  return restoreProject(meta,files);
}
function restoreProject(meta:any,files:Record<string,Uint8Array>,arrays?:NumericArrays):{volume:Volume;state:ProjectState}{
  if(!meta||typeof meta!=='object')throw new Error('工程project.json对象无效。');
  if(meta.format!=='deepmark-mimics-workbench'||meta.version!==1||meta.endianness!=='little')throw new Error('不支持此工程格式或版本。');
  assertKeys(meta,'format version endianness volume project','project.json');
  assertKeys(meta.volume,'name dims spacing little min max affine oblique unit dicom niftiReference','影像');
  assertProjectSchema(meta.project,true);
  const vm=meta.volume,dims=vm?.dims;
  if(!Array.isArray(dims)||dims.length!==3||dims.some((n:unknown)=>!Number.isSafeInteger(n)||Number(n)<=0))throw new Error('工程影像尺寸无效。');
  const n=checkedVoxelCount(dims,'工程影像');
  const referencedPaths=new Set<string>(['project.json']);
  function file(path:string,size?:number){const b=files[path];if(!b||size!==undefined&&b.byteLength!==size)throw new Error(`工程数据损坏：${path}`);referencedPaths.add(path);return b;}
  function take(path:string,size?:number){return file(path,size).slice().buffer as ArrayBuffer;}
  if(meta.project.resliceTransform!==undefined){const expected=strToU8(meta.project.resliceTransform),stored=file('reslice-transform.txt',expected.byteLength);if(stored.some((value,i)=>value!==expected[i]))throw new Error('工程重切片变换文本与元数据不一致。');}
  function floats(path:string,size?:number){
    const original=arrays?.[path];
    if(original){file(path,size);if(!(original instanceof Float32Array)||original.some(n=>!Number.isFinite(n)))throw new Error(`工程包含非有限数值：${path}`);return original;}
    const bytes=file(path,size);if(NATIVE_LITTLE_ENDIAN&&bytes.byteOffset%4===0&&bytes.byteLength%4===0){const out=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);if(out.some(n=>!Number.isFinite(n)))throw new Error('工程包含非有限数值：'+path);return out;}const buffer=take(path,size);if(buffer.byteLength%4)throw new Error(`工程浮点数据长度损坏：${path}`);const view=new DataView(buffer),out=new Float32Array(buffer.byteLength/4);for(let i=0;i<out.length;i++){out[i]=view.getFloat32(i*4,true);if(!Number.isFinite(out[i]))throw new Error(`工程包含非有限数值：${path}`);}return out;
  }
  function uints(path:string){const original=arrays?.[path];if(original){file(path);if(!(original instanceof Uint32Array))throw new Error('工程索引存储类型无效。');return original;}const bytes=file(path);if(NATIVE_LITTLE_ENDIAN&&bytes.byteOffset%4===0&&bytes.byteLength%4===0)return new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);const buffer=take(path);if(buffer.byteLength%4)throw new Error(`工程索引数据长度损坏：${path}`);const view=new DataView(buffer),out=new Uint32Array(buffer.byteLength/4);for(let i=0;i<out.length;i++)out[i]=view.getUint32(i*4,true);return out;}
  function string(value:unknown,label:string){if(typeof value!=='string')throw new Error(`工程${label}无效。`);return value;}
  function id(value:unknown,label:string){const result=string(value,label);if(!result||result.length>256)throw new Error(`工程${label}无效。`);return result;}
  function opacity(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw new Error('工程对象透明度无效。');return value;}
  function color(value:unknown){if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw new Error('工程对象颜色无效。');return value;}
  function bool(value:unknown,label:string){if(typeof value!=='boolean')throw new Error(`工程${label}无效。`);return value;}
  if(!Array.isArray(vm.spacing)||vm.spacing.length!==3||vm.spacing.some((x:number)=>!Number.isFinite(x)||x<=0)||!Array.isArray(vm.affine)||vm.affine.length!==3||vm.affine.some((r:number[])=>!Array.isArray(r)||r.length!==4||r.some(x=>!Number.isFinite(x))))throw new Error('工程物理坐标无效。');
  const data=floats('image/values.f32',n*4),header=new Uint8Array(take('image/header.bin',348)),little=bool(vm.little,'字节序'),h=new DataView(header.buffer);
  if(h.getInt32(0,little)!==348||dims.some((d:number,a:number)=>h.getInt16(42+a*2,little)!==d)||h.getInt16(40,little)<3||h.getInt16(40,little)>7)throw new Error('工程NIfTI头与影像尺寸不一致。');
  for(let a=4;a<=h.getInt16(40,little);a++)if(h.getInt16(40+a*2,little)!==1)throw new Error('工程包含尚未支持的时间/通道维度。');
  const originalOffset=h.getFloat32(108,little);if(!Number.isInteger(originalOffset)||originalOffset<352)throw new Error('工程NIfTI数据偏移无效。');
  // Parse a one-voxel header probe to reuse the canonical qform/sform/unit rules without allocating a second image.
  const probe=new ArrayBuffer(360),probeBytes=new Uint8Array(probe),ph=new DataView(probe);probeBytes.set(header);
  for(let a=1;a<8;a++)ph.setInt16(40+a*2,1,little);
  ph.setFloat32(108,352,little);
  const geometry=parseNifti(probe),close=(a:number,b:number)=>Math.abs(a-b)<=1e-5*Math.max(1,Math.abs(a),Math.abs(b));
  const reference=vm.niftiReference===undefined?undefined:validateNiftiReference(vm.niftiReference);
  if(vm.unit!==geometry.unit)throw new Error('工程单位与NIfTI头不一致。');
  if(!reference&&(vm.affine.some((row:number[],r:number)=>row.some((x,c)=>!close(x,geometry.affine[r]![c]!)))||vm.spacing.some((x:number,a:number)=>!close(x,geometry.spacing[a]!))))throw new Error('工程仿射/单位与NIfTI头不一致。');
  let min=Infinity,max=-Infinity;for(const value of data){min=Math.min(min,value);max=Math.max(max,value);}
  if(!Number.isFinite(vm.min)||!Number.isFinite(vm.max)||!close(vm.min,min)||!close(vm.max,max))throw new Error('工程灰度范围与数据不一致。');
  const volume:Volume={name:string(vm.name,'影像名称'),dims:dims as Vec3,spacing:[...vm.spacing] as Vec3,data,header,little,min,max,affine:vm.affine.map((row:number[])=>[...row]),oblique:bool(vm.oblique,'方向标记'),unit:vm.unit,...(reference?{niftiReference:reference}:{})};
  if(reference){validateReferenceHeader(volume,geometry);const app=applicationAffineMm(volume);if(volume.spacing.some((n,a)=>Math.abs(n-Math.hypot(...app.slice(0,3).map(row=>row[a]!)))>1e-8*Math.max(1,Math.abs(n))))throw new Error('工程应用间距与其仿射基底不一致。');if(volume.oblique!==affineIsOblique(app))throw new Error('工程应用方向标记与应用坐标不一致。');}
  else if(volume.oblique!==geometry.oblique)throw new Error('工程方向标记与NIfTI头不一致。');
  if(vm.dicom!==undefined){
    const d=vm.dicom;
    assertKeys(d,'modality intensityUnit photometricInterpretation displayInverted windowCenter windowWidth coordinateSystem','DICOM元数据');
    if(!d||!['CT','MR'].includes(d.modality)||!['HU','GV'].includes(d.intensityUnit)||!['MONOCHROME1','MONOCHROME2'].includes(d.photometricInterpretation)||!['RAS','reslice-local'].includes(d.coordinateSystem)||d.displayInverted!==(d.photometricInterpretation==='MONOCHROME1')||d.windowCenter!==undefined&&!Number.isFinite(d.windowCenter)||d.windowWidth!==undefined&&(!Number.isFinite(d.windowWidth)||d.windowWidth<=0))throw new Error('工程DICOM显示/定量元数据无效。');
    (volume as DicomVolume).dicom={modality:d.modality,intensityUnit:d.intensityUnit,photometricInterpretation:d.photometricInterpretation,displayInverted:d.displayInverted,coordinateSystem:d.coordinateSystem,windowCenter:d.windowCenter,windowWidth:d.windowWidth};
  }
  if(!meta.project||!Array.isArray(meta.project.masks)||!Array.isArray(meta.project.parts)||!Array.isArray(meta.project.measurements))throw new Error('工程对象目录损坏。');
  const masks:MaskObject[]=meta.project.masks.map((m:any,i:number)=>{
    if(!m||m.path!==`masks/${i}.u8`||!Number.isSafeInteger(m.revision)||m.revision<0||m.threshold!==null&&(!Array.isArray(m.threshold)||m.threshold.length!==2||!m.threshold.every(Number.isFinite)||m.threshold[0]>m.threshold[1]))throw new Error('工程Mask属性损坏。');
    const mask=arrays?file(m.path,n):new Uint8Array(take(m.path,n));if(mask.some(value=>value!==0&&value!==1))throw new Error('工程Mask不是独立二值成员数据。');
    return {id:id(m.id,'Mask ID'),name:string(m.name,'Mask名称'),color:color(m.color),visible:bool(m.visible,'Mask显隐'),opacity:opacity(m.opacity),threshold:m.threshold,revision:m.revision,data:mask,...(m.sourcePartId!==undefined?{sourcePartId:m.sourcePartId}:{})};
  });
  const parts:PartObject[]=meta.project.parts.map((p:any,i:number)=>{
    if(!p||p.positions!==`parts/${i}.positions.f32`||p.indices!==`parts/${i}.indices.u32`||p.normals!==undefined&&p.normals!==`parts/${i}.normals.f32`)throw new Error('工程网格路径损坏。');
    const positions=floats(p.positions),indices=uints(p.indices),normals=p.normals?floats(p.normals,positions.byteLength):undefined;
    if(positions.length%3||indices.length%3||indices.some(x=>x>=positions.length/3))throw new Error('工程网格损坏。');
    if(p.sourceMaskId!==undefined)id(p.sourceMaskId,'来源Mask ID');
    if(p.sourceRevision!==undefined&&(!Number.isSafeInteger(p.sourceRevision)||p.sourceRevision<0)||p.sourceRevision!==undefined&&p.sourceMaskId===undefined)throw new Error('工程来源Mask版本无效。');
    // A missing source is allowed as historical provenance after its mask has been deleted.
    return {id:id(p.id,'Part ID'),name:string(p.name,'Part名称'),color:color(p.color),visible:bool(p.visible,'Part显隐'),opacity:opacity(p.opacity),sourceMaskId:p.sourceMaskId,sourceRevision:p.sourceRevision,mesh:{positions,indices,...(normals?{normals}:{})}};
  });
  const measurements:MeasurementObject[]=meta.project.measurements.map((m:any)=>{
    validateMeasurementObject(m,dims as Vec3);
    // World points remain valid when an attached mesh has been deleted; retain the orphan reference explicitly.
    return {id:m.id,name:m.name,kind:m.kind,points:m.points,plane:m.plane,partId:m.partId,text:m.text,visible:m.visible,color:m.color,...(m.mprPlane!==undefined?{mprPlane:validateMprPlane(m.mprPlane)}:{}),...(m.densityPlane!==undefined?{densityPlane:validateAffinePlane(m.densityPlane)}:{}),...(m.pointPartIds!==undefined?{pointPartIds:[...m.pointPartIds]}:{}),...(m.labelOffset!==undefined?{labelOffset:[...m.labelOffset] as Vec3}:{}),...(m.controlPoints!==undefined?{controlPoints:m.controlPoints}:{}),...(m.pathMethod!==undefined?{pathMethod:m.pathMethod}:{}),...(m.annotationStyle!==undefined?{annotationStyle:{...m.annotationStyle}}:{})};
  });
  function sourceReference(value:any){if(value.sourceMaskId!==undefined)id(value.sourceMaskId,'来源Mask ID');if(value.sourceRevision!==undefined&&(!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<0||value.sourceMaskId===undefined))throw new Error('工程来源Mask版本无效。');return {...(value.sourceMaskId!==undefined?{sourceMaskId:value.sourceMaskId}:{}),...(value.sourceRevision!==undefined?{sourceRevision:value.sourceRevision}:{})};}
  if(meta.project.centerlines!==undefined&&!Array.isArray(meta.project.centerlines)||meta.project.polylines!==undefined&&!Array.isArray(meta.project.polylines))throw new Error('工程中心线/Polyline目录无效。');
  const centerlines:CenterlineObject[]|undefined=meta.project.centerlines?.map((o:any)=>{
    if(!o||!o.graph)throw new Error('工程中心线对象损坏。');validateCenterline(o.graph);if(o.sourcePartId!==undefined)id(o.sourcePartId,'来源Part ID');return {id:id(o.id,'Centerline ID'),name:string(o.name,'Centerline名称'),color:color(o.color),visible:bool(o.visible,'Centerline显隐'),graph:o.graph,...sourceReference(o),...(o.sourcePartId!==undefined?{sourcePartId:o.sourcePartId}:{})};
  });
  const polylines:PolylineObject[]|undefined=meta.project.polylines?.map((o:any)=>{
    if(!o||!o.set)throw new Error('工程Polyline对象损坏。');let set:ContourSet|PhysicalContourSet;if(isPhysicalContourSet(o.set))set=validatePhysicalContourSet(o.set);else{validateContourSet(o.set,volumeGrid(volume));set=o.set;}return {id:id(o.id,'Polyline ID'),name:string(o.name,'Polyline名称'),color:color(o.color),visible:bool(o.visible,'Polyline显隐'),set,...sourceReference(o)};
  });
  const selectedCenterlineId=meta.project.selectedCenterlineId===undefined?undefined:string(meta.project.selectedCenterlineId,'活动Centerline ID'),selectedPolylineId=meta.project.selectedPolylineId===undefined?undefined:string(meta.project.selectedPolylineId,'活动Polyline ID');
  if(selectedCenterlineId&&!centerlines?.some(o=>o.id===selectedCenterlineId)||selectedPolylineId&&!polylines?.some(o=>o.id===selectedPolylineId))throw new Error('工程活动中心线/Polyline引用无效。');
  const resliceObjects:ReslicePlaneObject[]|undefined=meta.project.resliceObjects?.map(cloneResliceObject),selectedResliceId:string|undefined=meta.project.selectedResliceId;
  const allIDs=[...masks,...parts,...measurements,...(centerlines??[]),...(polylines??[]),...(resliceObjects??[])].map(o=>o.id);if(new Set(allIDs).size!==allIDs.length)throw new Error('工程包含重复对象ID。');
  const selectedMaskId=string(meta.project.selectedMaskId,'活动Mask ID'),selectedPartId=string(meta.project.selectedPartId,'活动Part ID');
  if(selectedMaskId&&!masks.some(m=>m.id===selectedMaskId)||selectedPartId&&!parts.some(p=>p.id===selectedPartId))throw new Error('工程活动对象引用无效。');
  for(const object of [...parts,...(centerlines??[]),...(polylines??[])]){
    const source=masks.find(m=>m.id===object.sourceMaskId);
    if(object.sourceMaskId!==undefined&&!source&&allIDs.includes(object.sourceMaskId))throw new Error('工程来源Mask引用了其他类型对象。');
    if(source&&object.sourceRevision!==undefined&&object.sourceRevision>source.revision)throw new Error('工程来源Mask版本晚于现有来源。');
  }
  for(const reference of [...masks.map(m=>m.sourcePartId),...measurements.flatMap(measurementPartIds),...(centerlines??[]).map(c=>c.sourcePartId)])if(reference!==undefined&&!parts.some(p=>p.id===reference)&&allIDs.includes(reference))throw new Error('工程Part来源/附件引用了其他类型对象。');
  const viewState:ProjectViewState|undefined=meta.project.viewState;
  if(viewState!==undefined){
    if(viewState.point!==undefined&&(!Array.isArray(viewState.point)||viewState.point.length!==3||viewState.point.some((x,a)=>!Number.isSafeInteger(x)||x<0||x>=dims[a])))throw new Error('工程视图定位点无效。');
    if(viewState.window!==undefined&&(!Number.isFinite(viewState.window.center)||!Number.isFinite(viewState.window.width)||viewState.window.width<=0))throw new Error('工程视图窗宽窗位无效。');
    if(viewState.activeAxis!==undefined&&![0,1,2].includes(viewState.activeAxis))throw new Error('工程视图活动轴无效。');
    if(viewState.renderMode!==undefined&&!['parts','volume'].includes(viewState.renderMode))throw new Error('工程视图渲染模式无效。');
    if(viewState.tab!==undefined&&!['segmentation','surface','measurements','analysis'].includes(viewState.tab))throw new Error('工程视图标签页无效。');
    const tools=['navigate','threshold','region','dynamic','paint','erase','local-threshold','lasso','livewire','multiple','boolean','morphology','cavity','fill','largest','smartExpand','crop','distance','angle','diameter','ellipse','area','density-rectangle','density-ellipse','annotation','surface-distance','select','deselect','centerline'];
    if(viewState.tool!==undefined&&!tools.includes(viewState.tool))throw new Error('工程视图工具无效。');
    if(viewState.selectedMeasurementId!==undefined){string(viewState.selectedMeasurementId,'视图活动测量ID');if(viewState.selectedMeasurementId&&!measurements.some(m=>m.id===viewState.selectedMeasurementId))throw new Error('工程视图活动测量引用无效。');}
  }
  for(const path of Object.keys(files))if(!referencedPaths.has(path))throw new Error(`工程包含未支持的数据条目：${path}。`);
  return {volume,state:{name:string(meta.project.name,'名称'),masks,parts,measurements,selectedMaskId,selectedPartId,...(centerlines?{centerlines}:{}),...(polylines?{polylines}:{}),...(selectedCenterlineId!==undefined?{selectedCenterlineId}:{}),...(selectedPolylineId!==undefined?{selectedPolylineId}:{}),...(resliceObjects!==undefined?{resliceObjects}:{}),...(selectedResliceId!==undefined?{selectedResliceId}:{}),...(meta.project.resliceTransform!==undefined?{resliceTransform:meta.project.resliceTransform}:{}),...(viewState!==undefined?{viewState:cloneViewState(viewState)}:{})}};
}
