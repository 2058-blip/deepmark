import {computed,ref,shallowRef,watch,onScopeDispose} from 'vue';
import type {AuthUser,Dataset} from '../api.ts';
import {api,authenticatedFetch,responseError,loadCurrentUser} from '../api.ts';
import type {useWorkbench} from '../../mimics-workbench/src/mimics/useWorkbench.ts';
import type {ProjectState} from '../../mimics-workbench/src/mimics/project.ts';
import {WorkbenchOutbox} from './outbox.ts';
import type {WorkbenchOperation} from './outbox.ts';
import {WorkbenchClaims} from './claims.ts';
import {diffMaskPackets,applyMaskPackets,readMaskRuns,sameMaskPackets} from './maskRuns.ts';
import type {VoxelBounds} from './maskRuns.ts';
import {WORKBENCH_BASE,COLLECTIONS,WorkbenchResources,readMaskSnapshot,maskSnapshotPackets,metadataChanges,hasMetadataChanges,applyMetadata,nativeState} from './wire.ts';
import type {Manifest,SharedWorkbench,SharedEvent} from './wire.ts';

function same(a:any,b:any):boolean{
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||ArrayBuffer.isView(a)||ArrayBuffer.isView(b))return false;
  const keys=Object.keys(a),other=Object.keys(b);return keys.length===other.length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
}
function sharedEqual(a:ProjectState,b:ProjectState){
  if(a.name!==b.name||a.resliceTransform!==b.resliceTransform)return false;
  for(const key of COLLECTIONS){
    const before=a[key]||[],after=b[key]||[];if(before.length!==after.length)return false;
    for(let i=0;i<before.length;i++){
      const x=before[i] as any,y=after[i] as any;if(x===y)continue;
      const keys=Object.keys(x).filter(key=>key!=='visible'&&key!=='opacity'),other=Object.keys(y).filter(key=>key!=='visible'&&key!=='opacity');
      if(keys.length!==other.length||keys.some(key=>!same(x[key],y[key])))return false;
    }
  }
  return true;
}
async function copyMask(source:Uint8Array){const result=new Uint8Array(source.length);let lastYield=performance.now();for(let start=0;start<source.length;start+=4*1024*1024){result.set(source.subarray(start,Math.min(source.length,start+4*1024*1024)),start);if(performance.now()-lastYield>=6&&start+4*1024*1024<source.length){await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}}return result;}
function operationId(){return globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
type Editor=ReturnType<typeof useWorkbench>;

/** Account, permissions, result transport and view projection wrap the frozen editor. */
export function useTeamWorkbench(editor:Editor,user:AuthUser,dataset:Dataset){
  const project=shallowRef<SharedWorkbench|null>(null),connected=ref(false),initializing=ref(true),queueCount=ref(0),sending=ref(false),error=ref(''),notice=ref(''),localMode=ref(false);
  const members=ref<AuthUser[]>([]),history=ref<SharedEvent[]>([]),legacyHistory=ref<SharedEvent[]>([]),sourceData=shallowRef<Float32Array|null>(null),encoding=ref(0),recoveryBlocked=ref(false),viewingHistory=ref(false);
  const outbox=new WorkbenchOutbox(user.id),claims=new WorkbenchClaims(),authority=new Map<string,Uint8Array>();
  const draftHints=new WeakMap<Uint8Array,{source:Uint8Array;bounds:VoxelBounds}>();
  const delayedClaims:{mask:string;author:string;packet:Uint8Array}[]=[];
  const ownedAfter=new Map<string,WeakRef<ProjectState>>();
  const ownedBefore=new Map<string,WeakRef<ProjectState>>();
  let resources:WorkbenchResources|null=null,manifest:Manifest|null=null,socket:WebSocket|null=null,stopped=false,applying=false,pumping=false,refreshing=false,deferred=false;
  let serial=Promise.resolve(),network=Promise.resolve(),projection=Promise.resolve(),clock=0,retry:ReturnType<typeof setTimeout>|null=null,reconnect:ReturnType<typeof setTimeout>|null=null,poll:ReturnType<typeof setInterval>|null=null;
  let accessRevoked=false;
  let pointer=false;
  let lastNative=editor.state.value,requestedKind='',editorBaseRevision=0;
  let lastUnit=0;
  const revisionBases=new Map<number,number>();
  const selectionOverrides=new Map<string,string>();
  const canWrite=computed(()=>!initializing.value&&!localMode.value&&!recoveryBlocked.value&&!!project.value?.canWrite&&project.value.datasetStatus!=='completed');
  const activeGesture=()=>pointer||!!editor.draft.value||!!editor.mpr.brushPreview.value||!!editor.draftPoints.value.length||!!editor.mpr.contourDraft.value||!!editor.measurementEditor.draft.value||editor.busy.value;
  const pending=computed(()=>queueCount.value+encoding.value>0);
  const base=()=>WORKBENCH_BASE+'/'+project.value!.id;
  async function recount(){if(project.value)queueCount.value=(await outbox.list(project.value.id)).length;}
  function protectDraft(data:Uint8Array|null,bounds:VoxelBounds|null|undefined){
    const mask=editor.activeMask.value,volume=editor.volume.value;if(!data||!mask||!volume||!bounds||!canWrite.value)return;
    const [dx,dy]=volume.dims;
    if(claims.hasForeign(mask.id,user.id))for(let z=bounds.min[2];z<=bounds.max[2];z++)for(let y=bounds.min[1];y<=bounds.max[1];y++)for(let x=bounds.min[0];x<=bounds.max[0];x++){
        const i=x+dx*(y+dy*z);if(!data[i]&&claims.foreignAt(mask.id,user.id,i))data[i]=1;
      }
    draftHints.set(data,{source:mask.data,bounds:{min:[...bounds.min],max:[...bounds.max]}});
  }
  watch([editor.draftRevision,editor.draftBounds],()=>protectDraft(editor.draft.value,editor.draftBounds.value),{flush:'sync'});
  watch([editor.mpr.brushPreviewRevision,editor.mpr.brushBounds],()=>protectDraft(editor.mpr.brushPreview.value,editor.mpr.brushBounds.value),{flush:'sync'});
  function changedDraft(data:Uint8Array|null){
    if(!data)return false;const hint=draftHints.get(data);if(!hint)return true;const volume=editor.volume.value!;
    for(let z=hint.bounds.min[2];z<=hint.bounds.max[2];z++)for(let y=hint.bounds.min[1];y<=hint.bounds.max[1];y++)for(let x=hint.bounds.min[0];x<=hint.bounds.max[0];x++){
      const i=x+volume.dims[0]*(y+volume.dims[1]*z);if(data[i]!==hint.source[i])return true;
    }
    return false;
  }
  const end=editor.brushEnd;
  editor.brushEnd=()=>{if(canWrite.value&&editor.draft.value&&!changedDraft(editor.draft.value)){editor.brushCancel();notice.value='未删除其他作者的标注';}else end();};
  const endMpr=editor.mpr.endBrush;
  editor.mpr.endBrush=change=>{if(canWrite.value&&editor.mpr.brushPreview.value&&!changedDraft(editor.mpr.brushPreview.value)){editor.mpr.cancelBrushGesture(change);notice.value='未删除其他作者的标注';return false;}return endMpr(change);};
  const deleteMask=editor.deleteMask;
  editor.deleteMask=()=>{const id=editor.activeMask.value?.id;if(canWrite.value&&id&&claims.hasForeign(id,user.id)){notice.value='该 Mask 包含其他作者的标注，不能删除';return;}deleteMask();};
  watch(editor.volume,volume=>{
    if(project.value&&sourceData.value&&volume&&volume.data!==sourceData.value&&!initializing.value){
      localMode.value=true;connected.value=false;socket?.close();if(poll)clearInterval(poll);notice.value='已打开本地派生工程；原协同工程保留在服务器';}
  },{flush:'sync'});
  const undo=editor.undo;
  editor.undo=redo=>{requestedKind=redo?'重做':'撤销';try{undo(redo);}finally{requestedKind='';}};
  watch(editor.revision,()=>{
    const after=editor.state.value,before=lastNative;lastNative=after;
    const beforeUnit=lastUnit,afterUnit=editor.volume.value?(editor.volume.value.header[123]!&7):0;lastUnit=afterUnit;
    revisionBases.set(editor.revision.value,applying?project.value?.revision||0:editorBaseRevision);
    if(applying||initializing.value||localMode.value||!project.value)return;
    if(!canWrite.value){void projectView();return;}
    if(beforeUnit===afterUnit&&sharedEqual(before,after))return;
    // Algorithm outcomes may replace whole Masks. Restore foreign contributions
    // in the owned result array, never in input/history-before/source arrays.
    for(const mask of after.masks){
      const old=before.masks.find(item=>item.id===mask.id);
      if(old&&old.data!==mask.data&&!draftHints.has(mask.data))claims.protect(mask.id,user.id,mask.data);
    }
    const captured=project.value,volume=editor.volume.value,baseRevision=editorBaseRevision;
    if(!volume)return;
    const op=operationId(),kind=beforeUnit!==afterUnit?'确认空间单位':requestedKind||editor.undoName.value||'标注',nativeRevision=editor.revision.value;ownedAfter.set(op,new WeakRef(after));ownedBefore.set(op,new WeakRef(before));encoding.value++;
    serial=serial.then(async()=>{
      const operation:WorkbenchOperation={key:captured.id+':'+op,project:captured.id,op,baseRevision,kind,changes:{},created:clock=Math.max(clock+1,Date.now()),parts:0,status:'encoding',nativeRevision};
      await outbox.begin(operation);
      const beforeMeta=await resources!.manifest(before),afterMeta=await resources!.manifest(after);
      beforeMeta.sourceUnit=beforeUnit;afterMeta.sourceUnit=afterUnit;
      const changes=metadataChanges(beforeMeta,afterMeta);
      const changed=after.masks.filter(mask=>before.masks.find(item=>item.id===mask.id)?.data!==mask.data);
      if(!changed.length&&!hasMetadataChanges(changes)){await outbox.remove(operation.key);ownedAfter.delete(op);ownedBefore.delete(op);return;}
      operation.changes=changes;await outbox.begin(operation);let n=0;
      for(const mask of changed){
        const old=before.masks.find(item=>item.id===mask.id)?.data||null,hint=draftHints.get(mask.data),inverse=old?draftHints.get(old):undefined;
        const bounds=hint?.source===old?hint.bounds:inverse?.source===mask.data?inverse.bounds:undefined;
        for await(const packet of diffMaskPackets(old,mask.data,volume.dims,{bounds})){await outbox.part(operation,n++,mask.id,packet);}
      }
      if(!n&&!hasMetadataChanges(changes)){await outbox.remove(operation.key);ownedAfter.delete(op);ownedBefore.delete(op);return;}
      await outbox.ready(operation,n);await recount();void pump();
    }).catch(reason=>{error.value=(reason as Error).message;}).finally(()=>{encoding.value--;});
  },{flush:'sync'});
  async function load(snapshot:SharedWorkbench,cacheRevision?:number,historical=false){
    viewingHistory.value=historical;
    const cached=editor.state.value;
    project.value=snapshot;resources=new WorkbenchResources(snapshot.id,user.id);manifest=snapshot.manifest;authority.clear();
    for(const def of manifest.masks)authority.set(String(def.id),await readMaskSnapshot(snapshot.maskBase+encodeURIComponent(String(def.id)),snapshot.count));
    for(const claim of snapshot.claims||[])for await(const packet of maskSnapshotPackets(snapshot.maskBase+encodeURIComponent(claim.mask)+'&author='+encodeURIComponent(claim.author),snapshot.count))claims.apply(claim.mask,claim.author,packet,snapshot.count);
    sourceData.value=editor.volume.value!.data;
    if(!historical)await recover(cached,cacheRevision);
    await projectView(true);initializing.value=false;
    if(!historical){await recount();connect();poll=setInterval(()=>void refresh(),5000);void pump();}
    else{const presence=await api<{members:AuthUser[]}>(base()+'/presence');members.value=presence.members;}
  }
  async function recover(cached:ProjectState,cacheRevision?:number){
    const current=project.value!,pending=await outbox.list(current.id),incomplete=pending.filter(op=>op.status==='encoding');
    if(!incomplete.length)return;
    if(cacheRevision===undefined||incomplete.some(op=>op.nativeRevision>cacheRevision)){
      recoveryBlocked.value=true;error.value='上次操作尚未完整写入本机，待确认数据已保留；请从本地工程检查或导出成果。';return;
    }
    const marker=await outbox.marker(current.id),baseRevision=marker?.serverRevision??Math.min(...pending.map(op=>op.baseRevision));
    const baseline=await api<SharedWorkbench>(base()+'?revision='+baseRevision);
    let target=await resources!.manifest(cached);target.sourceUnit=editor.volume.value!.header[123]!&7;const targetMasks=new Map(cached.masks.map(mask=>[mask.id,mask.data]));
    for(const operation of pending)if(operation.status==='ready'&&operation.nativeRevision>cacheRevision){
      target=applyMetadata(target,operation.changes);
      const parts=await outbox.parts(operation.key),copies=new Set<string>();
      for(const part of parts){
        let data=targetMasks.get(part.mask);
        if(!data)data=new Uint8Array(current.count);else if(!copies.has(part.mask))data=await copyMask(data);
        copies.add(part.mask);targetMasks.set(part.mask,data);await applyMaskPackets(data,[part.packet]);
      }
    }
    const op=operationId(),replacement:WorkbenchOperation={key:current.id+':'+op,project:current.id,op,baseRevision,kind:'恢复本地进度',changes:metadataChanges(baseline.manifest,target),created:clock=Math.max(clock+1,Date.now()),parts:0,status:'encoding',nativeRevision:cacheRevision};
    await outbox.begin(replacement);let n=0;
    for(const def of target.masks){
      const id=String(def.id),after=targetMasks.get(id)||new Uint8Array(current.count);
      const before=baseline.manifest.masks.some(mask=>mask.id===id)?await readMaskSnapshot(baseline.maskBase+encodeURIComponent(id),current.count):null;
      for await(const packet of diffMaskPackets(before,after,editor.volume.value!.dims))await outbox.part(replacement,n++,id,packet);
    }
    await outbox.ready(replacement,n);
    for(const operation of pending)await outbox.remove(operation.key);
    notice.value='已恢复本机未完成上传的工作记录';
  }
  function projectView(force=false){
    const next=projection.then(()=>projectViewNow(force));projection=next.catch(()=>{});return next;
  }
  async function projectViewNow(force=false){
    if(!project.value||!resources||!manifest||localMode.value||stopped)return;
    if(!force&&(activeGesture()||encoding.value)){deferred=true;return;}
    const projectedRevision=project.value.revision;let nativeRevision=editor.revision.value;
    for(const claim of delayedClaims.splice(0))claims.apply(claim.mask,claim.author,claim.packet,project.value.count);
    const projected=new Map(authority),operations=viewingHistory.value?[]:await outbox.list(project.value.id);
    let projectedManifest=manifest;
    for(const operation of operations){
      if(operation.status!=='ready')continue;projectedManifest=applyMetadata(projectedManifest,operation.changes);
      const parts=await outbox.parts(operation.key),ids=new Set(parts.map(part=>part.mask)),localBefore=ownedBefore.get(operation.op)?.deref(),localAfter=ownedAfter.get(operation.op)?.deref();
      for(const id of ids){
        const packets=parts.filter(part=>part.mask===id).map(part=>part.packet),old=localBefore?.masks.find(mask=>mask.id===id)?.data,next=localAfter?.masks.find(mask=>mask.id===id)?.data;
        let blocked=false;
        if(claims.hasForeign(id,user.id))for(const packet of packets)for(const run of readMaskRuns(packet,project.value.count))if(!run.after&&claims.foreignIntersects(id,user.id,run.start,run.start+run.length))blocked=true;
        if(next&&!blocked&&projected.get(id)===old){projected.set(id,next);continue;}
        const source=projected.get(id),target=source?await copyMask(source):new Uint8Array(project.value.count);projected.set(id,target);
        await applyMaskPackets(target,packets);claims.protect(id,user.id,target);
      }
    }
    for(const def of projectedManifest.masks)if(!projected.has(String(def.id)))projected.set(String(def.id),new Uint8Array(project.value.count));
    const unit=projectedManifest.sourceUnit;
    if(unit&&[1,2,3].includes(unit)&&editor.volume.value?.unit!=='mm'){
      applying=true;try{editor.spatialUnitChoice.value=unit as 1|2|3;editor.confirmSpatialUnit();}finally{applying=false;}
      if(editor.volume.value?.unit!=='mm')throw new Error(editor.error.value||'无法应用团队空间单位。');nativeRevision=editor.revision.value;
    }
    const previous={...editor.state.value,...Object.fromEntries(selectionOverrides)};
    const state=await nativeState(projectedManifest,projected,resources,previous);
    if(stopped||localMode.value)return;
    if(!force&&(activeGesture()||encoding.value||editor.revision.value!==nativeRevision||project.value.revision!==projectedRevision)){deferred=true;return;}
    if(!same(state,editor.state.value)){
      applying=true;try{editor.state.value=state;editor.revision.value++;}finally{applying=false;}
    }
    const measurement=selectionOverrides.get('selectedMeasurementId');if(measurement&&state.measurements.some(item=>item.id===measurement))editor.selectedMeasurementId.value=measurement;
    selectionOverrides.clear();editorBaseRevision=project.value.revision;deferred=false;
  }
  async function accept(event:SharedEvent){
    if(!project.value||event.revision<=project.value.revision)return;
    if(event.revision!==project.value.revision+1){await refresh();return;}
    manifest=applyMetadata(manifest!,event.changes);
    const own=ownedAfter.get(event.op)?.deref(),ownBefore=ownedBefore.get(event.op)?.deref();
    if(own&&event.author===user.id){
      for(const[field,collection]of [['selectedMaskId','masks'],['selectedPartId','parts'],['selectedCenterlineId','centerlines'],['selectedPolylineId','polylines'],['selectedResliceId','resliceObjects']] as const){
        const id=own[field],mapped=id?event.renamed?.[collection+'/'+id]:undefined;
        if(mapped&&editor.state.value[field]===id)selectionOverrides.set(field,mapped);
      }
      const selected=editor.selectedMeasurementId.value,mapped=event.renamed?.['measurements/'+selected];
      if(mapped)selectionOverrides.set('selectedMeasurementId',mapped);
    }
    const originalParts=event.author===user.id?await outbox.parts(project.value.id+':'+event.op):[];
    const received=new Map<string,Uint8Array[]>();
    for(const part of event.parts){
      const response=await authenticatedFetch(base()+'/events/'+event.revision+'/parts/'+part.n);if(!response.ok)throw await responseError(response);
      const packet=new Uint8Array(await response.arrayBuffer());
      if(part.scope==='claim'){
        if(activeGesture())delayedClaims.push({mask:part.mask,author:part.author||event.author,packet});
        else claims.apply(part.mask,part.author||event.author,packet,project.value.count);
        continue;
      }
      const packets=received.get(part.mask)||[];packets.push(packet);received.set(part.mask,packets);
    }
    const ids=new Set([...received.keys(),...originalParts.map(part=>part.mask)]);
    for(const id of ids){
      const packets=received.get(id)||[],expected=originalParts.filter(part=>part.mask===id).map(part=>part.packet);
      const old=authority.get(id),localBefore=ownBefore?.masks.find(mask=>mask.id===id)?.data,localAfter=own?.masks.find(mask=>mask.id===id)?.data;
      if(localAfter&&old===localBefore&&sameMaskPackets(packets,expected,project.value.count)){authority.set(id,localAfter);continue;}
      if(!packets.length)continue;
      const target=old?await copyMask(old):new Uint8Array(project.value.count);await applyMaskPackets(target,packets);authority.set(id,target);
    }
    for(const def of manifest.masks)if(!authority.has(String(def.id))){
      const local=event.author===user.id?own?.masks.find(mask=>mask.id===def.id)?.data:undefined;
      authority.set(String(def.id),local||new Uint8Array(project.value.count));
    }
    for(const id of [...authority.keys()])if(!manifest.masks.some(mask=>mask.id===id)){authority.delete(id);claims.remove(id);}
    await outbox.remove(project.value.id+':'+event.op);ownedAfter.delete(event.op);ownedBefore.delete(event.op);
    project.value={...project.value,revision:event.revision,latestRevision:Math.max(event.revision,project.value.latestRevision),manifest};
    history.value=[event,...history.value].slice(0,100);await recount();
    await projectView();
  }
  async function refresh(){
    if(stopped||viewingHistory.value||!project.value||refreshing)return;refreshing=true;
    try{
      for(let page=0;page<100;page++){
        const response:{events:SharedEvent[];revision:number;canWrite:boolean;datasetStatus:string}=await api(base()+'/events?after='+project.value.revision);
        project.value={...project.value,canWrite:response.canWrite,datasetStatus:response.datasetStatus,latestRevision:response.revision};
        for(const event of response.events)await accept(event);
        if(!response.events.length||project.value.revision===response.revision)break;
      }
      if(!recoveryBlocked.value)error.value='';
    }catch(reason){handleError(reason);}finally{refreshing=false;}
  }
  async function pump(){
    if(stopped||accessRevoked||!project.value||pumping||!project.value.canWrite||recoveryBlocked.value)return;pumping=true;sending.value=true;
    try{
      const operations=await outbox.list(project.value.id);
      for(const operation of operations){
        if(operation.status!=='ready')continue;
        for(const part of await outbox.parts(operation.key)){
          const response=await authenticatedFetch(base()+'/operations/'+encodeURIComponent(operation.op)+'/parts/'+part.n,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Mask-Id':encodeURIComponent(part.mask),'X-Workbench-Author':encodeURIComponent(user.id)},body:part.packet as Uint8Array<ArrayBuffer>});
          if(!response.ok)throw await responseError(response);
        }
        const acknowledgement=await api<{event:SharedEvent;protectedCount?:number}>(base()+'/operations',{method:'POST',headers:{'X-Workbench-Author':encodeURIComponent(user.id)},body:JSON.stringify({op:operation.op,baseRevision:operation.baseRevision,kind:operation.kind,changes:operation.changes,parts:operation.parts})});
        if(acknowledgement.protectedCount)notice.value='已保留其他作者的标注';
        if(acknowledgement.event.revision<=project.value!.revision){await outbox.remove(operation.key);ownedAfter.delete(operation.op);ownedBefore.delete(operation.op);await recount();await projectView();}
        await refresh();
      }
      error.value='';
    }catch(reason){handleError(reason);if(!stopped&&!accessRevoked){if(retry)clearTimeout(retry);retry=setTimeout(()=>void pump(),1500);}}
    finally{pumping=false;sending.value=false;await recount();}
  }
  function handleError(reason:unknown){
    error.value=(reason as Error).message;
    const status=(reason as any).status;if((status===401||status===403||status===423)&&project.value)project.value={...project.value,canWrite:false};
    if(status===401||status===403){accessRevoked=true;socket?.close();if(retry)clearTimeout(retry);if(reconnect)clearTimeout(reconnect);if(poll)clearInterval(poll);if(status===401)void loadCurrentUser().catch(()=>{});}
  }
  function connect(){
    if(stopped||accessRevoked||localMode.value||!project.value)return;const url=new URL('/api/collaboration/workbench-socket',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('project',project.value.id);url.searchParams.set('author',user.id);
    socket=new WebSocket(url);socket.onopen=()=>{connected.value=true;void refresh();};
    socket.onmessage=message=>{try{const value=JSON.parse(message.data);
      if(value.members)members.value=value.members;
      if(value.canWrite!==undefined&&project.value)project.value={...project.value,canWrite:value.canWrite,datasetStatus:value.datasetStatus||project.value.datasetStatus};
      if(value.type==='committed'||value.type==='ready')void refresh();
    }catch{error.value='协同消息格式无效。';}};
    socket.onclose=()=>{connected.value=false;if(!stopped&&!accessRevoked&&!localMode.value){if(reconnect)clearTimeout(reconnect);reconnect=setTimeout(connect,1500);}};
    socket.onerror=()=>{connected.value=false;};
  }
  watch([()=>!!editor.draft.value,()=>!!editor.mpr.brushPreview.value,()=>editor.draftPoints.value.length,()=>!!editor.mpr.contourDraft.value,()=>!!editor.measurementEditor.draft.value,editor.busy,encoding],()=>{
    if(deferred&&!activeGesture())network=network.then(()=>projectView()).catch(handleError);
  });
  function pointerState(active:boolean){pointer=active;if(!active&&deferred)network=network.then(()=>projectView()).catch(handleError);}
  async function flush(){if(viewingHistory.value)return;await serial;await pump();await refresh();await recount();if(queueCount.value||encoding.value)throw new Error(error.value||'仍有标注操作等待同步，进度已留在本机。');}
  async function readHistory(){if(!project.value)return;const result=await api<{events:SharedEvent[];legacy:SharedEvent[]}>(base()+'/history');history.value=result.events;legacyHistory.value=result.legacy;}
  async function markCached(nativeRevision:number){if(project.value)await outbox.mark(project.value.id,revisionBases.get(nativeRevision)??editorBaseRevision,nativeRevision);}
  function dispose(){stopped=true;resources?.dispose();socket?.close();if(retry)clearTimeout(retry);if(reconnect)clearTimeout(reconnect);if(poll)clearInterval(poll);}
  onScopeDispose(dispose);
  return{project,connected,initializing,queueCount,sending,error,notice,localMode,members,history,legacyHistory,viewingHistory,sourceData,encoding,recoveryBlocked,canWrite,pending,load,refresh,flush,dispose,pointerState,markCached,readHistory,pendingFor:(id:string)=>outbox.list(id)};
}
