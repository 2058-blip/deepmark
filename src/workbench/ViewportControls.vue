<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,shallowRef} from 'vue';
import UiIcon from '../UiIcon.vue';
import {zoomToSlider,sliderToZoom,zoomWheelInput} from './viewportZoom.ts';
import './viewportControls.css';

defineOptions({inheritAttrs:false});
const props=defineProps<{zoom:number;zoomWheel:(event:WheelEvent)=>void}>();
const anchor=ref<HTMLElement>(),expandButton=ref<HTMLButtonElement>();
const section=shallowRef<HTMLElement|null>(null),header=shallowRef<HTMLElement|null>(null),host=shallowRef<HTMLElement|null>(null);
const expanded=ref(false),percentage=computed(()=>Math.round(props.zoom*100));
let nativeFit:HTMLButtonElement|null=null,canvas:HTMLCanvasElement|null=null,workspace:HTMLElement|null=null;
function changeZoom(target:number){
  if(!canvas)return;
  const input=zoomWheelInput(props.zoom,target,canvas.getBoundingClientRect());
  if(input)props.zoomWheel(new WheelEvent('wheel',input));
}
function fit(){nativeFit?.click();}
function cancelGesture(){
  if(!canvas)return;
  const rect=canvas.getBoundingClientRect();
  props.zoomWheel(new WheelEvent('wheel',{ctrlKey:true,deltaY:0,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
}
function controlWheel(event:WheelEvent){if(event.ctrlKey||event.shiftKey)props.zoomWheel(event);}
function restore(){
  expanded.value=false;section.value?.classList.remove('native-maximized-viewport');
  workspace?.classList.remove('native-view-expanded');
  workspace?.style.removeProperty('--native-objects-width');workspace?.style.removeProperty('--native-expanded-top');
}
function toggleExpand(){
  cancelGesture();
  if(expanded.value){restore();return;}
  if(!section.value||!workspace)return;
  const objects=workspace.querySelector<HTMLElement>('.mw-objects'),banner=workspace.querySelector<HTMLElement>('.native-history-return');
  workspace.style.setProperty('--native-objects-width',(objects?.getBoundingClientRect().width||0)+'px');
  workspace.style.setProperty('--native-expanded-top',(banner?.getBoundingClientRect().height||0)+'px');
  workspace.classList.add('native-view-expanded');section.value.classList.add('native-maximized-viewport');expanded.value=true;
}
function escape(event:KeyboardEvent){if(expanded.value&&event.key==='Escape'){event.preventDefault();cancelGesture();restore();expandButton.value?.focus();}}
onMounted(()=>{
  section.value=anchor.value?.closest<HTMLElement>('.image-viewport,.mpr-viewport')||null;
  header.value=section.value?.querySelector<HTMLElement>(':scope > header')||null;
  canvas=section.value?.querySelector<HTMLCanvasElement>('canvas')||null;host.value=canvas?.parentElement||null;
  nativeFit=header.value?.querySelector<HTMLButtonElement>(':scope > button')||null;
  workspace=section.value?.closest<HTMLElement>('.collaborative-native-workbench')||null;
  section.value?.classList.add('native-viewport-enhanced');window.addEventListener('keydown',escape,true);
});
onBeforeUnmount(()=>{if(expanded.value)restore();section.value?.classList.remove('native-viewport-enhanced');window.removeEventListener('keydown',escape,true);});
</script>
<template>
  <span ref="anchor" hidden/>
  <Teleport v-if="header" :to="header">
    <div class="native-viewport-actions">
      <button aria-label="适配并居中" title="适配并居中（重置缩放和平移）" @click="fit"><UiIcon name="fit" :size="16"/></button>
      <button ref="expandButton" :aria-label="expanded?'退出单视图全屏':'单视图全屏'" :aria-pressed="expanded" :title="expanded?'退出单视图全屏（Esc）':'单视图全屏'" @click="toggleExpand"><UiIcon :name="expanded?'restore':'maximize'" :size="16"/></button>
    </div>
  </Teleport>
  <Teleport v-if="host&&expanded" :to="host">
    <div class="native-viewport-zoom" aria-label="影像缩放" :data-zoom-percent="percentage" @pointerdown.stop @dblclick.stop @wheel.stop.prevent="controlWheel">
      <button aria-label="放大影像" title="放大影像" :disabled="zoom>=12" @click="changeZoom(zoom*1.2)"><UiIcon name="zoom-in" :size="17"/></button>
      <input type="range" aria-label="缩放倍率" :aria-valuetext="percentage+'%'" min="0" max="1000" step="1" :value="zoomToSlider(zoom)" @input="changeZoom(sliderToZoom(Number(($event.target as HTMLInputElement).value)))"/>
      <output aria-live="off">{{percentage}}%</output>
    </div>
  </Teleport>
</template>
