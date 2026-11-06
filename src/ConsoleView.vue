<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref} from 'vue';
import {api,downloadAuthenticated,uploadDataset} from './api.ts';
import type {AuthUser,Dataset,Group} from './api.ts';
import type {TransferProgress as TransferState} from './api.ts';
import {isTransferAborted} from './transfer.ts';
import TransferProgress from './TransferProgress.vue';
import CaseList from './CaseList.vue';
import UiIcon from './UiIcon.vue';
import './console.css';
import './consoleShell.css';

const props=defineProps<{user:AuthUser}>();
const emit=defineEmits<{open:[dataset:Dataset];logout:[]}>();
type MemberStatus={id?:string;userId?:string;name?:string;username?:string;online?:boolean;lastSeen?:string;revision?:number;pending?:number;status?:string};
type HistoryEvent={revision?:number;kind?:string;name?:string;author?:string;time?:string};
type StatusDetail={dataset:Dataset;members?:MemberStatus[];history?:HistoryEvent[]};
type CaseInfo={file:string;patient?:string;description?:string};
const datasets=ref<Dataset[]>([]),groups=ref<Group[]>([]),loading=ref(true),refreshing=ref(false),busy=ref(''),error=ref(''),notice=ref('');
const caseMetadata=ref<CaseInfo[]>([]),metadataRequest=new AbortController();
const manualRefreshing=ref(false);
const search=ref(''),filter=ref('all'),groupName=ref(''),joinCode=ref(''),claimGroup=ref('');
const uploadFile=ref<File|null>(null),uploadName=ref(''),uploadInput=ref<HTMLInputElement|null>(null);
const transfer=ref<TransferState|null>(null),transferTitle=ref(''),transferStage=ref('');
let transferRequest:AbortController|null=null;
const uploadStage=computed(()=>transfer.value?.complete||transfer.value?.percent===100?'服务器正在校验并发布…':transfer.value?.percent===null||!transfer.value?'正在上传…':`正在上传 ${transfer.value.percent}%`);
const canCancelTransfer=computed(()=>!!transferRequest&&(busy.value!=='upload'||!transfer.value?.complete&&transfer.value?.percent!==100));
function cancelTransfer(){if(canCancelTransfer.value)transferRequest?.abort();}
const selectedId=ref<string|null>(null),detail=ref<StatusDetail|null>(null),detailLoading=ref(false),lastUpdated=ref(0);
const filters=[{key:'all',label:'全部'},{key:'unassigned',label:'未标注'},{key:'in_progress',label:'进行中'},{key:'completed',label:'已完成'}] as const;
let poll:ReturnType<typeof setInterval>|null=null;
const isDispatcher=computed(()=>props.user.role==='dispatcher');
const leaderGroups=computed(()=>groups.value.filter(group=>group.isLeader||group.leaderId===props.user.id));
const filtered=computed(()=>datasets.value.filter(dataset=>(filter.value==='all'||dataset.status===filter.value)&&`${dataset.name} ${dataset.groupName||''}`.toLowerCase().includes(search.value.toLowerCase())));
const counts=computed(()=>({all:datasets.value.length,unassigned:datasets.value.filter(d=>d.status==='unassigned').length,in_progress:datasets.value.filter(d=>d.status==='in_progress').length,completed:datasets.value.filter(d=>d.status==='completed').length}));
const detailProgress=computed(()=>{
  const progress=detail.value?.dataset.progress;if(progress===null||progress===undefined)return [];
  if(typeof progress!=='object')return [['进度记录',String(progress)]];
  const labels:Record<string,string>={operations:'操作数',operationCount:'操作数',annotatedVoxels:'已标注体素',labeledVoxels:'已标注体素',onlineMembers:'在线成员',activeMembers:'活跃成员',lastActivity:'最近操作',lastUpdated:'最近更新',revision:'当前修订',parallelRegions:'并列区域',parallelCount:'并列区域',labels:'标签数',labelCount:'标签数'};
  return Object.entries(progress).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>[labels[key]||key,typeof value==='object'?JSON.stringify(value):String(value)]);
});
function stateName(status:Dataset['status']){return {unassigned:'未标注',in_progress:'进行中',completed:'已完成'}[status]||status;}
function formatSize(size:number){return size>=1024**3?`${(size/1024**3).toFixed(2)} GB`:size>=1024**2?`${(size/1024**2).toFixed(1)} MB`:`${Math.max(1,Math.ceil(size/1024))} KB`;}
function time(value?:string){if(!value)return '暂无';const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))return value;const pad=(n:number)=>String(n).padStart(2,'0');return `${parsed.getFullYear()}-${pad(parsed.getMonth()+1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;}
function ownGroup(dataset:Dataset){return groups.value.find(group=>group.id===dataset.groupId);}
function canComplete(dataset:Dataset){const group=ownGroup(dataset);return !isDispatcher.value&&dataset.status==='in_progress'&&!!group&&(group.isLeader||group.leaderId===props.user.id);}
function canOpen(dataset:Dataset){return isDispatcher.value?!!dataset.projectId:dataset.status!=='unassigned'&&!!ownGroup(dataset);}
function memberState(member:MemberStatus){return member.online===true?'在线':member.online===false?'离线':member.status||'小组成员';}
async function loadCaseMetadata(){
  // This optional static file only supplies display text. Dataset access and task status always come from the authenticated API.
  try{
    const value=await api<unknown>('/cases.json',{signal:metadataRequest.signal});
    if(Array.isArray(value))caseMetadata.value=value.flatMap(entry=>{
      if(!entry||typeof entry!=='object')return [];const item=entry as Record<string,unknown>;
      return typeof item.file==='string'?[{file:item.file,patient:typeof item.patient==='string'?item.patient:'',description:typeof item.description==='string'?item.description:''}]:[];
    });
  }catch{caseMetadata.value=[];}
}
async function readDetail(id:string,quiet=false){
  if(!quiet)detailLoading.value=true;
  try{const result=await api<StatusDetail>(`/api/datasets/${encodeURIComponent(id)}/status`);if(selectedId.value===id)detail.value=result;}
  catch(reason){if(selectedId.value===id)error.value=(reason as Error).message;}
  finally{if(selectedId.value===id)detailLoading.value=false;}
}
async function selectDetail(dataset:Dataset){selectedId.value=dataset.id;detail.value={dataset};error.value='';await nextTick();document.querySelector('.console-detail')?.scrollIntoView({behavior:'smooth',block:'start'});await readDetail(dataset.id);}
async function refresh(initial=false,background=false){
  if(refreshing.value)return;refreshing.value=true;manualRefreshing.value=!initial&&!background;if(initial)loading.value=true;
  try{
    const [listed,joined]=await Promise.all([api<{datasets:Dataset[]}>('/api/datasets'),isDispatcher.value?Promise.resolve({groups:[] as Group[]}):api<{groups:Group[]}>('/api/groups')]);
    datasets.value=listed.datasets;groups.value=joined.groups;
    if(!leaderGroups.value.some(group=>group.id===claimGroup.value))claimGroup.value=leaderGroups.value[0]?.id||'';
    lastUpdated.value=Date.now();if(selectedId.value)await readDetail(selectedId.value,true);
  }catch(reason){error.value=(reason as Error).message;}
  finally{refreshing.value=false;manualRefreshing.value=false;loading.value=false;}
}
async function act(key:string,action:()=>Promise<void>){if(busy.value)return;busy.value=key;error.value='';notice.value='';try{await action();await refresh();}catch(reason){if(isTransferAborted(reason))notice.value='传输已取消，可以重试。';else error.value=(reason as Error).message;}finally{busy.value='';}}
async function createGroup(){const name=groupName.value.trim();if(!name)return;await act('create-group',async()=>{const result=await api<{group:Group}>('/api/groups',{method:'POST',body:JSON.stringify({name})});claimGroup.value=result.group.id;groupName.value='';notice.value=`已创建“${result.group.name}”，你是组长。`;});}
async function joinGroup(){const code=joinCode.value.trim();if(!code)return;await act('join-group',async()=>{const result=await api<{group:Group}>('/api/groups/join',{method:'POST',body:JSON.stringify({code})});joinCode.value='';notice.value=`已加入“${result.group.name}”。`;});}
function chooseUpload(event:Event){const input=event.target as HTMLInputElement;uploadFile.value=input.files?.[0]||null;if(uploadFile.value&&!uploadName.value)uploadName.value=uploadFile.value.name;}
async function upload(){const file=uploadFile.value;if(!file)return;if(!/\.nii(?:\.gz)?$/i.test(file.name)){error.value='请选择 .nii 或 .nii.gz 影像文件。';return;}if(!file.size){error.value='影像文件为空，请重新选择。';return;}
  await act('upload',async()=>{
    transferRequest=new AbortController();transfer.value={loaded:0,total:null,percent:null};transferTitle.value=`上传影像：${file.name}`;transferStage.value='正在上传影像…';
    try{const form=new FormData();form.set('file',file);if(uploadName.value.trim())form.set('name',uploadName.value.trim());const result=await uploadDataset(form,progress=>{transfer.value=progress;transferStage.value=progress.complete||progress.percent===100?'上传已完成，服务器正在校验并发布…':'正在上传影像…';},{signal:transferRequest.signal});uploadFile.value=null;uploadName.value='';if(uploadInput.value)uploadInput.value.value='';notice.value=`“${result.dataset.name}”已发布，等待组长认领。`;}
    finally{transferRequest=null;transfer.value=null;}
  });
}
async function claim(dataset:Dataset){if(!claimGroup.value)return;await act(`claim:${dataset.id}`,async()=>{await api(`/api/datasets/${encodeURIComponent(dataset.id)}/claim`,{method:'POST',body:JSON.stringify({groupId:claimGroup.value})});notice.value=`已认领“${dataset.name}”，小组成员现在可以共同标注。`;});}
async function complete(dataset:Dataset){if(!canComplete(dataset)||!window.confirm(`将“${dataset.name}”标记为已完成？完成后小组成员将只能查看成果，请确认成员已同步当前工作。`))return;await act(`complete:${dataset.id}`,async()=>{await api(`/api/datasets/${encodeURIComponent(dataset.id)}/complete`,{method:'POST',body:JSON.stringify({revision:dataset.revision})});notice.value=`“${dataset.name}”已完成，派活方可以下载成果。`;});}
async function downloadResult(dataset:Dataset){if(dataset.status!=='completed'||!dataset.projectId)return;if(dataset.editor==='workbench'){emit('open',{...dataset,workbenchExport:true});return;}await act(`download:${dataset.id}`,async()=>{
  transferRequest=new AbortController();transfer.value={loaded:0,total:null,percent:null};transferTitle.value=`下载成果：${dataset.name}`;transferStage.value='正在生成并下载成果 ZIP…';
  try{await downloadAuthenticated(`/api/collaboration/projects/${encodeURIComponent(dataset.projectId!)}/export`,`${dataset.name.replace(/\.nii(?:\.gz)?$/i,'')}-seg.zip`,{signal:transferRequest.signal,onProgress:progress=>{transfer.value=progress;transferStage.value=progress.complete?'下载完成，正在交给浏览器保存…':progress.loaded?'正在下载成果 ZIP…':'正在生成并下载成果 ZIP…';}});notice.value='成果 ZIP 下载完成，已交给浏览器保存。';}
  finally{transferRequest=null;transfer.value=null;}
});}
function open(dataset:Dataset){if(canOpen(dataset)&&!busy.value)emit('open',dataset);}
onMounted(()=>{void refresh(true);void loadCaseMetadata();poll=setInterval(()=>{if(!busy.value)void refresh(false,true);},5000);});
onBeforeUnmount(()=>{if(poll)clearInterval(poll);metadataRequest.abort();transferRequest?.abort();});
</script>

<template>
  <div class="console-page console-shell">
    <div v-if="transfer" class="console-transfer-status"><TransferProgress :title="transferTitle" :progress="transfer" :stage="transferStage" :cancellable="canCancelTransfer" @cancel="cancelTransfer"/></div>
    <header class="console-topbar"><div class="console-brand"><strong>DeepMark</strong><span class="console-brand-role"><UiIcon :name="isDispatcher?'folder':'users'" :size="17"/>{{isDispatcher?'派活工作台':'干活工作台'}}</span></div><div class="console-account"><span class="console-account-avatar" aria-hidden="true">{{(user.name||user.username).slice(0,1)}}</span><span class="console-account-identity" :title="`${user.name} · @${user.username}`">{{user.name}} <small>@{{user.username}}</small></span><button :disabled="!!busy" @click="emit('logout')"><UiIcon name="logout" :size="17"/>退出登录</button></div></header>
    <main class="console-content">
      <section class="console-heading"><div><span class="eyebrow"><UiIcon :name="isDispatcher?'folder':'users'" :size="16"/>{{isDispatcher?'影像发布':'团队协作'}}</span><h1>{{isDispatcher?'发布影像，跟进标注成果':'组成小组，协同完成标注'}}</h1><p>{{isDispatcher?'上传后的影像会进入待认领列表。你可以查看自己发布的数据集、监看标注并下载已完成成果。':'组长认领待标注影像，小组成员使用同一份实时协作工程。已完成任务保留为只读。'}}</p></div><button :disabled="manualRefreshing||!!busy" :aria-busy="manualRefreshing" @click="error='';refresh()"><UiIcon name="refresh" :size="17"/>刷新工作台</button></section>
      <p v-if="error" class="console-error" role="alert">{{error}}</p><p v-if="notice" class="console-notice" role="status">{{notice}}</p>
      <section v-if="isDispatcher" class="console-card console-upload"><div><h2><UiIcon name="upload" :size="21"/>发布待标注影像</h2><p>支持三维灰度 NIfTI-1：.nii / .nii.gz。</p></div><form @submit.prevent="upload"><label>影像文件<input ref="uploadInput" type="file" accept=".nii,.nii.gz" required :disabled="!!busy" @change="chooseUpload"/></label><label>显示名称<input v-model="uploadName" maxlength="160" placeholder="选填，默认使用文件名" :disabled="!!busy"/></label><button class="primary" :disabled="!uploadFile||!!busy"><UiIcon name="upload" :size="17"/>{{busy==='upload'?uploadStage:'上传并发布'}}</button><small v-if="uploadFile">{{uploadFile.name}} · {{formatSize(uploadFile.size)}}</small></form></section>
      <section v-else class="console-team-grid">
        <article class="console-card"><h2><UiIcon name="users" :size="21"/>我的干活组</h2><p v-if="!groups.length" class="console-muted">创建一个小组成为组长，或使用邀请码加入已有小组。</p><div v-for="group in groups" :key="group.id" class="console-group"><div><strong>{{group.name}}</strong><span class="console-role">{{group.isLeader||group.leaderId===user.id?'组长':'成员'}}</span></div><p>邀请码 <code>{{group.code}}</code> · {{group.members.length}} 位成员</p><p class="console-members">{{group.members.map(member=>member.name||member.username).join('、')}}</p></div></article>
        <article class="console-card console-team-forms"><form @submit.prevent="createGroup"><h2><UiIcon name="plus" :size="21"/>创建小组</h2><label>小组名称<input v-model="groupName" maxlength="80" required placeholder="例如：骨骼标注一组" :disabled="!!busy"/></label><button :disabled="!groupName.trim()||!!busy"><UiIcon name="plus" :size="17"/>{{busy==='create-group'?'正在创建…':'创建并成为组长'}}</button></form><form @submit.prevent="joinGroup"><h2><UiIcon name="users" :size="21"/>加入小组</h2><label>小组邀请码<input v-model="joinCode" maxlength="64" required placeholder="输入组长分享的邀请码" :disabled="!!busy"/></label><button :disabled="!joinCode.trim()||!!busy"><UiIcon name="users" :size="17"/>{{busy==='join-group'?'正在加入…':'加入小组'}}</button></form></article>
      </section>
      <section class="console-card console-datasets"><div class="console-section-heading"><div><h2><UiIcon name="layers" :size="21"/>{{isDispatcher?'我发布的数据集':'可认领影像与小组任务'}}</h2><p>{{lastUpdated?`最近更新 ${new Date(lastUpdated).toLocaleTimeString('zh-CN')} · 每 5 秒自动刷新`:'正在获取工作台数据…'}}</p></div><label v-if="!isDispatcher&&leaderGroups.length" class="console-claim-group">认领到小组<select v-model="claimGroup" :disabled="!!busy"><option v-for="group in leaderGroups" :key="group.id" :value="group.id">{{group.name}}</option></select></label></div>
        <div class="console-list-toolbar"><div class="console-filters"><button v-for="option in filters" :key="option.key" :class="{active:filter===option.key}" @click="filter=option.key">{{option.label}} <span>{{counts[option.key]}}</span></button></div><input v-model="search" type="search" aria-label="搜索数据集" placeholder="搜索影像名称或小组"/></div>
        <CaseList :datasets="filtered" :loading="loading" :busy="!!busy||refreshing" :selected-id="selectedId" :metadata="caseMetadata" :total-count="datasets.length" :empty-message="isDispatcher?'上传影像后，会在这里显示发布状态。':'派活方发布影像后，组长可以在这里认领。'" @refresh="error='';refresh()">
          <template #actions="{dataset}">
            <button :disabled="!!busy" @click="selectDetail(dataset)">详细状态</button>
            <button v-if="!isDispatcher&&dataset.status==='unassigned'" class="primary" :disabled="!claimGroup||!!busy" :title="!leaderGroups.length?'只有组长可以认领，请先创建小组或联系组长':''" @click="claim(dataset)">{{busy===`claim:${dataset.id}`?'正在认领…':'组长认领'}}</button>
            <button v-else-if="canOpen(dataset)" :class="{primary:dataset.status==='in_progress'&&!isDispatcher}" :disabled="!!busy" @click="open(dataset)">{{isDispatcher?'只读监看':dataset.status==='completed'?'查看成果':'进入协同标注'}}</button>
            <button v-if="canComplete(dataset)" :disabled="!!busy" @click="complete(dataset)">提交完成</button>
            <button v-if="dataset.status==='completed'&&dataset.projectId" :disabled="!!busy" @click="downloadResult(dataset)">{{busy===`download:${dataset.id}`?'正在下载…':'下载成果'}}</button>
          </template>
        </CaseList>
      </section>
      <section v-if="selectedId&&detail" class="console-card console-detail" aria-labelledby="dataset-detail-title"><div class="console-section-heading"><div><h2 id="dataset-detail-title"><UiIcon name="file" :size="21"/>{{detail.dataset.name}} · 详细状态</h2><p>{{detailLoading?'正在读取详细状态…':'状态随工作台自动更新'}}</p></div><button @click="selectedId=null;detail=null"><UiIcon name="close" :size="16"/>收起</button></div><dl class="console-detail-grid"><div><dt>任务状态</dt><dd>{{stateName(detail.dataset.status)}}</dd></div><div><dt>标注小组</dt><dd>{{detail.dataset.groupName||'尚未认领'}}</dd></div><div><dt>当前修订</dt><dd>{{detail.dataset.revision??'暂无操作'}}</dd></div><div><dt>最近更新</dt><dd>{{time(detail.dataset.modified)}}</dd></div><div v-for="([label,value],index) in detailProgress" :key="index"><dt>{{label}}</dt><dd>{{value}}</dd></div></dl><div class="console-detail-columns"><div><h3><UiIcon name="users" :size="17"/>成员状态</h3><ul v-if="detail.members?.length" class="console-member-list"><li v-for="(member,index) in detail.members" :key="member.id||member.userId||index"><span><strong>{{member.name||member.username||'小组成员'}}</strong><small v-if="member.username">@{{member.username}}</small></span><span :class="['console-presence',{online:member.online}]">{{memberState(member)}}<small v-if="member.pending!==undefined"> · 待同步 {{member.pending}}</small><small v-if="member.revision!==undefined"> · 修订 {{member.revision}}</small><small v-if="member.lastSeen"> · {{time(member.lastSeen)}}</small></span></li></ul><p v-else class="console-muted">{{detail.dataset.status==='unassigned'?'尚未分配标注小组。':'暂无成员活动记录。'}}</p></div><div><h3><UiIcon name="cache" :size="17"/>最近标注记录</h3><ol v-if="detail.history?.length" class="console-history-list"><li v-for="(event,index) in detail.history.slice(0,20)" :key="`${event.revision}:${index}`"><strong>{{event.name||event.author||'成员'}}<span v-if="event.revision!==undefined"> · 修订 {{event.revision}}</span></strong><span>{{event.kind||'标注更新'}} · {{time(event.time)}}</span></li></ol><p v-else class="console-muted">暂无标注操作记录。</p></div></div></section>
    </main>
  </div>
</template>
<style scoped>
.console-transfer-status{position:fixed;right:24px;bottom:24px;z-index:40;width:min(420px,calc(100vw - 32px));filter:drop-shadow(0 5px 16px #173c3720)}
@media(max-width:600px){.console-transfer-status{right:16px;bottom:max(16px,env(safe-area-inset-bottom))}}
</style>
