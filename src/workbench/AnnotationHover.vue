<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import type {Axis,MprPlane,Vec3,VolumeGrid} from '../../mimics-workbench/src/mimics/types.ts';
import {imageHoverIndex,mprHoverLookup} from './hover.ts';
import type {HoverAnnotation} from './hover.ts';
import {createHoverDwell,HOVER_DWELL_MS} from './hoverDwell.ts';
import type {HoverPointer} from './hoverDwell.ts';
defineOptions({inheritAttrs:false});
const props=withDefaults(defineProps<{
  grid:VolumeGrid;volume:unknown;axis?:Axis;point?:Vec3;plane?:MprPlane;view:unknown;size:readonly number[];revision:number;ready?:boolean;
  locate?:(event:Pick<MouseEvent,'clientX'|'clientY'>)=>Vec3|null;
  pixelAt?:(event:Pick<MouseEvent,'clientX'|'clientY'>)=>[number,number];
  annotationsAt:(index:number)=>HoverAnnotation[];
}>(),{ready:true});
const anchor=ref<HTMLElement>(),index=ref<number|null>(null),position=ref({x:0,y:0});
let canvas:HTMLCanvasElement|null=null;
const lookup=computed(()=>props.plane?mprHoverLookup(props.grid,props.plane):null);
const rows=computed(()=>index.value===null?[]:props.annotationsAt(index.value));
const placement=computed(()=>({left:Math.max(8,Math.min(position.value.x+18,window.innerWidth-368))+'px',top:(position.value.y>window.innerHeight*.65?Math.max(8,position.value.y-16):position.value.y+18)+'px',transform:position.value.y>window.innerHeight*.65?'translateY(-100%)':undefined}));
const dwell=createHoverDwell({show:refresh,hide:()=>{index.value=null;}});
function hide(){dwell.cancel();}
function refresh(pointer:HoverPointer){
  if(!canvas||props.ready===false){index.value=null;return;}
  const r=canvas.getBoundingClientRect();if(pointer.clientX<r.left||pointer.clientX>=r.right||pointer.clientY<r.top||pointer.clientY>=r.bottom){hide();return;}
  if(document.elementFromPoint(pointer.clientX,pointer.clientY)!==canvas){hide();return;}
  position.value={x:pointer.clientX,y:pointer.clientY};
  if(props.plane&&props.pixelAt&&lookup.value)index.value=lookup.value(props.pixelAt(pointer));
  else if(props.locate&&props.point&&props.axis!==undefined)index.value=imageHoverIndex(props.locate(pointer),props.grid.dims,props.axis,props.point[props.axis]);
  else index.value=null;
}
function invalidate(){dwell.invalidate();}
function move(event:PointerEvent){if(event.buttons||event.pointerType==='touch'){hide();return;}dwell.move(event);}
watch([()=>props.grid,()=>props.volume,()=>props.axis,()=>props.point,()=>props.plane,()=>props.view,()=>props.size,()=>props.revision,()=>props.ready],invalidate,{flush:'sync'});
onMounted(()=>{
  canvas=anchor.value?.closest('.image-viewport,.mpr-viewport')?.querySelector('canvas')||null;
  canvas?.addEventListener('pointerenter',move);canvas?.addEventListener('pointermove',move);canvas?.addEventListener('pointerup',move);canvas?.addEventListener('pointerleave',hide);canvas?.addEventListener('pointerdown',hide);canvas?.addEventListener('pointercancel',hide);canvas?.addEventListener('wheel',invalidate,{passive:true});
  window.addEventListener('blur',hide);window.addEventListener('resize',invalidate);
});
onBeforeUnmount(()=>{dwell.dispose();canvas?.removeEventListener('pointerenter',move);canvas?.removeEventListener('pointermove',move);canvas?.removeEventListener('pointerup',move);canvas?.removeEventListener('pointerleave',hide);canvas?.removeEventListener('pointerdown',hide);canvas?.removeEventListener('pointercancel',hide);canvas?.removeEventListener('wheel',invalidate);window.removeEventListener('blur',hide);window.removeEventListener('resize',invalidate);});
</script>
<template>
  <span ref="anchor" hidden data-annotation-hover-anchor :data-hover-index="index" :data-hover-delay="HOVER_DWELL_MS"/>
  <Teleport to="body"><aside v-if="rows.length" class="native-annotation-hover" role="tooltip" aria-label="掩膜详情" :style="placement" :data-mask-count="rows.length">
    <header v-if="rows.length>1">{{rows.length}} 个重叠 Mask</header>
    <section v-for="mask in rows" :key="mask.id" :data-mask-id="mask.id"><strong :title="mask.name"><i :style="{background:mask.color}"/>{{mask.name}}</strong><p><span>作者{{mask.authors.length>1?'（'+mask.authors.length+'）':''}}：</span><template v-if="mask.authors.length"><template v-for="(author,n) in mask.authors" :key="author.id"><span v-if="n">、</span><span :data-author-id="author.id">{{author.name}}</span></template></template><span v-else>未记录</span></p></section>
  </aside></Teleport>
</template>
<style scoped>
.native-annotation-hover{position:fixed;z-index:3500;box-sizing:border-box;width:max-content;max-width:min(350px,calc(100vw - 16px));max-height:65vh;overflow:hidden;pointer-events:none;border:1px solid #9ab8ad;border-radius:8px;background:#fffffff5;color:#214638;box-shadow:0 5px 20px #071d2633;font:12px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}.native-annotation-hover header{padding:6px 12px;background:#e9f4ef;color:#55796b;font-size:11px;border-bottom:1px solid #d2e5dc}.native-annotation-hover section{padding:8px 12px;max-width:325px}.native-annotation-hover section+section{border-top:1px solid #e0ebe5}.native-annotation-hover strong{display:block;overflow-wrap:anywhere}.native-annotation-hover i{display:inline-block;width:10px;height:10px;border:1px solid #244f3544;border-radius:2px;margin-right:7px}.native-annotation-hover p{margin:3px 0 0;color:#416457;overflow-wrap:anywhere}
</style>
