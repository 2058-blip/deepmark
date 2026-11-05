<script setup lang="ts">
import {onMounted,ref,watch} from 'vue';
import AuthView from './AuthView.vue';
import ConsoleView from './ConsoleView.vue';
import WorkbenchHost from './workbench/WorkbenchHost.vue';
import {api,authUser,loadCurrentUser} from './api.ts';
import type {Dataset} from './api.ts';
import type {HistoryView} from './workbench/wire.ts';
const checking=ref(true),dataset=ref<Dataset|null>(null),error=ref('');
const historyView=ref<HistoryView|undefined>();
onMounted(async()=>{try{await loadCurrentUser();}catch(reason){error.value=(reason as Error).message;}finally{checking.value=false;}});
watch(authUser,(user,old)=>{if(user?.id!==old?.id)dataset.value=null;});
async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'});authUser.value=null;dataset.value=null;historyView.value=undefined;}catch(reason){error.value=(reason as Error).message;}}
function back(){if(historyView.value)historyView.value=undefined;else dataset.value=null;}
</script>
<template>
  <main v-if="checking" class="console-loading">正在连接团队工作台…</main>
  <template v-else-if="authUser">
    <WorkbenchHost v-if="dataset" :key="authUser.id+':'+dataset.id+':'+JSON.stringify(historyView)" :user="authUser" :dataset="dataset" :history-view="historyView" @back="back" @logout="logout" @inspect="historyView=$event"/>
    <ConsoleView v-else :user="authUser" @open="dataset=$event;historyView=undefined" @logout="logout"/>
  </template>
  <AuthView v-else @authenticated="authUser=$event"/>
  <p v-if="error" role="alert" class="native-auth-error">{{error}}</p>
</template>
