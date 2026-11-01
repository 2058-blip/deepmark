<script setup lang="ts">
import {ref,watchPostEffect} from 'vue';
import type {useCollaboration} from './useCollaboration.ts';
import type {ParallelAnnotation} from './collaborationTypes.ts';
import './collaboration.css';
const props=defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>}>();
defineEmits<{login:[];reload:[]}>();
const {nickname,person,project,history,historical,syncText,error,cacheError,connected,joining,initializing,queueCount,showHistory,active,viewHistory,exiting,exitBlocked,exitNotice,saveAndExit,retryFinish,forceLocalExit,exportLocal,focusRegion,highlightAnnotation,offlineSource}=props.collaboration;
const exitDialog=ref<HTMLDialogElement|null>(null);
watchPostEffect(()=>{const dialog=exitDialog.value;if(!dialog)return;if((exiting.value||exitBlocked.value)&&!dialog.open)dialog.showModal();else if(!exiting.value&&!exitBlocked.value&&dialog.open)dialog.close();});
function labelSummary(row:ParallelAnnotation){const ids=[...new Set(row.values.map(([,v])=>v))];return ids.map(id=>id===0?'背景 / 擦除':project.value?.labels.find(l=>l.id===id)?.name||`标签 ${id}`).join('、');}
</script>
<template>
  <section class="collaboration-panel" :data-author="person?.id" :data-online="connected" :data-pending="queueCount" :data-error="!!(error||cacheError)" :aria-busy="initializing||joining||exiting">
    <header><strong>团队协同</strong><span>{{person?'当前服务器的所有数据集均由团队共享':'登录一次，即可协同所有服务器数据集'}}</span></header>
    <template v-if="!person"><div class="collaboration-join"><input v-model="nickname" aria-label="团队昵称" maxlength="40" placeholder="输入你的团队昵称" @keydown.enter="!initializing&&!joining&&nickname.trim()&&$emit('login')"/><button class="primary" :disabled="initializing||joining||!nickname.trim()" @click="$emit('login')">{{initializing?'正在恢复登录…':joining?'正在登录…':'登录团队'}}</button></div><p>{{datasetId?'登录后自动获取这份数据集的团队已有标注，加载完成后即可编辑。':'团队成员权限相同。服务器数据集自动同步，本地打开的影像仍可独立标注。'}}</p></template>
    <template v-else><div class="collaboration-controls"><strong>{{person.name}}</strong><span>{{active?`统一成果 · 修订 ${project!.revision}`:'已登录团队'}}</span><button :disabled="exiting||joining" @click="saveAndExit">退出团队</button></div><p v-if="!datasetId">打开任意服务器数据集，将自动加载团队最新成果并实时同步。</p><p v-else-if="!active">{{joining?'正在加载团队已有标注…':'团队标注尚未加载完成，暂不能编辑。'}} <button v-if="!joining" @click="$emit('reload')">重新加载团队标注</button></p></template>
    <template v-if="active">
      <div class="collaboration-controls"><span v-if="queueCount||error||!connected" class="sync-indicator" role="status">{{syncText}}</span><button @click="showHistory=!showHistory">{{showHistory?'收起记录':'操作记录'}}</button><button @click="exportLocal">导出本地副本</button>
      </div>
      <p v-if="offlineSource" class="collaboration-error">当前显示本地缓存，联网后会获取共享完整成果并提交待上传操作。</p>
      <p v-if="project!.status==='finalized'" class="final-status">已由 {{project!.finalizedBy}} 定稿。当前仅可查看和导出。</p>
      <p v-else>同一区域可提交自己的标注，其他作者的意见会保留。只能删除自己的标注。</p>
      <div v-if="project!.regions.length" class="parallel-regions"><header><strong>并列标注 · {{project!.regions.length}} 处区域</strong><button v-if="highlightAnnotation" @click="highlightAnnotation=null">显示全部意见</button></header>
        <article v-for="(region,index) in project!.regions" :key="region.id" class="parallel-region"><div class="region-heading"><button @click="focusRegion(region)">定位区域 {{index+1}}</button><span>{{region.indices.length.toLocaleString()}} 个体素</span></div>
          <div v-for="annotation in region.annotations" :key="annotation.id" :class="['parallel-annotation',{highlighted:highlightAnnotation===annotation.id}]"><button class="parallel-choice" @click="focusRegion(region,annotation.id)"><strong>{{annotation.name}}</strong><span>{{labelSummary(annotation)}} · {{annotation.values.length}} 个体素</span></button></div>
        </article>
      </div>
      <div v-if="historical!==null" class="history-banner">查看修订 {{historical}}（只读）<button @click="viewHistory(null)">返回实时编辑</button></div>
      <div v-if="showHistory" class="collaboration-history"><button :disabled="!!queueCount" @click="viewHistory(0)">查看初始记录</button><div v-for="event in history" :key="event.revision"><span>#{{event.revision}} · {{event.name}} · {{event.kind}} · {{new Date(event.time).toLocaleString('zh-CN')}}</span><button :disabled="!!queueCount" @click="viewHistory(event.revision)">查看此记录</button></div><p v-if="!history.length">尚无操作记录。</p></div>
    </template>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p><p v-if="cacheError" class="collaboration-error" role="alert">{{cacheError}}</p><p v-if="exitNotice" role="status">{{exitNotice}}</p>
    <dialog ref="exitDialog" class="dataset-dialog exit-dialog" aria-labelledby="exit-title" @cancel.prevent="!exiting&&(exitBlocked=false)"><h2 id="exit-title">{{exiting?'正在同步操作':'操作尚未全部上传'}}</h2><p v-if="exiting">正在缓存本地副本并提交剩余操作，请稍候…</p><template v-else><p>可以等待网络恢复，也可保留本地副本与待上传操作后暂时退出。</p><p class="collaboration-error">{{error}}</p><div class="exit-actions"><button @click="exitBlocked=false">继续工作</button><button @click="retryFinish">重试同步并退出</button><button class="primary" :disabled="!!cacheError" @click="forceLocalExit">保留本地缓存并退出</button></div></template></dialog>
  </section>
</template>
