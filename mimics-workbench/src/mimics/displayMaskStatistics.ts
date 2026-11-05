import {shallowRef,ref,watch,onScopeDispose} from 'vue';
import type {Ref} from 'vue';
import {physicalPoint,requireGrid,voxelPoint} from './types.ts';
import type {VolumeGrid,BinaryMask,MaskObject,Vec3} from './types.ts';
import {maskStatistics} from './segmentation.ts';
import type {MaskStatistics} from './segmentation.ts';

/** Display-only statistics, with the same arithmetic order as maskStatistics.
 * Work is resumable; no annotation, history or algorithm input is modified. */
export class DisplayMaskStatisticsJob {
  private grid:VolumeGrid;private mask:BinaryMask;private cursor=0;
  private count=0;private finiteCount=0;private mean=0;private m2=0;private min=Infinity;private max=-Infinity;
  private low:Vec3;private high:Vec3=[-1,-1,-1];private sums:Vec3=[0,0,0];private voxelVolume:number;
  constructor(grid:VolumeGrid,mask:BinaryMask){
    requireGrid(grid,mask);this.grid=grid;this.mask=mask;this.low=[...grid.dims];this.voxelVolume=grid.spacing.reduce((a,b)=>a*b,1);
    if(grid.affine){const a=grid.affine;
      if(a.length<3||a.slice(0,3).some(row=>row.length<4||row.slice(0,4).some(v=>!Number.isFinite(v))))throw new Error('物理坐标变换无效。');
      this.voxelVolume=Math.abs(a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]));
    }
    if(!Number.isFinite(this.voxelVolume)||this.voxelVolume<=0)throw new Error('体素物理体积无效。');
  }
  step(length=65536):boolean{
    const end=Math.min(this.mask.length,this.cursor+length);
    for(let i=this.cursor;i<end;i++)if(this.mask[i]){
      this.count++;const p=voxelPoint(i,this.grid.dims);
      for(let a=0;a<3;a++){this.sums[a]+=p[a];this.low[a]=Math.min(this.low[a],p[a]);this.high[a]=Math.max(this.high[a],p[a]);}
      const value=this.grid.data[i];
      if(Number.isFinite(value)){this.finiteCount++;const delta=value-this.mean;this.mean+=delta/this.finiteCount;this.m2+=delta*(value-this.mean);this.min=Math.min(this.min,value);this.max=Math.max(this.max,value);}
    }
    this.cursor=end;return end===this.mask.length;
  }
  result():MaskStatistics{
    if(this.cursor!==this.mask.length)throw new Error('显示统计尚未完成。');
    const centroid=this.count?this.sums.map(n=>n/this.count) as Vec3:null;
    return{count:this.count,finiteCount:this.finiteCount,nonFiniteCount:this.count-this.finiteCount,
      voxelVolumeMm3:this.voxelVolume,volumeMm3:this.count*this.voxelVolume,min:this.finiteCount?this.min:null,max:this.finiteCount?this.max:null,
      mean:this.finiteCount?this.mean:null,standardDeviation:this.finiteCount?Math.sqrt(Math.max(0,this.m2/this.finiteCount)):null,
      bounds:this.count?{min:this.low,max:this.high}:null,centroid,centroidMm:centroid?physicalPoint(centroid,this.grid):null};
  }
}
export function useDisplayMaskStatistics(grid:Ref<VolumeGrid|null>,mask:Ref<MaskObject|undefined>,paused:Ref<boolean>){
  const value=shallowRef<MaskStatistics|null>(null),pending=ref(false);
  let generation=0,frame=0,lastId='',completed:BinaryMask|null=null;
  const stop=()=>{generation++;if(frame)cancelAnimationFrame(frame);frame=0;};
  watch([grid,()=>mask.value?.data,()=>mask.value?.id,paused],()=>{
    stop();const source=grid.value,selected=mask.value;
    if(!source||!selected){value.value=null;pending.value=false;completed=null;return;}
    if(selected.id!==lastId){lastId=selected.id;value.value=null;completed=null;}
    if(completed===selected.data&&value.value){pending.value=false;return;}
    pending.value=true;if(paused.value)return;
    const token=generation;
    if(selected.data.length<1024*1024){value.value=maskStatistics(source,selected.data);completed=selected.data;pending.value=false;return;}
    const job=new DisplayMaskStatisticsJob(source,selected.data);
    const step=()=>{
      frame=0;if(token!==generation)return;const start=performance.now();let done=false;
      do{done=job.step();}while(!done&&performance.now()-start<3);
      if(done){value.value=job.result();completed=selected.data;pending.value=false;}
      else frame=requestAnimationFrame(step);
    };
    frame=requestAnimationFrame(step);
  },{immediate:true});
  onScopeDispose(stop);return{value,pending};
}
