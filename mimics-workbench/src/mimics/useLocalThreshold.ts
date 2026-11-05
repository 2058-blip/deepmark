import {computed,ref,shallowRef,watch} from 'vue';
import type {ComputedRef,ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import type {MaskObject} from './types.ts';

export type LocalThresholdSlot=0|1|2;
export type LocalThresholdBound='lower'|'upper';
export interface LocalThresholdBounds {readonly lower:number;readonly upper:number}
export interface LocalThresholdRange extends LocalThresholdBounds {readonly editable:boolean}
export type LocalThresholdRanges=readonly [LocalThresholdRange,LocalThresholdRange,LocalThresholdRange];

/** Three local edit ranges. The middle range follows the active mask and never writes back to it. */
export function useLocalThreshold(activeMask:ComputedRef<MaskObject|undefined>,volume:ShallowRef<Volume|null>){
  const slot=ref<LocalThresholdSlot>(1);
  const defaultRange=computed<LocalThresholdBounds>(()=>{
    const stored=activeMask.value?.threshold;
    if(stored)return{lower:stored[0],upper:stored[1]};
    // Existing application fallback, not a recovered Mimics preset. No image uses a neutral placeholder.
    const max=volume.value?.max??0;
    return{lower:Math.min(max,226),upper:max};
  });
  const custom=shallowRef<readonly [LocalThresholdBounds,LocalThresholdBounds]>([{...defaultRange.value},{...defaultRange.value}]);
  const ranges=computed<LocalThresholdRanges>(()=>Object.freeze([
    Object.freeze({...custom.value[0],editable:true}),
    Object.freeze({...defaultRange.value,editable:false}),
    Object.freeze({...custom.value[1],editable:true}),
  ]) as LocalThresholdRanges);
  const range=computed<LocalThresholdBounds>(()=>{
    const selected=ranges.value[slot.value]??ranges.value[1];
    return Object.freeze({lower:selected.lower,upper:selected.upper});
  });
  function validSlot(value:unknown):value is LocalThresholdSlot{return value===0||value===1||value===2;}
  function choose(value:LocalThresholdSlot):boolean{
    if(!validSlot(value))return false;
    slot.value=value;return true;
  }
  function update(value:LocalThresholdSlot,bound:LocalThresholdBound,next:number):boolean{
    if(!volume.value||!validSlot(value)||value===1||(bound!=='lower'&&bound!=='upper')||!Number.isFinite(next))return false;
    const index=value===0?0:1,current=custom.value[index],changed={...current,[bound]:next};
    if(changed.lower>changed.upper)return false;
    const changedCustom:[LocalThresholdBounds,LocalThresholdBounds]=[custom.value[0],custom.value[1]];
    changedCustom[index]=changed;custom.value=changedCustom;return true;
  }
  function reset(){
    custom.value=[{...defaultRange.value},{...defaultRange.value}];slot.value=1;
  }
  watch([()=>activeMask.value?.id,()=>activeMask.value?.threshold?.[0],()=>activeMask.value?.threshold?.[1],()=>volume.value],reset,{flush:'sync'});
  return{slot,ranges,range,choose,update,reset};
}
