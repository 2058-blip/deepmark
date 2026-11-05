import {computed,reactive,ref,shallowRef} from 'vue';
import type {Ref,ShallowRef,ComputedRef} from 'vue';
import type {Volume} from '../core.ts';
import {planeAxes,planePoint} from '../core.ts';
import {download} from '../view.ts';
import {objectId,addMask,addPart} from './project.ts';
import {inheritPartSource} from './partProvenance.ts';
import type {ProjectState,CenterlineObject,PolylineObject} from './project.ts';
import type {OperationRequest} from './operationClient.ts';
import type {CenterlineGraph,CenterlineMeasurementRow} from './centerline.ts';
import {exportCenterlineCSV,deleteCenterlineBranch} from './centerline.ts';
import type {ContourSet,BitmapLabelResult} from './contours.ts';
import {isPhysicalContourSet,type PhysicalContourSet} from './physicalContours.ts';
import {affinePlaneViewingPlane} from './affinePlane.ts';
import type {CutResult,SurfacePathResult} from './meshTools.ts';
import {physicalPoint,type Vec3,type VolumeGrid,type MaskObject,type PartObject,type TriangleMesh,type Axis,type MaskResult,type MprPlane} from './types.ts';

interface Context {
  volume:ShallowRef<Volume|null>; grid:ComputedRef<VolumeGrid|null>; state:ShallowRef<ProjectState>;
  activeMask:ComputedRef<MaskObject|undefined>;activePart:ComputedRef<PartObject|undefined>;
  point:Ref<Vec3>;activeAxis:Ref<Axis>;tool:Ref<string>;objectTab:Ref<string>;busy:Ref<boolean>;status:Ref<string>;
  commit:(name:string,state:ProjectState)=>void; fail:(error:unknown)=>void;
  runJob:<T>(request:OperationRequest,name:string,update?:(result:T,state:ProjectState)=>ProjectState)=>Promise<T|undefined>;
  runMask:(kind:string,name:string,options?:Record<string,unknown>,seed?:Vec3,toPreview?:boolean,temporary?:boolean)=>Promise<void>;
  locatePlane?:(plane:MprPlane)=>boolean;
}
export function useAdvancedTools(c:Context){
  const seeds=ref<Vec3[]>([]),rows=shallowRef<CenterlineMeasurementRow[]>([]);
  const parameters=reactive({mode:'centerline',centerlineSource:'mask',controlSpacingMm:2,centerWeight:2,smoothFactor:.1,shortBranchMm:3,branchId:'',pointIndex:0,movePoint:[0,0,0] as Vec3,influenceMm:5,cutNormal:[0,0,1] as Vec3,cutOrigin:[0,0,0] as Vec3,cap:true,keepOriginals:true,stitchTolerance:.001,polylineAxis:2 as Axis,physicalLayer:0,labelText:'A',labelHeightMm:8,labelDepthMm:2,labelFont:'Arial',labelOperation:'add',smoothStrategy:'majority-26',smoothIterations:1});
  const centerlines=computed(()=>c.state.value.centerlines||[]),polylines=computed(()=>c.state.value.polylines||[]);
  const activeCenterline=computed(()=>centerlines.value.find(o=>o.id===c.state.value.selectedCenterlineId)||centerlines.value.at(-1));
  const activePolyline=computed(()=>polylines.value.find(o=>o.id===c.state.value.selectedPolylineId)||polylines.value.at(-1));
  const physicalPolyline=computed(()=>!!activePolyline.value&&isPhysicalContourSet(activePolyline.value.set));
  const physicalPolylineLines=computed(()=>{
    const lines:{id:string;points:Vec3[];color:string;label?:string}[]=[];
    for(const object of polylines.value){if(!object.visible||!isPhysicalContourSet(object.set))continue;for(let index=0;index<object.set.layers.length;index++){
      const layer=object.set.layers[index]!;for(let ringIndex=0;ringIndex<layer.rings.length;ringIndex++){
        const ring=layer.rings[ringIndex]!,frame=layer.plane,points=ring.points.map(point=>frame.origin.map((value,k)=>value+frame.u[k]!*point[0]+frame.v[k]!*point[1]) as Vec3);if(points.length)points.push([...points[0]!]);
        lines.push({id:object.id+':physical:'+index+':'+ringIndex,points,color:object.color,...(index===parameters.physicalLayer?{label:object.name+' / '+(index+1)}:{})});
      }
    }}return lines;
  });
  const branch=computed(()=>activeCenterline.value?.graph.branches.find(b=>b.id===parameters.branchId)||activeCenterline.value?.graph.branches[0]);
  const overlayLines=computed(()=>{
    const lines:{id:string;points:Vec3[];color:string;label?:string}[]=[];
    for(const o of centerlines.value)if(o.visible)for(const b of o.graph.branches)lines.push({id:o.id+':'+b.id,points:b.points,color:o.color,label:o.name+' / '+b.id});
    if(c.grid.value)for(const o of polylines.value)if(o.visible&&!isPhysicalContourSet(o.set))for(const layer of o.set.layers){if(layer.plane.index!==c.point.value[layer.plane.axis])continue;for(let n=0;n<layer.rings.length;n++){const ring=layer.rings[n];const points=ring.points.map(p=>physicalPoint(planePoint(layer.plane.axis,layer.plane.index,...p),c.grid.value!));if(points.length)points.push(points[0]);lines.push({id:o.id+':'+layer.plane.index+':'+n,points,color:o.color});}}
    lines.push(...physicalPolylineLines.value);
    if(c.grid.value&&seeds.value.length)lines.push({id:'centerline-seeds',points:seeds.value.map(p=>physicalPoint(p,c.grid.value!)),color:'#f6ac71',label:'中心线约束点'});
    return lines;
  });
  function selectCenterline(id:string){c.state.value={...c.state.value,selectedCenterlineId:id};rows.value=[];parameters.branchId='';parameters.pointIndex=0;}
  function selectPolyline(id:string){if(c.busy.value||!polylines.value.some(object=>object.id===id))return;c.state.value={...c.state.value,selectedPolylineId:id};parameters.physicalLayer=0;}
  function addSeed(p:Vec3){if(c.busy.value)return;seeds.value=[...seeds.value,p.map(Math.round) as Vec3];c.status.value=seeds.value.length===1?'已设置根点；继续点选一个或多个终点':'已添加终点；点击计算中心线';}
  function startSeeds(){seeds.value=[];c.tool.value='centerline';c.status.value='先在结构内部点根点，再点一个或多个终点；可以跨切片';}
  function graphObject(graph:CenterlineGraph,source?:MaskObject):CenterlineObject{return{id:objectId('centerline'),name:`中心线 ${centerlines.value.length+1}`,color:'#ffbe68',visible:true,graph,sourceMaskId:source?.id,sourceRevision:source?.revision};}
  async function fit(){
    if(seeds.value.length<2){c.fail('请先指定根点及至少一个终点。');return;}
    const source=c.activeMask.value,part=c.activePart.value;
    if(parameters.centerlineSource==='mask'&&!source||parameters.centerlineSource==='part'&&!part){c.fail('请选择中心线输入对象。');return;}
    const result=await c.runJob<CenterlineGraph>({kind:parameters.centerlineSource==='part'?'centerlineFromMesh':'centerline',mask:source?.data,mesh:part?.mesh,options:{root:seeds.value[0],endpoints:seeds.value.slice(1),coordinateSpace:'voxel',controlSpacingMm:parameters.controlSpacingMm,centerWeight:parameters.centerWeight}},'计算中心线',(graph,s)=>{const o={...graphObject(graph,parameters.centerlineSource==='mask'?source:undefined),...(parameters.centerlineSource==='part'?{sourcePartId:part!.id}:{})};return{...s,centerlines:[...(s.centerlines||[]),o],selectedCenterlineId:o.id};});
    if(result)seeds.value=[];c.objectTab.value='curves';
  }
  async function editGraph(kind:string,name:string,options:Record<string,unknown>){
    const current=activeCenterline.value;if(!current)return;
    const source=current.sourceMaskId?c.state.value.masks.find(m=>m.id===current.sourceMaskId):undefined;
    const part=current.sourcePartId?c.state.value.parts.find(p=>p.id===current.sourcePartId):undefined;
    if(!source&&!part){c.fail('中心线来源已删除，无法核对编辑后的内部路径。');return;}
    await c.runJob<CenterlineGraph>({kind,mask:source?.data,mesh:part?.mesh,options:{...options,graph:current.graph}},name,(graph,s)=>({...s,centerlines:s.centerlines?.map(o=>o.id===current.id?{...o,graph}:o)}));rows.value=[];
  }
  function smooth(){return editGraph('smoothCenterline','平滑中心线',{factor:parameters.smoothFactor});}
  function filter(){return editGraph('filterCenterline','过滤短分支',{thresholdMm:parameters.shortBranchMm});}
  function setMovePoint(){const b=branch.value;if(!b)return;parameters.movePoint=[...b.points[Math.min(b.points.length-1,Math.max(0,parameters.pointIndex))]];}
  function movePoint(){const b=branch.value;if(!b)return;return editGraph('moveCenterline','移动中心线控制点',{branchId:b.id,pointIndex:parameters.pointIndex,position:parameters.movePoint,influenceMm:parameters.influenceMm});}
  function grow(){if(!c.grid.value||!branch.value)return;return editGraph('growCenterline','延长中心线分支',{branchId:branch.value.id,pointIndex:parameters.pointIndex,end:physicalPoint(c.point.value,c.grid.value),controlSpacingMm:parameters.controlSpacingMm});}
  async function split(){const current=activeCenterline.value,b=branch.value;if(!current||!b)return;await c.runJob<CenterlineGraph[]>({kind:'splitCenterline',options:{graph:current.graph,branchId:b.id,pointIndex:parameters.pointIndex}},'分割中心线',(graphs,s)=>{const objects=graphs.map(graph=>graphObject(graph));return{...s,centerlines:[...(s.centerlines||[]).filter(o=>o.id!==current.id),...objects],selectedCenterlineId:objects[0]?.id};});}
  function deleteBranch(){const current=activeCenterline.value,b=branch.value;if(!current||!b)return;try{const graph=deleteCenterlineBranch(current.graph,b.id);c.commit('删除中心线分支',{...c.state.value,centerlines:centerlines.value.map(o=>o.id===current.id?{...o,graph}:o)});rows.value=[];}catch(e){c.fail(e);}}
  async function measure(){if(!activeCenterline.value||!c.activePart.value){c.fail('请选择中心线及截面分析所用的三维表面。');return;}const result=await c.runJob<CenterlineMeasurementRow[]>({kind:'measureCenterline',mesh:c.activePart.value.mesh,options:{graph:activeCenterline.value.graph,controlPointsOnly:true}},'中心线截面测量');if(result)rows.value=result;}
  function exportCSV(){if(activeCenterline.value)download(exportCenterlineCSV(activeCenterline.value.graph,rows.value),activeCenterline.value.name+'.csv','text/csv;charset=utf-8');}
  async function calculatePolylines(){const source=c.activeMask.value;if(!source)return;await c.runJob<ContourSet>({kind:'polylines',mask:source.data,options:{axis:parameters.polylineAxis}},'计算轮廓',(set,s)=>{const o:PolylineObject={id:objectId('polylines'),name:source.name+' 轮廓',color:'#f7d669',visible:true,set,sourceMaskId:source.id,sourceRevision:source.revision};return{...s,polylines:[...(s.polylines||[]),o],selectedPolylineId:o.id};});c.objectTab.value='curves';}
  function locatePolylineLayer(){
    const object=activePolyline.value;if(!object||!isPhysicalContourSet(object.set)||!Number.isSafeInteger(parameters.physicalLayer))return false;
    const layer=object.set.layers[parameters.physicalLayer];if(!layer)return false;
    try{return c.locatePlane?.(affinePlaneViewingPlane(layer.plane))??false;}catch(error){c.fail(error);return false;}
  }
  async function updatePolylines(){
    const o=activePolyline.value;if(!o)return;const source=c.state.value.masks.find(m=>m.id===o.sourceMaskId);if(!source){c.fail('轮廓的来源Mask已删除，请重新计算完整轮廓集合。');return;}
    if(isPhysicalContourSet(o.set)){
      const index=parameters.physicalLayer;if(!Number.isSafeInteger(index)||index<0||index>=o.set.layers.length){c.fail('请选择有效的物理轮廓层。');return;}
      await c.runJob<PhysicalContourSet>({kind:'updatePhysicalPolylines',mask:source.data,options:{set:o.set,index,sourceRevision:source.revision}},'更新物理轮廓层',(set,s)=>{
        const revision=set.layers.every(layer=>layer.sourceRevision===source.revision)?source.revision:o.sourceRevision;
        return{...s,polylines:s.polylines?.map(p=>p.id===o.id?{...p,set,...(revision===undefined?{}:{sourceRevision:revision})}:p)};
      });return;
    }
    await c.runJob<ContourSet>({kind:'updatePolylines',mask:source.data,options:{set:o.set,index:c.point.value[o.set.axis]}},'更新当前层轮廓',(set,s)=>({...s,polylines:s.polylines?.map(p=>p.id===o.id?{...p,set,sourceRevision:source.revision}:p)}));
  }
  async function fillPolylines(){const o=activePolyline.value;if(!o||!c.grid.value)return;await c.runJob<MaskResult>({kind:isPhysicalContourSet(o.set)?'physicalPolylinesToMask':'polylinesToMask',options:{set:o.set}},'由轮廓填充Mask',(result,s)=>addMask(s,c.grid.value!.data.length,o.name+' Mask',result.mask));c.objectTab.value='masks';}
  function exportPolylines(){if(activePolyline.value)download(JSON.stringify(activePolyline.value.set),activePolyline.value.name+'.polylines.json','application/json');}
  function toggleCurve(id:string,type:'centerline'|'polyline'){const key=type==='centerline'?'centerlines':'polylines';c.commit('修改曲线显隐',{...c.state.value,[key]:(c.state.value[key]||[]).map(o=>o.id===id?{...o,visible:!o.visible}:o)});}
  function deleteCurve(id:string,type:'centerline'|'polyline'){const s=c.state.value;if(type==='centerline'){const list=(s.centerlines||[]).filter(o=>o.id!==id);c.commit('删除中心线',{...s,centerlines:list,selectedCenterlineId:list[0]?.id||''});}else{const list=(s.polylines||[]).filter(o=>o.id!==id);c.commit('删除轮廓',{...s,polylines:list,selectedPolylineId:list[0]?.id||''});}}
  async function label(){
    if(!c.grid.value||!c.activeMask.value)return;
    try{
      if(!parameters.labelText.trim()||parameters.labelText.length>120||!Number.isFinite(parameters.labelHeightMm)||parameters.labelHeightMm<=0)throw new Error('请输入有效文字和高度。');
      const plane=c.activeAxis.value,[a,b]=planeAxes(plane),pixel=Math.min(c.grid.value.spacing[a]/2,c.grid.value.spacing[b]/2,parameters.labelHeightMm/32);
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;ctx.font=`64px ${parameters.labelFont}`;const trial=ctx.measureText(parameters.labelText),glyphHeight=trial.actualBoundingBoxAscent+trial.actualBoundingBoxDescent;
      if(!Number.isFinite(glyphHeight)||glyphHeight<=0)throw new Error('此文字没有可渲染的字形边界。');
      const fontPixels=parameters.labelHeightMm/pixel*64/glyphHeight;if(fontPixels>512)throw new Error('文字光栅过大，请减小文字高度。');
      ctx.font=`${fontPixels}px ${parameters.labelFont}`;const text=ctx.measureText(parameters.labelText);canvas.width=Math.ceil(text.actualBoundingBoxLeft+text.actualBoundingBoxRight)+4;canvas.height=Math.ceil(text.actualBoundingBoxAscent+text.actualBoundingBoxDescent)+4;
      if(canvas.width*canvas.height>2_000_000)throw new Error('文字光栅过大。');
      ctx.font=`${fontPixels}px ${parameters.labelFont}`;ctx.textBaseline='alphabetic';ctx.fillStyle='white';ctx.fillText(parameters.labelText,2+text.actualBoundingBoxLeft,2+text.actualBoundingBoxAscent);const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,alpha=new Uint8Array(canvas.width*canvas.height);for(let i=0;i<alpha.length;i++)alpha[i]=rgba[4*i+3];
      await c.runMask('label','实体Label',{bitmap:{width:canvas.width,height:canvas.height,data:alpha},origin:c.point.value,axis:plane,pixelSizeMm:[pixel,pixel],depthMm:parameters.labelDepthMm,direction:'auto',flipV:true,operation:parameters.labelOperation},undefined,true);
    }catch(e){c.fail(e);}
  }
  function smoothMask(){return c.runMask('smoothMask','Mask多数平滑',{strategy:parameters.smoothStrategy,iterations:parameters.smoothIterations});}
  function cutAtCrosshair(){if(c.grid.value)parameters.cutOrigin=physicalPoint(c.point.value,c.grid.value);}
  async function cut(){const part=c.activePart.value;if(!part)return;const keep=parameters.keepOriginals;await c.runJob<CutResult>({kind:'cut',mesh:part.mesh,options:{plane:{origin:parameters.cutOrigin,normal:parameters.cutNormal},cap:parameters.cap}},'平面切割',(result,s)=>{if(!result.intersects)throw new Error('切平面没有穿过当前表面。');let next=s;for(const [mesh,suffix] of [[result.positive,'正侧'],[result.negative,'负侧']] as const){if(!mesh.indices.length)continue;next=addPart(next,mesh);next={...next,parts:next.parts.map(p=>p.id===next.selectedPartId?{...p,name:part.name+' '+suffix,color:part.color,...inheritPartSource(part)}:p)};}if(!keep)next={...next,parts:next.parts.filter(p=>p.id!==part.id)};return next;});c.objectTab.value='parts';}
  async function splitParts(){const part=c.activePart.value;if(!part)return;const keep=parameters.keepOriginals;await c.runJob<TriangleMesh[]>({kind:'split',mesh:part.mesh},'分离连通壳',(pieces,s)=>{if(pieces.length<2)throw new Error('当前表面只有一个连通壳。');let next=s;pieces.forEach((mesh,i)=>{next=addPart(next,mesh);next={...next,parts:next.parts.map(p=>p.id===next.selectedPartId?{...p,name:part.name+' 壳'+(i+1),color:part.color,...inheritPartSource(part)}:p)};});return keep?next:{...next,parts:next.parts.filter(p=>p.id!==part.id)};});}
  async function repair(kind:'fixNormals'|'stitch'){const part=c.activePart.value;if(!part)return;await c.runJob<TriangleMesh>({kind,mesh:part.mesh,options:{tolerance:parameters.stitchTolerance,preserveCavities:true}},kind==='fixNormals'?'修正法线':'缝合开放边',(mesh,s)=>{const next=addPart(s,mesh);return{...next,parts:next.parts.map(p=>p.id===next.selectedPartId?{...p,...inheritPartSource(part)}:p)};});}
  async function surfacePath(points:Vec3[],partId:string,replaceId?:string){
    const part=c.state.value.parts.find(p=>p.id===partId);if(!part||points.length<2){c.fail('请在同一表面上设置至少两个路径约束点。');return;}
    return c.runJob<SurfacePathResult>({kind:'surfacePath',mesh:part.mesh,options:{points}},'曲面路径测量',(result,s)=>{
      const previous=replaceId?s.measurements.find(m=>m.id===replaceId):undefined;
      if(replaceId&&(!previous||previous.kind!=='surface-distance'||previous.partId!==partId))throw new Error('原曲面测量已变化，不能替换旧路径。');
      const m={...(previous??{id:objectId('measurement'),name:'曲面路径',color:'#ffdf7a',visible:true}),kind:'surface-distance' as const,points:result.points,controlPoints:result.projectedPoints,pathMethod:'edge-graph' as const,partId};
      return{...s,measurements:replaceId?s.measurements.map(old=>old.id===replaceId?m:old):[...s.measurements,m]};
    });
  }
  return {parameters,seeds,rows,centerlines,polylines,activeCenterline,activePolyline,physicalPolyline,physicalPolylineLines,locatePolylineLayer,branch,overlayLines,selectCenterline,selectPolyline,addSeed,startSeeds,fit,smooth,filter,setMovePoint,movePoint,grow,split,deleteBranch,measure,exportCSV,calculatePolylines,updatePolylines,fillPolylines,exportPolylines,toggleCurve,deleteCurve,label,smoothMask,cutAtCrosshair,cut,splitParts,repair,surfacePath};
}
