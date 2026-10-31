import {computed,onBeforeUnmount,ref,shallowRef,watch} from 'vue';
import type {Change} from './core.ts';
import {exportNifti} from './core.ts';
import type {Segment,Tool} from './view.ts';
import {download,readFile} from './view.ts';
import type {useEditor} from './useEditor.ts';
import type {Draft,DraftIndex,Identity,Operation,Person,Project,ViewState,Workspace} from './collaborationTypes.ts';
import {allIdentities,allOperations,cacheDataset,listDrafts,readDataset,readDraft,saveIdentity,writeLocal} from './localCache.ts';
type History={revision:number;op:string;author:string;name:string;kind:string;time:string};
const base='/api/collaboration',sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function api<T>(path:string,data?:unknown,author?:string):Promise<T>{
  const response=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(12000),headers:{...(author?{'X-Deepmark-Author':author}:{}),...(data===undefined?{}:{'Content-Type':'application/json','X-Deepmark-Request':'1'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});
  if(!response.ok){const result=await response.json().catch(()=>({error:'网络请求失败。'}));throw new Error(result.error||'请求失败。');}return response.json();
}
function base64(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
function encode(change:Change){
  if(change.indices.length*8>32*1024*1024)throw new Error('单次操作超过同步上限，请缩小范围。');
  const order=Array.from(change.indices.keys()).sort((a,b)=>change.indices[a]-change.indices[b]),bytes=new Uint8Array(order.length*8),view=new DataView(bytes.buffer);
  order.forEach((k,n)=>{view.setUint32(n*8,change.indices[k],true);view.setUint16(n*8+4,change.before[k],true);view.setUint16(n*8+6,change.after[k],true);});return base64(bytes);
}
function applyLocal(mask:Uint16Array,patch:string){const bytes=Uint8Array.from(atob(patch),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);for(let n=0;n<bytes.length;n+=8)mask[view.getUint32(n,true)]=view.getUint16(n+6,true);}
async function inflate(value:string){const raw=Uint8Array.from(atob(value),c=>c.charCodeAt(0)),bytes=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();return new Uint16Array(bytes);}
async function deflate(value:ArrayBuffer){const bytes=await new Response(new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();return base64(new Uint8Array(bytes));}
export function useCollaboration(editor:ReturnType<typeof useEditor>){
  const nickname=ref(''),person=shallowRef<Person|null>(null),project=shallowRef<Project|null>(null),branch=ref('main'),history=ref<History[]>([]),historical=ref<number|null>(null);
  const syncText=ref(''),error=ref(''),cacheError=ref(''),connected=ref(false),joining=ref(false),queueCount=ref(0),showHistory=ref(false),exiting=ref(false),exitBlocked=ref(false),exitNotice=ref('');
  const workspace=shallowRef<Workspace|null>(null),drafts=ref<DraftIndex[]>([]),lastCached=ref(0),checkpointDirty=ref(true),showDrafts=ref(false);
  const blockedLocal=ref('');
  const active=computed(()=>!!project.value),unsaved=computed(()=>queueCount.value>0||!!error.value||!!cacheError.value);
  let queue:Operation[]=[],socket:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|null=null,retry:ReturnType<typeof setTimeout>|null=null,fetching=false,sending=false,epoch=0,stopped=true,persist=Promise.resolve(),partialId:string|null=null,cacheGeneration=0;
  const request=<T>(path:string,data?:unknown)=>api<T>(path,data,person.value?.id);
  const draftKey=()=>person.value&&project.value?`${person.value.id}:${project.value.id}`:'';
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
    else throw new Error('请重新加入协同以恢复上传身份。');
  }
  void (async()=>{try{await rememberIdentity(await api('/session'));}catch{}const identities=await allIdentities();if(!person.value&&identities.length)nickname.value=identities.sort((a,b)=>b.updated-a.updated)[0].name;await reloadDrafts();})().catch(reason=>{cacheError.value=(reason as Error).message;});
  function view():ViewState{return {point:[...editor.point.value],selected:editor.selected.value,center:editor.center.value,width:editor.width.value,diameter:editor.diameter.value,opacity:editor.opacity.value,tool:editor.tool.value};}
  function operation(change:Change,kind='edit',id:string=crypto.randomUUID()):Operation{
    return {key:`${draftKey()}:${id}`,project:project.value!.id,op:id,branch:branch.value,baseRevision:project.value!.revision,patch:encode(change),kind,created:Date.now()};
  }
  function capture():Draft|null{
    if(!project.value||!person.value||!editor.volume.value||historical.value!==null)return null;
    const partial=editor.pendingChange();if(!partial)partialId=null;else partialId??=crypto.randomUUID();
    return {key:draftKey(),author:{...person.value},project:structuredClone(project.value),branch:branch.value,name:editor.volume.value.name,mask:editor.mask.value.slice().buffer,segments:editor.segments.value.map(s=>({...s})),view:view(),updated:Date.now(),generation:cacheGeneration,pending:partial?operation(partial,'edit',partialId!):null,needsCheckpoint:checkpointDirty.value,blocked:blockedLocal.value};
  }
  function persistWrite(draft:Draft|null,op?:Operation,removeOp?:string){
    const operations=queue.map(item=>({...item}));
    const action=persist.catch(()=>{}).then(()=>writeLocal({operations,...(draft?{draft}:{}),...(op?{operation:op}:{}),...(removeOp?{removeOp}:{})}));
    persist=action.then(()=>{if(draft)lastCached.value=draft.updated;cacheError.value='';});
    void persist.catch(reason=>{cacheError.value=`本地缓存失败：${(reason as Error).message}。请先导出成果。`;});return persist;
  }
  async function cacheNow(){const draft=capture();if(draft)await persistWrite(draft);else await persist;return draft;}
  async function reloadDrafts(){drafts.value=(await listDrafts()).sort((a,b)=>b.updated-a.updated);}
  function detach(){epoch++;stopped=true;socket?.close();socket=null;if(reconnect)clearTimeout(reconnect);if(retry)clearTimeout(retry);editor.setChangeHandler(null);editor.readOnly.value=false;project.value=null;queue=[];queueCount.value=0;connected.value=false;historical.value=null;workspace.value=null;error.value='';syncText.value='';partialId=null;}
  async function refresh(){
    const id=project.value?.id;if(!id||fetching||sending||editor.strokeActive.value||exiting.value||blockedLocal.value)return;
    fetching=true;const token=epoch,expectedBranch=branch.value,expectedHistory=historical.value;
    try{
      const state=await request<Project>(`/projects/${id}${expectedHistory===null?'':`?revision=${expectedHistory}`}`),chosen=state.branches.find(b=>b.id===expectedBranch)||state.branches[0],mask=await inflate(chosen.mask);
      if(token!==epoch||editor.strokeActive.value||sending||branch.value!==expectedBranch||historical.value!==expectedHistory)return;
      if(expectedHistory===null&&state.revision<(project.value?.revision??0))return;
      if(mask.length!==editor.mask.value.length)throw new Error('服务器工程与当前影像尺寸不一致。');
      for(const op of queue)applyLocal(mask,op.patch);
      editor.mask.value=mask;editor.revision.value++;project.value=state;branch.value=chosen.id;
      editor.segments.value=state.labels.map(label=>({...label,visible:editor.segments.value.find(s=>s.id===label.id)?.visible??true}));
      for(const op of queue)if(op.label){const label=editor.segments.value.find(s=>s.id===op.label!.id);if(label){label.name=op.label.name;label.color=op.label.color;}}
      if(!state.labels.some(l=>l.id===editor.selected.value))editor.selected.value=state.labels[0].id;
      editor.readOnly.value=expectedHistory!==null;editor.dirty.value=queue.length>0;
      await cacheNow();history.value=(await request<{events:History[]}>(`/projects/${id}/history`)).events;
      error.value='';mark();
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;mark();}}finally{fetching=false;}
  }
  async function pump(){
    if(sending||!project.value||!queue.length)return;sending=true;const token=epoch;
    try{
      await persist;await ensureSession();
      while(queue.length&&token===epoch){
        await persist;const op=queue[0],result=await request<{revision:number;forkId:string|null}>(`/projects/${op.project}/${op.label?'labels':'operations'}`,op.label?{...op.label,op:op.op}:op);if(token!==epoch)return;
        if(result.forkId){branch.value=result.forkId;for(const pending of queue.slice(1))if(pending.branch===op.branch){pending.branch=result.forkId;await writeLocal({operation:pending});}editor.status.value='检测到冲突，两个版本均已保留。';}
        if(project.value)project.value={...project.value,revision:result.revision,latestRevision:result.revision};
        queue.shift();await persistWrite(capture(),undefined,op.key);error.value='';mark();
      }
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;mark();}}finally{sending=false;if(token===epoch){mark();if(queue.length)retry=setTimeout(()=>void pump(),3000);else if(!exiting.value)await refresh();}}
  }
  function enqueue(change:Change,kind='edit'){
    if(!project.value||!person.value)return;cacheGeneration++;checkpointDirty.value=true;
    try{const op=operation(change,kind);queue.push(op);mark();void persistWrite(capture(),op).then(()=>pump()).catch(()=>{});}
    catch(reason){blockedLocal.value=error.value=(reason as Error).message;editor.dirty.value=true;mark();void cacheNow().catch(()=>{});}
  }
  function connect(){
    if(stopped||!project.value)return;
    socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${base}/socket?project=${project.value.id}`);
    socket.onopen=()=>{connected.value=true;mark();void pump();void refresh();};socket.onmessage=()=>{if(!queue.length)void refresh();};
    socket.onclose=()=>{connected.value=false;mark();if(!stopped)reconnect=setTimeout(()=>{void ensureSession().then(connect).catch(()=>{reconnect=setTimeout(connect,3000);});},1500);};socket.onerror=()=>socket?.close();
  }
  function restoreView(saved:ViewState){const v=editor.volume.value;if(!v)return;editor.point.value=saved.point.map((n,a)=>Math.max(0,Math.min(v.dims[a]-1,n)));editor.selected.value=editor.segments.value.some(s=>s.id===saved.selected)?saved.selected:editor.segments.value[0].id;editor.center.value=saved.center;editor.width.value=saved.width;editor.diameter.value=saved.diameter;editor.opacity.value=saved.opacity;editor.tool.value=['paint','erase','navigate','threshold'].includes(saved.tool)?saved.tool as Tool:'paint';}
  async function attach(state:Project,draft?:Draft){
    detach();stopped=false;project.value=state;branch.value=draft?.branch||'main';checkpointDirty.value=draft?.needsCheckpoint??true;blockedLocal.value=draft?.blocked||'';error.value=blockedLocal.value;
    queue=(await allOperations()).filter(op=>op.project===state.id&&op.key.startsWith(person.value!.id+':')).sort((a,b)=>a.created-b.created);
    if(draft?.pending&&!queue.some(op=>op.op===draft.pending!.op)){queue.push(draft.pending);await writeLocal({operation:draft.pending});}
    editor.history.value=[];editor.future.value=[];editor.setChangeHandler(enqueue);historical.value=null;
    if(draft){editor.mask.value=new Uint16Array(draft.mask.slice(0));editor.segments.value=draft.segments.map(s=>({...s}));restoreView(draft.view);editor.revision.value++;}
    else{
      const b=state.branches[0];editor.mask.value=await inflate(b.mask);editor.segments.value=state.labels.map(s=>({...s,visible:true}));for(const op of queue)applyLocal(editor.mask.value,op.patch);editor.revision.value++;
    }
    editor.dirty.value=queue.length>0;mark();await cacheNow();connect();
  }
  async function join(datasetId:string){
    if(!nickname.value.trim()){error.value='请先输入协同昵称。';return;}if(!editor.canReplace())return;joining.value=true;error.value='';
    try{
      const original=await readDataset(datasetId);if(!original)throw new Error('请先重新下载影像，建立完整本地缓存。');
      const identity=(await allIdentities()).find(item=>item.name===nickname.value.trim());
      if(identity)await ensureSession(identity);else if(!person.value||person.value.name!==nickname.value.trim())await rememberIdentity(await api('/session',{name:nickname.value}));else await ensureSession();
      const state=await request<Project>('/projects',{datasetId}),draft=await readDraft(`${person.value!.id}:${state.id}`);
      if(!await readDataset(`project:${state.id}`))await cacheDataset(`project:${state.id}`,new File([original.file],original.name));
      await attach(state,draft);
      workspace.value=await request<Workspace>(`/projects/${state.id}/workspace`);
      if(!draft&&workspace.value.checkpoint){restoreView(workspace.value.checkpoint.view);branch.value=workspace.value.checkpoint.branch;}
      await refresh();
    }catch(reason){error.value=(reason as Error).message;}finally{joining.value=false;}
  }
  async function restoreDraft(key:string){
    joining.value=true;error.value='';
    try{
      const draft=await readDraft(key);if(!draft)throw new Error('本地工作副本不存在。');const original=await readDataset(`project:${draft.project.id}`)||await readDataset(draft.project.datasetId);if(!original)throw new Error('缺少本地原始影像，请重新下载。');
      const identity=(await allIdentities()).find(item=>item.id===draft.author.id);if(!identity)throw new Error('缺少本地作者身份，不能把成果提交给其他作者。');
      editor.install(await readFile(new File([original.file],original.name)));person.value=draft.author;nickname.value=draft.author.name;await attach(draft.project,draft);
      showDrafts.value=false;editor.status.value='已恢复完整本地工作副本；网络恢复后自动续传。';return draft.project.datasetId;
    }catch(reason){error.value=(reason as Error).message;return null;}finally{joining.value=false;}
  }
  async function saveCheckpoint(){
    const id=project.value?.id;if(!id)return;const draft=await cacheNow();if(!draft)throw new Error('请返回实时编辑后保存个人成果。');
    await ensureSession();const own=await request<Workspace>(`/projects/${id}/workspace`),snapshot=await deflate(draft.mask);
    const result=await request<{generation:number;updated:string}>(`/projects/${id}/workspace`,{id:crypto.randomUUID(),generation:own.generation,revision:draft.project.revision,branch:draft.branch,view:draft.view,labels:draft.segments,snapshot});
    if(cacheGeneration===draft.generation){checkpointDirty.value=false;draft.needsCheckpoint=false;await persistWrite(draft);}
    workspace.value={...own,generation:result.generation,updated:result.updated};
  }
  async function saveAndExit():Promise<boolean>{
    if(!active.value)return true;if(exiting.value)return false;exitBlocked.value=false;exitNotice.value='';
    if(historical.value!==null){historical.value=null;editor.readOnly.value=false;await refresh();}
    editor.endStroke();exiting.value=true;editor.readOnly.value=true;
    try{
      await cacheNow();if(blockedLocal.value)throw new Error(blockedLocal.value);const deadline=Date.now()+15000;
      while(queue.length||sending){if(Date.now()>deadline)throw new Error('网络上传尚未完成。');if(!sending)await pump();else await sleep(100);if(error.value&&queue.length)throw new Error(error.value);}
      // Refresh the final shared view before creating the private checkpoint.
      exiting.value=false;await refresh();exiting.value=true;editor.readOnly.value=true;await saveCheckpoint();
      await request('/logout',{});detach();person.value=null;exitNotice.value='个人成果已归档，已退出协同。';await reloadDrafts();return true;
    }catch(reason){error.value=(reason as Error).message;exitBlocked.value=true;await cacheNow().catch(()=>{});return false;}
    finally{exiting.value=false;editor.readOnly.value=historical.value!==null;}
  }
  async function forceLocalExit(){try{editor.endStroke();await cacheNow();await persist;detach();person.value=null;exitBlocked.value=false;exitNotice.value='已保留本地完整副本和待上传操作，下次从本地缓存恢复后续传。';await reloadDrafts();}catch(reason){cacheError.value=(reason as Error).message;}}
  async function chooseBranch(id:string){if(queue.length||editor.strokeActive.value||exiting.value)return;await cacheNow();branch.value=id;await refresh();}
  async function viewHistory(revision:number|null){if(queue.length||editor.strokeActive.value||exiting.value)return;if(historical.value===null)await cacheNow();historical.value=revision;editor.readOnly.value=revision!==null;await refresh();}
  async function addLabel(){if(!project.value)return;try{const result=await request<{label:Omit<Segment,'visible'>}>(`/projects/${project.value.id}/labels`,{});editor.segments.value.push({...result.label,visible:true});editor.selected.value=result.label.id;checkpointDirty.value=true;cacheGeneration++;await refresh();}catch(reason){error.value=(reason as Error).message;}}
  async function updateLabel(label:Segment){if(!project.value||!person.value)return;if(!label.name.trim()||label.name.length>60){label.name=project.value.labels.find(s=>s.id===label.id)?.name||`标注 ${label.id}`;error.value='标签名称不能为空，已恢复原名称。';return;}checkpointDirty.value=true;cacheGeneration++;const op:Operation={...operation({indices:new Uint32Array(),before:new Uint16Array(),after:new Uint16Array()},'label'),label:{id:label.id,name:label.name,color:label.color}};queue.push(op);editor.dirty.value=true;mark();try{await persistWrite(capture(),op);void pump();}catch(reason){cacheError.value=(reason as Error).message;}}
  function exportServer(){if(!project.value||queue.length||unsaved.value)return;const params=new URLSearchParams({branch:branch.value});if(historical.value!==null)params.set('revision',String(historical.value));const a=document.createElement('a');a.href=`${base}/projects/${project.value.id}/export?${params}`;a.download='';a.click();}
  async function exportPersonal(){if(!project.value)return;try{await ensureSession();const response=await fetch(`${base}/projects/${project.value.id}/workspace/export`,{headers:{'X-Deepmark-Author':person.value!.id}});if(!response.ok)throw new Error('个人成果暂时无法下载。');download(await response.arrayBuffer(),`个人成果-${person.value!.name}.nii`);}catch(reason){error.value=(reason as Error).message;}}
  function exportLocal(){if(editor.volume.value)download(exportNifti(editor.volume.value,editor.mask.value),`本地工作副本-${person.value?.name||'标注'}.nii`);}
  watch(()=>editor.strokeActive.value,value=>{if(!value&&!queue.length)void refresh();});
  let viewTimer:ReturnType<typeof setTimeout>|null=null;
  watch(()=>JSON.stringify(view()),()=>{if(active.value&&historical.value===null){checkpointDirty.value=true;cacheGeneration++;if(viewTimer)clearTimeout(viewTimer);viewTimer=setTimeout(()=>void cacheNow().catch(()=>{}),400);}});
  const poll=setInterval(()=>{if(!queue.length)void refresh();},5000),partialCache=setInterval(()=>{if(editor.strokeActive.value&&active.value)void cacheNow().catch(()=>{});},700);
  const visibility=()=>{if(document.visibilityState==='hidden'&&active.value){editor.endStroke();void cacheNow().catch(()=>{});}};
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(active.value&&(queue.length||checkpointDirty.value||cacheError.value)){editor.endStroke();void cacheNow().catch(()=>{});event.preventDefault();event.returnValue='';}};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('beforeunload',beforeUnload);
  onBeforeUnmount(()=>{void cacheNow().catch(()=>{});detach();clearInterval(poll);clearInterval(partialCache);if(viewTimer)clearTimeout(viewTimer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('beforeunload',beforeUnload);});
  return {nickname,person,project,branch,history,historical,syncText,error,cacheError,connected,joining,queueCount,showHistory,active,unsaved,workspace,drafts,lastCached,showDrafts,checkpointDirty,exiting,exitBlocked,exitNotice,join,cacheNow,reloadDrafts,restoreDraft,saveAndExit,forceLocalExit,saveCheckpoint,chooseBranch,viewHistory,addLabel,updateLabel,exportServer,exportPersonal,exportLocal};
}
