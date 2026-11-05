<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ReduceOptions, SmoothOptions } from './geometry.ts';
import type { MaskObject, Vec3 } from './types.ts';

type CalculationRequest = {
  maskIds: string[];
  quality: 'optimal' | 'custom';
  step: Vec3;
  smooth?: SmoothOptions;
  reduction?: ReduceOptions;
  topology: 'native-table' | 'resolved';
};
const props = defineProps<{ masks: MaskObject[]; activeMaskId: string; busy: boolean; progress: number; error: string }>();
const emit = defineEmits<{ calculate: [request: CalculationRequest]; close: []; cancel: [] }>();
const dialog = ref<HTMLElement>();
const selectedIds = ref<string[]>(props.masks.some(mask => mask.id === props.activeMaskId) ? [props.activeMaskId] : []);
const quality = ref<'optimal' | 'custom'>('optimal'), optionsOpen = ref(false), helpOpen = ref(false);
const step = ref<Vec3>([1, 1, 1]), smoothEnabled = ref(false), reduceEnabled = ref(false), resolveAmbiguous = ref(false);
const smoothIterations = ref(3), smoothFactor = ref(.3), compensateShrinkage = ref(false);
const remainingPercent = ref(50), tolerance = ref(.3), featureAngle = ref(45), reduceIterations = ref(3);
const localError = ref(''), cancelRequested = ref(false);
const selectedMasks = computed(() => props.masks.filter(mask => selectedIds.value.includes(mask.id)));
const shownError = computed(() => localError.value || props.error);
const custom = computed(() => quality.value === 'custom');
const progressFraction = computed(() => Number.isFinite(props.progress) ? Math.max(0, Math.min(1, props.progress)) : 0);

watch(() => props.masks.map(mask => mask.id), ids => { selectedIds.value = selectedIds.value.filter(id => ids.includes(id)); }, { flush: 'sync' });
watch(() => props.busy, busy => { if (!busy) cancelRequested.value = false; }, { flush: 'sync' });
watch([quality, step, smoothEnabled, reduceEnabled, resolveAmbiguous, smoothIterations, smoothFactor, compensateShrinkage, remainingPercent, tolerance, featureAngle, reduceIterations, selectedIds], () => { localError.value = ''; }, { deep: true, flush: 'sync' });

function toggleMask(id: string) {
  if (props.busy || !props.masks.some(mask => mask.id === id)) return;
  selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter(selected => selected !== id) : [...selectedIds.value, id];
}
function selectRow(id: string, additive: boolean) {
  if (props.busy || !props.masks.some(mask => mask.id === id)) return;
  if (additive) toggleMask(id); else selectedIds.value = [id];
}
function customParameters(): Pick<CalculationRequest, 'step' | 'smooth' | 'reduction' | 'topology'> {
  if (step.value.length !== 3 || step.value.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('X、Y、Z 采样步长必须为正整数。');
  const result: Pick<CalculationRequest, 'step' | 'smooth' | 'reduction' | 'topology'> = { step: [...step.value], topology: resolveAmbiguous.value ? 'resolved' : 'native-table' };
  if (smoothEnabled.value) {
    if (!Number.isSafeInteger(smoothIterations.value) || smoothIterations.value < 1 || smoothIterations.value > 1000 || !Number.isFinite(smoothFactor.value) || smoothFactor.value < 0 || smoothFactor.value > 1) throw new Error('平滑次数须为 1–1000 的整数，平滑因子须在 0–1 之间。');
    result.smooth = { iterations: smoothIterations.value, factor: smoothFactor.value, compensateShrinkage: compensateShrinkage.value, preserveBoundary: true };
  }
  if (reduceEnabled.value) {
    if (!Number.isFinite(remainingPercent.value) || remainingPercent.value <= 0 || remainingPercent.value > 100 || !Number.isFinite(tolerance.value) || tolerance.value < 0 || !Number.isFinite(featureAngle.value) || featureAngle.value < 0 || featureAngle.value > 180 || !Number.isSafeInteger(reduceIterations.value) || reduceIterations.value < 1 || reduceIterations.value > 1000) throw new Error('减面须保留大于 0 且不超过 100% 的三角形；容差须非负，边缘角须在 0–180°，迭代次数须为 1–1000 的整数。');
    result.reduction = { targetRatio: remainingPercent.value / 100, tolerance: tolerance.value, featureAngle: featureAngle.value, iterations: reduceIterations.value, preserveBoundary: true };
  }
  return result;
}
function calculate() {
  if (props.busy) return;
  localError.value = '';
  try {
    const maskIds = [...new Set(selectedMasks.value.map(mask => mask.id))];
    if (!maskIds.length) throw new Error('请先选择至少一个 Mask。');
    if (quality.value !== 'optimal' && quality.value !== 'custom') throw new Error('请选择 Optimal 或 Custom 质量。');
    const parameters = quality.value === 'optimal' ? { step: [1, 1, 1] as Vec3, topology: 'native-table' as const } : customParameters();
    emit('calculate', { maskIds, quality: quality.value, ...parameters });
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
    if (custom.value) optionsOpen.value = true;
  }
}
function finishOptions() {
  if (props.busy) return;
  try { if (custom.value) customParameters(); localError.value = ''; optionsOpen.value = false; }
  catch (error) { localError.value = error instanceof Error ? error.message : String(error); }
}
function close() { if (!props.busy) emit('close'); }
function cancel() {
  if (!props.busy || cancelRequested.value) return;
  cancelRequested.value = true; emit('cancel');
}
function escape() {
  if (props.busy) cancel(); else if (optionsOpen.value) optionsOpen.value = false; else close();
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(element => element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus(); }
}
onMounted(() => dialog.value?.focus());
</script>

<template>
  <div class="calculate-backdrop">
    <section ref="dialog" class="calculate-dialog" role="dialog" aria-modal="true" aria-labelledby="calculate-3d-title" tabindex="-1" @keydown.esc.prevent.stop="escape" @keydown="trapFocus">
      <header class="calculate-titlebar"><h2 id="calculate-3d-title">Calculate 3D</h2><button type="button" aria-label="关闭 Calculate 3D" :disabled="busy" @click="close">×</button></header>
      <div class="calculate-body">
        <div class="calculate-main">
          <div class="mask-list">
            <table role="grid" aria-label="选择用于 3D 计算的 Mask" aria-multiselectable="true">
              <thead><tr><th scope="col">Selected</th><th scope="col">Name</th><th scope="col">Lower threshold</th><th scope="col">Higher threshold</th></tr></thead>
              <tbody>
                <tr v-for="mask in masks" :key="mask.id" :class="{selected:selectedIds.includes(mask.id)}" :aria-selected="selectedIds.includes(mask.id)" :tabindex="busy?-1:0" @click="selectRow(mask.id,$event.ctrlKey||$event.metaKey)" @keydown.space.prevent="toggleMask(mask.id)" @keydown.enter.prevent="selectRow(mask.id,false)">
                  <td class="mask-selected"><input type="checkbox" :checked="selectedIds.includes(mask.id)" :disabled="busy" :aria-label="`选择 Mask ${mask.name}`" @click.stop @change="toggleMask(mask.id)"></td>
                  <td class="mask-name"><span class="mask-color" :style="{backgroundColor:mask.color}" aria-hidden="true"/>{{mask.name}}</td>
                  <td>{{mask.threshold?.[0]??'—'}}</td><td>{{mask.threshold?.[1]??'—'}}</td>
                </tr>
                <tr v-if="!masks.length"><td colspan="4" class="empty-masks">没有可计算的 Mask。</td></tr>
              </tbody>
            </table>
          </div>
          <aside class="calculate-quality">
            <fieldset :disabled="busy"><legend>Quality</legend><label><input v-model="quality" type="radio" value="optimal" name="calculate-quality">Optimal</label><label><input v-model="quality" type="radio" value="custom" name="calculate-quality">Custom</label></fieldset>
            <p>{{custom?'使用自定义参数':'完整分辨率'}}</p>
            <button type="button" :disabled="busy" :aria-expanded="optionsOpen" aria-controls="calculate-3d-options" @click="optionsOpen=!optionsOpen">Options…</button>
          </aside>
        </div>
        <p class="selection-hint">Ctrl + 单击可多选 · 已选择 {{selectedMasks.length}} 个 Mask</p>
        <section v-if="optionsOpen" id="calculate-3d-options" class="calculate-options" aria-labelledby="calculate-options-title">
          <h3 id="calculate-options-title">Calculate 3D Parameters</h3>
          <p class="parameter-hint">{{custom?'仅影响本次生成的 3D；源 Mask 保持不变。':'Optimal 使用每个体素，不额外平滑或减面。选择 Custom 可编辑参数。'}}</p>
          <fieldset :disabled="busy||!custom"><legend>Matrix reduction</legend><div class="parameter-row"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis">{{axis}} step<input :value="custom?step[index]:1" type="number" min="1" step="1" :aria-label="`${axis} step`" @input="step[index]=Number(($event.target as HTMLInputElement).value)"></label></div><small>步长以体素为单位；1 表示完整分辨率。</small></fieldset>
          <div class="processing-options">
            <fieldset :disabled="busy||!custom"><legend><label><input :checked="custom&&smoothEnabled" :disabled="busy||!custom" type="checkbox" @change="smoothEnabled=($event.target as HTMLInputElement).checked">Smoothing</label></legend><div class="parameter-row"><label>Iterations<input v-model.number="smoothIterations" :disabled="!smoothEnabled||!custom||busy" type="number" min="1" max="1000" step="1" aria-label="Smoothing iterations"></label><label>Smooth factor<input v-model.number="smoothFactor" :disabled="!smoothEnabled||!custom||busy" type="number" min="0" max="1" step=".05" aria-label="Smooth factor"></label></div><label class="check-option"><input :checked="custom&&compensateShrinkage" :disabled="!smoothEnabled||!custom||busy" type="checkbox" @change="compensateShrinkage=($event.target as HTMLInputElement).checked">Compensate shrinkage</label></fieldset>
            <fieldset :disabled="busy||!custom"><legend><label><input :checked="custom&&reduceEnabled" :disabled="busy||!custom" type="checkbox" @change="reduceEnabled=($event.target as HTMLInputElement).checked">Triangle reduction</label></legend><div class="parameter-row"><label>Keep triangles (%)<input v-model.number="remainingPercent" :disabled="!reduceEnabled||!custom||busy" type="number" min=".1" max="100" step="1"></label><label>Tolerance<input v-model.number="tolerance" :disabled="!reduceEnabled||!custom||busy" type="number" min="0" step=".1" title="与模型坐标相同的空间单位"></label></div><div class="parameter-row"><label>Edge angle (°)<input v-model.number="featureAngle" :disabled="!reduceEnabled||!custom||busy" type="number" min="0" max="180" step="1"></label><label>Iterations<input v-model.number="reduceIterations" :disabled="!reduceEnabled||!custom||busy" type="number" min="1" max="1000" step="1" aria-label="Triangle reduction iterations"></label></div><small>Tolerance 使用模型坐标单位；保留比例为目标值。</small></fieldset>
          </div>
          <label class="check-option"><input :checked="custom&&resolveAmbiguous" :disabled="busy||!custom" type="checkbox" @change="resolveAmbiguous=($event.target as HTMLInputElement).checked">Resolve ambiguous faces · 解决歧义面</label>
          <div class="options-actions"><button type="button" :disabled="busy" @click="finishOptions">OK</button></div>
        </section>
        <p v-if="helpOpen" class="calculate-help">选择 Mask → 选择 Quality → 按需打开 Options 并按 OK → Calculate。计算完成后可继续生成，按 Close 退出。Optimal 按完整分辨率生成；Custom 的平滑与减面仅在勾选后执行。</p>
        <div v-if="shownError" class="calculate-error" role="alert">{{shownError}}</div>
        <div v-if="busy" class="calculate-progress" aria-live="polite"><progress :value="progressFraction" max="1" aria-label="3D 计算进度"/><span>{{cancelRequested?'正在取消…':`${Math.round(progressFraction*100)}%`}}</span></div>
      </div>
      <footer class="calculate-actions"><button v-if="busy" type="button" :disabled="cancelRequested" @click="cancel">Cancel</button><span class="action-spacer"/><button type="button" class="calculate-button" :disabled="busy||!selectedMasks.length" @click="calculate">Calculate</button><button type="button" :disabled="busy" @click="close">Close</button><button type="button" :aria-expanded="helpOpen" @click="helpOpen=!helpOpen">Help</button></footer>
    </section>
  </div>
</template>

<style scoped>
.calculate-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:#0610208c;padding:20px}.calculate-dialog{width:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);display:flex;flex-direction:column;border:1px solid #687e96;border-radius:5px;background:#eff0f2;color:#162637;box-shadow:0 14px 42px #0008;font:12px 'Segoe UI','Microsoft YaHei',sans-serif;outline:none;overflow:hidden}.calculate-titlebar{display:flex;align-items:center;justify-content:space-between;min-height:30px;padding:0 5px 0 10px;background:linear-gradient(#dae7f5,#b7cde4);border-bottom:1px solid #90a8c0}.calculate-titlebar h2{margin:0;font-size:12px;font-weight:500}.calculate-dialog button{font:inherit;color:#192c41;border:1px solid #9aabbc;border-radius:3px;padding:4px 12px;background:linear-gradient(#fff,#e1e5eb);cursor:pointer;min-width:78px}.calculate-dialog button:hover:not(:disabled){background:linear-gradient(#f4fbff,#d6eafa);border-color:#5895c8}.calculate-dialog button:focus-visible,.calculate-dialog input:focus-visible,.mask-list tr:focus-visible{outline:2px solid #3d8ac4;outline-offset:1px}.calculate-dialog button:disabled{color:#8a929b;cursor:default;opacity:.75}.calculate-titlebar button{min-width:30px;padding:0 8px;font-size:17px;line-height:21px;background:linear-gradient(#e7b7ad,#bc6b5d);color:#fff;border-color:#a36155}.calculate-body{padding:10px;overflow:auto}.calculate-main{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px;min-height:205px}.mask-list{background:#fff;border:1px solid #98a5b2;overflow:auto;min-height:205px;max-height:300px}.mask-list table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:11px}.mask-list th{position:sticky;top:0;background:#f3f5f8;border-right:1px solid #d7dce3;border-bottom:1px solid #c7d0db;padding:4px 5px;text-align:left;font-weight:400}.mask-list td{padding:4px 5px;border:0}.mask-list tr.selected td{background:#d9e9f8}.mask-list tbody tr:not(.selected):nth-child(even) td{background:#f2f3f5}.mask-list tbody tr{cursor:default}.mask-list .mask-selected{text-align:center;width:32px}.mask-list input{margin:0;vertical-align:middle;accent-color:#37894d}.mask-name{max-width:160px;overflow:hidden;text-overflow:ellipsis}.mask-color{display:inline-block;width:10px;height:10px;border:1px solid #425a59;box-shadow:inset 2px 2px 0 #ffffff70;vertical-align:-1px;margin-right:5px}.mask-list .empty-masks{text-align:center;padding:22px;color:#697989}.calculate-quality fieldset,.calculate-options fieldset{margin:0;border:1px solid #aebbc8;border-radius:3px;padding:9px}.calculate-quality fieldset{display:flex;flex-direction:column;gap:9px}.calculate-dialog legend{padding:0 4px;font-size:11px}.calculate-quality label,.check-option,.calculate-options legend label{display:flex;gap:5px;align-items:center}.calculate-dialog input[type=checkbox],.calculate-dialog input[type=radio]{margin:0;accent-color:#347cae}.calculate-quality p{font-size:10px;line-height:1.6;color:#53677c;margin:12px 0 8px}.calculate-quality>button{width:100%;padding:4px 5px}.selection-hint{margin:7px 0 0;color:#52677d;font-size:10px}.calculate-options{margin-top:10px;border:1px solid #a4b5c6;border-radius:3px;padding:9px;background:#f7f8fa}.calculate-options h3{font-size:12px;font-weight:500;margin:0 0 5px}.parameter-hint{margin:0 0 9px;color:#53677c;font-size:10px;line-height:1.6}.parameter-row{display:flex;gap:10px;margin:4px 0}.parameter-row>label{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;font-size:10px}.parameter-row input{width:100%;min-width:0;box-sizing:border-box;background:#fff;border:1px solid #9eacba;border-radius:2px;padding:3px 4px;color:#172c42;font:11px 'Segoe UI',sans-serif}.parameter-row input:disabled{background:#e9edf1;color:#8e99a4}.calculate-options small{display:block;font-size:9px;line-height:1.5;color:#64778c}.processing-options{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}.calculate-options .check-option{font-size:10px;margin-top:9px}.calculate-options fieldset:disabled{color:#8693a0}.options-actions{display:flex;justify-content:flex-end;margin-top:8px}.calculate-help{font-size:11px;line-height:1.7;background:#fffbe5;border:1px solid #d9cf9b;padding:8px;margin:10px 0 0}.calculate-error{margin-top:9px;color:#9b251f;background:#fff0ec;border:1px solid #d6a49b;border-radius:3px;padding:7px;font-size:11px;line-height:1.6}.calculate-progress{display:flex;gap:8px;align-items:center;margin-top:10px}.calculate-progress progress{flex:1;height:14px;accent-color:#4a9c63}.calculate-progress span{font-size:11px;min-width:65px;text-align:right}.calculate-actions{display:flex;gap:8px;border-top:1px solid #b0bac5;padding:9px 10px;background:#eceef1;flex-wrap:wrap}.action-spacer{flex:1}.calculate-actions .calculate-button{border-color:#6e94b7}.calculate-dialog :disabled{cursor:default}@media(max-width:560px){.calculate-main{grid-template-columns:minmax(0,1fr)}.calculate-quality{display:flex;align-items:center;gap:10px}.calculate-quality fieldset{flex:1;flex-direction:row;gap:14px}.calculate-quality p{display:none}.calculate-quality>button{width:auto}.processing-options{grid-template-columns:1fr}.calculate-actions{gap:6px}.calculate-dialog button{min-width:70px}}
</style>
