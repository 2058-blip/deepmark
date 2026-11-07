<script setup lang="ts">
import {computed} from 'vue';
import UiIcon from '../UiIcon.vue';
import type {AuthUser,Dataset} from '../api.ts';
import type {useTeamWorkbench} from './useTeamWorkbench.ts';
const props=defineProps<{user:AuthUser;dataset:Dataset;sync:ReturnType<typeof useTeamWorkbench>;leaving:boolean}>();
const emit=defineEmits<{back:[];logout:[];history:[]}>();
const label=computed(()=>props.sync.localMode.value?'本地模式':props.sync.viewingHistory.value?'历史只读':props.sync.error.value?'同步异常':props.sync.encoding.value?'准备操作差量':props.sync.queueCount.value?'待同步 '+props.sync.queueCount.value+' 笔':props.sync.connected.value?'协同在线':'重新连接中');
</script>
<template>
  <section class="native-sync-bar" aria-label="协同同步信息栏" :data-connected="sync.connected.value">
    <button v-if="!sync.viewingHistory.value" class="native-back" :disabled="leaving" @click="emit('back')"><UiIcon name="back" :size="17"/>任务列表</button>
    <span class="native-team"><UiIcon name="users" :size="18"/><strong>{{dataset.groupName||'团队工作台'}}</strong><small>{{dataset.name}}</small></span>
    <span class="native-sync-state" :class="{offline:!sync.connected.value,error:!!sync.error.value}" role="status"><i/>{{label}}</span>
    <span v-if="sync.project.value" class="native-revision">修订 {{sync.project.value.revision}}</span>
    <div class="native-members" aria-label="在线作者"><span v-for="member in sync.members.value" :key="member.id" :title="member.name+(member.id===user.id?'（你）':'')">{{member.name.slice(0,1)}}</span><small>{{sync.members.value.length}} 人在线</small></div>
    <button @click="emit('history')" :disabled="!sync.project.value">操作记录</button>
    <slot name="settings"/>
    <span class="native-account">{{user.name}}<small>{{user.role==='dispatcher'?'派活 · 只读':'标注工程师'}}</small></span>
    <button class="native-logout" :disabled="leaving" @click="emit('logout')">退出账号</button>
    <div v-if="sync.error.value||sync.notice.value" class="native-sync-notice" :class="{error:!!sync.error.value}" role="status">{{sync.error.value||sync.notice.value}}</div>
  </section>
  <section v-if="sync.viewingHistory.value" class="native-history-return" aria-label="历史回看导航">
    <span><i/>历史回看 · 只读</span>
    <button class="native-return-live" :disabled="leaving" @click="emit('back')"><UiIcon name="back" :size="19"/>返回实时成果</button>
  </section>
</template>
