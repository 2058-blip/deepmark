<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SliceView from './SliceView.vue';
import DatasetBrowser from './DatasetBrowser.vue';
import CollaborationPanel from './CollaborationPanel.vue';
import LocalDrafts from './LocalDrafts.vue';
import UiIcon from './UiIcon.vue';
import { useEditor } from './useEditor.ts';
import { useCollaboration } from './useCollaboration.ts';
import { indexOf,makeDemo } from './core.ts';
import type { Axis } from './core.ts';
import type { Tool } from './view.ts';
import { download,inputValue } from './view.ts';
import {cacheDataset} from './localCache.ts';
const editor=useEditor();
const {volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,viewBusy:busy,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,hoverPreview,regionWidth,regionMode,selectRegion,canReplace,load,startStroke,endStroke,stroke,runThreshold,undo,loadSegmentation}=editor;
const collaboration=useCollaboration(editor);
const {active:collaborating,queueCount,unsaved,showDrafts,drafts,parallelMap,project,connected}=collaboration;
const datasetId=ref<string|null>(null);
const fileInput=ref<HTMLInputElement|null>(null),segInput=ref<HTMLInputElement|null>(null);
const tools:{id:Tool;icon:string;label:string;keys?:string}[]=[{id:'paint',icon:'brush',label:'画笔',keys:'B'},{id:'erase',icon:'erase',label:'橡皮擦',keys:'E'},{id:'navigate',icon:'crosshair',label:'定位',keys:'V'},{id:'threshold',icon:'threshold',label:'阈值'},{id:'region',icon:'region',label:'灰度分区',keys:'G'}];
const axes:Axis[]=[2,1,0];
// 纯界面状态：当前激活视图、主视图、面板折叠。不触发切片重算。
const activeAxis=ref<Axis>(2),mainAxis=ref<Axis>(2),collabOpen=ref(true),grayOpen=ref(false);
watch(tool,value=>{if(value==='region')grayOpen.value=true;});
watch(volume,()=>{activeAxis.value=2;mainAxis.value=2;});
const sync=computed(()=>{
  if(!collaborating.value)return {state:'local',text:'本地模式',title:'影像在本机处理；加入协同后操作才会上传。'};
  const who=collaboration.person.value?.name||'';
  if(!connected.value)return {state:'offline',text:queueCount.value?`离线 · ${queueCount.value} 笔待上传`:'离线 · 本地缓存',title:`${who} · 网络断开，编辑保留在本地，恢复后自动续传。`};
  if(queueCount.value)return {state:'pending',text:`待上传 ${queueCount.value} 笔`,title:`${who} · 正在提交本地操作。`};
  if(collaboration.error.value)return {state:'error',text:'同步异常',title:`${who} · ${collaboration.error.value}`};
  return {state:'synced',text:`已同步 · 修订 ${project.value?.revision??'—'}`,title:`${who} · 共享成果已是最新。`};
});
async function chooseFile(event:Event,seg=false){const element=event.target as HTMLInputElement,file=element.files?.[0];element.value='';if(seg)await loadSegmentation(file);else{if(collaborating.value&&!await collaboration.saveAndExit())return;if(await load(file))datasetId.value=null;}}
async function openDataset(file:File,id?:string){if(collaborating.value&&!await collaboration.saveAndExit())return false;if(id)await cacheDataset(id,file);if(!await load(file,true))return false;datasetId.value=id||null;return true;}
async function showLocal(){await collaboration.reloadDrafts();showDrafts.value=true;}
async function restoreLocal(key:string){if(collaborating.value&&!await collaboration.saveAndExit())throw new Error('请先处理当前工作副本。');const id=await collaboration.restoreDraft(key);if(!id)throw new Error(collaboration.error.value||'恢复失败。');datasetId.value=id;}
function addSegment(){if(collaborating.value)void collaboration.addLabel();else editor.addSegment();}
function updateLabel(label:typeof segments.value[number]){if(collaborating.value)void collaboration.updateLabel(label);}
function exportMask(){if(collaborating.value)collaboration.exportServer();else editor.exportMask();}
async function demo(){if(collaborating.value&&!await collaboration.saveAndExit())return;if(canReplace()){datasetId.value=null;editor.install(makeDemo());}}
function setWindow(event:Event,which:'center'|'width'){const value=Number(inputValue(event));if(!Number.isFinite(value)||(which==='width'&&value<1))return;if(which==='width')width.value=value;else center.value=value;}
function fullWindow(){if(volume.value){center.value=(volume.value.min+volume.value.max)/2;width.value=Math.max(1,volume.value.max-volume.value.min);}}
function setRegionWidth(event:Event){const n=Number(inputValue(event));if(Number.isFinite(n)&&n>=.1)regionWidth.value=n;}
</script>
<template>
  <div class="app">
    <header class="topbar">
      <div class="brand"><div class="brand-icon"><UiIcon name="logo"/></div><div>Deepmark<small>医学影像协作标注</small></div></div>
      <div v-if="volume" class="top-file" :title="volume.name">
        <UiIcon name="file"/><strong>{{volume.name}}</strong>
        <small>{{volume.dims.join('×')}} · {{volume.spacing.map(n=>+n.toFixed(2)).join('/')}} {{volume.unit||'mm'}}</small>
        <span v-if="dirty" class="dirty-dot" title="有未导出的修改"/>
      </div>
      <div v-else class="top-file placeholder"><UiIcon name="file"/>尚未加载影像 · 支持 .nii / .nii.gz</div>
      <div class="top-actions">
        <span class="mode-badge" :data-state="sync.state" :title="sync.title"><i aria-hidden="true"/>{{collaborating?'多人协同':'本地编辑'}} · {{sync.text}}</span>
        <button class="local-cache-button" title="查看本浏览器保留的工作副本" @click="showLocal"><UiIcon name="cache"/>本地工作缓存</button>
        <button class="server-library-button" :disabled="busy" title="浏览并下载服务器影像" @click="showDatasets=true"><UiIcon name="server"/>服务器数据集</button>
        <button :disabled="busy" title="打开本机 NIfTI 影像" @click="fileInput?.click()"><UiIcon name="folder"/>打开影像</button>
        <button class="primary" :disabled="!volume||(busy&&!editor.readOnly.value)||(collaborating&&(!!queueCount||unsaved))" :title="collaborating?'打包共享成果与并列意见':'打包分割 NIfTI 与标签说明'" @click="exportMask"><UiIcon name="export"/>{{collaborating&&project?.regions.length?'导出审阅 ZIP':'导出标注 ZIP ↗'}}</button>
      </div>
    </header>
    <input ref="fileInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseFile($event)"/><input ref="segInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseFile($event,true)"/>
    <div class="workspace">
      <aside class="sidebar">
        <div class="section-heading">分割标签<span v-if="volume">{{segments.length}} / 64</span><button aria-label="新增标签" title="新增标签" :disabled="!volume||busy||segments.length>=64" @click="addSegment">＋</button></div>
        <div class="segment-list">
          <div v-for="s in segments" :key="s.id" :class="['segment',{selected:selected===s.id}]" @click="selected=s.id">
            <input v-model="s.color" :disabled="busy" :aria-label="`${s.name}颜色`" type="color" @change="updateLabel(s)"/>
            <input v-model="s.name" :disabled="busy" :aria-label="`标签 ${s.id}名称`" maxlength="60" @change="updateLabel(s)"/>
            <button :title="s.visible?'隐藏标注':'显示标注'" :aria-label="s.visible?'隐藏标注':'显示标注'" @click.stop="s.visible=!s.visible"><UiIcon :name="s.visible?'eye':'eye-off'"/></button>
          </div>
          <p v-if="!volume" class="hint">加载影像后在此管理标签的名称、颜色与显隐。</p>
        </div>
        <label class="range-label">标注透明度<span>{{Math.round(opacity*100)}}%</span><input v-model.number="opacity" type="range" min="0" max="1" step=".05" :disabled="!volume"/></label>
        <hr class="side-divider"/>
        <div class="section-heading">标注工具<small>B / E / V / G</small></div>
        <div class="tools"><button v-for="t in tools" :key="t.id" :aria-label="t.label" :title="t.keys?`${t.label}（${t.keys}）`:t.label" :disabled="!volume||busy" :class="{active:tool===t.id}" @click="tool=t.id"><UiIcon :name="t.icon"/>{{t.label}}</button></div>
        <div v-if="tool==='threshold'&&volume" class="threshold-panel">
          <div class="section-heading">灰度阈值<small>整套三维影像</small></div>
          <p class="hint">影像灰度范围：{{volume.min.toLocaleString()}} ～ {{volume.max.toLocaleString()}}。使用原始灰度，与窗宽窗位无关。</p>
          <label for="threshold-min">最小灰度</label><input id="threshold-min" type="number" step="any" :value="thresholdMin" @input="thresholdMin=inputValue($event)"/><input aria-label="最小灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(minimum)?Math.max(volume.min,Math.min(volume.max,minimum)):volume.min" @input="thresholdMin=inputValue($event)"/>
          <label for="threshold-max">最大灰度</label><input id="threshold-max" type="number" step="any" :value="thresholdMax" @input="thresholdMax=inputValue($event)"/><input aria-label="最大灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(maximum)?Math.max(volume.min,Math.min(volume.max,maximum)):volume.max" @input="thresholdMax=inputValue($event)"/>
          <p v-if="!thresholdValid" class="field-error" role="alert">请输入有效范围，最小值不能大于最大值。</p><p v-if="!active.visible" class="field-error">请先显示当前标签，再预览或应用。</p>
          <label class="preview-toggle"><input v-model="previewEnabled" type="checkbox"/>预览选区（尚未写入标注）</label>
          <p class="hint">应用后，以此范围替换当前标签；范围内覆盖其他标签，范围外保留其他标签。包含上下限，可一次撤销。</p>
          <button class="primary" :disabled="!thresholdValid||!active.visible||busy" @click="runThreshold">应用阈值分割</button>
        </div>
        <template v-else-if="tool==='paint'||tool==='erase'">
          <label class="range-label">{{tool==='erase'?'橡皮擦直径':'画笔直径'}}<span>{{diameter}} {{volume?.unit||'mm'}}</span><input v-model.number="diameter" type="range" min="1" max="50" :disabled="!volume"/></label>
          <p class="hint">画笔覆盖其他标签；橡皮擦只擦除当前标签。先显示当前标签，再进行编辑。</p>
        </template>
        <p v-else-if="tool==='navigate'" class="hint">在影像上拖动即可联动三切面十字线，快速定位体素。</p>
        <p v-else class="hint">鼠标悬停显示黄色灰度轮廓，点击轮廓内区域加入当前标签，仅作用于当前切片。</p>
        <details class="fold gray-settings" :open="grayOpen" @toggle="grayOpen=($event.target as HTMLDetailsElement).open">
          <summary>灰度分区与悬停轮廓</summary>
          <div class="fold-body">
            <label class="preview-toggle"><input v-model="hoverPreview" type="checkbox" :disabled="!volume"/>悬停显示灰度区域轮廓</label>
            <label class="field-row">分区方式<select v-model="regionMode" aria-label="灰度分区方式" :disabled="!volume"><option value="bands">灰度区间分区</option><option value="level">悬停灰度等值区域</option></select></label>
            <label v-if="regionMode==='bands'" class="field-row">灰度区间宽度<input aria-label="灰度区间宽度" type="number" min=".1" step="1" :value="regionWidth" :disabled="!volume" @input="setRegionWidth"/></label>
            <p class="hint">黄色轮廓仅为预览，不写入标注。宽度决定灰度分段的粒度，请按影像调整。</p>
          </div>
        </details>
        <div class="history"><button :disabled="!history.length||busy" title="撤销上一步（Ctrl+Z）" @click="undo()">↶ 撤销</button><button :disabled="!future.length||busy" title="重做（Ctrl+Shift+Z / Ctrl+Y）" @click="undo(true)">↷ 重做</button></div>
        <hr class="side-divider"/>
        <div class="section-heading">窗宽窗位<small>原始灰度</small></div>
        <div class="window-inputs"><label>窗位<input type="number" :disabled="!volume" :value="center" @input="setWindow($event,'center')"/></label><label>窗宽<input type="number" min="1" :disabled="!volume" :value="width" @input="setWindow($event,'width')"/></label></div>
        <div class="presets">
          <button :disabled="!volume" title="窗位 40 / 窗宽 400" @click="center=40;width=400">软组织</button>
          <button :disabled="!volume" title="窗位 400 / 窗宽 1800" @click="center=400;width=1800">骨窗</button>
          <button :disabled="!volume" title="窗位 -600 / 窗宽 1500" @click="center=-600;width=1500">肺窗</button>
          <button :disabled="!volume" title="窗位 40 / 窗宽 80" @click="center=40;width=80">脑窗</button>
          <button :disabled="!volume" title="覆盖影像全部灰度" @click="fullWindow">全范围</button>
        </div>
        <div class="sidebar-bottom">
          <button :disabled="!volume||busy||collaborating" :title="collaborating?'协同中以共享成果为准，不能整份导入':'载入与当前影像同网格的分割 NIfTI'" @click="segInput?.click()"><UiIcon name="file"/>导入已有分割</button>
          <button :disabled="!volume" title="下载当前标签设置 JSON" @click="download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')"><UiIcon name="export"/>导出标签说明</button>
        </div>
      </aside>
      <main>
        <template v-if="volume">
          <div v-if="volume.oblique" class="notice oblique">此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。</div>
          <div v-if="thresholdPreview" class="threshold-notice">正在预览阈值 {{minimum.toLocaleString()}} ～ {{maximum.toLocaleString()}} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>
          <div class="views">
            <SliceView v-for="axis in axes" :key="axis" :volume="volume" :mask="mask" :axis="axis" :point="point" :revision="revision" :segments="segments" :opacity="opacity" :center="center" :width="width" :tool="tool" :diameter="diameter" :threshold-preview="thresholdPreview" :parallel-map="collaborating?parallelMap:undefined" :hover-preview="hoverPreview" :region-width="regionWidth" :region-mode="regionMode" :allow-edit="!busy" :active="activeAxis===axis" :main="mainAxis===axis" @activate="activeAxis=$event" @promote="mainAxis=$event" @point="point=$event" @start="startStroke" @end="endStroke" @stroke="stroke" @region="selectRegion"/>
          </div>
        </template>
        <div v-else class="empty">
          <div class="empty-visual"><div/><div/><span>＋</span></div>
          <h2>让影像成为可编辑的标注</h2>
          <p>导入三维 NIfTI 影像，在三个切面上绘制分割。<br/>本地影像在本机处理；服务器数据集支持多人协同。</p>
          <button :disabled="busy" class="primary" @click="fileInput?.click()">选择 NIfTI 文件</button>
          <button :disabled="busy" class="server-open-button" @click="showDatasets=true">从服务器选择数据集</button>
          <button :disabled="busy" class="text-button" @click="demo">先用合成影像体验 →</button>
          <small>支持三维灰度 NIfTI-1 · 不支持时间序列 · 滚轮切片，B/E/V/G 切换工具</small>
        </div>
      </main>
      <aside v-if="datasetId" :class="['collab-side',{collapsed:!collabOpen}]" :data-state="sync.state">
        <div class="collab-side-header">
          <template v-if="collabOpen"><span class="collab-dot" aria-hidden="true"/>多人协同<span v-if="collaborating" class="collab-count">{{collaboration.person.value?.name}}</span>
            <button class="icon-button" aria-label="收起协作面板" title="收起协作面板" @click="collabOpen=false"><UiIcon name="chevron"/></button></template>
          <button v-else class="icon-button" aria-label="展开协作面板" title="展开协作面板" @click="collabOpen=true"><UiIcon name="users"/></button>
        </div>
        <div v-if="!collabOpen" class="collab-side-rail" @click="collabOpen=true"><span class="collab-dot" aria-hidden="true"/>多人协同</div>
        <div v-show="collabOpen" class="collab-side-body">
          <CollaborationPanel :dataset-id="datasetId" :collaboration="collaboration"/>
        </div>
      </aside>
    </div>
    <footer class="statusbar">
      <span role="status">{{editor.busy.value?'◌ ':''}}{{status}}</span>
      <span class="spacer"/>
      <span v-if="volume" class="status-meta">
        <span><i :style="{background:active.color}" aria-hidden="true"/>{{active.name}} · 值 {{selected}}</span>
        <span>体素 I {{point[0]+1}} / J {{point[1]+1}} / K {{point[2]+1}}</span>
        <span>灰度 {{volume.data[indexOf(point,volume.dims)].toFixed(1)}}</span>
      </span>
      <span v-else class="status-meta">标注原型 · 请核对导出结果</span>
    </footer>
    <div v-if="editor.busy.value" class="busy-overlay" aria-live="polite">{{status}}</div>
    <DatasetBrowser v-if="showDatasets" :on-before-open="canReplace" :on-open="openDataset" @close="showDatasets=false"/>
    <LocalDrafts v-if="showDrafts" :drafts="drafts" :restore="restoreLocal" @close="showDrafts=false"/>
  </div>
</template>
