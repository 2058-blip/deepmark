<script setup lang="ts">
import type {useCollaboration} from './useCollaboration.ts';
import './collaboration.css';
const props=defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>}>();
const {nickname,person,project,branch,history,historical,syncText,error,connected,joining,queueCount,showHistory,active,join,leave,chooseBranch,viewHistory}=props.collaboration;
function value(event:Event){return (event.target as HTMLSelectElement).value;}
</script>
<template>
  <section v-if="datasetId" class="collaboration-panel">
    <header><strong>多人协同</strong><span>{{active?`版本 ${project!.revision}`:'共同编辑同一影像'}}</span></header>
    <template v-if="!active"><div class="collaboration-join"><input v-model="nickname" aria-label="协同昵称" maxlength="40" placeholder="输入你的协同昵称"/><button class="primary" :disabled="joining||!nickname.trim()" @click="join(datasetId!)">{{joining?'正在加入…':'加入实时协同'}}</button></div><p>所有成员权限相同；分工由团队内部协调。</p></template>
    <template v-else>
      <div class="collaboration-controls"><span :class="['sync-indicator',{online:connected&&!queueCount&&!error}]">● {{syncText}}</span><span>{{person?.name}}</span><label>查看版本<select aria-label="协同版本" :value="branch" :disabled="!!queueCount" @change="chooseBranch(value($event))"><option v-for="b in project!.branches" :key="b.id" :value="b.id">{{b.name}}</option></select></label><button @click="showHistory=!showHistory">{{showHistory?'收起历史':'工作记录'}}</button><button :disabled="!!queueCount" @click="leave">退出协同</button></div>
      <p>冲突保留各版；后续绘制同步所有版本，仅改变重新绘制的体素。</p>
      <div v-if="historical!==null" class="history-banner">正在查看历史版本 {{historical}}（只读）<button @click="viewHistory(null)">返回实时编辑</button></div>
      <div v-if="showHistory" class="collaboration-history"><button :disabled="!!queueCount" @click="viewHistory(0)">查看初始版本</button><div v-for="event in history" :key="event.revision"><span>#{{event.revision}} · {{event.name}} · {{event.kind}} · {{new Date(event.time).toLocaleString('zh-CN')}}</span><button :disabled="!!queueCount" @click="viewHistory(event.revision)">查看此版</button></div><p v-if="!history.length">尚无工作记录，开始绘制后会自动保存。</p></div>
    </template>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p>
  </section>
</template>
