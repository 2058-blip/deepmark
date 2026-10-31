import type {Axis,Change,Volume} from './core.ts';
export function sliceLayout(volume:Pick<Volume,'dims'>,axis:Axis,slice:number){
  const [nx,ny]=volume.dims,strides=[1,nx,nx*ny],a=axis===0?1:0,b=axis===2?1:2;
  return {a,b,width:volume.dims[a],height:volume.dims[b],base:slice*strides[axis],stepX:strides[a],stepY:strides[b]};
}
export function extractSlice(volume:Pick<Volume,'dims'|'data'>,axis:Axis,slice:number,target?:Float32Array){
  const l=sliceLayout(volume,axis,slice),data=target?.length===l.width*l.height?target:new Float32Array(l.width*l.height);
  for(let y=0,j=0;y<l.height;y++){let i=l.base+(l.height-1-y)*l.stepY;for(let x=0;x<l.width;x++,i+=l.stepX)data[j++]=volume.data[i];}return data;
}
export function slicePixelsToVoxels(dims:Volume['dims'],axis:Axis,slice:number,pixels:Uint32Array){
  const l=sliceLayout({dims},axis,slice),result=new Uint32Array(pixels.length);
  for(let n=0;n<pixels.length;n++){const i=pixels[n];if(i>=l.width*l.height)throw new Error('分区像素超出切片范围。');result[n]=l.base+i%l.width*l.stepX+(l.height-1-Math.floor(i/l.width))*l.stepY;}return result;
}
export function fillSliceRegion(mask:Uint16Array,dims:Volume['dims'],axis:Axis,slice:number,pixels:Uint32Array,value:number,includeTouches=false):Change|null{
  if(!Number.isInteger(slice)||slice<0||slice>=dims[axis]||mask.length!==dims[0]*dims[1]*dims[2])throw new Error('分区不属于当前影像切片。');
  if(!Number.isInteger(value)||value<1||value>65535)throw new Error('请选择有效标签。');
  if(pixels.length*8>32*1024*1024)throw new Error('选中区域过大，请调整灰度区间后重试。');
  const voxels=slicePixelsToVoxels(dims,axis,slice,pixels);let count=0;for(const i of voxels)if(includeTouches||mask[i]!==value)count++;if(!count)return null;
  const change:Change={indices:new Uint32Array(count),before:new Uint16Array(count),after:new Uint16Array(count).fill(value)};
  for(let n=0,j=0;n<voxels.length;n++){const i=voxels[n];if(!includeTouches&&mask[i]===value)continue;change.indices[j]=i;change.before[j]=mask[i];j++;}
  for(const i of change.indices)mask[i]=value;return change;
}
