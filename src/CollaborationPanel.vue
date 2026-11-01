<script setup lang="ts">
import {ref,watchPostEffect} from 'vue';
import type {useCollaboration} from './useCollaboration.ts';
import type {ParallelAnnotation} from './collaborationTypes.ts';
import './collaboration.css';
const props=defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>}>();
defineEmits<{reload:[]}>();
const {person,project,history,historical,syncText,error,cacheError,connected,joining,initializing,queueCount,active,canWrite,viewHistory,exiting,exitBlocked,exitNotice,retryFinish,forceLocalExit,exportLocal,focusRegion,highlightAnnotation,offlineSource}=props.collaboration;
const exitDialog=ref<HTMLDialogElement|null>(null);
watchPostEffect(()=>{const dialog=exitDialog.value;if(!dialog)return;if((exiting.value||exitBlocked.value)&&!dialog.open)dialog.showModal();else if(!exiting.value&&!exitBlocked.value&&dialog.open)dialog.close();});
function labelSummary(row:ParallelAnnotation){const ids=[...new Set(row.values.map(([,v])=>v))];return ids.map(id=>id===0?'背景 / 擦除':project.value?.labels.find(l=>l.id===id)?.name||`标签 ${id}`).join('、');}
</script>
<template>
  <section class="collaboration-panel" :data-author="person?.id" :data-online="connected" :data-pending="queueCount" :data-error="!!(error||cacheError)" :aria-busy="initializing||joining||exiting">
    <header><strong>{{person?.role==='dispatcher'?'实时只读监看':'任务协同'}}</strong><span>{{canWrite?'当前小组成员可共同标注':'当前账号仅可查看成果'}}</span></header>
    <div v-if="person" class="collaboration-controls"><strong>{{person.name}}</strong><span>{{active?(connected?'实时连接已建立':'正在连接实时服务'):'正在加载任务'}}</span></div>
    <p v-if="datasetId&&!active">{{joining?'正在加载任务已有标注…':'任务标注尚未加载完成，暂不能编辑。'}} <button v-if="!joining" @click="$emit('reload')">重新加载任务标注</button></p>
    <template v-if="active">
      <div class="collaboration-controls"><span v-if="queueCount||error||!connected" class="sync-indicator" role="status">{{syncText}}</span><button v-if="person?.role==='worker'||project?.datasetStatus==='completed'" @click="exportLocal">导出本地副本</button>
      </div>
      <p v-if="offlineSource" class="collaboration-error">当前显示本地缓存，联网后会获取共享完整成果并提交待上传操作。</p>
      <p v-if="project!.status==='finalized'" class="final-status">已由 {{project!.finalizedBy}} 定稿。当前仅可查看和导出。</p>
      <p v-else-if="canWrite">同一区域可提交自己的标注，其他作者的意见会保留。只能删除自己的标注。</p>
      <p v-else>此视图会随团队操作更新。切片、缩放、窗宽窗位及标注来源查询可正常使用。</p>
      <div v-if="project!.regions.length" class="parallel-regions"><header><strong>并列标注 · {{project!.regions.length}} 处区域</strong><button v-if="highlightAnnotation" @click="highlightAnnotation=null">显示全部意见</button></header>
        <article v-for="(region,index) in project!.regions" :key="region.id" class="parallel-region"><div class="region-heading"><button @click="focusRegion(region)">定位区域 {{index+1}}</button><span>{{region.indices.length.toLocaleString()}} 个体素</span></div>
          <div v-for="annotation in region.annotations" :key="annotation.id" :class="['parallel-annotation',{highlighted:highlightAnnotation===annotation.id}]"><button class="parallel-choice" @click="focusRegion(region,annotation.id)"><strong>{{annotation.name}}</strong><span>{{labelSummary(annotation)}} · {{annotation.values.length}} 个体素</span></button></div>
        </article>
      </div>
      <div v-if="historical!==null" class="history-banner">当前为只读视图<button @click="viewHistory(null)">返回实时编辑</button></div>
      <details v-if="history.length" class="collaboration-history"><summary>操作记录 · {{history.length}} 条</summary><ol><li v-for="entry in history" :key="entry.revision"><button :disabled="!!queueCount||exiting" @click="viewHistory(entry.revision)">修订 {{entry.revision}} · {{entry.name}} · {{entry.kind}}</button><time>{{new Date(entry.time).toLocaleString()}}</time></li></ol></details>
    </template>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p><p v-if="cacheError" class="collaboration-error" role="alert">{{cacheError}}</p><p v-if="exitNotice" role="status">{{exitNotice}}</p>
    <dialog ref="exitDialog" class="dataset-dialog exit-dialog" aria-labelledby="exit-title" @cancel.prevent="!exiting&&(exitBlocked=false)"><h2 id="exit-title">{{exiting?'正在同步操作':'操作尚未全部上传'}}</h2><p v-if="exiting">正在缓存本地副本并提交剩余操作，请稍候…</p><template v-else><p>可以等待网络恢复，也可保留本地副本与待上传操作后暂时退出。</p><p class="collaboration-error">{{error}}</p><div class="exit-actions"><button @click="exitBlocked=false">继续工作</button><button @click="retryFinish">重试同步并退出</button><button class="primary" :disabled="!!cacheError" @click="forceLocalExit">保留本地缓存并退出</button></div></template></dialog>
  </section>
</template>
