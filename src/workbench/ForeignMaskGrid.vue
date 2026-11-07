<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue';
import type {Axis,MprPlane,Vec3,VolumeGrid} from '../../mimics-workbench/src/mimics/types.ts';
import {createForeignGridPattern,gridViewportLookup,paintForeignGrid} from './foreignGrid.ts';
import type {ForeignGridPattern,ForeignMaskLookup} from './foreignGrid.ts';

defineOptions({inheritAttrs:false});
const props=withDefaults(defineProps<{
  grid:VolumeGrid;volume:unknown;axis?:Axis;point?:Vec3;plane?:MprPlane;view:unknown;
  size:readonly number[];revision:number;ready?:boolean;enabled:boolean;lockedAt:ForeignMaskLookup|null;
}>(),{ready:true});
const anchor=ref<HTMLElement>(),overlay=ref<HTMLCanvasElement>(),target=shallowRef<HTMLElement|null>(null),painted=ref(0),renders=ref(0),renderMs=ref(0);
let frame=0,image:ImageData|null=null,pattern:ForeignGridPattern|null=null;
function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
function draw(){
  frame=0;painted.value=0;
  const canvas=overlay.value;
  if(!canvas||!props.enabled||!props.ready||!props.lockedAt){image=null;if(!props.enabled||!props.lockedAt)pattern=null;return;}
  const [logicalWidth,logicalHeight]=props.size;
  if(!logicalWidth||!logicalHeight||![logicalWidth,logicalHeight].every(value=>Number.isFinite(value)&&value>0))return;
  const started=performance.now();
  // A display-only layer, bounded by the viewport rather than the CT volume.
  const scale=Math.min(1,1536/Math.max(logicalWidth,logicalHeight),Math.sqrt(1500000/(logicalWidth*logicalHeight)));
  const width=Math.max(1,Math.ceil(logicalWidth*scale)),height=Math.max(1,Math.ceil(logicalHeight*scale));
  const context=canvas.getContext('2d');if(!context)return;
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;image=null;}
  image??=context.createImageData(width,height);
  if(!pattern||pattern.width!==width||pattern.height!==height||pattern.logicalWidth!==logicalWidth||pattern.logicalHeight!==logicalHeight){
    pattern=createForeignGridPattern(width,height,logicalWidth,logicalHeight);
  }
  const lookup=gridViewportLookup(props);
  painted.value=paintForeignGrid(image.data,width,height,logicalWidth,logicalHeight,lookup,props.lockedAt,pattern);
  context.putImageData(image,0,0);
  renders.value++;renderMs.value=Math.round((performance.now()-started)*100)/100;
}
// Other coordinates only move the crosshair. They do not change this slice's
// ownership raster; the native image viewport still redraws its crosshair.
watch([overlay,()=>props.enabled,()=>props.lockedAt,()=>props.ready,()=>props.grid,()=>props.volume,()=>props.axis,()=>props.axis===undefined?null:props.point?.[props.axis],()=>props.plane,()=>props.view,()=>props.size,()=>props.revision],schedule,{flush:'post'});
onMounted(()=>{
  const canvas=anchor.value?.closest('.image-viewport,.mpr-viewport')?.querySelector('canvas');
  target.value=canvas?.parentElement||null;schedule();
});
onBeforeUnmount(()=>{if(frame)cancelAnimationFrame(frame);image=null;pattern=null;});
</script>
<template>
  <span ref="anchor" hidden/>
  <Teleport v-if="target&&enabled&&ready&&lockedAt" :to="target">
    <canvas ref="overlay" class="native-foreign-mask-grid" aria-hidden="true" data-testid="foreign-mask-grid" :data-grid-pixels="painted" :data-grid-render-count="renders" :data-grid-render-ms="renderMs"/>
  </Teleport>
</template>
<style scoped>
.native-foreign-mask-grid{position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none!important;z-index:1;image-rendering:pixelated;}
</style>
