<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import SliceView from './SliceView.vue';
import UiIcon from './UiIcon.vue';
import AuthView from './AuthView.vue';
import ConsoleView from './ConsoleView.vue';
import CollaborationPanel from './CollaborationPanel.vue';
import LocalDrafts from './LocalDrafts.vue';
import TransferProgress from './TransferProgress.vue';
import { useEditor } from './useEditor.ts';
import { useCollaboration } from './useCollaboration.ts';
import { indexOf } from './core.ts';
import type { Axis } from './core.ts';
import {slicePageIndex} from './sliceGeometry.ts';
import type { Tool } from './view.ts';
import { download,inputValue,fileFingerprints,direction } from './view.ts';
import {cacheDataset,readDataset} from './localCache.ts';
import {api,authUser,downloadBlobAuthenticated,loadCurrentUser} from './api.ts';
import type {AuthUser,Dataset,TransferProgress as TransferState} from './api.ts';
const editor=useEditor();
const {airCache,zooms,volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,viewBusy:busy,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,hoverPreview,regionWidth,regionMode,selectRegion,canReplace,load,startStroke,endStroke,stroke,runThreshold,undo,loadSegmentation}=editor;
const collaboration=useCollaboration(editor);
const {active:collaborating,queueCount,unsaved,showDrafts,drafts,parallelMap,project}=collaboration;
const checkingAuth=ref(true),inEditor=ref(false),shellError=ref(''),closing=ref(false),currentDataset=ref<Dataset|null>(null);
const datasetId=ref<string|null>(null);
const openingProgress=ref<TransferState|null>(null),openingStage=ref(''),openingName=ref(''),openingCancellable=ref(false);
let openingController:AbortController|null=null;
const exportProgress=ref<TransferState|null>(null),exporting=ref(false);
let exportController:AbortController|null=null;
let loadedFingerprint:string|undefined;
const datasetOpening=ref(false),editingBlocked=computed(()=>!authUser.value||!inEditor.value||authUser.value.role!=='worker'||!collaboration.canWrite.value||busy.value||datasetOpening.value||!!datasetId.value&&!collaborating.value);
watch(editingBlocked,value=>{editor.editLocked.value=value;},{immediate:true});
watch(authUser,(user,previous)=>{if(previous&&previous.id!==user?.id){inEditor.value=false;datasetId.value=null;currentDataset.value=null;showDrafts.value=false;}});
const segInput=ref<HTMLInputElement|null>(null);
const tools:{id:Tool;icon:string;label:string}[]=[{id:'paint',icon:'✎',label:'画笔'},{id:'erase',icon:'▱',label:'橡皮擦'},{id:'threshold',icon:'◒',label:'阈值'},{id:'region',icon:'◌',label:'灰度分区'}];
const axes:Axis[]=[2,1,0];
const activeAxis=ref<Axis>(2),primaryAxis=ref<Axis>(2),viewLayout=ref<'single'|'focus'|'columns'>('single');
const maximizedAxis=ref<Axis|null>(null);
const labelsMedia=window.matchMedia('(min-width: 1000px)');
const labelsExpanded=ref(labelsMedia.matches),navigationOpen=ref(false);
const touchMedia=window.matchMedia('(any-pointer: coarse)'),touchEnabled=ref(touchMedia.matches);
const touchMode=ref<'slice'|'paint'|'pan'|'window'>('slice');
const touchModes=[{id:'slice' as const,label:'翻片',icon:'layers'},{id:'paint' as const,label:'标注',icon:'brush'},{id:'pan' as const,label:'平移',icon:'hand'},{id:'window' as const,label:'调窗',icon:'sun'}];
const touchHint=computed(()=>touchMode.value==='slice'?'单指上下滑动翻片，轻点查看标注来源':touchMode.value==='pan'?'单指拖动平移影像':touchMode.value==='window'?'单指左右调窗宽、上下调窗位':tool.value==='region'?'按住并拖动预览灰度区域，抬起加入当前标签':tool.value==='threshold'?'在标签面板设置范围后应用阈值':'单指拖动画笔或橡皮，使用撤销恢复');
function detectTouch(event:PointerEvent){if(event.pointerType==='touch')touchEnabled.value=true;}
function updateTouchMedia(event:MediaQueryListEvent){touchEnabled.value=event.matches||navigator.maxTouchPoints>0;}
function chooseTool(next:Tool){tool.value=next;if(touchEnabled.value){touchMode.value='paint';if(next==='threshold')labelsExpanded.value=true;}}
watch(labelsExpanded,value=>{if(value&&touchEnabled.value)navigationOpen.value=false;});
watch(navigationOpen,value=>{if(value&&touchEnabled.value)labelsExpanded.value=false;});
watch(editingBlocked,value=>{if(value&&touchMode.value==='paint')touchMode.value='slice';});
function updateLabelsForViewport(event:MediaQueryListEvent){labelsExpanded.value=event.matches;}
const navigationItems=ref<Dataset[]>([]),navigationLoading=ref(false),navigationError=ref('');
const navigationCases=computed(()=>navigationItems.value.filter(item=>item.id===datasetId.value||item.status!=='unassigned'));
const navigationIndex=computed(()=>navigationCases.value.findIndex(item=>item.id===datasetId.value));
const axisOptions=[{axis:2 as Axis,name:'轴位'},{axis:1 as Axis,name:'冠状位'},{axis:0 as Axis,name:'矢状位'}];
const currentPlane=computed(()=>volume.value?direction(volume.value,activeAxis.value):'轴位');
const activeSlicePage=ref('1');
function resetActiveSlicePage(){activeSlicePage.value=String(point.value[activeAxis.value]+1);}
function commitActiveSlicePage(){const index=slicePageIndex(activeSlicePage.value,volume.value?.dims[activeAxis.value]||0);if(index!==null){const next=[...point.value];next[activeAxis.value]=index;point.value=next;}resetActiveSlicePage();}
watch([()=>point.value[activeAxis.value],activeAxis,volume],resetActiveSlicePage,{flush:'sync'});
const helpOpen=ref(false);
const renamingLabel=ref<number|null>(null),renameValue=ref(''),labelNameInput=ref<HTMLTextAreaElement|null>(null);
const toolIcons:Record<Tool,string>={paint:'brush',erase:'eraser',threshold:'threshold',region:'region'};
const toolShortcuts:Record<Tool,string>={paint:'B',erase:'E',threshold:'',region:'G'};
const liveReady=computed(()=>collaborating.value&&collaboration.connected.value&&!unsaved.value);
const liveLabel=computed(()=>queueCount.value?`待同步 ${queueCount.value} 笔`:unsaved.value?'同步异常':collaboration.connected.value?'已同步':'连接中');
function selectLayout(layout:'single'|'focus'|'columns'){maximizedAxis.value=null;viewLayout.value=layout;if(layout!=='columns')primaryAxis.value=activeAxis.value;}
function selectPlane(axis:Axis){activeAxis.value=axis;primaryAxis.value=axis;maximizedAxis.value=null;viewLayout.value='single';}
function stepSlice(delta:number){if(!volume.value)return;const next=[...point.value];next[activeAxis.value]=Math.max(0,Math.min(volume.value.dims[activeAxis.value]-1,next[activeAxis.value]+delta));point.value=next;}
async function loadNavigation(){if(navigationLoading.value)return;navigationLoading.value=true;navigationError.value='';try{navigationItems.value=(await api<{datasets:Dataset[]}>('/api/datasets')).datasets;}catch(reason){navigationError.value=(reason as Error).message;}finally{navigationLoading.value=false;}}
async function selectCase(id:string){const dataset=navigationCases.value.find(item=>item.id===id);if(dataset&&id!==datasetId.value)await openConsoleDataset(dataset);}
function stepCase(delta:number){const dataset=navigationCases.value[navigationIndex.value+delta];if(dataset)void selectCase(dataset.id);}
watch(navigationOpen,value=>{if(value)void loadNavigation();});
watch(inEditor,value=>{if(value){navigationOpen.value=false;helpOpen.value=false;}});
function focusViewport(axis:Axis){activeAxis.value=axis;maximizedAxis.value=maximizedAxis.value===axis?null:axis;}
function viewportKey(event:KeyboardEvent){
  if(!inEditor.value||!volume.value||event.defaultPrevented||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]'))return;
  if(event.key==='Escape'){if(helpOpen.value){helpOpen.value=false;return;}if(maximizedAxis.value!==null){maximizedAxis.value=null;return;}}
  const target=event.target as HTMLElement|null;
  if(event.code==='Space'&&!event.repeat&&!target?.closest('input,textarea,select,button,summary,[contenteditable="true"],[role="textbox"]')){event.preventDefault();focusViewport(activeAxis.value);}
}
function applyWindowLevel(nextCenter:number,nextWidth:number){if(Number.isFinite(nextCenter)&&Number.isFinite(nextWidth)&&nextWidth>=1){center.value=nextCenter;width.value=nextWidth;}}
watch(volume,()=>{activeAxis.value=2;primaryAxis.value=2;maximizedAxis.value=null;});
async function chooseSegmentation(event:Event){const element=event.target as HTMLInputElement,file=element.files?.[0];element.value='';if(!editingBlocked.value)await loadSegmentation(file);}
async function loadServerResult(){if(!datasetId.value)return false;datasetOpening.value=true;if(openingStage.value)openingStage.value='正在加载团队最新标注…';try{const ok=await collaboration.openProject(datasetId.value);if(!ok)status.value=`团队标注加载失败：${collaboration.error.value}`;return ok;}finally{datasetOpening.value=false;}}
async function openDataset(file:File,id?:string){
  await collaboration.sessionReady;if(collaborating.value&&!await collaboration.switchDataset())return false;
  datasetOpening.value=true;try{
    const cached=id?await readDataset(id):undefined;
    if(openingStage.value)openingStage.value='正在解析影像并准备显示…';
    if(id&&id===datasetId.value&&volume.value&&fileFingerprints.get(file)===loadedFingerprint&&loadedFingerprint)editor.install(volume.value);
    else if(!await load(file,true))throw new Error(status.value||'影像未能打开。');
    loadedFingerprint=fileFingerprints.get(file)||cached?.fingerprint;
    if(id&&(!cached?.fingerprint||cached.fingerprint!==loadedFingerprint)){if(openingStage.value)openingStage.value='正在保存影像缓存…';await cacheDataset(id,file,loadedFingerprint);}
    datasetId.value=id||null;if(id&&collaboration.person.value&&!await loadServerResult())throw new Error(collaboration.error.value||'团队标注未能加载，请重试。');return true;
  }finally{datasetOpening.value=false;}
}
async function showLocal(){await collaboration.reloadDrafts();showDrafts.value=true;}
async function restoreLocal(key:string){if(collaborating.value&&!await collaboration.switchDataset())throw new Error('请先处理当前工作副本。');const id=await collaboration.restoreDraft(key);if(!id)throw new Error(collaboration.error.value||'恢复失败。');datasetId.value=id;inEditor.value=true;}
function addSegment(){if(!editingBlocked.value&&collaborating.value)void collaboration.addLabel();}
function updateLabel(label:typeof segments.value[number]){if(!editingBlocked.value&&collaborating.value)void collaboration.updateLabel(label);}
function beginRename(label:typeof segments.value[number]){if(editingBlocked.value)return;selected.value=label.id;renamingLabel.value=label.id;renameValue.value=label.name;void nextTick(()=>{labelNameInput.value?.focus();labelNameInput.value?.select();});}
function finishRename(label:typeof segments.value[number]){if(renamingLabel.value!==label.id)return;const name=renameValue.value.replace(/[\r\n]+/g,' ').trim();renamingLabel.value=null;if(!editingBlocked.value&&name&&name!==label.name){label.name=name;updateLabel(label);}}
function cancelRename(){renamingLabel.value=null;renameValue.value='';}
function renameKey(event:KeyboardEvent,label:typeof segments.value[number]){if(event.isComposing||event.keyCode===229)return;if(event.key==='Enter'){event.preventDefault();finishRename(label);}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelRename();}}
watch([volume,editingBlocked],cancelRename);
async function exportMask(){
  if(!collaborating.value){await editor.exportMask();return;}
  if(exporting.value)return;exporting.value=true;exportProgress.value=null;exportController=new AbortController();
  try{const ok=await collaboration.exportServer({signal:exportController.signal,onProgress:progress=>{exportProgress.value=progress;}});if(ok)status.value='成果 ZIP 已准备好，正在交给浏览器保存。';}
  finally{exporting.value=false;exportController=null;exportProgress.value=null;}
}
function authenticated(user:AuthUser){authUser.value=user;inEditor.value=false;shellError.value='';}
async function openConsoleDataset(dataset:Dataset){
  if(datasetOpening.value||!authUser.value)return;shellError.value='';datasetOpening.value=true;
  const controller=new AbortController();openingController=controller;openingCancellable.value=true;openingProgress.value=null;openingName.value=dataset.name;openingStage.value='正在检查病例权限与本地缓存…';
  const previous=inEditor.value&&volume.value&&datasetId.value?{id:datasetId.value,dataset:currentDataset.value,volume:volume.value,mask:mask.value,segments:segments.value,fingerprint:loadedFingerprint,point:[...point.value],zooms:[...zooms.value],center:center.value,width:width.value,selected:selected.value,axis:activeAxis.value,primary:primaryAxis.value,layout:viewLayout.value,maximized:maximizedAxis.value}:null;
  let openingImage=false;
  try{
    // Recheck current access and the immutable image fingerprint before using a cached image.
    const datasetPath=`/api/datasets/${encodeURIComponent(dataset.id)}`;
    try{dataset=(await api<{dataset:Dataset}>(datasetPath,{signal:controller.signal})).dataset;}
    catch(reason){if((reason as {status?:number}).status!==404)throw reason;dataset=(await api<{dataset:Dataset}>(`${datasetPath}/status`,{signal:controller.signal})).dataset;}
    const cached=await readDataset(dataset.id);
    controller.signal.throwIfAborted();
    let file:File;
    if(cached?.fingerprint&&cached.fingerprint===dataset.fingerprint&&cached.file.size===dataset.size){file=cached.file;fileFingerprints.set(file,cached.fingerprint);}
    else{
      openingStage.value='正在下载影像…';
      const blob=await downloadBlobAuthenticated(dataset.downloadUrl||`/api/datasets/${encodeURIComponent(dataset.id)}/download`,{signal:controller.signal,onProgress:progress=>{openingProgress.value=progress;}});
      file=new File([blob],dataset.name,{type:'application/octet-stream'});
    }
    controller.signal.throwIfAborted();openingCancellable.value=false;openingController=null;
    openingStage.value=cached?.file===file?'已读取本地缓存，正在准备影像…':'影像下载完成，正在准备影像…';
    openingImage=true;
    if(!await openDataset(file,dataset.id))throw new Error(collaboration.error.value||status.value||'影像未能打开。');
    currentDataset.value=dataset;inEditor.value=true;
  }catch(reason){
    if((reason as Error).name==='AbortError')status.value='已取消影像下载。';else shellError.value=(reason as Error).message;
    if(openingImage&&previous&&(!collaborating.value||datasetId.value!==previous.id||volume.value!==previous.volume)){
      datasetOpening.value=true;volume.value=previous.volume;mask.value=previous.mask;segments.value=previous.segments;datasetId.value=previous.id;currentDataset.value=previous.dataset;loadedFingerprint=previous.fingerprint;revision.value++;
      // Keep the previous image visible if reconnecting fails; openProject rechecks access before enabling edits.
      let restored=false;try{restored=await collaboration.openProject(previous.id);}catch{}
      if(!restored){mask.value=previous.mask;segments.value=previous.segments;shellError.value+=' 原病例已保留为只读，请在实时协作中重新加载任务标注。';}
      await nextTick();point.value=previous.point;zooms.value=previous.zooms;center.value=previous.center;width.value=previous.width;selected.value=segments.value.some(label=>label.id===previous.selected)?previous.selected:segments.value[0]?.id||1;activeAxis.value=previous.axis;primaryAxis.value=previous.primary;viewLayout.value=previous.layout;maximizedAxis.value=previous.maximized;
    }
  }finally{datasetOpening.value=false;openingController=null;openingCancellable.value=false;openingProgress.value=null;openingStage.value='';}
}
async function backToConsole(){if(closing.value)return;closing.value=true;try{if(collaborating.value&&!await collaboration.switchDataset())return;inEditor.value=false;shellError.value='';}finally{closing.value=false;}}
async function logout(){
  if(closing.value)return;closing.value=true;shellError.value='';
  try{if(collaborating.value&&!await collaboration.switchDataset())return;await api('/api/auth/logout',{method:'POST',body:'{}'});authUser.value=null;inEditor.value=false;currentDataset.value=null;datasetId.value=null;editor.volume.value=null;editor.mask.value=new Uint16Array();showDrafts.value=false;}
  catch(reason){shellError.value=(reason as Error).message;}finally{closing.value=false;}
}
onMounted(async()=>{window.addEventListener('keydown',viewportKey);labelsMedia.addEventListener('change',updateLabelsForViewport);touchMedia.addEventListener('change',updateTouchMedia);try{await loadCurrentUser();}catch(reason){shellError.value=(reason as Error).message;}finally{checkingAuth.value=false;}});
onBeforeUnmount(()=>{openingController?.abort();exportController?.abort();window.removeEventListener('keydown',viewportKey);labelsMedia.removeEventListener('change',updateLabelsForViewport);touchMedia.removeEventListener('change',updateTouchMedia);});
function setWindow(event:Event,which:'center'|'width'){const value=Number(inputValue(event));if(!Number.isFinite(value)||(which==='width'&&value<1))return;if(which==='width')width.value=value;else center.value=value;}
function fullWindow(){if(volume.value){center.value=(volume.value.min+volume.value.max)/2;width.value=Math.max(1,volume.value.max-volume.value.min);}}
function setRegionWidth(event:Event){const n=Number(inputValue(event));if(Number.isFinite(n)&&n>=.1)regionWidth.value=n;}
</script>
<template>
  <div v-if="checkingAuth" class="console-loading" role="status">正在验证登录状态…</div>
  <AuthView v-else-if="!authUser" @authenticated="authenticated"/>
  <template v-else>
  <p v-if="shellError" class="console-error shell-error" :class="{'is-editor-error':inEditor}" role="alert"><span>{{shellError}}</span><button v-if="inEditor" aria-label="关闭错误提示" @click="shellError=''">关闭</button></p>
  <ConsoleView v-if="!inEditor" :user="authUser" @open="openConsoleDataset" @logout="logout"/>
  <div v-else class="app workstation" :class="{'is-viewport-maximized':maximizedAxis!==null,'are-labels-open':labelsExpanded,'uses-touch':touchEnabled}" data-testid="annotation-editor" :data-readonly="editingBlocked" :data-touch-mode="touchMode" @pointerdown.capture="detectTouch">
    <header class="topbar"><div class="workstation-brand"><div class="brand">DeepMark<span>影像协作</span></div><div class="workstation-title"><h1>医学影像多人协作标注</h1><span class="workstation-case-name" :title="volume?.name">{{volume?.name||'标注任务'}}</span></div></div>
      <div class="top-actions"><span data-testid="editor-mode" class="workstation-mode">{{authUser.role==='dispatcher'?'派活只读监看':editingBlocked?'只读查看':'干活协同标注'}}</span><span class="workstation-person" :title="authUser.username"><span>{{authUser.name.slice(0,1)}}</span>{{authUser.name}}</span><span class="header-presence"><UiIcon name="users" :size="18"/>{{collaboration.connected.value&&collaboration.presenceKnown.value?`${collaboration.onlineMembers.value.length} 人在线`:'连接中'}}</span><span :class="['workstation-sync',{ready:liveReady,pending:unsaved}]" aria-live="polite"><UiIcon :name="liveReady?'check':'cache'" :size="17"/>{{liveLabel}}</span><button class="workstation-export" :disabled="exporting||!volume||(authUser.role==='dispatcher'&&project?.datasetStatus!=='completed')||(busy&&!editor.readOnly.value)||(collaborating&&(!!queueCount||unsaved))" @click="exportMask"><UiIcon name="export" :size="17"/>{{collaborating&&project?.regions.length?'导出审阅 ZIP':'导出标注 ZIP ↗'}}</button><button class="workstation-logout" :disabled="closing" aria-label="退出登录" title="退出登录" @click="logout"><UiIcon name="logout" :size="18"/></button></div>
    </header>
    <input ref="segInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseSegmentation"/>
    <div class="workspace"><button v-if="touchEnabled&&(labelsExpanded||navigationOpen)" class="touch-panel-backdrop" aria-label="关闭侧边面板" @click="labelsExpanded=false;navigationOpen=false"/>
    <nav class="workstation-rail" aria-label="标注工作区导航"><button data-testid="editor-back" :disabled="closing" title="返回工作台" @click="backToConsole"><UiIcon name="home" :size="25"/><span>工作台</span></button><button :class="{active:labelsExpanded}" :aria-expanded="labelsExpanded" aria-controls="editor-labels" title="标注标签" @click="labelsExpanded=!labelsExpanded"><UiIcon name="tag" :size="24"/><span>标签</span></button><button :class="{active:navigationOpen}" :aria-expanded="navigationOpen" aria-controls="case-navigation-content" title="病例导航" @click="navigationOpen=!navigationOpen"><UiIcon name="folder" :size="25"/><span>病例</span></button><span class="rail-spacer"/><button v-if="authUser.role==='worker'" class="local-cache-button" title="本地工作缓存" @click="showLocal"><UiIcon name="cache" :size="24"/><span>缓存</span></button><button :class="{active:helpOpen}" :aria-expanded="helpOpen" aria-controls="editor-help" title="操作说明" @click="helpOpen=!helpOpen"><UiIcon name="help" :size="25"/><span>帮助</span></button></nav>
    <aside id="editor-labels" class="sidebar" v-show="labelsExpanded">
      <div class="section-heading labels-heading">标注标签<small>{{segments.length}} 个标签</small><button v-if="touchEnabled" class="touch-panel-close" aria-label="收起标签面板" @click="labelsExpanded=false"><UiIcon name="close" :size="20"/></button></div><button class="add-label-button" aria-label="新增标签" :disabled="!volume||editingBlocked||segments.length>=64" @click="addSegment"><UiIcon name="plus" :size="19"/>新建标签</button>
      <div class="segment-list">
        <div v-for="s in segments" :key="s.id" :class="['segment',{selected:selected===s.id}]" :style="{'--segment-color':s.color}" @click="selected=s.id">
          <input v-model="s.color" :disabled="editingBlocked" :aria-label="`${s.name}颜色`" type="color" @change="updateLabel(s)"/>
          <span v-if="renamingLabel===s.id" class="segment-name-editor" @click.stop>
            <span class="segment-name-measure" aria-hidden="true">{{renameValue+' '}}</span>
            <textarea :ref="el=>{if(el)labelNameInput=el as HTMLTextAreaElement}" v-model="renameValue" class="segment-name-input" rows="1" wrap="soft" :disabled="editingBlocked" :aria-label="`标签 ${s.id}名称`" maxlength="60" @blur="finishRename(s)" @keydown="renameKey($event,s)"/>
          </span>
          <span v-else class="segment-name-text" :title="s.name" @click.stop="selected=s.id" @dblclick.stop>{{s.name}}</span>
          <button class="segment-rename" :disabled="editingBlocked" :title="`重命名${s.name}`" :aria-label="`重命名标签 ${s.id}`" @click.stop="beginRename(s)"><UiIcon name="brush" :size="13"/></button>
          <button class="segment-visibility" :title="s.visible?'隐藏标注':'显示标注'" :aria-label="s.visible?'隐藏标注':'显示标注'" @click.stop="s.visible=!s.visible"><UiIcon :name="s.visible?'eye':'eye-off'" :size="23"/></button>
          <small class="segment-creator" :title="s.createdBy?`创建者：${s.createdBy.name}${s.createdAt?` · ${new Date(s.createdAt).toLocaleString()}`:''}`:'此标签的历史创建信息未记录'">创建者：{{s.createdBy?.name||'未记录'}}</small>
        </div>
      </div>
      <label class="range-label">标注透明度<span>{{Math.round(opacity*100)}}%</span><input v-model.number="opacity" type="range" min="0" max="1" step=".05"/></label>
      <div class="section-heading">工具选项<small>{{tools.find(t=>t.id===tool)?.label}}</small></div>
      <div v-if="tool==='threshold'&&volume" class="threshold-panel">
        <div class="section-heading">灰度阈值<small>整套三维影像</small></div><p class="hint">影像灰度范围：{{volume.min.toLocaleString()}} ～ {{volume.max.toLocaleString()}}。使用原始灰度，与窗宽窗位无关。</p>
        <label for="threshold-min">最小灰度</label><input id="threshold-min" type="number" step="any" :value="thresholdMin" @input="thresholdMin=inputValue($event)"/><input aria-label="最小灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(minimum)?Math.max(volume.min,Math.min(volume.max,minimum)):volume.min" @input="thresholdMin=inputValue($event)"/>
        <label for="threshold-max">最大灰度</label><input id="threshold-max" type="number" step="any" :value="thresholdMax" @input="thresholdMax=inputValue($event)"/><input aria-label="最大灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(maximum)?Math.max(volume.min,Math.min(volume.max,maximum)):volume.max" @input="thresholdMax=inputValue($event)"/>
        <p v-if="!thresholdValid" class="field-error" role="alert">请输入有效范围，最小值不能大于最大值。</p><p v-if="!active.visible" class="field-error">请先显示当前标签，再预览或应用。</p>
        <label class="preview-toggle"><input v-model="previewEnabled" type="checkbox"/>预览选区（尚未写入标注）</label><p class="hint">应用后，以此范围替换当前标签；范围内覆盖其他标签，范围外保留其他标签。包含上下限，可一次撤销。</p><button class="primary" :disabled="!thresholdValid||!active.visible||editingBlocked" @click="runThreshold">应用阈值分割</button>
      </div>
      <label v-else class="range-label">画笔直径<span>{{diameter}} {{volume?.unit||'mm'}}</span><input v-model.number="diameter" type="range" min="1" max="50"/></label>
      <div v-if="tool==='region'" class="gray-settings"><label class="preview-toggle"><input v-model="hoverPreview" type="checkbox" :disabled="!volume"/>悬停显示灰度区域轮廓</label><label>分区方式<select v-model="regionMode" aria-label="灰度分区方式" :disabled="!volume"><option value="bands">灰度区间分区</option><option value="level">悬停灰度等值区域</option></select></label><label v-if="regionMode==='bands'">灰度区间宽度<input aria-label="灰度区间宽度" type="number" min=".1" step="1" :value="regionWidth" :disabled="!volume" @input="setRegionWidth"/></label><p class="hint">黄色轮廓仅为预览。选择“灰度分区”，点击轮廓内区域可加入当前标签，仅作用于当前切片。</p></div>
      <div class="section-heading">影像显示<em class="en">DISPLAY</em></div><div class="window-inputs"><label>窗位<input type="number" :disabled="!volume" :value="center" @input="setWindow($event,'center')"/></label><label>窗宽<input type="number" min="1" :disabled="!volume" :value="width" @input="setWindow($event,'width')"/></label></div>
      <div class="presets"><button :disabled="!volume" @click="center=-600;width=1500">肺窗</button><button :disabled="!volume" @click="center=40;width=400">软组织</button><button :disabled="!volume" @click="center=400;width=1800">骨窗</button><button :disabled="!volume" @click="fullWindow">全范围</button></div>
      <div class="sidebar-bottom"><button :disabled="!volume||editingBlocked||collaborating" @click="segInput?.click()">导入已有分割</button><button :disabled="!volume" @click="download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')">导出标签说明</button><div class="shared-state" :class="{'is-warning':!liveReady}"><UiIcon :name="liveReady?'check':'cache'" :size="20"/><span>共享标注 · {{liveReady?'已同步':'正在同步'}}</span></div></div>
    </aside>
    <aside class="case-navigation" :class="{'is-expanded':navigationOpen}" :data-expanded="navigationOpen" data-testid="case-navigation"><header><button :aria-label="`${navigationOpen?'收起':'展开'}病例导航`" :aria-expanded="navigationOpen" aria-controls="case-navigation-content" @click="navigationOpen=!navigationOpen"><strong>病例导航</strong><UiIcon :name="navigationOpen?'down':'chevron'" :size="16"/></button></header><div v-show="navigationOpen" id="case-navigation-content" class="case-navigation-content"><label>当前病例<select aria-label="选择病例" :value="datasetId||''" :disabled="navigationLoading||datasetOpening" @change="selectCase(inputValue($event))"><option v-if="!navigationCases.length" :value="datasetId||''">{{volume?.name||'暂无可切换病例'}}</option><option v-for="item in navigationCases" :key="item.id" :value="item.id">{{item.name}}</option></select></label><div class="case-stepper"><button aria-label="上一病例" :disabled="navigationIndex<=0||datasetOpening" @click="stepCase(-1)"><UiIcon name="back" :size="16"/></button><span>{{Math.max(0,navigationIndex+1)}} / {{navigationCases.length}}</span><button aria-label="下一病例" :disabled="navigationIndex<0||navigationIndex>=navigationCases.length-1||datasetOpening" @click="stepCase(1)"><UiIcon name="chevron" :size="16"/></button></div><p v-if="navigationLoading" class="navigation-hint" role="status">正在加载病例…</p><p v-if="navigationError" class="navigation-error" role="alert">{{navigationError}}<button @click="loadNavigation">重试</button></p><div class="navigation-plane"><span>切面</span><button v-for="option in axisOptions" :key="option.axis" :class="{active:activeAxis===option.axis}" :aria-pressed="activeAxis===option.axis" @click="selectPlane(option.axis)">{{volume?direction(volume,option.axis):option.name}}</button></div><div v-if="volume" class="navigation-slice"><span>切片</span><div class="case-stepper"><button aria-label="上一切片" :disabled="point[activeAxis]<=0" @click="stepSlice(-1)"><UiIcon name="back" :size="16"/></button><span>{{point[activeAxis]+1}} / {{volume.dims[activeAxis]}}</span><button aria-label="下一切片" :disabled="point[activeAxis]>=volume.dims[activeAxis]-1" @click="stepSlice(1)"><UiIcon name="chevron" :size="16"/></button></div></div><dl v-if="volume" class="navigation-metadata"><div><dt>体素尺寸</dt><dd>{{volume.dims.join(' × ')}}</dd></div><div><dt>体素间距</dt><dd>{{volume.spacing.map(n=>+n.toFixed(2)).join(' / ')}} {{volume.unit}}</dd></div></dl></div></aside>
    <div class="viewer-workspace"><main class="viewer-column">
      <div class="editor-toolbar"><div class="tools" role="group" aria-label="标注工具"><button v-for="t in tools" :key="t.id" :aria-label="t.label" :title="`${t.label}${toolShortcuts[t.id]?` · ${toolShortcuts[t.id]}`:''}`" :aria-pressed="tool===t.id" :disabled="!volume||editingBlocked" :class="{active:tool===t.id}" @click="chooseTool(t.id)"><UiIcon :name="toolIcons[t.id]" :size="22"/><span>{{t.label}}</span></button></div><div class="toolbar-history"><button aria-label="撤销" title="撤销 · Ctrl+Z" :disabled="!history.length||editingBlocked" @click="undo()"><UiIcon name="undo" :size="22"/></button><button aria-label="重做" title="重做 · Ctrl+Shift+Z / Ctrl+Y" :disabled="!future.length||editingBlocked" @click="undo(true)"><UiIcon name="redo" :size="22"/></button></div><span class="toolbar-browse-hint" title="中键拖动平移；右键拖动调窗；Ctrl＋右键拖动缩放"><UiIcon name="hand" :size="22"/><UiIcon name="sun" :size="24"/><span>窗宽窗位</span></span><div class="workstation-layout" role="group" aria-label="切面布局"><button :class="{active:viewLayout==='single'}" :aria-pressed="viewLayout==='single'" title="单幅视图" aria-label="单幅视图" @click="selectLayout('single')"><UiIcon name="single" :size="21"/></button><button :class="{active:viewLayout==='focus'}" :aria-pressed="viewLayout==='focus'" title="主视图布局" aria-label="主视图布局" @click="selectLayout('focus')"><UiIcon name="focus" :size="21"/></button><button :class="{active:viewLayout==='columns'}" :aria-pressed="viewLayout==='columns'" title="三列布局" aria-label="三列布局" @click="selectLayout('columns')"><UiIcon name="columns" :size="21"/></button></div></div>
      <div v-if="touchEnabled" class="touch-controls" role="region" aria-label="触屏操作"><div class="touch-mode-buttons" role="group" aria-label="单指操作模式"><button v-for="mode in touchModes" :key="mode.id" :aria-label="`触屏${mode.label}`" :aria-pressed="touchMode===mode.id" :class="{active:touchMode===mode.id}" :disabled="!volume||(mode.id==='paint'&&editingBlocked)" @click="touchMode=mode.id"><UiIcon :name="mode.icon" :size="18"/>{{mode.label}}</button></div><p class="touch-hint">{{touchHint}} · 双指缩放和平移</p></div>
      <div v-if="helpOpen" id="editor-help" class="editor-help" role="region" aria-label="操作说明"><header><strong>操作说明</strong><button @click="helpOpen=false">关闭</button></header><p v-if="touchEnabled">先选择单指模式。双指随时缩放和平移；增加第二指会取消当前未完成笔画。手写笔可直接标注。灰度分区按住预览、抬起选择。</p><p>滚轮翻片 · 中键平移 · 右键调整窗宽窗位 · Ctrl＋右键缩放</p><p>B 画笔 · E 橡皮擦 · G 灰度分区 · Ctrl＋Z 撤销 · Ctrl＋Y 重做</p><p>底部页码可直接输入，Enter 或失焦跳转，Esc 取消。</p><p>双击切面标题或空格切换最大化，Esc 恢复。普通画笔修改当前切片，阈值应用于整套影像。</p></div>
      <p v-if="editingBlocked" data-testid="readonly-notice" class="notice">{{authUser.role==='dispatcher'?'派活账号仅查看实时标注，不能修改标签、画刷、阈值或历史成果。':'当前任务只读，仍可切换切片、调整显示并查看标注来源。'}}</p>
      <template v-if="volume">
        <div v-if="volume.oblique" class="notice">此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。</div>
        <div v-if="thresholdPreview" class="threshold-notice">正在预览阈值 {{minimum.toLocaleString()}} ～ {{maximum.toLocaleString()}} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>
        <div class="views" :data-layout="maximizedAxis===null?viewLayout:'single'" :data-primary-axis="primaryAxis" :data-maximized-axis="maximizedAxis"><SliceView v-for="axis in axes" :key="axis" v-show="maximizedAxis!==null?maximizedAxis===axis:viewLayout!=='single'||primaryAxis===axis" :maximized="maximizedAxis===axis" :volume="volume" :mask="mask" :axis="axis" :point="point" :revision="revision" :segments="segments" :opacity="opacity" :center="center" :width="width" :tool="tool" :diameter="diameter" :threshold-preview="thresholdPreview" :parallel-map="collaborating?parallelMap:undefined" :hover-preview="hoverPreview" :region-width="regionWidth" :region-mode="regionMode" :touch-mode="touchMode" :allow-edit="!editingBlocked" :active="activeAxis===axis" :air-cache="airCache" :zoom="zooms[axis]" :provenance="collaborating?collaboration.provenance:undefined" :provenance-key="`${project?.id}:${project?.revision}:${revision}`" @activate="activeAxis=$event" @focus="focusViewport" @window-level="applyWindowLevel" @zoom="zooms[axis]=$event" @point="point=$event" @start="startStroke" @end="endStroke" @cancel="editor.cancelStroke" @stroke="stroke" @region="selectRegion"/><div v-if="viewLayout==='single'&&maximizedAxis===null" class="image-identification"><strong :title="volume.name">{{volume.name}}</strong><span>{{currentPlane}} · 间距 {{+volume.spacing[activeAxis].toFixed(3)}} {{volume.unit}}</span></div></div>
        <div class="info-bar"><span class="info-case" :title="volume.name">当前病例：{{volume.name}}</span><label class="info-page">切片<input class="slice-page-input" type="number" inputmode="numeric" min="1" :max="volume.dims[activeAxis]" step="1" aria-label="当前切片页码" title="输入切片页码，Enter 或失焦跳转，Esc 取消" :value="activeSlicePage" @input="activeSlicePage=inputValue($event)" @keydown.enter.prevent.stop="commitActiveSlicePage" @keydown.esc.prevent.stop="resetActiveSlicePage" @blur="commitActiveSlicePage"/><span>/ {{volume.dims[activeAxis]}}</span></label><span class="info-sync" :class="{ready:liveReady}"><UiIcon :name="liveReady?'check':'cache'" :size="18"/>{{liveReady?'所有更改已同步':liveLabel}}</span><span class="info-voxel">灰度 {{volume.data[indexOf(point,volume.dims)].toFixed(1)}}</span></div>
      </template>
      <div v-else class="empty"><h2>影像尚未加载</h2><p>返回工作台，选择有权限访问的数据集。</p><button @click="backToConsole">返回工作台</button></div>
    </main><CollaborationPanel :dataset-id="datasetId" :collaboration="collaboration" sidebar compact :maximized="maximizedAxis!==null" @reload="loadServerResult" @reveal="maximizedAxis=null"/></div></div>
    <footer class="statusbar"><span role="status" :class="{'is-busy':editor.busy.value}">{{editor.busy.value?'◌ ':''}}{{status}}</span><span>标注原型 · 请核对导出结果</span></footer><div v-if="editor.busy.value||datasetOpening" class="busy-overlay" aria-live="polite"><TransferProgress v-if="datasetOpening&&openingStage" class="opening-transfer" :title="openingName" :progress="openingProgress" :stage="editor.busy.value?status:openingStage" :cancellable="openingCancellable" @cancel="openingController?.abort()"/><span v-else class="busy-card">{{editor.busy.value?status:'正在加载团队最新标注…'}}</span></div>
    <LocalDrafts v-if="showDrafts" :drafts="drafts" :restore="restoreLocal" @close="showDrafts=false"/>
  </div>
  </template>
  <div v-if="datasetOpening&&!inEditor" class="busy-overlay" role="status"><TransferProgress class="opening-transfer" :title="openingName||'打开影像'" :progress="openingProgress" :stage="editor.busy.value?status:openingStage" :cancellable="openingCancellable" @cancel="openingController?.abort()"/></div>
  <div v-if="exporting" class="export-transfer"><TransferProgress title="下载标注成果 ZIP" :progress="exportProgress" :stage="exportProgress?'正在下载成果…':'正在生成成果文件，等待服务器响应…'" cancellable @cancel="exportController?.abort()"/></div>
</template>
<style scoped>
.opening-transfer{width:min(460px,calc(100vw - 32px));box-shadow:0 12px 40px #173c3726}
.export-transfer{position:fixed;right:max(18px,env(safe-area-inset-right));bottom:max(32px,env(safe-area-inset-bottom));z-index:45;width:min(430px,calc(100vw - 32px));box-shadow:0 8px 32px #173c3726;border-radius:6px}
</style>
