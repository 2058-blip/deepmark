<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {Volume} from '../core.ts';
import { computeNormals, createMeshPicker, meshStats, type MeshPicker } from './geometry.ts';
import { evaluateMeasurement } from './measurements.ts';
import type { MeasurementObject, MprPlane, PartObject, TriangleMesh, Vec3 } from './types.ts';
import { cameraRotation, rotateCameraVector, projectCameraPoint, cameraPickRay, fitCameraHalfHeight, cameraClipMatrix } from './viewportGeometry.ts';
import { annotationLayout, annotationLabelHit, allowsMeasurementLabels, allowsMeasurementHandle, type AnnotationLayout } from './annotationLayout.ts';
import {measurementPointPartId,measurementPartIds} from './measurementAttachments.ts';
import {ellipseFrame,ellipsePoints,ellipseHandles,moveEllipse,resizeEllipse,rotateEllipse,measurementLabelPosition,type EllipseFrame,type EllipseHandleId} from './ellipseGeometry.ts';
import {validateMprPlane} from './mpr.ts';
import {reslicePlaneFrame,reslicePlaneHandles,translateReslicePlane,rotateReslicePlane,resizeReslicePlane} from './resliceGizmo.ts';
import type {ResliceProjectPoint} from './resliceProjectTypes.ts';

const props = defineProps<{
  parts: PartObject[]; revision?: number; volume?:Volume; selectedId?: string; spatialUnit?: string; allowEdit?: boolean; tool?: string;
  measurements?: MeasurementObject[]; measurementLabels?: Record<string, string>;
  pendingPoints?: Vec3[]; measurementDraftToken?:number; selectedMeasurementId?: string;
  overlayLines?: { id: string; points: Vec3[]; color: string; label?: string }[];
  reslicePlane?:MprPlane; resliceMode?:'view'|'rotate'|'resize'; resliceId?:string; resliceRevision?:number;
  referencePointToken?:number;
}>();
const emit = defineEmits<{
  select: [id: string]; pick: [hit: { partId: string; position: Vec3 }];
  selectMeasurement: [id: string]; moveMeasurementPoint: [change: { id: string; index: number; position: Vec3;volume?:Volume;revision?:number }];
  editMeasurement: [id: string];
  updateMeasurementGeometry: [change:{id:string;points:Vec3[];volume?:Volume;revision?:number}];
  previewMeasurementGeometry: [change:{id:string;points:Vec3[];volume?:Volume;revision?:number}|null];
  updateMeasurementLabel: [change:{id:string;offset:Vec3;volume?:Volume;revision?:number}];
  completeEllipseCreation:[change:{position:Vec3;draftToken:number;volume?:Volume;revision?:number}];
  updateReslicePlane:[change:{id:string;plane:MprPlane;action:'move'|'rotate'|'resize';volume?:Volume;revision:number;resliceRevision:number}];
  referencePoint:[ResliceProjectPoint];
}>();
const canvas = ref<HTMLCanvasElement>(), host = ref<HTMLDivElement>();
const unavailable = ref(''), wireframe = ref(false), dragging = ref(false);
const hoveredAnnotation=ref('');
const visibleCount = computed(() => props.parts.filter(p => p.visible && p.opacity > 0).length);
const triangleCount = computed(() => props.parts.filter(p => p.visible).reduce((s, p) => s + p.mesh.indices.length / 3, 0));
const overlaySize = ref<[number, number]>([1, 1]), cameraRevision = ref(0);
type GL = WebGLRenderingContext | WebGL2RenderingContext;
interface GPUObject { part: PartObject; positions: WebGLBuffer; normals: WebGLBuffer; edges: WebGLBuffer; count: number; edgeCount: number; centre: Vec3 }
let gl: GL | null = null, program: WebGLProgram | null = null, observer: ResizeObserver | undefined;
let gpu: GPUObject[] = [], frame = 0, destroyed = false;
const pickers = new Map<string, { mesh: TriangleMesh; revision?: number; picker: MeshPicker }>();
let centre: Vec3 = [0, 0, 0], radius = 1, halfHeight = 1.3, pan: [number, number] = [0, 0];
let pitch = -0.5, yaw = 0.55, cssWidth = 1, cssHeight = 1;
let positionLocation = -1, normalLocation = -1;
let matrixLocation: WebGLUniformLocation | null = null, rotationLocation: WebGLUniformLocation | null = null;
let colorLocation: WebGLUniformLocation | null = null, unlitLocation: WebGLUniformLocation | null = null;
interface CreationEpoch {token:number;volume?:Volume;revision?:number;pendingKey:string;stage:number;tool?:string;allowEdit:boolean}
interface ReferenceEpoch {token:number;volume?:Volume;revision?:number;tool?:string;allowEdit:boolean}
let pointer: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean; pan: boolean;creation?:CreationEpoch;reference?:ReferenceEpoch } | null = null;
const pointers = new Map<number, { x: number; y: number }>();
let pinch = 0;
interface GestureSnapshot { measurement:MeasurementObject; collection:MeasurementObject[]|undefined; points:Vec3[]; sources:string; volume?:Volume; revision?:number }
interface CapturedGesture extends GestureSnapshot { pointerId:number; id:string; element:SVGElement }
let measurementDrag: (CapturedGesture & { index:number;partId:string;original:Vec3 }) | null = null;
let ellipseDrag: (CapturedGesture & {handleId:EllipseHandleId;start:Vec3;center:Vec3;normal:Vec3;moved:boolean})|null=null;
let labelDrag: (CapturedGesture & {start:Vec3;anchor:Vec3;normal:Vec3;offset:Vec3})|null=null;
interface ResliceGesture {
  pointerId:number; element:SVGElement; id:string; object:MprPlane; plane:MprPlane; planeKey:string;
  frame:ReturnType<typeof reslicePlaneFrame>; start:Vec3; anchor:Vec3; camera:ReturnType<typeof camera>;
  handleId:string; action:'move'|'rotate'|'resize'; mode:'rotate'|'resize'; tool?:string; volume?:Volume; revision:number; resliceRevision:number;
}
let resliceDrag:ResliceGesture|null=null;
const temporaryReslicePlane=ref<MprPlane>();
const temporaryPoint = ref<{ id: string; index: number; position: Vec3 }>();
const temporaryGeometry=ref<{id:string;points:Vec3[]}>(),temporaryLabel=ref<{id:string;offset:Vec3}>();
let creationPlane:(EllipseFrame&{epoch:CreationEpoch;ends:[Vec3,Vec3]})|undefined,creationBlocked:CreationEpoch|undefined;
const creationPreview=ref<{points:Vec3[];stage:1|2;provisional:boolean;reason?:string}>();
const interactionHint = computed(() => {
  if(projectedReslice.value?.editable)return props.resliceMode==='resize'
    ? 'RP 尺寸 · 拖动红色边角控点调整物理宽高 · 松开提交 · Esc 取消'
    : 'RP 旋转 · 角点绕平面法线旋转 / 中心沿平面移动 · 松开提交 · Esc 取消';
  if(props.tool==='ellipse'&&props.allowEdit!==false){
    if(props.pendingPoints?.length===2)return '移动鼠标调整短轴 · 第三次点击确认冻结平面上的椭圆 · Esc 取消';
    if(props.pendingPoints?.length===1)return '在表面点击长轴第二端 · 悬停预览短半轴暂按长半轴一半显示 · Esc 取消';
    return '在 Part 表面点击椭圆长轴第一端';
  }
  if(temporaryGeometry.value)return '椭圆平面内调整 · 轴端缩放 / 角点旋转 / 中心移动 · 松开提交 · Esc 取消';
  if(temporaryLabel.value)return '拖拽测量标签 · 世界坐标偏移 · 松开提交 · Esc 取消';
  if (!temporaryPoint.value) return '拖动旋转 · Shift / 右键平移 · 滚轮缩放 · 点击表面拾取';
  return props.measurements?.find(m => m.id === temporaryPoint.value!.id)?.kind === 'surface-distance'
    ? '沿 Part 表面拖拽约束 · 虚线为约束预览 · 松开重新计算路径 · Esc 取消'
    : '沿 Part 表面拖拽控制点 · 松开提交 · Esc 取消';
});

interface ProjectedMeasurement {
  id: string; color: string; selected: boolean; points: [number, number][];
  handles: { index: number; point: [number, number];partId:string|null;canDrag:boolean }[];
  path: string; arc: string; preview: string; label: string; shortLabel: string; labelX: number; labelY: number;
  labelWidth: number; leader: string; canDrag: boolean; canSelect: boolean; canInteractLabel: boolean; annotation: boolean;
  annotationLabel?: AnnotationLayout;
  ellipseHandles:{id:EllipseHandleId;kind:string;point:[number,number]}[];ellipseBox:string;
  lines:string[];labelHeight:number;
}
function project(p: Vec3): [number, number] {
  return projectCameraPoint(p, camera());
}
function camera() { return { center: centre, rotation: rotation(), halfHeight, width: cssWidth, height: cssHeight, pan }; }
function svgPath(points: [number, number][], close = false): string {
  return points.length ? points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ') + (close ? ' Z' : '') : '';
}
function worldCurve(m: MeasurementObject): Vec3[] {
  const p = m.points;
  if (m.kind === 'diameter' && p.length === 3) {
    const result = evaluateMeasurement('diameter', p);
    const c = result.details.center as Vec3 | undefined;
    if (result.valid && c) {
      const u = minus(p[0]!, c), n = cross(minus(p[1]!, p[0]!), minus(p[2]!, p[0]!));
      const len = Math.hypot(...n); if (len < 1e-12) return p;
      const v = cross(n.map(x => x / len) as Vec3, u);
      return Array.from({ length: 65 }, (_, i) => c.map((x, k) => x + u[k]! * Math.cos(i * Math.PI / 32) + v[k]! * Math.sin(i * Math.PI / 32)) as Vec3);
    }
  }
  if (m.kind === 'ellipse' && p.length === 3) {
    try{const f=ellipseFrame(p);return Array.from({length:65},(_,i)=>f.center.map((x,k)=>x+f.a*f.u[k]!*Math.cos(i*Math.PI/32)+f.b*f.v[k]!*Math.sin(i*Math.PI/32)) as Vec3);}catch{return p;}
  }
  return p;
}
function angleArc(m: MeasurementObject): Vec3[] {
  if (m.kind !== 'angle' || m.points.length !== 3) return [];
  const [a, c, b] = m.points, u = minus(a!, c!), v = minus(b!, c!);
  const lu = Math.hypot(...u), lv = Math.hypot(...v); if (lu < 1e-10 || lv < 1e-10) return [];
  const x = u.map(n => n / lu) as Vec3, y0 = v.map(n => n / lv) as Vec3;
  const cosine = Math.max(-1, Math.min(1, dot(x, y0))), y = y0.map((n, k) => n - cosine * x[k]!) as Vec3, ly = Math.hypot(...y);
  if (ly < 1e-10) return [];
  const theta = Math.acos(cosine), radius = Math.min(lu, lv) * 0.22;
  return Array.from({ length: 25 }, (_, i) => c!.map((n, k) => n + radius * (x[k]! * Math.cos(theta * i / 24) + y[k]! / ly * Math.sin(theta * i / 24))) as Vec3);
}
function attachmentsVisible(measurement:MeasurementObject){return measurementPartIds(measurement).every(id=>props.parts.some(part=>part.id===id&&part.visible&&part.opacity>0));}
function handlePartId(measurement:MeasurementObject,index:number){return measurement.kind==='surface-distance'?measurement.partId??null:measurementPointPartId(measurement,index);}
function previewLines(measurement:MeasurementObject):string[]{
  if(measurement.kind!=='area'&&measurement.kind!=='ellipse')return[props.measurementLabels?.[measurement.id]??measurement.name];
  const result=evaluateMeasurement(measurement.kind,measurement.points);
  if(!result.valid)return[`预览无效 · ${result.reason}`];
  const n=(key:string)=>Number(result.details[key]).toFixed(2);
  return measurement.kind==='ellipse'?[`预览 · D1 ${n('D1')} mm · D2 ${n('D2')} mm · E ${n('E')}`,`P ${n('P')} mm · A ${n('A')} mm²`,`DP ${n('DP')} mm · DA ${n('DA')} mm`]:[`预览 · A ${result.value.toFixed(2)} mm² · P ${n('perimeter')} mm`,`Da ${n('Da')} mm · Dp ${n('Dp')} mm`,`Lmax ${n('Lmax')} mm · L ${n('L')} mm`];
}
const projectedMeasurements = computed<ProjectedMeasurement[]>(() => {
  cameraRevision.value;
  // A moved surface constraint does not solve a new path. Keep its previous dense result
  // solid and render only a dashed constraint preview until the parent recomputes on drop.
  const shown = (props.measurements ?? []).map(m => ({...m,points:temporaryGeometry.value?.id===m.id?temporaryGeometry.value.points:temporaryPoint.value?.id === m.id && m.kind !== 'surface-distance' ? m.points.map((p, i) => i === temporaryPoint.value!.index ? temporaryPoint.value!.position : p):m.points,...(temporaryLabel.value?.id===m.id?{labelOffset:temporaryLabel.value.offset}:{})}));
  // Density corners define an image ROI, not a line between two Part points.
  return shown.filter(m => m.kind !== 'density-rectangle' && m.kind !== 'density-ellipse' && m.visible && m.points.length && m.points.every(p => p.length === 3 && p.every(Number.isFinite)) && attachmentsVisible(m)).map(m => {
    const points = m.points.map(project), pathPoints = worldCurve(m).map(project), arc = svgPath(angleArc(m).map(project));
    const annotation = m.kind === 'annotation',live=(temporaryGeometry.value?.id===m.id||temporaryPoint.value?.id===m.id)&&(m.kind==='area'||m.kind==='ellipse');
    const lines=live?previewLines(m):[annotation?m.text??m.name:props.measurementLabels?.[m.id]??m.name],label=lines.join('\n');
    const annotationLabel = annotation ? annotationLayout(points[0]!,label,m.annotationStyle,{viewport:[cssWidth,cssHeight],labelPoint:points[1]}) : undefined;
    const shortLabel = annotationLabel?.displayText ?? (label.length > 70 ? label.slice(0, 69) + '…' : label);
    const labelWidth = annotationLabel?.width ?? Math.max(1, Math.min(cssWidth - 10, Math.max(66,...lines.map(line=>[...line].reduce((w,c)=>w+(c.charCodeAt(0)>255?11:6.5),16)))));
    const anchor = project(measurementLabelPosition(m)),labelHeight=annotationLabel?.height??(23+(lines.length-1)*16);
    const labelX = annotationLabel?.x ?? Math.max(5, Math.min(cssWidth - labelWidth - 5, anchor[0]! + 10));
    const labelY = annotationLabel?.y ?? Math.max(20, Math.min(cssHeight - labelHeight-7, anchor[1]! - 12));
    const leader = annotationLabel ? svgPath(annotationLabel.leader) : '';
    const surface = m.kind === 'surface-distance', hasConstraints = surface && !!m.controlPoints?.length;
    let handles = m.kind==='ellipse'?[]:hasConstraints ? m.controlPoints!.map((point, index) => ({ index, point: project(point) })) : surface && points.length > 2 ? [0, points.length - 1].map(index => ({ index, point: points[index]! })) : points.map((point, index) => ({ index, point }));
    let preview = '';
    if (surface && temporaryPoint.value?.id === m.id) {
      handles = handles.map(handle => handle.index === temporaryPoint.value!.index ? { ...handle, point: project(temporaryPoint.value!.position) } : handle);
      preview = svgPath(handles.map(handle => handle.point));
    }
    const canSelect=props.allowEdit!==false&&allowsMeasurementHandle(props.tool,m.kind),canInteractLabel=props.allowEdit!==false&&allowsMeasurementLabels(props.tool);
    let shapeHandles:ProjectedMeasurement['ellipseHandles']=[];
    if(m.kind==='ellipse')try{shapeHandles=ellipseHandles(m.points).map(handle=>({id:handle.id,kind:handle.kind,point:project(handle.position)}));}catch{/* A rejected degenerate preview retains its label reason. */}
    const ellipseBox=svgPath(shapeHandles.filter(handle=>handle.kind==='rotate').map(handle=>handle.point),true);
    const attachedHandles=handles.map(handle=>{const partId=handlePartId(m,handle.index);return{...handle,partId,canDrag:!!partId&&canSelect};});
    return { id: m.id, color: m.color, points, handles:attachedHandles,ellipseHandles:shapeHandles,ellipseBox,lines,labelHeight, arc, preview, path: annotation ? '' : svgPath(pathPoints, m.kind === 'area' && points.length > 2), label, shortLabel, labelX, labelY, labelWidth, leader, canDrag: attachedHandles.some(handle=>handle.canDrag), canSelect, canInteractLabel, selected: m.id === props.selectedMeasurementId, annotation, annotationLabel };
  });
});
const projectedPending = computed(() => { cameraRevision.value; return (props.pendingPoints ?? []).map(project); });
const projectedCreation=computed(()=>{
  cameraRevision.value;const preview=creationPreview.value;if(!preview)return;
  const measurement:MeasurementObject={id:'pending-ellipse',name:'椭圆创建预览',kind:'ellipse',points:preview.points,visible:true,color:'#ffe2a4'},result=evaluateMeasurement('ellipse',preview.points),lines=preview.reason?[`预览无效 · ${preview.reason}`]:previewLines(measurement),frame=result.valid?ellipseFrame(preview.points):undefined;
  const anchor=project(frame?.center??preview.points[0]!),width=Math.max(1,Math.min(cssWidth-12,Math.max(220,...lines.map(line=>[...line].length*7+14))));
  return{path:svgPath(worldCurve(measurement).map(project),result.valid),axis:svgPath(preview.points.slice(0,2).map(project)),points:preview.points.map(project),lines,valid:result.valid&&!preview.reason,stage:preview.stage,hint:preview.provisional?'应用预览约定：短半轴暂为长半轴的一半':preview.stage===2?'短轴来自冻结物理平面 · 点击确认':'点击表面确定长轴第二端',x:Math.max(6,Math.min(cssWidth-width-6,anchor[0]+10)),y:Math.max(20,Math.min(cssHeight-78,anchor[1]-14)),width};
});
const projectedOverlayLines = computed(() => {
  cameraRevision.value;
  return (props.overlayLines ?? []).filter(line => line.points.length > 1 && line.points.every(p => p.length === 3 && p.every(Number.isFinite))).map(line => {
    const points = line.points.map(project); return { ...line, path: svgPath(points), end: points[points.length - 1]! };
  });
});
function canEditReslice(){return props.allowEdit!==false&&!!props.resliceId&&(props.resliceMode==='rotate'||props.resliceMode==='resize')&&(props.tool===undefined||props.tool==='navigate'||props.tool==='select');}
const projectedReslice=computed(()=>{
  cameraRevision.value;
  const plane=temporaryReslicePlane.value??props.reslicePlane;if(!plane)return;
  try{
    const frame=reslicePlaneFrame(plane),center=project(frame.center),corners=frame.corners.map(project),editable=canEditReslice();
    const handles=editable?reslicePlaneHandles(plane,props.resliceMode as 'rotate'|'resize').map(handle=>{
      const point=project(handle.position),angle=Math.atan2(point[1]-center[1],point[0]-center[0]);
      const cursor=handle.kind==='move'?'move':handle.kind==='rotate'?'crosshair':(['ew-resize','nwse-resize','ns-resize','nesw-resize'][((Math.round(angle/(Math.PI/4))%4)+4)%4]);
      return{...handle,point,cursor,label:handle.kind==='move'?'中心移动':handle.kind==='rotate'?'平面法线旋转':'物理宽高调整'};
    }):[];
    return{path:svgPath(corners,true),corners,center,handles,editable,resize:props.resliceMode==='resize',label:`RP${props.resliceMode==='resize'?' · Resize':props.resliceMode==='rotate'?' · Rotate':''}`};
  }catch{return;}
});
const orientationAxes = computed(() => {
  cameraRevision.value; const r = rotation();
  return ([{ name: 'X', vector: [1, 0, 0], color: '#ee8e81' }, { name: 'Y', vector: [0, 1, 0], color: '#84d4a1' }, { name: 'Z', vector: [0, 0, 1], color: '#83b8f0' }] as { name: string; vector: Vec3; color: string }[]).map(axis => {
    const p = rotate(axis.vector, r); return { ...axis, x: p[0] * 24, y: -p[1] * 24, depth: p[2] };
  }).sort((a, b) => a.depth - b.depth);
});

// Column-major Y * X rotation, used by GPU rendering and the exact inverse picking ray.
function rotation(): number[] { return cameraRotation(pitch, yaw); }
function rotate(v: Vec3, r: number[]): Vec3 { return rotateCameraVector(v, r); }
function schedule() { if (!frame && !destroyed) frame = requestAnimationFrame(render); }
function shader(kind: number, source: string): WebGLShader {
  const s = gl!.createShader(kind); if (!s) throw new Error('无法建立 WebGL shader。');
  gl!.shaderSource(s, source); gl!.compileShader(s);
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) { const error = gl!.getShaderInfoLog(s); gl!.deleteShader(s); throw new Error(error ?? 'WebGL shader 编译失败。'); }
  return s;
}
function initialise() {
  if (!canvas.value) return;
  try {
    gl = canvas.value.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    const version2 = !!gl;
    if (!gl) gl = canvas.value.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) { unavailable.value = '当前浏览器未提供 WebGL。请启用硬件加速后重新加载。'; return; }
    const vertex = version2 ? `#version 300 es
      in vec3 aPosition; in vec3 aNormal; uniform mat4 uMatrix; uniform mat3 uRotation; out vec3 vNormal;
      void main(){gl_Position=uMatrix*vec4(aPosition,1.0);vNormal=uRotation*aNormal;}` : `
      attribute vec3 aPosition; attribute vec3 aNormal; uniform mat4 uMatrix; uniform mat3 uRotation; varying vec3 vNormal;
      void main(){gl_Position=uMatrix*vec4(aPosition,1.0);vNormal=uRotation*aNormal;}`;
    const light = `vec3 n=normalize(vNormal); if(!gl_FrontFacing)n=-n;
      float diffuse=max(dot(n,normalize(vec3(-0.35,0.6,0.8))),0.0);
      float rim=pow(1.0-abs(n.z),2.0); vec3 lit=uColor.rgb*(0.27+0.7*diffuse)+vec3(0.07)*rim;
      vec4 color=vec4(mix(lit,uColor.rgb,uUnlit),uColor.a);`;
    const fragment = version2 ? `#version 300 es
      precision highp float; in vec3 vNormal; uniform vec4 uColor; uniform float uUnlit; out vec4 fragColor;
      void main(){${light}fragColor=color;}` : `
      precision highp float; varying vec3 vNormal; uniform vec4 uColor; uniform float uUnlit;
      void main(){${light}gl_FragColor=color;}`;
    const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
    program = gl.createProgram(); if (!program) throw new Error('无法建立 WebGL program。');
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL program 链接失败。');
    positionLocation = gl.getAttribLocation(program, 'aPosition'); normalLocation = gl.getAttribLocation(program, 'aNormal');
    matrixLocation = gl.getUniformLocation(program, 'uMatrix'); rotationLocation = gl.getUniformLocation(program, 'uRotation');
    colorLocation = gl.getUniformLocation(program, 'uColor'); unlitLocation = gl.getUniformLocation(program, 'uUnlit');
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    upload(); resize(); fit(); unavailable.value = '';
  } catch (error) { unavailable.value = error instanceof Error ? error.message : 'WebGL 初始化失败。'; disposeGPU(); }
}
function disposeGPU() {
  if (gl) for (const object of gpu) { gl.deleteBuffer(object.positions); gl.deleteBuffer(object.normals); gl.deleteBuffer(object.edges); }
  gpu = [];
}
function sceneBounds() {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const part of props.parts.filter(p => p.visible && p.opacity > 0)) {
    const p = part.mesh.positions;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[i + k]!); max[k] = Math.max(max[k]!, p[i + k]!); found = true; }
  }
  const hasPartBounds=found;
  if(props.reslicePlane)try{
    for(const p of reslicePlaneFrame(props.reslicePlane).corners)for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,p[k]!);max[k]=Math.max(max[k]!,p[k]!);found=true;}
  }catch{/* Invalid external planes do not corrupt the camera bounds. */}
  if (!hasPartBounds) {
    const points = [...(props.measurements ?? []).filter(m => m.visible && !m.partId).flatMap(m => m.points), ...props.pendingPoints ?? [], ...(props.overlayLines ?? []).flatMap(line => line.points)];
    for (const p of points) if (p.every(Number.isFinite)) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); found = true; }
  }
  return found ? { min, max } : { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
}
function upload() {
  if (!gl || !program) return;
  const bounds = sceneBounds();
  centre = bounds.min.map((v, k) => (v + bounds.max[k]!) / 2) as Vec3;
  radius = Math.max(1e-4, Math.hypot(...bounds.max.map((v, k) => v - bounds.min[k]!)) / 2 || 1);
  disposeGPU();
  for (const id of pickers.keys()) if (!props.parts.some(p => p.id === id)) pickers.delete(id);
  const buffer = (data: Float32Array): WebGLBuffer => {
    const b = gl!.createBuffer(); if (!b) throw new Error('WebGL 顶点缓冲区分配失败。');
    gl!.bindBuffer(gl!.ARRAY_BUFFER, b); gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW); return b;
  };
  for (const part of props.parts) {
    const mesh = part.mesh; if (!mesh.indices.length) continue;
    pickerFor(part);
    const normals = mesh.normals?.length === mesh.positions.length ? mesh.normals : computeNormals(mesh);
    // Expanded triangles avoid Uint32 index-extension restrictions in WebGL 1.
    const vertices = new Float32Array(mesh.indices.length * 3), normalData = new Float32Array(vertices.length), edges = new Float32Array(mesh.indices.length * 6);
    for (let f = 0; f < mesh.indices.length / 3; f++) for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k]!, b = mesh.indices[3 * f + (k + 1) % 3]!;
      for (let axis = 0; axis < 3; axis++) {
        vertices[9 * f + 3 * k + axis] = mesh.positions[3 * a + axis]! - centre[axis]!;
        normalData[9 * f + 3 * k + axis] = normals[3 * a + axis]!;
        edges[18 * f + 6 * k + axis] = mesh.positions[3 * a + axis]! - centre[axis]!;
        edges[18 * f + 6 * k + 3 + axis] = mesh.positions[3 * b + axis]! - centre[axis]!;
      }
    }
    const b = meshStats(mesh).bounds;
    gpu.push({ part, positions: buffer(vertices), normals: buffer(normalData), edges: buffer(edges), count: mesh.indices.length, edgeCount: mesh.indices.length * 2, centre: b.min.map((v, k) => (v + b.max[k]!) / 2 - centre[k]!) as Vec3 });
  }
  schedule();
}
function fit() {
  clearMeasurementDrag();clearResliceDrag();
  const bounds = sceneBounds();
  const span = bounds.max.map((v, k) => v - bounds.min[k]!);
  if (!visibleCount.value) { centre = bounds.min.map((v, k) => (v + bounds.max[k]!) / 2) as Vec3; radius = Math.max(1e-4, Math.hypot(...span) / 2 || 1); }
  halfHeight = fitCameraHalfHeight(bounds.min, bounds.max, cssWidth, cssHeight);
  const focus=bounds.min.map((v,k)=>(v+bounds.max[k]!)/2) as Vec3,offset=rotate(minus(focus,centre),rotation());
  pan = props.reslicePlane?[-offset[0],-offset[1]]:[0,0]; schedule();
}
function preset(view: 'front' | 'top' | 'side' | 'iso') {
  clearMeasurementDrag();clearResliceDrag();
  if (view === 'front') { yaw = 0; pitch = 0; }
  if (view === 'side') { yaw = Math.PI / 2; pitch = 0; }
  if (view === 'top') { yaw = 0; pitch = -Math.PI / 2; }
  if (view === 'iso') { yaw = 0.55; pitch = -0.5; }
  schedule();
}
function resize() {
  clearResliceDrag();
  if (!canvas.value || !host.value) return;
  const rect = host.value.getBoundingClientRect(); cssWidth = Math.max(1, rect.width); cssHeight = Math.max(1, rect.height);
  overlaySize.value = [cssWidth, cssHeight];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.value.width = Math.round(cssWidth * dpr); canvas.value.height = Math.round(cssHeight * dpr); schedule();
}
function parseColor(value: string): number[] {
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
  if (/^#[0-9a-f]{3}$/i.test(value)) return [1, 2, 3].map(i => parseInt(value[i]! + value[i]!, 16) / 255);
  return [0.7, 0.78, 0.88];
}
function bindPosition(buffer: WebGLBuffer) {
  gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer); gl!.enableVertexAttribArray(positionLocation); gl!.vertexAttribPointer(positionLocation, 3, gl!.FLOAT, false, 0, 0);
}
function render() {
  frame = 0; cameraRevision.value++; if (!gl || !program || !canvas.value || destroyed) return;
  gl.viewport(0, 0, canvas.value.width, canvas.value.height); gl.clearColor(0.045, 0.065, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(program);
  const r = rotation();
  const depth = Math.max(radius * 12, halfHeight * 12, 1);
  gl.uniformMatrix4fv(matrixLocation, false, cameraClipMatrix(camera(), depth)); gl.uniformMatrix3fv(rotationLocation, false, new Float32Array(r));
  // Opaque pass first; transparent objects are sorted back-to-front by their view-space centres.
  const visible = gpu.filter(o => o.part.visible && o.part.opacity > 0);
  visible.sort((a, b) => (a.part.opacity >= 0.999 ? 0 : 1) - (b.part.opacity >= 0.999 ? 0 : 1) || rotate(a.centre, r)[2] - rotate(b.centre, r)[2]);
  for (const object of visible) {
    const opacity = Math.max(0, Math.min(1, object.part.opacity)), selected = object.part.id === props.selectedId;
    const rgb = parseColor(object.part.color).map(v => Math.min(1, v * (selected ? 1.1 : 1) + (selected ? 0.035 : 0)));
    gl.depthMask(opacity >= 0.999); gl.uniform4f(colorLocation, rgb[0]!, rgb[1]!, rgb[2]!, opacity); gl.uniform1f(unlitLocation, 0);
    bindPosition(object.positions); gl.bindBuffer(gl.ARRAY_BUFFER, object.normals); gl.enableVertexAttribArray(normalLocation); gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0);
    if (wireframe.value) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
    gl.drawArrays(gl.TRIANGLES, 0, object.count);
    if (wireframe.value) {
      gl.disable(gl.POLYGON_OFFSET_FILL); bindPosition(object.edges); gl.disableVertexAttribArray(normalLocation); gl.vertexAttrib3f(normalLocation, 0, 0, 1);
      gl.uniform1f(unlitLocation, 1); gl.uniform4f(colorLocation, selected ? 0.8 : 0.12, selected ? 0.9 : 0.16, selected ? 1 : 0.22, Math.max(0.2, opacity));
      gl.drawArrays(gl.LINES, 0, object.edgeCount);
    }
  }
  gl.depthMask(true);
}
function wheel(event: WheelEvent) {
  clearMeasurementDrag();clearResliceDrag();
  event.preventDefault(); halfHeight = Math.max(radius * 0.005, Math.min(radius * 100, halfHeight * Math.exp(Math.max(-200, Math.min(200, event.deltaY)) * 0.0015))); schedule();
}
function down(event: PointerEvent) {
  clearMeasurementDrag();clearResliceDrag();
  if (pointers.size >= 2 || event.button < 0 || event.button > 2) return;
  canvas.value?.focus();
  canvas.value?.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); if (pointer) pointer.moved = true; return; }
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, pan: event.button === 1 || event.button === 2 || event.shiftKey,...(props.tool==='ellipse'?{creation:creationEpoch()}:{} ),...(props.tool==='reslice-project-line'&&Number.isSafeInteger(props.referencePointToken)&&props.referencePointToken!>0?{reference:{token:props.referencePointToken!,volume:props.volume,revision:props.revision,tool:props.tool,allowEdit:props.allowEdit!==false}}:{}) };
  dragging.value = true;
}
function move(event: PointerEvent) {
  if(canvas.value){const rect=canvas.value.getBoundingClientRect(),point:[number,number]=[(event.clientX-rect.left)*cssWidth/rect.width,(event.clientY-rect.top)*cssHeight/rect.height];hoveredAnnotation.value=[...projectedMeasurements.value].reverse().find(m=>m.annotationLabel&&annotationLabelHit(m.annotationLabel,point))?.label??'';}
  if(!pointers.size)updateEllipseCreation(event);
  if (!pointers.has(event.pointerId)) return;
  if(pointer?.creation&&!pointer.pan&&event.buttons!==undefined&&event.buttons!==1){pointer.moved=true;creationPreview.value=undefined;return;}
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], next = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    if (pinch > 1 && next > 1) halfHeight = Math.max(radius * 0.005, Math.min(radius * 100, halfHeight * pinch / next));
    pinch = next; schedule(); return;
  }
  if (!pointer || pointer.id !== event.pointerId) return;
  const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
  if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 3) pointer.moved = true;
  if (pointer.pan || event.shiftKey) { pan[0] += dx * 2 * halfHeight / cssHeight; pan[1] -= dy * 2 * halfHeight / cssHeight; }
  else { yaw += dx * 0.008; pitch += dy * 0.008; }
  pointer.x = event.clientX; pointer.y = event.clientY; schedule();
}
function up(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointer?.id === event.pointerId) {
    if (!pointer.moved && !pointer.pan && event.type === 'pointerup' && event.button === 0){
      if(pointer.creation)ellipseCreationClick(event,pointer.creation);
      else if(pointer.reference){const epoch=pointer.reference;if(referenceCurrent(epoch)&&epoch.volume){const hit=rayHit(event.clientX,event.clientY);if(hit)emit('referencePoint',{position:[...hit.position],partId:hit.partId,volume:epoch.volume,revision:epoch.revision??0,lineToken:epoch.token});}}
      else if(props.tool!=='ellipse'&&props.tool!=='reslice-project-line')pick(event.clientX, event.clientY);
    }else if(pointer.creation&&event.type!=='pointerup')creationPreview.value=undefined;
    pointer = null;
  }
  if (pointers.size === 1) { const [id, p] = [...pointers.entries()][0]!; pointer = { id, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: true, pan: false }; }
  if (!pointers.size) { pinch = 0; dragging.value = false; }
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
}
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function pickerFor(part: PartObject): MeshPicker {
  const cached = pickers.get(part.id);
  if (cached?.mesh === part.mesh && cached.revision === props.revision) return cached.picker;
  const picker = createMeshPicker(part.mesh); pickers.set(part.id, { mesh: part.mesh, revision: props.revision, picker }); return picker;
}
function rayHit(clientX: number, clientY: number, partId?: string): { partId: string; position: Vec3 } | undefined {
  if (!canvas.value) return undefined;
  const rect = canvas.value.getBoundingClientRect();
  const reach = Math.max(radius * 15, halfHeight * 15, 2);
  const { origin, direction } = cameraPickRay([(clientX - rect.left) / rect.width * cssWidth, (clientY - rect.top) / rect.height * cssHeight], camera(), reach);
  let closest = Infinity, hit: { partId: string; position: Vec3 } | undefined;
  for (const part of props.parts) {
    if (!part.visible || part.opacity <= 0 || partId && part.id !== partId) continue;
    const result = pickerFor(part).intersect(origin, direction, closest);
    if (result && result.distance < closest) { closest = result.distance; hit = { partId: part.id, position: result.position }; }
  }
  return hit;
}
function pick(clientX: number, clientY: number) {
  const hit = rayHit(clientX, clientY);
  if (hit) { emit('select', hit.partId); if (props.allowEdit !== false) emit('pick', hit); }
}
function referenceCurrent(epoch:ReferenceEpoch){return epoch.allowEdit&&props.allowEdit!==false&&props.tool===epoch.tool&&props.tool==='reslice-project-line'&&props.volume===epoch.volume&&props.revision===epoch.revision&&props.referencePointToken===epoch.token;}
function gestureSources(measurement:MeasurementObject){return JSON.stringify([measurement.kind,measurement.controlPoints,measurement.pointPartIds,measurement.partId,measurement.labelOffset,measurement.visible]);}
function snapshot(measurement:MeasurementObject):GestureSnapshot{return{measurement,collection:props.measurements,points:measurement.points.map(p=>[...p] as Vec3),sources:gestureSources(measurement),volume:props.volume,revision:props.revision};}
function gestureCurrent(gesture:CapturedGesture,label=false):boolean{
  const measurement=props.measurements?.find(m=>m.id===gesture.id);
  return props.allowEdit!==false&&props.volume===gesture.volume&&props.revision===gesture.revision&&props.measurements===gesture.collection&&measurement===gesture.measurement&&!!measurement&&measurement.visible&&attachmentsVisible(measurement)&&gestureSources(measurement)===gesture.sources&&measurement.points.length===gesture.points.length&&measurement.points.every((p,i)=>p.every((v,k)=>v===gesture.points[i]![k]))&&(label?allowsMeasurementLabels(props.tool):allowsMeasurementHandle(props.tool,measurement.kind));
}
/** Aggregate edits intersect one frozen physical plane, never the individual Part surfaces. */
function planePoint(event:Pick<PointerEvent,'clientX'|'clientY'>,center:Vec3,normal:Vec3):Vec3|undefined{
  if(!canvas.value)return;
  const rect=canvas.value.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return;
  const ray=cameraPickRay([(event.clientX-rect.left)/rect.width*cssWidth,(event.clientY-rect.top)/rect.height*cssHeight],camera(),Math.max(radius*15,halfHeight*15,2)),denominator=dot(ray.direction,normal);
  if(Math.abs(denominator)<1e-9)return;
  const t=dot(minus(center,ray.origin),normal)/denominator,position=ray.origin.map((v,k)=>v+t*ray.direction[k]!) as Vec3;
  return position.every(Number.isFinite)?position:undefined;
}
function reslicePoint(event:Pick<PointerEvent,'clientX'|'clientY'>,frame:ResliceGesture['frame'],frozenCamera:ReturnType<typeof camera>):Vec3|undefined{
  if(!canvas.value)return;
  const rect=canvas.value.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return;
  const ray=cameraPickRay([(event.clientX-rect.left)/rect.width*frozenCamera.width,(event.clientY-rect.top)/rect.height*frozenCamera.height],frozenCamera,Math.max(radius*15,halfHeight*15,2)),denominator=dot(ray.direction,frame.normal);
  if(Math.abs(denominator)<1e-9)return;
  const t=dot(minus(frame.center,ray.origin),frame.normal)/denominator,point=ray.origin.map((v,k)=>v+t*ray.direction[k]!) as Vec3;
  return point.every(Number.isFinite)?point:undefined;
}
function resliceCurrent(gesture:ResliceGesture){
  return canEditReslice()&&props.resliceId===gesture.id&&props.resliceMode===gesture.mode&&props.tool===gesture.tool&&props.volume===gesture.volume&&(props.revision??0)===gesture.revision&&(props.resliceRevision??0)===gesture.resliceRevision&&props.reslicePlane===gesture.object&&JSON.stringify(props.reslicePlane)===gesture.planeKey;
}
/** RP handles have no attachment to Part meshes. Every candidate uses one captured physical frame. */
function startResliceHandle(event:PointerEvent,handleId:string){
  if(!canEditReslice()||!props.reslicePlane||event.button!==0)return;
  event.stopPropagation();event.preventDefault();clearMeasurementDrag();clearResliceDrag();
  try{
    const plane=validateMprPlane(props.reslicePlane),mode=props.resliceMode as 'rotate'|'resize';
    const handle=reslicePlaneHandles(plane,mode).find(handle=>handle.id===handleId);if(!handle)return;
    const frame=reslicePlaneFrame(plane),current=camera(),frozenCamera={...current,center:[...current.center] as Vec3,rotation:[...current.rotation],pan:[...current.pan] as [number,number]},start=reslicePoint(event,frame,frozenCamera);if(!start)return;
    const element=event.currentTarget as SVGElement;element.setPointerCapture(event.pointerId);
    resliceDrag={pointerId:event.pointerId,element,id:props.resliceId!,object:props.reslicePlane,plane,planeKey:JSON.stringify(props.reslicePlane),frame,start,anchor:[...handle.position],camera:frozenCamera,handleId,action:handle.kind,mode,tool:props.tool,volume:props.volume,revision:props.revision??0,resliceRevision:props.resliceRevision??0};
    temporaryReslicePlane.value=plane;element.focus();
  }catch{/* Invalid or edge-on planes cannot start a transform. */}
}
function moveResliceHandle(event:PointerEvent){
  const gesture=resliceDrag;if(!gesture||event.pointerId!==gesture.pointerId)return;
  if(!resliceCurrent(gesture)||(event.type==='pointermove'&&event.buttons!==undefined&&event.buttons!==1)){clearResliceDrag();return;}
  event.stopPropagation();event.preventDefault();const position=reslicePoint(event,gesture.frame,gesture.camera);if(!position)return;
  try{
    temporaryReslicePlane.value=gesture.handleId==='center'?translateReslicePlane(gesture.plane,minus(position,gesture.start))
      :gesture.mode==='rotate'?rotateReslicePlane(gesture.plane,gesture.start,position)
      :resizeReslicePlane(gesture.plane,gesture.handleId,gesture.anchor.map((v,k)=>v+position[k]!-gesture.start[k]!) as Vec3);
  }catch{/* Keep the last valid local preview at a collapsed axis or the rotation center. */}
}
function clearResliceDrag(){
  const previous=resliceDrag;resliceDrag=null;temporaryReslicePlane.value=undefined;
  if(previous?.element.hasPointerCapture(previous.pointerId))previous.element.releasePointerCapture(previous.pointerId);
}
function endResliceHandle(event:PointerEvent){
  const gesture=resliceDrag;if(!gesture||event.pointerId!==gesture.pointerId)return;
  event.stopPropagation();event.preventDefault();
  if(event.type!=='pointerup'||event.button!==0||!resliceCurrent(gesture)){clearResliceDrag();return;}
  moveResliceHandle(event);const plane=temporaryReslicePlane.value;clearResliceDrag();
  if(plane&&(['origin','u','v'] as const).some(key=>plane[key].some((v,k)=>Math.abs(v-gesture.plane[key][k]!)>1e-8)))emit('updateReslicePlane',{id:gesture.id,plane:validateMprPlane(plane),action:gesture.action,volume:gesture.volume,revision:gesture.revision,resliceRevision:gesture.resliceRevision});
}
function creationEpoch():CreationEpoch{return{token:props.measurementDraftToken??0,volume:props.volume,revision:props.revision,pendingKey:JSON.stringify(props.pendingPoints??[]),stage:props.pendingPoints?.length??0,tool:props.tool,allowEdit:props.allowEdit!==false};}
function sameCreationEpoch(a:CreationEpoch,b:CreationEpoch){return a.token===b.token&&a.volume===b.volume&&a.revision===b.revision&&a.pendingKey===b.pendingKey&&a.stage===b.stage&&a.tool===b.tool&&a.allowEdit===b.allowEdit;}
/** App convention: the plane contains the picked axis and is as camera-facing as possible. */
function creationFrame(ends:[Vec3,Vec3]):EllipseFrame{
  if(ends.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v))))throw new Error('长轴点必须是有限世界坐标。');
  const axis=minus(ends[1],ends[0]),length=Math.hypot(...axis);if(!Number.isFinite(length)||length<=2e-9)throw new Error('椭圆长轴不能为零。');
  const u=axis.map(v=>v/length) as Vec3,center=ends[0].map((v,k)=>v/2+ends[1][k]!/2) as Vec3;
  const candidates=([ [0,0,1],[0,1,0],[1,0,0] ] as Vec3[]).map(p=>rotateCameraVector(p,rotation(),true));
  const perpendicular=candidates.map(candidate=>candidate.map((v,k)=>v-u[k]!*dot(candidate,u)) as Vec3).find(candidate=>Math.hypot(...candidate)>1e-8)!;
  const normal=perpendicular.map(v=>v/Math.hypot(...perpendicular)) as Vec3,v=cross(normal,u);
  return{center,u,v,normal,a:length/2,b:length/4};
}
function refreshEllipseCreation(){
  if(pointer?.creation)pointer.moved=true;
  creationPreview.value=undefined;creationPlane=undefined;creationBlocked=undefined;
  const epoch=creationEpoch();if(epoch.tool!=='ellipse'||!epoch.allowEdit||epoch.stage!==2)return;
  try{
    const ends=props.pendingPoints!.map(p=>[...p] as Vec3) as [Vec3,Vec3],frame=creationFrame(ends);
    creationPlane={...frame,ends,epoch};creationPreview.value={points:ellipsePoints(frame),stage:2,provisional:true};
  }catch{/* A coincident long axis remains unconfirmed. */}
}
function updateEllipseCreation(event:Pick<PointerEvent,'clientX'|'clientY'>){
  const epoch=creationEpoch();if(epoch.tool!=='ellipse'||!epoch.allowEdit||creationBlocked&&sameCreationEpoch(creationBlocked,epoch)){creationPreview.value=undefined;return;}
  if(epoch.stage===1){
    const hit=rayHit(event.clientX,event.clientY);if(!hit){creationPreview.value=undefined;return;}
    try{creationPreview.value={points:ellipsePoints(creationFrame([[...props.pendingPoints![0]!],hit.position])),stage:1,provisional:true};}catch{creationPreview.value=undefined;}
    return;
  }
  const frozen=creationPlane;if(epoch.stage!==2||!frozen||!sameCreationEpoch(frozen.epoch,epoch)){creationPreview.value=undefined;return;}
  const position=planePoint(event,frozen.center,frozen.normal);
  if(!position){creationPreview.value={points:ellipsePoints(frozen),stage:2,provisional:false,reason:'视线与冻结创建平面平行，请旋转视图。'};return;}
  const radius=dot(minus(position,frozen.center),frozen.v),minor=frozen.center.map((v,k)=>v+radius*frozen.v[k]!) as Vec3;
  creationPreview.value={points:[[...frozen.ends[0]],[...frozen.ends[1]],minor],stage:2,provisional:false};
}
function ellipseCreationClick(event:PointerEvent,epoch:CreationEpoch){
  const current=creationEpoch();if(!sameCreationEpoch(epoch,current)||!current.allowEdit||current.tool!=='ellipse'||creationBlocked&&sameCreationEpoch(creationBlocked,current))return;
  if(epoch.stage!==2){if(epoch.stage<2)pick(event.clientX,event.clientY);return;}
  updateEllipseCreation(event);const preview=creationPreview.value;
  if(!preview||preview.reason||!evaluateMeasurement('ellipse',preview.points).valid)return;
  const position=[...preview.points[2]!] as Vec3;creationBlocked=current;creationPreview.value=undefined;
  emit('completeEllipseCreation',{position,draftToken:epoch.token,volume:epoch.volume,revision:epoch.revision});
}
function leaveCanvas(){hoveredAnnotation.value='';creationPreview.value=undefined;}
let previewEmitted=false;
function emitGeometryPreview(id:string,points:Vec3[],gesture:CapturedGesture){previewEmitted=true;emit('previewMeasurementGeometry',{id,points:points.map(p=>[...p] as Vec3),volume:gesture.volume,revision:gesture.revision});}
function startEllipseHandle(event:PointerEvent,id:string,handleId:EllipseHandleId){
  const measurement=props.measurements?.find(m=>m.id===id);
  if(!measurement||measurement.kind!=='ellipse'||props.allowEdit===false||!allowsMeasurementHandle(props.tool,measurement.kind)||!attachmentsVisible(measurement))return;
  event.stopPropagation();event.preventDefault();emit('selectMeasurement',id);if(event.button!==0)return;
  clearMeasurementDrag();clearResliceDrag();
  try{
    const f=ellipseFrame(measurement.points),start=planePoint(event,f.center,f.normal);if(!start)return;
    const element=event.currentTarget as SVGElement;element.setPointerCapture(event.pointerId);
    ellipseDrag={...snapshot(measurement),pointerId:event.pointerId,id,element,handleId,start,center:[...f.center],normal:[...f.normal],moved:false};
    temporaryGeometry.value={id,points:measurement.points.map(p=>[...p] as Vec3)};element.focus();
  }catch{/* Degenerate stored ellipses cannot start a transform. */}
}
function moveEllipseHandle(event:PointerEvent){
  const gesture=ellipseDrag;if(!gesture||event.pointerId!==gesture.pointerId)return;
  if(!gestureCurrent(gesture)||(event.type==='pointermove'&&event.buttons!==undefined&&event.buttons!==1)){clearMeasurementDrag();return;}
  event.stopPropagation();event.preventDefault();const position=planePoint(event,gesture.center,gesture.normal);if(!position)return;
  if(Math.hypot(...minus(position,gesture.start))>1e-8)gesture.moved=true;
  try{
    const points=gesture.handleId==='center'?moveEllipse(gesture.points,minus(position,gesture.start)):gesture.handleId.startsWith('rotate')?rotateEllipse(gesture.points,gesture.start,position):resizeEllipse(gesture.points,gesture.handleId,position);
    temporaryGeometry.value={id:gesture.id,points};emitGeometryPreview(gesture.id,points,gesture);
  }catch{/* Keep the last valid geometry when crossing a zero axis or rotation center. */}
}
function startLabelDrag(event:PointerEvent,id:string){
  const measurement=props.measurements?.find(m=>m.id===id);
  if(!measurement||props.allowEdit===false||!allowsMeasurementLabels(props.tool)||!attachmentsVisible(measurement))return;
  selectLabel(event,id);if(measurement.kind==='annotation'||event.button!==0)return;
  clearMeasurementDrag();clearResliceDrag();const anchor=measurementLabelPosition(measurement),normal=rotateCameraVector([0,0,1],rotation(),true),start=planePoint(event,anchor,normal);if(!start)return;
  const element=event.currentTarget as SVGElement;element.setPointerCapture(event.pointerId);
  labelDrag={...snapshot(measurement),pointerId:event.pointerId,id,element,start,anchor,normal,offset:[...measurement.labelOffset??[0,0,0]] as Vec3};
  temporaryLabel.value={id,offset:[...labelDrag.offset]};element.focus();
}
function moveLabelDrag(event:PointerEvent){
  const gesture=labelDrag;if(!gesture||event.pointerId!==gesture.pointerId)return;
  if(!gestureCurrent(gesture,true)||(event.type==='pointermove'&&event.buttons!==undefined&&event.buttons!==1)){clearMeasurementDrag();return;}
  event.stopPropagation();event.preventDefault();const position=planePoint(event,gesture.anchor,gesture.normal);if(!position)return;
  temporaryLabel.value={id:gesture.id,offset:gesture.offset.map((v,k)=>v+position[k]!-gesture.start[k]!) as Vec3};
}
function startMeasurementHandle(event: PointerEvent, id: string, index: number) {
  const measurement = props.measurements?.find(m => m.id === id);
  if(!measurement||props.allowEdit===false||!allowsMeasurementHandle(props.tool,measurement.kind)||!attachmentsVisible(measurement))return;
  event.stopPropagation(); event.preventDefault(); emit('selectMeasurement', id);
  if (event.button !== 0) return;
  if(measurement.kind==='ellipse'){startEllipseHandle(event,id,index===0?'u-':index===1?'u+':'v+');return;}
  clearMeasurementDrag();clearResliceDrag();
  const source = measurement?.kind === 'surface-distance' && measurement.controlPoints?.length ? measurement.controlPoints : measurement?.points;
  const original = source?.[index];
  const partId=handlePartId(measurement,index);if (!partId || !original) return;
  const element = event.currentTarget as SVGElement; element.setPointerCapture(event.pointerId);
  measurementDrag = { ...snapshot(measurement),pointerId: event.pointerId, id, index, partId, element, original: [...original] };
  temporaryPoint.value = { id, index, position: [...original] }; element.focus();
}
function moveMeasurementHandle(event: PointerEvent) {
  if(resliceDrag){moveResliceHandle(event);return;}
  if(ellipseDrag){moveEllipseHandle(event);return;}
  if(labelDrag){moveLabelDrag(event);return;}
  if (!measurementDrag || event.pointerId !== measurementDrag.pointerId) return;
  const measurement=props.measurements?.find(m=>m.id===measurementDrag!.id);
  if (!gestureCurrent(measurementDrag)||!measurement||handlePartId(measurement,measurementDrag.index)!==measurementDrag.partId||(event.type==='pointermove'&&event.buttons!==undefined&&event.buttons!==1)) { clearMeasurementDrag(); return; }
  event.stopPropagation(); event.preventDefault();
  const hit = rayHit(event.clientX, event.clientY, measurementDrag.partId);
  if (hit){temporaryPoint.value = { id: measurementDrag.id, index: measurementDrag.index, position: hit.position };if(measurement.kind==='area')emitGeometryPreview(measurement.id,measurement.points.map((p,i)=>i===measurementDrag!.index?hit.position:p),measurementDrag);}
}
function clearMeasurementDrag() {
  const previous = measurementDrag??ellipseDrag??labelDrag; measurementDrag = null;ellipseDrag=null;labelDrag=null; temporaryPoint.value = undefined;temporaryGeometry.value=undefined;temporaryLabel.value=undefined;
  if(previewEmitted){previewEmitted=false;emit('previewMeasurementGeometry',null);}
  if (previous?.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId);
}
function endMeasurementHandle(event: PointerEvent) {
  if(resliceDrag){endResliceHandle(event);return;}
  if(ellipseDrag||labelDrag){
    const gesture=ellipseDrag??labelDrag!;if(event.pointerId!==gesture.pointerId)return;
    event.stopPropagation();event.preventDefault();
    if(event.type!=='pointerup'||!gestureCurrent(gesture,!!labelDrag)){clearMeasurementDrag();return;}
    moveMeasurementHandle(event);
    const geometry=temporaryGeometry.value,label=temporaryLabel.value,isGeometry=!!ellipseDrag;
    clearMeasurementDrag();
    if(isGeometry&&'moved'in gesture&&gesture.moved&&geometry&&geometry.points.some((p,i)=>Math.hypot(...minus(p,gesture.points[i]!))>1e-8))emit('updateMeasurementGeometry',{id:gesture.id,points:geometry.points.map(p=>[...p] as Vec3),volume:gesture.volume,revision:gesture.revision});
    else if(label&&'offset'in gesture&&Math.hypot(...minus(label.offset,gesture.offset))>1e-8)emit('updateMeasurementLabel',{id:gesture.id,offset:[...label.offset],volume:gesture.volume,revision:gesture.revision});
    return;
  }
  if (!measurementDrag || event.pointerId !== measurementDrag.pointerId) return;
  event.stopPropagation(); event.preventDefault();
  if (event.type === 'pointerup' && props.allowEdit !== false) {
    moveMeasurementHandle(event);
    const change = temporaryPoint.value,gesture=measurementDrag;
    if (change && gesture && Math.hypot(...minus(change.position, gesture.original)) > 1e-8) emit('moveMeasurementPoint', { id: change.id, index: change.index, position: [...change.position],volume:gesture.volume,revision:gesture.revision });
  }
  clearMeasurementDrag();
}
function measurementKey(event: KeyboardEvent) {
  if(event.key==='Escape'&&resliceDrag){event.preventDefault();event.stopPropagation();clearResliceDrag();}
  else if (event.key === 'Escape' && (measurementDrag||ellipseDrag||labelDrag)) { event.preventDefault(); event.stopPropagation(); clearMeasurementDrag(); }
  else if(event.key==='Escape'&&props.tool==='ellipse'){
    creationBlocked=creationEpoch();creationPlane=undefined;creationPreview.value=undefined;if(pointer?.creation)pointer.moved=true;
    // Let the workbench's global Escape handler cancel the matching draft/token too.
  }
}
function selectLabel(event:Event,id:string){if(props.allowEdit===false||!allowsMeasurementLabels(props.tool))return;event.stopPropagation();event.preventDefault();emit('selectMeasurement',id);}
function selectHandle(event:Event,id:string){const measurement=props.measurements?.find(m=>m.id===id);if(props.allowEdit===false||!measurement||!allowsMeasurementHandle(props.tool,measurement.kind))return;event.stopPropagation();event.preventDefault();emit('selectMeasurement',id);}
function editLabel(event:Event,id:string){if(props.allowEdit===false||!allowsMeasurementLabels(props.tool))return;event.stopPropagation();event.preventDefault();emit('editMeasurement',id);}
function contextLost(event: Event) { event.preventDefault();clearResliceDrag(); unavailable.value = 'WebGL 上下文已中断，正在等待恢复。'; gpu = []; }
function contextRestored() { initialise(); }
watch(() => [props.revision, ...props.parts.map(p => [p.id, p.mesh, p.visible, p.opacity, p.color])], () => {
  clearMeasurementDrag();
  const hadData = gpu.length > 0,previousCentre=[...centre] as Vec3,previousPan=[...pan] as [number,number];
  try {
    upload();
    if(!hadData&&(!props.reslicePlane||gpu.length>0))fit();
    else{
      // Re-uploaded mesh vertices use a new origin. Compensate pan so an RP drop/revision
      // cannot move the camera, including a scene containing only the selected RP.
      const delta=rotate(minus(centre,previousCentre),rotation());pan=[previousPan[0]+delta[0],previousPan[1]+delta[1]];
    }
  } catch (error) { unavailable.value = error instanceof Error ? error.message : String(error); }
});
watch(() => props.selectedId, schedule); watch(wireframe, schedule);
watch([()=>props.volume,()=>props.revision,()=>props.referencePointToken,()=>props.tool,()=>props.allowEdit],()=>{if(pointer?.reference&&!referenceCurrent(pointer.reference))pointer.moved=true;},{flush:'sync'});
watch(() => props.allowEdit, value => { if (value === false) {clearMeasurementDrag();clearResliceDrag();} });
watch([()=>props.volume,()=>props.revision,()=>props.measurements],()=>clearMeasurementDrag(),{flush:'sync',deep:true});
watch(()=>props.tool,()=>{const gesture=measurementDrag??ellipseDrag??labelDrag;if(gesture&&!gestureCurrent(gesture,!!labelDrag))clearMeasurementDrag();},{flush:'sync'});
watch([()=>props.volume,()=>props.revision,()=>props.measurementDraftToken,()=>props.tool,()=>props.allowEdit,()=>JSON.stringify(props.pendingPoints??[])],refreshEllipseCreation,{flush:'sync',immediate:true});
watch(() => [props.measurements, props.pendingPoints, props.overlayLines], () => { if (!visibleCount.value) { upload(); fit(); } }, { deep: true });
watch([()=>props.volume,()=>props.revision,()=>props.resliceId,()=>props.resliceRevision,()=>props.resliceMode,()=>props.reslicePlane,()=>props.tool,()=>props.allowEdit],()=>{
  if(resliceDrag&&!resliceCurrent(resliceDrag))clearResliceDrag();
},{flush:'sync',deep:true});
watch([()=>props.resliceId,()=>!!props.reslicePlane,()=>props.volume],()=>{
  if(!visibleCount.value&&!resliceDrag){upload();fit();}else schedule();
});
watch(()=>props.reslicePlane,schedule,{deep:true});
onMounted(async () => {
  await nextTick(); initialise(); observer = new ResizeObserver(resize); if (host.value) observer.observe(host.value);
  canvas.value?.addEventListener('webglcontextlost', contextLost); canvas.value?.addEventListener('webglcontextrestored', contextRestored);
  window.addEventListener('keydown', measurementKey, true);
});
onBeforeUnmount(() => {
  destroyed = true; observer?.disconnect(); if (frame) cancelAnimationFrame(frame); disposeGPU();
  canvas.value?.removeEventListener('webglcontextlost', contextLost); canvas.value?.removeEventListener('webglcontextrestored', contextRestored);
  window.removeEventListener('keydown', measurementKey, true); clearMeasurementDrag();clearResliceDrag();creationPlane=undefined;creationBlocked=undefined;creationPreview.value=undefined; pickers.clear();
  if (gl && program) gl.deleteProgram(program); program = null; gl = null; pointers.clear();
});
defineExpose({ fit, preset });
</script>

<template>
  <section class="part-viewport" aria-label="三维 Part 视图" :data-spatial-unit="spatialUnit||'影像单位'">
    <header class="viewport-toolbar">
      <strong>3D / Parts</strong>
      <div class="viewport-actions">
        <button type="button" title="显示全部对象 (F)" @click="fit">适配</button>
        <button type="button" title="从世界 +Z 朝 −Z 观察 XY 平面" @click="preset('front')">正面 XY</button>
        <button type="button" title="从世界 −Y 朝 +Y 观察 XZ 平面" @click="preset('top')">顶面 XZ</button>
        <button type="button" title="从世界 −X 朝 +X 观察 YZ 平面" @click="preset('side')">侧面 YZ</button>
        <button type="button" @click="preset('iso')">等轴</button>
        <label><input v-model="wireframe" type="checkbox"> 网格边</label>
      </div>
    </header>
    <div ref="host" class="canvas-host">
      <canvas ref="canvas" :class="{ dragging }" :title="hoveredAnnotation" tabindex="0" aria-label="拖动旋转，Shift 或右键拖动平移，滚轮缩放，点击表面拾取物理坐标"
        @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @wheel="wheel" @contextmenu.prevent
        @dblclick="fit" @keydown.f.prevent="fit" @pointerleave="leaveCanvas" />
      <svg v-if="!unavailable" class="measurement-overlay" :viewBox="`0 0 ${overlaySize[0]} ${overlaySize[1]}`" aria-label="三维测量与注释覆盖层" @contextmenu.prevent @wheel="wheel"
        @pointermove="moveMeasurementHandle" @pointerup="endMeasurementHandle" @pointercancel="endMeasurementHandle" @lostpointercapture="endMeasurementHandle">
        <g class="orientation-triad" :transform="`translate(42,${overlaySize[1]-44})`" aria-label="世界 XYZ 坐标方向">
          <g v-for="axis in orientationAxes" :key="axis.name" :style="{color:axis.color}"><line x1="0" y1="0" :x2="axis.x" :y2="axis.y" stroke="currentColor" stroke-width="1.5"/><circle :cx="axis.x" :cy="axis.y" r="2" fill="currentColor"/><text :x="axis.x+(Math.hypot(axis.x,axis.y)<4?-12:axis.x>=0?4:-12)" :y="axis.y+(axis.y>0?12:-4)" fill="currentColor" font-size="10">{{axis.name}}</text></g>
        </g>
        <g v-if="projectedReslice" class="reslice-plane" :class="{'reslice-resize':projectedReslice.resize}" aria-label="选中的三维 RP 平面" :data-reslice-id="resliceId" :data-reslice-mode="resliceMode??'view'" style="pointer-events:none">
          <path :d="projectedReslice.path" class="reslice-plane-face"/><path :d="projectedReslice.path" class="reslice-plane-border"/>
          <text :x="projectedReslice.corners[0]![0]+7" :y="projectedReslice.corners[0]![1]-8" class="reslice-plane-label">{{projectedReslice.label}}</text>
          <g v-for="handle in projectedReslice.handles" :key="handle.id" :transform="`translate(${handle.point[0]},${handle.point[1]})`" class="reslice-handle" :class="handle.kind" :style="{pointerEvents:projectedReslice.editable?'auto':'none',cursor:handle.cursor}" role="button" tabindex="0" :data-reslice-handle="handle.id" :aria-label="`RP ${handle.label} ${handle.id}，沿冻结物理平面拖动，Esc 取消`" @pointerdown="startResliceHandle($event,handle.id)">
            <title>{{handle.label}} · 松开提交 / Esc 取消</title><circle r="11" class="reslice-handle-hit"/>
            <path v-if="handle.kind==='move'" d="M-6,0 L6,0 M0,-6 L0,6" class="reslice-center"/><rect v-else-if="handle.kind==='rotate'" x="-4" y="-4" width="8" height="8" rx="1" class="reslice-handle-dot"/><circle v-else r="4" class="reslice-handle-dot"/>
          </g>
        </g>
        <g v-for="line in projectedOverlayLines" :key="`overlay-${line.id}`" class="geometry-overlay-line" :style="{ '--overlay-color': line.color }">
          <path :d="line.path" /><text v-if="line.label" :x="line.end[0] + 8" :y="line.end[1] - 8">{{ line.label }}</text>
        </g>
        <g v-for="m in projectedMeasurements" :key="m.id" :class="{ 'selected-measurement': m.selected, 'annotation-geometry':m.annotation }" :style="{ '--measurement-color': m.color }">
          <path v-if="m.path" :d="m.path" class="measurement-line" />
          <path v-if="m.preview" :d="m.preview" class="constraint-preview" />
          <path v-if="m.arc" :d="m.arc" class="measurement-arc" />
          <path v-if="m.selected&&m.ellipseBox" :d="m.ellipseBox" class="ellipse-box" />
          <path v-if="m.leader" :d="m.leader" class="annotation-leader" />
          <path v-if="m.annotationLabel?.arrowHead" :d="svgPath(m.annotationLabel.arrowHead,true)" class="annotation-ending"/>
          <circle v-if="m.annotationLabel?.dot" :cx="m.annotationLabel.dot[0]" :cy="m.annotationLabel.dot[1]" r="3.5" class="annotation-ending"/>
          <g v-for="handle in m.handles" :key="handle.index" :transform="`translate(${handle.point[0]},${handle.point[1]})`" class="measurement-handle" :class="{ draggable: handle.canDrag }" :style="{pointerEvents:m.canSelect?'auto':'none'}"
            role="button" :tabindex="m.canSelect?0:-1" :aria-disabled="!m.canSelect" :aria-label="`${m.label}，控制点 ${handle.index + 1}${handle.canDrag ? '，拖拽可沿自身 Part 表面移动，Esc 取消' : ''}`"
            @pointerdown="startMeasurementHandle($event, m.id, handle.index)" @keydown.enter="selectHandle($event,m.id)">
            <title>{{ m.label }} · 点 {{ handle.index + 1 }}{{ handle.canDrag ? ' · 拖拽沿自身表面移动 / Esc 取消' : '' }}</title>
            <circle r="10" class="handle-hit" /><circle :r="m.selected ? 4.6 : 3.6" class="handle-dot" />
          </g>
          <g v-for="handle in m.ellipseHandles" :key="handle.id" :transform="`translate(${handle.point[0]},${handle.point[1]})`" class="measurement-handle ellipse-handle" :class="[handle.kind,{draggable:m.canSelect}]" :style="{pointerEvents:m.canSelect?'auto':'none'}" role="button" :tabindex="m.canSelect?0:-1" :aria-disabled="!m.canSelect" :data-handle="handle.id" :aria-label="`${m.label}，${handle.kind==='move'?'中心移动':handle.kind==='rotate'?'角点旋转':'轴端缩放'} ${handle.id}，沿椭圆平面拖拽，Esc 取消`"
            @pointerdown="startEllipseHandle($event,m.id,handle.id)" @keydown.enter="selectHandle($event,m.id)">
            <title>{{handle.kind==='move'?'中心移动':handle.kind==='rotate'?'角点旋转':'轴端缩放'}} · 平面内拖拽 / Esc 取消</title><circle r="9" class="handle-hit" />
            <rect v-if="handle.kind==='rotate'" x="-3.5" y="-3.5" width="7" height="7" class="handle-dot" /><path v-else-if="handle.kind==='move'" d="M-5,0 L5,0 M0,-5 L0,5" class="ellipse-center"/><circle v-else :r="m.selected?4.6:3.6" class="handle-dot"/>
          </g>
          <g :transform="`translate(${m.labelX},${m.labelY}) rotate(${m.annotationLabel?.style.rotation??0})`" class="measurement-label" :style="{pointerEvents:m.canInteractLabel?'auto':'none'}" role="button" :tabindex="m.canInteractLabel?0:-1" :aria-disabled="!m.canInteractLabel" :aria-label="m.label"
            @pointerdown="startLabelDrag($event,m.id)" @keydown.enter="selectLabel($event,m.id)" @dblclick="editLabel($event,m.id)">
            <title>{{ m.label }}</title><rect :x="m.annotationLabel?.left??0" :y="m.annotationLabel?.top??-17" :width="m.labelWidth" :height="m.labelHeight" rx="4" />
            <text v-if="m.lines.length===1" :x="m.annotationLabel?.textX??7" :y="m.annotationLabel?.textY??-2" :text-anchor="m.annotationLabel?.style.align==='center'?'middle':m.annotationLabel?.style.align==='right'?'end':'start'">{{ m.shortLabel }}</text>
            <text v-else x="7" y="-2"><tspan v-for="(line,index) in m.lines" :key="index" x="7" :dy="index?16:0">{{line}}</tspan></text>
          </g>
        </g>
        <g v-if="projectedCreation" class="pending-ellipse" aria-label="三维椭圆创建预览" :data-stage="projectedCreation.stage" :data-valid="projectedCreation.valid">
          <path :d="projectedCreation.path" class="pending-ellipse-outline"/><path :d="projectedCreation.axis" class="pending-ellipse-axis"/>
          <circle v-for="(point,index) in projectedCreation.points" :key="index" :cx="point[0]" :cy="point[1]" r="3.5"/>
          <g :transform="`translate(${projectedCreation.x},${projectedCreation.y})`" class="pending-ellipse-label"><rect x="0" y="-17" :width="projectedCreation.width" :height="23+projectedCreation.lines.length*16" rx="4"/>
            <text x="7" y="-2"><tspan v-for="(line,index) in projectedCreation.lines" :key="index" x="7" :dy="index?16:0">{{line}}</tspan><tspan x="7" dy="16" class="creation-convention">{{projectedCreation.hint}}</tspan></text>
          </g>
        </g>
        <g v-if="projectedPending.length" class="pending-measurement">
          <path :d="svgPath(projectedPending)" />
          <g v-for="(p, index) in projectedPending" :key="index" :transform="`translate(${p[0]},${p[1]})`"><circle r="4" /><text x="7" y="-7">{{ index + 1 }}</text></g>
        </g>
      </svg>
      <div v-if="unavailable" class="empty-view error" role="alert">{{ unavailable }}</div>
      <div v-else-if="!visibleCount && !projectedReslice && !projectedMeasurements.length && !projectedPending.length && !projectedOverlayLines.length" class="empty-view"><span class="cube-icon">◇</span><b>尚无可见的 Part</b><span>选择 Mask 后计算三维，或导入 STL 表面。</span></div>
      <div v-else-if="!visibleCount" class="measurement-only-hint">物理空间几何视图 · 当前无可见 Part 表面</div>
      <div class="interaction-hint">{{ interactionHint }}</div>
    </div>
    <footer class="viewport-status"><span>{{ visibleCount }} 个可见对象</span><span>{{ triangleCount.toLocaleString() }} 个三角形 · {{spatialUnit||'影像单位'}} · 正交投影</span></footer>
  </section>
</template>

<style scoped>
.part-viewport { display: flex; flex-direction: column; min-width: 0; min-height: 260px; height: 100%; overflow: hidden; background: #0b101a; color: #cbd5e1; border: 1px solid #273247; border-radius: 7px; }
.viewport-toolbar { min-height: 37px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px; background: #141e2e; border-bottom: 1px solid #273247; font-size: 12px; flex-wrap: wrap; }
.viewport-toolbar strong { font-size: 12px; letter-spacing: .04em; color: #d8e6f5; }
.viewport-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.viewport-actions button { cursor: pointer; border: 1px solid #34445b; border-radius: 4px; color: #bdcde0; background: #1b293d; padding: 3px 7px; font-size: 11px; }
.viewport-actions button:hover { color: white; background: #2b4160; }
.viewport-actions label { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; white-space: nowrap; }
.viewport-actions input { accent-color: #42b5ff; }
.canvas-host { position: relative; flex: 1; min-height: 210px; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; touch-action: none; cursor: grab; outline: none; }
canvas:focus-visible { box-shadow: inset 0 0 0 2px #59bfff; }
canvas.dragging { cursor: grabbing; }
.empty-view { pointer-events: none; position: absolute; inset: 0; display: flex; flex-direction: column; gap: 11px; align-items: center; justify-content: center; text-align: center; color: #8092aa; font-size: 12px; padding: 24px; }
.empty-view b { font-size: 14px; font-weight: 500; color: #afc1d7; }
.empty-view .cube-icon { font-size: 44px; color: #3d5c7f; line-height: 1; }
.empty-view.error { color: #ffb8ac; background: #121b2be8; }
.interaction-hint { position: absolute; bottom: 10px; left: 12px; right: 12px; color: #7d8ca4; font-size: 10px; pointer-events: none; text-align: center; }
.measurement-only-hint { position: absolute; top: 12px; left: 12px; color: #7d97b6; font-size: 10px; pointer-events: none; }
.measurement-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: hidden; }
.reslice-plane-face{fill:#63c8ff0d;stroke:none}.reslice-plane-border{fill:none;stroke:#6bcaff;stroke-width:1.5;stroke-linejoin:round;filter:drop-shadow(0 1px 2px #000b)}.reslice-plane-label{fill:#9cdbff;stroke:#091321;stroke-width:3;paint-order:stroke;font:11px 'Segoe UI','Microsoft YaHei',sans-serif}.reslice-resize .reslice-plane-border{stroke:#ff625a;stroke-width:2}.reslice-resize .reslice-plane-label{fill:#ffaaa0}.reslice-handle{outline:none;touch-action:none}.reslice-handle-hit{fill:transparent;stroke:none}.reslice-handle-dot{fill:#102033;stroke:#a8e3ff;stroke-width:1.7}.reslice-center{fill:none;stroke:#b7e7ff;stroke-width:2}.reslice-resize .reslice-handle-dot{fill:#401b22;stroke:#ff8880}.reslice-resize .reslice-center{stroke:#ffaaa0}.reslice-handle:focus-visible .reslice-handle-dot,.reslice-handle:focus-visible .reslice-center{stroke:white;stroke-width:3}
.measurement-line, .measurement-arc, .annotation-leader { fill: none; stroke: var(--measurement-color, #f9d782); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 1px 2px #000b); }
.measurement-arc { stroke-width: 1.2; }.annotation-leader { stroke-width: 1.2; }
.ellipse-box { fill:none;stroke:var(--measurement-color);stroke-width:.8;stroke-dasharray:3 4;opacity:.5; }.ellipse-center { fill:none;stroke:var(--measurement-color);stroke-width:2; }.ellipse-handle.rotate { cursor:crosshair; }.ellipse-handle.move { cursor:move; }
.constraint-preview { fill: none; stroke: var(--measurement-color, #f9d782); stroke-width: 1.5; stroke-dasharray: 5 4; stroke-linecap: round; opacity: .8; }
.selected-measurement .measurement-line { stroke-width: 2.4; }
.measurement-handle { pointer-events: auto; cursor: pointer; outline: none; }.measurement-handle.draggable { cursor: grab; }.measurement-handle.draggable:active { cursor: grabbing; }
.handle-hit { fill: transparent; stroke: none; }.handle-dot { fill: #0c1729; stroke: var(--measurement-color, #f9d782); stroke-width: 1.8; }
.selected-measurement .handle-dot { fill: var(--measurement-color, #f9d782); stroke: #edf6ff; stroke-width: 1.4; }
.measurement-handle:focus-visible .handle-dot { stroke: white; stroke-width: 3; }
.measurement-label { pointer-events: auto; cursor: pointer; outline: none; }.measurement-label rect { fill: #101f33eb; stroke: var(--measurement-color, #f9d782); stroke-width: .65; }
.measurement-label text { fill: var(--measurement-color, #f9d782); font: 11px 'Segoe UI', 'Microsoft YaHei', sans-serif; user-select: none; }
.annotation-geometry .measurement-label text{font-size:12px}.annotation-ending{fill:var(--measurement-color,#f9d782);stroke:none}.annotation-geometry:not(.selected-measurement) .handle-dot{opacity:0}.annotation-geometry .measurement-handle:hover .handle-dot,.annotation-geometry .measurement-handle:focus-visible .handle-dot{opacity:1}
.selected-measurement .measurement-label rect, .measurement-label:focus-visible rect { stroke-width: 1.7; fill: #1a304bed; }
.pending-measurement { stroke: #ffe2a4; fill: #ffe2a4; }.pending-measurement path { fill: none; stroke-width: 1.7; stroke-dasharray: 5 4; }.pending-measurement text { stroke: none; font: 11px monospace; }
.pending-ellipse { fill:#ffe2a4;stroke:#ffe2a4; }.pending-ellipse-outline,.pending-ellipse-axis{fill:none;stroke-width:1.6;stroke-dasharray:5 4}.pending-ellipse-axis{stroke-width:.8;opacity:.6}.pending-ellipse-label rect{fill:#101f33ed;stroke-width:.7}.pending-ellipse-label text{stroke:none;font:11px 'Segoe UI','Microsoft YaHei',sans-serif}.creation-convention{fill:#b7c5d6;font-size:10px}
.geometry-overlay-line path { fill: none; stroke: var(--overlay-color, #8de3c0); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 1px 2px #000a); }
.geometry-overlay-line text { fill: var(--overlay-color, #8de3c0); font: 11px 'Segoe UI', 'Microsoft YaHei', sans-serif; paint-order: stroke; stroke: #0a1425; stroke-width: 3; stroke-linejoin: round; }
.viewport-status { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px; background: #111b2a; border-top: 1px solid #273247; font-size: 10px; color: #7f93ad; }
</style>
