<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildTransferLUT, columnMajor, inspectVolumeForRendering, normalizeTransferPoints, presetTransferFunction, relativeWorldToTexture, renderingSampleCount, type TransferPoint, type VolumePreset, type VolumeRenderingInfo } from './volumeRendering.ts';
import type { Vec3, VolumeGrid } from './types.ts';
import { cameraRotation, fitCameraHalfHeight } from './viewportGeometry.ts';

const props=defineProps<{grid:VolumeGrid;windowCenter?:number;windowWidth?:number;preset?:VolumePreset;opacity?:number;maxTextureBytes?:number;spatialUnit?:string;intensityUnit?:string}>();
const spatialUnit=computed(()=>props.spatialUnit||'影像单位');
const canvas=ref<HTMLCanvasElement>(),host=ref<HTMLDivElement>();
const fatalError=ref(''),renderError=ref(''),info=ref<VolumeRenderingInfo>(),showTransfer=ref(false),selected=ref(2);
const points=ref<TransferPoint[]>(presetTransferFunction(props.preset??'bone'));
const currentPreset=ref<VolumePreset>(props.preset??'bone'),globalOpacity=ref(props.opacity??1),stepMm=ref(1),shading=ref(true);
const histogram=ref<number[]>([]),histogramRange=ref<[number,number]>([0,1]),heldDomain=ref<[number,number]|null>(null);
const selectedPoint=computed(()=>points.value[Math.min(selected.value,points.value.length-1)]!);
const domain=computed<[number,number]>(()=>heldDomain.value??[Math.min(info.value?.min??0,points.value[0]!.value),Math.max(info.value?.max??1,points.value[points.value.length-1]!.value)]);
const minimumStep=computed(()=>info.value?Math.max(1e-6,Math.min(...info.value.physicalVoxelSize)*.2):.1);
const maximumStep=computed(()=>info.value?Math.max(minimumStep.value*2,Math.min(...info.value.physicalVoxelSize)*4):4);
const error=computed(()=>fatalError.value||renderError.value);
const graphX=(value:number)=>8+244*(value-domain.value[0])/(domain.value[1]-domain.value[0]);
const graphY=(opacity:number)=>88-80*opacity;
const transferPath=computed(()=>points.value.map((p,i)=>`${i?'L':'M'}${graphX(p.value).toFixed(2)},${graphY(p.opacity).toFixed(2)}`).join(' '));
const histogramPath=computed(()=>{
  const bins=histogram.value,top=Math.max(1,...bins),[lo,hi]=histogramRange.value;
  return bins.map((count,i)=>{const x=graphX(lo+(i+.5)/bins.length*(hi-lo)),y=88-70*Math.log1p(count)/Math.log1p(top);return `M${x.toFixed(1)},88V${y.toFixed(1)}`;}).join(' ');
});

let gl:WebGL2RenderingContext|null=null,program:WebGLProgram|null=null,volumeTexture:WebGLTexture|null=null,transferTexture:WebGLTexture|null=null;
let observer:ResizeObserver|undefined,frame=0,destroyed=false,transferDirty=true,width=1,height=1;
let yaw=.55,pitch=-.5,halfHeight=1,pan:[number,number]=[0,0];
let pointer:{id:number;x:number;y:number;pan:boolean}|null=null;
const pointers=new Map<number,{x:number;y:number}>();let pinch=0;
let transferDrag:{id:number;index:number;element:SVGElement}|null=null;
const uniforms=new Map<string,WebGLUniformLocation|null>();
const location=(name:string)=>{if(!uniforms.has(name))uniforms.set(name,gl!.getUniformLocation(program!,name));return uniforms.get(name)!;};
function rotation():number[]{return cameraRotation(pitch,yaw);}
function schedule(){if(!frame&&!destroyed)frame=requestAnimationFrame(render);}
function shader(kind:number,source:string){const s=gl!.createShader(kind);if(!s)throw new Error('无法建立体绘制 shader。');gl!.shaderSource(s,source);gl!.compileShader(s);if(!gl!.getShaderParameter(s,gl!.COMPILE_STATUS)){const message=gl!.getShaderInfoLog(s);gl!.deleteShader(s);throw new Error(message??'体绘制 shader 编译失败。');}return s;}
const fragmentSource=`#version 300 es
precision highp float; precision highp int; precision highp sampler3D; precision highp sampler2D;
in vec2 vNdc; out vec4 fragColor;
uniform sampler3D uVolume; uniform sampler2D uTransfer; uniform ivec3 uDims; uniform int uLutSize;
uniform vec2 uDomain; uniform mat4 uWorldToTexture; uniform mat3 uViewToWorld; uniform mat3 uGradientToWorld; uniform mat3 uWorldToView;
uniform float uHalfHeight,uAspect,uDistance,uStep,uOpacity,uWindowCenter,uWindowWidth,uShading; uniform vec2 uPan;
float raw(ivec3 p){return texelFetch(uVolume,clamp(p,ivec3(0),uDims-ivec3(1)),0).r;}
float scalarAt(vec3 uv){vec3 p=uv*vec3(uDims)-.5;ivec3 b=ivec3(floor(p));vec3 t=fract(p);
 float a=mix(raw(b),raw(b+ivec3(1,0,0)),t.x),c=mix(raw(b+ivec3(0,1,0)),raw(b+ivec3(1,1,0)),t.x);
 float d=mix(raw(b+ivec3(0,0,1)),raw(b+ivec3(1,0,1)),t.x),e=mix(raw(b+ivec3(0,1,1)),raw(b+ivec3(1,1,1)),t.x);
 return mix(mix(a,c,t.y),mix(d,e,t.y),t.z);}
vec4 transferAt(float value){float x=clamp((value-uDomain.x)/(uDomain.y-uDomain.x),0.,1.)*float(uLutSize-1);int a=int(floor(x)),b=min(a+1,uLutSize-1);return mix(texelFetch(uTransfer,ivec2(a,0),0),texelFetch(uTransfer,ivec2(b,0),0),fract(x));}
bool slab(vec3 o,vec3 d,out float nearT,out float farT){nearT=0.;farT=1.e30;for(int k=0;k<3;k++){if(abs(d[k])<1.e-12){if(o[k]<0.||o[k]>1.)return false;}else{float a=(0.-o[k])/d[k],b=(1.-o[k])/d[k];nearT=max(nearT,min(a,b));farT=min(farT,max(a,b));if(nearT>farT)return false;}}return farT>=0.;}
void main(){vec3 background=vec3(.035,.055,.085);if(uOpacity<=0.){fragColor=vec4(background,1.);return;}
 vec3 viewOrigin=vec3(vNdc.x*uHalfHeight*uAspect-uPan.x,vNdc.y*uHalfHeight-uPan.y,uDistance);
 vec3 worldOrigin=uViewToWorld*viewOrigin,worldDirection=uViewToWorld*vec3(0.,0.,-1.);
 vec3 origin=(uWorldToTexture*vec4(worldOrigin,1.)).xyz,direction=(uWorldToTexture*vec4(worldDirection,0.)).xyz;
 float first,last;if(!slab(origin,direction,first,last)){fragColor=vec4(background,1.);return;}
 vec4 accumulated=vec4(0.);float distance=first;
 for(int i=0;i<4096;i++){if(distance>=last||accumulated.a>.995)break;float dt=min(uStep,last-distance);vec3 uv=origin+direction*(distance+.5*dt);float value=scalarAt(uv);vec4 mapped=transferAt(value);
  float baseAlpha=clamp(mapped.a*uOpacity,0.,1.);if(baseAlpha>0.){
   float alpha=1.-pow(max(0.,1.-baseAlpha),dt);vec3 color=mapped.rgb;
   float windowValue=clamp((value-uWindowCenter)/uWindowWidth+.5,0.,1.);color*=.3+.7*windowValue;
   if(uShading>.5){ivec3 p=ivec3(floor(uv*vec3(uDims)));vec3 gradient=vec3(raw(p+ivec3(1,0,0))-raw(p-ivec3(1,0,0)),raw(p+ivec3(0,1,0))-raw(p-ivec3(0,1,0)),raw(p+ivec3(0,0,1))-raw(p-ivec3(0,0,1)))*.5;
    vec3 n=uWorldToView*(uGradientToWorld*gradient);float intensity=length(n)>1.e-7?.3+.7*max(dot(-normalize(n),normalize(vec3(-.35,.55,.8))),0.):.8;color*=intensity;}
   float weight=(1.-accumulated.a)*alpha;accumulated.rgb+=weight*color;accumulated.a+=weight;}
  distance+=dt;}
 fragColor=vec4(accumulated.rgb+(1.-accumulated.a)*background,1.);}`;
function initialise(){
  if(!canvas.value)return;
  try{
    gl=canvas.value.getContext('webgl2',{antialias:false,alpha:false,preserveDrawingBuffer:false});
    if(!gl)throw new Error('Volume Rendering 需要 WebGL2 / 3D 纹理；当前浏览器未提供，未使用表面模型替代。');
    const vs=shader(gl.VERTEX_SHADER,`#version 300 es
      precision highp float;out vec2 vNdc;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vNdc=p*2.-1.;gl_Position=vec4(vNdc,0.,1.);}`),fs=shader(gl.FRAGMENT_SHADER,fragmentSource);
    program=gl.createProgram();if(!program)throw new Error('无法建立体绘制 program。');gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??'体绘制 program 链接失败。');
    uniforms.clear();gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);resize();uploadVolume();fit();
  }catch(e){fatalError.value=e instanceof Error?e.message:String(e);}
}
function uploadVolume(){
  if(!gl||!program)return;
  fatalError.value='';renderError.value='';info.value=undefined;
  try{
    if(volumeTexture)gl.deleteTexture(volumeTexture);volumeTexture=null;
    const metadata=inspectVolumeForRendering(props.grid,{max3DTextureSize:gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,maxTextureBytes:props.maxTextureBytes});info.value=metadata;
    const bins=new Array<number>(128).fill(0),range=metadata.max-metadata.min||1;for(const value of props.grid.data)bins[Math.min(127,Math.floor((value-metadata.min)/range*128))]++;
    histogram.value=bins;histogramRange.value=[metadata.min,metadata.max===metadata.min?metadata.min+1:metadata.max];
    volumeTexture=gl.createTexture();if(!volumeTexture)throw new Error('GPU体纹理分配失败。');gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_3D,volumeTexture);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R])gl.texParameteri(gl.TEXTURE_3D,axis,gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage3D(gl.TEXTURE_3D,0,gl.R32F,...props.grid.dims,0,gl.RED,gl.FLOAT,props.grid.data);
    const code=gl.getError();if(code!==gl.NO_ERROR)throw new Error(`GPU无法分配完整R32F体纹理（WebGL error ${code}）；未降采样。`);
    stepMm.value=Math.min(...metadata.physicalVoxelSize)*.75;transferDirty=true;fit();schedule();
  }catch(e){fatalError.value=e instanceof Error?e.message:String(e);}
}
function uploadTransfer(){
  const lut=buildTransferLUT(points.value,domain.value,1024);
  if(!transferTexture)transferTexture=gl!.createTexture();if(!transferTexture)throw new Error('传递函数纹理分配失败。');
  gl!.activeTexture(gl!.TEXTURE1);gl!.bindTexture(gl!.TEXTURE_2D,transferTexture);gl!.texParameteri(gl!.TEXTURE_2D,gl!.TEXTURE_MIN_FILTER,gl!.NEAREST);gl!.texParameteri(gl!.TEXTURE_2D,gl!.TEXTURE_MAG_FILTER,gl!.NEAREST);gl!.texParameteri(gl!.TEXTURE_2D,gl!.TEXTURE_WRAP_S,gl!.CLAMP_TO_EDGE);gl!.texParameteri(gl!.TEXTURE_2D,gl!.TEXTURE_WRAP_T,gl!.CLAMP_TO_EDGE);
  gl!.texImage2D(gl!.TEXTURE_2D,0,gl!.RGBA32F,lut.size,1,0,gl!.RGBA,gl!.FLOAT,lut.data);
  const code=gl!.getError();if(code!==gl!.NO_ERROR)throw new Error(`传递函数纹理写入失败（WebGL error ${code}）。`);transferDirty=false;
}
function fit(){if(!info.value)return;halfHeight=fitCameraHalfHeight(info.value.bounds.min,info.value.bounds.max,width,height,1.08);pan=[0,0];schedule();}
function resize(){if(!host.value||!canvas.value)return;const rect=host.value.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);const dpr=Math.min(1.5,window.devicePixelRatio||1);canvas.value.width=Math.round(width*dpr);canvas.value.height=Math.round(height*dpr);schedule();}
function render(){
  frame=0;if(!gl||!program||!canvas.value||!info.value||fatalError.value||!volumeTexture||destroyed)return;
  gl.viewport(0,0,canvas.value.width,canvas.value.height);gl.clearColor(.035,.055,.085,1);gl.clear(gl.COLOR_BUFFER_BIT);
  try{
    const metadata=info.value;renderingSampleCount(Math.hypot(...metadata.bounds.size),stepMm.value);
    const center=props.windowCenter??(metadata.min+metadata.max)/2,widthWindow=props.windowWidth??Math.max(1,metadata.max-metadata.min);
    if(!Number.isFinite(center)||!Number.isFinite(widthWindow)||widthWindow<=0)throw new Error('体绘制窗宽/窗位无效。');
    if(!Number.isFinite(globalOpacity.value)||globalOpacity.value<0||globalOpacity.value>1)throw new Error('体绘制不透明度必须位于0到1。');
    gl.useProgram(program);if(transferDirty)uploadTransfer();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_3D,volumeTexture);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,transferTexture);
    gl.uniform1i(location('uVolume'),0);gl.uniform1i(location('uTransfer'),1);gl.uniform1i(location('uLutSize'),1024);gl.uniform3iv(location('uDims'),new Int32Array(props.grid.dims));gl.uniform2f(location('uDomain'),...domain.value);
    gl.uniformMatrix4fv(location('uWorldToTexture'),false,columnMajor(relativeWorldToTexture(metadata)));
    const r=rotation(),inverse=[r[0]!,r[3]!,r[6]!,r[1]!,r[4]!,r[7]!,r[2]!,r[5]!,r[8]!];gl.uniformMatrix3fv(location('uViewToWorld'),false,new Float32Array(inverse));gl.uniformMatrix3fv(location('uWorldToView'),false,new Float32Array(r));
    gl.uniformMatrix3fv(location('uGradientToWorld'),false,new Float32Array(metadata.worldToVoxel.slice(0,3).flatMap(row=>row.slice(0,3))));
    gl.uniform1f(location('uHalfHeight'),halfHeight);gl.uniform1f(location('uAspect'),width/height);gl.uniform1f(location('uDistance'),metadata.bounds.radius*4+Math.hypot(...pan));gl.uniform2f(location('uPan'),...pan);
    gl.uniform1f(location('uStep'),stepMm.value);gl.uniform1f(location('uOpacity'),globalOpacity.value);gl.uniform1f(location('uWindowCenter'),center);gl.uniform1f(location('uWindowWidth'),widthWindow);gl.uniform1f(location('uShading'),+shading.value);
    gl.drawArrays(gl.TRIANGLES,0,3);const code=gl.getError();if(code!==gl.NO_ERROR)throw new Error(`体绘制失败（WebGL error ${code}）。`);renderError.value='';
  }catch(e){renderError.value=e instanceof Error?e.message:String(e);}
}
function down(event:PointerEvent){if(pointers.size>=2||event.button<0||event.button>2)return;canvas.value?.focus();canvas.value?.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===2){const[a,b]=[...pointers.values()];pinch=Math.hypot(a!.x-b!.x,a!.y-b!.y);return;}pointer={id:event.pointerId,x:event.clientX,y:event.clientY,pan:event.button===1||event.button===2||event.shiftKey};}
function move(event:PointerEvent){
  if(!pointers.has(event.pointerId))return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(pointers.size===2){const[a,b]=[...pointers.values()],next=Math.hypot(a!.x-b!.x,a!.y-b!.y);if(pinch>1&&next>1)halfHeight=Math.max(1e-4,halfHeight*pinch/next);pinch=next;schedule();return;}
  if(!pointer||pointer.id!==event.pointerId)return;const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;if(pointer.pan||event.shiftKey){pan[0]+=dx*halfHeight*2/height;pan[1]-=dy*halfHeight*2/height;}else{yaw+=dx*.008;pitch+=dy*.008;}pointer.x=event.clientX;pointer.y=event.clientY;schedule();
}
function up(event:PointerEvent){pointers.delete(event.pointerId);if(pointer?.id===event.pointerId)pointer=null;if(pointers.size===1){const[id,p]=[...pointers.entries()][0]!;pointer={id,x:p.x,y:p.y,pan:false};}if(!pointers.size)pinch=0;if(canvas.value?.hasPointerCapture(event.pointerId))canvas.value.releasePointerCapture(event.pointerId);}
function wheel(event:WheelEvent){event.preventDefault();const radius=info.value?.bounds.radius??1;halfHeight=Math.max(radius*.005,Math.min(radius*100,halfHeight*Math.exp(Math.max(-200,Math.min(200,event.deltaY))*.0015)));schedule();}
function changePreset(preset:VolumePreset){currentPreset.value=preset;points.value=presetTransferFunction(preset);selected.value=Math.min(2,points.value.length-1);}
function graphPosition(event:PointerEvent,element:SVGElement):{value:number;opacity:number}{const rect=element.ownerSVGElement?.getBoundingClientRect()??element.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*260,y=(event.clientY-rect.top)/rect.height*96;return {value:domain.value[0]+Math.max(0,Math.min(1,(x-8)/244))*(domain.value[1]-domain.value[0]),opacity:Math.max(0,Math.min(1,(88-y)/80))};}
function addPoint(event:PointerEvent){if(event.button!==0)return;const p=graphPosition(event,event.currentTarget as SVGElement),near=points.value.findIndex(point=>Math.abs(point.value-p.value)<(domain.value[1]-domain.value[0])*1e-4);if(near>=0){selected.value=near;return;}const color=selectedPoint.value.color;points.value=normalizeTransferPoints([...points.value,{...p,color:[...color]}]);selected.value=points.value.findIndex(point=>point.value===p.value);}
function startTransfer(event:PointerEvent,index:number){if(event.button!==0)return;event.preventDefault();event.stopPropagation();selected.value=index;heldDomain.value=[...domain.value];const element=event.currentTarget as SVGElement;element.setPointerCapture(event.pointerId);transferDrag={id:event.pointerId,index,element};}
function moveTransfer(event:PointerEvent){if(!transferDrag||transferDrag.id!==event.pointerId)return;event.preventDefault();const p=graphPosition(event,transferDrag.element),i=transferDrag.index,epsilon=(domain.value[1]-domain.value[0])*1e-5;const lower=i?points.value[i-1]!.value+epsilon:domain.value[0],upper=i+1<points.value.length?points.value[i+1]!.value-epsilon:domain.value[1];points.value=points.value.map((point,j)=>j===i?{...point,value:Math.max(lower,Math.min(upper,p.value)),opacity:p.opacity}:point);}
function endTransfer(event:PointerEvent){if(!transferDrag||transferDrag.id!==event.pointerId)return;if(transferDrag.element.hasPointerCapture(event.pointerId))transferDrag.element.releasePointerCapture(event.pointerId);transferDrag=null;heldDomain.value=null;}
function deletePoint(index=selected.value){if(points.value.length<=2){renderError.value='传递函数至少保留两个控制点。';return;}points.value=points.value.filter((_,i)=>i!==index);selected.value=Math.min(index,points.value.length-1);}
function colorHex(color:Vec3){return '#'+color.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');}
function editColor(event:Event){const hex=(event.target as HTMLInputElement).value;points.value=points.value.map((p,i)=>i===selected.value?{...p,color:[1,3,5].map(k=>parseInt(hex.slice(k,k+2),16)/255) as Vec3}:p);}
function editNumber(event:Event,key:'value'|'opacity'){
  const value=Number((event.target as HTMLInputElement).value);try{const updated=points.value.map((p,i)=>i===selected.value?{...p,[key]:value}:p);points.value=normalizeTransferPoints(updated);selected.value=key==='value'?points.value.findIndex(p=>p.value===value):selected.value;renderError.value='';}catch(e){renderError.value=e instanceof Error?e.message:String(e);}
}
function contextLost(event:Event){event.preventDefault();fatalError.value='WebGL体绘制上下文已中断，等待恢复。';volumeTexture=null;transferTexture=null;}
function contextRestored(){initialise();}
watch(()=>[props.grid,props.maxTextureBytes],uploadVolume);
watch(()=>props.preset,preset=>{if(preset)changePreset(preset);});watch(()=>props.opacity,value=>{if(value!==undefined)globalOpacity.value=value;});
watch(()=>[props.windowCenter,props.windowWidth],schedule);watch([globalOpacity,stepMm,shading],schedule);
watch([points,domain],()=>{transferDirty=true;schedule();},{deep:true});
onMounted(async()=>{await nextTick();initialise();observer=new ResizeObserver(resize);if(host.value)observer.observe(host.value);canvas.value?.addEventListener('webglcontextlost',contextLost);canvas.value?.addEventListener('webglcontextrestored',contextRestored);});
onBeforeUnmount(()=>{destroyed=true;observer?.disconnect();if(frame)cancelAnimationFrame(frame);canvas.value?.removeEventListener('webglcontextlost',contextLost);canvas.value?.removeEventListener('webglcontextrestored',contextRestored);if(gl){if(volumeTexture)gl.deleteTexture(volumeTexture);if(transferTexture)gl.deleteTexture(transferTexture);if(program)gl.deleteProgram(program);}uniforms.clear();pointers.clear();gl=null;program=null;});
defineExpose({fit,reload:uploadVolume});
</script>

<template>
  <section class="volume-viewport" aria-label="独立体绘制视图" :data-spatial-unit="spatialUnit">
    <header><strong>Volume Rendering</strong><div class="volume-actions"><select :value="currentPreset" aria-label="体绘制预设" @change="changePreset(($event.target as HTMLSelectElement).value as VolumePreset)"><option value="bone">骨</option><option value="soft">软组织</option><option value="both">骨 + 软组织</option></select><button type="button" @click="fit">适配</button><button type="button" :class="{active:showTransfer}" @click="showTransfer=!showTransfer">传递函数</button></div></header>
    <div ref="host" class="volume-canvas-host">
      <canvas ref="canvas" tabindex="0" aria-label="体素光线积分；拖动旋转，Shift或右键平移，滚轮缩放" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @wheel="wheel" @contextmenu.prevent @dblclick="fit" @keydown.f.prevent="fit" />
      <div v-if="error" class="volume-error" role="alert">{{error}}</div>
      <aside v-if="showTransfer" class="transfer-panel" aria-label="体绘制传递函数编辑器">
        <div class="transfer-title"><b>灰度 → 颜色 / 不透明度</b><span>点击添加 · 拖点调整 · 右键点删除</span></div>
        <svg viewBox="0 0 260 96" class="transfer-graph" aria-label="灰度不透明度控制曲线" @pointerdown="addPoint" @pointermove="moveTransfer" @pointerup="endTransfer" @pointercancel="endTransfer" @contextmenu.prevent>
          <path :d="histogramPath" class="histogram"/><path d="M8,8V88H252" class="graph-axis"/><path :d="transferPath" class="transfer-curve"/>
          <circle v-for="(point,index) in points" :key="index" :cx="graphX(point.value)" :cy="graphY(point.opacity)" :r="index===selected?4.5:3.5" :fill="colorHex(point.color)" :class="{selected:index===selected}" tabindex="0" :aria-label="`传递控制点 ${index+1}，灰度 ${point.value.toFixed(1)}，不透明度 ${point.opacity.toFixed(3)}`" @pointerdown="startTransfer($event,index)" @contextmenu.prevent.stop="deletePoint(index)" @focus="selected=index" @keydown.delete.prevent="deletePoint(index)"><title>{{point.value.toFixed(1)}} · α {{point.opacity.toFixed(3)}}</title></circle>
        </svg>
        <div class="graph-range"><span>{{domain[0].toFixed(0)}}</span><span>灰度 / {{intensityUnit||'GV'}}</span><span>{{domain[1].toFixed(0)}}</span></div>
        <div class="transfer-point"><label>灰度<input type="number" :value="selectedPoint.value" step="1" @change="editNumber($event,'value')"></label><label>α / 1 {{spatialUnit}}<input type="number" :value="selectedPoint.opacity" min="0" max="1" step=".01" @change="editNumber($event,'opacity')"></label><label>颜色<input type="color" :value="colorHex(selectedPoint.color)" @input="editColor"></label><button type="button" :disabled="points.length<=2" @click="deletePoint()">删除</button></div>
        <small>CT 示例预设可编辑；窗宽/窗位调节颜色亮度。此视图不生成 Part 或 STL。</small>
      </aside>
      <div class="volume-hint">体素光线积分 · 拖动旋转 · Shift / 右键平移 · 滚轮缩放</div>
    </div>
    <footer><label>不透明度<input v-model.number="globalOpacity" type="range" min="0" max="1" step=".01"></label><label>步长 <input v-model.number="stepMm" class="step-input" style="width:43px" type="number" :min="minimumStep" :max="maximumStep" :step="Math.max(1e-5,minimumStep/2)"> {{spatialUnit}}</label><label><input v-model="shading" type="checkbox"> 光照</label><span>{{info?`${(info.textureBytes/1048576).toFixed(1)} MiB · `:''}}R32F · WebGL2</span></footer>
  </section>
</template>

<style scoped>
.volume-viewport{display:flex;flex-direction:column;height:100%;min-height:260px;min-width:0;overflow:hidden;border:1px solid #293b53;border-radius:7px;background:#09101a;color:#b7cae1;font:11px 'Segoe UI','Microsoft YaHei',sans-serif}.volume-viewport header{min-height:38px;display:flex;gap:8px;align-items:center;justify-content:space-between;padding:5px 9px;border-bottom:1px solid #293b53;background:#142236;flex-wrap:wrap}.volume-viewport strong{font-size:12px;letter-spacing:.02em;color:#d6e7f8}.volume-actions{display:flex;gap:4px;align-items:center}.volume-viewport button,.volume-viewport select{border:1px solid #36506e;border-radius:4px;color:#c1d6ee;background:#1b304a;padding:3px 6px;font:inherit;cursor:pointer}.volume-viewport button:hover,.volume-viewport button.active{background:#2a486c}.volume-viewport button:disabled{opacity:.4;cursor:default}.volume-canvas-host{position:relative;flex:1;min-height:210px;overflow:hidden}.volume-canvas-host canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none;outline:none}.volume-canvas-host canvas:active{cursor:grabbing}.volume-canvas-host canvas:focus-visible{box-shadow:inset 0 0 0 2px #65baf0}.volume-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#ffc1ad;font-size:12px;background:#0b1424e8;pointer-events:none;line-height:1.8}.volume-hint{position:absolute;bottom:9px;left:10px;right:10px;text-align:center;font-size:10px;color:#778eaa;pointer-events:none}.transfer-panel{position:absolute;top:8px;right:8px;width:min(300px,calc(100% - 16px));padding:10px;background:#101f32ed;border:1px solid #3c5d80;border-radius:7px;box-shadow:0 6px 20px #0007}.transfer-title{display:flex;flex-direction:column;gap:4px}.transfer-title b{color:#d0e6fa;font-size:11px;font-weight:500}.transfer-title span{font-size:9px;color:#8ba5c2}.transfer-graph{display:block;width:100%;height:100px;margin-top:5px;background:#081526;border-radius:3px;touch-action:none;cursor:crosshair}.histogram{fill:none;stroke:#3d6385;stroke-width:1.7;opacity:.65}.graph-axis{fill:none;stroke:#42617e;stroke-width:.6}.transfer-curve{fill:none;stroke:#76d2d1;stroke-width:1.5}.transfer-graph circle{stroke:#d7f5ff;stroke-width:1;cursor:grab}.transfer-graph circle.selected{stroke:#fff1b8;stroke-width:2}.transfer-graph circle:active{cursor:grabbing}.graph-range{display:flex;justify-content:space-between;color:#7e9abb;font-size:9px;margin-top:2px}.transfer-point{display:flex;gap:6px;align-items:end;margin-top:8px}.transfer-point label{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;font-size:9px;color:#93b0cd}.transfer-point input:not([type=color]){min-width:0;width:100%;box-sizing:border-box;border:1px solid #36506e;border-radius:3px;background:#0c1a2e;padding:4px;color:#d3e6fb;font:10px Consolas,monospace}.transfer-point input[type=color]{width:28px;height:24px;padding:0;border:0;background:none}.transfer-point label:last-of-type{flex:0}.transfer-point button{height:25px}.transfer-panel small{display:block;margin-top:7px;font-size:9px;color:#7d9ab8;line-height:1.6}.volume-viewport footer{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:5px 8px;min-height:26px;background:#111d2f;border-top:1px solid #293b53;flex-wrap:wrap;font-size:9px;color:#7f9bb9}.volume-viewport footer label{display:flex;align-items:center;gap:4px;white-space:nowrap}.volume-viewport input[type=range]{width:62px;accent-color:#71c0e4}.volume-viewport input[type=checkbox]{accent-color:#70bcda}.step-input{width:43px;border:1px solid #344f6b;border-radius:3px;background:#0a182b;color:#bed6ed;padding:2px;font:10px Consolas,monospace}
</style>
