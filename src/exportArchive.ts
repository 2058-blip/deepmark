import {strToU8,zip} from 'fflate';
import type {Zippable} from 'fflate';
import type {Segment} from './view.ts';
import type {ParallelRegion} from './collaborationTypes.ts';

export type ExportMetadata={source?:string;projectId?:string;datasetId?:string;revision?:number;status?:string;local?:boolean;parallelRegions?:ParallelRegion[]};
// Stable timestamps let exports of an unchanged historical revision remain identical.
export const archiveOptions={level:6 as const,mtime:new Date(2000,0,1)};
export function annotationFiles(nifti:Uint8Array,labels:Omit<Segment,'visible'>[],metadata:ExportMetadata={}):Zippable{
  const {parallelRegions=[],...details}=metadata,parallelFile=parallelRegions.length?'parallel-annotations.json':null;
  const json=(value:unknown)=>strToU8(JSON.stringify(value,null,2));
  const files:Zippable={
    'segmentation.nii':nifti,
    'labels.json':json({version:1,segments:labels.map(({id,name,color,createdBy,createdAt})=>({id,name,color,...(createdBy&&typeof createdBy.id==='string'&&typeof createdBy.name==='string'?{createdBy:{id:createdBy.id,name:createdBy.name}}:{}),...(typeof createdAt==='string'?{createdAt}:{})}))}),
    'manifest.json':json({format:'deepmark-export-1',...details,segmentationFile:'segmentation.nii',labelsFile:'labels.json',parallelFile}),
    'README.txt':strToU8('Deepmark 标注导出包\n\nsegmentation.nii：NIfTI-1 分割标签，可解压后导入 3D Slicer。0 为背景，其他整数为标签编号。\nlabels.json：标签编号、名称和颜色。\nmanifest.json：导出来源与修订信息。\nparallel-annotations.json（如有）：冲突区域各作者的并列标注；单个 NIfTI 标签图无法表示这些并列意见，请保留此文件。\n\n本包不包含原始 CT 影像。\n'),
  };
  if(parallelFile)files[parallelFile]=json({format:'deepmark-parallel-1',projectId:metadata.projectId,revision:metadata.revision,primaryFile:'segmentation.nii',parallelRegions});
  return files;
}
export function annotationArchive(nifti:ArrayBuffer,labels:Omit<Segment,'visible'>[],metadata:ExportMetadata={}):Promise<ArrayBuffer>{
  return new Promise((resolve,reject)=>zip(annotationFiles(new Uint8Array(nifti),labels,metadata),archiveOptions,(error,result)=>{
    if(error)reject(error);else resolve(new Uint8Array(result).buffer);
  }));
}
