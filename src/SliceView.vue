<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue';
import type {Axis,ThresholdRange,Volume} from './core.ts';
import {sliceBox,sliceCoords,dragZoom} from './sliceGeometry.ts';
import type {ExteriorAirCache} from './exteriorAir.ts';
import {planePoint,indexOf,planeAxes} from './core.ts';
import {direction,edgeDirection,inputValue} from './view.ts';
import type {Segment,Tool} from './view.ts';
import {SliceRenderer} from './sliceRenderer.ts';
import type {GrayFrame} from './sliceRenderer.ts';
import {GrayRegionClient} from './grayRegionClient.ts';
import type {GrayMode,RegionOutline} from './grayRegions.ts';
const p=withDefaults(defineProps<{volume:Volume;mask:Uint16Array;axis:Axis;point:number[];revision:number;segments:Segment[];opacity:number;center:number;width:number;tool:Tool;diameter:number;thresholdPreview:ThresholdRange|null;parallelMap?:Map<number,number[]>;hoverPreview?:boolean;regionWidth?:number;regionMode?:GrayMode;allowEdit?:boolean;airCache?:ExteriorAirCache|null;zoom?:number;provenance?:(index:number)=>Promise<string>;provenanceKey?:string}>(),{hoverPreview:true,regionWidth:100,regionMode:'bands',allowEdit:true,zoom:1});
const emit=defineEmits<{zoom:[value:number];point:[value:number[]];start:[];stroke:[axis:Axis,slice:number,u:number,v:number];end:[];region:[axis:Axis,slice:number,pixels:Uint32Array]}>();
const host=ref<HTMLDivElement|null>(null),canvas=ref<HTMLCanvasElement|null>(null),size=ref([300,300]),outline=shallowRef<RegionOutline|null>(null),grayMessage=ref('');
const renderedSlice=ref(-1),renderCount=ref(0),grayBuilds=ref(0),renderMs=ref(0);
const zooming=ref(false),authorText=ref('');let zoomStartY=0,zoomInitial=1,zoomPointer=-1,authorGeneration=0,authorTimer:ReturnType<typeof setTimeout>|null=null,authorIndex=-1;
const hoverPosition=ref([12,12]);
const annotationStyle=computed(()=>{const left=Math.max(8,Math.min(hoverPosition.value[0]+14,size.value[0]-220)),top=Math.max(8,Math.min(hoverPosition.value[1]+16,size.value[1]-80));return {left:`${left}px`,right:'auto',top:`${top}px`,maxWidth:`${Math.max(80,Math.min(340,size.value[0]-left-8))}px`,overflowWrap:'anywhere' as const};});
const brushPoint=shallowRef<[number,number]|null>(null);
let drawing=false,last:[number,number]|null=null,observer:ResizeObserver,renderer:SliceRenderer|null=null,frame:GrayFrame|null=null,grayClient:GrayRegionClient|null=null;
let renderRAF=0,wheelRAF=0,wheelTarget:number|null=null,grayDirty=true,labelDirty=true,inside=false,lastClient:[number,number]|null=null,quietTimer:ReturnType<typeof setTimeout>|null=null;
let preparedVolume:Volume|null=null,renderedVolume:Volume|null=null,preparedSlice=-1,preparedKey='';
const geometry=computed(()=>{const [a,b]=planeAxes(p.axis),nx=p.volume.dims[a],ny=p.volume.dims[b],box=sliceBox(size.value,nx,ny,p.volume.spacing[a],p.volume.spacing[b],p.zoom);return {a,b,...box};});
const brushCursor=computed(()=>{
  if(!brushPoint.value||!p.allowEdit||zooming.value||(p.tool!=='paint'&&p.tool!=='erase'))return null;
  const g=geometry.value,[u,v]=brushPoint.value;
  return {x:g.ox+(u+.5)/g.nx*g.w,y:g.oy+(g.ny-v-.5)/g.ny*g.h,rx:p.diameter/2/p.volume.spacing[g.a]*g.w/g.nx,ry:p.diameter/2/p.volume.spacing[g.b]*g.h/g.ny};
});
function schedule(){if(!renderRAF)renderRAF=requestAnimationFrame(render);}
function render(){
  renderRAF=0;if(!renderer)return;const started=performance.now();
  if(grayDirty||!frame){frame=renderer.gray(p.volume,p.axis,p.point[p.axis],p.center,p.width);grayDirty=false;}
  if(labelDirty){renderer.labels(p.volume,p.axis,p.point[p.axis],p.mask,p.segments,p.thresholdPreview,p.parallelMap,p.airCache);labelDirty=false;}
  const g=geometry.value;renderer.draw(frame,size.value,g,p.point,g.a,g.b,p.opacity);renderedVolume=p.volume;renderedSlice.value=p.point[p.axis];renderCount.value=renderer.draws;grayBuilds.value=renderer.builds;renderMs.value=+(performance.now()-started).toFixed(2);
  if(inside&&p.hoverPreview&&!drawing&&!quietTimer)preview();
}
function resetRegion(){outline.value=null;grayMessage.value='';preparedKey='';grayClient?.clear();}
watch([()=>p.volume,()=>p.point[p.axis]],()=>{grayDirty=true;labelDirty=true;resetRegion();schedule();},{flush:'post'});
watch([()=>p.center,()=>p.width],()=>{grayDirty=true;schedule();},{flush:'post'});
watch([()=>p.mask,()=>p.revision,()=>p.thresholdPreview,()=>p.airCache,()=>p.parallelMap,()=>p.segments.map(s=>`${s.id}:${s.color}:${s.visible}`).join('|')],()=>{labelDirty=true;schedule();},{flush:'post'});
watch([()=>p.point[geometry.value.a],()=>p.point[geometry.value.b],()=>p.opacity,()=>size.value,()=>p.zoom],schedule,{flush:'post'});
watch([()=>p.hoverPreview,()=>p.regionMode,()=>p.regionWidth,()=>p.airCache],()=>{resetRegion();schedule();},{flush:'post'});
watch(()=>p.tool,()=>{if(drawing)end();grayClient?.clear();outline.value=null;if(inside&&p.hoverPreview)preview();});
onMounted(()=>{window.addEventListener('blur',cancelGesture);renderer=new SliceRenderer(canvas.value!);observer=new ResizeObserver(entries=>{size.value=[Math.max(80,entries[0].contentRect.width),Math.max(80,entries[0].contentRect.height)];});observer.observe(host.value!);schedule();});
onBeforeUnmount(()=>{clearAuthor();window.removeEventListener('blur',cancelGesture);observer?.disconnect();if(renderRAF)cancelAnimationFrame(renderRAF);if(wheelRAF)cancelAnimationFrame(wheelRAF);if(quietTimer)clearTimeout(quietTimer);grayClient?.destroy();renderer?.destroy();});
function coords(clientX:number,clientY:number):[number,number]|null{const rect=canvas.value!.getBoundingClientRect();return sliceCoords(geometry.value,clientX-rect.left,clientY-rect.top);}
function client(){
  if(!grayClient)grayClient=new GrayRegionClient(result=>{if(inside&&p.hoverPreview&&!drawing&&preparedVolume===p.volume&&preparedSlice===p.point[p.axis]){outline.value=result;grayMessage.value=result.truncated?'轮廓过于复杂，请增大灰度区间宽度。':'';}},pixels=>{if(p.tool==='region'&&p.allowEdit&&preparedVolume===p.volume&&preparedSlice===p.point[p.axis])emit('region',p.axis,preparedSlice,pixels);},message=>{grayMessage.value=message;});
  return grayClient;
}
function prepare(){
  if(!frame||renderedVolume!==p.volume||renderedSlice.value!==p.point[p.axis])return null;
  const c=client(),key=`${p.point[p.axis]}:${p.regionMode}:${p.regionWidth}`;
  if(preparedVolume!==p.volume||preparedKey!==key){preparedVolume=p.volume;preparedSlice=p.point[p.axis];preparedKey=key;outline.value=null;grayMessage.value='正在计算灰度区域…';c.prepare(frame.values,frame.width,frame.height,p.regionMode,p.regionWidth,p.airCache?.slice(p.axis,p.point[p.axis]));}
  return c;
}
function seed(point:[number,number]){const {nx,ny}=geometry.value;return Math.round(point[0])+nx*(ny-1-Math.round(point[1]));}
function preview(){if(!inside||!lastClient||!p.hoverPreview||drawing||zooming.value||quietTimer)return;const point=coords(...lastClient);if(!point){outline.value=null;grayClient?.clear();return;}prepare()?.hover(seed(point));}
function move(e:PointerEvent){
  if(zooming.value){if(e.pointerId===zoomPointer)emit('zoom',dragZoom(zoomInitial,zoomStartY,e.clientY));return;}
  lastClient=[e.clientX,e.clientY];const current=coords(e.clientX,e.clientY);
  const rect=canvas.value!.getBoundingClientRect();hoverPosition.value=[e.clientX-rect.left,e.clientY-rect.top];
  brushPoint.value=current;
  if(!drawing){hoverAuthor(current);inside=!!current;if(current)preview();else{outline.value=null;grayClient?.clear();}return;}
  if(!current){last=null;return;}
  const previous=last||current,steps=Math.max(1,Math.ceil(Math.hypot(current[0]-previous[0],current[1]-previous[1])*2));for(let i=1;i<=steps;i++)emit('stroke',p.axis,p.point[p.axis],previous[0]+(current[0]-previous[0])*i/steps,previous[1]+(current[1]-previous[1])*i/steps);last=current;
}
function start(e:PointerEvent){
  clearAuthor();if(e.ctrlKey&&e.button===2){e.preventDefault();end();zooming.value=true;zoomStartY=e.clientY;zoomInitial=p.zoom;zoomPointer=e.pointerId;outline.value=null;brushPoint.value=null;grayClient?.clear();canvas.value!.setPointerCapture(e.pointerId);return;}
  const point=coords(e.clientX,e.clientY),rect=canvas.value!.getBoundingClientRect(),ratio=window.devicePixelRatio||1;if(e.button!==0||!point||renderedVolume!==p.volume||renderedSlice.value!==p.point[p.axis]||Math.abs(canvas.value!.width-rect.width*ratio)>2||Math.abs(canvas.value!.height-rect.height*ratio)>2)return;
  lastClient=[e.clientX,e.clientY];inside=true;
  if(p.tool==='region'){if(p.allowEdit)prepare()?.select(seed(point));return;}
  if(!p.allowEdit||(p.tool!=='paint'&&p.tool!=='erase'))return;
  drawing=true;grayClient?.clear();outline.value=null;canvas.value!.setPointerCapture(e.pointerId);emit('start');move(e);
}
function end(){if(zooming.value){zooming.value=false;const id=zoomPointer;zoomPointer=-1;if(id>=0&&canvas.value?.hasPointerCapture(id))canvas.value.releasePointerCapture(id);return;}if(drawing){drawing=false;last=null;emit('end');preview();}}
function leave(){clearAuthor();brushPoint.value=null;inside=false;outline.value=null;grayMessage.value='';grayClient?.clear();}
function slice(value:number){const q=[...p.point];q[p.axis]=Math.max(0,Math.min(p.volume.dims[p.axis]-1,value));emit('point',q);}
function wheel(event:WheelEvent){
  clearAuthor();if(drawing||zooming.value||!event.deltaY)return;wheelTarget=Math.max(0,Math.min(p.volume.dims[p.axis]-1,(wheelTarget??p.point[p.axis])+(event.deltaY>0?1:-1)));outline.value=null;grayClient?.clear();
  if(quietTimer)clearTimeout(quietTimer);quietTimer=setTimeout(()=>{quietTimer=null;preview();},100);
  if(!wheelRAF)wheelRAF=requestAnimationFrame(()=>{wheelRAF=0;const target=wheelTarget;wheelTarget=null;if(target!==null)slice(target);});
}
function cancelGesture(){end();leave();}
function clearAuthor(){authorGeneration++;authorIndex=-1;authorText.value='';if(authorTimer)clearTimeout(authorTimer);authorTimer=null;}
function hoverAuthor(point:[number,number]|null){
  if(!point){clearAuthor();return;}
  const index=indexOf(planePoint(p.axis,p.point[p.axis],Math.round(point[0]),Math.round(point[1])),p.volume.dims);
  const labels=(p.parallelMap?.get(index)||[p.mask[index]]).filter(id=>id&&p.segments.some(segment=>segment.id===id&&segment.visible));
  if(!labels.length){clearAuthor();return;}if(authorIndex===index)return;
  clearAuthor();authorIndex=index;authorText.value=`标注内容：${labels.map(id=>`${p.segments.find(segment=>segment.id===id)?.name||'标签'}（${id}）`).join('；')}${p.provenance?'':'\n本地标注'}`;
  if(!p.provenance)return;const generation=authorGeneration;authorTimer=setTimeout(async()=>{authorTimer=null;try{const text=await p.provenance!(index);if(text&&generation===authorGeneration&&authorIndex===index)authorText.value=text;}catch{}},100);
}
watch([()=>p.volume,()=>p.point[p.axis],()=>p.provenanceKey,()=>p.zoom,()=>p.tool,()=>p.segments.map(segment=>`${segment.id}:${segment.name}:${segment.visible}`).join('|')],()=>{clearAuthor();if(inside&&lastClient&&!drawing&&!zooming.value)hoverAuthor(coords(...lastClient));},{flush:'post'});
</script>
<template>
  <section :class="['slice',`slice-${axis}`]" :data-zoom="zoom" :data-rendered-slice="renderedSlice" :data-renders="renderCount" :data-gray-builds="grayBuilds" :data-render-ms="renderMs">
    <header><span class="view-dot"/>{{direction(volume,axis)}}<span v-if="thresholdPreview" class="preview-badge">预览</span><span v-else-if="parallelMap?.size" class="preview-badge">并列标注</span><small>{{['I','J','K'][axis]}} = {{point[axis]+1}} / {{volume.dims[axis]}}</small></header>
    <div ref="host" class="canvas-host" @wheel.prevent="wheel">
      <canvas ref="canvas" @pointerenter="move" @pointerleave="leave" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @contextmenu.prevent/>
      <svg v-if="brushCursor" :class="['brush-cursor',{'eraser-cursor':tool==='erase'}]" :viewBox="`0 0 ${size[0]} ${size[1]}`" :aria-label="`${tool==='erase'?'橡皮擦':'画笔'}直径 ${diameter} ${volume.unit}`"><ellipse :cx="brushCursor.x" :cy="brushCursor.y" :rx="brushCursor.rx" :ry="brushCursor.ry"/><text :x="brushCursor.x+brushCursor.rx+7" :y="brushCursor.y-7">⌀ {{diameter}} {{volume.unit}}</text></svg>
      <svg v-if="outline?.path&&hoverPreview&&!drawing&&!zooming" class="gray-region-outline" :viewBox="`0 0 ${geometry.nx} ${geometry.ny}`" preserveAspectRatio="none" :style="{left:`${geometry.ox}px`,top:`${geometry.oy}px`,width:`${geometry.w}px`,height:`${geometry.h}px`}" aria-label="鼠标所在灰度区域轮廓"><path :d="outline.path" fill="none" stroke="#ffe26f" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <span v-if="inside&&hoverPreview&&!drawing&&!zooming" class="gray-region-info">{{outline&&outline.count===0?'外围空气已排除':outline&&!outline.truncated?`${outline.count.toLocaleString()} 像素 · 灰度 ${+outline.minimum.toFixed(2)}～${+outline.maximum.toFixed(2)}`:grayMessage}}</span>
      <span v-if="authorText&&!drawing&&!zooming" class="annotation-author" :style="annotationStyle" role="tooltip">{{authorText}}</span>
      <span class="edge top">{{edgeDirection(volume,geometry.b,true)}}</span><span class="edge bottom">{{edgeDirection(volume,geometry.b,false)}}</span><span class="edge left">{{edgeDirection(volume,geometry.a,false)}}</span><span class="edge right">{{edgeDirection(volume,geometry.a,true)}}</span>
    </div>
    <footer><button class="zoom-reset" :aria-label="`重置${direction(volume,axis)}缩放`" @click="emit('zoom',1)">{{Math.round(zoom*100)}}%</button><span>切片</span><input :aria-label="`${direction(volume,axis)}切片`" type="range" min="0" :max="volume.dims[axis]-1" :value="point[axis]" @input="slice(+inputValue($event))"/><span>{{point[axis]+1}}</span></footer>
  </section>
</template>
