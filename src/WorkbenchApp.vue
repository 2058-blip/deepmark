<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref,watch} from 'vue';
import AuthView from './AuthView.vue';
import ConsoleView from './ConsoleView.vue';
import WorkbenchHost from './workbench/WorkbenchHost.vue';
import {api,authUser,loadCurrentUser} from './api.ts';
import type {Dataset} from './api.ts';
import type {HistoryView} from './workbench/wire.ts';
const checking=ref(true),dataset=ref<Dataset|null>(null),error=ref('');
const historyView=ref<HistoryView|undefined>();
const opening=ref(false);
let linkRequest:AbortController|undefined;
function cancelLink(){linkRequest?.abort();linkRequest=undefined;opening.value=false;}
function setDatasetLink(id:string|null){
  const url=new URL(window.location.href);
  if(id)url.searchParams.set('dataset',id);else url.searchParams.delete('dataset');
  if(url.href!==window.location.href)window.history.pushState(null,'',url);
}
async function openLinkedDataset(){
  cancelLink();dataset.value=null;historyView.value=undefined;error.value='';
  const id=new URL(window.location.href).searchParams.get('dataset'),userId=authUser.value?.id;
  if(!id||!userId)return;
  const request=new AbortController();linkRequest=request;opening.value=true;
  try{
    const result=await api<{dataset:Dataset}>('/api/datasets/'+encodeURIComponent(id),{signal:request.signal});
    if(!request.signal.aborted&&authUser.value?.id===userId)dataset.value=result.dataset;
  }catch(reason){if(!request.signal.aborted)error.value='无法打开影像：'+(reason as Error).message;}
  finally{if(linkRequest===request){linkRequest=undefined;opening.value=false;}}
}
function openDataset(value:Dataset){cancelLink();error.value='';dataset.value=value;historyView.value=undefined;setDatasetLink(value.id);}
onMounted(async()=>{window.addEventListener('popstate',openLinkedDataset);try{await loadCurrentUser();}catch(reason){error.value=(reason as Error).message;}finally{checking.value=false;}});
onBeforeUnmount(()=>{cancelLink();window.removeEventListener('popstate',openLinkedDataset);});
watch(()=>authUser.value?.id,()=>void openLinkedDataset(),{immediate:true});
async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'});authUser.value=null;dataset.value=null;historyView.value=undefined;}catch(reason){error.value=(reason as Error).message;}}
function back(){if(historyView.value)historyView.value=undefined;else{cancelLink();dataset.value=null;setDatasetLink(null);}}
</script>
<template>
  <main v-if="checking||opening" class="console-loading">正在连接团队工作台…</main>
  <template v-else-if="authUser">
    <WorkbenchHost v-if="dataset" :key="authUser.id+':'+dataset.id+':'+JSON.stringify(historyView)" :user="authUser" :dataset="dataset" :history-view="historyView" @back="back" @logout="logout" @inspect="historyView=$event"/>
    <ConsoleView v-else :user="authUser" @open="openDataset" @logout="logout"/>
  </template>
  <AuthView v-else @authenticated="authUser=$event"/>
  <p v-if="error" role="alert" class="native-auth-error">{{error}}</p>
</template>
