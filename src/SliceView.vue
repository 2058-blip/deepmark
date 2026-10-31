<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchPostEffect } from 'vue';
import { indexOf, planeAxes, planePoint, thresholdLabel } from './core.ts';
import type { Axis, ThresholdRange, Volume } from './core.ts';
import { direction, edgeDirection, inputValue } from './view.ts';
import type { Segment, Tool } from './view.ts';
const p=defineProps<{volume:Volume;mask:Uint16Array;axis:Axis;point:number[];revision:number;segments:Segment[];opacity:number;center:number;width:number;tool:Tool;diameter:number;thresholdPreview:ThresholdRange|null}>();
const emit=defineEmits<{point:[value:number[]];start:[];stroke:[axis:Axis,slice:number,u:number,v:number];end:[]}>();
const host=ref<HTMLDivElement|null>(null),canvas=ref<HTMLCanvasElement|null>(null),size=ref([300,300]);
let drawing=false,last:[number,number]|null=null,observer:ResizeObserver;
const geometry=computed(()=>{
  const [a,b]=planeAxes(p.axis),nx=p.volume.dims[a],ny=p.volume.dims[b];
  const scale=Math.min((size.value[0]-36)/(nx*p.volume.spacing[a]),(size.value[1]-36)/(ny*p.volume.spacing[b]));
  const w=nx*p.volume.spacing[a]*scale,h=ny*p.volume.spacing[b]*scale;
  return {a,b,nx,ny,w,h,ox:(size.value[0]-w)/2,oy:(size.value[1]-h)/2};
});
onMounted(()=>{observer=new ResizeObserver(entries=>{size.value=[Math.max(80,entries[0].contentRect.width),Math.max(80,entries[0].contentRect.height)];});observer.observe(host.value!);});
onBeforeUnmount(()=>observer?.disconnect());
watchPostEffect(()=>{
  if(!canvas.value)return;void p.revision;
  const {a,b,nx,ny,w,h,ox,oy}=geometry.value,c=canvas.value,ratio=window.devicePixelRatio||1;
  c.width=Math.round(size.value[0]*ratio);c.height=Math.round(size.value[1]*ratio);
  const ctx=c.getContext('2d')!;ctx.scale(ratio,ratio);ctx.fillStyle='#080c11';ctx.fillRect(0,0,...size.value as [number,number]);
  const layer=document.createElement('canvas');layer.width=nx;layer.height=ny;
  const lc=layer.getContext('2d')!,image=lc.createImageData(nx,ny);
  const palette=new Map(p.segments.filter(s=>s.visible).map(s=>[s.id,[1,3,5].map(i=>parseInt(s.color.slice(i,i+2),16))]));
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const i=indexOf(planePoint(p.axis,p.point[p.axis],x,ny-1-y),p.volume.dims);
    const gray=Math.max(0,Math.min(255,(p.volume.data[i]-(p.center-p.width/2))/p.width*255));
    const label=p.thresholdPreview?thresholdLabel(p.volume.data[i],p.mask[i],p.thresholdPreview):p.mask[i],rgb=palette.get(label),j=4*(x+nx*y);
    for(let k=0;k<3;k++)image.data[j+k]=rgb?gray*(1-p.opacity)+rgb[k]*p.opacity:gray;image.data[j+3]=255;
  }
  lc.putImageData(image,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(layer,ox,oy,w,h);
  const cx=ox+(p.point[a]+.5)/nx*w,cy=oy+(ny-p.point[b]-.5)/ny*h;
  ctx.strokeStyle='#ffffff66';ctx.lineWidth=1;ctx.setLineDash([4,5]);ctx.beginPath();ctx.moveTo(cx,oy);ctx.lineTo(cx,oy+h);ctx.moveTo(ox,cy);ctx.lineTo(ox+w,cy);ctx.stroke();
});
function coords(e:PointerEvent):[number,number]|null{
  const {nx,ny,w,h,ox,oy}=geometry.value,rect=canvas.value!.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
  if(x<ox||x>ox+w||y<oy||y>oy+h)return null;
  return [Math.min(nx-1,Math.max(0,(x-ox)/w*nx-.5)),Math.min(ny-1,Math.max(0,ny-.5-(y-oy)/h*ny))];
}
function move(e:PointerEvent){
  if(!drawing)return;const current=coords(e);if(!current){last=null;return;}
  if(p.tool==='navigate'||p.tool==='threshold'){const q=[...p.point];q[geometry.value.a]=Math.round(current[0]);q[geometry.value.b]=Math.round(current[1]);emit('point',q);return;}
  const previous=last||current,steps=Math.max(1,Math.ceil(Math.hypot(current[0]-previous[0],current[1]-previous[1])*2));
  for(let i=1;i<=steps;i++)emit('stroke',p.axis,p.point[p.axis],previous[0]+(current[0]-previous[0])*i/steps,previous[1]+(current[1]-previous[1])*i/steps);
  last=current;
}
function start(e:PointerEvent){if(e.button!==0||!coords(e))return;drawing=true;canvas.value!.setPointerCapture(e.pointerId);emit('start');move(e);}
function end(){if(drawing){drawing=false;last=null;emit('end');}}
function slice(value:number){const q=[...p.point];q[p.axis]=Math.max(0,Math.min(p.volume.dims[p.axis]-1,value));emit('point',q);}
</script>
<template>
  <section :class="['slice',`slice-${axis}`]">
    <header><span class="view-dot"/>{{direction(volume,axis)}}<span v-if="thresholdPreview" class="preview-badge">预览</span><small>{{['I','J','K'][axis]}} = {{point[axis]+1}} / {{volume.dims[axis]}}</small></header>
    <div ref="host" class="canvas-host" @wheel.prevent="!drawing&&slice(point[axis]+($event.deltaY>0?1:-1))">
      <canvas ref="canvas" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end"/>
      <span class="edge top">{{edgeDirection(volume,geometry.b,true)}}</span><span class="edge bottom">{{edgeDirection(volume,geometry.b,false)}}</span><span class="edge left">{{edgeDirection(volume,geometry.a,false)}}</span><span class="edge right">{{edgeDirection(volume,geometry.a,true)}}</span>
    </div>
    <footer><span>切片</span><input :aria-label="`${direction(volume,axis)}切片`" type="range" min="0" :max="volume.dims[axis]-1" :value="point[axis]" @input="slice(+inputValue($event))"/><span>{{point[axis]+1}}</span></footer>
  </section>
</template>
