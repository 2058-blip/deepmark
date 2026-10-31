<script setup lang="ts">
import { ref } from 'vue';
import SliceView from './SliceView.vue';
import DatasetBrowser from './DatasetBrowser.vue';
import CollaborationPanel from './CollaborationPanel.vue';
import { useEditor } from './useEditor.ts';
import { useCollaboration } from './useCollaboration.ts';
import { indexOf,makeDemo } from './core.ts';
import type { Axis } from './core.ts';
import type { Tool } from './view.ts';
import { download,inputValue } from './view.ts';
const editor=useEditor();
const {volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,viewBusy:busy,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,canReplace,load,startStroke,endStroke,stroke,runThreshold,undo,loadSegmentation}=editor;
const collaboration=useCollaboration(editor);
const {active:collaborating,queueCount,unsaved}=collaboration;
const datasetId=ref<string|null>(null);
const fileInput=ref<HTMLInputElement|null>(null),segInput=ref<HTMLInputElement|null>(null);
const tools:{id:Tool;icon:string;label:string}[]=[{id:'paint',icon:'✎',label:'画笔'},{id:'erase',icon:'▱',label:'橡皮擦'},{id:'navigate',icon:'⌖',label:'定位'},{id:'threshold',icon:'◒',label:'阈值'}];
const axes:Axis[]=[2,1,0];
async function chooseFile(event:Event,seg=false){const element=event.target as HTMLInputElement,file=element.files?.[0];element.value='';if(seg)await loadSegmentation(file);else if(await load(file)){collaboration.leave();datasetId.value=null;}}
async function openDataset(file:File,id?:string){if(!await load(file,true))return false;collaboration.leave();datasetId.value=id||null;return true;}
function addSegment(){if(collaborating.value)void collaboration.addLabel();else editor.addSegment();}
function updateLabel(label:typeof segments.value[number]){if(collaborating.value)void collaboration.updateLabel(label);}
function exportMask(){if(collaborating.value)collaboration.exportServer();else editor.exportMask();}
function demo(){if(canReplace()){collaboration.leave();datasetId.value=null;editor.install(makeDemo());}}
function setWindow(event:Event,which:'center'|'width'){const value=Number(inputValue(event));if(!Number.isFinite(value)||(which==='width'&&value<1))return;if(which==='width')width.value=value;else center.value=value;}
function fullWindow(){if(volume.value){center.value=(volume.value.min+volume.value.max)/2;width.value=Math.max(1,volume.value.max-volume.value.min);}}
</script>
<template>
  <div class="app">
    <header class="topbar"><div class="brand"><div class="brand-icon">✚</div><div>医学分割标注<small>SLICER WEB · 本地浏览器版</small></div></div>
      <div class="top-actions"><span class="local-badge">● {{collaborating?'多人实时协同':'影像本地处理'}}</span><button class="server-library-button" :disabled="busy" @click="showDatasets=true">服务器数据集</button><button :disabled="busy" @click="fileInput?.click()">打开影像</button><button class="primary" :disabled="!volume||(busy&&!editor.readOnly.value)||(collaborating&&(!!queueCount||unsaved))" @click="exportMask">导出标注 ↗</button></div>
    </header>
    <input ref="fileInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseFile($event)"/><input ref="segInput" hidden type="file" accept=".nii,.nii.gz" @change="chooseFile($event,true)"/>
    <div class="workspace"><aside class="sidebar">
      <div class="section-heading">工作空间<span>01</span></div>
      <div class="file-card"><span class="eyebrow">当前影像</span><strong :title="volume?.name">{{volume?.name||'尚未加载影像'}}</strong><small>{{volume?`${volume.dims.join(' × ')} · ${volume.spacing.map(n=>+n.toFixed(3)).join(' / ')} 间距`:'支持 .nii / .nii.gz'}}</small></div>
      <div class="section-heading">分割标签<button aria-label="新增标签" :disabled="!volume||busy||segments.length>=64" @click="addSegment">＋</button></div>
      <div class="segment-list"><div v-for="s in segments" :key="s.id" :class="['segment',{selected:selected===s.id}]" @click="selected=s.id"><input v-model="s.color" :disabled="busy" :aria-label="`${s.name}颜色`" type="color" @change="updateLabel(s)"/><input v-model="s.name" :disabled="busy" :aria-label="`标签 ${s.id}名称`" maxlength="60" @change="updateLabel(s)"/><button :title="s.visible?'隐藏标注':'显示标注'" :aria-label="s.visible?'隐藏标注':'显示标注'" @click.stop="s.visible=!s.visible">{{s.visible?'◉':'○'}}</button></div></div>
      <label class="range-label">标注透明度<span>{{Math.round(opacity*100)}}%</span><input v-model.number="opacity" type="range" min="0" max="1" step=".05"/></label>
      <div class="section-heading">标注工具<small>B / E / V</small></div>
      <div class="tools"><button v-for="t in tools" :key="t.id" :aria-label="t.label" :disabled="!volume||busy" :class="{active:tool===t.id}" @click="tool=t.id"><b aria-hidden="true">{{t.icon}}</b>{{t.label}}</button></div>
      <div v-if="tool==='threshold'&&volume" class="threshold-panel">
        <div class="section-heading">灰度阈值<small>整套三维影像</small></div><p class="hint">影像灰度范围：{{volume.min.toLocaleString()}} ～ {{volume.max.toLocaleString()}}。使用原始灰度，与窗宽窗位无关。</p>
        <label for="threshold-min">最小灰度</label><input id="threshold-min" type="number" step="any" :value="thresholdMin" @input="thresholdMin=inputValue($event)"/><input aria-label="最小灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(minimum)?Math.max(volume.min,Math.min(volume.max,minimum)):volume.min" @input="thresholdMin=inputValue($event)"/>
        <label for="threshold-max">最大灰度</label><input id="threshold-max" type="number" step="any" :value="thresholdMax" @input="thresholdMax=inputValue($event)"/><input aria-label="最大灰度滑块" type="range" :min="volume.min" :max="volume.max" step="any" :disabled="volume.min===volume.max" :value="Number.isFinite(maximum)?Math.max(volume.min,Math.min(volume.max,maximum)):volume.max" @input="thresholdMax=inputValue($event)"/>
        <p v-if="!thresholdValid" class="field-error" role="alert">请输入有效范围，最小值不能大于最大值。</p><p v-if="!active.visible" class="field-error">请先显示当前标签，再预览或应用。</p>
        <label class="preview-toggle"><input v-model="previewEnabled" type="checkbox"/>预览选区（尚未写入标注）</label><p class="hint">应用后，以此范围替换当前标签；范围内覆盖其他标签，范围外保留其他标签。包含上下限，可一次撤销。</p><button class="primary" :disabled="!thresholdValid||!active.visible||busy" @click="runThreshold">应用阈值分割</button>
      </div>
      <template v-else><label class="range-label">画笔直径<span>{{diameter}} {{volume?.unit||'mm'}}</span><input v-model.number="diameter" type="range" min="1" max="50"/></label><p class="hint">画笔覆盖其他标签；橡皮擦只擦除当前标签。先显示当前标签，再进行编辑。</p></template>
      <div class="history"><button :disabled="!history.length||busy" @click="undo()">↶ 撤销</button><button :disabled="!future.length||busy" @click="undo(true)">↷ 重做</button></div>
      <div class="section-heading">影像显示</div><div class="window-inputs"><label>窗位<input type="number" :disabled="!volume" :value="center" @input="setWindow($event,'center')"/></label><label>窗宽<input type="number" min="1" :disabled="!volume" :value="width" @input="setWindow($event,'width')"/></label></div>
      <div class="presets"><button :disabled="!volume" @click="center=40;width=400">软组织</button><button :disabled="!volume" @click="center=400;width=1800">骨窗</button><button :disabled="!volume" @click="fullWindow">全范围</button></div>
      <div class="sidebar-bottom"><button :disabled="!volume||busy||collaborating" @click="segInput?.click()">导入已有分割</button><button :disabled="!volume" @click="download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')">导出标签说明</button></div>
    </aside><main>
      <div class="main-heading"><div><span class="eyebrow">SEGMENT EDITOR</span><h1>{{volume?'三切面标注':'从一份影像开始'}}</h1></div><span class="state">{{dirty?'● 有未导出的修改':volume?'● 就绪':'等待导入'}}</span></div>
      <CollaborationPanel :dataset-id="datasetId" :collaboration="collaboration"/>
      <template v-if="volume">
        <div class="notice">{{volume.oblique?'此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。':'按影像空间方向标注切面与方位，保持原始体素网格。'}} 滚轮切片 · 定位工具联动十字线</div>
        <div v-if="thresholdPreview" class="threshold-notice">正在预览阈值 {{minimum.toLocaleString()}} ～ {{maximum.toLocaleString()}} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>
        <div class="views"><SliceView v-for="axis in axes" :key="axis" :volume="volume" :mask="mask" :axis="axis" :point="point" :revision="revision" :segments="segments" :opacity="opacity" :center="center" :width="width" :tool="tool" :diameter="diameter" :threshold-preview="thresholdPreview" @point="point=$event" @start="startStroke" @end="endStroke" @stroke="stroke"/></div>
        <div class="info-bar"><span>当前标签<i :style="{background:active.color}"/>{{active.name}} · 值 {{selected}}</span><span>体素 I {{point[0]+1}} / J {{point[1]+1}} / K {{point[2]+1}}</span><span>灰度 {{volume.data[indexOf(point,volume.dims)].toFixed(1)}}</span></div>
      </template>
      <div v-else class="empty"><div class="empty-visual"><div/><div/><span>＋</span></div><h2>让影像成为可编辑的标注</h2><p>导入三维 NIfTI 影像，在三个切面上绘制分割。<br/>文件在本机处理，无需上传。</p><button :disabled="busy" class="primary" @click="fileInput?.click()">选择 NIfTI 文件</button><button :disabled="busy" class="server-open-button" @click="showDatasets=true">从服务器选择数据集</button><button :disabled="busy" class="text-button" @click="demo">先用合成影像体验 →</button><small>支持三维灰度 NIfTI-1 · 不支持时间序列</small></div>
    </main></div>
    <footer class="statusbar"><span role="status">{{editor.busy.value?'◌ ':''}}{{status}}</span><span>标注原型 · 请核对导出结果</span></footer><div v-if="editor.busy.value" class="busy-overlay" aria-live="polite">正在处理文件，请稍候…</div>
    <DatasetBrowser v-if="showDatasets" :on-before-open="canReplace" :on-open="openDataset" @close="showDatasets=false"/>
  </div>
</template>
