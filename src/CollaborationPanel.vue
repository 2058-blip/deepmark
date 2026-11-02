<script setup lang="ts">
import {computed,ref,useId,watch,watchPostEffect} from 'vue';
import type {useCollaboration} from './useCollaboration.ts';
import type {ParallelAnnotation} from './collaborationTypes.ts';
import UiIcon from './UiIcon.vue';
import './collaboration.css';
import './collaborationPeople.css';
import './collaborationDrawer.css';
const props=withDefaults(defineProps<{datasetId:string|null;collaboration:ReturnType<typeof useCollaboration>;compact?:boolean;sidebar?:boolean;maximized?:boolean}>(),{compact:false,sidebar:false,maximized:false});
defineEmits<{reload:[];reveal:[]}>();
const {person,project,history,historical,onlineMembers,presenceKnown,presenceError,historyReady,historyError,syncText,error,cacheError,connected,joining,initializing,queueCount,active,canWrite,viewHistory,exiting,exitBlocked,exitNotice,retryFinish,forceLocalExit,exportLocal,focusRegion,highlightAnnotation,offlineSource}=props.collaboration;
const exitDialog=ref<HTMLDialogElement|null>(null);
const expanded=ref(false),historyExpanded=ref(false),drawerOpen=ref(false),detailsId=useId(),drawerId=useId();
const displayedMembers=computed(()=>[...onlineMembers.value].sort((a,b)=>Number(b.id===person.value?.id)-Number(a.id===person.value?.id)||a.name.localeCompare(b.name,'zh-CN')));
const recentHistory=computed(()=>history.value.slice(0,3));
const connectionSummary=computed(()=>{
  if(exiting.value)return '正在同步操作';
  if(initializing.value||joining.value)return '正在加载任务';
  if(error.value||cacheError.value)return '同步异常';
  if(!active.value)return '等待任务';
  if(!connected.value)return '正在连接';
  if(queueCount.value)return `${queueCount.value} 笔待同步`;
  return '已同步';
});
const fullySynced=computed(()=>active.value&&connected.value&&!queueCount.value&&!error.value&&!cacheError.value&&!initializing.value&&!joining.value);
const sidebarNotice=computed(()=>[...new Set([error.value,cacheError.value,exitNotice.value,active.value&&offlineSource.value?'当前显示离线缓存，联网后会恢复同步。':active.value&&!connected.value?'实时连接已断开，操作将保留在本地等待同步。':'',historical.value!==null?'当前正在查看历史版本，展开协作卡片可返回实时编辑。':''].filter(Boolean))].join(' '));
watch(()=>project.value?.id,()=>{drawerOpen.value=false;expanded.value=props.compact&&!props.sidebar&&!!project.value?.regions.length;historyExpanded.value=false;});
watch(()=>project.value?.regions.length||0,(count,previous)=>{if(props.compact&&count>previous)expanded.value=true;});
watch(historical,value=>{if(props.compact&&value!==null)expanded.value=true;});
watchPostEffect(()=>{const dialog=exitDialog.value;if(!dialog)return;if((exiting.value||exitBlocked.value)&&!dialog.open)dialog.showModal();else if(!exiting.value&&!exitBlocked.value&&dialog.open)dialog.close();});
function labelSummary(row:ParallelAnnotation){const ids=[...new Set(row.values.map(([,v])=>v))];return ids.map(id=>id===0?'背景 / 擦除':project.value?.labels.find(l=>l.id===id)?.name||`标签 ${id}`).join('、');}
function roleName(role:string){return role==='dispatcher'?'派活 · 只读':'标注成员';}
function actionName(kind:string){return ({edit:'标注',undo:'撤销',redo:'重做',label:'更新标签',threshold:'阈值分割'} as Record<string,string>)[kind]||kind||'标注操作';}
function operationTime(time:string){const date=new Date(time);return Number.isNaN(date.getTime())?'时间未记录':date.toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function fullTime(time:string){const date=new Date(time);return Number.isNaN(date.getTime())?'时间未记录':date.toLocaleString('zh-CN',{hour12:false});}
</script>
<template>
  <section :class="['collaboration-panel',{'is-compact':compact||sidebar,'is-drawer':sidebar,'is-drawer-open':sidebar&&drawerOpen}]" :data-expanded="sidebar?drawerOpen:undefined" :data-author="person?.id" :data-online="connected" :data-pending="queueCount" :data-error="!!(error||cacheError)" :aria-busy="initializing||joining||exiting">
    <header v-if="sidebar" class="collaboration-drawer-header">
      <button class="collaboration-drawer-toggle" :aria-label="`${drawerOpen?'收起':'展开'}实时协作`" :aria-expanded="drawerOpen" :aria-controls="drawerId" @click="drawerOpen=!drawerOpen"><UiIcon name="chevron" :size="16"/><strong>实时协作</strong></button>
      <span class="drawer-online-count" :class="{'is-online':connected&&presenceKnown}" aria-live="polite"><template v-if="connected&&presenceKnown">{{displayedMembers.length}}<span> 人在线</span></template><template v-else>{{connected?'连接中':'离线'}}</template></span>
      <span v-if="!drawerOpen" class="drawer-closed-status" :class="{'is-warning':!!sidebarNotice||!!queueCount}" :title="connectionSummary">{{sidebarNotice?'需关注':queueCount?`${queueCount} 笔待同步`:connectionSummary}}</span>
    </header>
    <header v-else :class="{'collaboration-summary':compact}"><strong>{{person?.role==='dispatcher'?'实时只读监看':'任务协同'}}</strong><template v-if="compact"><span :class="['collaboration-summary-status',{'is-warning':!!(error||cacheError||queueCount),'is-online':active&&connected&&!error&&!cacheError&&!queueCount}]" aria-live="polite">{{connectionSummary}}</span><span v-if="project" class="collaboration-revision">修订 {{project.revision}}</span><span v-if="project?.regions.length" class="collaboration-region-count">{{project.regions.length}} 处并列标注</span><button class="collaboration-details-toggle" :aria-expanded="expanded" :aria-controls="detailsId" @click="expanded=!expanded">{{expanded?'收起详情':'协作详情'}}</button></template><span v-else>{{canWrite?'当前小组成员可共同标注':'当前账号仅可查看成果'}}</span></header>
    <div v-show="!sidebar||drawerOpen" :id="drawerId" class="collaboration-drawer-body">
    <p v-if="datasetId&&!active">{{joining?'正在加载任务已有标注…':'任务标注尚未加载完成，暂不能编辑。'}} <button v-if="!joining" @click="$emit('reload')">重新加载任务标注</button></p>
    <p v-if="active&&offlineSource" class="collaboration-error">当前显示本地缓存，联网后会获取共享完整成果并提交待上传操作。</p>
    <p v-if="active&&project?.status==='finalized'" class="final-status">已由 {{project.finalizedBy}} 定稿。当前仅可查看和导出。</p>
    <div v-if="historical!==null" class="history-banner">当前为只读视图<button @click="viewHistory(null)">返回实时编辑</button></div>
    <div v-if="active" class="collaboration-people" aria-label="当前工程在线协作者">
      <span class="people-caption">当前在线<template v-if="connected&&presenceKnown"> · {{displayedMembers.length}} 人</template></span>
      <ul v-if="connected&&presenceKnown&&displayedMembers.length" class="presence-members">
        <li v-for="member in displayedMembers" :key="member.id" :data-presence-author="member.id" :data-self="member.id===person?.id" :title="`${member.name} · ${roleName(member.role)}`"><span class="presence-avatar" aria-hidden="true">{{member.name.slice(0,1)}}</span><strong>{{member.name}}</strong><span v-if="member.id===person?.id" class="presence-self">我</span><small>{{roleName(member.role)}}</small><span class="presence-dot" aria-label="在线"/></li>
      </ul>
      <span v-else class="presence-unavailable">{{!connected?'连接已断开，在线状态暂不可用':presenceError||(!presenceKnown?'正在获取在线成员…':'暂无在线成员')}}</span>
    </div>
    <div v-if="active" class="collaboration-recent" aria-label="最近已同步操作">
      <div class="recent-caption"><strong>{{sidebar?'协作动态':'最近操作'}}</strong><span>执行者 · 动作 · 时间</span><button v-if="history.length>3&&(!expanded||!historyExpanded)" @click="expanded=true;historyExpanded=true">展开记录 · {{history.length}} 条</button></div>
      <ol v-if="recentHistory.length" class="recent-operations"><li v-for="entry in recentHistory" :key="entry.revision" :data-operation-author="entry.author"><strong>{{entry.name||'作者未记录'}}<small v-if="entry.author===person?.id">（我）</small></strong><span class="recent-action">{{actionName(entry.kind)}}</span><time :datetime="entry.time" :title="fullTime(entry.time)">{{operationTime(entry.time)}}</time><span class="recent-revision">修订 {{entry.revision}}</span></li></ol>
      <p v-else class="recent-empty">{{offlineSource?'离线缓存中不含实时操作记录':historyError||(!historyReady?'正在加载操作记录…':'暂无已同步操作')}}</p>
      <span v-if="recentHistory.length&&historyError" class="recent-warning">{{historyError}}</span>
    </div>
    <div v-if="sidebar&&active" class="drawer-sync-card" :class="{'is-synced':fullySynced}" role="status"><UiIcon :name="fullySynced?'check':'cache'" :size="22"/><span><strong>{{fullySynced?'当前任务已同步':connectionSummary}}</strong><small>{{fullySynced?'更改已保存至共享成果':queueCount?'待上传操作已保留在本地':'请留意连接与同步状态'}}</small></span></div>
    <button v-if="sidebar" class="collaboration-details-toggle drawer-details-button" :aria-expanded="expanded" :aria-controls="detailsId" @click="expanded=!expanded">{{expanded?'收起协作详情':'协作详情与历史'}}<span v-if="project?.regions.length">{{project.regions.length}} 处并列标注</span><UiIcon name="chevron" :size="14"/></button>
    <div v-show="(!compact&&!sidebar)||expanded" :id="detailsId" class="collaboration-details">
    <div v-if="person" class="collaboration-controls"><strong>{{person.name}}</strong><span>{{active?(connected?'实时连接已建立':'正在连接实时服务'):'正在加载任务'}}</span></div>
    <template v-if="active">
      <div class="collaboration-controls"><span v-if="queueCount||error||!connected" class="sync-indicator" role="status">{{syncText}}</span><button v-if="person?.role==='worker'||project?.datasetStatus==='completed'" @click="exportLocal">导出本地副本</button>
      </div>
      <template v-if="project!.status!=='finalized'"><p v-if="canWrite">同一区域可提交自己的标注，其他作者的意见会保留。只能删除自己的标注。</p><p v-else>此视图会随团队操作更新。切片、缩放、窗宽窗位及标注来源查询可正常使用。</p></template>
      <div v-if="project!.regions.length" class="parallel-regions"><header><strong>并列标注 · {{project!.regions.length}} 处区域</strong><button v-if="highlightAnnotation" @click="highlightAnnotation=null">显示全部意见</button></header>
        <article v-for="(region,index) in project!.regions" :key="region.id" class="parallel-region"><div class="region-heading"><button @click="focusRegion(region)">定位区域 {{index+1}}</button><span>{{region.indices.length.toLocaleString()}} 个体素</span></div>
          <div v-for="annotation in region.annotations" :key="annotation.id" :class="['parallel-annotation',{highlighted:highlightAnnotation===annotation.id}]"><button class="parallel-choice" @click="focusRegion(region,annotation.id)"><strong>{{annotation.name}}</strong><span>{{labelSummary(annotation)}} · {{annotation.values.length}} 个体素</span></button></div>
        </article>
      </div>
      <details v-if="history.length" class="collaboration-history" :open="historyExpanded" @toggle="historyExpanded=($event.target as HTMLDetailsElement).open"><summary>操作记录与版本 · 最近 {{history.length}} 条</summary><ol><li v-for="entry in history" :key="entry.revision"><span><strong>{{entry.name||'作者未记录'}}</strong> · {{actionName(entry.kind)}} · 修订 {{entry.revision}}</span><time :datetime="entry.time">{{fullTime(entry.time)}}</time><button :disabled="!!queueCount||exiting" @click="viewHistory(entry.revision)">查看此版本</button></li></ol></details>
    </template>
    </div>
    <p v-if="error" class="collaboration-error" role="alert">{{error}}</p><p v-if="cacheError" class="collaboration-error" role="alert">{{cacheError}}</p><p v-if="exitNotice" role="status">{{exitNotice}}</p>
    </div>
    <div v-if="sidebar&&(!drawerOpen||maximized)&&sidebarNotice" class="drawer-collapsed-notice" role="alert"><p>{{sidebarNotice}}</p><button @click="drawerOpen=true;$emit('reveal')">查看协作状态</button></div>
    <dialog ref="exitDialog" class="dataset-dialog exit-dialog" aria-labelledby="exit-title" @cancel.prevent="!exiting&&(exitBlocked=false)"><h2 id="exit-title">{{exiting?'正在同步操作':'操作尚未全部上传'}}</h2><p v-if="exiting">正在缓存本地副本并提交剩余操作，请稍候…</p><template v-else><p>可以等待网络恢复，也可保留本地副本与待上传操作后暂时退出。</p><p class="collaboration-error">{{error}}</p><div class="exit-actions"><button @click="exitBlocked=false">继续工作</button><button @click="retryFinish">重试同步并退出</button><button class="primary" :disabled="!!cacheError" @click="forceLocalExit">保留本地缓存并退出</button></div></template></dialog>
  </section>
</template>
