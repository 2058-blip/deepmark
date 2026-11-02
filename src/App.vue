<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import SliceView from './SliceView.vue';
import UiIcon from './UiIcon.vue';
import AuthView from './AuthView.vue';
import ConsoleView from './ConsoleView.vue';
import CollaborationPanel from './CollaborationPanel.vue';
import LocalDrafts from './LocalDrafts.vue';
import { useEditor } from './useEditor.ts';
import { useCollaboration } from './useCollaboration.ts';
import { indexOf } from './core.ts';
import type { Axis } from './core.ts';
import type { Tool } from './view.ts';
import { download,inputValue,fileFingerprints } from './view.ts';
import {cacheDataset,readDataset} from './localCache.ts';
import {api,authUser,authenticatedFetch,loadCurrentUser,responseError} from './api.ts';
import type {AuthUser,Dataset} from './api.ts';
const editor=useEditor();
const {excludeAir,airThreshold,airCache,zooms,volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,viewBusy:busy,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,hoverPreview,regionWidth,regionMode,selectRegion,canReplace,load,startStroke,endStroke,stroke,runThreshold,undo,loadSegmentation}=editor;
const collaboration=useCollaboration(editor);
const {active:collaborating,queueCount,unsaved,showDrafts,drafts,parallelMap,project}=collaboration;
const checkingAuth=ref(true),inEditor=ref(false),shellError=ref(''),closing=ref(false),currentDataset=ref<Dataset|null>(null);
const datasetId=ref<string|null>(null);
let loadedFingerprint:string|undefined;
const datasetOpening=ref(false),editingBlocked=computed(()=>!authUser.value||!inEditor.value||authUser.value.role!=='worker'||!collaboration.canWrite.value||busy.value||datasetOpening.value||!!datasetId.value&&!collaborating.value);
watch(editingBlocked,value=>{editor.editLocked.value=value;},{immediate:true});
watch(authUser,(user,previous)=>{if(previous&&previous.id!==user?.id){inEditor.value=false;datasetId.value=null;currentDataset.value=null;showDrafts.value=false;}});
const segInput=ref<HTMLInputElement|null>(null);
const tools:{id:Tool;icon:string;label:string}[]=[{id:'paint',icon:'✎',label:'画笔'},{id:'erase',icon:'▱',label:'橡皮擦'},{id:'threshold',icon:'◒',label:'阈值'},{id:'region',icon:'◌',label:'灰度分区'}];
const axes:Axis[]=[2,1,0];
const activeAxis=ref<Axis>(2),primaryAxis=ref<Axis>(2),viewLayout=ref<'focus'|'columns'>('focus');
const maximizedAxis=ref<Axis|null>(null);
const renamingLabel=ref<number|null>(null),renameValue=ref(''),labelNameInput=ref<HTMLTextAreaElement|null>(null);
const toolIcons:Record<Tool,string>={paint:'brush',erase:'eraser',threshold:'threshold',region:'region'};
const toolShortcuts:Record<Tool,string>={paint:'B',erase:'E',threshold:'',region:'G'};
const liveReady=computed(()=>collaborating.value&&collaboration.connected.value&&!unsaved.value);
const liveLabel=computed(()=>queueCount.value?`待同步 ${queueCount.value} 笔`:unsaved.value?'同步异常':collaboration.connected.value?'已同步':'连接中');
function selectLayout(layout:'focus'|'columns'){maximizedAxis.value=null;viewLayout.value=layout;if(layout==='focus')primaryAxis.value=activeAxis.value;}
function focusViewport(axis:Axis){activeAxis.value=axis;maximizedAxis.value=maximizedAxis.value===axis?null:axis;}
function viewportKey(event:KeyboardEvent){
  if(!inEditor.value||!volume.value||event.defaultPrevented||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]'))return;
  if(event.key==='Escape'&&maximizedAxis.value!==null){maximizedAxis.value=null;return;}
  const target=event.target as HTMLElement|null;
  if(event.code==='Space'&&!event.repeat&&!target?.closest('input,textarea,select,button,summary,[contenteditable="true"],[role="textbox"]')){event.preventDefault();focusViewport(activeAxis.value);}
}
function applyWindowLevel(nextCenter:number,nextWidth:number){if(Number.isFinite(nextCenter)&&Number.isFinite(nextWidth)&&nextWidth>=1){center.value=nextCenter;width.value=nextWidth;}}
watch(volume,()=>{activeAxis.value=2;primaryAxis.value=2;maximizedAxis.value=null;});
async function chooseSegmentation(event:Event){const element=event.target as HTMLInputElement,file=element.files?.[0];element.value='';if(!editingBlocked.value)await loadSegmentation(file);}
async function loadServerResult(){if(!datasetId.value)return false;datasetOpening.value=true;try{const ok=await collaboration.openProject(datasetId.value);if(!ok)status.value=`团队标注加载失败：${collaboration.error.value}`;return ok;}finally{datasetOpening.value=false;}}
async function openDataset(file:File,id?:string){
  await collaboration.sessionReady;if(collaborating.value&&!await collaboration.switchDataset())return false;
  datasetOpening.value=true;try{
    const cached=id?await readDataset(id):undefined;
    if(id&&id===datasetId.value&&volume.value&&fileFingerprints.get(file)===loadedFingerprint&&loadedFingerprint)editor.install(volume.value);
    else if(!await load(file,true))throw new Error(status.value||'影像未能打开。');
    loadedFingerprint=fileFingerprints.get(file)||cached?.fingerprint;
    if(id&&(!cached?.fingerprint||cached.fingerprint!==loadedFingerprint))await cacheDataset(id,file,loadedFingerprint);
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
function exportMask(){if(collaborating.value)collaboration.exportServer();else editor.exportMask();}
function authenticated(user:AuthUser){authUser.value=user;inEditor.value=false;shellError.value='';}
async function openConsoleDataset(dataset:Dataset){
  if(datasetOpening.value||!authUser.value)return;shellError.value='';datasetOpening.value=true;
  try{
    if(collaborating.value&&!await collaboration.switchDataset())throw new Error('请先同步或保留当前工作副本。');
    // Recheck current access and the immutable image fingerprint before using a cached image.
    const {dataset:latest}=await api<{dataset:Dataset}>(`/api/datasets/${encodeURIComponent(dataset.id)}`);
    dataset=latest;
    const cached=await readDataset(dataset.id);
    let file:File;
    if(cached?.fingerprint&&cached.fingerprint===dataset.fingerprint&&cached.file.size===dataset.size){file=cached.file;fileFingerprints.set(file,cached.fingerprint);}
    else{
      const response=await authenticatedFetch(dataset.downloadUrl||`/api/datasets/${encodeURIComponent(dataset.id)}/download`);if(!response.ok)throw await responseError(response);
      file=new File([await response.blob()],dataset.name,{type:'application/octet-stream'});
    }
    if(!await openDataset(file,dataset.id))throw new Error(collaboration.error.value||status.value||'影像未能打开。');
    currentDataset.value=dataset;inEditor.value=true;
  }catch(reason){shellError.value=(reason as Error).message;}finally{datasetOpening.value=false;}
}
async function backToConsole(){if(closing.value)return;closing.value=true;try{if(collaborating.value&&!await collaboration.switchDataset())return;inEditor.value=false;shellError.value='';}finally{closing.value=false;}}
async function logout(){
  if(closing.value)return;closing.value=true;shellError.value='';
  try{if(collaborating.value&&!await collaboration.switchDataset())return;await api('/api/auth/logout',{method:'POST',body:'{}'});authUser.value=null;inEditor.value=false;currentDataset.value=null;datasetId.value=null;editor.volume.value=null;editor.mask.value=new Uint16Array();showDrafts.value=false;}
  catch(reason){shellError.value=(reason as Error).message;}finally{closing.value=false;}
}
onMounted(async()=>{window.addEventListener('keydown',viewportKey);try{await loadCurrentUser();}catch(reason){shellError.value=(reason as Error).message;}finally{checkingAuth.value=false;}});
onBeforeUnmount(()=>window.removeEventListener('keydown',viewportKey));
function setWindow(event:Event,which:'center'|'width'){const value=Number(inputValue(event));if(!Number.isFinite(value)||(which==='width'&&value<1))return;if(which==='width')width.value=value;else center.value=value;}
function fullWindow(){if(volume.value){center.value=(volume.value.min+volume.value.max)/2;width.value=Math.max(1,volume.value.max-volume.value.min);}}
function setAirThreshold(event:Event){const raw=inputValue(event);const n=Number(raw);if(raw.trim()!==''&&Number.isFinite(n))airThreshold.value=n;}
function setRegionWidth(event:Event){const n=Number(inputValue(event));if(Number.isFinite(n)&&n>=.1)regionWidth.value=n;}
</script>
<template>
  <div v-if="checkingAuth" class="console-loading" role="status">正在验证登录状态…</div>
  <AuthView v-else-if="!authUser" @authenticated="authenticated"/>
  <template v-else>
  <p v-if="shellError" class="console-error shell-error" role="alert">{{shellError}}</p>
  <ConsoleView v-if="!inEditor" :user="authUser" @open="openConsoleDataset" @logout="logout"/>
  <div v-else class="app workstation" :class="{'is-viewport-maximized':maximizedAxis!==null}" data-testid="annotation-editor" :data-readonly="editingBlocked">
    <header class="topbar"><div class="workstation-brand"><div class="brand"><div class="brand-icon"><UiIcon name="plus" :size="23"/></div><span>Deepmark</span></div><nav class="workstation-breadcrumb" aria-label="当前位置"><button data-testid="editor-back" :disabled="closing" @click="backToConsole"><UiIcon name="back" :size="14"/>返回工作台</button><UiIcon name="chevron" :size="13"/><span :title="volume?.name">{{volume?.name||'标注任务'}}</span></nav></div>
      <div class="top-actions"><span data-testid="editor-mode" class="workstation-mode">{{authUser.role==='dispatcher'?'派活只读监看':editingBlocked?'只读查看':'干活协同标注'}}</span><span class="workstation-person" :title="authUser.username"><span>{{authUser.name.slice(0,1)}}</span>{{authUser.name}}</span><span :class="['workstation-sync',{ready:liveReady,pending:unsaved}]" aria-live="polite"><UiIcon v-if="liveReady" name="check" :size="13"/><i v-else/>{{liveLabel}}</span><button v-if="authUser.role==='worker'" class="local-cache-button" @click="showLocal"><UiIcon name="cache" :size="14"/>本地工作缓存</button><button class="primary workstation-export" :disabled="!volume||(authUser.role==='dispatcher'&&project?.datasetStatus!=='completed')||(busy&&!editor.readOnly.value)||(collaborating&&(!!queueCount||unsaved))" @click="exportMask"><UiIcon name="export" :size="15"/>{{collaborating&&project?.regions.length?'导出审阅 ZIP':'导出标注 ZIP ↗'}}</button><button class="workstation-logout" :disabled="closing" @click="logout"><UiIcon name="logout" :size="14"/>退出登录</button></div>
    </header>
    <input ref="segInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseSegmentation"/>
    <div class="workspace"><aside class="sidebar">
      <div class="section-heading">工作空间<em class="en">WORKSPACE</em></div>
      <div class="file-card"><span class="eyebrow">当前影像</span><strong :title="volume?.name">{{volume?.name||'尚未加载影像'}}</strong><small>{{volume?`${volume.dims.join(' × ')} · ${volume.spacing.map(n=>+n.toFixed(3)).join(' / ')} 间距`:'支持 .nii / .nii.gz'}}</small></div>
      <div class="section-heading">分割标签<em class="en">LABELS</em><button aria-label="新增标签" :disabled="!volume||editingBlocked||segments.length>=64" @click="addSegment">＋</button></div>
      <div class="segment-list">
        <div v-for="s in segments" :key="s.id" :class="['segment',{selected:selected===s.id}]" :style="{'--segment-color':s.color}" @click="selected=s.id">
          <input v-model="s.color" :disabled="editingBlocked" :aria-label="`${s.name}颜色`" type="color" @change="updateLabel(s)"/>
          <span v-if="renamingLabel===s.id" class="segment-name-editor" @click.stop>
            <span class="segment-name-measure" aria-hidden="true">{{renameValue+' '}}</span>
            <textarea :ref="el=>{if(el)labelNameInput=el as HTMLTextAreaElement}" v-model="renameValue" class="segment-name-input" rows="1" wrap="soft" :disabled="editingBlocked" :aria-label="`标签 ${s.id}名称`" maxlength="60" @blur="finishRename(s)" @keydown="renameKey($event,s)"/>
          </span>
          <span v-else class="segment-name-text" :title="s.name" @click.stop="selected=s.id" @dblclick.stop>{{s.name}}</span>
          <button class="segment-rename" :disabled="editingBlocked" :title="`重命名${s.name}`" :aria-label="`重命名标签 ${s.id}`" @click.stop="beginRename(s)"><UiIcon name="brush" :size="13"/></button>
          <button :title="s.visible?'隐藏标注':'显示标注'" :aria-label="s.visible?'隐藏标注':'显示标注'" @click.stop="s.visible=!s.visible">{{s.visible?'◉':'○'}}</button>
          <small class="segment-creator" :title="s.createdBy?`创建者：${s.createdBy.name}${s.createdAt?` · ${new Date(s.createdAt).toLocaleString()}`:''}`:'此标签的历史创建信息未记录'">创建者：{{s.createdBy?.name||'未记录'}}</small>
        </div>
      </div>
      <label class="range-label">标注透明度<span>{{Math.round(opacity*100)}}%</span><input v-model.number="opacity" type="range" min="0" max="1" step=".05"/></label>
      <div class="section-heading">标注工具<em class="en">TOOLS</em><small>B / E / G</small></div>
      <div class="tools"><button v-for="t in tools" :key="t.id" :aria-label="t.label" :title="`${t.label}${toolShortcuts[t.id]?` · ${toolShortcuts[t.id]}`:''}`" :aria-pressed="tool===t.id" :disabled="!volume||editingBlocked" :class="{active:tool===t.id}" @click="tool=t.id"><UiIcon :name="toolIcons[t.id]" :size="21"/><span>{{t.label}}</span></button></div>
      <div v-if="tool==='threshold'&&volume" class="threshold-panel">
        <div class="section-heading">灰度阈值<small>整套三维影像</small></div><p class="hint">影像灰度范围：{{volume.min.toLocaleString()}} ～ {{volume.max.toLocaleString()}}。使用原始灰度，与窗宽窗位无关。</p>
        <label for="threshold-min">最小灰度</label><input id="threshold-min" type="number" step="any" :value="thresholdMin" @input="thresholdMin=inputValue($event)"/><input aria-label="最小灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(minimum)?Math.max(volume.min,Math.min(volume.max,minimum)):volume.min" @input="thresholdMin=inputValue($event)"/>
        <label for="threshold-max">最大灰度</label><input id="threshold-max" type="number" step="any" :value="thresholdMax" @input="thresholdMax=inputValue($event)"/><input aria-label="最大灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(maximum)?Math.max(volume.min,Math.min(volume.max,maximum)):volume.max" @input="thresholdMax=inputValue($event)"/>
        <p v-if="!thresholdValid" class="field-error" role="alert">请输入有效范围，最小值不能大于最大值。</p><p v-if="!active.visible" class="field-error">请先显示当前标签，再预览或应用。</p>
        <label class="preview-toggle"><input v-model="previewEnabled" type="checkbox"/>预览选区（尚未写入标注）</label><p class="hint">应用后，以此范围替换当前标签；范围内覆盖其他标签，范围外保留其他标签。包含上下限，可一次撤销。</p><button class="primary" :disabled="!thresholdValid||!active.visible||editingBlocked" @click="runThreshold">应用阈值分割</button>
      </div>
      <template v-else><label class="range-label">画笔直径<span>{{diameter}} {{volume?.unit||'mm'}}</span><input v-model.number="diameter" type="range" min="1" max="50"/></label><p class="hint">{{collaborating?'同一区域修改会保留他人意见；橡皮只删除自己在当前标签中的标注。':'画笔覆盖其他标签；橡皮只擦除当前标签。'}}先显示当前标签，再进行编辑。</p></template>
      <div class="gray-settings"><label class="preview-toggle"><input v-model="excludeAir" type="checkbox"/>排除外围空气</label><label v-if="excludeAir">空气上限<input aria-label="空气上限" type="number" :value="airThreshold" @input="setAirThreshold($event)"/></label><p class="hint">排除与当前切片边界连通的低灰度空气，保留内部气腔。阈值分割按原始 K 平面逐层识别；已有标注保留，仍可擦除。</p></div>
      <div class="gray-settings"><label class="preview-toggle"><input v-model="hoverPreview" type="checkbox" :disabled="!volume"/>悬停显示灰度区域轮廓</label><label>分区方式<select v-model="regionMode" aria-label="灰度分区方式" :disabled="!volume"><option value="bands">灰度区间分区</option><option value="level">悬停灰度等值区域</option></select></label><label v-if="regionMode==='bands'">灰度区间宽度<input aria-label="灰度区间宽度" type="number" min=".1" step="1" :value="regionWidth" :disabled="!volume" @input="setRegionWidth"/></label><p class="hint">黄色轮廓仅为预览。选择“灰度分区”，点击轮廓内区域可加入当前标签，仅作用于当前切片。</p></div>
      <div class="history"><button title="撤销 · Ctrl+Z" :disabled="!history.length||editingBlocked" @click="undo()"><UiIcon name="undo" :size="14"/>↶ 撤销</button><button title="重做 · Ctrl+Shift+Z / Ctrl+Y" :disabled="!future.length||editingBlocked" @click="undo(true)"><UiIcon name="redo" :size="14"/>↷ 重做</button></div>
      <div class="section-heading">影像显示<em class="en">DISPLAY</em></div><div class="window-inputs"><label>窗位<input type="number" :disabled="!volume" :value="center" @input="setWindow($event,'center')"/></label><label>窗宽<input type="number" min="1" :disabled="!volume" :value="width" @input="setWindow($event,'width')"/></label></div>
      <div class="presets"><button :disabled="!volume" @click="center=-600;width=1500">肺窗</button><button :disabled="!volume" @click="center=40;width=400">软组织</button><button :disabled="!volume" @click="center=400;width=1800">骨窗</button><button :disabled="!volume" @click="fullWindow">全范围</button></div>
      <div class="sidebar-bottom"><button :disabled="!volume||editingBlocked||collaborating" @click="segInput?.click()">导入已有分割</button><button :disabled="!volume" @click="download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')">导出标签说明</button></div>
    </aside><main>
      <div class="main-heading"><div class="workstation-heading"><h1>{{volume?'标注工作台':'从一份影像开始'}}</h1><span :class="['state',{'is-dirty':dirty,'is-ready':!!volume&&!dirty}]">{{dirty?'● 有未导出的修改':volume?'● 就绪':'等待导入'}}</span></div><div class="workstation-view-actions"><details class="viewer-help"><summary><UiIcon name="help" :size="15"/>操作说明</summary><div><strong>影像浏览</strong><p>滚轮：逐层浏览切片</p><p>右键拖动：调整窗宽、窗位</p><p>中键拖动：平移影像</p><p>Ctrl＋右键上下拖动：缩放</p><p>点击百分比：重置缩放和平移</p><p>双击切面标题或空格：最大化 / 恢复；Esc 恢复多视图</p><strong>分割标注</strong><p>先选标签，再用左键执行当前工具</p><p>B 画笔 · E 橡皮擦 · G 灰度分区</p><p>Ctrl＋Z 撤销 · Ctrl＋Y 重做</p><p>普通画笔修改当前切片；阈值应用于整套影像。橡皮只删除自己的标注。</p></div></details><div class="workstation-layout" role="group" aria-label="切面布局"><button :class="{active:viewLayout==='focus'}" :aria-pressed="viewLayout==='focus'" title="主视图布局" aria-label="主视图布局" @click="selectLayout('focus')"><UiIcon name="focus" :size="16"/></button><button :class="{active:viewLayout==='columns'}" :aria-pressed="viewLayout==='columns'" title="三列布局" aria-label="三列布局" @click="selectLayout('columns')"><UiIcon name="columns" :size="16"/></button></div></div></div>
      <CollaborationPanel :dataset-id="datasetId" :collaboration="collaboration" compact @reload="loadServerResult"/>
      <p v-if="editingBlocked" data-testid="readonly-notice" class="notice">{{authUser.role==='dispatcher'?'派活账号仅查看实时标注，不能修改标签、画刷、阈值或历史成果。':'当前任务只读，仍可切换切片、调整显示并查看标注来源。'}}</p>
      <template v-if="volume">
        <div v-if="volume.oblique" class="notice">此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。</div>
        <div v-if="thresholdPreview" class="threshold-notice">正在预览阈值 {{minimum.toLocaleString()}} ～ {{maximum.toLocaleString()}} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>
        <div class="views" :data-layout="maximizedAxis===null?viewLayout:'single'" :data-primary-axis="primaryAxis" :data-maximized-axis="maximizedAxis"><SliceView v-for="axis in axes" :key="axis" v-show="maximizedAxis===null||maximizedAxis===axis" :maximized="maximizedAxis===axis" :volume="volume" :mask="mask" :axis="axis" :point="point" :revision="revision" :segments="segments" :opacity="opacity" :center="center" :width="width" :tool="tool" :diameter="diameter" :threshold-preview="thresholdPreview" :parallel-map="collaborating?parallelMap:undefined" :hover-preview="hoverPreview" :region-width="regionWidth" :region-mode="regionMode" :allow-edit="!editingBlocked" :active="activeAxis===axis" :air-cache="airCache" :zoom="zooms[axis]" :provenance="collaborating?collaboration.provenance:undefined" :provenance-key="`${project?.id}:${project?.revision}:${revision}`" @activate="activeAxis=$event" @focus="focusViewport" @window-level="applyWindowLevel" @zoom="zooms[axis]=$event" @point="point=$event" @start="startStroke" @end="endStroke" @stroke="stroke" @region="selectRegion"/></div>
        <div class="info-bar"><span>当前标签<i :style="{background:active.color}"/>{{active.name}} · 值 {{selected}}</span><span>体素 I {{point[0]+1}} / J {{point[1]+1}} / K {{point[2]+1}}</span><span>灰度 {{volume.data[indexOf(point,volume.dims)].toFixed(1)}}</span></div>
      </template>
      <div v-else class="empty"><h2>影像尚未加载</h2><p>返回工作台，选择有权限访问的数据集。</p><button @click="backToConsole">返回工作台</button></div>
    </main></div>
    <footer class="statusbar"><span role="status" :class="{'is-busy':editor.busy.value}">{{editor.busy.value?'◌ ':''}}{{status}}</span><span>标注原型 · 请核对导出结果</span></footer><div v-if="editor.busy.value||datasetOpening" class="busy-overlay" aria-live="polite"><span class="busy-card">{{editor.busy.value?status:'正在加载团队最新标注…'}}</span></div>
    <LocalDrafts v-if="showDrafts" :drafts="drafts" :restore="restoreLocal" @close="showDrafts=false"/>
  </div>
  </template>
  <div v-if="datasetOpening&&!inEditor" class="busy-overlay" role="status"><span class="busy-card">正在下载影像并加载团队标注…</span></div>
</template>
