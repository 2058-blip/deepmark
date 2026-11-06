import type {DraftBounds} from './slicePixels.ts';
import {computed,ref,shallowRef,reactive,watch,onBeforeUnmount,onMounted,getCurrentInstance} from 'vue';
import {makeDemo,exportNifti,planeAxes,indexOf} from '../core.ts';
import type {Volume} from '../core.ts';
import {readFile,download} from '../view.ts';
import {createProject,volumeGrid,ProjectHistory,replaceMask,addMask,addPart,objectId,encodeProject,decodeProject,validateProject,validateMeasurementObject} from './project.ts';
import type {ProjectState,ProjectViewState} from './project.ts';
import {OperationClient} from './operationClient.ts';
import {makeVesselDemo} from './demo.ts';
import type {OperationRequest} from './operationClient.ts';
import {useAdvancedTools} from './useAdvancedTools.ts';
import {maskStatistics,polygonRaster,applySelection} from './segmentation.ts';
import {meshStats,exportSTL,parseSTL} from './geometry.ts';
import {worldToVoxel,evaluateMeasurement,densityStatistics} from './measurements.ts';
import type {EvaluationKind} from './measurements.ts';
import {liveWirePath} from './livewire.ts';
import type {LiveWireTree} from './livewire.ts';
import {parseDicom,groupDicomSeries,convertSeriesToVolume} from './dicom.ts';
import type {DicomSeries,DicomVolume} from './dicom.ts';
import {physicalPoint,voxelIndex} from './types.ts';
import {brushSweepFootprint,MAX_BRUSH_SCAN_VISITS,normalizeBrushSize} from './viewportGeometry.ts';
import {sameImageGeometry,splitImportedLabels} from './segmentationImport.ts';
import {IndexedDBWorkspaceRepository,WorkspaceSaveQueue} from './workspaceRepository.ts';
import type {WorkspaceRepository,WorkspaceSnapshot,WorkspaceSummary} from './workspaceRepository.ts';
import {saveLocalFile} from './fileTransfer.ts';
import {useLocalThreshold} from './useLocalThreshold.ts';
import {useMeasurementProperties} from './useMeasurementProperties.ts';
import {uniformMeasurementPartId,measurementPartIds} from './measurementAttachments.ts';
import {isDensityROI,densityROIHasArea,normalizeDensityROI} from './roiGeometry.ts';
import {useMprView,sameMprPlane,sameMprOrientation,coplanarMprPlanes} from './useMprView.ts';
import {validateMprPlane,mprPlaneNormal,mprPlaneCenter,mprPixelToWorld,mprWorldToPixel,fitMprPlane} from './mpr.ts';
import {sourceSliceMprPlane} from './mprInteraction.ts';
import {validateAffinePlane,affinePlaneWorldToPixel,affinePlanePixelToWorld,affinePlaneNormal,affinePlaneViewingPlane,coplanarAffinePlanes,sameAffinePlane} from './affinePlane.ts';
import {useResliceObjects} from './useResliceObjects.ts';
import {useMprBrush} from './useMprBrush.ts';
import {useMprContour} from './useMprContour.ts';
import {useResliceProject} from './useResliceProject.ts';
import {meshFromReference,type MeshCoordinateFrame} from './meshExchange.ts';
import type {SaveFileHandler,SaveFileRequest,SaveFileResult} from './fileTransfer.ts';
import type {SurfaceOptions} from './geometry.ts';
import type {Axis,Vec3,BinaryMask,MaskResult,TriangleMesh,MaskObject,MeasurementObject,MeasurementKind,SlicePlane,MprPlane,AffinePlane,ReslicePlaneObject} from './types.ts';

export interface WorkbenchOptions {repository?:WorkspaceRepository|null;saveFile?:SaveFileHandler;autosaveDelayMs?:number}
interface ReplacementCandidate {volume:Volume;state?:ProjectState;cacheId?:string;generated?:boolean}
interface BrushTransaction {maskId:string;tool:string;volume:Volume;revision:number;axis?:Axis;slice?:number;diameter:number;width:number;height:number;shape:'circle'|'square';lower:number;upper:number;selecting:boolean;changed:boolean;last:Vec3|null;covered:Uint8Array|null;coveredRows:Uint32Array|null;coveredCount:number;scanVisits:number}
interface ContourTransaction {maskId:string;tool:string;volume:Volume;revision:number;plane:SlicePlane;operation:'add'|'remove'|'threshold';lower:number;upper:number;temporary:boolean;selection:BinaryMask|null}
export interface CalculationRequest {maskIds:string[];quality:'optimal'|'custom';step:Vec3;smooth?:SurfaceOptions['smooth'];reduction?:SurfaceOptions['reduction'];topology:'native-table'|'resolved'}
export interface DensityROICreation {kind:'density-rectangle'|'density-ellipse';plane:SlicePlane;points:[Vec3,Vec3];volume?:Volume;revision?:number}
export interface MeasurementGeometryChange {id:string;points:Vec3[];plane?:SlicePlane;mprPlane?:MprPlane;densityPlane?:AffinePlane;mprRevision?:number;volume?:Volume;revision?:number}
export interface MeasurementLabelChange {id:string;offset:Vec3;mprPlane?:MprPlane;mprRevision?:number;volume?:Volume;revision?:number}
interface MprGesture {mprPlane:MprPlane;mprRevision?:number;volume?:Volume;revision?:number}
export interface MprTransformChange {plane:MprPlane;crosshair:Vec3;sourcePlane:MprPlane;volume:Volume;revision:number;mprRevision:number}
export interface WorkbenchMeasurementResult {kind:string;valid:boolean;value:number;unit:string;details:Record<string,unknown>;reason?:string;preview?:boolean}
export function useWorkbench(options:WorkbenchOptions={}){
  const volume=shallowRef<Volume|null>(null),state=shallowRef<ProjectState>({name:'新工程',masks:[],parts:[],measurements:[],selectedMaskId:'',selectedPartId:''});
  const history=new ProjectHistory(),historyTick=ref(0),revision=ref(0),point=ref<Vec3>([0,0,0]),activeAxis=ref<Axis>(2);
  const selectedMeasurementId=ref('');
  const measurementDraftToken=ref(0);
  const measurementPreview=shallowRef<MeasurementGeometryChange|null>(null);
  const regionSourceId=ref('');
  const renderMode=ref<'parts'|'volume'>('parts');
  const showCalculate3D=ref(false);
  const spatialUnitChoice=ref<1|2|3>(2);
  const tool=ref('navigate'),tab=ref('segmentation'),objectTab=ref('masks'),center=ref(40),width=ref(400),dirty=ref(false);
  let importController:AbortController|null=null;
  const status=ref('打开影像，或加载合成影像开始。'),error=ref(''),busy=ref(false),progress=ref(0);
  const draftBounds=shallowRef<DraftBounds|null>(null);
  const preview=shallowRef<BinaryMask|null>(null),selection=shallowRef<BinaryMask|null>(null),draft=shallowRef<BinaryMask|null>(null),draftRevision=ref(0);
  const selectionAxis=ref<Axis>(2),interpolationPreview=shallowRef<BinaryMask|null>(null);
  const draftPoints=ref<Vec3[]>([]),draftPlane=ref<SlicePlane|null>(null),series=shallowRef<DicomSeries[]>([]),seriesChoice=ref(0);
  const draftPointPartIds=ref<(string|null)[]>([]),draftPointPlanes=ref<(SlicePlane|null)[]>([]);
  const draftMprPlane=shallowRef<MprPlane|null>(null),draftPointMprPlanes=ref<(MprPlane|null)[]>([]);
  let measurementDraftKind='';
  const params=reactive({stlFrame:'reference' as MeshCoordinateFrame,lower:226,upper:1600,thresholdAutoPreview:true,thresholdKeepLargest:false,thresholdFillHoles:false,diameter:6,brushWidth:6,brushHeight:6,sameWidthHeight:true,brushShape:'circle',densityWidth:10,densityHeight:10,editOperation:'add',selectionType:'brush',connectivity:6,multiple:true,leaveOriginal:true,target:'new',lowerDeviation:30,upperDeviation:30,updateMean:true,fillCavities:false,otherMask:'',boolean:'union',morphology:'close',radius:1,morphConnectivity:26,selectionOperation:'add',copyCount:1,copyDirection:1,startSlice:0,endSlice:10,step:1,topology:'native-table',smoothIterations:3,smoothFactor:.3,compensate:true,keepOriginals:true,reduceRatio:.5,tolerance:.3,featureAngle:45,wrapResolution:1,closingDistance:2,protectThinWalls:true,annotationText:'注释',maximumExpandDistance:3,expandSensitivity:10000,expandIterations:200,expandProbability:70,livewireWeight:.6,livewireAttraction:0,roiMin:[0,0,0] as Vec3,roiMax:[0,0,0] as Vec3});
  let thresholdTimer:ReturnType<typeof setTimeout>|null=null;
  const operations=new OperationClient();let previewTarget='',previewRevision=0,previewTitle='阈值分割',previewRange:[number,number]|undefined,previewSignature='',strokeState:BrushTransaction|null=null,livewire:LiveWireTree|null=null,jobGeneration=0,currentWorkKind='';
  let contourState:ContourTransaction|null=null;
  let selectionOwner:{maskId:string;volume:Volume}|null=null;
  let interpolationSource:{selection:BinaryMask;volume:Volume;maskId:string;axis:Axis}|null=null;
  const isSelectionTool=(value:string)=>['multiple','select','deselect'].includes(value);
  const multipleEditing=computed(()=>isSelectionTool(tool.value));
  const imageTool=computed(()=>multipleEditing.value&&['lasso','livewire'].includes(params.selectionType)?params.selectionType:tool.value);
  const measurementMinimum:Record<string,number>={distance:2,angle:3,diameter:3,ellipse:3,area:3,'density-rectangle':2,'density-ellipse':2,annotation:1};
  const pendingReplacement=shallowRef<ReplacementCandidate|null>(null),showLocalProjects=ref(false),localProjects=shallowRef<WorkspaceSummary[]>([]),cacheState=ref<'unavailable'|'pending'|'saved'|'error'>('unavailable'),cacheError=ref('');
  const repository=options.repository===null?null:options.repository||((typeof indexedDB!=='undefined')?new IndexedDBWorkspaceRepository():null);
  const saveFile=options.saveFile||saveLocalFile;
  let documentId='',cacheTimer:ReturnType<typeof setTimeout>|null=null,cacheClock=0,installing=false;
  const cacheQueue=repository?new WorkspaceSaveQueue(repository,snapshot=>{
    if(snapshot.id===documentId&&snapshot.revision===revision.value&&JSON.stringify(snapshot.state.viewState)===JSON.stringify(viewState())){cacheState.value='saved';cacheError.value='';}
  },(error:unknown,snapshot?:WorkspaceSnapshot)=>{if(snapshot&&snapshot.id!==documentId)return;cacheState.value='error';cacheError.value=error instanceof Error?error.message:String(error);}):null;
  const imageMeta=computed(()=>(volume.value as DicomVolume|null)?.dicom);
  let surfacePartId='';
  const grid=computed(()=>volume.value?volumeGrid(volume.value):null);
  const physicalUnitsKnown=computed(()=>volume.value?.unit==='mm');
  const activeMask=computed(()=>state.value.masks.find(m=>m.id===state.value.selectedMaskId));
  const regionSource=computed(()=>state.value.masks.find(m=>m.id===regionSourceId.value));
  const measurementEditor=useMeasurementProperties({state,selectedMeasurementId,busy,volume,commit,fail});
  const localThreshold=useLocalThreshold(activeMask,volume);
  const mprView=useMprView({volume,grid,point,busy,physicalUnitsKnown,cancel,fail,status});
  const interactiveMpr=ref(false);let syncingReslice=false;
  const resliceMode=ref<'view'|'rotate'|'resize'>('view'),modifyingResliceId=ref('');
  const reslices=useResliceObjects({state,volume,busy,commit,fail,onActivate:activateReslice});
  const mprBrush=useMprBrush({volume,grid,state,activeMask,tool,busy,revision,poseRevision:mprView.poseRevision,
    validPlane:plane=>mprView.enabled.value&&mprView.planes.value.some(current=>sameMprPlane(current,plane)),
    getSettings:()=>({widthMm:params.brushWidth,heightMm:params.sameWidthHeight?params.brushWidth:params.brushHeight,shape:params.brushShape as 'circle'|'square',...(tool.value==='local-threshold'?{lower:localThreshold.range.value.lower,upper:localThreshold.range.value.upper}:{})}),
    beforeBegin:()=>{brushCancel();measurementEditor.cancel();clearMeasurementDraft();reslices.cancelProperties();preview.value=null;},commit,fail,status});
  const mprContour=useMprContour({volume,grid,state,activeMask,tool,busy,active:mprView.enabled,revision,poseRevision:mprView.poseRevision,
    validPlane:plane=>mprView.enabled.value&&mprView.planes.value.some(current=>sameMprPlane(current,plane)),
    getSettings:()=>({operation:params.editOperation as 'add'|'remove'|'threshold',lower:localThreshold.range.value.lower,upper:localThreshold.range.value.upper,gradientWeight:params.livewireWeight,attraction:params.livewireAttraction,interpolation:mprView.interpolation.value}),
    beforeBegin:()=>{mprBrush.cancel();brushCancel();measurementEditor.cancel();clearMeasurementDraft();reslices.cancelProperties();preview.value=null;},
    run:<T>(request:OperationRequest)=>runJob<T>(request,'MPR 轮廓计算'),
    abort:()=>{if(currentWorkKind.startsWith('mpr-contour-')){jobGeneration++;operations.cancel();busy.value=false;progress.value=0;currentWorkKind='';}},commit,fail,status});
  const resliceProject=useResliceProject({volume,grid,state,revision,point,tool,busy,physicalUnitsKnown,poseRevision:mprView.poseRevision,
    currentMpr:()=>mprView.plane.value,validMprPlane:plane=>mprView.enabled.value&&mprView.planes.value.some(current=>sameMprPlane(current,plane)),snapshot:projectSnapshot,
    beforeOpen:()=>{cancel();endPlaneModify();interactiveMpr.value=false;},
    abort:()=>{if(currentWorkKind.startsWith('reslice-project')){jobGeneration++;operations.cancel();busy.value=false;progress.value=0;currentWorkKind='';}},
    run:<T>(request:OperationRequest)=>runJob<T>(request,'生成重切片工程'),save:saveResliceFile,
    archive:prepared=>operations.run<Uint8Array>({kind:'reslice-project-export',options:{volume:prepared.volume,state:prepared.state}}),
    openResult:prepared=>offerReplacement({volume:prepared.volume,state:prepared.state,generated:true}),status,fail});
  const interactivePlane=computed(()=>reslices.selected.value?.plane),interactiveCenter=computed(()=>interactivePlane.value?mprPlaneCenter(interactivePlane.value):undefined);
  function activateReslice(object:ReslicePlaneObject|null){
    if(installing||syncingReslice)return;syncingReslice=true;
    try{
      const ownModify=!!object&&object.id===modifyingResliceId.value&&resliceMode.value!=='view';if(!ownModify)endPlaneModify();
      if(object)syncModifiedResliceView(object.plane,ownModify);else{interactiveMpr.value=false;mprView.close();}
    }finally{syncingReslice=false;}
  }
  function syncModifiedResliceView(plane:MprPlane,preserveClosed:boolean){
    if(!preserveClosed||mprView.enabled.value){mprView.setPlane(plane);return;}
    const previous=mprView.snapshot();mprView.restore({enabled:false,plane,step:previous?.step??1,interpolation:previous?.interpolation??'linear',...(previous?.crosshair?{crosshair:previous.crosshair}:{})});
  }
  const displayMasks=computed(()=>multipleEditing.value?activeMask.value?[{...activeMask.value,visible:true}]:[]:state.value.masks);
  const activePart=computed(()=>state.value.parts.find(p=>p.id===state.value.selectedPartId));
  function displayedMeasurement(m:MeasurementObject):MeasurementObject{
    if(m.densityPlane&&isDensityROI(m.kind)&&grid.value){
      try{
        const frame=validateAffinePlane(m.densityPlane),normal=affinePlaneNormal(frame),views=mprView.enabled.value?mprView.planes.value:([0,1,2] as Axis[]).map(axis=>sourceSliceMprPlane(grid.value!,axis,point.value[axis]));
        const current=views.find(plane=>{const n=affinePlaneNormal(plane);return Math.min(Math.hypot(...n.map((value,k)=>value-normal[k]!)),Math.hypot(...n.map((value,k)=>value+normal[k]!)))<1e-12;});
        if(!current)return m;const delta=current.origin.reduce((sum,value,k)=>sum+(value-frame.origin[k]!)*normal[k]!,0),offset=normal.map(value=>value*delta) as Vec3;
        return{...m,densityPlane:{...frame,origin:frame.origin.map((value,k)=>value+offset[k]!) as Vec3},points:m.points.map(p=>p.map((value,k)=>value+offset[k]!) as Vec3)};
      }catch{return m;}
    }
    if(m.mprPlane&&isDensityROI(m.kind)){
      const current=mprView.planes.value.find(p=>sameMprOrientation(p,m.mprPlane!));if(!current)return m;
      const normal=mprPlaneNormal(current),delta=current.origin.reduce((sum,n,a)=>sum+(n-m.mprPlane!.origin[a])*normal[a],0);
      return{...m,mprPlane:validateMprPlane(current),points:m.points.map(p=>p.map((n,a)=>n+normal[a]*delta) as Vec3)};
    }
    if(!grid.value||!m.plane||!m.kind.startsWith('density'))return m;
    const plane={axis:m.plane.axis,index:point.value[m.plane.axis]};
    try{return{...m,plane,points:m.points.map(world=>{const p=worldToVoxel(world,grid.value!);p[plane.axis]=plane.index;return physicalPoint(p,grid.value!);})};}catch{return m;}
  }
  const displayMeasurements=computed(()=>state.value.measurements.map(displayedMeasurement));
  function clearMeasurementDraft(){draftPoints.value=[];draftPlane.value=null;draftMprPlane.value=null;draftPointPartIds.value=[];draftPointPlanes.value=[];draftPointMprPlanes.value=[];measurementDraftKind='';}
  function syncMeasurementDraftPlane(){
    const image=draftPointPlanes.value[0],mpr=draftPointMprPlanes.value[0],unattached=draftPointPartIds.value.every(id=>id===null);
    draftPlane.value=image&&unattached&&draftPointPlanes.value.every(p=>p?.axis===image.axis&&p.index===image.index)&&draftPointMprPlanes.value.every(p=>p===null)?{...image}:null;
    draftMprPlane.value=mpr&&unattached&&draftPointMprPlanes.value.every(p=>p!==null&&sameMprPlane(p,mpr))&&draftPointPlanes.value.every(p=>p===null)?validateMprPlane(mpr):null;
  }
  const undoName=computed(()=>{historyTick.value;return history.past.at(-1)?.name||'';}),redoName=computed(()=>{historyTick.value;return history.future.at(-1)?.name||'';});
  const maskInfo=computed(()=>{if(!grid.value||!activeMask.value)return null;return maskStatistics(grid.value,activeMask.value.data);});
  const partStatsCache=new WeakMap<Float32Array,{indices:Uint32Array;stats:ReturnType<typeof meshStats>}>();
  const partInfo=computed(()=>{
    const mesh=activePart.value?.mesh;if(!mesh)return null;
    const cached=partStatsCache.get(mesh.positions);if(cached?.indices===mesh.indices)return cached.stats;
    const stats=meshStats(mesh);partStatsCache.set(mesh.positions,{indices:mesh.indices,stats});return stats;
  });
  function fail(e:unknown){error.value=e instanceof Error?e.message:String(e);status.value=error.value;}
  function validMeasurementSelection(project:ProjectState):ProjectState{
    const id=project.viewState?.selectedMeasurementId;
    return id&&!project.measurements.some(m=>m.id===id)?{...project,viewState:{...project.viewState,selectedMeasurementId:''}}:project;
  }
  function syncSelectedMeasurement(){if(selectedMeasurementId.value&&!state.value.measurements.some(m=>m.id===selectedMeasurementId.value))selectedMeasurementId.value='';}
  function syncThresholdControls(){
    if(!volume.value)return;
    const range=activeMask.value?.threshold;
    params.lower=range?.[0]??Math.min(volume.value.max,226);params.upper=range?.[1]??volume.value.max;
  }
  function viewState():ProjectViewState{const mpr=mprView.snapshot();return{point:[...point.value],window:{center:center.value,width:width.value},activeAxis:activeAxis.value,renderMode:renderMode.value,tool:['mpr-plane','reslice-project-line'].includes(tool.value)?'navigate':tool.value,tab:tab.value as ProjectViewState['tab'],selectedMeasurementId:selectedMeasurementId.value,...(mpr?{mpr}:{})};}
  function projectSnapshot():ProjectState{return{...state.value,viewState:viewState()};}
  function cacheSnapshot():WorkspaceSnapshot|null{if(!volume.value||!documentId)return null;return{id:documentId,volume:volume.value,state:projectSnapshot(),updatedAt:cacheClock=Math.max(Date.now(),cacheClock+1),revision:revision.value};}
  function scheduleCache(){if(!cacheQueue||installing||!volume.value)return;if(cacheTimer)clearTimeout(cacheTimer);cacheState.value='pending';cacheTimer=setTimeout(()=>{cacheTimer=null;const snapshot=cacheSnapshot();if(snapshot)cacheQueue.enqueue(snapshot);},options.autosaveDelayMs??700);}
  async function flushLocalCache(){if(!cacheQueue)throw new Error('此浏览器未提供本地缓存，请先导出工程文件。');if(cacheTimer)clearTimeout(cacheTimer);cacheTimer=null;const snapshot=cacheSnapshot();if(snapshot)await cacheQueue.flush(snapshot);}
  async function listLocalProjects(){if(!repository){cacheError.value='此浏览器未提供本地工程缓存。';return;}try{localProjects.value=await repository.list();cacheError.value='';}catch(e){cacheState.value='error';cacheError.value=e instanceof Error?e.message:String(e);}}
  async function openLocalProjects(){showLocalProjects.value=true;await listLocalProjects();}
  function thresholdConfig(){return JSON.stringify([state.value.selectedMaskId,params.lower,params.upper,params.thresholdKeepLargest,params.thresholdFillHoles]);}
  function regionConfig(){return JSON.stringify([regionSourceId.value||state.value.selectedMaskId,params.target,params.connectivity,params.multiple,params.leaveOriginal]);}
  function setRegionSource(id:string){
    if(!state.value.masks.some(mask=>mask.id===id)){fail('请选择有效的 Source Mask。');return false;}
    if(busy.value&&currentWorkKind!=='region')return false;
    if(currentWorkKind==='region')cancel();regionSourceId.value=id;
    if(params.target===id)params.target='new';return true;
  }
  function swapRegionMasks(){
    const target=state.value.masks.find(mask=>mask.id===params.target),source=regionSource.value;
    if(!target||!source||source.id===target.id){fail('交换需要两个不同的已有 Mask。');return false;}
    if(busy.value&&currentWorkKind!=='region')return false;
    if(currentWorkKind==='region')cancel();regionSourceId.value=target.id;params.target=source.id;return true;
  }
  function closeRegionGrowing(){if(currentWorkKind==='region')cancel();tool.value='navigate';}
  function commit(name:string,next:ProjectState){next=validMeasurementSelection(next);history.push(name,state.value,next);state.value=next;historyTick.value++;revision.value++;dirty.value=true;status.value=name+' 已完成';error.value='';}
  async function runJob<T>(request:OperationRequest,name:string,update?:(result:T,state:ProjectState)=>ProjectState):Promise<T|undefined>{
    if(!grid.value||busy.value)return;
    if(!physicalUnitsKnown.value){fail('请先确认影像空间单位，再进行毫米尺度的几何操作。');return;}
    const token=++jobGeneration,rev=revision.value;busy.value=true;currentWorkKind=request.kind;progress.value=0;error.value='';
    try{const result=await operations.run<T>(request,f=>progress.value=f);if(token!==jobGeneration)return;if(rev!==revision.value)throw new Error('工程对象已变化，丢弃旧计算结果。');if(update)commit(name,update(result,state.value));else status.value=name+' 已完成';return result;}
    catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  function install(v:Volume,project?:ProjectState,cacheId?:string){
    const prepared=validMeasurementSelection(project||createProject(v));
    installing=true;contourState=null;measurementEditor.cancel();showCalculate3D.value=false;jobGeneration++;operations.initialize(volumeGrid(v));brushCancel();
    if(thresholdTimer)clearTimeout(thresholdTimer);thresholdTimer=null;
    volume.value=v;state.value=prepared;documentId=cacheId||objectId('workspace');
    history.clear();historyTick.value++;revision.value++;busy.value=false;progress.value=0;currentWorkKind='';
    const view=state.value.viewState;
    point.value=view?.point?[...view.point]:v.dims.map(d=>Math.floor(d/2)) as Vec3;
    activeAxis.value=view?.activeAxis??2;renderMode.value=view?.renderMode??'parts';
    selectedMeasurementId.value=view?.selectedMeasurementId||'';
    interactiveMpr.value=false;endPlaneModify();mprView.restore(view?.mpr);
    params.roiMin=[0,0,0];params.roiMax=v.dims.map(d=>d-1) as Vec3;params.startSlice=0;params.endSlice=v.dims[2]-1;syncThresholdControls();
    const meta=(v as DicomVolume).dicom;
    center.value=view?.window?.center??meta?.windowCenter??(v.min+v.max)/2;
    width.value=view?.window?.width??meta?.windowWidth??Math.max(1,v.max-v.min);
    tool.value=view?.tool||'navigate';tab.value=view?.tab||'segmentation';regionSourceId.value=tool.value==='region'?state.value.selectedMaskId:'';params.target='new';
    preview.value=null;selection.value=null;interpolationPreview.value=null;interpolationSource=null;selectionOwner=null;draft.value=null;draftPoints.value=[];draftPlane.value=null;livewire=null;surfacePartId='';
    dirty.value=false;error.value='';pendingReplacement.value=null;series.value=[];
    advanced.seeds.value=[];advanced.rows.value=[];status.value='影像已加载';installing=false;if(multipleEditing.value)startSelectionSession();scheduleCache();
  }
  function confirmSpatialUnit(){
    const v=volume.value;if(!v||physicalUnitsKnown.value||busy.value)return;
    if(state.value.parts.length||state.value.measurements.length||state.value.centerlines?.length||state.value.polylines?.length||state.value.resliceObjects?.length){fail('已有物理几何对象，无法直接重新解释空间单位。');return;}
    if(![1,2,3].includes(spatialUnitChoice.value)){fail('请选择有效的空间单位。');return;}
    const factor=spatialUnitChoice.value===1?1000:spatialUnitChoice.value===3?.001:1,header=v.header.slice();header[123]=(header[123]&~7)|spatialUnitChoice.value;
    const image:Volume={...v,header,spacing:[0,1,2].map(a=>Math.hypot(...v.affine.map(row=>row[a]))*factor) as Vec3,unit:'mm'};
    const project={...state.value,viewState:viewState()};validateProject(image,project);
    install(image,project);dirty.value=true;status.value='已定义空间单位，建立新的空间基准';
  }
  function offerReplacement(candidate:ReplacementCandidate){
    if(dirty.value&&volume.value){pendingReplacement.value=candidate;status.value='新工程已读取，请选择如何保留当前未保存的修改';return false;}
    install(candidate.volume,candidate.state,candidate.cacheId);if(candidate.generated)dirty.value=true;return true;
  }
  async function confirmReplacement(action:'cancel'|'discard'|'cache'){
    const candidate=pendingReplacement.value;if(!candidate||busy.value)return;
    if(action==='cancel'){pendingReplacement.value=null;status.value='已保留当前工程';return;}
    if(action==='cache'){
      const token=++jobGeneration;busy.value=true;currentWorkKind='replacementCache';error.value='';
      try{await flushLocalCache();}
      catch(e){if(token===jobGeneration&&pendingReplacement.value===candidate)fail(e);return;}
      finally{if(token===jobGeneration){busy.value=false;currentWorkKind='';}}
      if(token!==jobGeneration||pendingReplacement.value!==candidate)return;
    }
    install(candidate.volume,candidate.state,candidate.cacheId);if(candidate.generated)dirty.value=true;showLocalProjects.value=false;
  }
  function demo(kind?:'vessel'){
    if(busy.value)cancel();
    if(offerReplacement({volume:kind==='vessel'?makeVesselDemo():makeDemo()})){center.value=300;width.value=1400;}
  }
  function beginImport(){cancel();importController=new AbortController();series.value=[];seriesChoice.value=0;pendingReplacement.value=null;const token=++jobGeneration;busy.value=true;error.value='';progress.value=0;currentWorkKind='import';return token;}
  async function openFiles(files:FileList|File[]|null){
    if(!files?.length)return false;const token=beginImport();
    try{
      const list=Array.from(files),file=list[0];let candidate:ReplacementCandidate;
      if(/\.zip$/i.test(file.name)){const bytes=await file.arrayBuffer();if(token!==jobGeneration)return false;candidate=decodeProject(new Uint8Array(bytes));}
      else if(/\.nii(\.gz)?$/i.test(file.name)){const image=await readFile(file,{signal:importController?.signal,onProgress:value=>{if(token===jobGeneration){progress.value=value.fraction;status.value=value.stage;}}});if(token!==jobGeneration)return false;candidate={volume:image};}
      else {
        const slices=[];
        for(let i=0;i<list.length;i++){const bytes=await list[i].arrayBuffer();if(token!==jobGeneration)return false;slices.push(parseDicom(bytes,list[i].name));progress.value=(i+1)/list.length;}
        const groups=groupDicomSeries(slices);if(token!==jobGeneration)return false;
        if(groups.length!==1){series.value=groups;seriesChoice.value=0;status.value=`检测到 ${groups.length} 个系列，请选择一个。`;return false;}
        candidate={volume:convertSeriesToVolume(groups[0])};
      }
      if(token!==jobGeneration)return false;
      return offerReplacement(candidate);
    }catch(e){if(token===jobGeneration)fail(e);return false;}
    finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  function loadSeries(){if(busy.value)return;try{const source=series.value[seriesChoice.value];if(!source)throw new Error('请选择一个DICOM系列。');const v=convertSeriesToVolume(source);offerReplacement({volume:v});series.value=[];}catch(e){fail(e);}}
  async function restoreLocalProject(id:string){
    if(!repository)return;const token=beginImport();
    try{const snapshot=await repository.load(id);if(token!==jobGeneration)return;if(!snapshot)throw new Error('本地工程不存在。');validateProject(snapshot.volume,snapshot.state);offerReplacement({volume:snapshot.volume,state:snapshot.state,cacheId:snapshot.id});showLocalProjects.value=false;}
    catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }

  function selectMask(id:string){if(!state.value.masks.some(m=>m.id===id))return;if(busy.value)cancel();brushCancel();state.value={...state.value,selectedMaskId:id};preview.value=null;}
  function updateMask(id:string,patch:Partial<Pick<MaskObject,'name'|'color'|'visible'|'opacity'>>){if(busy.value)cancel();brushCancel();commit('修改Mask属性',{...state.value,masks:state.value.masks.map(m=>m.id===id?{...m,...patch}:m)});}
  function newMask(){if(!volume.value)return;if(busy.value)cancel();brushCancel();commit('新建Mask',addMask(state.value,volume.value.data.length));tool.value='threshold';tab.value='segmentation';}
  function duplicateMask(){if(!volume.value||!activeMask.value)return;if(busy.value)cancel();brushCancel();const original=activeMask.value;let next=addMask(state.value,volume.value.data.length,original.name+' 副本',original.data.slice());next={...next,masks:next.masks.map(m=>m.id===next.selectedMaskId?{...m,threshold:original.threshold?[...original.threshold]:null,opacity:original.opacity}:m)};commit('复制Mask',next);}
  function deleteMask(){if(!activeMask.value)return;if(busy.value)cancel();brushCancel();try{const masks=state.value.masks.filter(m=>m.id!==activeMask.value!.id);commit('删除Mask',{...state.value,masks,selectedMaskId:masks[0]?.id||''});}catch(reason){fail(reason);}}
  function clearMask(){if(!activeMask.value)return;if(busy.value)cancel();brushCancel();commit('清空Mask',replaceMask(state.value,activeMask.value.id,new Uint8Array(activeMask.value.data.length)));}

  function undo(redo=false){
    cancel();try{const next=redo?history.redo():history.undo();
      if(next){state.value=validMeasurementSelection(next);historyTick.value++;revision.value++;dirty.value=true;status.value=redo?'已重做':'已撤销';error.value='';return true;}return false;
    }catch(reason){fail(reason);return false;}
  }
  function brushCancel(){draftBounds.value=null;const hadDraft=!!draft.value;draft.value=null;strokeState=null;draftRevision.value++;if(hadDraft)status.value='已取消本次笔画';}
  let synchronizingBrushSize=false;
  function synchronizeBrushSize(nextWidth:number,nextHeight:number){
    if(synchronizingBrushSize)return;
    if(strokeState)brushCancel();
    synchronizingBrushSize=true;
    try{params.brushWidth=nextWidth;params.brushHeight=params.sameWidthHeight?nextWidth:nextHeight;params.diameter=nextWidth;}
    finally{synchronizingBrushSize=false;}
  }
  function setBrushSize(nextWidth:number,nextHeight:number):boolean{
    if(![nextWidth,nextHeight].every(value=>Number.isFinite(value)&&value>0)){brushCancel();fail('笔刷宽高/直径必须是有限正数。');return false;}
    if(params.brushWidth===nextWidth&&params.brushHeight===(params.sameWidthHeight?nextWidth:nextHeight)&&params.diameter===nextWidth)return true;
    synchronizeBrushSize(nextWidth,nextHeight);return true;
  }
  // Legacy diameter is the width alias. Synchronous guarded updates keep the equal-size mode atomic.
  watch(()=>params.diameter,value=>{if(!synchronizingBrushSize)synchronizeBrushSize(value,params.brushHeight);},{flush:'sync'});
  watch(()=>params.brushWidth,value=>{if(!synchronizingBrushSize)synchronizeBrushSize(value,params.brushHeight);},{flush:'sync'});
  watch(()=>params.brushHeight,value=>{if(!synchronizingBrushSize)synchronizeBrushSize(params.sameWidthHeight?value:params.brushWidth,value);},{flush:'sync'});
  watch(()=>params.sameWidthHeight,()=>{if(!synchronizingBrushSize)synchronizeBrushSize(params.brushWidth,params.brushHeight);},{flush:'sync'});
  watch(()=>params.brushShape,()=>{if(strokeState)brushCancel();},{flush:'sync'});
  function cancel(){
    importController?.abort();importController=null;
    measurementPreview.value=null;
    resliceProject.cancel();
    mprContour.cancel();
    mprBrush.cancel();
    mprView.cancelDefinition();
    reslices.cancelProperties();
    if(thresholdTimer)clearTimeout(thresholdTimer);thresholdTimer=null;
    jobGeneration++;operations.cancel();busy.value=false;progress.value=0;currentWorkKind='';
    brushCancel();measurementEditor.cancel();preview.value=null;interpolationPreview.value=null;interpolationSource=null;draftPoints.value=[];draftPlane.value=null;livewire=null;contourState=null;surfacePartId='';advanced.seeds.value=[];
    if(tool.value==='mpr-plane')tool.value='navigate';status.value='已取消未提交的操作';
  }

  function startSelectionSession(){
    selection.value=null;interpolationPreview.value=null;interpolationSource=null;
    selectionOwner=volume.value&&activeMask.value?{volume:volume.value,maskId:activeMask.value.id}:null;
    selectionAxis.value=activeAxis.value;
    if(volume.value){params.startSlice=0;params.endSlice=volume.value.dims[selectionAxis.value]-1;}
  }
  function validSelectionSession(){return !!(multipleEditing.value&&volume.value&&activeMask.value&&selectionOwner?.volume===volume.value&&selectionOwner.maskId===activeMask.value.id);}
  function setSelectionAxis(axis:Axis){
    if(![0,1,2].includes(axis)||!validSelectionSession())return;
    if(interpolationPreview.value){fail('请先应用或取消当前插值预览。');return;}
    if(selectionAxis.value===axis)return;
    cancel();selectionAxis.value=axis;activeAxis.value=axis;
    params.startSlice=0;params.endSlice=volume.value!.dims[axis]-1;status.value='已切换多片编辑和复制方向';
  }
  function clearSelection(){cancel();selection.value=null;interpolationPreview.value=null;interpolationSource=null;status.value='已清除临时选区，活动 Mask 保持不变';}
  function closeMultipleEdit(){clearSelection();tool.value='navigate';selectionOwner=null;status.value='已退出多片编辑';}
  function cancelInterpolation(){
    if(currentWorkKind==='interpolate')cancel();
    interpolationPreview.value=null;interpolationSource=null;status.value='已取消插值预览，保留原临时选区';
  }
  function applyInterpolation(){
    const result=interpolationPreview.value,source=interpolationSource;if(!result||busy.value)return;
    if(!source||!validSelectionSession()||source.selection!==selection.value||source.volume!==volume.value||source.maskId!==state.value.selectedMaskId||source.axis!==selectionAxis.value){cancelInterpolation();fail('插值预览已过期，请重新计算。');return;}
    interpolationPreview.value=null;interpolationSource=null;selection.value=result;status.value='插值已应用到临时 Mask，活动 Mask 尚未改变';
  }
  function copySelection(){return runMask('copySelection','复制选区',{plane:{axis:selectionAxis.value,index:point.value[selectionAxis.value]},direction:params.copyDirection,count:params.copyCount},undefined,false,true);}
  function interpolateSelection(){return runMask('interpolate','选区插值',{axis:selectionAxis.value,start:params.startSlice,end:params.endSlice},undefined,false,true);}
  function applyTemporarySelection(){const range=localThreshold.range.value;return runMask('selection','应用临时选区',{operation:params.selectionOperation,lower:range.lower,upper:range.upper});}

  async function runMask(kind:string,name:string,options:Record<string,unknown>={},seed?:Vec3,toPreview=false,temporary=false){
    if((temporary||kind==='selection')&&interpolationPreview.value){fail('请先应用或取消当前插值预览。');return;}
    const source=kind==='region'&&regionSourceId.value?regionSource.value:activeMask.value;
    if(!grid.value||busy.value)return;if(!source){fail(kind==='region'?'请选择有效的 Source Mask。':'请先选择 Mask。');return;}
    const original=state.value,rev=revision.value,id=source.id,token=++jobGeneration,targetSetting=params.target,leaveOriginal=params.leaveOriginal,thresholdStamp=thresholdConfig(),regionStamp=regionConfig();busy.value=true;currentWorkKind=kind;progress.value=0;error.value='';
    try {const input=temporary?selection.value:source.data;if(!input)throw new Error('请先绘制临时选区。');
      if(kind==='region'&&targetSetting!=='new'){
        if(targetSetting==='active'||targetSetting===id)throw new Error('普通区域生长的源和目标必须是不同 Mask。');
        if(!original.masks.some(mask=>mask.id===targetSetting))throw new Error('请选择有效的 Target Mask。');
      }
      const temporaryAxis=selectionAxis.value,sourceSlice=point.value[temporaryAxis];
      if(temporary||kind==='selection'){
        if(!validSelectionSession())throw new Error('请在当前 Mask 的多片编辑会话中操作临时选区。');
        if(temporary&&kind!=='copySelection'&&kind!=='interpolate')throw new Error('未知临时选区操作。');
        if(kind==='copySelection'){
          const plane=options.plane as SlicePlane|undefined;
          if(!plane||plane.axis!==temporaryAxis||plane.index!==sourceSlice||!Number.isSafeInteger(options.count)||Number(options.count)<0||![1,-1].includes(Number(options.direction)))throw new Error('复制方向、层数或当前切片无效。');
        }
        if(kind==='interpolate'&&options.axis!==temporaryAxis)throw new Error('插值方向必须与多片编辑方向一致。');
      }
      const other=kind==='selection'?selection.value:state.value.masks.find(m=>m.id===params.otherMask)?.data;
      if(kind==='selection'&&!other)throw new Error('请先绘制临时选区。');
      const result=await operations.run<MaskResult>({kind,mask:input,other:other||undefined,seed,options},f=>progress.value=f);
      if(token!==jobGeneration)return;if(rev!==revision.value)throw new Error('对象已变化，丢弃旧计算结果。');if(kind==='region'&&regionStamp!==regionConfig())throw new Error('区域生长参数已变化，丢弃旧计算结果。');if(toPreview&&kind==='threshold'&&(thresholdStamp!==thresholdConfig()||options.lower!==params.lower||options.upper!==params.upper||!!options.keepLargest!==params.thresholdKeepLargest||!!options.fillHoles!==params.thresholdFillHoles))throw new Error('阈值参数已变化，请重新计算预览。');
      if(temporary&&(selection.value!==input||!validSelectionSession()||selectionAxis.value!==temporaryAxis||kind==='copySelection'&&point.value[temporaryAxis]!==sourceSlice))throw new Error('临时选区或编辑位置已变化，丢弃旧计算结果。');
      if(kind==='label'&&(result as MaskResult&{labelVoxelCount?:number}).labelVoxelCount===0)throw new Error('文字没有落到有效体素上，请检查起点、字高和厚度。');if(temporary){
        if(kind==='interpolate'){interpolationSource={selection:input,volume:volume.value!,maskId:id,axis:temporaryAxis};interpolationPreview.value=result.mask;status.value='插值为临时预览，请应用或取消后继续编辑';}
        else {currentWorkKind='';selection.value=result.mask;if(Number(options.count)!==0){const next=[...point.value] as Vec3;next[temporaryAxis]=Math.max(0,Math.min(volume.value!.dims[temporaryAxis]-1,sourceSlice+Number(options.direction)*Number(options.count)));point.value=next;}status.value=name+' 临时选区已更新';}
      }
      else if(toPreview){preview.value=result.mask;previewTarget=id;previewRevision=rev;previewTitle=name;previewSignature=kind==='threshold'?thresholdStamp:'';previewRange=kind==='threshold'?[Number(options.lower),Number(options.upper)]:undefined;const detail=result as MaskResult&{converged?:boolean;residualNorm?:number};status.value=detail.converged===false?`计算未达到收敛，残差 ${detail.residualNorm?.toExponential(2)}；请检查预览或增加迭代次数`:'黄色为计算预览，点击应用后才修改Mask';}
      else if(kind==='region'){
        if(!result.mask.some(Boolean)){status.value='种子不属于 Source Mask，未改变工程';return;}
        let next=original,changed=false;
        if(!leaveOriginal){const remaining=source.data.slice();for(let i=0;i<remaining.length;i++)if(result.mask[i]&&remaining[i]){remaining[i]=0;changed=true;}if(changed)next=replaceMask(next,id,remaining);}
        if(targetSetting==='new'){
          next=addMask(next,grid.value.data.length,name,result.mask);const created=next.selectedMaskId;
          next={...next,selectedMaskId:original.selectedMaskId,masks:next.masks.map(mask=>mask.id===created?{...mask,threshold:source.threshold?[...source.threshold]:null,opacity:source.opacity}:mask)};changed=true;
        }else{
          const target=next.masks.find(mask=>mask.id===targetSetting)!;let targetChanged=false;const merged=target.data.slice();
          for(let i=0;i<merged.length;i++)if(result.mask[i]&&!merged[i]){merged[i]=1;targetChanged=true;}
          if(targetChanged){next=replaceMask(next,target.id,merged);changed=true;}
        }
        if(changed)commit(name,next);else status.value='目标已包含该连通区域，工程无变化';
      }
      else {
        const grow=['dynamic','cavity'].includes(kind),newTarget=grow&&targetSetting==='new'&&!options.append;
        const targetId=options.append||targetSetting==='active'?id:targetSetting;
        let next=original;
        if(newTarget)next=addMask(next,grid.value.data.length,name,result.mask);
        else if(grow){const target=next.masks.find(m=>m.id===targetId);if(!target)throw new Error('请选择有效的目标Mask。');const merged=target.data.slice();for(let i=0;i<merged.length;i++)if(result.mask[i])merged[i]=1;next=replaceMask(next,target.id,merged);}
        else next=replaceMask(next,id,result.mask);
        if(kind==='selection'&&!result.mask.some((value,i)=>value!==activeMask.value!.data[i]))status.value='临时选区未改变活动 Mask';
        else commit(name,next);
      }
    }catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  function thresholdPreview(){return runMask('threshold','阈值分割',{lower:params.lower,upper:params.upper,keepLargest:params.thresholdKeepLargest,fillHoles:params.thresholdFillHoles},undefined,true);}
  function applyPreview(){
    if(!preview.value)return;
    if(revision.value!==previewRevision||activeMask.value?.id!==previewTarget||previewSignature&&previewSignature!==thresholdConfig()){
      preview.value=null;fail('预览已过期，请重新计算。');return;
    }
    commit(previewTitle,replaceMask(state.value,previewTarget,preview.value,previewRange));preview.value=null;
  }
  function brushBegin(axis?:Axis,slice?:number){
    brushCancel();if(!volume.value||!activeMask.value||busy.value||!physicalUnitsKnown.value||!multipleEditing.value&&!activeMask.value.visible||!['paint','erase','select','deselect','multiple','local-threshold'].includes(imageTool.value))return;
    let size;try{size=normalizeBrushSize({width:params.brushWidth,height:params.sameWidthHeight?params.brushWidth:params.brushHeight,shape:params.brushShape as 'circle'|'square'});}catch(error){fail(error);return;}
    const selecting=multipleEditing.value;
    if(selecting&&(!validSelectionSession()||interpolationPreview.value||axis!==undefined&&axis!==selectionAxis.value))return;
    const range=tool.value==='local-threshold'?localThreshold.range.value:{lower:params.lower,upper:params.upper};
    strokeState={maskId:activeMask.value.id,tool:tool.value,volume:volume.value,revision:revision.value,axis,slice,diameter:params.diameter,width:size.width,height:size.height,shape:size.shape,lower:range.lower,upper:range.upper,selecting,changed:false,last:null,covered:null,coveredRows:null,coveredCount:0,scanVisits:0};
    draft.value=(selecting?selection.value:activeMask.value.data)?.slice()||new Uint8Array(volume.value.data.length);
  }
  function brushStroke(p:Vec3,axis:Axis,slice:number,startSegment=false){
    const stroke=strokeState;if(!stroke||!draft.value||!grid.value||!volume.value)return;
    if(stroke.volume!==volume.value||stroke.maskId!==state.value.selectedMaskId||stroke.tool!==tool.value||stroke.revision!==revision.value||busy.value){brushCancel();return;}
    if(stroke.axis===undefined){stroke.axis=axis;stroke.slice=slice;}
    if(stroke.axis!==axis||stroke.slice!==slice||stroke.selecting&&(axis!==selectionAxis.value||interpolationPreview.value||!validSelectionSession())||p.some(x=>!Number.isFinite(x))||!Number.isSafeInteger(slice)||slice<0||slice>=volume.value.dims[axis]){brushCancel();return;}
    const [a,b]=planeAxes(axis),nx=volume.value.dims[a],ny=volume.value.dims[b];
    if(stroke.coveredCount===nx*ny||!startSegment&&stroke.last&&stroke.last[a]===p[a]&&stroke.last[b]===p[b]){stroke.last=[...p];return;}
    try{
      const sweep=brushSweepFootprint(grid.value,axis,{width:stroke.width,height:stroke.height,shape:stroke.shape},startSegment?p:stroke.last??p,p),{minU,maxU,minV,maxV}=sweep;
      let visits=0;for(let v=minV;v<=maxV;v++)if(stroke.coveredRows?.[v]!==nx)visits+=Math.max(0,maxU-minU+1);
      if(stroke.scanVisits+visits>MAX_BRUSH_SCAN_VISITS)throw new Error(`本笔路径累计扫描超过 ${MAX_BRUSH_SCAN_VISITS} 个候选体素，已取消整笔；请分段绘制。`);
      if(!stroke.covered){stroke.covered=new Uint8Array(nx*ny);stroke.coveredRows=new Uint32Array(ny);}
      stroke.scanVisits+=visits;stroke.last=[...p];
      const min:Vec3=[0,0,0],max:Vec3=[0,0,0];min[axis]=max[axis]=slice;min[a]=minU;max[a]=maxU;min[b]=minV;max[b]=maxV;
      const previous=draftBounds.value;draftBounds.value=previous?{min:previous.min.map((v,k)=>Math.min(v,min[k]!)) as Vec3,max:previous.max.map((v,k)=>Math.max(v,max[k]!)) as Vec3}:{min,max};
      const covered=stroke.covered,rows=stroke.coveredRows!,strides=[1,volume.value.dims[0],volume.value.dims[0]*volume.value.dims[1]],erase=['erase','deselect'].includes(stroke.tool),threshold=stroke.tool==='local-threshold';
      for(let v=minV;v<=maxV;v++){
        if(rows[v]===nx)continue;
        const row=v*nx,base=slice*strides[axis]!+v*strides[b]!;
        for(let u=minU;u<=maxU;u++){
          const cell=row+u;if(covered[cell]||!sweep.contains(u,v))continue;
          covered[cell]=1;rows[v]++;stroke.coveredCount++;
          const i=base+u*strides[a]!,intensity=threshold?volume.value.data[i]:0,value=threshold?Number(intensity>=stroke.lower&&intensity<=stroke.upper):erase?0:1;
          if(draft.value[i]!==value){draft.value[i]=value;stroke.changed=true;}
        }
      }
    }catch(error){brushCancel();fail(error);return;}
    draftRevision.value++;
  }
  function brushEnd(){
    const stroke=strokeState,data=draft.value;
    if(!stroke||!data)return;
    if(stroke.volume!==volume.value||stroke.maskId!==state.value.selectedMaskId||stroke.tool!==tool.value||stroke.revision!==revision.value||busy.value){brushCancel();return;}
    draft.value=null;strokeState=null;draftRevision.value++;
    if(!stroke.changed)return;
    if(stroke.selecting){selection.value=data;status.value='临时选区已更新，尚未应用';}
    else {
      // This draft was cloned from a validated binary mask and brushStroke only
      // writes 0/1. Rechecking every voxel here stalls pen-up on large CTs.
      const found=state.value.masks.find(mask=>mask.id===stroke.maskId);
      if(!found)throw new Error('目标Mask已不存在。');
      if(!Number.isSafeInteger(found.revision)||found.revision<0||found.revision===Number.MAX_SAFE_INTEGER)throw new Error('Mask版本无效或已超过安全整数范围。');
      const next={...state.value,masks:state.value.masks.map(mask=>mask.id===stroke.maskId?{...mask,data,revision:mask.revision+1}:mask)};
      commit(stroke.tool==='erase'?'擦除':stroke.tool==='local-threshold'?'局部阈值':'绘制Mask',next);
    }
  }

  function appendMeasurementPoint(p:Vec3,plane:SlicePlane|null,partId:string|null,mprPlane:MprPlane|null=null){
    const kind=tool.value;if(!measurementMinimum[kind]||p.some(n=>!Number.isFinite(n)))return;
    const free=['distance','angle','diameter','ellipse'].includes(kind),first=draftPointPlanes.value[0],firstMpr=draftPointMprPlanes.value[0];
    const sameContext=first&&plane?first.axis===plane.axis&&first.index===plane.index:firstMpr&&mprPlane?sameMprPlane(firstMpr,mprPlane):false;
    if(measurementDraftKind!==kind||!free&&draftPoints.value.length&&!sameContext)clearMeasurementDraft();
    measurementDraftKind=kind;
    const last=draftPoints.value.at(-1);
    if(kind==='area'&&last&&Math.hypot(...p.map((n,a)=>n-last[a]))<1e-6)return;
    draftPointPartIds.value=[...draftPointPartIds.value,partId];draftPointPlanes.value=[...draftPointPlanes.value,plane?{...plane}:null];
    draftPointMprPlanes.value=[...draftPointMprPlanes.value,mprPlane?validateMprPlane(mprPlane):null];syncMeasurementDraftPlane();
    draftPoints.value=[...draftPoints.value,[...p]];
    if(kind!=='area'&&draftPoints.value.length>=measurementMinimum[kind]!){
      finishDrawing();
      if(draftPoints.value.length>=measurementMinimum[kind]!){
        draftPoints.value=draftPoints.value.slice(0,measurementMinimum[kind]!-1);draftPointPartIds.value=draftPointPartIds.value.slice(0,draftPoints.value.length);draftPointPlanes.value=draftPointPlanes.value.slice(0,draftPoints.value.length);
        draftPointMprPlanes.value=draftPointMprPlanes.value.slice(0,draftPoints.value.length);syncMeasurementDraftPlane();
      }
    }
  }
  function completeEllipseCreation(change:{position:Vec3;draftToken:number;volume?:Volume;revision?:number}){
    if(!validGesture(change)||tool.value!=='ellipse'||draftPoints.value.length!==2||change.draftToken!==measurementDraftToken.value)return false;
    try{
      const count=state.value.measurements.length;appendMeasurementPoint(worldToVoxel(change.position,grid.value!),null,null);return state.value.measurements.length===count+1;
    }catch(error){fail(error);return false;}
  }

  async function imagePick(p:Vec3,axis:Axis,slice:number,append=false){
    if(!grid.value||busy.value)return;if(multipleEditing.value&&(!validSelectionSession()||interpolationPreview.value||axis!==selectionAxis.value))return;if(!physicalUnitsKnown.value&&!['region','dynamic','cavity','navigate'].includes(tool.value)){fail('请先确认影像空间单位。');return;}activeAxis.value=axis;const plane={axis,index:slice},seed=p.map(Math.round) as Vec3,effectiveTool=imageTool.value;
    if(tool.value==='mpr-plane'&&mprView.defining.value){addMprDefinitionPoint(physicalPoint(p,grid.value));return;}
    if(tool.value==='centerline'){advanced.addSeed(seed);return;}
    if(tool.value==='surface-distance'){fail('曲面路径的约束点需要放在三维表面上。');return;}
    const domain={connectivity:params.connectivity,plane:params.multiple?undefined:plane};
    if(['region','dynamic','cavity'].includes(tool.value)){await runMask(tool.value,tool.value==='region'?'区域生长':tool.value==='dynamic'?'动态区域生长':'填充腔体',{...domain,append:append&&tool.value==='dynamic',lowerDeviation:params.lowerDeviation,upperDeviation:params.upperDeviation,updateMean:params.updateMean,fillCavities:params.fillCavities},seed);return;}
    const isContour=effectiveTool==='lasso'||effectiveTool==='livewire';
    if(!isContour&&!measurementMinimum[tool.value])return;
    if(!isContour){appendMeasurementPoint(p,plane,null);return;}
    if(isContour){
      if(!volume.value||!activeMask.value||!multipleEditing.value&&!activeMask.value.visible)return;
      if(!['add','remove','threshold'].includes(params.editOperation)){fail('未知轮廓编辑操作。');return;}
      if(!contourState||contourState.plane.axis!==axis||contourState.plane.index!==slice){
        draftPoints.value=[];draftPlane.value=null;livewire=null;
        const temporary=multipleEditing.value,range=localThreshold.range.value;
        contourState={maskId:activeMask.value.id,tool:effectiveTool,volume:volume.value,revision:revision.value,plane,operation:temporary?tool.value==='deselect'?'remove':'add':params.editOperation as ContourTransaction['operation'],lower:range.lower,upper:range.upper,temporary,selection:temporary?selection.value:null};
      }
    }
    if(!draftPlane.value||draftPlane.value.axis!==axis||draftPlane.value.index!==slice){draftPoints.value=[];draftPlane.value=plane;livewire=null;}
    if(effectiveTool==='livewire'){
      if(livewire)draftPoints.value=[...draftPoints.value,...liveWirePath(livewire,seed).slice(1)];else draftPoints.value=[seed];
      const token=++jobGeneration,rev=revision.value;busy.value=true;currentWorkKind='livewire';try{const tree=await operations.run<LiveWireTree>({kind:'livewire',seed,options:{plane,gradientWeight:params.livewireWeight,attraction:params.livewireAttraction}});if(token===jobGeneration&&rev===revision.value&&imageTool.value==='livewire'&&draftPlane.value?.axis===axis&&draftPlane.value.index===slice)livewire=tree;}catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;currentWorkKind='';}}return;
    }
    const last=draftPoints.value.at(-1);if(last&&Math.hypot(...p.map((v,i)=>v-last[i]))<1e-6)return;draftPoints.value=[...draftPoints.value,p];
  }
  function finishDrawing(){if(mprView.enabled.value&&['lasso','livewire'].includes(tool.value)){void mprContour.completeCurrent();return;}if(busy.value||!grid.value||!draftPoints.value.length)return;
    if(tool.value==='surface-distance'){void advanced.surfacePath(draftPoints.value.map(p=>physicalPoint(p,grid.value!)),surfacePartId).then(result=>{if(result){draftPoints.value=[];objectTab.value='measurements';}});return;}
    try{if(imageTool.value==='lasso'||imageTool.value==='livewire'){
        const plane=draftPlane.value;if(!plane)return;
        const context=contourState,mask=activeMask.value;
        if(!context||!mask||!context.temporary&&!mask.visible||context.volume!==volume.value||context.maskId!==mask.id||context.revision!==revision.value||context.tool!==imageTool.value||context.temporary!==multipleEditing.value||context.temporary&&(!validSelectionSession()||interpolationPreview.value||context.selection!==selection.value||context.plane.axis!==selectionAxis.value)||context.plane.axis!==plane.axis||context.plane.index!==plane.index){cancel();return;}
        let points=draftPoints.value;if(imageTool.value==='livewire'&&livewire)points=[...points,...liveWirePath(livewire,points[0]).slice(1)];
        const[a,b]=planeAxes(context.plane.axis),first=points[0],second=points.find(p=>Math.hypot(p[a]-first[a],p[b]-first[b])>1e-6);
        if(points.length<3||!second||!points.some(p=>Math.abs((second[a]-first[a])*(p[b]-first[b])-(second[b]-first[b])*(p[a]-first[a]))>1e-6)){status.value='轮廓需要至少三个不共线点';return;}
        const region=polygonRaster(grid.value,context.plane,points.map(p=>[p[a],p[b]]));
        const input=context.temporary?context.selection||new Uint8Array(grid.value.data.length):mask.data;
        const result=applySelection(grid.value,input,region.mask,{operation:context.operation,lower:context.lower,upper:context.upper});
        contourState=null;
        if(context.temporary){if(result.mask.some((value,i)=>value!==input[i]))selection.value=result.mask;status.value='轮廓已更新临时 Mask，活动 Mask 尚未改变';}
        else if(result.mask.some((value,i)=>value!==mask.data[i]))commit(context.operation==='remove'?'轮廓擦除':context.operation==='threshold'?'轮廓局部阈值':'轮廓绘制',replaceMask(state.value,context.maskId,result.mask));
        else status.value='轮廓范围内的 Mask 无变化';
      }
      else {
        const minimum=measurementMinimum[tool.value];if(!minimum||draftPoints.value.length<minimum)return;
        const sources=draftPointPartIds.value.length===draftPoints.value.length?[...draftPointPartIds.value]:draftPoints.value.map(()=>null),partId=uniformMeasurementPartId(sources),part=state.value.parts.find(item=>item.id===partId);
        const m:MeasurementObject={id:objectId('measurement'),name:(tool.value==='annotation'?(part?.name||volume.value!.name)+' 注释':tool.value)+' '+(state.value.measurements.length+1),kind:tool.value as MeasurementKind,points:draftPoints.value.map(p=>physicalPoint(p,grid.value!)),...(draftPlane.value?{plane:{...draftPlane.value}}:{}),...(draftMprPlane.value?{mprPlane:validateMprPlane(draftMprPlane.value)}:{}),...(partId?{partId}:{}),pointPartIds:sources,visible:true,color:'#ffdf7a',...(tool.value==='annotation'?{text:params.annotationText}:{})};
        validateMeasurementObject(m,volume.value!.dims);
        if(m.kind==='ellipse'||m.kind==='area'){const result=evaluateMeasurement(m.kind,m.points);if(!result.valid)throw new Error(result.reason||'测量几何无效。');}
        if(isDensityROI(m.kind)){if(m.mprPlane)mprDensityCorners(m.points,m.mprPlane);else{if(!m.plane)throw new Error('密度 ROI 必须在同一切片上。');densityCorners(draftPoints.value,m.plane);}}
        if(m.kind==='annotation')measurementEditor.openCreate(m);else{commit('添加测量/标注',{...state.value,measurements:[...state.value.measurements,m]});selectedMeasurementId.value=m.id;}
        objectTab.value='measurements';
      }
      clearMeasurementDraft();livewire=null;contourState=null;
    }catch(e){fail(e);}
  }
  function evaluateWorkbenchMeasurement(input:MeasurementObject):WorkbenchMeasurementResult{
    const temporary=measurementPreview.value?.id===input.id?measurementPreview.value:null;
    const m=displayedMeasurement(temporary?{...input,points:temporary.points,...(temporary.plane?{plane:temporary.plane}:{}),...(temporary.mprPlane?{mprPlane:temporary.mprPlane}:{}),...(temporary.densityPlane?{densityPlane:temporary.densityPlane}:{})}:input),invalid=(reason:string):WorkbenchMeasurementResult=>({kind:m.kind,valid:false,value:NaN,unit:'',details:{},reason});
    try{
      if(m.kind==='annotation')return invalid('文字标注没有数值结果。');
      if(isDensityROI(m.kind)){
        if(grid.value&&m.densityPlane){
          const frame=validateAffinePlane(m.densityPlane),p=affineDensityCorners(m.points,frame).map(world=>affinePlaneWorldToPixel(frame,world).pixel),min:[number,number]=[p[0]![0],p[0]![1]],max:[number,number]=[p[1]![0],p[1]![1]];
          const r=densityStatistics(grid.value,frame,m.kind==='density-rectangle'?{kind:'rect',min,max}:{kind:'ellipse',center:[(min[0]+max[0])/2,(min[1]+max[1])/2],radius:[(max[0]-min[0])/2,(max[1]-min[1])/2]},{unit:imageMeta.value?.intensityUnit||'GV',interpolation:mprView.interpolation.value});
          return{kind:m.kind,valid:r.count>0,value:r.mean,unit:r.unit,details:{...r},...(r.count?{}:{reason:'ROI 内没有有效灰度采样。'})};
        }
        if(grid.value&&m.mprPlane){
          const p=mprDensityCorners(m.points,m.mprPlane).map(world=>mprWorldToPixel(m.mprPlane!,world).pixel),min:[number,number]=[Math.min(p[0][0],p[1][0]),Math.min(p[0][1],p[1][1])],max:[number,number]=[Math.max(p[0][0],p[1][0]),Math.max(p[0][1],p[1][1])];
          const r=densityStatistics(grid.value,m.mprPlane,m.kind==='density-rectangle'?{kind:'rect',min,max}:{kind:'ellipse',center:[(min[0]+max[0])/2,(min[1]+max[1])/2],radius:[(max[0]-min[0])/2,(max[1]-min[1])/2]},{unit:imageMeta.value?.intensityUnit||'GV',interpolation:mprView.interpolation.value});
          return{kind:m.kind,valid:r.count>0,value:r.mean,unit:r.unit,details:{...r},...(r.count?{}:{reason:'ROI 内没有有效灰度采样。'})};
        }
        if(!grid.value||!m.plane||m.points.length!==2)return invalid('密度 ROI 缺少有效影像平面。');
        const [a,b]=planeAxes(m.plane.axis),points=m.points.map(p=>worldToVoxel(p,grid.value!)),min:[number,number]=[Math.min(points[0][a],points[1][a]),Math.min(points[0][b],points[1][b])],max:[number,number]=[Math.max(points[0][a],points[1][a]),Math.max(points[0][b],points[1][b])];
        const r=densityStatistics(grid.value,m.plane,m.kind==='density-rectangle'?{kind:'rect',min,max}:{kind:'ellipse',center:[(min[0]+max[0])/2,(min[1]+max[1])/2],radius:[(max[0]-min[0])/2,(max[1]-min[1])/2]},{unit:imageMeta.value?.intensityUnit||'GV'});
        return{kind:m.kind,valid:r.count>0,value:r.mean,unit:r.unit,details:{...r},...(r.count?{}:{reason:'ROI 内没有有效灰度采样。'})};
      }
      if(m.kind==='surface-distance'){
        let length=0;for(let i=1;i<m.points.length;i++)length+=Math.hypot(...m.points[i].map((v,a)=>v-m.points[i-1][a]));
        return{kind:m.kind,valid:Number.isFinite(length)&&m.points.length>1,value:length,unit:'mm',details:{pathMethod:m.pathMethod||'mesh-edge'}};
      }
      return evaluateMeasurement(m.kind as EvaluationKind,m.points);
    }catch(error){return invalid(error instanceof Error?error.message:'无效测量。');}
  }
  function measurementDetails(id:string):WorkbenchMeasurementResult{
    const m=state.value.measurements.find(item=>item.id===id);return m?{...evaluateWorkbenchMeasurement(m),...(measurementPreview.value?.id===id?{preview:true}:{})}:{kind:'',valid:false,value:NaN,unit:'',details:{},reason:'测量对象已不存在。'};
  }
  const selectedMeasurementDetails=computed(()=>selectedMeasurementId.value?measurementDetails(selectedMeasurementId.value):null);
  function measurementLabel(m:MeasurementObject){
    if(m.kind==='annotation')return m.text||m.name;const r=evaluateWorkbenchMeasurement(m);if(!r.valid)return r.reason||'无效测量';
    if(isDensityROI(m.kind))return `均值 ${r.value.toFixed(2)} · σ ${Number(r.details.std).toFixed(2)} ${r.unit}`;
    if(m.kind==='surface-distance')return `≈ ${r.value.toFixed(2)} mm · 网格路径`;
    return`${r.value.toFixed(2)} ${r.unit}`;
  }
  const measurementLabels=computed(()=>Object.fromEntries(state.value.measurements.map(m=>[m.id,measurementLabel(m)])));
  function validGesture(change:{volume?:Volume;revision?:number}){return!busy.value&&!!grid.value&&physicalUnitsKnown.value&&(change.volume===undefined||change.volume===volume.value)&&(change.revision===undefined||change.revision===revision.value);}
  function gesturePlaneCurrent(change:{volume?:Volume;revision?:number},plane?:SlicePlane){return!plane||change.volume===undefined&&change.revision===undefined||point.value[plane.axis]===plane.index;}
  function validMprGesture(change:MprGesture){
    if(!validGesture(change))return false;try{
      const plane=validateMprPlane(change.mprPlane),snapshotted=change.volume!==undefined||change.revision!==undefined||change.mprRevision!==undefined;
      return!snapshotted||mprView.enabled.value&&(change.mprRevision===undefined||change.mprRevision===mprView.poseRevision.value)&&mprView.planes.value.some(p=>sameMprPlane(p,plane));
    }catch{return false;}
  }
  function mprDensityCorners(points:Vec3[],plane:MprPlane):[Vec3,Vec3]{
    const p=points.map(world=>mprWorldToPixel(plane,world));if(p.length!==2||p.some(q=>Math.abs(q.distance)>1e-5))throw new Error('密度 ROI 的两个角点必须在同一 MPR 平面。');
    const min:[number,number]=[Math.min(p[0].pixel[0],p[1].pixel[0]),Math.min(p[0].pixel[1],p[1].pixel[1])],max:[number,number]=[Math.max(p[0].pixel[0],p[1].pixel[0]),Math.max(p[0].pixel[1],p[1].pixel[1])];
    if(max[0]-min[0]<1e-8||max[1]-min[1]<1e-8)throw new Error('密度 ROI 的宽度和高度必须大于零。');return[mprPixelToWorld(plane,min),mprPixelToWorld(plane,max)];
  }
  function affineDensityCorners(points:Vec3[],frame:AffinePlane):[Vec3,Vec3]{
    if(!Array.isArray(points)||points.length!==2)throw new Error('仿射密度 ROI 需要两个世界角点。');
    const p=points.map(world=>affinePlaneWorldToPixel(frame,world));if(p.some(value=>Math.abs(value.distance)>1e-5))throw new Error('密度 ROI 角点必须位于保存的仿射平面。');
    const min:[number,number]=[Math.min(p[0]!.pixel[0],p[1]!.pixel[0]),Math.min(p[0]!.pixel[1],p[1]!.pixel[1])],max:[number,number]=[Math.max(p[0]!.pixel[0],p[1]!.pixel[0]),Math.max(p[0]!.pixel[1],p[1]!.pixel[1])];
    if(max.some((value,k)=>value-min[k]!<=1e-8))throw new Error('密度 ROI 的参数宽高必须大于零。');
    return[affinePlanePixelToWorld(frame,min),affinePlanePixelToWorld(frame,max)];
  }
  function affineDensityChange(found:MeasurementObject,change:MeasurementGeometryChange){
    if(!isDensityROI(found.kind)||!found.densityPlane||!change.densityPlane)throw new Error('缺少仿射密度 ROI 平面。');
    const shown=displayedMeasurement(found),frame=validateAffinePlane(change.densityPlane);
    if(!shown.densityPlane||!sameAffinePlane(frame,shown.densityPlane))throw new Error('密度 ROI 的保存基底或当前切片已变化。');
    if(change.mprPlane){if(change.plane||!validMprGesture({...change,mprPlane:change.mprPlane})||!coplanarAffinePlanes(frame,change.mprPlane))throw new Error('密度 ROI 的 MPR 视图上下文无效。');}
    else if(change.plane){const plane=checkedPlane(change.plane);if(change.mprRevision!==undefined||!gesturePlaneCurrent(change,plane)||!coplanarAffinePlanes(frame,sourceSliceMprPlane(grid.value!,plane.axis,plane.index)))throw new Error('密度 ROI 的原始切片上下文无效。');}
    else if(change.mprRevision!==undefined)throw new Error('缺少密度 ROI 的 MPR 视图平面。');
    return{frame,points:affineDensityCorners(change.points,frame)};
  }
  function mprPick(change:MprGesture&{position:Vec3;append?:boolean}){
    if(!validMprGesture(change))return false;
    try{
      const plane=validateMprPlane(change.mprPlane);if(Math.abs(mprWorldToPixel(plane,change.position).distance)>1e-5)return false;
      if(tool.value==='mpr-plane'&&mprView.defining.value)return addMprDefinitionPoint(change.position);
      if(!measurementMinimum[tool.value])return false;appendMeasurementPoint(worldToVoxel(change.position,grid.value!),null,null,plane);return true;
    }catch(error){fail(error);return false;}
  }
  function createMprDensityROI(change:MprGesture&{kind:'density-rectangle'|'density-ellipse';points:[Vec3,Vec3]}){
    if(!validMprGesture(change)||!isDensityROI(change.kind))return false;
    try{
      const mprPlane=validateMprPlane(change.mprPlane),points=mprDensityCorners(change.points,mprPlane),m:MeasurementObject={id:objectId('measurement'),name:(change.kind==='density-rectangle'?'MPR 矩形密度':'MPR 椭圆密度')+' '+(state.value.measurements.length+1),kind:change.kind,points,mprPlane,pointPartIds:[null,null],visible:true,color:'#ffdf7a'};
      validateMeasurementObject(m,volume.value!.dims);clearMeasurementDraft();commit('添加 MPR 密度 ROI',{...state.value,measurements:[...state.value.measurements,m]});selectedMeasurementId.value=m.id;objectTab.value='measurements';return true;
    }catch(error){fail(error);return false;}
  }
  function beginMprPlane(){if(!mprView.beginDefinition())return false;interactiveMpr.value=false;tool.value='mpr-plane';return true;}
  function saveCurrentReslicePlane(transactionName='调整重切片平面',forceNew=false){
    const plane=mprView.plane.value;if(!plane)return false;syncingReslice=true;
    try{if(!forceNew&&reslices.selected.value&&sameMprPlane(reslices.selected.value.plane,plane))return true;return!forceNew&&reslices.selected.value?reslices.updatePlane(reslices.selected.value.id,plane,transactionName):reslices.fromPlane(plane);}finally{syncingReslice=false;}
  }
  function finishResliceViewChange(previous:ReturnType<typeof mprView.snapshot>,name:string,forceNew=false){
    if(saveCurrentReslicePlane(name,forceNew))return true;mprView.restore(previous);return false;
  }
  function addMprDefinitionPoint(position:Vec3){
    const previous=mprView.snapshot(),pending=mprView.defining.value,accepted=mprView.addDefinitionPoint(position);if(accepted&&pending&&!mprView.defining.value){if(!finishResliceViewChange(previous,'三点定义重切片平面',true))return false;objectTab.value='reslices';tool.value='navigate';}return accepted;
  }
  function openMprView(){const previous=mprView.snapshot();if(!mprView.open())return false;if(!reslices.selected.value&&!finishResliceViewChange(previous,'新建重切片平面'))return false;if(!measurementMinimum[tool.value]&&!['navigate','surface-distance'].includes(tool.value))tool.value='navigate';return true;}
  function applyMprOrientation(){const previous=mprView.snapshot();if(!mprView.applyOrientation())return false;return finishResliceViewChange(previous,'调整重切片方向与采样');}
  function presetMpr(kind:'axial'|'coronal'|'sagittal'){const previous=mprView.snapshot();if(!mprView.preset(kind))return false;return finishResliceViewChange(previous,'重切片方向预设');}
  function startInteractiveMpr(){
    if(!grid.value||!physicalUnitsKnown.value||busy.value)return false;
    try{const axial=sourceSliceMprPlane(grid.value,2,point.value[2]),plane=fitMprPlane(grid.value,{size:[...mprView.resolution.value],center:physicalPoint(point.value,grid.value),normal:mprPlaneNormal(axial),up:axial.v});
      if(!reslices.fromPlane(plane))return false;interactiveMpr.value=true;tool.value='navigate';objectTab.value='reslices';return true;
    }catch(error){fail(error);return false;}
  }
  function editResliceInteractive(id:string){endPlaneModify();if(!reslices.select(id))return false;interactiveMpr.value=true;tool.value='navigate';objectTab.value='reslices';return true;}
  function stopInteractiveMpr(){interactiveMpr.value=false;}
  function transformMpr(change:MprTransformChange){
    if(!change||change.volume!==volume.value||change.revision!==revision.value||!interactiveMpr.value||!reslices.selected.value||!validGesture(change)||change.mprRevision!==mprView.poseRevision.value)return false;
    try{
      const source=validateMprPlane(change.sourcePlane),base=reslices.selected.value.plane,next=validateMprPlane(change.plane);
      const validSource=mprView.enabled.value?mprView.planes.value.some(p=>sameMprPlane(p,source)):([0,1,2] as Axis[]).some(axis=>sameMprPlane(sourceSliceMprPlane(grid.value!,axis,point.value[axis]),source));if(!validSource)return false;
      const center=mprPlaneCenter(base),nextCenter=mprPlaneCenter(next),tolerance=1e-8+Number.EPSILON*64*Math.max(1,...center.map(Math.abs),...nextCenter.map(Math.abs));
      if(!Array.isArray(change.crosshair)||change.crosshair.length!==3||change.crosshair.some((n,a)=>!Number.isFinite(n)||Math.abs(n-nextCenter[a])>tolerance))throw new Error('蓝色定位与候选平面中心不一致。');
      const near=(a:number,b:number)=>Math.abs(a-b)<=1e-8+Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
      if(!next.size.every((n,a)=>n===base.size[a])||!near(Math.hypot(...base.u),Math.hypot(...next.u))||!near(Math.hypot(...base.v),Math.hypot(...next.v)))throw new Error('蓝色旋转和平移不能改变平面采样或物理宽高。');
      const n=mprPlaneNormal(source),dot=(a:Vec3,b:Vec3)=>a.reduce((sum,v,k)=>sum+v*b[k]!,0),delta=nextCenter.map((v,a)=>v-center[a]) as Vec3;
      if(sameMprOrientation(base,next)){if(Math.abs(dot(delta,n))>tolerance)throw new Error('蓝色中心只能在抓取的显示平面内平移。');}
      else{
        if(Math.hypot(...delta)>tolerance)throw new Error('蓝色轴旋转必须保持交互中心。');
        for(const [oldAxis,newAxis] of [[base.u,next.u],[base.v,next.v],[mprPlaneNormal(base),mprPlaneNormal(next)]] as [Vec3,Vec3][])if(!near(dot(oldAxis,n),dot(newAxis,n)))throw new Error('蓝色轴必须绕当前显示平面的法线旋转。');
      }
      return reslices.updatePlane(reslices.selected.value.id,next,'交互调整重切片平面');
    }catch(error){fail(error);return false;}
  }
  function endPlaneModify(){resliceMode.value='view';modifyingResliceId.value='';}
  function beginPlaneModify(mode:'rotate'|'resize',id=state.value.selectedResliceId||''){
    if(!['rotate','resize'].includes(mode)||!grid.value||!physicalUnitsKnown.value||busy.value)return false;
    const object=reslices.objects.value.find(item=>item.id===id);if(!object)return false;
    cancel();interactiveMpr.value=false;syncingReslice=true;
    try{if(!reslices.select(id))return false;syncModifiedResliceView(object.plane,true);modifyingResliceId.value=id;resliceMode.value=mode;tool.value='navigate';objectTab.value='reslices';return true;}finally{syncingReslice=false;}
  }
  function modifyReslicePlane(change:{id:string;plane:MprPlane;action:'move'|'rotate'|'resize';volume?:Volume;revision:number;resliceRevision:number}){
    if(!change||change.volume!==volume.value||change.revision!==revision.value||change.resliceRevision!==mprView.poseRevision.value||!validGesture(change)||tool.value!=='navigate'||resliceMode.value==='view'||change.id!==modifyingResliceId.value||change.id!==reslices.selected.value?.id)return false;
    try{
      const base=reslices.selected.value!.plane,next=validateMprPlane(change.plane),center=mprPlaneCenter(base),candidateCenter=mprPlaneCenter(next),tol=1e-8+Number.EPSILON*64*Math.max(1,...center.map(Math.abs),...candidateCenter.map(Math.abs));
      if(!next.size.every((value,i)=>value===base.size[i]))throw new Error('视口修改不能改变输出采样点数。');
      const sameLength=(a:Vec3,b:Vec3)=>Math.abs(Math.hypot(...a)-Math.hypot(...b))<=1e-8+Number.EPSILON*64*Math.max(1,Math.hypot(...a),Math.hypot(...b));
      const sameCenter=Math.hypot(...candidateCenter.map((value,i)=>value-center[i]))<=tol;
      const normal=mprPlaneNormal(base),nextNormal=mprPlaneNormal(next),coplanarDirection=Math.hypot(...normal.map((value,i)=>value-nextNormal[i]))<1e-10;
      if(change.action==='resize'){
        if(resliceMode.value!=='resize'||!sameCenter||!sameMprOrientation(base,next))throw new Error('调整边框须保持中心、方向和采样点数。');
      }else if(change.action==='rotate'){
        if(resliceMode.value!=='rotate'||!sameCenter||!coplanarDirection||!sameLength(base.u,next.u)||!sameLength(base.v,next.v))throw new Error('角点旋转须保持中心、法线与物理尺寸。');
      }else if(change.action==='move'){
        const normalDelta=candidateCenter.reduce((sum,value,i)=>sum+(value-center[i])*normal[i],0);
        if(!sameMprOrientation(base,next)||!sameLength(base.u,next.u)||!sameLength(base.v,next.v)||Math.abs(normalDelta)>tol)throw new Error('中心只能沿当前平面平移，不能改变方向或物理尺寸。');
      }else return false;
      syncingReslice=true;let changed=false;try{changed=reslices.updatePlane(change.id,next,'修改三维重切片平面');}finally{syncingReslice=false;}
      if(changed)syncModifiedResliceView(next,true);return changed;
    }catch(error){fail(error);return false;}
  }
  function scrollMprView(change:{distanceMm:number;plane:MprPlane;volume?:Volume;revision?:number;mprRevision?:number}){return validMprGesture({...change,mprPlane:change.plane})&&mprView.scroll(change);}
  function checkedPlane(plane:SlicePlane):SlicePlane{
    if(!volume.value||![0,1,2].includes(plane.axis)||!Number.isSafeInteger(plane.index)||plane.index<0||plane.index>=volume.value.dims[plane.axis])throw new Error('测量切片平面无效。');return{...plane};
  }
  function previewMeasurementGeometry(change:MeasurementGeometryChange|null){
    if(change===null){measurementPreview.value=null;return true;}
    if(!validGesture(change))return false;
    const found=state.value.measurements.find(m=>m.id===change.id);if(!found||isDensityROI(found.kind)||found.kind==='surface-distance'||found.kind==='annotation')return false;
    try{
      const mprPlane=change.mprPlane?validateMprPlane(change.mprPlane):found.mprPlane;
      if(mprPlane&&(!found.mprPlane||change.plane||(change.mprPlane!==undefined||change.mprRevision!==undefined)&&!validMprGesture({...change,mprPlane})))return false;
      const plane=change.plane?checkedPlane(change.plane):found.plane;
      if(!gesturePlaneCurrent(change,plane))return false;
      const points=change.points.map(p=>[...p] as Vec3),changedCount=points.length!==found.points.length;
      if(mprPlane&&points.some(p=>Math.abs(mprWorldToPixel(mprPlane,p).distance)>1e-5))return false;
      if(plane&&points.some(p=>Math.abs(worldToVoxel(p,grid.value!)[plane.axis]-plane.index)>1e-5))return false;
      if(changedCount&&(found.kind!=='area'||measurementPartIds(found).length>0))return false;
      validateMeasurementObject({...found,points,...(plane?{plane}:{}),...(mprPlane?{mprPlane}:{}),...(changedCount&&found.pointPartIds!==undefined?{pointPartIds:points.map(()=>null)}:{})},volume.value!.dims);
      measurementPreview.value={id:found.id,points,...(plane?{plane:{...plane}}:{}),...(mprPlane?{mprPlane}:{}),volume:volume.value!,revision:revision.value};selectedMeasurementId.value=found.id;return true;
    }catch{return false;}
  }
  function updateMeasurementLabel(change:MeasurementLabelChange){
    if(!validGesture(change))return false;const found=state.value.measurements.find(m=>m.id===change.id);if(!found||found.kind==='annotation'||!gesturePlaneCurrent(change,found.plane))return false;
    if(found.mprPlane&&change.mprPlane&&(!validMprGesture({...change,mprPlane:change.mprPlane})||!coplanarMprPlanes(displayedMeasurement(found).mprPlane!,change.mprPlane)))return false;
    try{
      validateMeasurementObject({...found,labelOffset:change.offset},volume.value!.dims);
      const next:MeasurementObject={...found,labelOffset:[...change.offset] as Vec3};
      if(found.labelOffset?.every((n,a)=>Math.abs(n-next.labelOffset![a])<1e-10))return false;
      commit('移动测量标签',{...state.value,measurements:state.value.measurements.map(m=>m.id===found.id?next:m)});selectedMeasurementId.value=found.id;return true;
    }catch(error){fail(error);return false;}
  }
  function densityCorners(points:Vec3[],plane:SlicePlane){
    if(!grid.value||points.length!==2||points.some(p=>p.length!==3||p.some(n=>!Number.isFinite(n))||Math.abs(p[plane.axis]-plane.index)>1e-5))throw new Error('密度 ROI 的两个角点必须在同一切片上。');
    const corners=normalizeDensityROI(points,plane);if(!densityROIHasArea(corners,plane))throw new Error('密度 ROI 的宽度和高度必须大于零。');return corners;
  }
  function createDensityROI(change:DensityROICreation){
    if(!validGesture(change)||!isDensityROI(change.kind))return false;
    try{
      const plane=checkedPlane(change.plane);if(!gesturePlaneCurrent(change,plane))return false;
      const points=densityCorners(change.points,plane),m:MeasurementObject={id:objectId('measurement'),name:(change.kind==='density-rectangle'?'矩形密度':'椭圆密度')+' '+(state.value.measurements.length+1),kind:change.kind,plane,points:points.map(p=>physicalPoint(p,grid.value!)),pointPartIds:[null,null],visible:true,color:'#ffdf7a'};
      validateMeasurementObject(m,volume.value!.dims);clearMeasurementDraft();commit('添加密度 ROI',{...state.value,measurements:[...state.value.measurements,m]});selectedMeasurementId.value=m.id;objectTab.value='measurements';return true;
    }catch(error){fail(error);return false;}
  }
  function updateMeasurementGeometry(change:MeasurementGeometryChange){
    if(!validGesture(change))return false;const found=state.value.measurements.find(m=>m.id===change.id);if(!found||found.kind==='surface-distance')return false;
    try{
      if(found.densityPlane){
        const {frame,points}=affineDensityChange(found,change),next:MeasurementObject={...found,points,densityPlane:frame};validateMeasurementObject(next,volume.value!.dims);
        if(sameAffinePlane(frame,found.densityPlane)&&points.every((p,i)=>p.every((value,k)=>Math.abs(value-found.points[i]![k]!)<1e-10)))return false;
        commit('调整仿射密度 ROI',{...state.value,measurements:state.value.measurements.map(m=>m.id===found.id?next:m)});selectedMeasurementId.value=found.id;return true;
      }
      if(change.densityPlane!==undefined)return false;
      let points=change.points.map(p=>[...p] as Vec3),plane=change.plane?checkedPlane(change.plane):found.plane?{...found.plane}:undefined;
      let mprPlane=change.mprPlane?validateMprPlane(change.mprPlane):found.mprPlane?validateMprPlane(found.mprPlane):undefined;
      if(mprPlane){
        if(!found.mprPlane||plane||(change.mprPlane!==undefined||change.mprRevision!==undefined)&&!validMprGesture({...change,mprPlane}))return false;
        if(isDensityROI(found.kind)){if(!sameMprOrientation(found.mprPlane,mprPlane))throw new Error('密度 ROI 不能改变 MPR 采样方向。');points=mprDensityCorners(points,mprPlane);}
        else if(points.some(p=>Math.abs(mprWorldToPixel(mprPlane!,p).distance)>1e-5))throw new Error('测量控制点必须位于指定 MPR 平面。');
      }else if(isDensityROI(found.kind)){
        plane=change.plane?checkedPlane(change.plane):displayedMeasurement(found).plane;
        if(!plane||plane.axis!==found.plane?.axis)throw new Error('密度 ROI 不能改变切片方向。');
        if(!gesturePlaneCurrent(change,plane))return false;
        points=densityCorners(points.map(p=>worldToVoxel(p,grid.value!)),plane).map(p=>physicalPoint(p,grid.value!));
      }else{if(!gesturePlaneCurrent(change,plane))return false;if(plane&&points.some(p=>Math.abs(worldToVoxel(p,grid.value!)[plane!.axis]-plane!.index)>1e-5))throw new Error('测量控制点必须位于指定切片。');}
      const changedCount=points.length!==found.points.length;
      if(changedCount&&(found.kind!=='area'||measurementPartIds(found).length>0))throw new Error('只有图像面积测量允许改变控制点数量。');
      const next:MeasurementObject={...found,points,...(plane?{plane}:{}),...(mprPlane?{mprPlane}:{}),...(changedCount&&found.pointPartIds!==undefined?{pointPartIds:points.map(()=>null)}:{})};
      validateMeasurementObject(next,volume.value!.dims);
      if(found.kind==='ellipse'||found.kind==='area'){const result=evaluateMeasurement(found.kind,points);if(!result.valid)throw new Error(result.reason||'测量几何无效。');}
      if(points.length===found.points.length&&points.every((p,i)=>p.every((n,a)=>Math.abs(n-found.points[i][a])<1e-10))&&plane?.axis===found.plane?.axis&&plane?.index===found.plane?.index&&(mprPlane?!!found.mprPlane&&sameMprPlane(mprPlane,found.mprPlane):!found.mprPlane))return false;
      commit('调整测量几何',{...state.value,measurements:state.value.measurements.map(m=>m.id===found.id?next:m)});selectedMeasurementId.value=found.id;return true;
    }catch(error){fail(error);return false;}
  }
  function moveMeasurementPoint(change:{id:string;index:number;position:Vec3;mprPlane?:MprPlane;mprRevision?:number;volume?:Volume;revision?:number}){
    if(!validGesture(change))return;const found=state.value.measurements.find(m=>m.id===change.id);if(!found||!Number.isSafeInteger(change.index)||change.position.length!==3||change.position.some(x=>!Number.isFinite(x)))return;
    if(found.kind==='surface-distance'&&found.partId){const controls=found.controlPoints||[found.points[0],found.points.at(-1)!];const i=found.controlPoints?change.index:change.index===0?0:controls.length-1;if(!controls[i])return;void advanced.surfacePath(controls.map((p,j)=>i===j?change.position:p),found.partId,found.id);return;}
    if(!found.points[change.index])return;const shown=isDensityROI(found.kind)?displayedMeasurement(found):found;
    const targetMpr=change.mprPlane||(isDensityROI(found.kind)?shown.mprPlane:undefined);
    updateMeasurementGeometry({id:found.id,points:shown.points.map((p,i)=>i===change.index?[...change.position] as Vec3:p),...(shown.plane?{plane:shown.plane}:{}),...(targetMpr?{mprPlane:targetMpr}:{}),...(shown.densityPlane?{densityPlane:validateAffinePlane(shown.densityPlane)}:{}),volume:change.volume,revision:change.revision,mprRevision:change.mprRevision});
  }
  function locateMeasurement(id:string){const m=state.value.measurements.find(m=>m.id===id);if(!m?.points[0]||!grid.value||!volume.value)return;selectedMeasurementId.value=id;point.value=worldToVoxel(m.points[0],grid.value).map((x,a)=>Math.max(0,Math.min(volume.value!.dims[a]-1,Math.round(x)))) as Vec3;if(m.densityPlane)mprView.locate(m.points[0],affinePlaneViewingPlane(m.densityPlane));else if(m.mprPlane)mprView.locate(m.points[0],m.mprPlane);}
  function deleteMeasurement(id:string){commit('删除测量',{...state.value,measurements:state.value.measurements.filter(m=>m.id!==id)});}
  function openCalculate3D(){
    if(busy.value)return;if(!volume.value||!state.value.masks.length){fail('请先创建一个Mask。');return;}
    if(!physicalUnitsKnown.value){fail('请先确认影像空间单位。');return;}
    brushCancel();error.value='';showCalculate3D.value=true;
  }
  function closeCalculate3D(){if(busy.value)cancel();showCalculate3D.value=false;}
  async function calculateParts(request:CalculationRequest){
    const ids=[...new Set(request.maskIds)],sources=ids.map(id=>state.value.masks.find(m=>m.id===id));
    if(!ids.length||sources.some(m=>!m)){fail('请选择有效的Mask。');return;}
    const settings:SurfaceOptions=request.quality==='optimal'?{quality:'optimal',step:[1,1,1],topology:'native-table'}:{quality:'custom',step:[...request.step],smooth:request.smooth,reduction:request.reduction,topology:request.topology};
    const result=await runJob<{maskId:string;mesh:TriangleMesh}[]>({kind:'calculate3dBatch',options:{items:sources.map(m=>({id:m!.id,name:m!.name,mask:m!.data})),settings}},'Calculate 3D',(items,current)=>{
      let next=current;for(const item of items){const source=sources.find(m=>m!.id===item.maskId)!;next=addPart(next,item.mesh,source);}return next;
    });
    if(result){objectTab.value='parts';renderMode.value='parts';}
  }
  async function runPart(kind:string){if(!grid.value||busy.value)return;if(!physicalUnitsKnown.value){fail('请先确认影像空间单位，再生成毫米尺度的三维表面。');return;}const source=activeMask.value,part=activePart.value,rev=revision.value,token=++jobGeneration,keepOriginals=params.keepOriginals;if(kind==='calculate3d'&&!source||kind!=='calculate3d'&&!part)return;busy.value=true;progress.value=0;error.value='';
    try{const options=kind==='calculate3d'?{quality:'custom',step:params.step,topology:params.topology}:kind==='smooth'?{iterations:params.smoothIterations,factor:params.smoothFactor,compensateShrinkage:params.compensate}:kind==='reduce'?{targetRatio:params.reduceRatio,tolerance:params.tolerance,featureAngle:params.featureAngle,preserveBoundary:true}:kind==='wrap'?{resolution:params.wrapResolution,closingDistance:params.closingDistance,protectThinWalls:params.protectThinWalls}:{};
      const result=await operations.run<TriangleMesh|MaskResult>({kind,mask:source?.data,mesh:part?.mesh,options},f=>progress.value=f);if(token!==jobGeneration)return;if(rev!==revision.value)throw new Error('对象已变化，丢弃旧重建结果。');
      if(kind==='partToMask'){commit('从3D计算Mask',addMask(state.value,grid.value.data.length,part!.name+' Mask',(result as MaskResult).mask,part!));objectTab.value='masks';}
      else {const mesh=result as TriangleMesh;if(!mesh.indices.length)throw new Error('没有生成三角形，请检查Mask和采样范围。');let next=addPart(state.value,mesh,kind==='calculate3d'?source:undefined);if(kind!=='calculate3d'){next={...next,parts:next.parts.map(p=>p.id===next.selectedPartId?{...p,name:part!.name+' '+kind,color:part!.color,sourceMaskId:part!.sourceMaskId,sourceRevision:part!.sourceRevision}:p)};if(!keepOriginals)next={...next,parts:next.parts.filter(p=>p.id!==part!.id)};}commit(kind==='calculate3d'?'计算3D':kind,next);objectTab.value='parts';}
    }catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}}
  function partPick(value:{partId:string;position:Vec3}){
    if(busy.value||!physicalUnitsKnown.value||!grid.value)return;
    const part=state.value.parts.find(item=>item.id===value.partId);
    if(!part||!part.visible||part.opacity<=0||value.position.length!==3||value.position.some(n=>!Number.isFinite(n)))return;
    state.value={...state.value,selectedPartId:value.partId};
    const v=worldToVoxel(value.position,grid.value);point.value=v.map((n,a)=>Math.max(0,Math.min(volume.value!.dims[a]-1,Math.round(n)))) as Vec3;
    if(tool.value==='mpr-plane'&&mprView.defining.value){addMprDefinitionPoint(value.position);return;}
    if(tool.value==='centerline'){advanced.addSeed(v);return;}
    if(tool.value==='surface-distance'){
      if(draftPoints.value.length&&surfacePartId!==value.partId){fail('曲面路径的约束点必须在同一表面上。');return;}
      surfacePartId=value.partId;draftPlane.value=null;draftPoints.value=[...draftPoints.value,v];status.value='继续放路径点，按Enter计算曲面路径';return;
    }
    if(['distance','angle','diameter','ellipse','annotation'].includes(tool.value))appendMeasurementPoint(v,null,value.partId);
  }
  function selectPart(id:string){if(busy.value)cancel();if(!state.value.parts.some(p=>p.id===id))return;state.value={...state.value,selectedPartId:id};}
  function updatePart(id:string,patch:{color?:string;opacity?:number;name?:string}){if(busy.value)return;commit('修改3D属性',{...state.value,parts:state.value.parts.map(p=>p.id===id?{...p,...patch}:p)});}
  function togglePart(id:string){commit('修改3D显隐',{...state.value,parts:state.value.parts.map(p=>p.id===id?{...p,visible:!p.visible}:p)});}
  function deletePart(){if(activePart.value){const parts=state.value.parts.filter(p=>p.id!==activePart.value!.id);commit('删除3D',{...state.value,parts,selectedPartId:parts[0]?.id||''});}}
  async function importStl(file?:File){
    if(!file||!volume.value)return;if(!physicalUnitsKnown.value){fail('请先确认影像空间单位。');return;}const frame=params.stlFrame;if(!['reference','application'].includes(frame)){fail('STL 交换坐标选项无效。');return;}const originalVolume=volume.value,rev=revision.value,token=beginImport();
    try{const bytes=await file.arrayBuffer();if(token!==jobGeneration||volume.value!==originalVolume)return;if(rev!==revision.value)throw new Error('工程已变化，请重新导入表面。');const mesh=meshFromReference(parseSTL(bytes),originalVolume.niftiReference,frame);commit('导入STL',addPart(state.value,mesh));objectTab.value='parts';}
    catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  function setStlFrame(frame:MeshCoordinateFrame){if(busy.value||!['reference','application'].includes(frame))return false;params.stlFrame=frame;return true;}
  async function saveResliceFile(request:SaveFileRequest):Promise<SaveFileResult|undefined>{
    if(!volume.value||busy.value)return;
    const original=volume.value,token=++jobGeneration;busy.value=true;currentWorkKind='reslice-project-file';progress.value=0;error.value='';
    try{
      const result=await saveFile({...request,produce:async()=>{
        if(token!==jobGeneration||volume.value!==original)throw new Error('重切片结果导出已取消。');
        const bytes=await request.produce();if(token!==jobGeneration||volume.value!==original)throw new Error('重切片结果导出已取消。');return bytes;
      }});
      if(token!==jobGeneration)return result;
      status.value=result.status==='written'?result.name+' 已写入文件':result.status==='download-started'?'已发起下载，请在浏览器下载列表中确认完成':'已取消文件保存，重切片结果仍保留';
      return result;
    }catch(reason){if(token===jobGeneration)fail(reason);return;}
    finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  async function exportFile(kind:'project'|'stl'|'mask',delivery?:SaveFileRequest['delivery']){
    if(!volume.value||busy.value)return;
    const originalVolume=volume.value,originalState=projectSnapshot(),sourcePart=activePart.value,sourceMask=activeMask.value;
    if(kind==='stl'&&!sourcePart||kind==='mask'&&!sourceMask)return;
    const meshFrame=params.stlFrame;if(kind==='stl'&&!['reference','application'].includes(meshFrame)){fail('STL 交换坐标选项无效。');return;}
    const token=++jobGeneration,rev=revision.value,doc=documentId;busy.value=true;currentWorkKind='export';error.value='';progress.value=0;
    const extension=kind==='project'?'.zip':kind==='stl'?'.stl':'.nii',name=kind==='project'?state.value.name+'.deepmark.zip':(kind==='stl'?sourcePart!.name:sourceMask!.name)+extension;
    const {data:_data,...volumeMetadata}=originalVolume;
    try{
      const result=await saveFile({name,extension,mime:kind==='project'?'application/zip':'application/octet-stream',description:kind==='project'?'Deepmark 工程':kind==='stl'?'STL 三角表面':'NIfTI 分割',...(delivery?{delivery}:{}),produce:async()=>{
        if(token!==jobGeneration||volume.value!==originalVolume)throw new Error('导出已取消。');
        const bytes=await operations.run<Uint8Array>({kind:kind==='project'?'exportProject':kind==='stl'?'exportSTL':'exportMask',mask:sourceMask?.data,mesh:sourcePart?.mesh,options:{volume:volumeMetadata,state:originalState,...(kind==='stl'?{meshFrame}:{})}},f=>progress.value=f);
        if(token!==jobGeneration)throw new Error('导出已取消。');return bytes;
      }});
      if(token!==jobGeneration)return result;
      if(result.status==='written'){if(kind==='project'&&doc===documentId&&rev===revision.value)dirty.value=false;status.value=result.name+' 已写入文件';}
      else if(result.status==='download-started')status.value='已发起下载，请在浏览器下载列表中确认文件完成';
      else status.value='已取消文件保存，工程仍保留';
      return result;
    }catch(e){if(token===jobGeneration)fail(e);return undefined;}
    finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }
  function exportPart(){return exportFile('stl');}
  function saveProject(){return exportFile('project');}
  function exportMask(){return exportFile('mask');}
  function downloadProject(){return exportFile('project','download');}
  function downloadPart(){return exportFile('stl','download');}
  function downloadMask(){return exportFile('mask','download');}
  async function importMask(file?:File){
    if(!file||!volume.value)return;
    const originalVolume=volume.value,rev=revision.value,token=beginImport();
    try{
      const imported=await readFile(file);if(token!==jobGeneration||volume.value!==originalVolume)return;
      if(rev!==revision.value)throw new Error('工程已变化，请重新导入分割。');
      if(!sameImageGeometry(imported,originalVolume))throw new Error('分割影像的网格与空间坐标不一致。');
      const masks=splitImportedLabels(imported.data);let next=state.value;
      for(const mask of masks)next=addMask(next,imported.data.length,masks.length===1?file.name:`${file.name} · 标签 ${mask.label}`,mask.data);
      commit('导入Mask',next);
    }catch(e){if(token===jobGeneration)fail(e);}finally{if(token===jobGeneration){busy.value=false;progress.value=0;currentWorkKind='';}}
  }

  const advanced=useAdvancedTools({volume,grid,state,activeMask,activePart,point,activeAxis,tool,objectTab,busy,status,commit,fail,runJob,runMask,locatePlane:plane=>{if(busy.value)return false;interactiveMpr.value=false;endPlaneModify();tool.value='navigate';return mprView.locate(mprPlaneCenter(plane),plane);}});
  watch(draftPoints,()=>{measurementDraftToken.value++;},{flush:'sync'});
  watch([revision,volume,tool,busy,()=>state.value.measurements,()=>point.value[0],()=>point.value[1],()=>point.value[2]],()=>{measurementPreview.value=null;},{flush:'sync'});
  watch(()=>draftPoints.value.length,length=>{if(!length){draftPointPartIds.value=[];draftPointPlanes.value=[];draftPointMprPlanes.value=[];draftMprPlane.value=null;measurementDraftKind='';}},{flush:'sync'});
  watch(()=>measurementEditor.draft.value,value=>{if(value){measurementPreview.value=null;clearMeasurementDraft();livewire=null;contourState=null;surfacePartId='';}},{flush:'sync'});
  watch(()=>state.value.parts.map(part=>part.id).join('\0'),()=>{
    if(installing)return;
    if(draftPointPartIds.value.some(id=>id!==null&&!state.value.parts.some(part=>part.id===id))||surfacePartId&&!state.value.parts.some(part=>part.id===surfacePartId)){
      clearMeasurementDraft();surfacePartId='';status.value='测量来源模型已删除，取消未完成的测量';
    }
  },{flush:'sync'});
  watch([()=>state.value.measurements,selectedMeasurementId],()=>{if(!installing)syncSelectedMeasurement();},{flush:'sync'});
  watch([()=>activeMask.value?.id,()=>activeMask.value?.threshold?.[0],()=>activeMask.value?.threshold?.[1]],()=>{if(!installing)syncThresholdControls();},{flush:'sync'});
  function key(event:KeyboardEvent){const t=event.target as HTMLElement;if(['INPUT','TEXTAREA','SELECT'].includes(t.tagName)||t.isContentEditable)return;if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();controller.undo(event.shiftKey||event.key.toLowerCase()==='y');}else if(event.key==='Escape'){cancel();endPlaneModify();}else if(event.key==='Enter')finishDrawing();else if(event.key.toLowerCase()==='b')tool.value='paint';else if(event.key.toLowerCase()==='e')tool.value='erase';else if(event.key.toLowerCase()==='v')tool.value='navigate';}
  function beforeUnload(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue='';}}
  watch(tool,(next,previous)=>{
    if(['paint','erase','local-threshold','lasso','livewire'].includes(next))interactiveMpr.value=false;
    if(next!=='navigate')endPlaneModify();
    if(next!=='mpr-plane')mprView.cancelDefinition();
    if(installing)return;if(previous==='centerline')advanced.seeds.value=[];if(busy.value)cancel();brushCancel();measurementEditor.cancel();preview.value=null;draftPoints.value=[];draftPlane.value=null;livewire=null;contourState=null;surfacePartId='';advanced.seeds.value=[];
    if(next==='region'&&previous!=='region'){regionSourceId.value=state.value.selectedMaskId||state.value.masks[0]?.id||'';params.target='new';}
    else if(previous==='region'&&next!=='region')regionSourceId.value='';
    if(isSelectionTool(next)&&!isSelectionTool(previous))startSelectionSession();
    else if(!isSelectionTool(next)&&isSelectionTool(previous)){selection.value=null;interpolationPreview.value=null;interpolationSource=null;selectionOwner=null;}
  },{flush:'sync'});
  watch([regionSourceId,()=>params.target,()=>params.connectivity,()=>params.multiple,()=>params.leaveOriginal],()=>{if(!installing&&currentWorkKind==='region')cancel();},{flush:'sync'});
  watch(()=>state.value.masks.map(mask=>mask.id).join('\0'),()=>{
    if(installing)return;
    if(regionSourceId.value&&!state.value.masks.some(mask=>mask.id===regionSourceId.value))regionSourceId.value=state.value.selectedMaskId||state.value.masks[0]?.id||'';
    if(params.target!=='new'&&params.target!=='active'&&!state.value.masks.some(mask=>mask.id===params.target))params.target='new';
    if(regionSourceId.value&&params.target===regionSourceId.value)params.target='new';
  },{flush:'sync'});
  watch([()=>state.value.selectedMaskId,()=>volume.value],()=>{if(!installing&&multipleEditing.value){cancel();startSelectionSession();}},{flush:'sync'});
  watch([()=>state.value.selectedMaskId,()=>activeMask.value?.visible,revision,()=>volume.value,activeAxis,()=>point.value[activeAxis.value],()=>params.editOperation,()=>localThreshold.range.value.lower,()=>localThreshold.range.value.upper],()=>{if(!installing&&contourState)cancel();},{flush:'sync'});
  watch([selectionAxis,()=>params.selectionType],()=>{if(!installing&&multipleEditing.value&&!interpolationPreview.value)cancel();},{flush:'sync'});
  watch(()=>selection.value,()=>{if(contourState?.temporary)cancel();},{flush:'sync'});
  watch([()=>params.copyCount,()=>params.copyDirection,()=>point.value[selectionAxis.value]],()=>{if(currentWorkKind==='copySelection')cancel();},{flush:'sync'});
  watch([()=>params.startSlice,()=>params.endSlice],()=>{if(currentWorkKind==='interpolate')cancel();},{flush:'sync'});
  watch([()=>params.selectionOperation,()=>localThreshold.range.value.lower,()=>localThreshold.range.value.upper],()=>{if(currentWorkKind==='selection'||strokeState?.tool==='local-threshold')cancel();},{flush:'sync'});
  watch([()=>volume.value,()=>point.value[0],()=>point.value[1],()=>point.value[2]],()=>{if(strokeState)brushCancel();},{flush:'sync'});
  watch([()=>params.livewireWeight,()=>params.livewireAttraction],()=>{if(imageTool.value==='livewire')cancel();},{flush:'sync'});
  watch([tool,()=>params.lower,()=>params.upper,()=>params.thresholdAutoPreview,()=>params.thresholdKeepLargest,()=>params.thresholdFillHoles,()=>state.value.selectedMaskId],()=>{if(installing)return;if(currentWorkKind==='threshold')cancel();preview.value=null;if(thresholdTimer)clearTimeout(thresholdTimer);if(tool.value==='threshold'&&params.thresholdAutoPreview&&Number.isFinite(params.lower)&&Number.isFinite(params.upper)&&params.lower<=params.upper)thresholdTimer=setTimeout(()=>{thresholdTimer=null;if(!busy.value)void thresholdPreview();},180);},{flush:'sync'});
  watch([revision,point,activeAxis,center,width,renderMode,tool,tab,selectedMeasurementId],scheduleCache,{deep:false});
  watch(mprView.poseRevision,()=>{if(installing)return;measurementPreview.value=null;if(draftPointMprPlanes.value.some(p=>p!==null))clearMeasurementDraft();if(!mprView.defining.value&&tool.value==='mpr-plane')tool.value='navigate';},{flush:'sync'});
  watch([()=>point.value[0],()=>point.value[1],()=>point.value[2]],()=>{if(!installing&&interactiveMpr.value)mprView.poseRevision.value++;},{flush:'sync'});
  watch([mprView.enabled,mprView.plane,mprView.step,mprView.interpolation,mprView.crosshair],scheduleCache);
  if(getCurrentInstance()){
    onMounted(()=>{void listLocalProjects();window.addEventListener('keydown',key);window.addEventListener('beforeunload',beforeUnload);});
    onBeforeUnmount(()=>{importController?.abort();if(cacheTimer)clearTimeout(cacheTimer);const finalSnapshot=cacheSnapshot();if(finalSnapshot)cacheQueue?.enqueue(finalSnapshot);if(thresholdTimer)clearTimeout(thresholdTimer);operations.dispose();window.removeEventListener('keydown',key);window.removeEventListener('beforeunload',beforeUnload);});
  }
  const mpr={...mprView,beginContour:mprContour.begin,contourPoint:mprContour.addPoint,previewContourPoint:mprContour.hover,completeContour:mprContour.complete,cancelContourGesture:mprContour.cancelGesture,cancelContour:mprContour.cancel,completeContourCurrent:mprContour.completeCurrent,contourDraft:mprContour.draft,contourPending:mprContour.pending,contourSettingsKey:mprContour.settingsKey,beginBrush:mprBrush.begin,brushStroke:mprBrush.append,endBrush:mprBrush.end,cancelBrush:mprBrush.cancel,cancelBrushGesture:mprBrush.cancelGesture,brushBounds:mprBrush.bounds,brushPreview:mprBrush.preview,brushPreviewRevision:mprBrush.previewRevision,resliceMode,resliceId:modifyingResliceId,beginPlaneModify,endPlaneModify,modifyPlane:modifyReslicePlane,interactive:interactiveMpr,interactivePlane,interactiveCenter,startInteractive:startInteractiveMpr,stopInteractive:stopInteractiveMpr,editInteractive:editResliceInteractive,transform:transformMpr,open:openMprView,applyOrientation:applyMprOrientation,preset:presetMpr,addDefinitionPoint:addMprDefinitionPoint,scroll:scrollMprView,displayMeasurements,draftPlane:draftMprPlane,draftPoints:computed(()=>draftMprPlane.value&&grid.value?draftPoints.value.map(p=>physicalPoint(p,grid.value!)):[]),beginDefinition:beginMprPlane,pick:mprPick,createDensityROI:createMprDensityROI,updateMeasurementGeometry,previewMeasurementGeometry,updateMeasurementLabel,moveMeasurementPoint};
  const controller={draftBounds,setStlFrame,resliceProject,reslices,mpr,measurementDraftToken,completeEllipseCreation,measurementPreview,previewMeasurementGeometry,updateMeasurementLabel,displayMeasurements,createDensityROI,updateMeasurementGeometry,measurementDetails,selectedMeasurementDetails,measurementEditor,regionSourceId,regionSource,setRegionSource,swapRegionMasks,closeRegionGrowing,localThreshold,multipleEditing,imageTool,displayMasks,selectionAxis,setSelectionAxis,interpolationPreview,copySelection,interpolateSelection,applyInterpolation,cancelInterpolation,clearSelection,closeMultipleEdit,applyTemporarySelection,showCalculate3D,openCalculate3D,closeCalculate3D,calculateParts,physicalUnitsKnown,spatialUnitChoice,confirmSpatialUnit,cacheAvailable:!!repository,renderMode,pendingReplacement,confirmReplacement,showLocalProjects,localProjects,cacheState,cacheError,openLocalProjects,listLocalProjects,restoreLocalProject,flushLocalCache,setBrushSize,brushCancel,advanced,selectedMeasurementId,locateMeasurement,moveMeasurementPoint,updatePart,volume,state,grid,point,activeAxis,tool,tab,objectTab,center,width,dirty,status,error,busy,progress,preview,selection,draft,draftRevision,draftPoints,draftPlane,params,series,seriesChoice,activeMask,activePart,maskInfo,partInfo,undoName,redoName,measurementLabels,revision,imageMeta,demo,openFiles,loadSeries,selectMask,updateMask,newMask,duplicateMask,deleteMask,clearMask,undo,cancel,runMask,thresholdPreview,applyPreview,brushBegin,brushStroke,brushEnd,imagePick,finishDrawing,deleteMeasurement,runPart,partPick,selectPart,togglePart,deletePart,importStl,exportPart,saveProject,exportMask,downloadProject,downloadPart,downloadMask,importMask};
  return controller;
}
