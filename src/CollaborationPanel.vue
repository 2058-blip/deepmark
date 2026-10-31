<script setup lang="ts">
import {ref,watchPostEffect} from 'vue';
import type {useCollaboration} from './useCollaboration.ts';
import type {ParallelAnnotation} from './collaborationTypes.ts';
import './collaboration.css';
const props=defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>}>();
const {nickname,person,project,history,historical,syncText,error,cacheError,connected,joining,queueCount,showHistory,active,join,viewHistory,exiting,exitBlocked,exitNotice,saveAndExit,forceLocalExit,exportLocal,focusRegion,highlightAnnotation,offlineSource}=props.collaboration;
const exitDialog=ref<HTMLDialogElement|null>(null);
watchPostEffect(()=>{const dialog=exitDialog.value;if(!dialog)return;if((exiting.value||exitBlocked.value)&&!dialog.open)dialog.showModal();else if(!exiting.value&&!exitBlocked.value&&dialog.open)dialog.close();});
function labelSummary(row:ParallelAnnotation){const ids=[...new Set(row.values.map(([,v])=>v))];return ids.map(id=>id===0?'背景 / 擦除':project.value?.labels.find(l=>l.id===id)?.name||`标签 ${id}`).join('、');}
</script>
<template>
  <section v-if="datasetId" class="collaboration-panel" :data-online="connected" :data-pending="queueCount" :data-error="!!(error||cacheError)" :aria-busy="joining||exiting">
    <header><strong>多人协同</strong><span>{{active?`统一成果 · 修订 ${project!.revision}`:'进入时获取服务器完整成果'}}</span></header>
    <template v-if="!active"><div class="collaboration-join"><input v-model="nickname" aria-label="协同昵称" maxlength="40" placeholder="输入你的协同昵称"/><button class="primary" :disabled="joining||!nickname.trim()" @click="join(datasetId!)">{{joining?'正在获取共享成果…':'加入实时协同'}}</button></div><p>所有工程师共同编辑一份完整成果，分工由团队协调。</p></template>
    <template v-else>
      <div class="collaboration-controls"><span v-if="queueCount||error||!connected" class="sync-indicator" role="status">{{syncText}}</span><span>{{person?.name}}</span><button @click="showHistory=!showHistory">{{showHistory?'收起记录':'操作记录'}}</button><button @click="exportLocal">导出本地副本</button><button :disabled="exiting" @click="saveAndExit">同步并退出</button>
      </div>
      <p v-if="offlineSource" class="collaboration-error">当前显示本地缓存，联网后会获取共享完整成果并提交待上传操作。</p>
      <p v-if="project!.status==='finalized'" class="final-status">已由 {{project!.finalizedBy}} 定稿。当前仅可查看和导出。</p>
      <p v-else>共同编辑一份成果，不同意见在对应区域并列保留。点击条目可定位查看。</p>
      <div v-if="project!.regions.length" class="parallel-regions"><header><strong>并列标注 · {{project!.regions.length}} 处区域</strong><button v-if="highlightAnnotation" @click="highlightAnnotation=null">显示全部意见</button></header>
        <article v-for="(region,index) in project!.regions" :key="region.id" class="parallel-region"><div class="region-heading"><button @click="focusRegion(region)">定位区域 {{index+1}}</button><span>{{region.indices.length.toLocaleString()}} 个体素</span></div>
          <div v-for="annotation in region.annotations" :key="annotation.id" :class="['parallel-annotation',{highlighted:highlightAnnotation===annotation.id}]"><button class="parallel-choice" @click="focusRegion(region,annotation.id)"><strong>{{annotation.name}}</strong><span>{{labelSummary(annotation)}} · {{annotation.values.length}} 个体素</span></button></div>
        </article>
      </div>
      <div v-if="historical!==null" class="history-banner">查看修订 {{historical}}（只读）<button @click="viewHistory(null)">返回实时编辑</button></div>
      <div v-if="showHistory" class="collaboration-history"><button :disabled="!!queueCount" @click="viewHistory(0)">查看初始记录</button><div v-for="event in history" :key="event.revision"><span>#{{event.revision}} · {{event.name}} · {{event.kind}} · {{new Date(event.time).toLocaleString('zh-CN')}}</span><button :disabled="!!queueCount" @click="viewHistory(event.revision)">查看此记录</button></div><p v-if="!history.length">尚无操作记录。</p></div>
    </template>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p><p v-if="cacheError" class="collaboration-error" role="alert">{{cacheError}}</p><p v-if="exitNotice" role="status">{{exitNotice}}</p>
    <dialog ref="exitDialog" class="dataset-dialog exit-dialog" aria-labelledby="exit-title" @cancel.prevent="!exiting&&(exitBlocked=false)"><h2 id="exit-title">{{exiting?'正在同步操作':'操作尚未全部上传'}}</h2><p v-if="exiting">正在缓存本地副本并提交剩余操作，请稍候…</p><template v-else><p>可以等待网络恢复，也可保留本地副本与待上传操作后暂时退出。</p><p class="collaboration-error">{{error}}</p><div class="exit-actions"><button @click="exitBlocked=false">继续工作</button><button @click="saveAndExit">重试同步并退出</button><button class="primary" :disabled="!!cacheError" @click="forceLocalExit">保留本地缓存并退出</button></div></template></dialog>
  </section>
</template>
