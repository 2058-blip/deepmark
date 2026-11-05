import {computed,ref,shallowRef,watch,type ComputedRef,type Ref,type ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import {physicalPoint,type MprPlane,type Vec3,type VolumeGrid} from './types.ts';
import type {ProjectState} from './project.ts';
import {validateProject} from './project.ts';
import type {OperationRequest} from './operationClient.ts';
import type {SaveFileRequest,SaveFileResult} from './fileTransfer.ts';
import {createResliceProjectGeometry,type ResliceProjectGeometryOptions,type ResliceProjectGeometryResult} from './resliceProjectGeometry.ts';
import {validateResliceProjectObjects} from './resliceProjectData.ts';
import {mprPlaneCenter,mprPlaneNormal,mprWorldToPixel,validateMprPlane} from './mpr.ts';
import {worldToVoxel} from './measurements.ts';
import type {ResliceProjectDraft,ResliceProjectPoint,ResliceProjectPreview,ResliceProjectResultSummary,WorldReferenceLine} from './resliceProjectTypes.ts';

export interface PreparedResliceProject {
  volume:Volume;state:ProjectState;transformationText:string;warnings:string[];
  sampling:Omit<ResliceProjectGeometryResult,'data'|'masks'>;
}
export interface ResliceProjectContext {
  volume:ShallowRef<Volume|null>;grid:ComputedRef<VolumeGrid|null>;state:ShallowRef<ProjectState>;revision:Ref<number>;
  point:Ref<Vec3>;tool:Ref<string>;busy:Ref<boolean>;physicalUnitsKnown:ComputedRef<boolean>;poseRevision:Ref<number>;
  currentMpr:()=>MprPlane|null;validMprPlane:(plane:MprPlane)=>boolean;snapshot:()=>ProjectState;
  beforeOpen:()=>void;abort:()=>void;run:<T>(request:OperationRequest)=>Promise<T|undefined>;
  save:(request:SaveFileRequest)=>Promise<SaveFileResult|undefined>;
  archive:(result:PreparedResliceProject)=>Promise<Uint8Array>;
  openResult:(result:PreparedResliceProject)=>boolean;
  status:Ref<string>;fail:(error:unknown)=>void;
}
const sub=(a:Vec3,b:Vec3)=>a.map((v,k)=>v-b[k]!) as Vec3;
const unit=(v:Vec3)=>{const length=Math.hypot(...v);if(!Number.isFinite(length)||length<=0)throw new Error('重切片方向必须具有正有限长度。');return v.map(n=>n/length) as Vec3;};
const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,k)=>sum+n*b[k]!,0);
const cloneDraft=(value:ResliceProjectDraft):ResliceProjectDraft=>({...value,start:[...value.start],end:[...value.end],up:[...value.up]});
const draftKey=(value:ResliceProjectDraft|null)=>JSON.stringify(value);

/** New-volume generation never replaces the source project until the explicit Open Result action. */
export function useResliceProject(c:ResliceProjectContext){
  const open=ref(false),draft=shallowRef<ResliceProjectDraft|null>(null),drawing=ref(false),linePoints=shallowRef<Vec3[]>([]),lineToken=ref(0),error=ref('');
  const result=shallowRef<PreparedResliceProject|null>(null),written=ref(false);
  let generation=0,working=false,sourceVolume:Volume|null=null,sourceRevision=-1,drawVolume:Volume|null=null,drawRevision=-1;
  function nextLineToken(){if(lineToken.value>=Number.MAX_SAFE_INTEGER)throw new Error('重切片绘线编号已耗尽，请重新加载工作台。');lineToken.value++;}
  function fail(reason:unknown){error.value=reason instanceof Error?reason.message:String(reason);c.fail(reason);}
  function options(value:ResliceProjectDraft):ResliceProjectGeometryOptions{
    if(!Number.isFinite(value.widthMm)||value.widthMm<=0||!Number.isFinite(value.heightMm)||value.heightMm<=0||!Number.isFinite(value.pixelSize)||value.pixelSize<=0)throw new Error('影像宽高与像素尺寸必须是正有限毫米值。');
    if(typeof value.name!=='string'||!value.name.trim()||value.name.length>512)throw new Error('请输入有效的新工程名称。');
    if(typeof value.copyWorldObjects!=='boolean')throw new Error('对象复制选项无效。');
    return{start:[...value.start],end:[...value.end],up:[...value.up],rotationDegrees:value.rotationDegrees,width:Math.max(1,Math.round(value.widthMm/value.pixelSize)),height:Math.max(1,Math.round(value.heightMm/value.pixelSize)),pixelSize:value.pixelSize,sliceDistance:value.sliceDistance,updateCoordinateSystem:value.updateCoordinateSystem,interpolation:value.interpolation,background:value.background};
  }
  const preview=computed<ResliceProjectPreview>(()=>{
    const current=draft.value;if(!current||!c.volume.value)return{plan:null,error:'请先打开工程级重切片。',effectiveWidthMm:0,effectiveHeightMm:0,estimatedBytes:0,warnings:[]};
    try{
      const config=options(current),plan=createResliceProjectGeometry(config),bytes=plan.dims.reduce((a,b)=>a*b,1)*(4+c.state.value.masks.length);
      if(bytes>256*1024*1024)throw new Error('影像与全部Mask输出超过当前256MiB预算。');
      const warnings=['毫米宽高按最接近的整数像素量化；末层不越过线段终点。'];
      if(current.copyWorldObjects)validateResliceProjectObjects(c.volume.value,c.snapshot(),true);
      else warnings.push('新工程保留重采样影像与全部Mask；Part、测量、中心线、轮廓与RP保留在原工程。');
      if(current.updateCoordinateSystem)warnings.push('坐标更新以首像素中心为原点、行列层方向为正XYZ；应使用随附矩阵对齐外部对象。');
      return{plan,error:'',effectiveWidthMm:plan.dims[0]*current.pixelSize,effectiveHeightMm:plan.dims[1]*current.pixelSize,estimatedBytes:bytes,warnings};
    }catch(reason){return{plan:null,error:reason instanceof Error?reason.message:String(reason),effectiveWidthMm:0,effectiveHeightMm:0,estimatedBytes:0,warnings:[]};}
  });
  const lines=computed<WorldReferenceLine[]>(()=>{
    if(!open.value||!draft.value)return[];const current=draft.value,result:WorldReferenceLine[]=[];
    if([...current.start,...current.end].every(Number.isFinite))result.push({id:'reslice-project-axis',points:[[...current.start],[...current.end]],color:'#ffba6a',label:'Reslice line'});
    const corners=preview.value.plan?.geometry.supportCorners;
    if(corners?.length===8){let edge=0;for(let i=0;i<8;i++)for(const bit of [1,2,4])if(!(i&bit))result.push({id:'reslice-project-box:'+edge++,points:[[...corners[i]!],[...corners[i|bit]!]],color:'#f5cb6b'});}
    if(drawing.value&&linePoints.value.length)result.push({id:'reslice-project-draw-points',points:linePoints.value.map(p=>[...p]),color:'#ffeaba'});
    return result;
  });
  const summary=computed<ResliceProjectResultSummary|null>(()=>result.value?{name:result.value.volume.name,dims:[...result.value.volume.dims],masks:result.value.state.masks.length,parts:result.value.state.parts.length,measurements:result.value.state.measurements.length,grayOutside:result.value.sampling.coverage.grayOutside,written:written.value}:null);
  function ready(){if(!c.volume.value||!c.grid.value||!c.physicalUnitsKnown.value)throw new Error('请先加载并确认影像空间单位。');if(c.busy.value)throw new Error('请等待当前任务结束。');return c.grid.value;}
  function sourceCorners(grid:VolumeGrid){const points:Vec3[]=[];for(const z of [0,grid.dims[2]-1])for(const y of [0,grid.dims[1]-1])for(const x of [0,grid.dims[0]-1])points.push(physicalPoint([x,y,z],grid));return points;}
  function along(normal:Vec3,up:Vec3){
    const grid=ready(),n=unit(normal),center=physicalPoint(grid.dims.map(value=>(value-1)/2) as Vec3,grid),offsets=sourceCorners(grid).map(p=>dot(sub(p,center),n)),lo=Math.min(...offsets),hi=Math.max(...offsets);
    const endOffset=hi>lo?hi:lo+grid.spacing[2]/2;
    return{start:center.map((v,k)=>v+n[k]!*lo) as Vec3,end:center.map((v,k)=>v+n[k]!*endOffset) as Vec3,up:[...up] as Vec3};
  }
  function preset(kind:'source'|'world-x'|'world-y'|'world-z'){
    try{
      if(!draft.value||!['source','world-x','world-y','world-z'].includes(kind))return false;
      const grid=ready(),normal:Vec3=kind==='source'?sub(physicalPoint([0,0,1],grid),physicalPoint([0,0,0],grid)):kind==='world-x'?[1,0,0]:kind==='world-y'?[0,1,0]:[0,0,1];
      const up:Vec3=kind==='source'?sub(physicalPoint([0,1,0],grid),physicalPoint([0,0,0],grid)):kind==='world-y'?[0,0,1]:[0,1,0];
      return updateDraft(along(normal,up));
    }catch(reason){fail(reason);return false;}
  }
  function show(){
    try{
      const grid=ready();c.beforeOpen();
      if(!draft.value||sourceVolume!==c.volume.value){
        const pixelSize=Math.min(grid.spacing[0],grid.spacing[1]),normal=sub(physicalPoint([0,0,1],grid),physicalPoint([0,0,0],grid)),up=sub(physicalPoint([0,1,0],grid),physicalPoint([0,0,0],grid)),line=along(normal,up);
        draft.value={name:c.volume.value!.name.replace(/\.(nii(\.gz)?|zip)$/i,'')+' 重切片',...line,rotationDegrees:0,widthMm:grid.dims[0]*grid.spacing[0],heightMm:grid.dims[1]*grid.spacing[1],pixelSize,sliceDistance:grid.spacing[2],interpolation:'linear',background:c.volume.value!.min,updateCoordinateSystem:false,copyWorldObjects:true};
        sourceVolume=c.volume.value;sourceRevision=c.revision.value;result.value=null;written.value=false;
      }
      open.value=true;error.value='';return true;
    }catch(reason){fail(reason);return false;}
  }
  function updateDraft(patch:Partial<ResliceProjectDraft>){
    if(!draft.value||c.busy.value||!patch||typeof patch!=='object')return false;
    const allowed=new Set(Object.keys(draft.value));if(Object.keys(patch).some(key=>!allowed.has(key)))return false;
    const next={...draft.value,...patch};
    try{draft.value=cloneDraft(next);error.value='';return true;}catch(reason){fail(reason);return false;}
  }
  function cancelLine(){const had=drawing.value;drawing.value=false;linePoints.value=[];drawVolume=null;drawRevision=-1;if(had)nextLineToken();if(c.tool.value==='reslice-project-line')c.tool.value='navigate';}
  function drawLine(){
    try{ready();c.beforeOpen();cancelLine();nextLineToken();drawing.value=true;linePoints.value=[];drawVolume=c.volume.value;drawRevision=c.revision.value;c.tool.value='reslice-project-line';open.value=true;error.value='';return true;}catch(reason){fail(reason);return false;}
  }
  function addLinePoint(change:ResliceProjectPoint){
    if(!drawing.value||c.tool.value!=='reslice-project-line'||c.busy.value||!change||change.lineToken!==lineToken.value||!Number.isSafeInteger(change.lineToken)||change.volume!==drawVolume||change.volume!==c.volume.value||change.revision!==drawRevision||change.revision!==c.revision.value)return false;
    try{
      if(!Array.isArray(change.position)||change.position.length!==3||![change.position[0],change.position[1],change.position[2]].every(Number.isFinite))return false;
      if(change.mprPlane){
        const plane=validateMprPlane(change.mprPlane);if(change.mprRevision!==c.poseRevision.value||!c.validMprPlane(plane))return false;
        const projected=mprWorldToPixel(plane,change.position);
        if(Math.abs(projected.distance)>1e-5||projected.pixel.some((value,axis)=>value<-.5||value>plane.size[axis]!-.5))return false;
      }
      else if(change.mprRevision!==undefined)return false;
      if(change.partId&&!c.state.value.parts.some(part=>part.id===change.partId&&part.visible&&part.opacity>0))return false;
      if(!change.partId){const voxel=worldToVoxel(change.position,c.grid.value!);if(voxel.some((value,axis)=>!Number.isFinite(value)||value<-.5||value>c.grid.value!.dims[axis]!-.5))return false;}
      if(!linePoints.value.length){linePoints.value=[[...change.position]];return true;}
      const start=linePoints.value[0]!;if(Math.hypot(...sub(change.position,start))<1e-8){fail('线段终点必须不同于起点。');return false;}
      const end=[...change.position] as Vec3;cancelLine();return updateDraft({start:[...start],end});
    }catch(reason){fail(reason);return false;}
  }
  function useCurrentMpr(){
    try{ready();const plane=c.currentMpr();if(!plane)throw new Error('请先定义在线MPR平面。');const p=validateMprPlane(plane),grid=c.grid.value!,center=mprPlaneCenter(p),n=mprPlaneNormal(p),offsets=sourceCorners(grid).map(q=>dot(sub(q,center),n));return updateDraft({start:center.map((v,k)=>v+n[k]!*Math.min(...offsets)) as Vec3,end:center.map((v,k)=>v+n[k]!*Math.max(...offsets)) as Vec3,up:[...p.v],widthMm:p.size[0]*Math.hypot(...p.u),heightMm:p.size[1]*Math.hypot(...p.v),rotationDegrees:0});}catch(reason){fail(reason);return false;}
  }
  function cancel(){generation++;if(working){working=false;c.abort();}cancelLine();}
  function close(){cancel();open.value=false;}
  async function generate(){
    if(c.busy.value||working)return false;
    let token:number|undefined;
    try{
      ready();if(!draft.value||drawing.value||!preview.value.plan)throw new Error(preview.value.error||'请先完成有效重切片参数。');
      const config=cloneDraft(draft.value),key=draftKey(config),originalVolume=c.volume.value!,originalRevision=c.revision.value,state=c.snapshot();
      validateProject(originalVolume,state);validateResliceProjectObjects(originalVolume,state,config.copyWorldObjects);
      token=++generation;working=true;error.value='';result.value=null;written.value=false;
      const {data:_data,...metadata}=originalVolume;
      const value=await c.run<PreparedResliceProject>({kind:'reslice-project',options:{sourceVolume:metadata,sourceState:state,settings:options(config),name:config.name,copyWorldObjects:config.copyWorldObjects,updateCoordinateSystem:config.updateCoordinateSystem}});
      if(token!==generation||c.volume.value!==originalVolume||c.revision.value!==originalRevision||draftKey(draft.value)!==key)return false;
      working=false;if(!value)return false;validateProject(value.volume,value.state);result.value=value;sourceVolume=originalVolume;sourceRevision=originalRevision;c.status.value='已生成独立重切片工程；原工程保持不变，请保存或打开结果';return true;
    }catch(reason){if(token===undefined)fail(reason);else if(token===generation){working=false;fail(reason);}return false;}
    finally{if(token===generation)working=false;}
  }
  async function deliverResult(delivery?:SaveFileRequest['delivery']){
    const prepared=result.value;if(!prepared||c.busy.value)return;
    try{
      const outcome=await c.save({name:prepared.state.name+'.deepmark.zip',mime:'application/zip',extension:'.zip',description:'重切片工程与变换矩阵',...(delivery?{delivery}:{}),produce:()=>c.archive(prepared)});
      if(outcome?.status==='written'&&result.value===prepared)written.value=true;return outcome;
    }catch(reason){fail(reason);return;}
  }
  function saveResult(){return deliverResult();}
  function downloadResult(){return deliverResult('download');}
  async function saveTransforms(){
    const prepared=result.value;if(!prepared||c.busy.value)return;
    try{return await c.save({name:prepared.state.name+'.reslice-transform.txt',mime:'text/plain',extension:'.txt',description:'重切片坐标变换矩阵',produce:()=>new TextEncoder().encode(prepared.transformationText)});}catch(reason){fail(reason);return;}
  }
  function openResult(){const prepared=result.value;if(!prepared||c.busy.value)return false;cancelLine();const accepted=c.openResult(prepared);open.value=false;return accepted;}
  watch(()=>draftKey(draft.value),(next,previous)=>{if(next===previous)return;if(working){generation++;working=false;c.abort();}result.value=null;written.value=false;},{flush:'sync'});
  watch([c.volume,c.revision],()=>{
    if(drawing.value)cancelLine();if(working){generation++;working=false;c.abort();}
    if(sourceVolume!==c.volume.value){open.value=false;draft.value=null;result.value=null;sourceVolume=null;sourceRevision=-1;written.value=false;}
    else if(sourceRevision!==c.revision.value){result.value=null;written.value=false;sourceRevision=c.revision.value;}
  },{flush:'sync'});
  watch(c.tool,next=>{if(drawing.value&&next!=='reslice-project-line')cancelLine();},{flush:'sync'});
  return{open,draft,preview,drawing,linePoints,lineToken,lines,error,result,summary,show,updateDraft,preset,drawLine,cancelLine,addLinePoint,useCurrentMpr,generate,saveResult,downloadResult,saveTransforms,openResult,cancel,close};
}
