<script setup lang="ts">
import type {MeshCoordinateFrame} from './meshExchange.ts';
const props=defineProps<{frame:MeshCoordinateFrame;hasReference:boolean;busy:boolean}>();
const emit=defineEmits<{change:[frame:MeshCoordinateFrame]}>();
function change(event:Event){if(props.busy||!props.hasReference)return;const frame=(event.target as HTMLSelectElement).value;if(frame==='reference'||frame==='application')emit('change',frame);}
</script>
<template>
  <label v-if="hasReference" class="stl-coordinate-controls">STL 交换坐标<select :value="frame" :disabled="busy" aria-label="STL 交换坐标" @change="change"><option value="reference">参考坐标（与 NIfTI 对齐）</option><option value="application">应用坐标</option></select></label>
</template>
<style scoped>
.stl-coordinate-controls{display:flex;flex-direction:column;gap:5px;margin:8px 0;color:#abc0d6;font-size:10px}.stl-coordinate-controls select{min-width:0;max-width:100%;padding:5px;color:#cbdced;background:#16263b;border:1px solid #3b526e;border-radius:4px;font:11px 'Segoe UI','Microsoft YaHei',sans-serif}.stl-coordinate-controls select:disabled{opacity:.55}.stl-coordinate-controls select:focus-visible{outline:2px solid #78b8ed;outline-offset:1px}
</style>
