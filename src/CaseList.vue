<script setup lang="ts">
import {computed,ref} from 'vue';
import type {Dataset} from './api.ts';
import './caseList.css';

type CaseInfo={file:string;patient?:string;description?:string};
type Row=Dataset&{path:string;patient:string;description:string};
const props=withDefaults(defineProps<{datasets:Dataset[];loading:boolean;busy?:boolean;selectedId?:string|null;metadata?:CaseInfo[];totalCount?:number;emptyMessage?:string}>(),{busy:false,selectedId:null,metadata:()=>[],emptyMessage:'发布影像或调整筛选条件后，可在这里查看任务。'});
const emit=defineEmits<{refresh:[]}>();
const patientQuery=ref(''),descQuery=ref(''),sort=ref<'newest'|'oldest'|'patient'>('newest');
const pathOf=(dataset:Dataset)=>dataset.folder?`${dataset.folder}/${dataset.name}`:dataset.name;
const normalized=(value:string)=>value.replace(/\\/g,'/').replace(/^\/+/, '');
const rows=computed<Row[]>(()=>{
  const exact=new Map(props.metadata.map(info=>[normalized(info.file),info]));
  const byName=new Map<string,CaseInfo|null>();
  for(const info of props.metadata){const name=normalized(info.file).split('/').pop()!;byName.set(name,byName.has(name)?null:info);}
  return props.datasets.map(dataset=>{
    const path=pathOf(dataset),info=exact.get(normalized(path))||byName.get(dataset.name);
    return {...dataset,path,patient:info?.patient?.trim()||'',description:info?.description?.trim()||''};
  });
});
const registered=computed(()=>rows.value.filter(row=>row.patient||row.description).length);
const filtered=computed(()=>{
  const patient=patientQuery.value.trim().toLowerCase(),description=descQuery.value.trim().toLowerCase();
  const items=rows.value.filter(row=>(!patient||row.patient.toLowerCase().includes(patient))&&(!description||row.description.toLowerCase().includes(description)));
  const time=(row:Row)=>Date.parse(row.modified)||0;
  return items.sort((a,b)=>sort.value==='patient'?(a.patient||'\uffff').localeCompare(b.patient||'\uffff','zh-CN')||a.name.localeCompare(b.name,'zh-CN'):sort.value==='oldest'?time(a)-time(b):time(b)-time(a));
});
const pad=(value:number)=>String(value).padStart(2,'0');
function formatDate(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?'—':`${date.getFullYear()} // ${pad(date.getMonth()+1)} / ${pad(date.getDate())}  ${pad(date.getHours())}:${pad(date.getMinutes())}`;}
function formatSize(size:number){return size>=1024**3?`${(size/1024**3).toFixed(2)} GB`:size>=1024**2?`${(size/1024**2).toFixed(1)} MB`:`${Math.max(1,Math.ceil(size/1024))} KB`;}
function stateName(status:Dataset['status']){return {unassigned:'未标注',in_progress:'进行中',completed:'已完成'}[status]||status;}
</script>

<template>
  <div class="case-list-view">
    <div class="case-toolbar">
      <span class="case-count">共 {{pad(rows.length)}} 份影像 · 已登记 {{pad(registered)}} 份资料</span>
      <label class="case-sort"><span class="visually-hidden">排序方式</span><select v-model="sort" aria-label="排序方式"><option value="newest">最近修改：新 → 旧</option><option value="oldest">最近修改：旧 → 新</option><option value="patient">按患者排序</option></select></label>
      <button :disabled="loading||busy" @click="emit('refresh')">刷新列表</button>
    </div>
    <section class="case-card" aria-label="病例任务列表" :aria-busy="loading">
      <p v-if="loading" class="console-empty">正在读取病例列表…</p>
      <div v-else-if="!rows.length" class="console-empty"><strong>{{totalCount?'没有匹配的数据集':'这里还没有数据集'}}</strong><p>{{emptyMessage}}</p></div>
      <table v-else class="case-table">
        <thead><tr>
          <th class="col-patient"><div class="th-search"><span>患者</span><input v-model="patientQuery" type="search" aria-label="搜索患者" placeholder="姓名或编号"/></div></th>
          <th class="col-desc"><div class="th-search"><span>CT 描述</span><input v-model="descQuery" type="search" aria-label="搜索 CT 描述" placeholder="部位、检查方式"/></div></th>
          <th class="col-file">影像与任务</th><th class="col-date">最近修改</th><th class="col-action"><span class="visually-hidden">操作</span></th>
        </tr></thead>
        <tbody>
          <tr v-if="!filtered.length" class="no-match"><td colspan="5"><strong>没有匹配的病例</strong><span>尝试其他关键词，或清空列筛选。</span></td></tr>
          <tr v-for="(row,index) in filtered" :key="row.id" :class="['console-dataset',{selected:selectedId===row.id}]">
            <td class="col-patient" data-label="患者"><div class="patient-cell"><span class="row-index">{{pad(index+1)}}</span><span v-if="row.patient" class="patient-name">{{row.patient}}</span><span v-else class="placeholder">未登记患者</span></div></td>
            <td class="col-desc" data-label="CT 描述"><span v-if="row.description" class="case-desc" :title="row.description">{{row.description}}</span><span v-else class="placeholder">暂无描述</span></td>
            <td class="col-file" data-label="影像与任务"><div class="case-file-heading"><strong class="file-name" :title="row.path">{{row.name}}</strong><span :class="['console-status',row.status]">{{stateName(row.status)}}</span></div><small>{{formatSize(row.size)}} · {{row.format}}<span v-if="row.groupName"> · {{row.groupName}}</span><span v-if="row.revision!==undefined"> · 修订 {{row.revision}}</span></small></td>
            <td class="col-date" data-label="最近修改"><time :datetime="row.modified">{{formatDate(row.modified)}}</time></td>
            <td class="col-action" data-label="任务操作"><div class="console-dataset-actions row-actions"><slot name="actions" :dataset="row"/></div></td>
          </tr>
        </tbody>
      </table>
    </section>
    <p v-if="registered" class="case-metadata-note">患者与 CT 描述为可选展示资料；任务状态、可访问影像和操作权限以服务器为准。</p>
  </div>
</template>
