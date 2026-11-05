<script setup lang="ts">
import type {WorkspaceSummary} from './workspaceRepository.ts';
defineProps<{projects:WorkspaceSummary[];busy:boolean;error:string}>();
const emit=defineEmits<{close:[];refresh:[];restore:[string]}>();
</script>
<template>
  <div class="mw-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="local-project-title" class="mw-modal">
    <header><h2 id="local-project-title">本地工程副本</h2><button aria-label="关闭本地工程列表" @click="emit('close')">×</button></header>
    <p>编辑和浏览位置保存在当前浏览器中，可在刷新后恢复。工程文件仍可单独导出。</p>
    <div v-if="error" role="alert" class="mw-dialog-error">{{error}}</div>
    <div class="mw-local-project-list"><article v-for="project in projects" :key="project.id"><div><strong>{{project.name}}</strong><small>{{project.dims.join(' × ')}} · {{project.maskCount}} Mask · {{project.partCount}} Part</small><small>{{new Date(project.updatedAt).toLocaleString('zh-CN')}}</small></div><button :disabled="busy" @click="emit('restore',project.id)">恢复此工程</button></article><p v-if="!projects.length&&!error">当前浏览器尚无已保存的工程副本。</p></div>
    <footer><button :disabled="busy" @click="emit('refresh')">刷新列表</button><button @click="emit('close')">关闭</button></footer>
  </section></div>
</template>
