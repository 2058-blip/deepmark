import {getCurrentScope,onScopeDispose,ref,shallowRef,toValue,watch,type MaybeRefOrGetter} from 'vue';
import type {MprPlane,VolumeGrid} from './types.ts';
import {validateMprPlane,type MprMaskInput,type MprSlice} from './mpr.ts';
import {acquireMprSamplingOwner,MprSamplingCancelled,sameMprSamplingSource,mprSourceGeometry,type MprSamplingOwner,type MprSamplingSource} from './mprSamplingClient.ts';

export interface MprSamplingInputs {
  volume:MaybeRefOrGetter<object|null>;grid:MaybeRefOrGetter<VolumeGrid|null>;sourceRevision:MaybeRefOrGetter<number>;
  plane:MaybeRefOrGetter<MprPlane|null>;interpolation:MaybeRefOrGetter<'linear'|'nearest'>;
  masks:MaybeRefOrGetter<readonly (MprMaskInput&{revision?:number})[]>;active?:MaybeRefOrGetter<boolean>;
}
export function useMprSampling(input:MprSamplingInputs){
  const samples=shallowRef<MprSlice|null>(null),loading=ref(false),error=ref('');let owner:MprSamplingOwner|undefined,document:object|null=null,generation=0,disposed=false,last:{source:MprSamplingSource;plane:string;interpolation:string}|undefined;
  const invalidate=(message='')=>{
    const invalidation=++generation,recoveringOwner=owner,recoveringDocument=document;samples.value=null;loading.value=false;error.value=message;last=undefined;
    // A peer has explicitly restarted the shared resident. Rejoin it after initialization;
    // a later fatal error, cancel, document change or disposal revokes this queued request.
    if(!message)queueMicrotask(()=>{if(!disposed&&generation===invalidation&&owner===recoveringOwner&&document===recoveringDocument)update();});
  };
  function cancel(){generation++;owner?.cancel();samples.value=null;loading.value=false;last=undefined;}
  function update(retry=false){
    if(disposed)return;
    try{
      const volume=toValue(input.volume),grid=toValue(input.grid),candidate=toValue(input.plane),active=input.active===undefined||toValue(input.active),revision=toValue(input.sourceRevision),interpolation=toValue(input.interpolation),masks=toValue(input.masks).map(mask=>({id:mask.id,data:mask.data,...(mask.revision!==undefined?{revision:mask.revision}:{})})).sort((a,b)=>a.id.localeCompare(b.id));
      if(document!==volume){generation++;owner?.dispose();owner=undefined;document=volume;last=undefined;samples.value=null;}
      if(!active||!volume||!grid||!candidate){cancel();error.value='';return;}
      const plane=validateMprPlane(candidate),source:MprSamplingSource={grid:{...grid,dims:[...grid.dims],spacing:[...grid.spacing],...(grid.affine?{affine:grid.affine.map(row=>[...row])}:{})},masks,revision},key=JSON.stringify(plane);
      if(!retry&&last&&sameMprSamplingSource(last.source,source)&&last.plane===key&&last.interpolation===interpolation)return;
      if(!owner)owner=acquireMprSamplingOwner(volume,invalidate);
      const current=++generation;last={source,plane:key,interpolation};samples.value=null;loading.value=true;error.value='';
      void owner.request(source,plane,interpolation,retry).then(result=>{if(disposed||current!==generation)return;samples.value=result;loading.value=false;},failure=>{if(disposed||current!==generation)return;loading.value=false;samples.value=null;if(!(failure instanceof MprSamplingCancelled))error.value=failure instanceof Error?failure.message:String(failure);});
    }catch(failure){cancel();error.value=failure instanceof Error?failure.message:String(failure);}
  }
  const stop=watch(()=>{const grid=toValue(input.grid),plane=toValue(input.plane);return[toValue(input.volume),grid?.data,grid?mprSourceGeometry(grid):null,toValue(input.sourceRevision),plane?JSON.stringify(plane):null,toValue(input.interpolation),toValue(input.masks).map(mask=>[mask.id,mask.data,mask.revision]),input.active===undefined?true:toValue(input.active)];},()=>update(),{immediate:true,flush:'sync'});
  function refresh(){update(true);}
  function dispose(){if(disposed)return;disposed=true;stop();generation++;owner?.dispose();owner=undefined;document=null;samples.value=null;loading.value=false;}
  if(getCurrentScope())onScopeDispose(dispose);
  return{samples,loading,error,cancel,refresh,dispose};
}
