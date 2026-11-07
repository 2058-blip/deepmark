<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import Workbench from '../../mimics-workbench/src/mimics/Workbench.vue';
import {useWorkbench} from '../../mimics-workbench/src/mimics/useWorkbench.ts';
import {IndexedDBWorkspaceRepository} from '../../mimics-workbench/src/mimics/workspaceRepository.ts';
import type {WorkspaceRepository} from '../../mimics-workbench/src/mimics/workspaceRepository.ts';
import {api,downloadBlobAuthenticated,fingerprint} from '../api.ts';
import type {AuthUser,Dataset,TransferProgress as Progress} from '../api.ts';
import TransferProgress from '../TransferProgress.vue';
import WorkbenchSyncBar from './WorkbenchSyncBar.vue';
import AnnotationHover from './AnnotationHover.vue';
import ForeignMaskGrid from './ForeignMaskGrid.vue';
import WorkbenchDisplaySettings from './WorkbenchDisplaySettings.vue';
import ViewportControls from './ViewportControls.vue';
import {useTeamWorkbench} from './useTeamWorkbench.ts';
import {WORKBENCH_BASE} from './wire.ts';
import type {SharedWorkbench,HistoryView} from './wire.ts';
import './workbench.css';
const props=defineProps<{user:AuthUser;dataset:Dataset;historyView?:HistoryView}>();
const emit=defineEmits<{back:[];logout:[];inspect:[view:HistoryView]}>();
const displayPreferenceKey='deepmark:foreign-mask-grid:'+props.user.id;
const showForeignGrid=ref((()=>{try{return localStorage.getItem(displayPreferenceKey)!=='false';}catch{return true;}})());
watch(showForeignGrid,value=>{try{localStorage.setItem(displayPreferenceKey,String(value));}catch{/* Storage may be unavailable; the current display still works. */}});
const loading=ref(true),stage=ref('正在获取团队最新成果…'),error=ref(''),progress=ref<Progress|null>(null),leaving=ref(false),showHistory=ref(false);
const request=new AbortController(),stored=new IndexedDBWorkspaceRepository('deepmark-native-workspaces-'+props.user.id);
let projectId='',source:Float32Array|null=null,cachedRevision:number|undefined,rawUnit=0;
const cacheId=(unit:number)=>projectId+(unit!==rawUnit?':unit:'+unit:'');
const repository:WorkspaceRepository={
  save:async snapshot=>{
    if(sync.recoveryBlocked.value||props.historyView&&!sync.localMode.value)return;
    const shared=!!projectId&&snapshot.volume.data===source;
    await stored.save({...snapshot,id:shared?cacheId(snapshot.volume.header[123]!&7):snapshot.id});
    if(shared&&snapshot.revision!==undefined)await sync.markCached(snapshot.revision);
  },
  list:()=>stored.list(),load:async id=>{const value=await stored.load(id);cachedRevision=value?.revision;return value;},
};
const editor=useWorkbench({repository}),sync=useTeamWorkbench(editor,props.user,props.dataset);
const readOnly=computed(()=>loading.value||!sync.localMode.value&&!sync.canWrite.value);
const allowExport=computed(()=>sync.localMode.value||props.user.role==='worker'||props.dataset.status==='completed');
function guardKey(event:KeyboardEvent){
  if(!readOnly.value)return;
  const key=event.key.toLowerCase(),input=(event.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable=true]');
  if(!input&&((event.ctrlKey||event.metaKey)&&['z','y'].includes(key)||['b','e','g','delete','backspace','enter'].includes(key))){event.preventDefault();event.stopImmediatePropagation();}
}
async function enter(){
  try{
    let snapshot=await api<SharedWorkbench>(WORKBENCH_BASE,{method:'POST',headers:{'X-Workbench-Author':encodeURIComponent(props.user.id)},body:JSON.stringify({datasetId:props.dataset.id,fingerprint:props.dataset.fingerprint})});
    if(props.historyView)snapshot=await api<SharedWorkbench>(WORKBENCH_BASE+'/'+snapshot.id+(props.historyView.kind==='legacy'?'/legacy?revision=':'?revision=')+props.historyView.revision);
    projectId=snapshot.id;rawUnit=snapshot.manifest.rawUnit??0;
    const pending=props.historyView?[]:await sync.pendingFor(projectId),available=(await stored.list()).filter(item=>item.id===projectId||item.id.startsWith(projectId+':unit:'));
    const cache=pending.length?available.sort((a,b)=>b.updatedAt-a.updatedAt)[0]:available.find(item=>item.id===cacheId(snapshot.manifest.sourceUnit||rawUnit));
    const selected=cache||(!props.historyView?available.find(item=>item.id===projectId):undefined);
    if(selected){stage.value='正在恢复本机影像并获取服务器最新标注…';await editor.restoreLocalProject(selected.id);}
    else{
      stage.value='正在下载 CT…';const blob=await downloadBlobAuthenticated(props.dataset.downloadUrl,{signal:request.signal,onProgress:value=>{progress.value=value;}});
      stage.value='正在校验影像…';if(await fingerprint(blob,{signal:request.signal})!==props.dataset.fingerprint)throw new Error('影像指纹不一致，请重新打开数据集。');
      stage.value='正在读取 CT…';const suffix=props.dataset.format.toLowerCase().includes('gzip')?'.nii.gz':'.nii';
      if(!await editor.openFiles([new File([blob],props.dataset.id+suffix)]))throw new Error(editor.error.value||'影像读取失败。');
    }
    source=editor.volume.value?.data||null;stage.value='正在加载完整共享成果…';await sync.load(snapshot,cachedRevision,!!props.historyView);
    if(props.dataset.workbenchExport)await editor.downloadProject();
  }catch(reason){if(!request.signal.aborted)error.value=(reason as Error).message;}
  finally{loading.value=false;}
}
async function leave(logout=false){
  if(leaving.value)return;leaving.value=true;error.value='';
  try{await sync.flush();await editor.flushLocalCache();if(logout)emit('logout');else{sync.dispose();emit('back');}}
  catch(reason){error.value=(reason as Error).message;}
  finally{leaving.value=false;}
}
function pointerDown(){sync.pointerState(true);}
function pointerUp(){sync.pointerState(false);}
async function openHistory(){showHistory.value=!showHistory.value;if(showHistory.value)try{await sync.readHistory();}catch(reason){error.value=(reason as Error).message;}}
async function inspect(kind:HistoryView['kind'],revision:number){try{await sync.flush();await editor.flushLocalCache();emit('inspect',{kind,revision});}catch(reason){error.value=(reason as Error).message;}}
onMounted(()=>{window.addEventListener('keydown',guardKey,true);window.addEventListener('pointerup',pointerUp,true);window.addEventListener('pointercancel',pointerUp,true);void enter();});
onBeforeUnmount(()=>{request.abort();sync.dispose();window.removeEventListener('keydown',guardKey,true);window.removeEventListener('pointerup',pointerUp,true);window.removeEventListener('pointercancel',pointerUp,true);});
</script>
<template>
  <div class="collaborative-native-workbench" :class="{'native-history-view':!!historyView&&!sync.localMode.value}" @pointerdown.capture="pointerDown">
    <Workbench :editor="editor" :read-only="readOnly" :team-mode="!sync.localMode.value" :allow-export="allowExport" :mask-delete-reason="sync.localMode.value?'':sync.maskDeletionReason.value" :mask-contributors="sync.localMode.value?undefined:sync.maskContributors.value">
      <template #collaboration><WorkbenchSyncBar :user="user" :dataset="dataset" :sync="sync" :leaving="leaving" @back="leave()" @logout="leave(true)" @history="openHistory"><template #settings><WorkbenchDisplaySettings v-model:show-foreign-grid="showForeignGrid"/></template></WorkbenchSyncBar></template>
      <template #annotation-hover="view"><ViewportControls v-bind="view"/><AnnotationHover v-bind="view" :annotations-at="sync.annotationsAt"/><ForeignMaskGrid v-bind="view" :enabled="showForeignGrid" :locked-at="view.plane?sync.foreignMaskAt.value:sync.imageForeignMaskAt.value"/></template>
    </Workbench>
    <div v-if="loading" class="busy-overlay" role="status"><TransferProgress :title="dataset.name" :progress="progress" :stage="stage" cancellable @cancel="request.abort();emit('back')"/></div>
    <div v-if="error" class="native-host-error" role="alert">{{error}}<button @click="error=''">关闭提示</button><button v-if="!editor.volume.value" @click="emit('back')">返回任务列表</button></div>
    <aside v-if="showHistory" class="native-history-panel" aria-label="协同操作记录"><header><strong>团队操作记录</strong><button @click="showHistory=false">关闭</button></header><button @click="inspect('native',0)">查看初始成果</button><p v-if="!sync.history.value.length">暂无新操作。</p><article v-for="entry in sync.history.value" :key="entry.revision"><strong>{{entry.name}}</strong><span>{{entry.kind}}</span><small>r{{entry.revision}} · {{new Date(entry.time).toLocaleTimeString()}}</small><button :aria-label="'查看修订 '+entry.revision" @click="inspect('native',entry.revision)">只读回看</button></article><template v-if="sync.legacyHistory.value.length"><h3>迁移前历史</h3><article v-for="entry in sync.legacyHistory.value" :key="'legacy'+entry.revision"><strong>{{entry.name}}</strong><span>{{entry.kind}}</span><small>旧版 r{{entry.revision}}</small><button @click="inspect('legacy',entry.revision)">只读回看</button></article></template></aside>
  </div>
</template>
