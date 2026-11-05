import {calculateLiveWire,type LiveWireTree} from './livewire.ts';
import {sampleMprSlice,validateMprPlane} from './mpr.ts';
import {physicalPoint,requireGrid,type AlgorithmControl,type MprPlane,type Vec3,type VolumeGrid} from './types.ts';

export const MAX_MPR_LIVEWIRE_PIXELS=1_048_576;
export interface MprLiveWireOptions extends AlgorithmControl {interpolation?:'linear'|'nearest';gradientWeight?:number;attraction?:number}
function vector(value:unknown):asserts value is Vec3 {if(!Array.isArray(value)||value.length!==3||![value[0],value[1],value[2]].every(Number.isFinite))throw new Error('MPR LiveWire坐标或尺寸必须是有限三维向量。');}
function sourceGrid(grid:VolumeGrid):void {
  vector(grid.dims);vector(grid.spacing);const count=requireGrid(grid);
  if(!(grid.data instanceof Float32Array)||!Number.isSafeInteger(count)||count<=0)throw new Error('MPR LiveWire源数据必须是有效Float32体积。');
  if(grid.affine!==undefined){
    if(!Array.isArray(grid.affine)||![3,4].includes(grid.affine.length)||Array.from(grid.affine).some(row=>!Array.isArray(row)||row.length!==4||![row[0],row[1],row[2],row[3]].every(Number.isFinite)))throw new Error('MPR LiveWire方向矩阵必须是有限3×4或4×4仿射矩阵。');
    if(grid.affine.length===4&&grid.affine[3]!.some((n,k)=>n!==(k===3?1:0)))throw new Error('MPR LiveWire不支持透视方向矩阵。');
  }
  for(const x of [-.5,grid.dims[0]-.5])for(const y of [-.5,grid.dims[1]-.5])for(const z of [-.5,grid.dims[2]-.5])vector(physicalPoint([x,y,z],grid));
}

/**
 * Resample raw gray/valid support, then build an ordinary local [x,y,0] LiveWire tree.
 * No silent downsampling, source writes or straight-line fallback for unreachable paths.
 * Native Gaussian preprocessing and arbitrary-RP writeback equivalence remain unconfirmed.
 */
export function calculateMprLiveWire(grid:VolumeGrid,input:MprPlane,seed:Vec3,options:MprLiveWireOptions={}):LiveWireTree {
  const plane=validateMprPlane(input),[width,height]=plane.size,pixels=width*height;
  if(pixels>MAX_MPR_LIVEWIRE_PIXELS)throw new Error(`MPR LiveWire输出超过${MAX_MPR_LIVEWIRE_PIXELS}像素预算，请显式缩小重采样尺寸。`);
  vector(seed);
  if(![seed[0],seed[1],seed[2]].every(Number.isSafeInteger)||seed[2]!==0||seed[0]<0||seed[0]>=width||seed[1]<0||seed[1]>=height)throw new Error('MPR LiveWire种子必须是输出平面内的整数[x,y,0]。');
  if(options.interpolation!==undefined&&options.interpolation!=='linear'&&options.interpolation!=='nearest')throw new Error('MPR LiveWire灰度插值方式无效。');
  if(options.cancelled!==undefined&&typeof options.cancelled!=='function'||options.progress!==undefined&&typeof options.progress!=='function')throw new Error('MPR LiveWire控制回调必须是函数。');
  const gradientWeight=options.gradientWeight===undefined?.6:options.gradientWeight,attraction=options.attraction===undefined?0:options.attraction;
  if(!Number.isFinite(gradientWeight)||gradientWeight<0||gradientWeight>1)throw new Error('MPR LiveWire梯度权重必须在[0,1]。');
  if(!Number.isFinite(attraction)||Math.abs(attraction)>50)throw new Error('MPR LiveWire吸引参数必须在[-50,50]。');
  const cancelled=()=>{if(options.cancelled?.()){const error=new Error('MPR LiveWire操作已取消。');error.name='AbortError';throw error;}return false;};
  const progress=(fraction:number)=>{cancelled();options.progress?.(fraction);cancelled();};
  progress(0);sourceGrid(grid);
  const sampled=sampleMprSlice(grid,plane,[],{interpolation:options.interpolation??'linear',maxPixels:MAX_MPR_LIVEWIRE_PIXELS,cancelled});
  const first=seed[0]+width*seed[1];
  if(!sampled.valid[first])throw new Error('MPR LiveWire种子必须位于有有限原始灰度支持的重采样区域。');
  progress(.25);
  const local:VolumeGrid={dims:[width,height,1],spacing:[Math.hypot(...plane.u),Math.hypot(...plane.v),1],data:sampled.gray};
  const tree=calculateLiveWire(local,{axis:2,index:0},seed,{gradientWeight,attraction,allowedMask:sampled.valid,cancelled,progress:fraction=>progress(.25+.75*fraction)});
  cancelled();return tree;
}
