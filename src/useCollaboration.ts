import { computed,onBeforeUnmount,ref,shallowRef,watch } from 'vue';
import type { Change } from './core.ts';
import type { Segment } from './view.ts';
import type { useEditor } from './useEditor.ts';
type Person={id:string;name:string};
type Project={id:string;datasetId:string;revision:number;latestRevision:number;branches:{id:string;name:string;mask:string}[];labels:Omit<Segment,'visible'>[]};
type History={revision:number;op:string;author:string;name:string;kind:string;time:string};
type Operation={key:string;project:string;op:string;branch:string;baseRevision:number;patch:string;kind:string;created:number};
const base='/api/collaboration';
async function api<T>(path:string,data?:unknown):Promise<T>{
  const response=await fetch(base+path,{cache:'no-store',...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Deepmark-Request':'1'},body:JSON.stringify(data)})});
  if(!response.ok){const body=await response.json().catch(()=>({error:'网络请求失败。'}));throw new Error(body.error||'请求失败。');}return response.json();
}
function encode(change:Change){
  if(change.indices.length*8>32*1024*1024)throw new Error('单次操作超过同步上限，请撤销并缩小操作范围。');
  const order=Array.from(change.indices.keys()).sort((a,b)=>change.indices[a]-change.indices[b]),bytes=new Uint8Array(order.length*8),view=new DataView(bytes.buffer);
  order.forEach((k,n)=>{view.setUint32(n*8,change.indices[k],true);view.setUint16(n*8+4,change.before[k],true);view.setUint16(n*8+6,change.after[k],true);});
  let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
}
function applyLocal(mask:Uint16Array,patch:string){const text=atob(patch),bytes=Uint8Array.from(text,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);for(let n=0;n<bytes.length;n+=8)mask[view.getUint32(n,true)]=view.getUint16(n+6,true);}
async function inflate(value:string){const raw=Uint8Array.from(atob(value),c=>c.charCodeAt(0));const bytes=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();return new Uint16Array(bytes);}
let database:Promise<IDBDatabase>|null=null;
function db(){return database??=new Promise((resolve,reject)=>{const request=indexedDB.open('deepmark-collaboration',1);request.onupgradeneeded=()=>request.result.createObjectStore('queue',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function disk(action:'put'|'delete'|'getAll',value?:Operation|string):Promise<Operation[]>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('queue',action==='getAll'?'readonly':'readwrite'),store=tx.objectStore('queue');const request=action==='put'?store.put(value):action==='delete'?store.delete(value as string):store.getAll();let result:Operation[]=[];request.onsuccess=()=>{if(action==='getAll')result=request.result as Operation[];};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export function useCollaboration(editor:ReturnType<typeof useEditor>){
  const nickname=ref(''),person=shallowRef<Person|null>(null),project=shallowRef<Project|null>(null),branch=ref('main'),history=ref<History[]>([]),historical=ref<number|null>(null);
  const syncText=ref('未加入协同'),error=ref(''),connected=ref(false),joining=ref(false),queueCount=ref(0),showHistory=ref(false);
  const active=computed(()=>!!project.value),unsaved=computed(()=>queueCount.value>0||!!error.value);
  let queue:Operation[]=[],socket:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|null=null,retry:ReturnType<typeof setTimeout>|null=null,fetching=false,sending=false,epoch=0,stopped=false,persist=Promise.resolve();
  void api<{person:Person|null}>('/session').then(result=>{person.value=result.person;nickname.value=result.person?.name||'';}).catch(()=>{});
  function mark(){queueCount.value=queue.length;if(queue.length)syncText.value=`${connected.value?'正在同步':'等待重连'} · ${queue.length} 笔未确认`;else syncText.value=error.value?'同步异常，存在未确认操作':connected.value?'已保存到服务器':'连接中';}
  function leave(){epoch++;stopped=true;socket?.close();socket=null;if(reconnect)clearTimeout(reconnect);if(retry)clearTimeout(retry);editor.setChangeHandler(null);editor.readOnly.value=false;project.value=null;queue=[];queueCount.value=0;connected.value=false;historical.value=null;error.value='';syncText.value='未加入协同';}
  async function refresh(){
    const id=project.value?.id;if(!id||fetching||sending||editor.strokeActive.value)return;
    fetching=true;const token=epoch,expectedBranch=branch.value,expectedHistory=historical.value;
    try{
      const state=await api<Project>(`/projects/${id}${expectedHistory===null?'':`?revision=${expectedHistory}`}`);
      const chosen=state.branches.find(b=>b.id===expectedBranch)||state.branches[0],mask=await inflate(chosen.mask);
      if(token!==epoch||editor.strokeActive.value||sending||branch.value!==expectedBranch||historical.value!==expectedHistory)return;
      if(mask.length!==editor.mask.value.length)throw new Error('服务器工程与当前影像尺寸不一致。');
      for(const op of queue)applyLocal(mask,op.patch);
      editor.mask.value=mask;editor.revision.value++;project.value=state;branch.value=chosen.id;
      editor.segments.value=state.labels.map(label=>({...label,visible:editor.segments.value.find(s=>s.id===label.id)?.visible??true}));
      if(!state.labels.some(l=>l.id===editor.selected.value))editor.selected.value=state.labels[0].id;
      editor.readOnly.value=expectedHistory!==null;editor.dirty.value=queue.length>0;mark();
      history.value=(await api<{events:History[]}>(`/projects/${id}/history`)).events;
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;syncText.value='同步失败，正在重试';}}
    finally{fetching=false;}
  }
  async function pump(){
    if(sending||!project.value||!queue.length)return;sending=true;const token=epoch;
    try{
      await persist;
      while(queue.length&&token===epoch){
        await persist;
        const op=queue[0],result=await api<{revision:number;forkId:string|null}>(`/projects/${op.project}/operations`,op);
        if(token!==epoch)return;
        await disk('delete',op.key);queue.shift();
        if(result.forkId){
          branch.value=result.forkId;
          for(const pending of queue)if(pending.branch===op.branch){pending.branch=result.forkId;await disk('put',pending);}
          editor.status.value='检测到冲突，服务器已保留两个版本；后续编辑将同步所有版本。';
        }
        if(project.value)project.value={...project.value,revision:result.revision,latestRevision:result.revision};
        error.value='';mark();
      }
    }catch(reason){if(token===epoch){error.value=(reason as Error).message;syncText.value='未保存到服务器 · 正在重试';}}
    finally{
      sending=false;if(token===epoch){mark();if(queue.length)retry=setTimeout(()=>void pump(),3000);else await refresh();}
    }
  }
  function enqueue(change:Change,kind='edit'){
    if(!project.value||!person.value)return;
    try{
      const opId=crypto.randomUUID(),op:Operation={key:`${person.value.id}:${project.value.id}:${opId}`,project:project.value.id,op:opId,branch:branch.value,baseRevision:project.value.revision,patch:encode(change),kind,created:Date.now()};
      queue.push(op);mark();
      persist=persist.then(()=>disk('put',op)).then(()=>{});void pump();
    }catch(reason){change.indices.forEach((i,k)=>{editor.mask.value[i]=change.before[k];});editor.revision.value++;error.value=(reason as Error).message;syncText.value='本次操作未同步，已恢复到操作前';}
  }
  function connect(){
    if(stopped||!project.value)return;
    socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${base}/socket?project=${project.value.id}`);
    socket.onopen=()=>{connected.value=true;mark();void pump();void refresh();};
    socket.onmessage=()=>{if(!queue.length)void refresh();};
    socket.onclose=()=>{connected.value=false;mark();if(!stopped)reconnect=setTimeout(connect,1500);};
    socket.onerror=()=>socket?.close();
  }
  async function join(datasetId:string){
    if(!nickname.value.trim()){error.value='请先输入协同昵称。';return;}
    if(!editor.canReplace())return;joining.value=true;error.value='';
    try{
      if(!person.value||person.value.name!==nickname.value.trim())person.value=(await api<{person:Person}>('/session',{name:nickname.value})).person;
      const state=await api<Project>('/projects',{datasetId});leave();stopped=false;project.value=state;branch.value=localStorage.getItem(`deepmark-branch:${state.id}`)||'main';
      queue=(await disk('getAll')).filter(op=>op.project===state.id&&op.key.startsWith(person.value!.id+':')).sort((a,b)=>a.created-b.created);queueCount.value=queue.length;
      editor.history.value=[];editor.future.value=[];editor.setChangeHandler(enqueue);await refresh();connect();
    }catch(reason){error.value=(reason as Error).message;}finally{joining.value=false;}
  }
  async function chooseBranch(id:string){if(queue.length||editor.strokeActive.value)return;branch.value=id;await refresh();}
  async function viewHistory(revision:number|null){if(queue.length||editor.strokeActive.value)return;historical.value=revision;editor.readOnly.value=revision!==null;await refresh();}
  async function addLabel(){if(!project.value)return;try{const result=await api<{label:Omit<Segment,'visible'>}>(`/projects/${project.value.id}/labels`,{});editor.segments.value.push({...result.label,visible:true});editor.selected.value=result.label.id;await refresh();}catch(reason){error.value=(reason as Error).message;}}
  async function updateLabel(label:Segment){if(!project.value)return;try{await api(`/projects/${project.value.id}/labels`,{id:label.id,name:label.name,color:label.color});await refresh();}catch(reason){error.value=(reason as Error).message;}}
  function exportServer(){if(!project.value||queue.length||unsaved.value)return;const params=new URLSearchParams({branch:branch.value});if(historical.value!==null)params.set('revision',String(historical.value));const a=document.createElement('a');a.href=`${base}/projects/${project.value.id}/export?${params}`;a.download='';a.click();}
  watch(()=>editor.strokeActive.value,value=>{if(!value&&!queue.length)void refresh();});
  watch(branch,value=>{if(project.value)localStorage.setItem(`deepmark-branch:${project.value.id}`,value);});
  const poll=setInterval(()=>{if(!queue.length)void refresh();},5000);
  onBeforeUnmount(()=>{leave();clearInterval(poll);});
  return {nickname,person,project,branch,history,historical,syncText,error,connected,joining,queueCount,showHistory,active,unsaved,join,leave,chooseBranch,viewHistory,addLabel,updateLabel,exportServer};
}
