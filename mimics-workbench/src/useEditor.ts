import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef } from 'vue';
import { applyThreshold, exportNifti, makeDemo, paint } from './core.ts';
import type { Axis, Change, ThresholdRange, Volume } from './core.ts';
import { colors, download, initialSegments, readFile } from './view.ts';
import type { Segment, Tool } from './view.ts';
import {fillSliceRegion} from './sliceData.ts';
import type {GrayMode} from './grayRegions.ts';
import {annotationArchive} from './exportArchive.ts';

export function useEditor() {
  const volume=shallowRef<Volume|null>(null),mask=shallowRef<Uint16Array>(new Uint16Array());
  const segments=ref<Segment[]>(initialSegments()),selected=ref(1),tool=ref<Tool>('paint');
  const diameter=ref(8),opacity=ref(.45),point=ref([0,0,0]),revision=ref(0);
  const center=ref(40),width=ref(400),thresholdMin=ref('0'),thresholdMax=ref('100'),previewEnabled=ref(true);
  const showDatasets=ref(false),status=ref('打开 NIfTI 影像，开始分割标注'),busy=ref(false),dirty=ref(false);
  const readOnly=ref(false),strokeActive=ref(false),viewBusy=computed(()=>busy.value||readOnly.value);
  const hoverPreview=ref(true),regionWidth=ref(100),regionMode=ref<GrayMode>('bands');
  const history=shallowRef<Change[]>([]),future=shallowRef<Change[]>([]),pending=new Map<number,number>();
  const active=computed(()=>segments.value.find(s=>s.id===selected.value)!);
  const minimum=computed(()=>Number(thresholdMin.value)),maximum=computed(()=>Number(thresholdMax.value));
  const thresholdValid=computed(()=>thresholdMin.value.trim()!==''&&thresholdMax.value.trim()!==''&&Number.isFinite(minimum.value)&&Number.isFinite(maximum.value)&&minimum.value<=maximum.value);
  const thresholdPreview=computed<ThresholdRange|null>(()=>tool.value==='threshold'&&thresholdValid.value&&previewEnabled.value&&active.value.visible?{minimum:minimum.value,maximum:maximum.value,label:selected.value}:null);
  // Publish edit transactions without making large voxel arrays deeply reactive.
  let onChange: ((change:Change,kind?:string)=>void)|null=null;
  function setChangeHandler(handler:typeof onChange){onChange=handler;}
  function install(v:Volume){
    mask.value=new Uint16Array(v.data.length);history.value=[];future.value=[];pending.clear();
    volume.value=v;point.value=v.dims.map(n=>Math.floor(n/2));segments.value=initialSegments();selected.value=1;
    center.value=(v.min+v.max)/2;width.value=Math.max(1,v.max-v.min);dirty.value=false;revision.value++;
    thresholdMin.value=String(v.min+(v.max-v.min)*.75);thresholdMax.value=String(v.max);previewEnabled.value=true;tool.value='paint';
    status.value=`已加载 ${v.name} · ${v.dims.join(' × ')} 体素`;
  }
  function canReplace(){return !dirty.value||window.confirm('当前标注尚未导出。继续将替换当前影像和标注，是否继续？');}
  async function load(file?:File,replaceConfirmed=false):Promise<boolean>{
    if(!file||(!replaceConfirmed&&!canReplace()))return false;
    busy.value=true;status.value='正在读取影像…';
    try{await new Promise(r=>setTimeout(r,20));install(await readFile(file));return true;}
    catch(error){status.value=`打开失败：${(error as Error).message}`;return false;}finally{busy.value=false;}
  }
  function rememberChange(change:Change){
    history.value.push(change);
    let bytes=history.value.reduce((sum,c)=>sum+c.indices.byteLength+c.before.byteLength+c.after.byteLength,0);
    while(history.value.length>1&&(bytes>64*1024*1024||history.value.length>80)){const c=history.value.shift()!;bytes-=c.indices.byteLength+c.before.byteLength+c.after.byteLength;}
    triggerRef(history);future.value=[];dirty.value=true;revision.value++;onChange?.(change);
  }
  function startStroke(){pending.clear();strokeActive.value=true;}
  function pendingChange():Change|null{
    const pairs=[...pending].filter(([i,before])=>onChange||mask.value[i]!==before);if(!pairs.length)return null;
    return {indices:Uint32Array.from(pairs.map(p=>p[0])),before:Uint16Array.from(pairs.map(p=>p[1])),after:Uint16Array.from(pairs.map(p=>mask.value[p[0]]))};
  }
  function endStroke(){
    strokeActive.value=false;
    if(!pending.size)return;
    const pairs=[...pending].filter(([i,before])=>onChange||mask.value[i]!==before);pending.clear();if(!pairs.length)return;
    rememberChange({indices:Uint32Array.from(pairs.map(p=>p[0])),before:Uint16Array.from(pairs.map(p=>p[1])),after:Uint16Array.from(pairs.map(p=>mask.value[p[0]]))});
  }
  function stroke(axis:Axis,slice:number,u:number,v:number){
    if(!volume.value||busy.value||readOnly.value)return;
    if(!active.value.visible){status.value='请先显示当前标签。';return;}
    paint(mask.value,volume.value,axis,slice,u,v,diameter.value,tool.value==='erase'?0:selected.value,pending,tool.value==='erase'?selected.value:undefined,!!onChange);revision.value++;
  }
  async function runThreshold(){
    if(!volume.value||!thresholdValid.value||!active.value.visible||busy.value||readOnly.value)return;
    endStroke();busy.value=true;status.value='正在对整套影像执行阈值分割…';
    try{
      await new Promise(resolve=>setTimeout(resolve,30));
      const {change,matched}=applyThreshold(volume.value.data,mask.value,{minimum:minimum.value,maximum:maximum.value,label:selected.value});
      if(change)rememberChange(change);tool.value='paint';
      status.value=`阈值分割完成：${minimum.value}～${maximum.value}，选中 ${matched.toLocaleString()} 个体素，${change?'已更新当前标签，可撤销':'标注无需修改'}。`;
    }catch(error){status.value=`阈值分割失败：${(error as Error).message}`;}finally{busy.value=false;}
  }
  function selectRegion(axis:Axis,slice:number,pixels:Uint32Array){
    if(!volume.value||busy.value||readOnly.value)return;if(!active.value.visible){status.value='请先显示当前标签。';return;}
    try{const change=fillSliceRegion(mask.value,volume.value.dims,axis,slice,pixels,selected.value,!!onChange);if(change)rememberChange(change);status.value=`本切片灰度区域已加入“${active.value.name}”：${pixels.length.toLocaleString()} 个像素，可撤销。`;}
    catch(reason){status.value=(reason as Error).message;}
  }
  function undo(redo=false){
    if(readOnly.value)return;
    endStroke();const from=redo?future:history,to=redo?history:future,change=from.value.pop();if(!change)return;
    const values=redo?change.after:change.before;const before=redo?change.before:change.after;
    change.indices.forEach((i,k)=>{mask.value[i]=values[k];});to.value.push(change);triggerRef(from);triggerRef(to);
    dirty.value=true;revision.value++;onChange?.({indices:change.indices,before,after:values},redo?'redo':'undo');
  }
  async function loadSegmentation(file?:File){
    if(!file||!volume.value||readOnly.value||!canReplace())return;busy.value=true;
    try{
      const seg=await readFile(file),v=volume.value;
      if(seg.dims.some((n,i)=>n!==v.dims[i])||seg.affine.some((row,r)=>row.some((n,c)=>Math.abs(n-v.affine[r][c])>1e-4)))throw new Error('标注的尺寸或空间方向与当前影像不同。');
      const next=new Uint16Array(seg.data.length),ids=new Set<number>();
      for(let i=0;i<next.length;i++){const value=seg.data[i];if(!Number.isInteger(value)||value<0||value>65535)throw new Error('标注必须是 0～65535 的整数标签。');next[i]=value;if(value)ids.add(value);}
      if(ids.size>64)throw new Error('此版本最多显示 64 个标签。');
      const previous=mask.value;mask.value=next;history.value=[];future.value=[];pending.clear();
      const list=[...ids].sort((a,b)=>a-b).map((id,i)=>({id,name:`标注 ${id}`,color:colors[i%colors.length],visible:true}));
      segments.value=list.length?list:initialSegments();selected.value=list[0]?.id||1;revision.value++;dirty.value=false;status.value='分割标签已载入。';
      if(onChange){const indices:number[]=[];next.forEach((value,i)=>{if(value!==previous[i])indices.push(i);});if(indices.length)onChange({indices:Uint32Array.from(indices),before:Uint16Array.from(indices,i=>previous[i]),after:Uint16Array.from(indices,i=>next[i])});}
    }catch(error){status.value=`导入失败：${(error as Error).message}`;}finally{busy.value=false;}
  }
  async function exportMask(){
    if(!volume.value||busy.value)return;endStroke();busy.value=true;status.value='正在压缩标注 ZIP…';
    try{const v=volume.value,archive=await annotationArchive(exportNifti(v,mask.value),segments.value,{source:v.name});download(archive,v.name.replace(/\.nii(\.gz)?$/i,'')+'-seg.zip','application/zip');dirty.value=false;status.value='已请求下载标注 ZIP，内含分割 NIfTI 和标签说明。';}
    catch(reason){status.value=`导出失败：${(reason as Error).message}`;}finally{busy.value=false;}
  }
  function addSegment(){const id=Math.max(...segments.value.map(s=>s.id))+1;if(id>65535)return;segments.value.push({id,name:`标注 ${id}`,color:colors[(id-1)%colors.length],visible:true});selected.value=id;}
  function demo(){if(canReplace())install(makeDemo());}
  function before(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue='';}}
  function key(e:KeyboardEvent){
    if((e.target as HTMLElement).matches('input,textarea,select')||busy.value||readOnly.value||showDatasets.value)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);}
    else if(e.key.toLowerCase()==='b')tool.value='paint';else if(e.key.toLowerCase()==='e')tool.value='erase';else if(e.key.toLowerCase()==='v')tool.value='navigate';else if(e.key.toLowerCase()==='g')tool.value='region';
  }
  onMounted(()=>{window.addEventListener('beforeunload',before);window.addEventListener('keydown',key);});
  onBeforeUnmount(()=>{window.removeEventListener('beforeunload',before);window.removeEventListener('keydown',key);});
  return {volume,mask,segments,selected,tool,diameter,opacity,point,revision,center,width,thresholdMin,thresholdMax,previewEnabled,showDatasets,status,busy,viewBusy,readOnly,strokeActive,dirty,history,future,active,minimum,maximum,thresholdValid,thresholdPreview,hoverPreview,regionWidth,regionMode,selectRegion,install,canReplace,load,startStroke,endStroke,pendingChange,stroke,runThreshold,undo,loadSegmentation,exportMask,addSegment,demo,setChangeHandler};
}
