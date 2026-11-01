<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import SliceView from './SliceView.vue';
import AuthView from './AuthView.vue';
import ConsoleView from './ConsoleView.vue';
import CollaborationPanel from './CollaborationPanel.vue';
import LocalDrafts from './LocalDrafts.vue';
import { useEditor } from './useEditor.ts';
import { useCollaboration } from './useCollaboration.ts';
import { indexOf } from './core.ts';
import type { Axis } from './core.ts';
import type { Tool } from './view.ts';
import { download,inputValue } from './view.ts';
import {cacheDataset} from './localCache.ts';
import {api,authUser,authenticatedFetch,loadCurrentUser,responseError} from './api.ts';
import type {AuthUser,Dataset} from './api.ts';
const editor=useEditor();
const {excludeAir,airThreshold,airCache,zooms,volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,viewBusy:busy,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,hoverPreview,regionWidth,regionMode,selectRegion,canReplace,load,startStroke,endStroke,stroke,runThreshold,undo,loadSegmentation}=editor;
const collaboration=useCollaboration(editor);
const {active:collaborating,queueCount,unsaved,showDrafts,drafts,parallelMap,project}=collaboration;
const checkingAuth=ref(true),inEditor=ref(false),shellError=ref(''),closing=ref(false),currentDataset=ref<Dataset|null>(null);
const datasetId=ref<string|null>(null);
const datasetOpening=ref(false),editingBlocked=computed(()=>!authUser.value||!inEditor.value||authUser.value.role!=='worker'||!collaboration.canWrite.value||busy.value||datasetOpening.value||!!datasetId.value&&!collaborating.value);
watch(editingBlocked,value=>{editor.editLocked.value=value;},{immediate:true});
watch(authUser,(user,previous)=>{if(previous&&previous.id!==user?.id){inEditor.value=false;datasetId.value=null;currentDataset.value=null;showDrafts.value=false;}});
const segInput=ref<HTMLInputElement|null>(null);
const tools:{id:Tool;icon:string;label:string}[]=[{id:'paint',icon:'✎',label:'画笔'},{id:'erase',icon:'▱',label:'橡皮擦'},{id:'threshold',icon:'◒',label:'阈值'},{id:'region',icon:'◌',label:'灰度分区'}];
const axes:Axis[]=[2,1,0];
async function chooseSegmentation(event:Event){const element=event.target as HTMLInputElement,file=element.files?.[0];element.value='';if(!editingBlocked.value)await loadSegmentation(file);}
async function loadServerResult(){if(!datasetId.value)return false;datasetOpening.value=true;try{const ok=await collaboration.openProject(datasetId.value);if(!ok)status.value=`团队标注加载失败：${collaboration.error.value}`;return ok;}finally{datasetOpening.value=false;}}
async function openDataset(file:File,id?:string){
  await collaboration.sessionReady;if(collaborating.value&&!await collaboration.switchDataset())return false;
  datasetOpening.value=true;try{if(id)await cacheDataset(id,file);if(!await load(file,true))return false;datasetId.value=id||null;if(id&&collaboration.person.value&&!await loadServerResult())throw new Error(collaboration.error.value||'团队标注未能加载，请重试。');return true;}finally{datasetOpening.value=false;}
}
async function showLocal(){await collaboration.reloadDrafts();showDrafts.value=true;}
async function restoreLocal(key:string){if(collaborating.value&&!await collaboration.switchDataset())throw new Error('请先处理当前工作副本。');const id=await collaboration.restoreDraft(key);if(!id)throw new Error(collaboration.error.value||'恢复失败。');datasetId.value=id;inEditor.value=true;}
function addSegment(){if(!editingBlocked.value&&collaborating.value)void collaboration.addLabel();}
function updateLabel(label:typeof segments.value[number]){if(!editingBlocked.value&&collaborating.value)void collaboration.updateLabel(label);}
function exportMask(){if(collaborating.value)collaboration.exportServer();else editor.exportMask();}
function authenticated(user:AuthUser){authUser.value=user;inEditor.value=false;shellError.value='';}
async function openConsoleDataset(dataset:Dataset){
  if(datasetOpening.value||!authUser.value)return;shellError.value='';datasetOpening.value=true;
  try{
    if(collaborating.value&&!await collaboration.switchDataset())throw new Error('请先同步或保留当前工作副本。');
    const response=await authenticatedFetch(dataset.downloadUrl||`/api/datasets/${encodeURIComponent(dataset.id)}/download`);if(!response.ok)throw await responseError(response);
    const file=new File([await response.blob()],dataset.name,{type:'application/octet-stream'});
    if(!await openDataset(file,dataset.id))throw new Error(collaboration.error.value||'影像未能打开。');
    currentDataset.value=dataset;inEditor.value=true;
  }catch(reason){shellError.value=(reason as Error).message;}finally{datasetOpening.value=false;}
}
async function backToConsole(){if(closing.value)return;closing.value=true;try{if(collaborating.value&&!await collaboration.switchDataset())return;inEditor.value=false;shellError.value='';}finally{closing.value=false;}}
async function logout(){
  if(closing.value)return;closing.value=true;shellError.value='';
  try{if(collaborating.value&&!await collaboration.switchDataset())return;await api('/api/auth/logout',{method:'POST',body:'{}'});authUser.value=null;inEditor.value=false;currentDataset.value=null;datasetId.value=null;editor.volume.value=null;editor.mask.value=new Uint16Array();showDrafts.value=false;}
  catch(reason){shellError.value=(reason as Error).message;}finally{closing.value=false;}
}
onMounted(async()=>{try{await loadCurrentUser();}catch(reason){shellError.value=(reason as Error).message;}finally{checkingAuth.value=false;}});
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
  <div v-else class="app" data-testid="annotation-editor" :data-readonly="editingBlocked">
    <header class="topbar"><div class="brand"><div class="brand-icon">✚</div><div>医学分割标注<small>SLICER WEB · 本地浏览器版</small></div></div>
      <div class="top-actions"><span data-testid="editor-mode" class="local-badge">● {{authUser.role==='dispatcher'?'派活只读监看':editingBlocked?'只读查看':'干活协同标注'}}</span><span>{{authUser.name}}</span><button data-testid="editor-back" :disabled="closing" @click="backToConsole">返回工作台</button><button v-if="authUser.role==='worker'" class="local-cache-button" @click="showLocal">本地工作缓存</button><button class="primary" :disabled="!volume||(authUser.role==='dispatcher'&&project?.datasetStatus!=='completed')||(busy&&!editor.readOnly.value)||(collaborating&&(!!queueCount||unsaved))" @click="exportMask">{{collaborating&&project?.regions.length?'导出审阅 ZIP':'导出标注 ZIP ↗'}}</button><button :disabled="closing" @click="logout">退出登录</button></div>
    </header>
    <input ref="segInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseSegmentation"/>
    <div class="workspace"><aside class="sidebar">
      <div class="section-heading">工作空间<span>01</span></div>
      <div class="file-card"><span class="eyebrow">当前影像</span><strong :title="volume?.name">{{volume?.name||'尚未加载影像'}}</strong><small>{{volume?`${volume.dims.join(' × ')} · ${volume.spacing.map(n=>+n.toFixed(3)).join(' / ')} 间距`:'支持 .nii / .nii.gz'}}</small></div>
      <div class="section-heading">分割标签<button aria-label="新增标签" :disabled="!volume||editingBlocked||segments.length>=64" @click="addSegment">＋</button></div>
      <div class="segment-list"><div v-for="s in segments" :key="s.id" :class="['segment',{selected:selected===s.id}]" @click="selected=s.id"><input v-model="s.color" :disabled="editingBlocked" :aria-label="`${s.name}颜色`" type="color" @change="updateLabel(s)"/><input v-model="s.name" :disabled="editingBlocked" :aria-label="`标签 ${s.id}名称`" maxlength="60" @change="updateLabel(s)"/><button :title="s.visible?'隐藏标注':'显示标注'" :aria-label="s.visible?'隐藏标注':'显示标注'" @click.stop="s.visible=!s.visible">{{s.visible?'◉':'○'}}</button></div></div>
      <label class="range-label">标注透明度<span>{{Math.round(opacity*100)}}%</span><input v-model.number="opacity" type="range" min="0" max="1" step=".05"/></label>
      <div class="section-heading">标注工具<small>B / E / G</small></div>
      <div class="tools"><button v-for="t in tools" :key="t.id" :aria-label="t.label" :disabled="!volume||editingBlocked" :class="{active:tool===t.id}" @click="tool=t.id"><b aria-hidden="true">{{t.icon}}</b>{{t.label}}</button></div>
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
      <div class="history"><button :disabled="!history.length||editingBlocked" @click="undo()">↶ 撤销</button><button :disabled="!future.length||editingBlocked" @click="undo(true)">↷ 重做</button></div>
      <div class="section-heading">影像显示</div><div class="window-inputs"><label>窗位<input type="number" :disabled="!volume" :value="center" @input="setWindow($event,'center')"/></label><label>窗宽<input type="number" min="1" :disabled="!volume" :value="width" @input="setWindow($event,'width')"/></label></div>
      <div class="presets"><button :disabled="!volume" @click="center=40;width=400">软组织</button><button :disabled="!volume" @click="center=400;width=1800">骨窗</button><button :disabled="!volume" @click="fullWindow">全范围</button></div>
      <div class="sidebar-bottom"><button :disabled="!volume||editingBlocked||collaborating" @click="segInput?.click()">导入已有分割</button><button :disabled="!volume" @click="download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')">导出标签说明</button></div>
    </aside><main>
      <div class="main-heading"><div><span class="eyebrow">SEGMENT EDITOR</span><h1>{{volume?'三切面标注':'从一份影像开始'}}</h1></div><span class="state">{{dirty?'● 有未导出的修改':volume?'● 就绪':'等待导入'}}</span></div>
      <CollaborationPanel :dataset-id="datasetId" :collaboration="collaboration" @reload="loadServerResult"/>
      <p v-if="editingBlocked" data-testid="readonly-notice" class="notice">{{authUser.role==='dispatcher'?'派活账号仅查看实时标注，不能修改标签、画刷、阈值或历史成果。':'当前任务只读，仍可切换切片、调整显示并查看标注来源。'}}</p>
      <template v-if="volume">
        <div class="notice">{{volume.oblique?'此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。':'按影像空间方向标注切面与方位，保持原始体素网格。'}} 滚轮切片 · Ctrl + 按住右键上下拖动缩放</div>
        <div v-if="thresholdPreview" class="threshold-notice">正在预览阈值 {{minimum.toLocaleString()}} ～ {{maximum.toLocaleString()}} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>
        <div class="views"><SliceView v-for="axis in axes" :key="axis" :volume="volume" :mask="mask" :axis="axis" :point="point" :revision="revision" :segments="segments" :opacity="opacity" :center="center" :width="width" :tool="tool" :diameter="diameter" :threshold-preview="thresholdPreview" :parallel-map="collaborating?parallelMap:undefined" :hover-preview="hoverPreview" :region-width="regionWidth" :region-mode="regionMode" :allow-edit="!editingBlocked" :air-cache="airCache" :zoom="zooms[axis]" :provenance="collaborating?collaboration.provenance:undefined" :provenance-key="`${project?.id}:${project?.revision}:${revision}`" @zoom="zooms[axis]=$event" @point="point=$event" @start="startStroke" @end="endStroke" @stroke="stroke" @region="selectRegion"/></div>
        <div class="info-bar"><span>当前标签<i :style="{background:active.color}"/>{{active.name}} · 值 {{selected}}</span><span>体素 I {{point[0]+1}} / J {{point[1]+1}} / K {{point[2]+1}}</span><span>灰度 {{volume.data[indexOf(point,volume.dims)].toFixed(1)}}</span></div>
      </template>
      <div v-else class="empty"><h2>影像尚未加载</h2><p>返回工作台，选择有权限访问的数据集。</p><button @click="backToConsole">返回工作台</button></div>
    </main></div>
    <footer class="statusbar"><span role="status">{{editor.busy.value?'◌ ':''}}{{status}}</span><span>标注原型 · 请核对导出结果</span></footer><div v-if="editor.busy.value||datasetOpening" class="busy-overlay" aria-live="polite">{{editor.busy.value?status:'正在加载团队最新标注…'}}</div>
    <LocalDrafts v-if="showDrafts" :drafts="drafts" :restore="restoreLocal" @close="showDrafts=false"/>
  </div>
  </template>
  <div v-if="datasetOpening&&!inEditor" class="busy-overlay" role="status">正在下载影像并加载团队标注…</div>
</template>
