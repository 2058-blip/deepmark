import {computed,shallowRef,watch,type ComputedRef,type Ref,type ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import type {BinaryMask,MaskObject,MprPlane,Vec3,VolumeGrid} from './types.ts';
import type {ProjectState} from './project.ts';
import {replaceMask} from './project.ts';
import type {OperationRequest} from './operationClient.ts';
import {validateMprPlane,mprPixelToWorld,mprWorldToPixel} from './mpr.ts';
import {sameMprPlane} from './useMprView.ts';
import {liveWirePath,type LiveWireTree} from './livewire.ts';
import type {MprContourCompletion,MprContourDraft,MprContourEpoch,MprContourPoint} from './mprContourSession.ts';

export interface MprContourSettings {
  operation:'add'|'remove'|'threshold';lower?:number;upper?:number;
  gradientWeight?:number;attraction?:number;interpolation?:'linear'|'nearest';
}
export interface MprContourContext {
  volume:ShallowRef<Volume|null>;grid:ComputedRef<VolumeGrid|null>;state:ShallowRef<ProjectState>;
  activeMask:ComputedRef<MaskObject|undefined>;tool:Ref<string>;busy:Ref<boolean>;active:Ref<boolean>;
  revision:Ref<number>;poseRevision:Ref<number>;validPlane:(plane:MprPlane)=>boolean;
  getSettings:()=>MprContourSettings;beforeBegin:()=>void;
  run:<T>(request:OperationRequest)=>Promise<T|undefined>;abort:()=>void;
  commit:(name:string,state:ProjectState)=>void;fail:(error:unknown)=>void;status:Ref<string>;
}
interface Session extends MprContourEpoch {
  source:BinaryMask;maskRevision:number;tool:'lasso'|'livewire';settings:MprContourSettings;key:string;
  points:Vec3[];anchors:Vec3[];hover:Vec3[];completion:Vec3[]|null;tree:LiveWireTree|null;pending:boolean;
}
const MAX_POINTS=65_536;

/** Independent source-grid contour policy. The native arbitrary-RP writeback kernel remains unknown. */
export function useMprContour(c:MprContourContext){
  const draft=shallowRef<MprContourDraft|null>(null);let session:Session|null=null,highWater=0;
  function settings(){
    const input=c.getSettings();if(!['add','remove','threshold'].includes(input.operation))throw new Error('未知轮廓编辑操作。');
    const result:MprContourSettings={operation:input.operation};
    if(input.operation==='threshold'){
      if(!Number.isFinite(input.lower)||!Number.isFinite(input.upper)||input.lower!>input.upper!)throw new Error('轮廓局部阈值范围无效。');
      result.lower=input.lower;result.upper=input.upper;
    }
    if(c.tool.value==='livewire'){
      if(!Number.isFinite(input.gradientWeight)||input.gradientWeight!<0||input.gradientWeight!>1||!Number.isFinite(input.attraction)||Math.abs(input.attraction!)>50||!['linear','nearest'].includes(input.interpolation!))throw new Error('LiveWire 参数无效。');
      result.gradientWeight=input.gradientWeight;result.attraction=input.attraction;result.interpolation=input.interpolation;
    }
    return result;
  }
  const settingsKey=computed(()=>{try{return JSON.stringify(settings());}catch{return 'invalid';}});
  const pending=computed(()=>draft.value?.pending??false);
  const clone=(points:readonly Vec3[])=>points.map(point=>[...point] as Vec3);
  function epoch(s:Session):MprContourEpoch{return{sessionId:s.sessionId,activeMaskId:s.activeMaskId,mprPlane:validateMprPlane(s.mprPlane),volume:s.volume,revision:s.revision,mprRevision:s.mprRevision};}
  function publish(s:Session){if(session===s)draft.value={...epoch(s),points:clone(s.completion??s.points),anchors:clone(s.anchors),hover:clone(s.hover),pending:s.pending};}
  function clear(abort=true){const previous=session;session=null;draft.value=null;if(abort&&previous?.pending)c.abort();}
  function matches(change:MprContourEpoch,s=session){
    if(!s||!change)return false;
    try{return Number.isSafeInteger(change.sessionId)&&change.sessionId>0&&change.sessionId===s.sessionId&&change.volume===s.volume&&change.revision===s.revision&&change.mprRevision===s.mprRevision&&change.activeMaskId===s.activeMaskId&&sameMprPlane(validateMprPlane(change.mprPlane),s.mprPlane);}catch{return false;}
  }
  function stateCurrent(s:Session){
    const mask=c.activeMask.value;
    try{return session===s&&c.active.value&&c.volume.value===s.volume&&s.volume.unit==='mm'&&c.revision.value===s.revision&&c.poseRevision.value===s.mprRevision&&c.tool.value===s.tool&&(!c.busy.value||s.pending)&&c.state.value.selectedMaskId===s.activeMaskId&&mask?.id===s.activeMaskId&&mask.visible&&mask.data===s.source&&mask.revision===s.maskRevision&&!!c.grid.value&&c.validPlane(s.mprPlane)&&JSON.stringify(settings())===s.key;}catch{return false;}
  }
  function begin(change:MprContourEpoch){
    if(!['lasso','livewire'].includes(c.tool.value)||!change||!Number.isSafeInteger(change.sessionId)||change.sessionId<=highWater||!c.active.value||c.busy.value||!c.volume.value||c.volume.value.unit!=='mm'||!c.grid.value)return false;
    const mask=c.activeMask.value;
    if(!mask?.visible||change.activeMaskId!==mask.id||change.activeMaskId!==c.state.value.selectedMaskId||change.volume!==c.volume.value||change.revision!==c.revision.value||change.mprRevision!==c.poseRevision.value)return false;
    try{
      const plane=validateMprPlane(change.mprPlane);if(!c.validPlane(plane))return false;const config=settings();
      c.beforeBegin();if(c.busy.value||mask!==c.activeMask.value||change.volume!==c.volume.value||change.revision!==c.revision.value||change.mprRevision!==c.poseRevision.value||!c.validPlane(plane))return false;
      clear();highWater=change.sessionId;session={...change,mprPlane:plane,source:mask.data,maskRevision:mask.revision,tool:c.tool.value as Session['tool'],settings:config,key:JSON.stringify(config),points:[],anchors:[],hover:[],completion:null,tree:null,pending:false};
      publish(session);c.status.value='MPR 轮廓尚未提交；Escape 取消';return true;
    }catch(error){c.fail(error);return false;}
  }
  function pointOnPlane(s:Session,world:Vec3){
    if(!Array.isArray(world)||world.length!==3||world.some(n=>!Number.isFinite(n)))throw new Error('轮廓点必须是有限的三维世界坐标。');
    const projected=mprWorldToPixel(s.mprPlane,world);
    if(Math.abs(projected.distance)>1e-5)throw new Error('轮廓点必须在冻结的MPR平面内。');
    const [x,y]=projected.pixel,[w,h]=s.mprPlane.size;
    if(x<-.5||y<-.5||x>w-.5||y>h-.5)throw new Error('轮廓点必须位于当前MPR图像范围。');
    return projected.pixel;
  }
  function localSeed(s:Session,world:Vec3):Vec3{const [x,y]=pointOnPlane(s,world);return[Math.max(0,Math.min(s.mprPlane.size[0]-1,Math.round(x))),Math.max(0,Math.min(s.mprPlane.size[1]-1,Math.round(y))),0];}
  function path(s:Session,target:Vec3){
    if(!s.tree)throw new Error('LiveWire 路径树尚未就绪。');const points=liveWirePath(s.tree,target),last=points.at(-1);
    if(!points.length||!last||last.some((v,k)=>v!==target[k]))throw new Error('LiveWire 无法到达该点；请沿有效影像重新放置锚点。');
    if(points.length>MAX_POINTS)throw new Error('LiveWire 路径超过轮廓点数预算，请缩小区域。');
    return points.map(point=>mprPixelToWorld(s.mprPlane,[point[0],point[1]]));
  }
  async function request<T>(s:Session,operation:OperationRequest):Promise<T|undefined>{
    if(!stateCurrent(s)||s.pending)return;s.pending=true;publish(s);
    try{
      const result=await c.run<T>(operation);if(session!==s)return;
      s.pending=false;if(!stateCurrent(s)){clear(false);return;}
      if(result===undefined){clear(false);return;}publish(s);return result;
    }catch(error){if(session===s){clear(false);c.fail(error);}return;}
    finally{if(session===s&&s.pending){s.pending=false;publish(s);}}
  }
  async function addPoint(change:MprContourPoint){
    const s=session;if(!s||!matches(change,s)||!stateCurrent(s)||s.tool!=='livewire'||s.pending)return false;
    try{
      const seed=localSeed(s,change.position),world=mprPixelToWorld(s.mprPlane,[seed[0],seed[1]]),last=s.anchors.at(-1);
      if(last&&last.every((v,k)=>v===world[k]))return true;
      const segment=s.tree?path(s,seed):[world];
      if(s.points.length+segment.length>MAX_POINTS)throw new Error('LiveWire 轮廓超过点数预算，请重新缩小区域。');
      const tree=await request<LiveWireTree>(s,{kind:'mpr-contour-livewire',seed,options:{mprPlane:s.mprPlane,...s.settings}});
      if(!tree||session!==s||!stateCurrent(s))return false;
      s.points=s.tree?[...s.points,...segment.slice(1)]:segment;s.anchors=[...s.anchors,world];s.tree=tree;s.hover=[];publish(s);return true;
    }catch(error){c.fail(error);return false;}
  }
  function hover(change:MprContourEpoch&{position:Vec3|null}){
    const s=session;if(!s||!matches(change,s)||!stateCurrent(s)||s.tool!=='livewire'||s.pending)return false;
    try{s.hover=change.position===null?[]:path(s,localSeed(s,change.position));publish(s);return true;}catch{s.hover=[];publish(s);return false;}
  }
  async function complete(change:MprContourCompletion){
    const s=session;if(!s||!matches(change,s)||!stateCurrent(s)||s.pending)return false;
    try{
      let points:Vec3[];
      if(s.tool==='lasso'){
        if(!Array.isArray(change.points)||change.points.length<3||change.points.length>MAX_POINTS)throw new Error('Lasso 轮廓需要至少三个点，且不能超过点数预算。');
        for(const point of change.points)pointOnPlane(s,point);points=clone(change.points);
      }else{
        const distinct=new Set(s.anchors.map(point=>JSON.stringify(point)));if(distinct.size<3)throw new Error('LiveWire 至少需要三个不同锚点才能闭合。');
        const closure=path(s,localSeed(s,s.anchors[0]));points=[...s.points,...closure.slice(1)];
        if(points.length>MAX_POINTS)throw new Error('LiveWire 闭合轮廓超过点数预算。');
      }
      s.completion=points;s.hover=[];
      const result=await request<{indices:Uint32Array}>(s,{kind:'mpr-contour-raster',options:{mprPlane:s.mprPlane,points}});
      if(!result||session!==s||!stateCurrent(s))return false;
      if(!(result.indices instanceof Uint32Array))throw new Error('MPR 轮廓后台结果无效。');
      const grid=c.grid.value!;let next:BinaryMask|undefined;
      for(const index of result.indices){
        if(index>=s.source.length)throw new Error('MPR 轮廓源体素索引越界。');
        const value=s.settings.operation==='add'?1:s.settings.operation==='remove'?0:Number(Number.isFinite(grid.data[index])&&grid.data[index]!>=s.settings.lower!&&grid.data[index]!<=s.settings.upper!);
        if(s.source[index]!==value){next??=s.source.slice();next[index]=value;}
      }
      clear(false);if(!next){c.status.value='MPR 轮廓范围内的 Mask 无变化';return false;}
      c.commit(s.settings.operation==='add'?'MPR 轮廓绘制':s.settings.operation==='remove'?'MPR 轮廓擦除':'MPR 轮廓局部阈值',replaceMask(c.state.value,s.activeMaskId,next));return true;
    }catch(error){if(session===s){s.completion=null;if(s.pending)clear();else publish(s);}c.fail(error);return false;}
  }
  function cancelGesture(change:MprContourEpoch){if(!matches(change))return false;clear();return true;}
  watch([c.volume,c.revision,c.poseRevision,c.tool,c.busy,c.active,()=>c.state.value.selectedMaskId,()=>c.activeMask.value?.visible,()=>c.activeMask.value?.data,()=>c.activeMask.value?.revision,settingsKey],()=>{if(session&&!stateCurrent(session))clear();},{flush:'sync'});
  return{draft,pending,settingsKey,begin,addPoint,hover,complete,cancelGesture,cancel:()=>clear(),completeCurrent:()=>session?complete(epoch(session)):Promise.resolve(false)};
}
