<script setup lang="ts">
import {computed,ref,shallowRef,watch,onMounted,onBeforeUnmount} from 'vue';
import type {Volume} from '../core.ts';
import {physicalPoint,type BinaryMask,type Vec3,type MprPlane,type AffinePlane,type VolumeGrid,type MaskObject,type MeasurementObject} from './types.ts';
import {worldToVoxel,evaluateMeasurement,type EvaluationKind} from './measurements.ts';
import {validateMprPlane,mprPixelToWorld,mprWorldToPixel,mprPlaneNormal} from './mpr.ts';
import {coplanarMprPlanes,sameMprOrientation} from './useMprView.ts';
import {interactiveMprAxes,translateMpr,rotateMpr} from './mprInteraction.ts';
import {useMprSampling} from './useMprSampling.ts';
import {normalizeBrushSize,resizeBrushFromDrag,MAX_BRUSH_STROKE_SAMPLES,type BrushSize} from './viewportGeometry.ts';
import {mprBrushPreviewIndices,nextMprBrushStrokeId} from './mprBrushPreview.ts';
import {nextMprContourSessionId,type MprContourEpoch,type MprContourDraft} from './mprContourSession.ts';
import {resliceProjectReferenceLines} from './resliceProjectOverlay.ts';
import type {WorldReferenceLine,ResliceProjectPoint} from './resliceProjectTypes.ts';
import {validateAffinePlane,coplanarAffinePlanes} from './affinePlane.ts';
import {affineDensityROI,editAffineDensityROI,hitAffineDensityROI} from './affineDensityROI.ts';
import {ellipseFrame,ellipseHandles,moveEllipse,resizeEllipse,rotateEllipse,measurementLabelPosition} from './ellipseGeometry.ts';
import {annotationLayout,annotationLabelHit,paintCanvasAnnotation,allowsMeasurementLabels} from './annotationLayout.ts';
import {isDensityROI,normalizeDensityROI,defaultDensityROI,densityROIFromDrag,moveDensityROI,resizeDensityROI,densityROIHasArea,densityROIOutline,densityROIMarkers,type DensityROIKind,type DensityROIPoints,type DensityROIHandle} from './roiGeometry.ts';

const props=defineProps<{
  volume:Volume;grid:VolumeGrid;plane:MprPlane;viewId?:number;mprRevision?:number;step:number;interpolation?:'linear'|'nearest';revision:number;
  point:Vec3;crosshair?:Vec3;tool:string;center:number;width:number;masks:MaskObject[];
  measurements:MeasurementObject[];measurementLabels:Record<string,string>;allowEdit:boolean;
  densitySize?:[number,number];draftPoints?:Vec3[];draftPlane?:MprPlane|null;displayInverted?:boolean;intensityUnit?:string;
  interactivePlane?:MprPlane;interactiveCenter?:Vec3;interactiveEnabled?:boolean;
  brushWidth?:number;brushHeight?:number;sameWidthHeight?:boolean;brushShape?:'circle'|'square';activeMaskId?:string;
  brushPreview?:BinaryMask|null;brushPreviewRevision?:number;
  contourDraft?:MprContourDraft|null;contourSettingsKey?:string;
  referenceLines?:WorldReferenceLine[];referencePointToken?:number;
}>();
type GeometryChange={id:string;points:Vec3[];mprPlane:MprPlane;densityPlane?:AffinePlane;volume:Volume;revision:number;mprRevision:number};
type LabelChange={id:string;offset:Vec3;mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number};
type BrushEpoch={mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number;activeMaskId:string;strokeId:number};
const emit=defineEmits<{
  point:[world:Vec3];scroll:[{distanceMm:number;plane:MprPlane;volume:Volume;revision:number;mprRevision:number;viewId?:number}];pick:[{position:Vec3;mprPlane:MprPlane;append?:boolean;volume:Volume;revision:number;mprRevision:number}];
  complete:[];cancel:[];editMeasurement:[id:string];referencePoint:[ResliceProjectPoint];
  moveMeasurementPoint:[{id:string;index:number;position:Vec3;mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number}];
  updateMeasurementGeometry:[GeometryChange];previewMeasurementGeometry:[GeometryChange|null];updateMeasurementLabel:[LabelChange];
  createDensityROI:[{kind:DensityROIKind;points:[Vec3,Vec3];mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number}];
  transformMpr:[{plane:MprPlane;crosshair:Vec3;sourcePlane:MprPlane;volume:Volume;revision:number;mprRevision:number}];
  beginBrush:[BrushEpoch];brushStroke:[BrushEpoch&{position:Vec3;startSegment?:boolean}];endBrush:[BrushEpoch];cancelBrush:[BrushEpoch];resizeBrush:[{width:number;height:number}];
  beginContour:[MprContourEpoch];contourPoint:[MprContourEpoch&{position:Vec3}];previewContourPoint:[MprContourEpoch&{position:Vec3|null}];completeContour:[MprContourEpoch&{points?:Vec3[]}];cancelContour:[MprContourEpoch];
}>();
const host=ref<HTMLElement|null>(null),canvas=ref<HTMLCanvasElement|null>(null),size=ref<[number,number]>([500,400]);
const zoom=ref(1),pan=ref<[number,number]>([0,0]),cursor=ref<Vec3|null>(null),cursorStyle=ref(''),hoverText=ref(''),interactionError=ref('');
const ctrlHeld=ref(false),interactivePreview=shallowRef<{plane:MprPlane;crosshair:Vec3}|null>(null);
const brush=computed(()=>['paint','erase','local-threshold'].includes(props.tool));
const contourTool=computed(()=>props.tool==='lasso'||props.tool==='livewire');
const localLasso=shallowRef<Vec3[]>([]);
const contourHint=computed(()=>props.tool==='lasso'?'Lasso：按住左键连续描绘，松开闭合；Esc 取消':props.tool==='livewire'?props.contourDraft?.pending?'LiveWire 正在准备路径；当前会话保留，请稍候':'LiveWire：点击设置至少三个锚点，移动预览；Enter / 双击闭合（本应用约定）':'' );
const brushSize=computed(()=>{try{return normalizeBrushSize({width:props.brushWidth??6,height:props.brushHeight??props.brushWidth??6,shape:props.brushShape??'circle'});}catch{return null;}});
const brushResizePreview=ref<{width:number;height:number}|null>(null);
function brushKey(){return JSON.stringify([props.tool,props.activeMaskId,props.brushWidth,props.brushHeight,props.sameWidthHeight,props.brushShape]);}
const offscreen=document.createElement('canvas');let observer:ResizeObserver|undefined,frame=0,lastRaster:{pixels:Uint8ClampedArray;width:number;height:number}|null=null;
let lastRasterPlane='',lastRasterVolume:Volume|undefined;
const planeKey=(plane:MprPlane)=>JSON.stringify([plane.origin,plane.u,plane.v,plane.size]);
const planeState=computed(()=>{try{return{plane:validateMprPlane(props.plane),error:''};}catch(error){return{plane:null,error:error instanceof Error?error.message:String(error)};}});
const geometry=computed(()=>{
  const plane=planeState.value.plane,nx=plane?.size[0]??1,ny=plane?.size[1]??1,dx=plane?Math.hypot(...plane.u):1,dy=plane?Math.hypot(...plane.v):1;
  const scale=Math.min(size.value[0]/(nx*dx),size.value[1]/(ny*dy))*zoom.value;
  return{nx,ny,dx,dy,scale,left:(size.value[0]-nx*dx*scale)/2+pan.value[0],top:(size.value[1]-ny*dy*scale)/2+pan.value[1]};
});
const sampler=useMprSampling({volume:()=>props.volume,grid:()=>props.grid,sourceRevision:()=>props.revision,plane:()=>props.plane,interpolation:()=>props.interpolation??'linear',masks:()=>props.masks});
const samples=computed(()=>({data:sampler.samples.value,error:planeState.value.error||sampler.error.value}));
const loading=sampler.loading;
let previewLookup:{key:string;indices:Int32Array}|null=null;
const previewIndices=computed(()=>{if(!planeState.value.plane)return null;try{const grid={dims:props.grid.dims,spacing:props.grid.spacing,affine:props.grid.affine},key=JSON.stringify([grid,props.plane]);if(previewLookup?.key!==key)previewLookup={key,indices:mprBrushPreviewIndices(grid,props.plane)};return previewLookup.indices;}catch{return null;}});
const raster=computed(()=>{
  props.brushPreviewRevision;
  const data=samples.value.data;if(!data)return null;const preview=props.brushPreview?.length===props.grid.data.length?props.brushPreview:null,indices=preview?previewIndices.value:null,pixels=new Uint8ClampedArray(data.gray.length*4),visible=props.masks.filter(mask=>mask.visible&&mask.opacity>0).map(mask=>({mask,bits:data.masks.find(sample=>sample.id===mask.id)?.data,color:[1,3,5].map(index=>parseInt(mask.color.slice(index,index+2),16))}));
  const center=props.center,width=props.width,inverted=props.displayInverted,activeId=props.activeMaskId;
  for(let i=0;i<data.gray.length;i++){
    let r=6,g=11,b=20;
    if(data.valid[i]){let gray=Math.max(0,Math.min(255,(data.gray[i]-center+width/2)/Math.max(1,width)*255));if(inverted)gray=255-gray;r=g=b=gray;}
    for(const {mask,bits,color} of visible){const bit=preview&&indices&&mask.id===activeId?(indices[i]!>=0?preview[indices[i]!]:0):bits?.[i];if(data.support[i]&&bit){const alpha=Math.max(0,Math.min(1,mask.opacity));r=r*(1-alpha)+color[0]*alpha;g=g*(1-alpha)+color[1]*alpha;b=b*(1-alpha)+color[2]*alpha;}}
    // v points upwards on the displayed plane; ImageData rows point downwards.
    const x=i%data.plane.size[0],y=Math.floor(i/data.plane.size[0]),j=4*(x+(data.plane.size[1]-1-y)*data.plane.size[0]);pixels[j]=r;pixels[j+1]=g;pixels[j+2]=b;pixels[j+3]=255;
  }
  return{pixels,width:data.plane.size[0],height:data.plane.size[1]};
});
const error=computed(()=>samples.value.error||interactionError.value);
function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
function pixelScreen(pixel:readonly number[]):[number,number]{const g=geometry.value;return[g.left+(pixel[0]+.5)*g.dx*g.scale,g.top+(g.ny-pixel[1]-.5)*g.dy*g.scale];}
function worldScreen(world:Vec3):[number,number]{return pixelScreen(mprWorldToPixel(props.plane,world).pixel);}
function localScreen(event:Pick<MouseEvent,'clientX'|'clientY'>):[number,number]{const rect=canvas.value!.getBoundingClientRect();return[(event.clientX-rect.left)*size.value[0]/rect.width,(event.clientY-rect.top)*size.value[1]/rect.height];}
function eventPixel(event:Pick<MouseEvent,'clientX'|'clientY'>):[number,number]{const [x,y]=localScreen(event),g=geometry.value;return[(x-g.left)/(g.dx*g.scale)-.5,g.ny-.5-(y-g.top)/(g.dy*g.scale)];}
function pointerWorld(event:Pick<MouseEvent,'clientX'|'clientY'>,plane=props.plane):Vec3{return mprPixelToWorld(plane,eventPixel(event));}
function sourceSupported(world:Vec3){const voxel=worldToVoxel(world,props.grid);return voxel.every((v,k)=>v>=-.5&&v<=props.grid.dims[k]-.5);}
function locate(event:Pick<MouseEvent,'clientX'|'clientY'>):Vec3|null{if(!canvas.value||!planeState.value.plane||!samples.value.data)return null;const pixel=eventPixel(event),g=geometry.value;if(pixel[0]<-.5||pixel[0]>g.nx-.5||pixel[1]<-.5||pixel[1]>g.ny-.5)return null;const world=mprPixelToWorld(props.plane,pixel);return sourceSupported(world)?world:null;}
type Frozen={volume:Volume;grid:VolumeGrid;revision:number;mprRevision:number;plane:MprPlane;key:string};
type BaseGesture=Frozen&{pointerId:number;client:[number,number]};
type BrushContext={tool:string;activeMaskId?:string;brushKey:string;mask?:MaskObject;maskData?:BinaryMask;maskRevision?:number};
type ContourLease=Frozen&{sessionId:number;activeMaskId:string;tool:'lasso'|'livewire';settingsKey:string;mask:MaskObject;maskData:BinaryMask;maskRevision:number;pointerId:number};
type Gesture=BaseGesture&(
  {kind:'pan'|'navigate'|'navigate-once'}|
  (BrushContext&{kind:'brush';last:Vec3|null;strokeId:number})|
  (BrushContext&{kind:'resize-brush';anchor:Vec3;size:Required<BrushSize>;scale:number;same:boolean})|
  {kind:'lasso';lease:ContourLease}|
  {kind:'interactive-mpr';base:MprPlane;pivot:Vec3;interactiveKey:string;start:Vec3;action:'move'|'rotate';moved:boolean;invalid:boolean}|
  {kind:'geometry';measurement:MeasurementObject;signature:string;original:Vec3[];start:Vec3;action:'point'|'resize'|'move'|'rotate';index?:number;handle?:string;moved:boolean;invalid:boolean}|
  {kind:'label';measurement:MeasurementObject;signature:string;start:Vec3;offset:Vec3;moved:boolean}|
  {kind:'affine-density';id:string;measurement:MeasurementObject;collection:MeasurementObject[];signature:string;densityPlane:AffinePlane;original:DensityROIPoints;start:Vec3;roiKind:DensityROIKind;action:'move'|'resize';handle?:DensityROIHandle;tool:string}|
  {kind:'density';id?:string;signature?:string;roiKind:DensityROIKind;start:Vec3;initial:DensityROIPoints;action:'create'|'move'|'resize';handle?:DensityROIHandle;moved:boolean}
);
let gesture:Gesture|null=null;
let contourLease:ContourLease|null=null;
function freeze():Frozen{return{volume:props.volume,grid:props.grid,revision:props.revision,mprRevision:props.mprRevision??0,plane:validateMprPlane(props.plane),key:planeKey(props.plane)};}
function current(frozen:Frozen){return props.volume===frozen.volume&&props.grid===frozen.grid&&props.revision===frozen.revision&&(props.mprRevision??0)===frozen.mprRevision&&planeKey(props.plane)===frozen.key;}
function capture(event:PointerEvent,details:object){gesture={...freeze(),pointerId:event.pointerId,client:[event.clientX,event.clientY],...details} as Gesture;canvas.value?.setPointerCapture(event.pointerId);return gesture;}
function clearGesture(){const previous=gesture;gesture=null;geometryPreview.value=null;labelPreview.value=null;densityPreview.value=null;affineDensityPreview.value=null;interactivePreview.value=null;brushResizePreview.value=null;cursorStyle.value='';if(previous&&canvas.value?.hasPointerCapture(previous.pointerId))canvas.value.releasePointerCapture(previous.pointerId);if(previous?.kind==='geometry')emit('previewMeasurementGeometry',null);}
function takeContourLease(){const previous=contourLease;contourLease=null;localLasso.value=[];return previous;}
function cancelPointer(event?:PointerEvent){if(event?.type==='lostpointercapture'&&!gesture&&contourLease)return;if(event&&(gesture?event.pointerId!==gesture.pointerId:contourLease&&event.pointerId!==contourLease.pointerId))return;const activeBrush=gesture?.kind==='brush'?gesture:null,activeContour=takeContourLease();areaMenu.value=null;clearGesture();if(activeBrush)emit('cancelBrush',brushPayload(activeBrush));if(activeContour)emit('cancelContour',contourPayload(activeContour));schedule();}
const geometryPreview=ref<{id:string;points:Vec3[]}|null>(null),labelPreview=ref<{id:string;offset:Vec3}|null>(null);
const densityPreview=ref<{id?:string;kind:DensityROIKind;points:DensityROIPoints}|null>(null);
const affineDensityPreview=shallowRef<{id:string;points:DensityROIPoints}|null>(null);
const areaMenu=shallowRef<(Frozen&{id:string;index:number;signature:string;points:Vec3[];x:number;y:number})|null>(null);
const roiPlane={axis:2,index:0} as const;
function roiDims():Vec3{return[props.plane.size[0],props.plane.size[1],1];}
function samplePoint(event:Pick<MouseEvent,'clientX'|'clientY'>,clip=false):Vec3{const [x,y]=eventPixel(event),[w,h]=props.plane.size;return[clip?Math.max(-.5,Math.min(w-.5,x)):x,clip?Math.max(-.5,Math.min(h-.5,y)):y,0];}
function samePlane(a:MprPlane|undefined,b=props.plane){if(!a)return false;try{return coplanarMprPlanes(a,b);}catch{return false;}}
function roiAligned(a:MprPlane){return sameMprOrientation(a,props.plane);}
function signature(m:MeasurementObject){return JSON.stringify([m.kind,m.points,m.mprPlane,m.densityPlane,m.pointPartIds,m.partId,m.labelOffset,m.visible]);}
function gestureCurrent(active:Gesture){if(!current(active))return false;if(active.kind==='affine-density')return props.allowEdit&&props.tool===active.tool&&allowsMeasurementLabels(props.tool)&&props.measurements===active.collection&&props.measurements.find(m=>m.id===active.id)===active.measurement&&signature(active.measurement)===active.signature;if(active.kind==='lasso')return contourLease===active.lease&&contourCurrent(active.lease);if(active.kind==='brush'||active.kind==='resize-brush'){const mask=props.masks.find(mask=>mask.id===active.activeMaskId);return props.allowEdit&&brush.value&&active.brushKey===brushKey()&&mask===active.mask&&mask?.data===active.maskData&&mask?.revision===active.maskRevision;}if(active.kind==='interactive-mpr')return props.allowEdit&&props.interactiveEnabled&&active.interactiveKey===interactiveKey();if(active.kind==='geometry'||active.kind==='label')return props.allowEdit&&allowsMeasurementLabels(props.tool)&&props.measurements.some(m=>m.id===active.measurement.id&&signature(m)===active.signature);if(active.kind==='density')return props.allowEdit&&allowsMeasurementLabels(props.tool)&&(!active.id||props.measurements.some(m=>m.id===active.id&&signature(m)===active.signature));return true;}
function interactiveKey(){return JSON.stringify([props.interactivePlane,props.interactiveCenter,props.interactiveEnabled]);}
function interactiveOverlay(){if(!props.interactiveEnabled||!props.interactivePlane||!props.interactiveCenter||!planeState.value.plane)return null;try{const shown=interactivePreview.value??{plane:props.interactivePlane,crosshair:props.interactiveCenter},center=worldScreen(shown.crosshair),axes=interactiveMprAxes(shown.plane,props.plane,shown.crosshair,props.viewId).map(axis=>{const end=worldScreen(shown.crosshair.map((v,k)=>v+axis.direction[k]) as Vec3),d:[number,number]=[end[0]-center[0],end[1]-center[1]],length=Math.hypot(...d);return{...axis,directionScreen:[d[0]/length,d[1]/length] as [number,number]};}).filter(axis=>axis.directionScreen.every(Number.isFinite));return{...shown,center,axes};}catch{return null;}}
function interactiveAt(event:Pick<MouseEvent,'clientX'|'clientY'>){if(!props.allowEdit)return null;const overlay=interactiveOverlay();if(!overlay)return null;const p=localScreen(event),delta=[p[0]-overlay.center[0],p[1]-overlay.center[1]];if(Math.hypot(...delta)<=8)return{action:'move' as const,cursor:'move'};for(const axis of overlay.axes)if(Math.abs(delta[0]*axis.directionScreen[1]-delta[1]*axis.directionScreen[0])<=6)return{action:'rotate' as const,cursor:'crosshair'};return null;}
function controlKey(event:KeyboardEvent){if(event.key!=='Control')return;ctrlHeld.value=event.type!=='keyup';if(!ctrlHeld.value&&gesture?.kind==='interactive-mpr')cancelPointer();schedule();}
function controlBlur(){ctrlHeld.value=false;if(contourLease||gesture?.kind==='interactive-mpr'||gesture?.kind==='brush'||gesture?.kind==='resize-brush'||gesture?.kind==='affine-density')cancelPointer();schedule();}
function worldPayload(frozen:Frozen){return{mprPlane:validateMprPlane(frozen.plane),volume:frozen.volume,revision:frozen.revision,mprRevision:frozen.mprRevision};}
function brushPayload(frozen:Frozen&BrushContext&{strokeId:number}):BrushEpoch{return{...worldPayload(frozen),activeMaskId:frozen.activeMaskId!,strokeId:frozen.strokeId};}
function contourPayload(lease:ContourLease):MprContourEpoch{return{...worldPayload(lease),activeMaskId:lease.activeMaskId,sessionId:lease.sessionId};}
function contourCurrent(lease:ContourLease){const mask=props.masks.find(mask=>mask.id===lease.activeMaskId);return current(lease)&&props.allowEdit&&props.tool===lease.tool&&props.activeMaskId===lease.activeMaskId&&(props.contourSettingsKey??'')===lease.settingsKey&&mask===lease.mask&&mask.visible&&mask.data===lease.maskData&&mask.revision===lease.maskRevision;}
function newContourLease(event:PointerEvent):ContourLease|null{
  const mask=props.masks.find(mask=>mask.id===props.activeMaskId);if(!mask||!mask.visible||!props.allowEdit||!contourTool.value)return null;
  const lease:ContourLease={...freeze(),sessionId:nextMprContourSessionId(),activeMaskId:mask.id,tool:props.tool as 'lasso'|'livewire',settingsKey:props.contourSettingsKey??'',mask,maskData:mask.data,maskRevision:mask.revision,pointerId:event.pointerId};contourLease=lease;emit('beginContour',contourPayload(lease));return contourLease===lease&&contourCurrent(lease)?lease:null;
}
function matchingContourDraft(lease:ContourLease){const draft=props.contourDraft;return draft&&draft.sessionId===lease.sessionId&&draft.activeMaskId===lease.activeMaskId&&draft.volume===lease.volume&&draft.revision===lease.revision&&draft.mprRevision===lease.mprRevision&&planeKey(draft.mprPlane)===lease.key?draft:null;}
function firstThreeContourPoints(points:Vec3[]){const unique:Vec3[]=[];for(const point of points){if(unique.every(q=>Math.hypot(...point.map((v,k)=>v-q[k]!))>1e-8))unique.push(point);if(unique.length===3)break;}return unique;}
function appendLassoPoint(world:Vec3){const last=localLasso.value.at(-1);if(!last||Math.hypot(...world.map((v,k)=>v-last[k]!))>1e-9)localLasso.value.push([...world]);}
function completeLiveWire(){
  const lease=contourLease;if(!lease||lease.tool!=='livewire'||!contourCurrent(lease))return false;const draft=matchingContourDraft(lease);if(!draft||draft.pending||firstThreeContourPoints(draft.anchors).length<3||draft.points.length<3)return false;
  takeContourLease();emit('completeContour',contourPayload(lease));schedule();return true;
}
const visibleContourDraft=computed(()=>{const draft=props.contourDraft;if(!draft||!contourTool.value||draft.activeMaskId!==props.activeMaskId||draft.volume!==props.volume||draft.revision!==props.revision||draft.mprRevision!==(props.mprRevision??0)||!samePlane(draft.mprPlane))return null;return draft;});
function leaveCanvas(){cursor.value=null;hoverText.value='';const lease=contourLease,draft=lease?matchingContourDraft(lease):null;if(gesture?.kind==='lasso')cancelPointer();else if(lease?.tool==='livewire'&&contourCurrent(lease)&&draft&&!draft.pending)emit('previewContourPoint',{...contourPayload(lease),position:null});schedule();}
function resultLines(kind:MeasurementObject['kind'],points:Vec3[]){if(kind==='annotation'||isDensityROI(kind)||kind==='surface-distance')return[];const result=evaluateMeasurement(kind,points);if(!result.valid)return[`预览无效 · ${result.reason}`];const d=result.details,n=(key:string)=>typeof d[key]==='number'&&Number.isFinite(d[key])?Number(d[key]).toFixed(2):'—';if(kind==='ellipse')return[`预览 · D1 ${n('D1')} · D2 ${n('D2')} mm · E ${n('E')}`,`A ${n('A')} mm² · P ${n('P')} mm · DP ${n('DP')} · DA ${n('DA')} mm`];if(kind==='area')return[`预览 · A ${result.value.toFixed(2)} mm² · P ${n('perimeter')} mm`,`Da ${n('Da')} · Dp ${n('Dp')} · Lmax ${n('Lmax')} · L ${n('L')} mm`];return[`预览 · ${result.value.toFixed(2)} ${result.unit}`];}
function ellipseOutline(points:Vec3[]){try{const f=ellipseFrame(points);return Array.from({length:128},(_,i)=>f.center.map((v,k)=>v+f.a*Math.cos(i*Math.PI/64)*f.u[k]+f.b*Math.sin(i*Math.PI/64)*f.v[k]) as Vec3);}catch{return[];}}
function measurementItems(){return props.measurements.filter(m=>m.visible&&samePlane(m.mprPlane)&&!isDensityROI(m.kind)&&m.kind!=='surface-distance').map(m=>{
  const points=geometryPreview.value?.id===m.id?geometryPreview.value.points:m.points,shown={...m,points,...(labelPreview.value?.id===m.id?{labelOffset:labelPreview.value.offset}:{})},screen=points.map(worldScreen);
  let handles:{id:string;kind:string;position:Vec3;screen:[number,number]}[]=[];
  if(m.kind==='ellipse'){try{handles=ellipseHandles(points).map(handle=>({...handle,screen:worldScreen(handle.position)}));}catch{/* Invalid candidates keep their error label. */}}else handles=points.map((position,index)=>({id:String(index),kind:'point',position,screen:screen[index]}));
  const annotation=m.kind==='annotation'?annotationLayout(screen[0],m.text??m.name,m.annotationStyle,{viewport:size.value,labelPoint:screen[1]}):null;
  const lines=geometryPreview.value?.id===m.id?resultLines(m.kind,points):[props.measurementLabels[m.id]||m.name],position=worldScreen(measurementLabelPosition(shown)),label={x:position[0]+10,y:position[1]-10,width:Math.max(1,...lines.map(line=>Array.from(line).length))*7+8,height:Math.max(1,lines.length)*16};
  return{m,points,screen,handles,annotation,lines,label,outline:m.kind==='ellipse'?ellipseOutline(points).map(worldScreen):screen};
});}
function densityItems(){return props.measurements.filter(m=>m.visible&&isDensityROI(m.kind)&&m.points.length===2&&samePlane(m.mprPlane)&&roiAligned(m.mprPlane!)).map(m=>({m,kind:m.kind as DensityROIKind,points:densityPreview.value?.id===m.id?densityPreview.value.points:normalizeDensityROI(m.points.map(world=>{const pixel=mprWorldToPixel(props.plane,world).pixel;return[pixel[0],pixel[1],0] as Vec3;}),roiPlane)}));}
function affineDensityItems(){return props.measurements.flatMap(m=>{if(!m.visible||!isDensityROI(m.kind)||!m.densityPlane||m.points.length!==2)return[];try{if(!coplanarAffinePlanes(m.densityPlane,props.plane))return[];const points=affineDensityPreview.value?.id===m.id?affineDensityPreview.value.points:m.points;return[{m,shape:affineDensityROI(m.kind,points,m.densityPlane)}];}catch{return[];}});}
function affineDensityAt(event:Pick<MouseEvent,'clientX'|'clientY'>){if(!props.allowEdit||!allowsMeasurementLabels(props.tool))return;for(const item of affineDensityItems().reverse()){const hit=hitAffineDensityROI(item.shape,worldScreen,localScreen(event));if(hit)return{...item,...hit};}}
function measurementAt(event:Pick<MouseEvent,'clientX'|'clientY'>){if(!props.allowEdit||!allowsMeasurementLabels(props.tool))return undefined;const [x,y]=localScreen(event);for(const item of measurementItems().reverse()){const handle=item.handles.find(handle=>Math.hypot(handle.screen[0]-x,handle.screen[1]-y)<8);if(handle)return{item,handle,label:false};if(item.annotation?annotationLabelHit(item.annotation,[x,y]):x>=item.label.x-4&&x<=item.label.x+item.label.width&&y>=item.label.y-13&&y<=item.label.y-13+item.label.height)return{item,handle:undefined,label:true};}return undefined;}
function densityAt(event:Pick<MouseEvent,'clientX'|'clientY'>){if(!props.allowEdit||!allowsMeasurementLabels(props.tool))return undefined;const [x,y]=localScreen(event);for(const item of densityItems().reverse()){
  for(const marker of densityROIMarkers(item.kind,item.points,roiPlane)){const p=pixelScreen(marker.point);if(Math.hypot(p[0]-x,p[1]-y)<=8)return{...item,action:'resize' as const,handle:marker.key,cursor:marker.key==='n'||marker.key==='s'?'ns-resize':marker.key==='e'||marker.key==='w'?'ew-resize':marker.key==='ne'||marker.key==='sw'?'nesw-resize':'nwse-resize'};}
  const outline=densityROIOutline(item.kind,item.points,roiPlane).map(pixelScreen);for(let i=0;i<outline.length;i++){const p=outline[i],q=outline[(i+1)%outline.length],dx=q[0]-p[0],dy=q[1]-p[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((x-p[0])*dx+(y-p[1])*dy)/length)):0;if(Math.hypot(x-p[0]-t*dx,y-p[1]-t*dy)<=6)return{...item,action:'move' as const,handle:undefined,cursor:'grab'};}
}return undefined;}
function openAreaMenu(event:Pick<MouseEvent,'clientX'|'clientY'>){areaMenu.value=null;if(!props.allowEdit||!allowsMeasurementLabels(props.tool))return false;const point=localScreen(event);for(const item of measurementItems().reverse()){if(item.m.kind!=='area')continue;const index=item.screen.findIndex(p=>Math.hypot(p[0]-point[0],p[1]-point[1])<8);if(index>=0){areaMenu.value={...freeze(),id:item.m.id,index,signature:signature(item.m),points:item.points.map(p=>[...p] as Vec3),x:Math.max(0,Math.min(size.value[0]-175,point[0])),y:Math.max(0,Math.min(size.value[1]-120,point[1]))};return true;}}return false;}
function editAreaPoint(action:'add'|'remove'){const menu=areaMenu.value;areaMenu.value=null;if(!menu||!current(menu)||!props.allowEdit||!props.measurements.some(m=>m.id===menu.id&&signature(m)===menu.signature))return;const points=menu.points.map(p=>[...p] as Vec3);if(action==='remove'){if(points.length<=3){interactionError.value='Area 至少保留三个控制点。';return;}points.splice(menu.index,1);}else{const p=points[menu.index],q=points[(menu.index+1)%points.length];points.splice(menu.index+1,0,p.map((v,k)=>(v+q[k])/2) as Vec3);}const result=evaluateMeasurement('area',points);if(!result.valid){interactionError.value=result.reason??'候选面积无效。';return;}emit('updateMeasurementGeometry',{id:menu.id,points,...worldPayload(menu)});schedule();}
function down(event:PointerEvent){
  if(gesture||!planeState.value.plane)return;ctrlHeld.value=!!event.ctrlKey;interactionError.value='';canvas.value?.focus();
  if(event.button===2&&!event.shiftKey&&openAreaMenu(event)){event.preventDefault?.();return;}areaMenu.value=null;
  if(event.button===1||event.button===2){capture(event,{kind:'pan'});return;}
  if(event.button!==0||typeof event.buttons==='number'&&!(event.buttons&1))return;
  const world=locate(event);
  if(event.shiftKey){if(world){capture(event,{kind:'navigate-once'});emit('point',world);schedule();}return;}
  if(event.ctrlKey&&props.interactiveEnabled){const hit=interactiveAt(event);if(hit&&props.interactivePlane&&props.interactiveCenter){const base=validateMprPlane(props.interactivePlane),pivot=[...props.interactiveCenter] as Vec3;capture(event,{kind:'interactive-mpr',base,pivot,interactiveKey:interactiveKey(),start:pointerWorld(event),action:hit.action,moved:false,invalid:false});interactivePreview.value={plane:base,crosshair:pivot};cursorStyle.value=hit.cursor;event.preventDefault?.();}schedule();return;}
  if(contourTool.value){
    if(event.ctrlKey||!world||!props.allowEdit||typeof event.buttons==='number'&&event.buttons!==1)return;
    if(contourLease&&!contourCurrent(contourLease))cancelPointer();
    try{
      if(props.tool==='lasso'){
        if(contourLease)cancelPointer();const lease=newContourLease(event);if(!lease)return;localLasso.value=[];appendLassoPoint(world);capture(event,{kind:'lasso',lease});
      }else{
        const existing=contourLease,lease=existing??newContourLease(event);if(!lease)return;const draft=matchingContourDraft(lease);if(draft?.pending||existing&&!draft)return;
        // A double click adds its first click anchor only; its qualified completion follows.
        if((event.detail??1)<2){lease.pointerId=event.pointerId;emit('contourPoint',{...contourPayload(lease),position:[...world]});}
      }
      cursor.value=world;cursorStyle.value='crosshair';event.preventDefault?.();schedule();
    }catch(error){cancelPointer();interactionError.value=error instanceof Error?error.message:String(error);}
    return;
  }
  const affine=affineDensityAt(event);
  if(affine){const m=affine.m;capture(event,{kind:'affine-density',id:m.id,measurement:m,collection:props.measurements,signature:signature(m),densityPlane:validateAffinePlane(m.densityPlane),original:m.points.map(p=>[...p]),start:pointerWorld(event),roiKind:m.kind,action:affine.action,handle:affine.handle,tool:props.tool});affineDensityPreview.value={id:m.id,points:m.points.map(p=>[...p]) as DensityROIPoints};cursorStyle.value=affine.action==='move'?'grabbing':affine.cursor;event.preventDefault?.();schedule();return;}
  const density=densityAt(event);
  if(density){capture(event,{kind:'density',id:density.m.id,signature:signature(density.m),roiKind:density.kind,start:samplePoint(event,true),initial:normalizeDensityROI(density.points,roiPlane),action:density.action,handle:density.handle,moved:false});densityPreview.value={id:density.m.id,kind:density.kind,points:normalizeDensityROI(density.points,roiPlane)};cursorStyle.value=density.action==='move'?'grabbing':density.cursor;schedule();return;}
  const hit=measurementAt(event);
  if(hit){const m=hit.item.m,start=pointerWorld(event);if(hit.label){if(m.kind==='annotation')return;capture(event,{kind:'label',measurement:m,signature:signature(m),start,offset:[...(m.labelOffset??[0,0,0])],moved:false});labelPreview.value={id:m.id,offset:[...(m.labelOffset??[0,0,0])]};cursorStyle.value='grabbing';}else{capture(event,{kind:'geometry',measurement:m,signature:signature(m),original:m.points.map(p=>[...p]),start,action:m.kind==='ellipse'?hit.handle!.kind:'point',index:m.kind==='ellipse'?undefined:Number(hit.handle!.id),handle:hit.handle!.id,moved:false,invalid:false});geometryPreview.value={id:m.id,points:m.points.map(p=>[...p] as Vec3)};cursorStyle.value=hit.handle?.kind==='move'?'grabbing':hit.handle?.kind==='rotate'?'crosshair':'move';}event.preventDefault?.();schedule();return;}
  if(!world)return;
  if(props.tool==='navigate'){capture(event,{kind:'navigate'});emit('point',world);schedule();return;}
  if(!props.allowEdit)return;
  if(props.tool==='reslice-project-line'){const token=props.referencePointToken;if(Number.isSafeInteger(token)&&token!>0){const frozen=freeze();emit('referencePoint',{position:[...world],...worldPayload(frozen),lineToken:token!});}schedule();return;}
  if(brush.value){
    if(typeof event.buttons==='number'&&event.buttons!==1)return;
    const config=brushSize.value;if(!config)return;
    cursor.value=world;
    const mask=props.masks.find(mask=>mask.id===props.activeMaskId),context:BrushContext={tool:props.tool,activeMaskId:props.activeMaskId,brushKey:brushKey(),mask,maskData:mask?.data,maskRevision:mask?.revision};
    if(event.ctrlKey){capture(event,{kind:'resize-brush',...context,anchor:[...world],size:{...config},scale:geometry.value.scale,same:props.sameWidthHeight!==false});brushResizePreview.value={width:config.width,height:config.height};cursor.value=world;}
    else if(mask){try{const strokeId=nextMprBrushStrokeId(),active=capture(event,{kind:'brush',...context,last:[...world],strokeId}) as Extract<Gesture,{kind:'brush'}>;emit('beginBrush',brushPayload(active));if(gesture===active&&gestureCurrent(active))emit('brushStroke',{position:[...world],...brushPayload(active),startSegment:true});}catch(error){cancelPointer();interactionError.value=error instanceof Error?error.message:String(error);}}
    schedule();return;
  }
  if(isDensityROI(props.tool)){try{const start=samplePoint(event,true),points=defaultDensityROI(start,props.densitySize??[10,10],roiPlane,roiDims());capture(event,{kind:'density',roiKind:props.tool,start,initial:points,action:'create',moved:false});densityPreview.value={kind:props.tool,points};cursorStyle.value='crosshair';schedule();}catch(error){interactionError.value=error instanceof Error?error.message:String(error);}return;}
  if(props.tool==='ellipse'&&props.draftPoints?.length===2&&samePlane(props.draftPlane??undefined)){const result=evaluateMeasurement('ellipse',[...props.draftPoints,world]);if(!result.valid){interactionError.value=result.reason??'椭圆候选无效。';cursor.value=world;schedule();return;}}
  if(['area','ellipse','distance','angle','diameter','annotation','mpr-plane'].includes(props.tool)){const frozen=freeze();emit('pick',{position:world,...worldPayload(frozen),append:event.ctrlKey});schedule();}
}
function move(event:PointerEvent){
  ctrlHeld.value=!!event.ctrlKey;cursor.value=locate(event);if(gesture&&event.pointerId!==gesture.pointerId)return;if(gesture&&(!gestureCurrent(gesture)||gesture.kind==='interactive-mpr'&&!event.ctrlKey)){cancelPointer();return;}
  if(contourLease&&!contourCurrent(contourLease)){cancelPointer();return;}
  const screen=localScreen(event);hoverText.value=measurementItems().reverse().find(item=>item.annotation&&annotationLabelHit(item.annotation,screen))?.annotation?.fullText??'';
  if(!gesture){const density=densityAt(event),hit=measurementAt(event);cursorStyle.value=event.ctrlKey&&props.interactiveEnabled?interactiveAt(event)?.cursor??'':brush.value&&props.allowEdit?'crosshair':affineDensityAt(event)?.cursor??density?.cursor??(hit?(hit.label||hit.handle?.kind==='move'?'grab':hit.handle?.kind==='rotate'?'crosshair':'move'):isDensityROI(props.tool)?'crosshair':'');if(cursor.value&&props.tool==='ellipse'&&props.draftPoints?.length===2&&samePlane(props.draftPlane??undefined)&&evaluateMeasurement('ellipse',[...props.draftPoints,cursor.value]).valid)interactionError.value='';}
  if(gesture&&(gesture.kind==='brush'||gesture.kind==='resize-brush'||gesture.kind==='lasso'||gesture.kind==='affine-density')&&typeof event.buttons==='number'&&(event.type==='pointerup'?event.buttons!==0||event.button!==0:event.buttons!==1)){cancelPointer();return;}
  if(gesture&&['geometry','label','density','interactive-mpr'].includes(gesture.kind)&&typeof event.buttons==='number'&&(event.type==='pointerup'?event.buttons!==0:!(event.buttons&1))){cancelPointer();return;}
  const active=gesture;
  if(active?.kind==='affine-density'){try{affineDensityPreview.value={id:active.id,points:editAffineDensityROI(active.densityPlane,active.original,active.start,pointerWorld(event,active.plane),active.action,active.handle)};}catch(error){cancelPointer();interactionError.value=error instanceof Error?error.message:String(error);return;}}
  else if(active?.kind==='lasso'){
    const samples=event.getCoalescedEvents?.()??[];if(localLasso.value.length+samples.length+1>MAX_BRUSH_STROKE_SAMPLES){cancelPointer();interactionError.value='本次轮廓输入超过轨迹处理上限，已取消整个会话。';return;}
    for(const sample of [...samples,event]){
      if(sample!==event&&(typeof sample.buttons==='number'&&sample.buttons!==1||typeof sample.pointerId==='number'&&sample.pointerId!==active.pointerId)){cancelPointer();return;}
      const world=locate(sample);if(!world){cancelPointer();return;}appendLassoPoint(world);
    }
  }else if(active?.kind==='brush'){
    const samples=event.getCoalescedEvents?.()??[];
    if(samples.length+1>MAX_BRUSH_STROKE_SAMPLES){cancelPointer();interactionError.value='本次输入的轨迹点超过处理上限，已取消整笔；请分段绘制。';return;}
    for(const sample of [...samples,event]){
      if(sample!==event&&(typeof sample.buttons==='number'&&sample.buttons!==1||typeof sample.pointerId==='number'&&sample.pointerId!==active.pointerId)){cancelPointer();return;}
      const world=locate(sample);
      if(world&&(!active.last||world.some((v,k)=>v!==active.last![k]))){const startSegment=!active.last;active.last=[...world];emit('brushStroke',{position:[...world],...brushPayload(active),startSegment});if(gesture!==active)return;if(!gestureCurrent(active)){cancelPointer();return;}}
      else active.last=world?[...world]:null;
    }
  }else if(active?.kind==='resize-brush'){
    try{const [x,y]=localScreen(event),[sx,sy]=localScreen({clientX:active.client[0],clientY:active.client[1]});brushResizePreview.value=resizeBrushFromDrag(active.size,[x-sx,y-sy],active.scale,active.same);cursor.value=active.anchor;}
    catch(error){cancelPointer();interactionError.value=error instanceof Error?error.message:String(error);return;}
  }else if(active?.kind==='interactive-mpr'){const world=pointerWorld(event,active.plane),delta=world.map((v,k)=>v-active.start[k]) as Vec3;active.moved=Math.hypot(...delta)>1e-9;try{interactivePreview.value=active.action==='move'?translateMpr(active.base,active.pivot,delta):rotateMpr(active.base,active.pivot,active.plane,active.start,world);active.invalid=false;interactionError.value='';}catch(error){active.invalid=true;interactionError.value=error instanceof Error?error.message:String(error);}}
  else if(active?.kind==='pan'){pan.value=[pan.value[0]+event.clientX-active.client[0],pan.value[1]+event.clientY-active.client[1]];active.client=[event.clientX,event.clientY];cursor.value=locate(event);}
  else if(active?.kind==='navigate'&&cursor.value)emit('point',cursor.value);
  else if(active?.kind==='geometry'){
    const world=pointerWorld(event,active.plane),delta=world.map((v,k)=>v-active.start[k]) as Vec3;active.moved=Math.hypot(...delta)>1e-9;
    try{const points=active.action==='point'?active.original.map((p,i)=>i===active.index?world:[...p] as Vec3):active.action==='move'?moveEllipse(active.original,delta):active.action==='rotate'?rotateEllipse(active.original,active.start,world):resizeEllipse(active.original,active.handle!,world);geometryPreview.value={id:active.measurement.id,points};active.invalid=false;interactionError.value='';emit('previewMeasurementGeometry',{id:active.measurement.id,points,...worldPayload(active)});}catch(error){active.invalid=true;interactionError.value=error instanceof Error?error.message:String(error);}
  }else if(active?.kind==='label'){const world=pointerWorld(event,active.plane),delta=world.map((v,k)=>v-active.start[k]);active.moved=Math.hypot(...delta)>1e-9;labelPreview.value={id:active.measurement.id,offset:active.offset.map((v,k)=>v+delta[k]) as Vec3};}
  else if(active?.kind==='density'){const point=samplePoint(event,true),distance=Math.hypot(event.clientX-active.client[0],event.clientY-active.client[1]);if(distance>=(active.action==='create'?3:1e-9))active.moved=true;const points=active.action==='create'?(active.moved?densityROIFromDrag(active.start,point,roiPlane,roiDims()):active.initial):active.action==='move'?moveDensityROI(active.initial,active.start,point,roiPlane,roiDims()):resizeDensityROI(active.initial,active.handle!,point,roiPlane,roiDims());densityPreview.value={id:active.id,kind:active.roiKind,points};}
  else if(!active&&contourLease?.tool==='livewire'&&!event.ctrlKey&&!event.shiftKey){const lease=contourLease,draft=matchingContourDraft(lease);if(draft&&!draft.pending)emit('previewContourPoint',{...contourPayload(lease),position:cursor.value?[...cursor.value]:null});}
  schedule();
}
function end(event:PointerEvent){
  if(!gesture||gesture.pointerId!==event.pointerId)return;if(event.type!=='pointerup'){cancelPointer(event);return;}move(event);const active=gesture,preview=geometryPreview.value,label=labelPreview.value,density=densityPreview.value,affine=affineDensityPreview.value,blue=interactivePreview.value,resized=brushResizePreview.value,lasso=active?.kind==='lasso'?localLasso.value.map(p=>[...p] as Vec3):null;if(active?.kind==='lasso')takeContourLease();clearGesture();if(!active)return;
  if(active.kind==='affine-density'&&affine&&affine.points.some((p,i)=>Math.hypot(...p.map((v,k)=>v-active.original[i]![k]!))>1e-8)){if(affineDensityROI(active.roiKind,affine.points,active.densityPlane).hasArea)emit('updateMeasurementGeometry',{id:active.id,points:affine.points.map(p=>[...p]),densityPlane:validateAffinePlane(active.densityPlane),...worldPayload(active)});else interactionError.value='密度 ROI 宽高须大于零。';}
  if(active.kind==='lasso'){
    if(lasso&&firstThreeContourPoints(lasso).length===3){emit('completeContour',{...contourPayload(active.lease),points:lasso});}
    else{interactionError.value='Lasso 至少需要三个不同的轮廓点。';emit('cancelContour',contourPayload(active.lease));}
  }
  if(active.kind==='brush')emit('endBrush',brushPayload(active));
  if(active.kind==='resize-brush'&&resized&&(resized.width!==active.size.width||resized.height!==active.size.height))emit('resizeBrush',resized);
  if(active.kind==='interactive-mpr'&&active.moved&&!active.invalid&&blue)emit('transformMpr',{plane:blue.plane,crosshair:blue.crosshair,sourcePlane:validateMprPlane(active.plane),volume:active.volume,revision:active.revision,mprRevision:active.mprRevision});
  if(active.kind==='geometry'&&active.moved&&!active.invalid&&preview){const m=active.measurement,result=m.kind==='annotation'?{valid:true,reason:''}:evaluateMeasurement(m.kind as EvaluationKind,preview.points);if(!result.valid)interactionError.value=result.reason??'候选测量无效。';else if(m.kind==='area'||m.kind==='ellipse')emit('updateMeasurementGeometry',{id:m.id,points:preview.points,...worldPayload(active)});else emit('moveMeasurementPoint',{id:m.id,index:active.index!,position:preview.points[active.index!],...worldPayload(active)});}
  if(active.kind==='label'&&active.moved&&label)emit('updateMeasurementLabel',{id:active.measurement.id,offset:label.offset,...worldPayload(active)});
  if(active.kind==='density'&&density){if(!densityROIHasArea(density.points,roiPlane))interactionError.value='密度 ROI 宽高须大于零。';else{const points=density.points.map(p=>mprPixelToWorld(active.plane,[p[0],p[1]])) as [Vec3,Vec3];if(active.id){if(active.moved)emit('updateMeasurementGeometry',{id:active.id,points,...worldPayload(active)});}else emit('createDensityROI',{kind:active.roiKind,points,...worldPayload(active)});}}
  schedule();
}
function wheel(event:WheelEvent){
  cancelPointer();if(!planeState.value.plane)return;
  if(event.ctrlKey||event.shiftKey){const pixel=eventPixel(event),screen=localScreen(event);zoom.value=Math.max(.15,Math.min(12,zoom.value*Math.exp(-event.deltaY*.002)));const next=pixelScreen(pixel);pan.value=[pan.value[0]+screen[0]-next[0],pan.value[1]+screen[1]-next[1]];cursor.value=locate(event);}
  else if(event.deltaY){if(!Number.isFinite(props.step)||props.step<=0)interactionError.value='MPR 滚动步长必须是有限正数。';else{const frozen=freeze();emit('scroll',{distanceMm:Math.sign(event.deltaY)*props.step,plane:frozen.plane,volume:frozen.volume,revision:frozen.revision,mprRevision:frozen.mprRevision,viewId:props.viewId});}}schedule();
}
function key(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault?.();event.stopPropagation?.();const localOnly=brush.value||contourTool.value||!!contourLease||gesture?.kind==='brush'||gesture?.kind==='resize-brush'||gesture?.kind==='affine-density';cancelPointer();if(!localOnly)emit('cancel');}else if(event.key==='Enter'&&props.allowEdit&&!brush.value){event.preventDefault?.();event.stopPropagation?.();if(contourTool.value){if(props.tool==='livewire')completeLiveWire();}else emit('complete');}}
function doubleClick(event:MouseEvent){if(contourTool.value){event.preventDefault?.();if(!event.ctrlKey&&!event.shiftKey&&props.tool==='livewire'&&props.allowEdit)completeLiveWire();return;}if(event.shiftKey||brush.value||event.ctrlKey&&props.interactiveEnabled)return;const hit=measurementAt(event);if(hit){event.preventDefault?.();if(hit.item.m.kind==='annotation'&&hit.label)emit('editMeasurement',hit.item.m.id);return;}if(props.allowEdit)emit('complete');}
function reset(){cancelPointer();zoom.value=1;pan.value=[0,0];cursor.value=null;schedule();}
function draw(){
  frame=0;const target=canvas.value;if(!target)return;const dpr=window.devicePixelRatio||1;const cw=Math.round(size.value[0]*dpr),ch=Math.round(size.value[1]*dpr);if(target.width!==cw)target.width=cw;if(target.height!==ch)target.height=ch;const ctx=target.getContext('2d');if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#060b14';ctx.fillRect(0,0,...size.value);
  const image=raster.value||(loading.value&&planeState.value.plane&&lastRasterVolume===props.volume&&lastRasterPlane===planeKey(props.plane)?lastRaster:null),g=geometry.value;if(image){if(lastRaster!==image){offscreen.width=image.width;offscreen.height=image.height;const oc=offscreen.getContext('2d')!,buffer=oc.createImageData(image.width,image.height);buffer.data.set(image.pixels);oc.putImageData(buffer,0,0);lastRaster=image;lastRasterPlane=planeKey(props.plane);lastRasterVolume=props.volume;}ctx.imageSmoothingEnabled=false;ctx.drawImage(offscreen,g.left,g.top,g.nx*g.dx*g.scale,g.ny*g.dy*g.scale);}
  if(!planeState.value.plane)return;
  const crosshair=props.crosshair??physicalPoint(props.point,props.grid),pixel=mprWorldToPixel(props.plane,crosshair),cross=pixelScreen(pixel.pixel),left=pixelScreen([-.5,-.5])[0],right=pixelScreen([g.nx-.5,-.5])[0],top=pixelScreen([-.5,g.ny-.5])[1],bottom=pixelScreen([-.5,-.5])[1];ctx.strokeStyle=props.interactiveEnabled?'#d9e4ef90':'#65b5e890';ctx.lineWidth=1;ctx.setLineDash(Math.abs(pixel.distance)>1e-5?[3,3]:[]);ctx.beginPath();ctx.moveTo(left,cross[1]);ctx.lineTo(right,cross[1]);ctx.moveTo(cross[0],top);ctx.lineTo(cross[0],bottom);ctx.stroke();ctx.setLineDash([]);
  paintMeasurements(ctx);
  paintContours(ctx);
  paintBrush(ctx);
  paintInteractive(ctx);
  paintReferenceLines(ctx);
}
function referenceSections(){if(!props.referenceLines?.length)return[];try{return resliceProjectReferenceLines(props.referenceLines,props.plane);}catch{return[];}}
function paintReferenceLines(ctx:CanvasRenderingContext2D){for(const line of referenceSections()){const points=line.points.map(worldScreen);ctx.save();ctx.strokeStyle=line.color;ctx.fillStyle=line.color;ctx.lineWidth=1.5;strokePath(ctx,points);if(points.length===1){ctx.beginPath();ctx.arc(...points[0]!,3,0,Math.PI*2);ctx.fill();}if(line.label&&points.length){ctx.font='11px Segoe UI,Microsoft YaHei';ctx.textAlign='left';ctx.fillText(line.label,points[0]![0]+6,points[0]![1]-6);}ctx.restore();}}
function paintContours(ctx:CanvasRenderingContext2D){
  const draft=visibleContourDraft.value,local=contourLease?.tool==='lasso'&&contourCurrent(contourLease)?localLasso.value:[];if(!draft&&!local.length)return;
  const finite=(point:Vec3)=>point.length===3&&point.every(Number.isFinite);ctx.save();ctx.strokeStyle='#ffe17b';ctx.fillStyle='#ffe17b';ctx.lineWidth=2;
  if(local.length)strokePath(ctx,local.filter(finite).map(worldScreen));
  if(draft){strokePath(ctx,draft.points.filter(finite).map(worldScreen));ctx.setLineDash([4,3]);ctx.strokeStyle='#75d8ff';strokePath(ctx,draft.hover.filter(finite).map(worldScreen));ctx.setLineDash([]);for(const anchor of draft.anchors.filter(finite)){ctx.beginPath();ctx.arc(...worldScreen(anchor),3.5,0,Math.PI*2);ctx.fill();}}
  ctx.restore();
}
function paintBrush(ctx:CanvasRenderingContext2D){
  if(!brush.value||!props.allowEdit||!cursor.value||ctrlHeld.value&&props.interactiveEnabled||gesture?.kind==='interactive-mpr')return;
  const config=brushSize.value;if(!config)return;const preview=brushResizePreview.value??config,[x,y]=worldScreen(cursor.value),w=preview.width*geometry.value.scale,h=preview.height*geometry.value.scale;
  ctx.save();ctx.strokeStyle=props.tool==='erase'?'#ffb0a0':'#ffe17b';ctx.lineWidth=1.3;ctx.setLineDash([4,3]);
  if(config.shape==='square')ctx.strokeRect(x-w/2,y-h/2,w,h);else{ctx.beginPath();ctx.ellipse(x,y,w/2,h/2,0,0,Math.PI*2);ctx.stroke();}
  ctx.setLineDash([]);if(brushResizePreview.value){ctx.fillStyle='#ffe17b';ctx.font='11px Segoe UI,Microsoft YaHei';ctx.fillText(`${preview.width.toFixed(2)} × ${preview.height.toFixed(2)} mm`,x+w/2+8,y-h/2-5);}ctx.restore();
}
function paintInteractive(ctx:CanvasRenderingContext2D){if(!ctrlHeld.value&&gesture?.kind!=='interactive-mpr')return;const overlay=interactiveOverlay();if(!overlay)return;const reach=Math.hypot(...size.value)*2;ctx.save();ctx.strokeStyle='#45a6ff';ctx.fillStyle='#45a6ff';ctx.lineWidth=2;for(const axis of overlay.axes){const [x,y]=overlay.center,[dx,dy]=axis.directionScreen;strokePath(ctx,[[x-dx*reach,y-dy*reach],[x+dx*reach,y+dy*reach]]);}ctx.beginPath();ctx.arc(...overlay.center,5,0,Math.PI*2);ctx.fill();ctx.font='11px Segoe UI,Microsoft YaHei';ctx.textAlign='left';ctx.fillText('Ctrl：拖蓝轴旋转，拖中心平移；松开提交',10,size.value[1]-12);ctx.restore();}
function strokePath(ctx:CanvasRenderingContext2D,points:[number,number][],closed=false){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));if(closed)ctx.closePath();ctx.stroke();}
function paintDensity(ctx:CanvasRenderingContext2D,kind:DensityROIKind,points:DensityROIPoints,color:string,label:string){ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1.5;strokePath(ctx,densityROIOutline(kind,points,roiPlane).map(pixelScreen),true);for(const marker of densityROIMarkers(kind,points,roiPlane)){const p=pixelScreen(marker.point);ctx.fillRect(p[0]-3,p[1]-3,6,6);}const p=pixelScreen(points[0]);ctx.font='12px Segoe UI,Microsoft YaHei';ctx.textAlign='left';ctx.fillText(label,p[0]+9,p[1]-10);}
function draftGeometry(){
  const points=props.draftPoints??[];if(!points.length||!samePlane(props.draftPlane??undefined))return null;
  if(props.tool!=='ellipse'||!cursor.value||points.length>2)return{outline:points.map(worldScreen),lines:[] as string[],anchor:points[0],closed:false};
  let world:Vec3[];
  if(points.length===1){const first=points[0],second=cursor.value,delta=second.map((v,k)=>v-first[k]) as Vec3,a=Math.hypot(...delta)/2;if(a<=1e-9)return{outline:[worldScreen(first)],lines:['移动设置另一长轴端点'],anchor:first,closed:false};const center=first.map((v,k)=>(v+second[k])/2) as Vec3,normal=mprPlaneNormal(props.plane),perp:Vec3=[normal[1]*delta[2]-normal[2]*delta[1],normal[2]*delta[0]-normal[0]*delta[2],normal[0]*delta[1]-normal[1]*delta[0]],length=Math.hypot(...perp);world=[first,second,center.map((v,k)=>v+perp[k]/length*a/2) as Vec3];}
  else world=[points[0],points[1],cursor.value];
  return{outline:ellipseOutline(world).map(worldScreen),lines:[...resultLines('ellipse',world),points.length===1?'暂定短半轴为长半轴的一半；再点固定长轴':'移动定义短轴，第三次点击确认（本应用约定）'],anchor:world[0],closed:true};
}
function paintMeasurements(ctx:CanvasRenderingContext2D){
  for(const item of measurementItems()){
    const {m,points,screen,outline,handles,annotation,label,lines}=item;
    if(annotation){paintCanvasAnnotation(ctx,annotation,m.color);continue;}
    ctx.strokeStyle=m.color;ctx.fillStyle=m.color;ctx.lineWidth=1.5;
    if(m.kind==='diameter'&&points.length===3){const result=evaluateMeasurement('diameter',points);if(result.valid){ctx.beginPath();ctx.arc(...worldScreen(result.details.center as Vec3),Number(result.details.radius)*geometry.value.scale,0,Math.PI*2);ctx.stroke();}}else strokePath(ctx,outline,m.kind==='area'||m.kind==='ellipse');
    if(m.kind==='ellipse'){ctx.save();ctx.setLineDash([3,3]);strokePath(ctx,handles.filter(handle=>handle.kind==='rotate').map(handle=>handle.screen),true);ctx.restore();}
    for(const handle of handles){const [x,y]=handle.screen;if(handle.kind==='rotate')ctx.strokeRect(x-3,y-3,6,6);else if(handle.kind==='move'){ctx.strokeRect(x-4,y-4,8,8);strokePath(ctx,[[x-6,y],[x+6,y]]);strokePath(ctx,[[x,y-6],[x,y+6]]);}else{ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}}
    ctx.font='12px Segoe UI,Microsoft YaHei';ctx.textAlign='left';lines.forEach((line,i)=>ctx.fillText(line,label.x,label.y+i*16));
  }
  for(const item of densityItems())paintDensity(ctx,item.kind,item.points,item.m.color,(props.measurementLabels[item.m.id]||item.m.name)+(densityPreview.value?.id===item.m.id?' · 松开更新':''));
  for(const {m,shape} of affineDensityItems()){const outline=shape.outline.map(worldScreen);ctx.strokeStyle=m.color;ctx.fillStyle=m.color;ctx.lineWidth=1.5;strokePath(ctx,outline,true);for(const marker of shape.markers){const p=worldScreen(marker.point);ctx.fillRect(p[0]-3,p[1]-3,6,6);}ctx.font='12px Segoe UI,Microsoft YaHei';ctx.textAlign='left';ctx.fillText((props.measurementLabels[m.id]||m.name)+(affineDensityPreview.value?.id===m.id?' · 松开更新':''),outline[0]![0]+9,outline[0]![1]-10);}
  if(densityPreview.value&&!densityPreview.value.id)paintDensity(ctx,densityPreview.value.kind,densityPreview.value.points,'#ffe17b','松开后计算密度');
  const draft=draftGeometry();if(draft){ctx.strokeStyle='#ffe17b';ctx.fillStyle='#ffe17b';ctx.lineWidth=2;strokePath(ctx,draft.outline,draft.closed);for(const world of props.draftPoints??[]){const p=worldScreen(world);ctx.beginPath();ctx.arc(...p,3,0,Math.PI*2);ctx.fill();}const p=worldScreen(draft.anchor);ctx.font='12px Segoe UI,Microsoft YaHei';draft.lines.forEach((line,i)=>ctx.fillText(line,p[0]+10,p[1]-10+i*16));}
}
watch([()=>props.volume,()=>props.grid,()=>props.revision,()=>props.mprRevision,()=>planeKey(props.plane),()=>props.interpolation,()=>props.tool,()=>props.allowEdit,()=>props.densitySize?.[0],()=>props.densitySize?.[1]],()=>cancelPointer(),{flush:'sync'});
watch(()=>props.measurements,()=>{if(gesture&&!gestureCurrent(gesture))cancelPointer();if(areaMenu.value&&!props.measurements.some(m=>m.id===areaMenu.value!.id&&signature(m)===areaMenu.value!.signature))areaMenu.value=null;},{flush:'sync'});
watch(()=>JSON.stringify(props.measurements.filter(m=>m.densityPlane).map(m=>[m.id,signature(m)])),()=>{if(gesture?.kind==='affine-density'&&!gestureCurrent(gesture))cancelPointer();},{flush:'sync'});
watch(interactiveKey,()=>{if(gesture?.kind==='interactive-mpr')cancelPointer();schedule();},{flush:'sync'});
watch(brushKey,()=>{if(gesture?.kind==='brush'||gesture?.kind==='resize-brush')cancelPointer();schedule();},{flush:'sync'});
watch(()=>props.masks.map(mask=>[mask.id,mask,mask.data,mask.revision]),()=>{if(gesture&&(gesture.kind==='brush'||gesture.kind==='resize-brush')&&!gestureCurrent(gesture))cancelPointer();},{flush:'sync'});
watch([()=>props.activeMaskId,()=>props.contourSettingsKey,()=>props.masks.map(mask=>[mask.id,mask,mask.data,mask.revision,mask.visible])],()=>{if(contourLease&&!contourCurrent(contourLease))cancelPointer();},{flush:'sync'});
watch(()=>props.contourDraft,(draft,previous)=>{if(contourLease&&(draft&&!matchingContourDraft(contourLease)||!draft&&previous?.sessionId===contourLease.sessionId))cancelPointer();schedule();},{flush:'sync'});
watch(loading,value=>{if(value&&gesture?.kind==='brush')cancelPointer();},{flush:'sync'});
watch([raster,loading,()=>props.point,()=>props.crosshair,()=>props.measurements,()=>props.measurementLabels,()=>props.draftPoints,()=>props.draftPlane,()=>props.contourDraft,()=>props.referenceLines,zoom,pan,ctrlHeld],schedule);
onMounted(()=>{observer=new ResizeObserver(entries=>{cancelPointer();size.value=[Math.max(1,entries[0].contentRect.width),Math.max(1,entries[0].contentRect.height)];schedule();});observer.observe(host.value!);window.addEventListener('keydown',controlKey);window.addEventListener('keyup',controlKey);window.addEventListener('blur',controlBlur);schedule();});
onBeforeUnmount(()=>{cancelPointer();sampler.dispose();observer?.disconnect();cancelAnimationFrame(frame);window.removeEventListener('keydown',controlKey);window.removeEventListener('keyup',controlKey);window.removeEventListener('blur',controlBlur);});
</script>

<template>
  <section class="mpr-viewport" data-slice-space="mpr-world" :data-view-id="viewId" :aria-busy="loading">
    <header><b>MPR {{(viewId??0)+1}} · 物理平面重采样</b><span>{{interpolation==='nearest'?'Nearest':'Linear'}} · {{plane.size[0]}} × {{plane.size[1]}}</span><button @click="reset">适配</button></header>
    <div ref="host" class="canvas-host" @keydown="key"><canvas ref="canvas" tabindex="0" :title="hoverText" :style="{cursor:cursorStyle}" aria-label="任意物理平面 MPR，滚轮沿法线移动，Ctrl 滚轮缩放，右键平移，Shift 左键世界定位，右击 Area 控制点增删" @pointerdown="down" @pointermove="move" @pointerup="end" @pointercancel="cancelPointer" @lostpointercapture="cancelPointer" @pointerleave="leaveCanvas" @contextmenu.prevent="!gesture&&openAreaMenu($event)" @dblclick="doubleClick" @wheel.prevent="wheel"/><div v-if="areaMenu" class="mpr-point-menu" role="menu" aria-label="MPR Area 控制点" :style="{left:`${areaMenu.x}px`,top:`${areaMenu.y}px`}" @pointerdown.stop @contextmenu.prevent><button role="menuitem" @click="editAreaPoint('add')">Add Point · 添加点</button><button role="menuitem" :disabled="areaMenu.points.length<=3" @click="editAreaPoint('remove')">Remove Point · 删除点</button><small>添加在下一条边中点，可再拖动；至少保留三点。</small></div><div v-if="loading" class="mpr-loading" role="status">正在重采样…</div><div v-if="contourHint" class="mpr-contour-hint">{{contourHint}}</div><div v-if="error" class="mpr-error" role="alert">{{error}}</div></div>
    <footer><span>{{cursor?cursor.map(v=>v.toFixed(2)).join(', '):'—'}} mm · 世界坐标</span><span>滚动 {{step}} mm · Mask nearest</span></footer>
  </section>
</template>

<style scoped>
.mpr-viewport{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid #42617d;border-radius:7px;overflow:hidden;background:#060b14;color:#a9bdd3;font:11px Segoe UI,Microsoft YaHei}.mpr-viewport header{display:flex;align-items:center;gap:12px;padding:7px 10px;background:#132638}.mpr-viewport header b{color:#a9d1ed}.mpr-viewport button{margin-left:auto;background:#1c3349;border:1px solid #46627e;border-radius:4px;color:#c5d8e9;padding:2px 7px;font:inherit;cursor:pointer}.canvas-host{position:relative;flex:1;min-height:100px}.canvas-host canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}.mpr-viewport footer{display:flex;gap:10px;justify-content:space-between;padding:6px 9px;background:#102030;font:10px Consolas,Microsoft YaHei}.mpr-error{position:absolute;left:10px;right:10px;bottom:10px;background:#48252de8;color:#ffd2c7;border:1px solid #9a5b62;padding:7px;font-size:11px;pointer-events:none}
.mpr-loading{position:absolute;top:8px;left:9px;padding:4px 7px;border-radius:4px;background:#162b42dd;color:#b7cee3;pointer-events:none}.mpr-point-menu{position:absolute;z-index:3;box-sizing:border-box;width:175px;padding:5px;background:#14263ced;border:1px solid #56789d;border-radius:5px;box-shadow:0 5px 15px #0008}.mpr-point-menu button{display:block;width:100%;margin:0;padding:6px;border:0;background:transparent;text-align:left}.mpr-point-menu button:hover{background:#294762}.mpr-point-menu button:disabled{opacity:.4;cursor:default}.mpr-point-menu small{display:block;padding:5px;color:#93adc9;font:10px/1.6 Segoe UI,Microsoft YaHei}
.mpr-contour-hint{position:absolute;bottom:7px;left:9px;right:9px;color:#c3d9eb;font-size:10px;pointer-events:none;text-shadow:0 1px 3px #000}
</style>
