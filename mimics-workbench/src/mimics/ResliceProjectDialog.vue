<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {Vec3} from './types.ts';
import type {ResliceProjectDraft,ResliceProjectPreview,ResliceProjectResultSummary} from './resliceProjectTypes.ts';

const props=defineProps<{open:boolean;draft:ResliceProjectDraft|null;preview:ResliceProjectPreview;drawing:boolean;linePointCount:number;busy:boolean;result:ResliceProjectResultSummary|null;error:string}>();
const emit=defineEmits<{updateDraft:[Partial<ResliceProjectDraft>];drawLine:[];cancelLine:[];useCurrentMpr:[];preset:['source'|'world-x'|'world-y'|'world-z'];generate:[];saveResult:[];downloadResult:[];saveTransforms:[];openResult:[];close:[]}>();
const collapsed=ref(false),localError=ref('');
const editingDisabled=computed(()=>props.busy||props.drawing||!props.draft);
const shownError=computed(()=>localError.value||props.error||props.preview.error);
const canGenerate=computed(()=>props.open&&!!props.draft&&!!props.preview.plan&&!props.preview.error&&!props.error&&!localError.value&&!props.busy&&!props.drawing);
const canUseResult=computed(()=>props.open&&!!props.result&&!props.busy&&!props.drawing);
const memory=computed(()=>Number.isFinite(props.preview.estimatedBytes)&&props.preview.estimatedBytes>=0?`${(props.preview.estimatedBytes/1048576).toFixed(2)} MiB`:'—');
watch(()=>props.drawing,(drawing,previous)=>{if(drawing)collapsed.value=true;else if(previous)collapsed.value=false;},{immediate:true,flush:'sync'});
watch(()=>props.open,open=>{if(!open){collapsed.value=false;localError.value='';}});
watch(()=>props.draft,()=>{localError.value='';});

function patch(value:Partial<ResliceProjectDraft>){if(!props.open||editingDisabled.value)return;localError.value='';emit('updateDraft',value);}
function nameField(event:Event){const name=(event.target as HTMLInputElement).value;if(!name.trim()||name.length>512){localError.value='工程名称须为 1 至 512 个字符。';return;}patch({name});}
function numberField(key:'rotationDegrees'|'widthMm'|'heightMm'|'pixelSize'|'sliceDistance'|'background',event:Event){
  if(editingDisabled.value)return;const input=event.target as HTMLInputElement,value=input.value.trim()===''?NaN:Number(input.value),positive=['widthMm','heightMm','pixelSize','sliceDistance'].includes(key);
  if(!Number.isFinite(value)||positive&&value<=0||key==='background'&&!Number.isFinite(Math.fround(value))){localError.value=positive?'物理宽高、像素尺寸和层距须为有限正毫米值。':'请输入有限数值。';return;}patch({[key]:value});
}
function vectorField(key:'start'|'end'|'up',index:number,event:Event){
  if(editingDisabled.value||!props.draft)return;const raw=(event.target as HTMLInputElement).value,value=raw.trim()===''?NaN:Number(raw);if(!Number.isFinite(value)){localError.value='坐标与方向分量须为有限数值。';return;}const vector=[...props.draft[key]] as Vec3;vector[index]=value;patch({[key]:vector});
}
function interpolationField(event:Event){const value=(event.target as HTMLSelectElement).value;if(value==='linear'||value==='nearest')patch({interpolation:value});}
function option(key:'updateCoordinateSystem'|'copyWorldObjects',event:Event){patch({[key]:(event.target as HTMLInputElement).checked});}
function direction(value:'source'|'world-x'|'world-y'|'world-z'){if(!props.open||editingDisabled.value)return;emit('preset',value);}
function request(action:'drawLine'|'cancelLine'|'useCurrentMpr'|'generate'|'saveResult'|'downloadResult'|'saveTransforms'|'openResult'|'close'){
  if(!props.open||props.busy)return;
  if(action==='close'){emit('close');return;}if(action==='cancelLine'){if(props.drawing)emit('cancelLine');return;}
  if(props.drawing)return;
  if(action==='generate'){if(canGenerate.value)emit('generate');return;}
  if(action==='saveResult'||action==='downloadResult'||action==='saveTransforms'||action==='openResult'){if(canUseResult.value){if(action==='saveResult')emit('saveResult');else if(action==='downloadResult')emit('downloadResult');else if(action==='saveTransforms')emit('saveTransforms');else emit('openResult');}return;}
  if(!props.draft)return;if(action==='drawLine')emit('drawLine');else emit('useCurrentMpr');
}
function key(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();request(props.drawing?'cancelLine':'close');}}
</script>

<template>
  <section v-if="open" class="reslice-project-dialog" :class="{collapsed,drawing}" role="dialog" aria-modal="false" aria-labelledby="reslice-project-title" tabindex="-1" @keydown="key">
    <header><h2 id="reslice-project-title">Reslice Project · 重切片新工程</h2><button type="button" aria-label="收起或展开重切片参数" :aria-expanded="!collapsed" @click="collapsed=!collapsed">{{collapsed?'展开':'收起'}}</button><button type="button" aria-label="关闭重切片新工程面板" :disabled="busy" @click="request('close')">×</button></header>
    <div class="reslice-line-status" :class="{active:drawing}"><span>{{drawing?`在外部 2D / 3D 视图点击线段两端 · ${Math.min(2,linePointCount)} / 2`:'按中心线确定新图像堆栈方向'}}</span><button v-if="drawing" type="button" :disabled="busy" @click="request('cancelLine')">取消画线</button></div>
    <div v-show="!collapsed" class="reslice-project-body">
      <p class="source-notice">生成独立的新工程；当前影像、Mask 与标注保留。</p>
      <template v-if="draft">
        <label>Project name · 新工程名称<input :value="draft.name" type="text" maxlength="512" :disabled="editingDisabled" @change="nameField"></label>
        <div class="pair"><button type="button" :disabled="editingDisabled" @click="request('drawLine')">Draw Line · 在视图画线</button><button type="button" :disabled="editingDisabled" @click="request('useCurrentMpr')">采用当前 MPR</button></div>
        <fieldset v-for="[field,label] in ([['start','线段起点 · 世界坐标 (mm)'],['end','线段终点 · 世界坐标 (mm)'],['up','图像向上方向 · 世界分量']] as const)" :key="field" :disabled="editingDisabled"><legend>{{label}}</legend><div class="triple"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis">{{axis}}<input :value="draft[field][index]" :aria-label="`${field} ${axis}`" type="number" step="any" @change="vectorField(field,index,$event)"></label></div></fieldset>
        <div class="preset-options"><span>方向快捷设置（本应用）</span><div><button type="button" :disabled="editingDisabled" @click="direction('source')">沿源切片方向</button><button v-for="axis in ['x','y','z'] as const" :key="axis" type="button" :disabled="editingDisabled" @click="direction(`world-${axis}`)">世界 {{axis.toUpperCase()}} 方向</button></div></div>
        <label>Rotation · 绕中心线旋转 (°)<input :value="draft.rotationDegrees" type="number" step="any" :disabled="editingDisabled" @change="numberField('rotationDegrees',$event)"></label>
        <div class="pair"><label>Image Width · 图像物理宽度 (mm)<input :value="draft.widthMm" type="number" min="0" step="any" :disabled="editingDisabled" @change="numberField('widthMm',$event)"></label><label>Image Height · 图像物理高度 (mm)<input :value="draft.heightMm" type="number" min="0" step="any" :disabled="editingDisabled" @change="numberField('heightMm',$event)"></label></div>
        <div class="pair"><label>Pixel size · 像素尺寸 (mm)<input :value="draft.pixelSize" type="number" min="0" step="any" :disabled="editingDisabled" @change="numberField('pixelSize',$event)"></label><label>Slice distance · 层距 (mm)<input :value="draft.sliceDistance" type="number" min="0" step="any" :disabled="editingDisabled" @change="numberField('sliceDistance',$event)"></label></div>
        <div class="pair"><label>灰度插值<select :value="draft.interpolation" :disabled="editingDisabled" @change="interpolationField"><option value="linear">Linear · 三线性</option><option value="nearest">Nearest · 最近邻</option></select></label><label>图像外背景值<input :value="draft.background" type="number" step="any" :disabled="editingDisabled" @change="numberField('background',$event)"></label></div>
        <label class="check"><input type="checkbox" :checked="draft.updateCoordinateSystem===true" :disabled="editingDisabled" @change="option('updateCoordinateSystem',$event)">Update CS · 更新新工程坐标系</label><small>默认关闭，保留源世界坐标；开启后新堆栈使用自身坐标，同时保留双向变换。</small>
        <label class="check"><input type="checkbox" :checked="draft.copyWorldObjects===true" :disabled="editingDisabled" @change="option('copyWorldObjects',$event)">复制世界坐标对象：Part / 测量 / 中心线 / RP</label><small>{{draft.copyWorldObjects?'无法无损复制的旧 IJK 轮廓或剪切密度 ROI 会明确报错。可取消勾选，仅生成影像与 Mask。':'已选择仅生成影像与 Mask，不复制 Part、测量、中心线或 RP。'}}</small>
      </template>
      <p v-else>当前没有可用的重切片参数。</p>
      <section class="reslice-preview" aria-label="新工程几何预览"><h3>Output · 输出预览</h3><template v-if="preview.plan"><p>尺寸 {{preview.plan.dims.join(' × ')}} voxels · {{preview.plan.geometry.sliceCount}} 张</p><p>有效宽高 {{preview.effectiveWidthMm.toFixed(3)}} × {{preview.effectiveHeightMm.toFixed(3)}} mm</p><p>预计灰度与 Mask 内存 {{memory}}</p><details><summary>坐标变换预览</summary><pre>{{preview.plan.sourceWorldToOutputWorld.map(row=>row.map(n=>n.toPrecision(7)).join('  ')).join('\n')}}</pre></details></template><p v-else>请确定有效的线段与物理尺寸。</p><ul v-if="preview.warnings.length"><li v-for="(warning,index) in preview.warnings" :key="index">{{warning}}</li></ul></section>
      <p v-if="shownError" class="reslice-project-error" role="alert">{{shownError}}</p>
      <section v-if="result" class="reslice-result" aria-label="独立重切片结果"><h3>{{result.name}}</h3><p>{{result.dims.join(' × ')}} voxels · {{result.masks}} Mask · {{result.parts}} Part · {{result.measurements}} 测量</p><p>图像外灰度 {{result.grayOutside.toLocaleString()}} 个 · {{result.written?'已保存新工程':'新结果尚未保存'}}</p><div class="result-actions"><button type="button" :disabled="!canUseResult" @click="request('saveResult')">保存新工程</button><button type="button" :disabled="!canUseResult" @click="request('downloadResult')">下载新工程副本</button><button type="button" :disabled="!canUseResult" @click="request('saveTransforms')">导出变换 TXT</button><button type="button" :disabled="!canUseResult" @click="request('openResult')">打开新工程</button></div></section>
      <footer><span v-if="busy" role="status">正在生成独立工程…</span><button type="button" :disabled="!canGenerate" @click="request('generate')">Generate · 生成新工程</button><button type="button" :disabled="busy" @click="request('close')">Close · 关闭</button></footer>
    </div>
  </section>
</template>

<style scoped>
.reslice-project-dialog{position:fixed;z-index:1080;right:18px;top:76px;width:430px;max-width:calc(100vw - 30px);max-height:calc(100vh - 92px);overflow:auto;border:1px solid #7891aa;border-radius:5px;background:#eff1f4;color:#172a3b;box-shadow:0 10px 30px #0008;font:12px 'Segoe UI','Microsoft YaHei',sans-serif}.reslice-project-dialog.collapsed{width:340px}.reslice-project-dialog header{position:sticky;top:0;display:flex;align-items:center;gap:5px;padding:7px 9px;background:linear-gradient(#dae7f5,#b7cde4);border-bottom:1px solid #98afc4;z-index:1}.reslice-project-dialog h2{flex:1;font-size:13px;font-weight:500;margin:0}.reslice-project-dialog button{font:inherit;padding:5px 8px;color:#193348;background:linear-gradient(#fff,#dfe5ed);border:1px solid #98aaba;border-radius:3px;cursor:pointer}.reslice-project-dialog header button{padding:2px 6px;font-size:11px}.reslice-line-status{display:flex;align-items:center;gap:7px;padding:8px 10px;color:#516b80;font-size:10px}.reslice-line-status.active{background:#e2eef9;color:#174d7b}.reslice-line-status span{flex:1}.reslice-line-status button{white-space:nowrap;font-size:10px}.reslice-project-body{display:flex;flex-direction:column;gap:11px;padding:2px 12px 12px}.reslice-project-dialog label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#304b63}.reslice-project-dialog input,.reslice-project-dialog select{box-sizing:border-box;min-width:0;width:100%;padding:5px;border:1px solid #9eacba;border-radius:2px;background:#fff;color:#162c40;font:12px 'Segoe UI','Microsoft YaHei',sans-serif}.reslice-project-dialog fieldset{margin:0;padding:8px;border:1px solid #b2c0cc;border-radius:3px}.reslice-project-dialog legend{padding:0 4px;font-size:10px;color:#304b63}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.reslice-project-dialog .check{flex-direction:row;align-items:center;line-height:1.5}.reslice-project-dialog .check input{width:auto;flex:none}.reslice-project-dialog small{font-size:10px;line-height:1.6;color:#5c7286;margin-top:-5px}.reslice-project-dialog p{margin:0;font-size:11px;line-height:1.6}.source-notice{padding:7px;background:#e4eaf0;border:1px solid #c2cdd6;border-radius:2px}.preset-options{display:flex;flex-direction:column;gap:5px;font-size:10px;color:#526a7f}.preset-options>div{display:flex;flex-wrap:wrap;gap:4px}.preset-options button{font-size:10px}.reslice-preview,.reslice-result{padding:9px;border:1px solid #c2cdd6;border-radius:3px;background:#e4eaf0}.reslice-project-dialog h3{font-size:11px;margin:0 0 6px}.reslice-preview ul{padding-left:16px;margin:6px 0 0;color:#765219;font-size:10px;line-height:1.7}.reslice-preview details{font-size:10px;margin-top:7px}.reslice-preview pre{font:10px/1.6 Consolas,monospace;overflow:auto}.reslice-project-error{padding:7px;background:#ffede9;border:1px solid #d9a79e;color:#9c3027}.result-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.reslice-project-dialog footer{display:flex;justify-content:flex-end;align-items:center;gap:7px;border-top:1px solid #b1bfcb;padding-top:10px}.reslice-project-dialog footer span{margin-right:auto;font-size:10px}.reslice-project-dialog :disabled{opacity:.55;cursor:default}.reslice-project-dialog input:focus-visible,.reslice-project-dialog button:focus-visible,.reslice-project-dialog select:focus-visible{outline:2px solid #3e8ec5;outline-offset:1px}
</style>
