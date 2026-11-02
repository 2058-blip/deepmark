<script setup lang="ts">
import {onMounted,ref} from 'vue';
import UiIcon from './UiIcon.vue';
import type {DraftIndex} from './collaborationTypes.ts';
import './datasets.css';
defineProps<{drafts:DraftIndex[];restore:(key:string)=>Promise<void>}>();
const emit=defineEmits<{close:[]}>(),dialog=ref<HTMLDialogElement|null>(null),busy=ref(false),error=ref('');
onMounted(()=>dialog.value!.showModal());
async function open(key:string,restore:(key:string)=>Promise<void>){busy.value=true;error.value='';try{await restore(key);emit('close');}catch(reason){error.value=(reason as Error).message;}finally{busy.value=false;}}
</script>
<template>
  <dialog ref="dialog" class="dataset-dialog local-drafts-dialog" aria-labelledby="local-drafts-title" @cancel.prevent="!busy&&emit('close')">
    <header class="datasets-header"><div><span class="eyebrow">当前浏览器</span><h2 id="local-drafts-title">本地工作缓存</h2></div><button class="dialog-close" aria-label="关闭本地缓存窗口" :disabled="busy" @click="emit('close')"><UiIcon name="close" :size="18"/></button></header>
    <p class="datasets-description">原始影像、完整标注、继续位置和待上传操作均保存在当前浏览器。恢复后可继续编辑，联网后续传。</p>
    <p v-if="error" class="datasets-error" role="alert">{{error}}</p>
    <div class="datasets-list"><article v-for="draft in drafts" :key="draft.key" class="dataset-card"><div class="dataset-file-icon"><UiIcon name="cache" :size="23"/></div><div class="dataset-details"><h3>{{draft.name}}</h3><p>作者：{{draft.author.name}} · {{draft.needsCheckpoint?'有待同步操作':'本地缓存完整'}}</p><small>本地更新于 {{new Date(draft.updated).toLocaleString('zh-CN')}}</small></div><div class="dataset-actions"><button class="primary" :disabled="busy" @click="open(draft.key,restore)">{{busy?'正在恢复…':'恢复工作'}}</button></div></article><div v-if="!drafts.length" class="datasets-empty">暂无本地工作缓存。加入协同后会自动建立。</div></div>
  </dialog>
</template>
