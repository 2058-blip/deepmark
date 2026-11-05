import {resultTransfers} from './transferBuffers.ts';
import * as segmentation from './segmentation.ts';
import * as geometry from './geometry.ts';
import {calculateLiveWire} from './livewire.ts';
import {calculateMprLiveWire} from './mprLivewire.ts';
import {rasterizeMprContour} from './mprContour.ts';
import {resliceProject} from './resliceProjectGeometry.ts';
import {buildReslicedProject} from './resliceProjectData.ts';
import {physicalContoursToMask,updatePhysicalContourLayer} from './physicalContours.ts';
import {meshToReference} from './meshExchange.ts';
import {smartExpand} from './smartExpand.ts';
import * as contours from './contours.ts';
import * as meshTools from './meshTools.ts';
import * as centerline from './centerline.ts';
import type {VolumeGrid} from './types.ts';
import {encodeProject,validateProject} from './project.ts';
import {exportNifti} from '../core.ts';
const workerScope=self as unknown as {postMessage:(message:unknown,transfer?:Transferable[])=>void};
let grid:VolumeGrid|null=null;
self.onmessage=(event:MessageEvent)=>{
  const message=event.data;
  if(message.type==='init'){grid=message.grid;workerScope.postMessage({type:'ready'});return;}
  const id=message.id;
  try {
    if(!grid)throw new Error('请先加载影像。');
    const options={...message.options,progress:(fraction:number)=>workerScope.postMessage({type:'progress',id,fraction})};
    let result:unknown;
    switch(message.kind){
      case 'reslice-project':{
        const sourceVolume={...options.sourceVolume,data:grid.data};validateProject(sourceVolume,options.sourceState);
        const sampled=resliceProject(grid,{...options.settings,progress:options.progress},options.sourceState.masks.map((mask:any)=>({id:mask.id,data:mask.data})));
        const prepared=buildReslicedProject(sourceVolume,options.sourceState,sampled,{name:options.name,copyWorldObjects:options.copyWorldObjects,updateCoordinateSystem:options.updateCoordinateSystem});
        const {data:_data,masks:_masks,...sampling}=sampled;result={...prepared,sampling};break;
      }
      case 'reslice-project-export':result=encodeProject(options.volume,options.state);break;
      case 'exportProject':result=encodeProject({...options.volume,data:grid.data},options.state);break;
      case 'exportSTL':{const mesh=meshToReference(message.mesh,options.volume?.niftiReference,options.meshFrame??'reference'),output=geometry.exportSTL(mesh,{binary:true});result=typeof output==='string'?new TextEncoder().encode(output):output;break;}
      case 'exportMask':result=new Uint8Array(exportNifti({...options.volume,data:grid.data},Uint16Array.from(message.mask)));break;
      case 'calculate3dBatch':{
        if(!Array.isArray(options.items)||!options.items.length)throw new Error('请选择至少一个Mask。');
        const items=[];
        for(let i=0;i<options.items.length;i++){
          const item=options.items[i],mesh=geometry.calculateSurface(grid,item.mask,{...options.settings,progress:(fraction:number)=>workerScope.postMessage({type:'progress',id,fraction:(i+fraction)/options.items.length})});
          if(!mesh.indices.length)throw new Error(`Mask“${item.name}”没有可重建的成员。`);
          items.push({maskId:item.id,mesh});
        }
        result=items;break;
      }
      case 'threshold':{
        let selected=segmentation.threshold(grid,options.lower,options.upper,options);
        if(options.keepLargest)selected=segmentation.keepLargest(grid,selected.mask,options);
        if(options.fillHoles)selected=segmentation.fillHoles(grid,selected.mask,options);
        result=selected;break;
      }
      case 'region':result=segmentation.regionGrow(grid,message.mask,message.seed,options);break;
      case 'dynamic':{
        const grown=segmentation.dynamicRegionGrow(grid,message.seed,options);
        result=options.fillCavities?segmentation.fillHoles(grid,grown.mask,options):grown;
        break;
      }
      case 'boolean':result=segmentation.booleanMasks(message.mask,message.other,options.operation,options);break;
      case 'morphology':result=segmentation.morphology(grid,message.mask,options);break;
      case 'fill':result=segmentation.fillHoles(grid,message.mask,options);break;
      case 'cavity':result=segmentation.cavityFill(grid,message.mask,message.seed,options);break;
      case 'largest':result=segmentation.keepLargest(grid,message.mask,options);break;
      case 'smartExpand':result=smartExpand(grid,message.mask,options);break;
      case 'smoothMask':result=contours.independentSmoothMask(grid,message.mask,options);break;
      case 'polylines':result=contours.calculatePolylines(grid,message.mask,options);break;
      case 'updatePolylines':result=contours.updatePolylines(grid,message.mask,options.set,options.index,options);break;
      case 'polylinesToMask':result=contours.contoursToMask(grid,options.set,options);break;
      case 'physicalPolylinesToMask':result=physicalContoursToMask(grid,options.set,options);break;
      case 'updatePhysicalPolylines':result=updatePhysicalContourLayer(grid,message.mask,options.set,options.index,options);break;
      case 'label':result=contours.bitmapToMask(grid,options.bitmap,{...options,source:message.mask});break;
      case 'cut':result=meshTools.cutMeshByPlane(message.mesh,options.plane,options);break;
      case 'split':result=meshTools.splitConnectedComponents(message.mesh,options);break;
      case 'surfacePath':result=meshTools.surfacePath(message.mesh,options.points,options);break;
      case 'fixNormals':result=meshTools.fixMeshNormals(message.mesh,options);break;
      case 'stitch':result=meshTools.stitchMesh(message.mesh,options);break;
      case 'centerline':result=centerline.fitCenterline(grid,message.mask,options);break;
      case 'centerlineFromMesh':result=centerline.fitCenterlineFromMesh(grid,message.mesh,options);break;
      case 'smoothCenterline':result=centerline.smoothCenterline(options.graph,{...options,domain:{grid,mask:message.mask||geometry.maskFromMesh(grid,message.mesh,options)}});break;
      case 'filterCenterline':result=centerline.filterShortBranches(options.graph,options.thresholdMm,options);break;
      case 'splitCenterline':result=centerline.splitCenterline(options.graph,options.branchId,options.pointIndex);break;
      case 'growCenterline':result=centerline.growCenterlineBranch(options.graph,grid,message.mask||geometry.maskFromMesh(grid,message.mesh,options),options);break;
      case 'moveCenterline':result=centerline.moveCenterlineControlPoint(options.graph,options.branchId,options.pointIndex,options.position,{...options,domain:{grid,mask:message.mask||geometry.maskFromMesh(grid,message.mesh,options)}});break;
      case 'measureCenterline':result=centerline.measureCenterline(options.graph,message.mesh,options);break;
      case 'crop':result=segmentation.cropMask(grid,message.mask,options.roi,options);break;
      case 'interpolate':result=segmentation.interpolateMaskSlices(grid,message.mask,options.axis,options.start,options.end);break;
      case 'selection':result=segmentation.applySelection(grid,message.mask,message.other,options);break;
      case 'copySelection':result=segmentation.copySelectionSlices(grid,message.mask,options.plane,options.direction,options.count);break;
      case 'livewire':result=calculateLiveWire(grid,options.plane,message.seed,options);break;
      case 'mpr-contour-livewire':result=calculateMprLiveWire(grid,options.mprPlane,message.seed,options);break;
      case 'mpr-contour-raster':result=rasterizeMprContour(grid,options.mprPlane,options.points,options);break;
      case 'calculate3d':result=geometry.calculateSurface(grid,message.mask,options);break;
      case 'smooth':result=geometry.smoothMesh(message.mesh,options);break;
      case 'reduce':result=geometry.reduceMesh(message.mesh,options);break;
      case 'wrap':result=geometry.wrapMesh(message.mesh,options);break;
      case 'partToMask':result={mask:geometry.maskFromMesh(grid,message.mesh,options)};break;
      default:throw new Error('未知操作。');
    }
    workerScope.postMessage({type:'result',id,result},resultTransfers(result,new Set([grid.data.buffer])));
  }catch(error){workerScope.postMessage({type:'error',id,message:error instanceof Error?error.message:String(error)});}
};
