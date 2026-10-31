<script setup lang="ts">
import type {useCollaboration} from './useCollaboration.ts';
import {ref,watchPostEffect} from 'vue';
import './collaboration.css';
const props=defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>}>();
const {nickname,person,project,branch,history,historical,syncText,error,cacheError,connected,joining,queueCount,showHistory,active,join,chooseBranch,viewHistory,workspace,lastCached,exiting,exitBlocked,exitNotice,saveAndExit,forceLocalExit,exportPersonal,exportLocal}=props.collaboration;
const exitDialog=ref<HTMLDialogElement|null>(null),showPersonal=ref(false);
watchPostEffect(()=>{const dialog=exitDialog.value;if(!dialog)return;if((exiting.value||exitBlocked.value)&&!dialog.open)dialog.showModal();else if(!exiting.value&&!exitBlocked.value&&dialog.open)dialog.close();});
function value(event:Event){return (event.target as HTMLSelectElement).value;}
</script>
<template>
  <section v-if="datasetId" class="collaboration-panel" :data-online="connected" :data-pending="queueCount" :data-error="!!(error||cacheError)" :aria-busy="joining||exiting">
    <header><strong>多人协同</strong><span>{{active?`版本 ${project!.revision}`:'共同编辑同一影像'}}</span></header>
    <template v-if="!active"><div class="collaboration-join"><input v-model="nickname" aria-label="协同昵称" maxlength="40" placeholder="输入你的协同昵称"/><button class="primary" :disabled="joining||!nickname.trim()" @click="join(datasetId!)">{{joining?'正在加入…':'加入实时协同'}}</button></div><p>所有成员权限相同；分工由团队内部协调。</p></template>
    <template v-else>
      <div class="collaboration-controls"><span v-if="queueCount||error||!connected" class="sync-indicator" role="status">{{syncText}}</span><span>{{person?.name}}</span><label>查看版本<select aria-label="协同版本" :value="branch" :disabled="!!queueCount||exiting" @change="chooseBranch(value($event))"><option v-for="b in project!.branches" :key="b.id" :value="b.id">{{b.name}}</option></select></label><button @click="showHistory=!showHistory">{{showHistory?'收起历史':'工作记录'}}</button><button @click="showPersonal=!showPersonal">个人空间</button><button :disabled="exiting" @click="saveAndExit">保存并退出</button></div>
      <p>冲突保留各版；后续绘制同步所有版本，仅改变重新绘制的体素。</p>
      <div v-if="showPersonal" class="personal-space"><p>本地完整缓存：{{lastCached?new Date(lastCached).toLocaleString('zh-CN'):'正在建立'}}。服务器为当前作者独立保存操作成果与个人工作副本。</p><p>个人副本在保存退出时统一归档。</p><button :disabled="!!queueCount||!!error" @click="exportPersonal">下载个人成果</button><button @click="exportLocal">导出本地完整副本</button></div>
      <div v-if="historical!==null" class="history-banner">正在查看历史版本 {{historical}}（只读）<button @click="viewHistory(null)">返回实时编辑</button></div>
      <div v-if="showHistory" class="collaboration-history"><button :disabled="!!queueCount" @click="viewHistory(0)">查看初始版本</button><div v-for="event in history" :key="event.revision"><span>#{{event.revision}} · {{event.name}} · {{event.kind}} · {{new Date(event.time).toLocaleString('zh-CN')}}</span><button :disabled="!!queueCount" @click="viewHistory(event.revision)">查看此版</button></div><p v-if="!history.length">尚无工作记录，开始绘制后会自动保存。</p></div>
    </template>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p>
    <p v-if="cacheError" class="collaboration-error" role="alert">{{cacheError}}</p>
    <p v-if="exitNotice" role="status">{{exitNotice}}</p>
    <dialog ref="exitDialog" class="dataset-dialog exit-dialog" aria-labelledby="exit-title" @cancel.prevent="!exiting&&(exitBlocked=false)"><h2 id="exit-title">{{exiting?'正在整理个人成果':'个人成果尚未全部上传'}}</h2><p v-if="exiting">正在保留本地副本、提交剩余操作并归档个人空间，请稍候…</p><template v-else><p>工作副本和待上传操作会保留在本地。可以恢复网络后继续等待，或暂时退出，下次从本地缓存恢复后续传。</p><p class="collaboration-error">{{error}}</p><div class="exit-actions"><button @click="exitBlocked=false">继续工作</button><button @click="saveAndExit">重试上传并退出</button><button class="primary" :disabled="!!cacheError" @click="forceLocalExit">保留本地缓存并退出</button></div></template></dialog>
  </section>
</template>
