<script setup lang="ts">
import { ref } from 'vue';
type Bound = 'lower' | 'upper';
type Slot = 0 | 1 | 2;
interface Range { lower: number; upper: number; editable: boolean }
const props = defineProps<{ slot: Slot; ranges: readonly Range[]; disabled?: boolean }>();
const emit = defineEmits<{ choose: [slot: Slot]; 'update-range': [slot: Slot, bound: Bound, value: number] }>();
const error = ref('');
function choose(slot: number) {
  if (props.disabled || ![0,1,2].includes(slot) || !props.ranges[slot]) return;
  error.value = ''; emit('choose', slot as Slot);
}
function update(slot: number, bound: Bound, event: Event) {
  const range = props.ranges[slot];
  if (props.disabled || slot !== 0 && slot !== 2 || !range?.editable) return;
  const raw = (event.target as HTMLInputElement).value.trim(), value = Number(raw);
  if (!raw || !Number.isFinite(value)) { error.value = '请输入有限的灰度值。'; return; }
  const lower = bound === 'lower' ? value : range.lower, upper = bound === 'upper' ? value : range.upper;
  if (lower > upper) { error.value = 'Threshold 1 不能大于 Threshold 2。'; return; }
  error.value = ''; emit('update-range', slot as Slot, bound, value);
}
</script>
<template>
  <fieldset class="local-threshold-controls" :disabled="disabled"><legend>Local Threshold · 局部阈值</legend>
    <div class="range-table"><table aria-label="局部阈值的三个范围"><thead><tr><th>范围</th><th>Threshold 1</th><th>Threshold 2</th></tr></thead><tbody>
      <tr v-for="(range,index) in ranges" :key="index" :class="{selected:slot===index}"><td><label class="range-choice"><input type="radio" name="local-threshold-slot" :checked="slot===index" :disabled="disabled" :aria-label="index===1?'选择活动 Mask 默认阈值':`选择自定义阈值 ${index===0?1:2}`" @change="choose(index)"><span>{{index===1?'Mask 默认':`自定义 ${index===0?1:2}`}}</span></label></td><td v-for="bound in (['lower','upper'] as const)" :key="bound"><input type="number" :value="range[bound]" :readonly="index===1||!range.editable" :aria-readonly="index===1||!range.editable" :disabled="disabled" :aria-label="`${index===1?'Mask 默认':`自定义 ${index===0?1:2}`} ${bound==='lower'?'Threshold 1':'Threshold 2'}`" step="1" @change="update(index,bound,$event)"></td></tr>
    </tbody></table><div class="range-arrows"><button type="button" aria-label="上一阈值范围" :disabled="disabled||slot<=0" @click="choose(slot-1)">↑</button><button type="button" aria-label="下一阈值范围" :disabled="disabled||slot>=ranges.length-1" @click="choose(slot+1)">↓</button></div></div>
    <small>中间范围跟随活动 Mask，数值只读；上下两组可自定义。</small><p v-if="error" role="alert">{{error}}</p>
  </fieldset>
</template>
<style scoped>
.local-threshold-controls{margin:0;padding:8px;border:1px solid #354b64;border-radius:4px;min-width:0;color:#a6bed9}.local-threshold-controls legend{font-size:11px;padding:0 4px}.range-table{display:flex;gap:5px;align-items:stretch}.range-table table{width:100%;min-width:0;border-collapse:collapse;font-size:9px}.range-table th{font-weight:400;text-align:left;padding:3px;color:#91a9c5}.range-table td{padding:3px 2px;min-width:0}.range-table tr.selected{background:#244364}.local-threshold-controls .range-choice{display:flex;flex-direction:row;align-items:center;gap:3px;font-size:9px;white-space:nowrap}.range-choice input{width:11px;height:11px;margin:0;accent-color:#76b7ef}.local-threshold-controls td input[type=number]{width:100%;min-width:0;box-sizing:border-box;padding:3px;font-size:10px}.local-threshold-controls input[readonly]{color:#9aabc0;background:#162336}.range-arrows{display:flex;flex-direction:column;justify-content:center;gap:5px}.local-threshold-controls .range-arrows button{padding:2px 5px;min-width:20px;font-size:11px}.local-threshold-controls small{display:block;font-size:9px;line-height:1.6;color:#849ab5;margin-top:5px}.local-threshold-controls p{margin:5px 0 0;font-size:10px;color:#ffb3a6}
</style>
