<script setup lang="ts">
import {onMounted,reactive,ref,watch} from 'vue';
import type {ResliceProperties,ReslicePropertiesDraft} from './useResliceObjects.ts';
const props=defineProps<{draft:ReslicePropertiesDraft;busy?:boolean}>();
const emit=defineEmits<{apply:[properties:ResliceProperties];cancel:[]}>();
const dialog=ref<HTMLElement>(),error=ref(''),form=reactive<ResliceProperties>({name:'',center:[0,0,0],angles:[0,0,0],widthMm:1,heightMm:1});
watch(()=>props.draft,draft=>{Object.assign(form,{name:draft.name,center:[...draft.center],angles:[...draft.angles],widthMm:draft.widthMm,heightMm:draft.heightMm});error.value='';},{immediate:true});
function apply(){
  if(props.busy)return;error.value='';
  if(!form.name.trim()||form.name.length>512){error.value='请输入1至512个字符的名称。';return;}
  if([...form.center,...form.angles].some(n=>typeof n!=='number'||!Number.isFinite(n))||![form.widthMm,form.heightMm].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)){error.value='中心和旋转角须为有限数，物理宽高须为有限正毫米数。';return;}
  emit('apply',{name:form.name.trim(),center:[...form.center],angles:[...form.angles],widthMm:form.widthMm,heightMm:form.heightMm});
}
function cancel(){if(!props.busy)emit('cancel');}
function key(event:KeyboardEvent){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();return;}
  if(event.key!=='Tab'||!dialog.value)return;const controls=[...dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])')].filter(element=>element.getClientRects().length),first=controls[0],last=controls.at(-1);if(!first||!last)return;
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.value)){event.preventDefault();first.focus();}
}
onMounted(()=>dialog.value?.focus());
</script>
<template>
  <div class="reslice-backdrop"><section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="reslice-properties-title" tabindex="-1" class="reslice-properties" @keydown="key">
    <header><h2 id="reslice-properties-title">Reslice Plane Properties · 重切片平面属性</h2><button type="button" aria-label="取消重切片属性编辑" :disabled="busy" @click="cancel">×</button></header>
    <div class="reslice-body">
      <label>Name · 名称<input v-model="form.name" type="text" maxlength="512" :disabled="busy"></label>
      <fieldset><legend>World center · 世界中心 (mm)</legend><div class="triple"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis">{{axis}}<input v-model.number="form.center[index]" :aria-label="`中心 ${axis} (mm)`" type="number" step="any" :disabled="busy"></label></div></fieldset>
      <fieldset><legend>World rotation · 世界旋转 (°)</legend><div class="triple"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis">{{axis}}<input v-model.number="form.angles[index]" :aria-label="`绕世界 ${axis} 旋转 (°)`" type="number" step="any" :disabled="busy"></label></div><small>依次绕固定的世界 X、Y、Z 轴旋转。</small></fieldset>
      <div class="pair"><label>Physical width · 物理宽度 (mm)<input v-model.number="form.widthMm" type="number" step="any" :disabled="busy"></label><label>Physical height · 物理高度 (mm)<input v-model.number="form.heightMm" type="number" step="any" :disabled="busy"></label></div>
      <p class="sampling">Output sampling · 输出采样：{{draft.size[0]}} × {{draft.size[1]}} pixels（只读）<small>物理宽高表示完整像素范围；调整毫米范围会改变像素间距，采样点数保持不变。</small></p>
      <p v-if="error" class="error" role="alert">{{error}}</p>
    </div><footer><button type="button" :disabled="busy" @click="apply">Apply · 应用</button><button type="button" :disabled="busy" @click="cancel">Cancel · 取消</button></footer>
  </section></div>
</template>
<style scoped>
.reslice-backdrop{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;padding:22px;background:#0610208c}.reslice-properties{width:520px;max-width:100%;max-height:90vh;overflow:auto;border:1px solid #7891aa;border-radius:5px;background:#eff1f4;color:#172a3b;box-shadow:0 16px 50px #0008;font:12px 'Segoe UI','Microsoft YaHei',sans-serif;outline:none}.reslice-properties header{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 6px 12px;background:linear-gradient(#dae7f5,#b7cde4);border-bottom:1px solid #98afc4}.reslice-properties h2{font-size:13px;font-weight:500;margin:0}.reslice-properties button{font:inherit;min-width:80px;padding:5px 14px;color:#193348;background:linear-gradient(#fff,#dfe5ed);border:1px solid #98aaba;border-radius:3px;cursor:pointer}.reslice-properties header button{min-width:28px;padding:0 6px;font-size:18px}.reslice-body{display:flex;flex-direction:column;gap:13px;padding:14px}.reslice-properties label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#304b63}.reslice-properties input{box-sizing:border-box;min-width:0;width:100%;padding:5px;border:1px solid #9eacba;border-radius:2px;background:#fff;color:#162c40;font:12px 'Segoe UI','Microsoft YaHei',sans-serif}.reslice-properties fieldset{margin:0;padding:10px;border:1px solid #b2c0cc;border-radius:3px}.reslice-properties legend{padding:0 5px;color:#304b63;font-size:11px}.triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.reslice-properties small{display:block;margin-top:7px;color:#5c7286;font-size:10px;line-height:1.7}.reslice-properties p{margin:0}.sampling{padding:9px;background:#e4eaf0;border:1px solid #c2cdd6;border-radius:2px;font-size:11px}.error{padding:7px;background:#ffede9;border:1px solid #d9a79e;color:#9c3027;font-size:11px}.reslice-properties footer{display:flex;justify-content:flex-end;gap:9px;border-top:1px solid #b1bfcb;padding:10px 14px}.reslice-properties :disabled{opacity:.55;cursor:default}.reslice-properties input:focus-visible,.reslice-properties button:focus-visible{outline:2px solid #3e8ec5;outline-offset:1px}
</style>
