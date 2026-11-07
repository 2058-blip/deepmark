<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref} from 'vue';
import UiIcon from '../UiIcon.vue';
defineProps<{showForeignGrid:boolean}>();
const emit=defineEmits<{'update:showForeignGrid':[value:boolean]}>();
const open=ref(false),root=ref<HTMLElement>(),trigger=ref<HTMLButtonElement>();
function outside(event:PointerEvent){if(event.target instanceof Node&&!root.value?.contains(event.target))open.value=false;}
function close(){open.value=false;trigger.value?.focus();}
onMounted(()=>window.addEventListener('pointerdown',outside));
onBeforeUnmount(()=>window.removeEventListener('pointerdown',outside));
</script>
<template>
  <div ref="root" class="native-display-settings" @keydown.esc.stop="close">
    <button ref="trigger" :aria-expanded="open" aria-controls="workbench-display-settings" @click="open=!open"><UiIcon name="settings" :size="17"/>设置</button>
    <section v-if="open" id="workbench-display-settings" class="native-settings-panel" aria-label="显示设置">
      <header><strong>显示设置</strong><button aria-label="关闭设置" @click="close"><UiIcon name="close" :size="16"/></button></header>
      <label><input type="checkbox" :checked="showForeignGrid" @change="emit('update:showForeignGrid',($event.target as HTMLInputElement).checked)"/><span>显示他人标注网格</span></label>
      <p><i class="native-grid-key"/>网格区域包含其他作者的标注，无法修改。</p>
      <small>关闭仅隐藏网格，不改变编辑权限。此设置在当前浏览器中按账号保存。</small>
    </section>
  </div>
</template>
<style scoped>
.native-display-settings{position:relative;flex-shrink:0;}
.native-settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:2200;box-sizing:border-box;width:min(320px,calc(100vw - 32px));padding:14px 16px;border:1px solid var(--border-strong);border-radius:8px;background:var(--panel);color:var(--text-2);box-shadow:var(--shadow-lg);font:13px/1.6 var(--font-sans);}
.native-settings-panel header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.native-settings-panel header strong{font-weight:600;color:var(--text);}
.native-settings-panel header button{width:26px!important;height:26px!important;padding:0!important;justify-content:center;}
.native-settings-panel label{display:flex;align-items:center;gap:8px;cursor:pointer;}
.native-settings-panel input{margin:0;accent-color:var(--primary);}
.native-settings-panel p{display:flex;align-items:flex-start;gap:8px;margin:12px 0 8px;font-size:12px;}
.native-grid-key{display:inline-block;flex:0 0 18px;height:18px;margin-top:1px;background-color:#86b8a7;background-image:repeating-linear-gradient(45deg,#ffffff40 0 .7px,transparent .7px 6.36px),repeating-linear-gradient(-45deg,#ffffff40 0 .7px,transparent .7px 6.36px);background-blend-mode:lighten;border:1px solid #739d90;border-radius:2px;}
.native-settings-panel small{display:block;color:var(--muted);font-size:11px;line-height:1.6;}
</style>
