<script setup lang="ts">
import {computed} from 'vue';
import type {TransferProgress} from './transfer.ts';
const props=withDefaults(defineProps<{title:string;progress?:TransferProgress|null;stage?:string;cancellable?:boolean}>(),{progress:null,stage:'',cancellable:false});
defineEmits<{cancel:[]}>();
function bytes(value:number){if(value<1024)return `${value} B`;if(value<1024**2)return `${(value/1024).toFixed(1)} KB`;if(value<1024**3)return `${(value/1024**2).toFixed(1)} MB`;return `${(value/1024**3).toFixed(2)} GB`;}
const amount=computed(()=>props.progress?`${bytes(props.progress.loaded)}${props.progress.total===null?'':` / ${bytes(props.progress.total)}`}`:'');
const description=computed(()=>[props.stage,amount.value].filter(Boolean).join(' · '));
</script>
<template>
  <section class="transfer-progress" data-testid="transfer-progress" :data-stage="stage" :data-loaded="progress?.loaded??0" :data-total="progress?.total??''" :data-transfer-complete="progress?.complete||false" aria-label="传输进度">
    <div class="transfer-heading"><strong>{{title}}</strong><span v-if="progress?.percent!==null&&progress?.percent!==undefined" class="transfer-percent">{{progress.percent}}%</span><span v-else class="transfer-percent">{{progress?.complete?'传输完成':progress?'传输中':'准备中'}}</span></div>
    <progress :value="progress?.percent??undefined" max="100" :aria-label="title" :aria-valuetext="description"/>
    <div class="transfer-description"><span role="status">{{description}}</span><button v-if="cancellable" type="button" @click="$emit('cancel')">取消传输</button></div>
  </section>
</template>
<style scoped>
.transfer-progress{width:100%;min-width:0;box-sizing:border-box;border:1px solid #cfe5dd;border-radius:6px;background:#f5fbf8;padding:14px 16px;color:#244a40;box-shadow:0 1px 3px #173c3708}
.transfer-heading,.transfer-description{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.transfer-heading strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}.transfer-percent{flex-shrink:0;color:#087f7c;font-size:12px;font-variant-numeric:tabular-nums}
progress{display:block;appearance:none;-webkit-appearance:none;width:100%;height:7px;margin:12px 0;border:0;border-radius:4px;overflow:hidden;accent-color:#18aaa9;background:#deeee8}
progress::-webkit-progress-bar{background:#deeee8;border-radius:4px}progress::-webkit-progress-value{background:#18aaa9;border-radius:4px}progress::-moz-progress-bar{background:#18aaa9;border-radius:4px}
progress:indeterminate{background:linear-gradient(90deg,#deeee8 0%,#18aaa9 45%,#deeee8 70%);background-size:200% 100%;animation:transfer-running 1.4s linear infinite}progress:indeterminate::-webkit-progress-bar{background:transparent}
.transfer-description{align-items:flex-start;font-size:11px;line-height:1.6;color:#57766a}.transfer-description>span{min-width:0;overflow-wrap:anywhere}.transfer-description button{flex-shrink:0;min-height:34px;padding:5px 10px;margin-top:-3px;background:#fff;border-color:#bdd9cf;color:#087f7c;font-size:11px;box-shadow:none}
@keyframes transfer-running{to{background-position:-200% 0}}
@media(pointer:coarse){.transfer-description button{min-height:44px;min-width:80px}}
@media(prefers-reduced-motion:reduce){progress:indeterminate{animation:none}}
</style>
