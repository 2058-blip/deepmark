<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import './datasets.css';
type Dataset={id:string;name:string;folder:string;size:number;modified:string;format:string;downloadUrl:string};
const props=defineProps<{onBeforeOpen:()=>boolean;onOpen:(file:File,datasetId?:string)=>Promise<boolean>}>();
const emit=defineEmits<{close:[]}>();
const dialog=ref<HTMLDialogElement|null>(null),datasets=ref<Dataset[]>([]),loading=ref(true),error=ref(''),search=ref(''),downloading=ref<string|null>(null),progress=ref({received:0,total:0}),parsing=ref(false);
let request:AbortController|null=null;const listing=new AbortController();
function formatSize(value:number){if(value<1024)return `${value} B`;const unit=value<1024**2?'KB':value<1024**3?'MB':'GB';return `${(value/(unit==='KB'?1024:unit==='MB'?1024**2:1024**3)).toFixed(1)} ${unit}`;}
async function refresh(signal?:AbortSignal){
  loading.value=true;error.value='';
  try{const response=await fetch('/api/datasets',{cache:'no-store',signal});if(!response.ok)throw new Error('服务器暂时无法提供数据集列表，请稍后重试。');const result=await response.json();if(!Array.isArray(result.datasets))throw new Error('服务器返回的数据集列表格式无效。');datasets.value=result.datasets;}
  catch(reason){if((reason as Error).name!=='AbortError')error.value=(reason as Error).message;}finally{if(!signal?.aborted)loading.value=false;}
}
function close(){if(parsing.value)return;request?.abort();emit('close');}
onMounted(()=>{dialog.value!.showModal();void refresh(listing.signal);});onBeforeUnmount(()=>{listing.abort();request?.abort();});
async function open(dataset:Dataset){
  if(downloading.value||!props.onBeforeOpen())return;
  const controller=new AbortController();request=controller;downloading.value=dataset.id;progress.value={received:0,total:dataset.size};error.value='';
  try{
    const response=await fetch(`/api/datasets/${encodeURIComponent(dataset.id)}/download`,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error(response.status===404?'数据集已移除，请刷新列表。':'数据集下载失败，请稍后重试。');
    const total=Number(response.headers.get('Content-Length'))||dataset.size,chunks:ArrayBuffer[]=[],reader=response.body?.getReader();if(!reader)throw new Error('浏览器无法读取下载内容。');
    let received=0;while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value.slice().buffer);received+=value.byteLength;progress.value={received,total};}
    if(total&&received!==total)throw new Error('数据集下载不完整，请重试。');parsing.value=true;
    if(await props.onOpen(new File(chunks,dataset.name,{type:'application/octet-stream'}),dataset.id))emit('close');else error.value='影像未能打开，请检查文件格式。关闭此窗口可查看详细错误。';
  }catch(reason){if((reason as Error).name!=='AbortError')error.value=(reason as Error).message;}finally{request=null;downloading.value=null;parsing.value=false;}
}
const filtered=computed(()=>datasets.value.filter(item=>(item.name+' '+item.folder).toLowerCase().includes(search.value.toLowerCase())));
</script>
<template>
  <dialog ref="dialog" class="dataset-dialog" aria-labelledby="datasets-title" @cancel.prevent="close">
    <header class="datasets-header"><div><span class="eyebrow">DATA LIBRARY</span><h2 id="datasets-title">服务器数据集</h2></div><button aria-label="关闭数据集窗口" :disabled="parsing" @click="close">✕</button></header>
    <p class="datasets-description">选择需要标注的影像，下载到浏览器后直接开始工作。也可以将原文件单独下载到电脑。</p>
    <div class="datasets-toolbar"><input v-model="search" aria-label="搜索服务器数据集" placeholder="搜索文件名或分类…"/><button :disabled="loading||!!downloading" @click="refresh()">刷新列表</button></div>
    <p v-if="error" class="datasets-error" role="alert">{{error}}</p>
    <div v-if="downloading" class="dataset-progress" role="status"><span>{{parsing?'正在解析影像…':`正在下载：${datasets.find(d=>d.id===downloading)?.name}`}}</span><progress :max="progress.total||1" :value="progress.received"/><small>{{formatSize(progress.received)}} / {{formatSize(progress.total)}}<button v-if="!parsing" @click="request?.abort()">取消下载</button></small></div>
    <div class="datasets-list" :aria-busy="loading"><p v-if="loading" class="datasets-empty">正在读取数据集列表…</p>
      <template v-else-if="filtered.length"><article v-for="dataset in filtered" :key="dataset.id" class="dataset-card"><div class="dataset-file-icon">NII</div><div class="dataset-details"><h3>{{dataset.name}}</h3><p><span v-if="dataset.folder">{{dataset.folder}} · </span>{{dataset.format}} · {{formatSize(dataset.size)}}</p><small>更新于 {{new Date(dataset.modified).toLocaleString('zh-CN')}}</small></div><div class="dataset-actions"><button class="primary" :disabled="!!downloading" @click="open(dataset)">下载并标注</button><span v-if="downloading" class="download-disabled">仅下载原文件</span><a v-else :href="`/api/datasets/${encodeURIComponent(dataset.id)}/download`" :download="dataset.name">仅下载原文件 ↓</a></div></article></template>
      <div v-else class="datasets-empty"><strong>{{search?'没有匹配的数据集':'暂时没有可下载的数据集'}}</strong><p>{{search?'尝试其他关键词，或清空搜索。':'管理员添加影像后，点击“刷新列表”即可查看。'}}</p></div>
    </div><footer class="datasets-footer"><span>共 {{datasets.length}} 份影像{{search?` · 匹配 ${filtered.length} 份`:''}}</span><span>支持 .nii / .nii.gz</span></footer>
  </dialog>
</template>
