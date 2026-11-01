import {computed,onBeforeUnmount,ref,shallowRef,watch} from 'vue';
import type {Change} from './core.ts';
import {exportNifti} from './core.ts';
import {annotationArchive} from './exportArchive.ts';
import {operationId} from './operationId.ts';
import type {Segment,Tool} from './view.ts';
import {download,readFile} from './view.ts';
import type {useEditor} from './useEditor.ts';
import type {Draft,DraftIndex,Identity,LiveDelta,Operation,ParallelRegion,Person,Project,ViewState} from './collaborationTypes.ts';
import {allIdentities,allOperations,cacheDataset,listDrafts,readDataset,readDraft,saveIdentity,writeLocal,writeView} from './localCache.ts';
type History={revision:number;op:string;author:string;name:string;kind:string;time:string};
const base='/api/collaboration',sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function api<T>(path:string,data?:unknown,author?:string):Promise<T>{
  const response=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(12000),headers:{...(author?{'X-Deepmark-Author':author}:{}),...(data===undefined?{}:{'Content-Type':'application/json','X-Deepmark-Request':'1'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});
  if(!response.ok){const result=await response.json().catch(()=>({error:'网络请求失败。'}));throw Object.assign(new Error(result.error||'请求失败。'),{status:response.status});}return response.json();
}
function base64(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
function encode(change:Change){
  if(change.indices.length*8>32*1024*1024)throw new Error('单次操作超过同步上限，请缩小范围。');
  const order=Array.from(change.indices.keys()).sort((a,b)=>change.indices[a]-change.indices[b]),bytes=new Uint8Array(order.length*8),view=new DataView(bytes.buffer);
  order.forEach((k,n)=>{view.setUint32(n*8,change.indices[k],true);view.setUint16(n*8+4,change.before[k],true);view.setUint16(n*8+6,change.after[k],true);});return base64(bytes);
}
function applyLocal(mask:Uint16Array,patch:string,preserveErase=false){const bytes=Uint8Array.from(atob(patch),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);for(let n=0;n<bytes.length;n+=8){const value=view.getUint16(n+6,true);if(!preserveErase||value!==0)mask[view.getUint32(n,true)]=value;}}
async function inflateBytes(value:string){const raw=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());}
async function inflate(value:string){const bytes=await inflateBytes(value);return new Uint16Array(bytes.buffer);}
async function deflate(value:ArrayBuffer){const bytes=await new Response(new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();return base64(new Uint8Array(bytes));}
export function useCollaboration(editor:ReturnType<typeof useEditor>){
  const nickname=ref(''),person=shallowRef<Person|null>(null),project=shallowRef<Project|null>(null),history=ref<History[]>([]),historical=ref<number|null>(null);
  const syncText=ref(''),error=ref(''),cacheError=ref(''),connected=ref(false),joining=ref(false),queueCount=ref(0),showHistory=ref(false),exiting=ref(false),exitBlocked=ref(false),exitNotice=ref('');
  const drafts=ref<DraftIndex[]>([]),lastCached=ref(0),showDrafts=ref(false),highlightAnnotation=ref<string|null>(null),offlineSource=ref(false);
  const initializing=ref(true),exitTeam=ref(true);
  const blockedLocal=ref('');
  const active=computed(()=>!!project.value),unsaved=computed(()=>queueCount.value>0||!!error.value||!!cacheError.value);
  const parallelMap=computed(()=>{const map=new Map<number,number[]>();for(const region of project.value?.regions||[])for(const row of region.annotations)for(const [i,label]of row.values){if(highlightAnnotation.value&&row.id===highlightAnnotation.value)map.set(i,[label]);else if(!highlightAnnotation.value){const values=map.get(i)||[];if(!values.includes(label))values.push(label);map.set(i,values);}}return map;});
  let queue:Operation[]=[],socket:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|null=null,retry:ReturnType<typeof setTimeout>|null=null,fetching=false,sending=false,epoch=0,stopped=true,persist=Promise.resolve(),partialId:string|null=null,cacheGeneration=0,lastFetchedRevision=-1;
  type Reply={revision:number;parallelCount?:number;protectedCount?:number;duplicate?:boolean;delta?:LiveDelta;serverMs?:number};
  let ownershipBits=new Uint8Array(),ownershipKnown=false,regionSource:Project['regions']|null=null,ownOpinions=new Map<number,number>();
  const patchViews=new WeakMap<Operation,DataView>();
  const acknowledged=new Set<string>(),incoming=new Map<number,LiveDelta>();
  const waiting=new Map<string,{resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let catchingUp=false,cacheTimer:ReturnType<typeof setTimeout>|null=null,cacheWriting=false;
  const request=<T>(path:string,data?:unknown)=>api<T>(path,data,person.value?.id);
  async function readOwnership(state:Project){if(state.ownershipAuthor!==person.value?.id||!state.ownedVoxels)return null;const bits=await inflateBytes(state.ownedVoxels);if(bits.length!==Math.ceil(editor.mask.value.length/8))throw new Error('标注权限尺寸不一致。');return bits;}
  function pendingValue(index:number):number|undefined{for(let n=queue.length-1;n>=0;n--){const op=queue[n];if(op.label||acknowledged.has(op.op))continue;let patch=patchViews.get(op);if(!patch){const bytes=Uint8Array.from(atob(op.patch),c=>c.charCodeAt(0));patch=new DataView(bytes.buffer);patchViews.set(op,patch);}let lo=0,hi=patch.byteLength/8;while(lo<hi){const mid=(lo+hi)>>>1;if(patch.getUint32(mid*8,true)<index)lo=mid+1;else hi=mid;}if(lo*8<patch.byteLength&&patch.getUint32(lo*8,true)===index)return patch.getUint16(lo*8+6,true);}return undefined;}
  function personalValue(index:number,fallback:number):number|null{
    const pending=pendingValue(index);if(pending!==undefined)return pending||null;
    const regions=project.value?.regions;if(regions!==regionSource){regionSource=regions||null;ownOpinions=new Map();for(const region of regions||[])for(const row of region.annotations)if(row.author===person.value?.id)for(const [i,value]of row.values)ownOpinions.set(i,value);}
    if(ownOpinions.has(index))return ownOpinions.get(index)||null;
    return ownershipKnown&&(ownershipBits[index>>>3]&(1<<(index&7)))?fallback:null;
  }
  const draftKey=()=>person.value&&project.value?`${person.value.id}:${project.value.id}`:'';
  const captureSignatures=new WeakMap<Draft,string>();let lastFullSignature='';
  const fullSignature=()=>`${draftKey()}:${editor.revision.value}:${project.value?.revision}:${queue.length}:${JSON.stringify(editor.segments.value)}`;
  function mark(){queueCount.value=queue.length;syncText.value=queue.length?`有 ${queue.length} 笔待上传${connected.value?'':'，等待网络恢复'}`:error.value?'上传异常，工作保留在本地':connected.value?'':'连接中，可继续本地编辑';}
  async function rememberIdentity(result:{person:Person|null;resumeKey?:string}){
    if(!result.person)return;person.value=result.person;nickname.value=result.person.name;
    if(result.resumeKey)await saveIdentity({...result.person,resumeKey:result.resumeKey,updated:Date.now()});
  }
  async function ensureSession(identity?:Identity){
    const owner=identity?.id||person.value?.id;
    const desired=identity||((await allIdentities()).find(item=>item.id===person.value?.id));
    const current=await api<{person:Person|null;resumeKey?:string}>('/session');
    if(desired&&current.person?.id!==desired.id){await rememberIdentity(await api('/session',{name:desired.name,credentials:{authorId:desired.id,resumeKey:desired.resumeKey}}));}
    else if(current.person){if(owner&&current.person.id!==owner)throw new Error('缺少原作者的本地身份凭据，不能把工作提交给其他作者。');await rememberIdentity(current);}
    else throw new Error('请重新登录团队以恢复上传身份。');
  }
  const sessionReady=(async()=>{try{await rememberIdentity(await api('/session'));}catch{}const identities=await allIdentities();if(!person.value&&identities.length)nickname.value=identities.sort((a,b)=>b.updated-a.updated)[0].name;await reloadDrafts();})().catch(reason=>{cacheError.value=(reason as Error).message;}).finally(()=>{initializing.value=false;});
  async function loginTeam():Promise<boolean>{
    await sessionReady;if(person.value)return true;if(!nickname.value.trim()){error.value='请输入团队昵称。';return false;}
    joining.value=true;error.value='';exitNotice.value='';
    try{const identity=(await allIdentities()).find(item=>item.name===nickname.value.trim());if(identity)await ensureSession(identity);else await rememberIdentity(await api('/session',{name:nickname.value}));return true;}
    catch(reason){error.value=(reason as Error).message;return false;}finally{joining.value=false;}
  }
  function view():ViewState{return {point:[...editor.point.value],selected:editor.selected.value,center:editor.center.value,width:editor.width.value,diameter:editor.diameter.value,opacity:editor.opacity.value,tool:editor.tool.value,regionWidth:editor.regionWidth.value,regionMode:editor.regionMode.value,hoverPreview:editor.hoverPreview.value,zooms:[...editor.zooms.value],excludeAir:editor.excludeAir.value,airThreshold:editor.airThreshold.value};}
  function operation(change:Change,kind='edit',id:string=operationId()):Operation{
    return {key:`${draftKey()}:${id}`,project:project.value!.id,op:id,baseRevision:project.value!.revision,patch:encode(change),kind,created:Date.now(),review:false};
  }
  function capture():Draft|null{
    if(!project.value||!person.value||!editor.volume.value||historical.value!==null)return null;
    const partial=editor.pendingChange();if(!partial)partialId=null;else partialId??=operationId();
    const draft:Draft={key:draftKey(),author:{...person.value},project:{...structuredClone(project.value),mask:''},name:editor.volume.value.name,mask:editor.mask.value.slice().buffer,ownedMask:ownershipKnown?ownershipBits.slice().buffer:undefined,segments:editor.segments.value.map(s=>({...s})),view:view(),updated:Date.now(),generation:cacheGeneration,pending:partial?operation(partial,'edit',partialId!):null,needsCheckpoint:queue.length>0||!!partial||!!blockedLocal.value,blocked:blockedLocal.value};captureSignatures.set(draft,fullSignature());return draft;
  }
  function persistWrite(draft:Draft|null,op?:Operation,removeOp?:string){
    const operations=queue.map(item=>({...item}));
    const action=persist.catch(()=>{}).then(()=>writeLocal({operations,...(draft?{draft}:{}),...(op?{operation:op}:{}),...(removeOp?{removeOp}:{})}));
    persist=action.then(()=>{if(draft){lastCached.value=draft.updated;lastFullSignature=captureSignatures.get(draft)||'';}cacheError.value='';});
    void persist.catch(reason=>{cacheError.value=`本地缓存失败：${(reason as Error).message}。请先导出成果。`;});return persist;
  }
  async function cacheView(){const key=draftKey();if(!key||historical.value!==null)return;const saved=view();const action=persist.catch(()=>{}).then(()=>writeView(key,saved));persist=action;void action.catch(reason=>{cacheError.value=(reason as Error).message;});await action;}
  async function cacheNow(){if(active.value&&fullSignature()===lastFullSignature){await cacheView();return null;}const draft=capture();if(draft)await persistWrite(draft);else await persist;return draft;}
  function scheduleCache(){if(cacheTimer||cacheWriting||!active.value)return;const token=epoch;cacheTimer=setTimeout(()=>{cacheTimer=null;if(token!==epoch)return;cacheWriting=true;void cacheNow().catch(()=>{}).finally(()=>{cacheWriting=false;});},150);}
  async function reloadDrafts(){drafts.value=(await listDrafts()).sort((a,b)=>b.updated-a.updated);}
  function rejectWaiting(){for(const item of waiting.values()){clearTimeout(item.timer);item.reject(new Error('实时连接已断开，正在重试。'));}waiting.clear();}
  function detach(){epoch++;lastFetchedRevision=-1;stopped=true;socket?.close();socket=null;rejectWaiting();incoming.clear();acknowledged.clear();if(cacheTimer)clearTimeout(cacheTimer);cacheTimer=null;if(reconnect)clearTimeout(reconnect);if(retry)clearTimeout(retry);editor.setChangeHandler(null);editor.setPersonalValueHandler(null);ownershipBits=new Uint8Array();ownershipKnown=false;regionSource=null;ownOpinions.clear();editor.readOnly.value=false;project.value=null;queue=[];queueCount.value=0;connected.value=false;historical.value=null;highlightAnnotation.value=null;error.value='';syncText.value='';partialId=null;}
  function overlayLocal(){for(const op of queue)if(!acknowledged.has(op.op))applyLocal(editor.mask.value,op.patch,true);}
  function updateLabels(labels:Project['labels']){
    editor.segments.value=labels.map(label=>({...label,visible:editor.segments.value.find(s=>s.id===label.id)?.visible??true}));
    for(const op of queue)if(op.label&&!acknowledged.has(op.op)){const label=editor.segments.value.find(s=>s.id===op.label!.id);if(label){label.name=op.label.name;label.color=op.label.color;}}
    if(!labels.some(l=>l.id===editor.selected.value))editor.selected.value=labels[0].id;
  }
  function receiveDelta(event:LiveDelta){
    if(!project.value||event.projectId!==project.value.id)return;
    if(event.author===person.value?.id&&queue.some(op=>op.op===event.op))acknowledged.add(event.op);
    if(historical.value!==null){project.value={...project.value,latestRevision:Math.max(project.value.latestRevision,event.revision)};return;}
    if(event.revision<=lastFetchedRevision)return;incoming.set(event.revision,event);
    while(incoming.has(lastFetchedRevision+1)){
      const next=incoming.get(lastFetchedRevision+1)!,stroke=editor.pendingDisplayChange();incoming.delete(next.revision);
      applyLocal(editor.mask.value,next.patch);overlayLocal();if(stroke)stroke.indices.forEach((i,k)=>{editor.mask.value[i]=stroke.after[k];});
      for(const [i,author]of next.owners||[])if(ownershipKnown){if(author===person.value?.id)ownershipBits[i>>>3]|=1<<(i&7);else ownershipBits[i>>>3]&=~(1<<(i&7));}
      project.value={...project.value,mask:'',revision:next.revision,latestRevision:next.revision,regions:next.regions,labels:next.labels,status:next.status,finalizedBy:next.finalizedBy??project.value.finalizedBy,finalizedAt:next.finalizedAt??project.value.finalizedAt,finalRevision:next.finalRevision??project.value.finalRevision};lastFetchedRevision=next.revision;
      updateLabels(next.labels);editor.revision.value++;editor.readOnly.value=next.status==='finalized';editor.dirty.value=queue.some(op=>!acknowledged.has(op.op));offlineSource.value=false;
      history.value=[{revision:next.revision,op:next.op,author:next.author,name:next.name,kind:next.kind,time:next.time},...history.value.filter(item=>item.revision!==next.revision)].slice(0,100);
      error.value='';scheduleCache();
    }
    mark();if(incoming.size&&!fetching)void catchUp();
  }
  async function refresh(force=false){
    const id=project.value?.id;if(!id||fetching||exiting.value||blockedLocal.value)return;
    fetching=true;const token=epoch,expectedHistory=historical.value;
    try{
      const response=await request<Project|{unchanged:true;revision:number}>(`/projects/${id}${expectedHistory===null?force?'':`?ifRevision=${lastFetchedRevision}`:`?revision=${expectedHistory}`}`);
      if('unchanged' in response){if(token===epoch){offlineSource.value=false;error.value='';mark();}return;}
      const state=response,mask=await inflate(state.mask),owned=await readOwnership(state);
      if(token!==epoch||historical.value!==expectedHistory)return;
      if(expectedHistory===null&&state.revision<(project.value?.revision??0))return;
      if(mask.length!==editor.mask.value.length)throw new Error('服务器工程与当前影像尺寸不一致。');
      const stroke=editor.pendingDisplayChange();for(const op of queue)if(!acknowledged.has(op.op))applyLocal(mask,op.patch,true);if(stroke)stroke.indices.forEach((i,k)=>{mask[i]=stroke.after[k];});
      ownershipBits=owned||new Uint8Array(Math.ceil(mask.length/8));ownershipKnown=!!owned;
      editor.mask.value=mask;editor.revision.value++;project.value=state;offlineSource.value=false;if(expectedHistory===null)lastFetchedRevision=state.revision;
      updateLabels(state.labels);for(const revision of incoming.keys())if(revision<=state.revision)incoming.delete(revision);
      editor.readOnly.value=expectedHistory!==null||state.status==='finalized';editor.dirty.value=queue.length>0;
      scheduleCache();history.value=(await request<{events:History[]}>(`/projects/${id}/history`)).events;
      error.value='';mark();
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;mark();}}finally{fetching=false;if(incoming.has(lastFetchedRevision+1))receiveDelta(incoming.get(lastFetchedRevision+1)!);}
  }
  async function catchUp(){
    if(catchingUp||fetching||!project.value||historical.value!==null||stopped)return;catchingUp=true;const token=epoch,id=project.value.id;
    try{let more=true;while(more&&token===epoch){const result=await request<{reset?:boolean;revision:number;events?:LiveDelta[];more?:boolean}>(`/projects/${id}/events?after=${lastFetchedRevision}`);if(token!==epoch)return;if(result.reset){await refresh(true);break;}for(const event of result.events||[])receiveDelta(event);more=!!result.more;}offlineSource.value=false;error.value='';mark();}
    catch(reason){if(token===epoch){error.value=(reason as Error).message;mark();}}finally{catchingUp=false;}
  }
  function sendLive(op:Operation):Promise<Reply>{
    return new Promise((resolve,reject)=>{const channel=socket!,timer=setTimeout(()=>{waiting.delete(op.op);channel.close();reject(new Error('服务器确认超时，正在重试。'));},12000);waiting.set(op.op,{resolve,reject,timer});try{channel.send(JSON.stringify({type:op.label?'label':'operation',requestId:op.op,author:person.value!.id,operation:op.label?{...op.label,op:op.op}:op}));}catch(reason){clearTimeout(timer);waiting.delete(op.op);reject(reason);}});
  }
  async function pump(){
    if(sending||!project.value||!queue.length)return;sending=true;const token=epoch;
    try{
      while(queue.length&&token===epoch){
        const op=queue[0],result=socket?.readyState===WebSocket.OPEN&&connected.value?await sendLive(op):await request<Reply>(`/projects/${op.project}/${op.label?'labels':'operations'}`,op.label?{...op.label,op:op.op}:op);if(token!==epoch)return;
        if(result.delta)receiveDelta(result.delta);
        if(result.parallelCount)editor.status.value='存在不同标注意见，已在对应区域保留并列标注。';
        if(result.protectedCount)editor.status.value=`已保留 ${result.protectedCount} 个他人标注体素；只能删除自己的标注。`;
        queue=queue.filter(item=>item.key!==op.key);acknowledged.delete(op.op);void persistWrite(null,undefined,op.key).catch(()=>{});scheduleCache();error.value='';mark();
        if(result.duplicate&&result.revision<=lastFetchedRevision)await refresh(true);
      }
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;mark();if((reason as {status?:number}).status===401)void ensureSession().catch(()=>{});}}finally{sending=false;if(token===epoch){mark();if(queue.length)retry=setTimeout(()=>void pump(),500);}}
  }
  function enqueue(change:Change,kind='edit'){
    if(!project.value||!person.value)return;cacheGeneration++;
    try{change.before=Uint16Array.from(change.indices,(i,k)=>personalValue(i,change.before[k])??0);const op=operation(change,kind,partialId||operationId());partialId=null;queue.push(op);mark();void pump();void persistWrite(null,op).catch(()=>{});scheduleCache();}
    catch(reason){blockedLocal.value=error.value=(reason as Error).message;editor.dirty.value=true;mark();void cacheNow().catch(()=>{});}
  }
  function connect(){
    if(stopped||!project.value)return;
    const current=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${base}/socket?project=${project.value.id}`);socket=current;
    current.onmessage=event=>{
      if(socket!==current)return;const message=JSON.parse(event.data);
      if(message.type==='ready'){connected.value=true;mark();void pump();if(!ownershipKnown)void refresh(true);else if(message.revision!==lastFetchedRevision)void catchUp();}
      else if(message.type==='delta')receiveDelta(message);
      else if(message.type==='ack'||message.type==='error'){const item=waiting.get(message.requestId);if(!item)return;waiting.delete(message.requestId);clearTimeout(item.timer);if(message.type==='ack')item.resolve(message);else item.reject(Object.assign(new Error(message.message),{status:message.status}));}
      else void catchUp();
    };
    current.onclose=()=>{if(socket!==current)return;connected.value=false;rejectWaiting();mark();if(!stopped)reconnect=setTimeout(()=>{void ensureSession().then(connect).catch(()=>{reconnect=setTimeout(connect,1500);});},500);};current.onerror=()=>current.close();
  }
  function restoreView(saved:ViewState){const v=editor.volume.value;if(!v)return;editor.point.value=saved.point.map((n,a)=>Math.max(0,Math.min(v.dims[a]-1,n)));editor.selected.value=editor.segments.value.some(s=>s.id===saved.selected)?saved.selected:editor.segments.value[0].id;editor.center.value=saved.center;editor.width.value=saved.width;editor.diameter.value=saved.diameter;editor.opacity.value=saved.opacity;editor.tool.value=['paint','erase','threshold','region'].includes(saved.tool)?saved.tool as Tool:'paint';if(saved.zooms?.length===3)editor.zooms.value=saved.zooms.map(n=>Number.isFinite(n)?Math.max(.25,Math.min(8,n)):1);if(saved.excludeAir!==undefined)editor.excludeAir.value=saved.excludeAir;if(Number.isFinite(saved.airThreshold))editor.airThreshold.value=saved.airThreshold!;if(saved.regionWidth&&saved.regionWidth>=.1)editor.regionWidth.value=saved.regionWidth;if(saved.regionMode)editor.regionMode.value=saved.regionMode;if(saved.hoverPreview!==undefined)editor.hoverPreview.value=saved.hoverPreview;}
  async function attach(state:Project,draft?:Draft,offline=false){
    detach();stopped=false;project.value=state;lastFetchedRevision=offline?-1:state.revision;blockedLocal.value=draft?.blocked||'';error.value=blockedLocal.value;offlineSource.value=offline;
    queue=(await allOperations()).filter(op=>op.project===state.id&&op.key.startsWith(person.value!.id+':')).sort((a,b)=>a.created-b.created);
    if(draft?.pending&&!queue.some(op=>op.op===draft.pending!.op)){queue.push(draft.pending);await writeLocal({operation:draft.pending});}
    editor.history.value=[];editor.future.value=[];editor.setChangeHandler(enqueue);historical.value=null;
    editor.mask.value=draft&&(offline||blockedLocal.value)?new Uint16Array(draft.mask.slice(0)):await inflate(state.mask);
    const owned=offline&&draft?.ownedMask?new Uint8Array(draft.ownedMask.slice(0)):await readOwnership(state);ownershipBits=owned||new Uint8Array(Math.ceil(editor.mask.value.length/8));ownershipKnown=!!owned;editor.setPersonalValueHandler(personalValue);
    editor.segments.value=(offline&&draft?draft.segments:state.labels).map(s=>({...s,visible:('visible' in s)&&typeof s.visible==='boolean'?s.visible:true}));
    for(const op of queue){applyLocal(editor.mask.value,op.patch,true);if(op.label){const row=editor.segments.value.find(s=>s.id===op.label!.id);if(row){row.name=op.label.name;row.color=op.label.color;}}}
    if(draft)restoreView(draft.view);editor.revision.value++;editor.readOnly.value=state.status==='finalized';
    editor.dirty.value=queue.length>0;mark();connect();scheduleCache();
    if(!offline){const token=epoch;void request<{events:History[]}>(`/projects/${state.id}/history`).then(result=>{if(token===epoch)history.value=result.events;}).catch(()=>{});}
  }
  async function openProject(datasetId:string):Promise<boolean>{
    await sessionReady;if(!person.value){error.value='请先登录团队，登录后所有服务器数据集都会自动同步。';return false;}joining.value=true;error.value='';exitNotice.value='';
    try{
      const original=await readDataset(datasetId);if(!original)throw new Error('请先重新下载影像，建立完整本地缓存。');
      await ensureSession();
      const state=await request<Project>('/projects',{datasetId}),draft=await readDraft(`${person.value!.id}:${state.id}`);
      if(!await readDataset(`project:${state.id}`))await cacheDataset(`project:${state.id}`,new File([original.file],original.name));
      await attach(state,draft);
      await refresh();editor.status.value=`已加载 ${editor.volume.value?.name||'影像'} 的团队最新成果 · 修订 ${project.value?.revision??state.revision}`;return true;
    }catch(reason){detach();error.value=(reason as Error).message;return false;}finally{joining.value=false;}
  }
  async function restoreDraft(key:string){
    joining.value=true;error.value='';
    try{
      const draft=await readDraft(key);if(!draft)throw new Error('本地工作副本不存在。');const original=await readDataset(`project:${draft.project.id}`)||await readDataset(draft.project.datasetId);if(!original)throw new Error('缺少本地原始影像，请重新下载。');
      const identity=(await allIdentities()).find(item=>item.id===draft.author.id);if(!identity)throw new Error('缺少本地作者身份，不能把成果提交给其他作者。');
      editor.install(await readFile(new File([original.file],original.name)));person.value=draft.author;nickname.value=draft.author.name;
      let state:Project,offline=false;try{await ensureSession(identity);state=await request<Project>(`/projects/${draft.project.id}`);}catch{offline=true;state={...draft.project,mask:await deflate(draft.mask),labels:draft.segments};}
      await attach(state,draft,offline);
      showDrafts.value=false;editor.status.value=offline?'当前显示本地缓存；联网后获取共享完整成果并续传。':'已获取服务器最新完整成果，并恢复本地待上传操作。';return draft.project.datasetId;
    }catch(reason){error.value=(reason as Error).message;return null;}finally{joining.value=false;}
  }
  async function finishWork(logout:boolean):Promise<boolean>{
    if(exiting.value)return false;exitTeam.value=logout;exitBlocked.value=false;exitNotice.value='';
    if(!active.value){if(!logout||!person.value)return true;try{await request('/logout',{});person.value=null;return true;}catch(reason){error.value=(reason as Error).message;return false;}}
    if(historical.value!==null){historical.value=null;editor.readOnly.value=false;await refresh();}
    editor.endStroke();exiting.value=true;editor.readOnly.value=true;
    try{
      await cacheNow();if(blockedLocal.value)throw new Error(blockedLocal.value);const deadline=Date.now()+15000;
      while(queue.length||sending){if(Date.now()>deadline)throw new Error('网络上传尚未完成。');if(!sending)await pump();else await sleep(100);if(error.value&&queue.length)throw new Error(error.value);}
      await cacheNow();if(logout)await request('/logout',{});detach();if(logout)person.value=null;exitNotice.value=logout?'操作已同步，本地副本已保留，已退出团队。':'';await reloadDrafts();return true;
    }catch(reason){error.value=(reason as Error).message;exitBlocked.value=true;await cacheNow().catch(()=>{});return false;}
    finally{exiting.value=false;editor.readOnly.value=historical.value!==null||project.value?.status==='finalized';}
  }
  const saveAndExit=()=>finishWork(true),switchDataset=()=>finishWork(false),retryFinish=()=>finishWork(exitTeam.value);
  async function forceLocalExit(){try{editor.endStroke();await cacheNow();await persist;detach();if(exitTeam.value)person.value=null;exitBlocked.value=false;exitNotice.value='已保留本地完整副本和待上传操作，下次从本地缓存恢复后续传。';await reloadDrafts();}catch(reason){cacheError.value=(reason as Error).message;}}
  async function viewHistory(revision:number|null){if(queue.length||editor.strokeActive.value||exiting.value)return;if(historical.value===null)await cacheNow();if(revision===null)lastFetchedRevision=-1;historical.value=revision;editor.readOnly.value=revision!==null;await refresh();}
  async function addLabel(){if(!project.value)return;try{const result=await request<{label:Omit<Segment,'visible'>;delta?:LiveDelta}>(`/projects/${project.value.id}/labels`,{});if(result.delta)receiveDelta(result.delta);if(!editor.segments.value.some(s=>s.id===result.label.id))editor.segments.value.push({...result.label,visible:true});editor.selected.value=result.label.id;cacheGeneration++;scheduleCache();}catch(reason){error.value=(reason as Error).message;}}
  async function updateLabel(label:Segment){if(!project.value||!person.value)return;if(!label.name.trim()||label.name.length>60){label.name=project.value.labels.find(s=>s.id===label.id)?.name||`标注 ${label.id}`;error.value='标签名称不能为空，已恢复原名称。';return;}cacheGeneration++;const op:Operation={...operation({indices:new Uint32Array(),before:new Uint16Array(),after:new Uint16Array()},'label'),label:{id:label.id,name:label.name,color:label.color}};queue.push(op);editor.dirty.value=true;mark();void pump();void persistWrite(null,op).catch(()=>{});scheduleCache();}
  function exportServer(){if(!project.value||queue.length||unsaved.value)return;const params=new URLSearchParams();if(historical.value!==null)params.set('revision',String(historical.value));const a=document.createElement('a');a.href=`${base}/projects/${project.value.id}/export?${params}`;a.download='';a.click();}
  async function exportLocal(){
    if(!editor.volume.value||editor.busy.value)return;editor.endStroke();editor.busy.value=true;editor.status.value='正在压缩本地副本 ZIP…';
    try{const v=editor.volume.value,archive=await annotationArchive(exportNifti(v,editor.mask.value),editor.segments.value,{source:v.name,local:true,projectId:project.value?.id,revision:historical.value??project.value?.revision,parallelRegions:project.value?.regions});download(archive,`本地工作副本-${person.value?.name||'标注'}.zip`,'application/zip');editor.status.value='已请求下载本地副本 ZIP。';}
    catch(reason){editor.status.value=`导出失败：${(reason as Error).message}`;}finally{editor.busy.value=false;}
  }
  watch(()=>editor.strokeActive.value,value=>{if(!value)scheduleCache();});
  let viewTimer:ReturnType<typeof setTimeout>|null=null;
  watch(()=>JSON.stringify(view()),()=>{if(active.value&&historical.value===null){cacheGeneration++;if(viewTimer)clearTimeout(viewTimer);viewTimer=setTimeout(()=>void cacheView().catch(()=>{}),400);}});
  const poll=setInterval(()=>{void catchUp();},5000),partialCache=setInterval(()=>{if(editor.strokeActive.value&&active.value)void cacheNow().catch(()=>{});},700);
  const visibility=()=>{if(document.visibilityState==='hidden'&&active.value){editor.endStroke();void cacheNow().catch(()=>{});}};
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(active.value&&(queue.length||editor.strokeActive.value||cacheError.value)){editor.endStroke();void cacheNow().catch(()=>{});event.preventDefault();event.returnValue='';}};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('beforeunload',beforeUnload);
  onBeforeUnmount(()=>{void cacheNow().catch(()=>{});detach();clearInterval(poll);clearInterval(partialCache);if(viewTimer)clearTimeout(viewTimer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('beforeunload',beforeUnload);});
  const provenanceCache=new Map<string,string>();
  async function provenance(index:number):Promise<string>{
    const current=project.value;if(!current)return '';const revision=current.revision,id=current.id,token=epoch;
    for(const op of queue)if(!op.label&&!acknowledged.has(op.op)){
      let patch=patchViews.get(op);if(!patch){const bytes=Uint8Array.from(atob(op.patch),c=>c.charCodeAt(0));patch=new DataView(bytes.buffer);patchViews.set(op,patch);}
      let lo=0,hi=patch.byteLength/8;while(lo<hi){const mid=(lo+hi)>>>1;if(patch.getUint32(mid*8,true)<index)lo=mid+1;else hi=mid;}
      if(lo*8<patch.byteLength&&patch.getUint32(lo*8,true)===index)return patch.getUint16(lo*8+6,true)===0?'正在确认自己的删除操作；他人标注保留':`${person.value?.name||'本机'} · 本机未同步`;
    }
    if(offlineSource.value)return '作者未记录（离线缓存）';
    const key=`${id}:${revision}:${index}`,old=provenanceCache.get(key);if(old)return old;
    type Source={projectId:string;index:number;revision:number;label:number;author:{id:string;name:string}|null;annotations:{author:string;name:string;label:number}[]};
    const source=await request<Source>(`/projects/${id}/provenance?index=${index}&revision=${revision}${historical.value!==null?'&historical=1':''}`).catch(async reason=>{if((reason as {status?:number}).status===409&&token===epoch){await catchUp();return null;}throw reason;});
    if(!source)return '';
    if(token!==epoch||project.value?.id!==id||project.value.revision!==revision||source.projectId!==id||source.index!==index||source.revision!==revision||source.label!==editor.mask.value[index])return '';
    const label=(value:number)=>value===0?'擦除（0）':`${editor.segments.value.find(s=>s.id===value)?.name||'标签'}（${value}）`;
    const text=source.annotations.length?`并列意见：${source.annotations.map(a=>`${a.name} · ${label(a.label)}`).join('；')}`:`来自：${source.author?.name||'作者未记录'} · ${label(source.label)}`;
    provenanceCache.set(key,text);while(provenanceCache.size>300)provenanceCache.delete(provenanceCache.keys().next().value!);return text;
  }
  function focusRegion(region:ParallelRegion,annotationId?:string){editor.point.value=region.bounds.min.map((v,a)=>Math.round((v+region.bounds.max[a])/2));highlightAnnotation.value=annotationId||null;}
  return {nickname,person,project,history,historical,syncText,error,cacheError,connected,joining,initializing,sessionReady,queueCount,showHistory,active,unsaved,drafts,lastCached,showDrafts,exiting,exitBlocked,exitNotice,loginTeam,openProject,switchDataset,cacheNow,reloadDrafts,restoreDraft,saveAndExit,retryFinish,forceLocalExit,viewHistory,addLabel,updateLabel,exportServer,exportLocal,focusRegion,highlightAnnotation,parallelMap,offlineSource,provenance};
}
