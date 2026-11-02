<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue';
import UiIcon from './UiIcon.vue';
import type {Axis,ThresholdRange,Volume} from './core.ts';
import {sliceBox,sliceCoords,dragZoom,dragWindowLevel,slicePageIndex} from './sliceGeometry.ts';
import type {ExteriorAirCache} from './exteriorAir.ts';
import {planePoint,indexOf,planeAxes} from './core.ts';
import {direction,edgeDirection,inputValue} from './view.ts';
import type {Segment,Tool} from './view.ts';
import {SliceRenderer} from './sliceRenderer.ts';
import type {GrayFrame} from './sliceRenderer.ts';
import {GrayRegionClient} from './grayRegionClient.ts';
import type {GrayMode,RegionOutline} from './grayRegions.ts';
import {pinchView,touchPair,touchSlice,touchTap} from './touchGeometry.ts';
import type {TouchPoint} from './touchGeometry.ts';
import {registerTouchCanvas,touchCanvasAllowed} from './touchSession.ts';
const p=withDefaults(defineProps<{volume:Volume;mask:Uint16Array;axis:Axis;point:number[];revision:number;segments:Segment[];opacity:number;center:number;width:number;tool:Tool;diameter:number;thresholdPreview:ThresholdRange|null;parallelMap?:Map<number,number[]>;hoverPreview?:boolean;regionWidth?:number;regionMode?:GrayMode;allowEdit?:boolean;airCache?:ExteriorAirCache|null;zoom?:number;active?:boolean;maximized?:boolean;provenance?:(index:number)=>Promise<string>;provenanceKey?:string;touchMode?:'slice'|'paint'|'pan'|'window'}>(),{hoverPreview:false,regionWidth:100,regionMode:'bands',allowEdit:true,zoom:1,active:false,maximized:false,touchMode:'slice'});
const emit=defineEmits<{zoom:[value:number];point:[value:number[]];activate:[axis:Axis];focus:[axis:Axis];'window-level':[center:number,width:number];start:[pointerType?:string];cancel:[];stroke:[axis:Axis,slice:number,u:number,v:number];end:[];region:[axis:Axis,slice:number,pixels:Uint32Array]}>();
const host=ref<HTMLDivElement|null>(null),canvas=ref<HTMLCanvasElement|null>(null),size=ref([300,300]),outline=shallowRef<RegionOutline|null>(null),grayMessage=ref('');
const renderedSlice=ref(-1),renderCount=ref(0),grayBuilds=ref(0),renderMs=ref(0);
const slicePage=ref(String(p.point[p.axis]+1));
const gesture=ref<'zoom'|'pan'|'window'|'slice'|'pinch'|null>(null),pan=ref<[number,number]>([0,0]),authorText=ref('');
const navigating=computed(()=>gesture.value!==null);
let gestureStart:[number,number]=[0,0],panInitial:[number,number]=[0,0],zoomInitial=1,windowInitial:[number,number]=[0,1],gesturePointer=-1,drawPointer=-1,authorGeneration=0,authorTimer:ReturnType<typeof setTimeout>|null=null,authorIndex=-1;
const touches=new Map<number,TouchPoint>(),ignoredTouches=new Set<number>();
let unregisterTouchCanvas:(()=>void)|null=null;
let touchStart:TouchPoint={x:0,y:0},touchStarted=0,touchSliceInitial=0,touchBlocked=false,touchRegion=false,penPointer=-1;
let pinchInitial:{center:[number,number];distance:number;zoom:number;pan:[number,number]}|null=null;
const hoverPosition=ref([12,12]);
const annotationStyle=computed(()=>{const left=Math.max(8,Math.min(hoverPosition.value[0]+14,size.value[0]-220)),top=Math.max(8,Math.min(hoverPosition.value[1]+16,size.value[1]-80));return {left:`${left}px`,right:'auto',top:`${top}px`,maxWidth:`${Math.max(80,Math.min(340,size.value[0]-left-8))}px`,overflowWrap:'anywhere' as const};});
const brushPoint=shallowRef<[number,number]|null>(null);
let drawing=false,last:[number,number]|null=null,observer:ResizeObserver,renderer:SliceRenderer|null=null,frame:GrayFrame|null=null,grayClient:GrayRegionClient|null=null;
let renderRAF=0,wheelRAF=0,wheelTarget:number|null=null,grayDirty=true,labelDirty=true,inside=false,lastClient:[number,number]|null=null,quietTimer:ReturnType<typeof setTimeout>|null=null;
let preparedVolume:Volume|null=null,renderedVolume:Volume|null=null,preparedSlice=-1,preparedKey='';
let renderedGeometry:{ox:number;oy:number;w:number;h:number}|null=null;
const geometry=computed(()=>{const [a,b]=planeAxes(p.axis),nx=p.volume.dims[a],ny=p.volume.dims[b],box=sliceBox(size.value,nx,ny,p.volume.spacing[a],p.volume.spacing[b],p.zoom,pan.value);return {a,b,...box};});
const brushCursor=computed(()=>{
  if(!brushPoint.value||!p.allowEdit||navigating.value||(p.tool!=='paint'&&p.tool!=='erase'))return null;
  const g=geometry.value,[u,v]=brushPoint.value;
  return {x:g.ox+(u+.5)/g.nx*g.w,y:g.oy+(g.ny-v-.5)/g.ny*g.h,rx:p.diameter/2/p.volume.spacing[g.a]*g.w/g.nx,ry:p.diameter/2/p.volume.spacing[g.b]*g.h/g.ny};
});
function schedule(){if(!renderRAF)renderRAF=requestAnimationFrame(render);}
function render(){
  renderRAF=0;if(!renderer)return;const started=performance.now();
  if(grayDirty||!frame){frame=renderer.gray(p.volume,p.axis,p.point[p.axis],p.center,p.width);grayDirty=false;}
  if(labelDirty){renderer.labels(p.volume,p.axis,p.point[p.axis],p.mask,p.segments,p.thresholdPreview,p.parallelMap,p.airCache);labelDirty=false;}
  const g=geometry.value;renderer.draw(frame,size.value,g,p.point,g.a,g.b,p.opacity);renderedGeometry={ox:g.ox,oy:g.oy,w:g.w,h:g.h};renderedVolume=p.volume;renderedSlice.value=p.point[p.axis];renderCount.value=renderer.draws;grayBuilds.value=renderer.builds;renderMs.value=+(performance.now()-started).toFixed(2);
  if(inside&&p.hoverPreview&&!drawing&&!quietTimer)preview();
}
function resetRegion(){outline.value=null;grayMessage.value='';preparedKey='';grayClient?.clear();}
watch([()=>p.volume,()=>p.point[p.axis]],()=>{grayDirty=true;labelDirty=true;resetRegion();schedule();},{flush:'post'});
watch([()=>p.volume,()=>p.axis,()=>p.point[p.axis]],resetSlicePage);
watch([()=>p.center,()=>p.width],()=>{grayDirty=true;schedule();},{flush:'post'});
watch([()=>p.mask,()=>p.revision,()=>p.thresholdPreview,()=>p.airCache,()=>p.parallelMap,()=>p.segments.map(s=>`${s.id}:${s.color}:${s.visible}`).join('|')],()=>{labelDirty=true;schedule();},{flush:'post'});
watch([()=>p.point[geometry.value.a],()=>p.point[geometry.value.b],()=>p.opacity,()=>size.value,()=>p.zoom,()=>pan.value[0],()=>pan.value[1]],schedule,{flush:'post'});
watch([()=>p.hoverPreview,()=>p.regionMode,()=>p.regionWidth,()=>p.airCache],()=>{resetRegion();schedule();},{flush:'post'});
watch([()=>p.tool,()=>p.touchMode],()=>{cancelGesture();grayClient?.clear();outline.value=null;if(inside&&p.hoverPreview)preview();});
watch(()=>p.volume,()=>{cancelGesture();pan.value=[0,0];});
watch(()=>p.allowEdit,value=>{if(!value)cancelGesture();});
onMounted(()=>{unregisterTouchCanvas=registerTouchCanvas(canvas.value!,cancelGesture);window.addEventListener('blur',resetInteractions);document.addEventListener('visibilitychange',visibility);window.addEventListener('pointerup',clearIgnoredTouch);window.addEventListener('pointercancel',clearIgnoredTouch);renderer=new SliceRenderer(canvas.value!);observer=new ResizeObserver(entries=>{size.value=[Math.max(80,entries[0].contentRect.width),Math.max(80,entries[0].contentRect.height)];});observer.observe(host.value!);schedule();});
onBeforeUnmount(()=>{cancelGesture();unregisterTouchCanvas?.();clearAuthor();window.removeEventListener('blur',resetInteractions);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pointerup',clearIgnoredTouch);window.removeEventListener('pointercancel',clearIgnoredTouch);observer?.disconnect();if(renderRAF)cancelAnimationFrame(renderRAF);if(wheelRAF)cancelAnimationFrame(wheelRAF);if(quietTimer)clearTimeout(quietTimer);grayClient?.destroy();renderer?.destroy();});
function coords(clientX:number,clientY:number):[number,number]|null{const rect=canvas.value!.getBoundingClientRect();return sliceCoords(geometry.value,clientX-rect.left,clientY-rect.top);}
function currentTransform(){const g=geometry.value,r=renderedGeometry;return !!r&&r.ox===g.ox&&r.oy===g.oy&&r.w===g.w&&r.h===g.h;}
function client(){
  if(!grayClient)grayClient=new GrayRegionClient(result=>{if(inside&&p.hoverPreview&&!drawing&&preparedVolume===p.volume&&preparedSlice===p.point[p.axis]){outline.value=result;grayMessage.value=result.truncated?'轮廓过于复杂，请增大灰度区间宽度。':'';}},pixels=>{if(p.tool==='region'&&p.allowEdit&&preparedVolume===p.volume&&preparedSlice===p.point[p.axis])emit('region',p.axis,preparedSlice,pixels);},message=>{grayMessage.value=message;});
  return grayClient;
}
function prepare(){
  if(!frame||renderedVolume!==p.volume||renderedSlice.value!==p.point[p.axis]||!currentTransform())return null;
  const c=client(),key=`${p.point[p.axis]}:${p.regionMode}:${p.regionWidth}`;
  if(preparedVolume!==p.volume||preparedKey!==key){preparedVolume=p.volume;preparedSlice=p.point[p.axis];preparedKey=key;outline.value=null;grayMessage.value='正在计算灰度区域…';c.prepare(frame.values,frame.width,frame.height,p.regionMode,p.regionWidth,p.airCache?.slice(p.axis,p.point[p.axis]));}
  return c;
}
function seed(point:[number,number]){const {nx,ny}=geometry.value;return Math.round(point[0])+nx*(ny-1-Math.round(point[1]));}
function preview(){if(!inside||!lastClient||!p.hoverPreview||drawing||navigating.value||quietTimer)return;const point=coords(...lastClient);if(!point){outline.value=null;grayClient?.clear();return;}prepare()?.hover(seed(point));}
function move(e:PointerEvent){
  if(e.pointerType==='touch'){moveTouch(e);return;}
  if(drawing&&e.pointerId!==drawPointer)return;
  if(navigating.value){
    if(e.pointerId!==gesturePointer)return;
    if(!(e.buttons&(gesture.value==='pan'?4:2))){end(e);return;}
    e.preventDefault();lastClient=[e.clientX,e.clientY];
    const dx=e.clientX-gestureStart[0],dy=e.clientY-gestureStart[1];
    if(gesture.value==='zoom')emit('zoom',dragZoom(zoomInitial,gestureStart[1],e.clientY));
    else if(gesture.value==='pan')pan.value=[panInitial[0]+dx,panInitial[1]+dy];
    else{const next=dragWindowLevel(windowInitial[0],windowInitial[1],dx,dy);emit('window-level',next.center,next.width);}return;
  }
  if(drawing&&!(e.buttons&1)){end(e);return;}
  if(drawing&&(renderedVolume!==p.volume||renderedSlice.value!==p.point[p.axis]||!currentTransform())){lastClient=[e.clientX,e.clientY];last=null;brushPoint.value=null;return;}
  lastClient=[e.clientX,e.clientY];const current=coords(e.clientX,e.clientY);
  const rect=canvas.value!.getBoundingClientRect();hoverPosition.value=[e.clientX-rect.left,e.clientY-rect.top];
  brushPoint.value=current;
  if(!drawing){hoverAuthor(current);inside=!!current;if(current)preview();else{outline.value=null;grayClient?.clear();}return;}
  if(!current){last=null;return;}
  const previous=last||current,steps=Math.max(1,Math.ceil(Math.hypot(current[0]-previous[0],current[1]-previous[1])*2));for(let i=1;i<=steps;i++)emit('stroke',p.axis,p.point[p.axis],previous[0]+(current[0]-previous[0])*i/steps,previous[1]+(current[1]-previous[1])*i/steps);last=current;
}
function start(e:PointerEvent){
  if(e.pointerType==='touch'){startTouch(e);return;}
  if(e.pointerType==='pen'){cancelTouches();penPointer=e.pointerId;}
  emit('activate',p.axis);clearAuthor();
  let pendingSlice=false;
  if(wheelRAF){cancelAnimationFrame(wheelRAF);wheelRAF=0;const target=wheelTarget;wheelTarget=null;if(target!==null){slice(target);pendingSlice=true;}}
  if(e.button===1||e.button===2){
    e.preventDefault();end();gesture.value=e.button===1?'pan':e.ctrlKey?'zoom':'window';gestureStart=[e.clientX,e.clientY];panInitial=[...pan.value];zoomInitial=p.zoom;windowInitial=[p.center,p.width];gesturePointer=e.pointerId;
    outline.value=null;brushPoint.value=null;grayClient?.clear();canvas.value!.setPointerCapture(e.pointerId);return;
  }
  if(drawing||navigating.value||pendingSlice)return;
  const point=coords(e.clientX,e.clientY),rect=canvas.value!.getBoundingClientRect(),ratio=window.devicePixelRatio||1;if(e.button!==0||!point||renderedVolume!==p.volume||renderedSlice.value!==p.point[p.axis]||!currentTransform()||Math.abs(canvas.value!.width-rect.width*ratio)>2||Math.abs(canvas.value!.height-rect.height*ratio)>2)return;
  lastClient=[e.clientX,e.clientY];inside=true;
  if(p.tool==='region'){if(p.allowEdit)prepare()?.select(seed(point));return;}
  if(!p.allowEdit||(p.tool!=='paint'&&p.tool!=='erase'))return;
  drawing=true;drawPointer=e.pointerId;grayClient?.clear();outline.value=null;canvas.value!.setPointerCapture(e.pointerId);emit('start',e.pointerType);move(e);
}
function end(event?:PointerEvent){
  if(event?.pointerType==='touch'){endTouch(event);return;}
  if(event?.pointerId===penPointer)penPointer=-1;
  if(navigating.value){if(event&&event.pointerId!==gesturePointer)return;gesture.value=null;const id=gesturePointer;gesturePointer=-1;if(id>=0&&canvas.value?.hasPointerCapture(id))canvas.value.releasePointerCapture(id);brushPoint.value=null;inside=false;return;}
  if(drawing){if(event&&event.pointerId!==drawPointer)return;drawing=false;last=null;const id=drawPointer;drawPointer=-1;if(id>=0&&canvas.value?.hasPointerCapture(id))canvas.value.releasePointerCapture(id);emit('end');preview();}
}
function resetView(){cancelGesture();pan.value=[0,0];emit('zoom',1);emit('activate',p.axis);clearAuthor();brushPoint.value=null;outline.value=null;grayClient?.clear();}
function leave(event?:PointerEvent){
  if(event?.pointerType!=='touch')clearAuthor();brushPoint.value=null;inside=false;outline.value=null;grayMessage.value='';
  // Touch releases implicitly leave the canvas. Hide the preview without cancelling
  // the region selection just queued on pointerup; explicit cancellation paths call
  // leave() without an event and still invalidate the worker request.
  if(event?.pointerType!=='touch'||touches.size>0)grayClient?.clear();
}
function slice(value:number){emit('activate',p.axis);const q=[...p.point];q[p.axis]=Math.max(0,Math.min(p.volume.dims[p.axis]-1,value));emit('point',q);}
function resetSlicePage(){slicePage.value=String(p.point[p.axis]+1);}
function commitSlicePage(){const index=slicePageIndex(slicePage.value,p.volume.dims[p.axis]);if(index===null){resetSlicePage();return;}slicePage.value=String(index+1);if(index!==p.point[p.axis])slice(index);}
function wheel(event:WheelEvent){
  clearAuthor();if(drawing||navigating.value||!event.deltaY)return;emit('activate',p.axis);wheelTarget=Math.max(0,Math.min(p.volume.dims[p.axis]-1,(wheelTarget??p.point[p.axis])+(event.deltaY>0?1:-1)));outline.value=null;grayClient?.clear();
  if(quietTimer)clearTimeout(quietTimer);quietTimer=setTimeout(()=>{quietTimer=null;preview();},100);
  if(!wheelRAF)wheelRAF=requestAnimationFrame(()=>{wheelRAF=0;const target=wheelTarget;wheelTarget=null;if(target!==null)slice(target);});
}
function release(id:number){if(canvas.value?.hasPointerCapture(id))canvas.value.releasePointerCapture(id);}
function cancelDrawing(releaseCapture=true){if(!drawing)return;drawing=false;last=null;const id=drawPointer;drawPointer=-1;emit('cancel');if(releaseCapture)release(id);}
function cancelTouches(){
  for(const id of touches.keys())ignoredTouches.add(id);
  const ids=[...touches.keys()];touches.clear();touchBlocked=true;touchRegion=false;pinchInitial=null;
  if(drawing)cancelDrawing();gesture.value=null;gesturePointer=-1;for(const id of ids)release(id);
}
function cancelGesture(){const id=gesturePointer;cancelDrawing();cancelTouches();gesture.value=null;gesturePointer=-1;release(id);penPointer=-1;leave();}
function resetInteractions(){cancelGesture();ignoredTouches.clear();touchBlocked=false;}
function visibility(){if(document.visibilityState==='hidden')resetInteractions();}
function clearIgnoredTouch(event:PointerEvent){if(event.pointerType==='pen'&&event.pointerId===penPointer)penPointer=-1;if(event.pointerType==='touch'&&ignoredTouches.delete(event.pointerId)&&!touches.size&&!ignoredTouches.size)touchBlocked=false;}
function pointerInterrupted(event:PointerEvent){
  if(event.pointerType==='touch'){
    // A capture released intentionally has already been removed from touches.
    if(touches.has(event.pointerId)){cancelTouches();leave();}
    if(event.type==='pointercancel')ignoredTouches.delete(event.pointerId);
    if(!touches.size&&!ignoredTouches.size)touchBlocked=false;
    return;
  }
  if(event.pointerId===drawPointer||event.pointerId===gesturePointer||event.pointerId===penPointer)cancelGesture();
}
function localPoint(point:TouchPoint):[number,number]{const rect=canvas.value!.getBoundingClientRect();return [point.x-rect.left,point.y-rect.top];}
function rememberPosition(point:TouchPoint){lastClient=[point.x,point.y];hoverPosition.value=localPoint(point);}
function readyPoint(point:TouchPoint){
  const rect=canvas.value!.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
  return renderedVolume===p.volume&&renderedSlice.value===p.point[p.axis]&&currentTransform()&&Math.abs(canvas.value!.width-rect.width*ratio)<=2&&Math.abs(canvas.value!.height-rect.height*ratio)<=2?coords(point.x,point.y):null;
}
function beginPinch(){
  // The first finger still owns its capture during the new two-finger gesture.
  cancelDrawing(false);touchRegion=false;grayClient?.clear();outline.value=null;brushPoint.value=null;inside=false;
  const pair=[...touches.values()];if(pair.length!==2)return;
  const info=touchPair(pair[0],pair[1]);pinchInitial={center:localPoint({x:info.center[0],y:info.center[1]}),distance:Math.max(1,info.distance),zoom:p.zoom,pan:[...pan.value]};gesture.value='pinch';
}
function startTouch(event:PointerEvent){
  event.preventDefault();emit('activate',p.axis);clearAuthor();
  if(!touchCanvasAllowed(canvas.value!)||penPointer>=0||ignoredTouches.size){ignoredTouches.add(event.pointerId);return;}
  if(!touches.size&&!ignoredTouches.size)touchBlocked=false;
  const point={x:event.clientX,y:event.clientY};touches.set(event.pointerId,point);canvas.value!.setPointerCapture(event.pointerId);
  if(touches.size===2&&!touchBlocked){beginPinch();return;}
  if(touches.size>2){cancelTouches();return;}
  if(touchBlocked)return;
  // Do not begin a touch against a wheel-selected slice that has not rendered yet.
  if(wheelRAF){cancelAnimationFrame(wheelRAF);wheelRAF=0;const target=wheelTarget;wheelTarget=null;if(target!==null)slice(target);touchBlocked=true;return;}
  touchStart=point;touchStarted=performance.now();touchSliceInitial=p.point[p.axis];gestureStart=[point.x,point.y];panInitial=[...pan.value];windowInitial=[p.center,p.width];rememberPosition(point);
  const current=readyPoint(point);inside=!!current;
  if(p.touchMode!=='paint'){gesture.value=p.touchMode;brushPoint.value=null;outline.value=null;grayClient?.clear();return;}
  if(!current||!p.allowEdit)return;
  brushPoint.value=current;
  if(p.tool==='region'){touchRegion=true;preview();return;}
  if(p.tool!=='paint'&&p.tool!=='erase')return;
  drawing=true;drawPointer=event.pointerId;last=null;grayClient?.clear();outline.value=null;emit('start','touch');drawAt(current);
}
function drawAt(current:[number,number]|null){
  if(!current){last=null;return;}
  const previous=last||current,steps=Math.max(1,Math.ceil(Math.hypot(current[0]-previous[0],current[1]-previous[1])*2));
  for(let i=1;i<=steps;i++)emit('stroke',p.axis,p.point[p.axis],previous[0]+(current[0]-previous[0])*i/steps,previous[1]+(current[1]-previous[1])*i/steps);last=current;
}
function moveTouch(event:PointerEvent){
  if(!touches.has(event.pointerId))return;event.preventDefault();
  const point={x:event.clientX,y:event.clientY};touches.set(event.pointerId,point);if(touchBlocked)return;
  if(gesture.value==='pinch'&&pinchInitial&&touches.size===2){
    const pair=[...touches.values()],info=touchPair(pair[0],pair[1]),next=pinchView(pinchInitial.zoom,pinchInitial.pan,size.value,pinchInitial.center,pinchInitial.distance,localPoint({x:info.center[0],y:info.center[1]}),info.distance);
    pan.value=next.pan;emit('zoom',next.zoom);return;
  }
  rememberPosition(point);const dx=point.x-touchStart.x,dy=point.y-touchStart.y;
  if(gesture.value==='slice'){const target=touchSlice(touchSliceInitial,touchStart.y,point.y,p.volume.dims[p.axis]);if(target!==p.point[p.axis])slice(target);return;}
  if(gesture.value==='pan'){pan.value=[panInitial[0]+dx,panInitial[1]+dy];return;}
  if(gesture.value==='window'){const next=dragWindowLevel(windowInitial[0],windowInitial[1],dx,dy);emit('window-level',next.center,next.width);return;}
  const current=readyPoint(point);brushPoint.value=current;inside=!!current;
  if(drawing){if(!current){last=null;return;}drawAt(current);return;}
  if(touchRegion){if(current)preview();else{outline.value=null;grayClient?.clear();}}
}
function endTouch(event:PointerEvent){
  event.preventDefault();
  if(ignoredTouches.delete(event.pointerId)){if(!touches.size&&!ignoredTouches.size)touchBlocked=false;return;}
  if(!touches.has(event.pointerId))return;
  const wasBlocked=touchBlocked,wasPinch=gesture.value==='pinch',point={x:event.clientX,y:event.clientY};touches.delete(event.pointerId);
  if(wasPinch||touches.size){touchBlocked=true;touchRegion=false;pinchInitial=null;gesture.value=null;cancelDrawing();release(event.pointerId);if(!touches.size)touchBlocked=false;return;}
  const region=touchRegion;touchRegion=false;gesture.value=null;pinchInitial=null;
  if(!wasBlocked){
    rememberPosition(point);
    if(drawing&&event.pointerId===drawPointer){drawing=false;last=null;drawPointer=-1;emit('end');}
    else if(region&&p.allowEdit&&p.tool==='region'){const current=readyPoint(point);if(current)prepare()?.select(seed(current));}
    else if(p.touchMode==='slice'&&touchTap(touchStart,point,performance.now()-touchStarted)){inside=!!coords(point.x,point.y);hoverAuthor(coords(point.x,point.y));}
  }else cancelDrawing();
  release(event.pointerId);touchBlocked=false;brushPoint.value=null;inside=false;outline.value=null;
}
function clearAuthor(){authorGeneration++;authorIndex=-1;authorText.value='';if(authorTimer)clearTimeout(authorTimer);authorTimer=null;}
function hoverAuthor(point:[number,number]|null){
  if(!point){clearAuthor();return;}
  const index=indexOf(planePoint(p.axis,p.point[p.axis],Math.round(point[0]),Math.round(point[1])),p.volume.dims);
  const labels=(p.parallelMap?.get(index)||[p.mask[index]]).filter(id=>id&&p.segments.some(segment=>segment.id===id&&segment.visible));
  if(!labels.length){clearAuthor();return;}if(authorIndex===index)return;
  clearAuthor();authorIndex=index;authorText.value=`标注内容：${labels.map(id=>`${p.segments.find(segment=>segment.id===id)?.name||'标签'}（${id}）`).join('；')}${p.provenance?'':'\n本地标注'}`;
  if(!p.provenance)return;const generation=authorGeneration;authorTimer=setTimeout(async()=>{authorTimer=null;try{const text=await p.provenance!(index);if(text&&generation===authorGeneration&&authorIndex===index)authorText.value=text;}catch{}},100);
}
watch([()=>p.volume,()=>p.point[p.axis],()=>p.provenanceKey,()=>p.zoom,()=>pan.value[0],()=>pan.value[1],()=>p.tool,()=>p.segments.map(segment=>`${segment.id}:${segment.name}:${segment.visible}`).join('|')],()=>{clearAuthor();if(inside&&lastClient&&!drawing&&!navigating.value)hoverAuthor(coords(...lastClient));},{flush:'post'});
</script>
<template>
  <section :class="['slice',`slice-${axis}`,{'is-active':active}]" :data-touch-mode="touchMode" :data-maximized="maximized" :data-zoom="zoom" :data-pan-x="pan[0]" :data-pan-y="pan[1]" :data-gesture="gesture" :data-rendered-slice="renderedSlice" :data-renders="renderCount" :data-gray-builds="grayBuilds" :data-render-ms="renderMs" @focusin="emit('activate',axis)" @pointerenter="emit('activate',axis)">
    <header tabindex="0" title="单击选中视图；双击标题或按空格最大化 / 恢复" @click="emit('activate',axis)" @dblclick="emit('focus',axis)"><span class="view-dot"/>{{direction(volume,axis)}}<span v-if="thresholdPreview" class="preview-badge">预览</span><span v-else-if="parallelMap?.size" class="preview-badge">并列标注</span><small>{{['I','J','K'][axis]}} = {{point[axis]+1}} / {{volume.dims[axis]}}</small><button class="viewport-maximize" :aria-label="`${maximized?'恢复多视图':`最大化${direction(volume,axis)}视图`}`" :title="maximized?'恢复多视图 · Esc / 空格':'最大化此视图 · 双击标题 / 空格'" :aria-pressed="maximized" @click.stop="emit('focus',axis)" @dblclick.stop><UiIcon :name="maximized?'restore':'maximize'" :size="16"/></button></header>
    <div ref="host" class="canvas-host" @wheel.prevent="wheel">
      <canvas ref="canvas" @pointerenter="move" @pointerleave="leave" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="pointerInterrupted" @lostpointercapture="pointerInterrupted" @contextmenu.prevent/>
      <svg v-if="brushCursor" :class="['brush-cursor',{'eraser-cursor':tool==='erase'}]" :viewBox="`0 0 ${size[0]} ${size[1]}`" :aria-label="`${tool==='erase'?'橡皮擦':'画笔'}直径 ${diameter} ${volume.unit}`"><ellipse :cx="brushCursor.x" :cy="brushCursor.y" :rx="brushCursor.rx" :ry="brushCursor.ry"/><text :x="brushCursor.x+brushCursor.rx+7" :y="brushCursor.y-7">⌀ {{diameter}} {{volume.unit}}</text></svg>
      <svg v-if="outline?.path&&hoverPreview&&!drawing&&!navigating" class="gray-region-outline" :viewBox="`0 0 ${geometry.nx} ${geometry.ny}`" preserveAspectRatio="none" :style="{left:`${geometry.ox}px`,top:`${geometry.oy}px`,width:`${geometry.w}px`,height:`${geometry.h}px`}" aria-label="当前指向的灰度区域轮廓"><path :d="outline.path" fill="none" stroke="#ffe26f" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <span v-if="inside&&hoverPreview&&!drawing&&!navigating" class="gray-region-info">{{outline&&outline.count===0?'外围空气已排除':outline&&!outline.truncated?`${outline.count.toLocaleString()} 像素 · 灰度 ${+outline.minimum.toFixed(2)}～${+outline.maximum.toFixed(2)}`:grayMessage}}</span>
      <span v-if="authorText&&!drawing&&!navigating" class="annotation-author" :style="annotationStyle" role="tooltip">{{authorText}}</span>
      <span class="edge top">{{edgeDirection(volume,geometry.b,true)}}</span><span class="edge bottom">{{edgeDirection(volume,geometry.b,false)}}</span><span class="edge left">{{edgeDirection(volume,geometry.a,false)}}</span><span class="edge right">{{edgeDirection(volume,geometry.a,true)}}</span>
    </div>
    <footer><button class="zoom-reset" title="重置当前视图的缩放与平移" :aria-label="`重置${direction(volume,axis)}缩放`" @click="resetView">{{Math.round(zoom*100)}}%</button><span>切片</span><input :aria-label="`${direction(volume,axis)}切片`" type="range" min="0" :max="volume.dims[axis]-1" :value="point[axis]" @input="slice(+inputValue($event))"/><span class="slice-page-control"><input :value="slicePage" class="slice-page-input" type="number" inputmode="numeric" min="1" :max="volume.dims[axis]" step="1" :aria-label="`${direction(volume,axis)}切片页码`" title="输入切片页码，按 Enter 或离开输入框跳转" @input="slicePage=inputValue($event)" @keydown.enter.prevent.stop="commitSlicePage" @keydown.esc.prevent.stop="resetSlicePage" @blur="commitSlicePage"/><span class="slice-page-total">/ {{volume.dims[axis]}}</span></span></footer>
  </section>
</template>
