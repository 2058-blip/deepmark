import {ref,shallowRef,watch} from 'vue';
import type {ComputedRef,Ref,ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import type {ProjectState} from './project.ts';
import {replaceMask} from './project.ts';
import type {BinaryMask,MaskObject,MprPlane,Vec3,VolumeGrid} from './types.ts';
import {validateMprPlane,mprWorldToPixel} from './mpr.ts';
import {sameMprPlane} from './useMprView.ts';
import {sweepMprBrush} from './mprBrush.ts';

export interface MprBrushEpoch {strokeId:number;activeMaskId:string;mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number}
export interface MprBrushPoint extends MprBrushEpoch {position:Vec3;startSegment?:boolean}
export interface MprBrushSettings {widthMm:number;heightMm:number;shape:'circle'|'square';lower?:number;upper?:number}
interface Stroke extends MprBrushEpoch {source:BinaryMask;tool:string;settings:MprBrushSettings;key:string;last:Vec3|null;pages:Map<number,Uint32Array>;scanVisits:number;changed:boolean}
export interface MprBrushContext {
  volume:ShallowRef<Volume|null>;grid:ComputedRef<VolumeGrid|null>;state:ShallowRef<ProjectState>;activeMask:ComputedRef<MaskObject|undefined>;tool:Ref<string>;busy:Ref<boolean>;revision:Ref<number>;poseRevision:Ref<number>;
  validPlane:(plane:MprPlane)=>boolean;getSettings:()=>MprBrushSettings;beforeBegin:()=>void;commit:(name:string,state:ProjectState)=>void;fail:(error:unknown)=>void;status:Ref<string>;
}
export const MAX_MPR_BRUSH_STROKE_VISITS=8_000_000;
/** Independent source-cell/plane editing policy; no proprietary MPR writeback equivalence is implied. */
export function useMprBrush(c:MprBrushContext){
  const preview=shallowRef<BinaryMask|null>(null),previewRevision=ref(0);let stroke:Stroke|null=null,highestStrokeId=0;
  function config(){const settings=c.getSettings();if(!Number.isFinite(settings.widthMm)||!Number.isFinite(settings.heightMm)||settings.widthMm<=0||settings.heightMm<=0||!['circle','square'].includes(settings.shape))throw new Error('MPR 画笔宽高必须是有限正毫米数。');if(c.tool.value==='local-threshold'&&(!Number.isFinite(settings.lower)||!Number.isFinite(settings.upper)||settings.lower!>settings.upper!))throw new Error('局部阈值范围无效。');return{...settings};}
  function key(settings:MprBrushSettings,tool=c.tool.value){return JSON.stringify([settings.widthMm,settings.heightMm,settings.shape,tool==='local-threshold'?settings.lower:null,tool==='local-threshold'?settings.upper:null]);}
  function clear(reason=''){const existed=!!stroke;stroke=null;preview.value=null;previewRevision.value++;if(existed&&reason)c.status.value=reason;}
  function epochValid(change:MprBrushEpoch){
    return!!change&&Number.isSafeInteger(change.strokeId)&&change.strokeId>0&&change.volume===c.volume.value&&change.revision===c.revision.value&&change.mprRevision===c.poseRevision.value&&!c.busy.value&&!!c.grid.value&&c.volume.value?.unit==='mm'&&change.activeMaskId===c.state.value.selectedMaskId&&change.activeMaskId===c.activeMask.value?.id&&!!c.activeMask.value?.visible&&c.validPlane(change.mprPlane);
  }
  function current(change?:MprBrushEpoch){
    const s=stroke;if(!s||!preview.value)return false;
    try{return epochValid(s)&&c.activeMask.value!.data===s.source&&c.tool.value===s.tool&&key(config())===s.key&&(!change||epochValid(change)&&change.strokeId===s.strokeId&&change.activeMaskId===s.activeMaskId&&sameMprPlane(change.mprPlane,s.mprPlane));}catch{return false;}
  }
  function begin(change:MprBrushEpoch){
    if(!['paint','erase','local-threshold'].includes(c.tool.value))return false;
    try{
      if(!epochValid(change)||change.strokeId<=highestStrokeId)return false;const settings=config(),plane=validateMprPlane(change.mprPlane),source=c.activeMask.value!.data;
      c.beforeBegin();if(!epochValid(change))return false;
      const next=source.slice();clear();highestStrokeId=change.strokeId;stroke={...change,mprPlane:plane,source,tool:c.tool.value,settings,key:key(settings),last:null,pages:new Map(),scanVisits:0,changed:false};preview.value=next;previewRevision.value++;c.status.value='MPR 笔画预览，尚未修改活动 Mask';return true;
    }catch(error){c.fail(error);return false;}
  }
  function visited(s:Stroke,index:number){const pageId=index>>>15;let page=s.pages.get(pageId);if(!page){page=new Uint32Array(1024);s.pages.set(pageId,page);}const word=(index&32767)>>>5,bit=1<<(index&31);if(page[word]!&bit)return true;page[word]!|=bit;return false;}
  function append(change:MprBrushPoint){
    if(stroke&&Number.isSafeInteger(change?.strokeId)&&change.strokeId>0&&change.strokeId!==stroke.strokeId)return false;
    if(!current(change)){clear('MPR 笔画上下文已变化，取消整笔预览');return false;}
    const s=stroke!;
    try{
      if(change.position.length!==3||change.position.some(n=>!Number.isFinite(n))||Math.abs(mprWorldToPixel(s.mprPlane,change.position).distance)>1e-5)throw new Error('MPR 笔画位置必须在冻结的物理平面内。');
      if(!change.startSegment&&s.last&&change.position.every((n,i)=>n===s.last![i]))return true;
      const remaining=MAX_MPR_BRUSH_STROKE_VISITS-s.scanVisits;if(remaining<=0)throw new Error('本笔画超过源体素扫描预算，已取消整笔；请分段绘制。');
      const result=sweepMprBrush(c.grid.value!,s.mprPlane,{from:change.startSegment?change.position:s.last??change.position,to:change.position,widthMm:s.settings.widthMm,heightMm:s.settings.heightMm,shape:s.settings.shape},{maxScanVisits:Math.min(1_000_000,remaining)});
      if(s.scanVisits+result.scanVisits>MAX_MPR_BRUSH_STROKE_VISITS)throw new Error('本笔画超过源体素扫描预算，已取消整笔；请分段绘制。');s.scanVisits+=result.scanVisits;
      let changed=false;for(const index of result.indices){if(visited(s,index))continue;const value=s.tool==='erase'?0:s.tool==='paint'?1:Number(Number.isFinite(c.grid.value!.data[index])&&c.grid.value!.data[index]!>=s.settings.lower!&&c.grid.value!.data[index]!<=s.settings.upper!);if(preview.value![index]!==value){preview.value![index]=value;changed=s.changed=true;}}
      s.last=[...change.position];if(changed)previewRevision.value++;return true;
    }catch(error){clear();c.fail(error);return false;}
  }
  function end(change:MprBrushEpoch){
    if(stroke&&Number.isSafeInteger(change?.strokeId)&&change.strokeId>0&&change.strokeId!==stroke.strokeId)return false;
    if(!change||!current(change)){clear('MPR 笔画上下文已变化，取消整笔预览');return false;}
    const s=stroke!,data=preview.value!;clear();if(!s.changed){c.status.value='MPR 笔画范围内的 Mask 无变化';return false;}
    try{c.commit(s.tool==='paint'?'MPR 绘制 Mask':s.tool==='erase'?'MPR 擦除 Mask':'MPR 局部阈值',replaceMask(c.state.value,s.activeMaskId,data));return true;}catch(error){c.fail(error);return false;}
  }
  function cancelGesture(change:MprBrushEpoch){
    const s=stroke;if(!s||!change)return false;
    try{
      if(!Number.isSafeInteger(change.strokeId)||change.strokeId<=0||change.strokeId!==s.strokeId||change.volume!==s.volume||change.revision!==s.revision||change.mprRevision!==s.mprRevision||change.activeMaskId!==s.activeMaskId||!sameMprPlane(validateMprPlane(change.mprPlane),s.mprPlane))return false;
      clear();return true;
    }catch{return false;}
  }
  watch([c.volume,c.revision,c.poseRevision,c.tool,c.busy,()=>c.state.value.selectedMaskId,()=>c.activeMask.value?.visible,()=>c.activeMask.value?.data,()=>key(c.getSettings())],()=>{if(stroke&&!current())clear('MPR 笔画上下文已变化，取消整笔预览');},{flush:'sync'});
  return{preview,previewRevision,begin,append,end,cancelGesture,cancel:()=>clear()};
}
