import {computed,ref,shallowRef} from 'vue';
import type {Ref,ShallowRef,ComputedRef} from 'vue';
import type {Volume} from '../core.ts';
import type {MprPlane,Vec3,VolumeGrid} from './types.ts';
import {physicalPoint} from './types.ts';
import {worldToVoxel,nearestVoxelCoordinate} from './measurements.ts';
import {validateMprPlane,fitMprPlane,mprPlaneCenter,mprPlaneNormal,orthogonalMprPlanes} from './mpr.ts';

export interface MprViewSnapshot {enabled:boolean;plane:MprPlane;step:number;interpolation:'linear'|'nearest';crosshair?:Vec3}
export interface MprViewContext {volume:ShallowRef<Volume|null>;grid:ComputedRef<VolumeGrid|null>;point:Ref<Vec3>;busy:Ref<boolean>;physicalUnitsKnown:ComputedRef<boolean>;cancel:()=>void;fail:(error:unknown)=>void;status:Ref<string>}
const dot=(a:Vec3,b:Vec3)=>a.reduce((sum,n,i)=>sum+n*b[i]!,0);
const unit=(v:Vec3)=>v.map(n=>n/Math.hypot(...v)) as Vec3;
export function sameMprPlane(a:MprPlane,b:MprPlane):boolean{
  return a.size.every((n,i)=>n===b.size[i])&&(['origin','u','v'] as const).every(key=>a[key].every((n,i)=>Math.abs(n-b[key][i]!)<=1e-8+Number.EPSILON*32*Math.max(Math.abs(n),Math.abs(b[key][i]!))));
}
export function sameMprOrientation(a:MprPlane,b:MprPlane):boolean{return(['u','v'] as const).every(key=>{const x=unit(a[key]),y=unit(b[key]);return Math.hypot(...x.map((n,i)=>n-y[i]!))<1e-12;});}
export function coplanarMprPlanes(a:MprPlane,b:MprPlane):boolean{
  const na=mprPlaneNormal(a),nb=mprPlaneNormal(b);return Math.min(Math.hypot(...na.map((n,i)=>n-nb[i]!)),Math.hypot(...na.map((n,i)=>n+nb[i]!)))<1e-12&&Math.abs(dot(a.origin.map((n,i)=>n-b.origin[i]!) as Vec3,na))<1e-5;
}
function planeAngles(plane:MprPlane):Vec3{
  const u=unit(plane.u),v=unit(plane.v),n=mprPlaneNormal(plane),ry=Math.asin(Math.max(-1,Math.min(1,-u[2]))),regular=Math.abs(Math.cos(ry))>1e-8;
  return[(regular?Math.atan2(v[2],n[2]):Math.atan2(-n[1],v[1]))*180/Math.PI,ry*180/Math.PI,(regular?Math.atan2(u[1],u[0]):0)*180/Math.PI].map(value=>Math.abs(value)<1e-12?0:value) as Vec3;
}
/** Non-destructive view state; the source grid and its crosshair remain independent. */
export function useMprView(c:MprViewContext){
  const enabled=ref(false),plane=shallowRef<MprPlane|null>(null),step=ref(1),interpolation=ref<'linear'|'nearest'>('linear'),crosshair=shallowRef<Vec3|null>(null),poseRevision=ref(0);
  const rotation=ref<Vec3>([0,0,0]),resolution=ref<[number,number]>([256,256]);
  const defining=ref(false),definitionPoints=ref<Vec3[]>([]);
  const planes=computed(()=>{if(!enabled.value||!plane.value||!c.grid.value)return[];try{return orthogonalMprPlanes(c.grid.value,plane.value);}catch(error){c.fail(error);return[];}});
  function ready(){if(!c.grid.value||!c.volume.value||!c.physicalUnitsKnown.value)throw new Error('请先加载并确认影像空间单位。');if(c.busy.value)throw new Error('正在处理其他操作，请稍后调整重切片平面。');return c.grid.value;}
  function publish(next:MprPlane,resetCrosshair=false){
    const validated=validateMprPlane(next);c.cancel();plane.value=validated;rotation.value=planeAngles(validated);enabled.value=true;resolution.value=[...validated.size];poseRevision.value++;if(resetCrosshair||!crosshair.value)crosshair.value=mprPlaneCenter(validated);c.status.value='在线 MPR 平面已更新，原影像与 Mask 保持不变';
  }
  function open(){try{const grid=ready();if(plane.value){publish(plane.value);return true;}rotation.value=[0,0,0];publish(fitMprPlane(grid,{size:resolution.value,center:physicalPoint(c.point.value,grid),angles:[0,0,0]}),true);step.value=Math.min(...grid.spacing);return true;}catch(error){c.fail(error);return false;}}
  function close(){c.cancel();enabled.value=false;poseRevision.value++;}
  function applyOrientation(){try{const grid=ready();publish(fitMprPlane(grid,{size:resolution.value,center:plane.value?mprPlaneCenter(plane.value):physicalPoint(c.point.value,grid),angles:[...rotation.value]}));return true;}catch(error){c.fail(error);return false;}}
  function preset(kind:'axial'|'coronal'|'sagittal'){
    rotation.value=kind==='axial'?[0,0,0]:kind==='coronal'?[90,0,0]:[90,0,90];return applyOrientation();
  }
  function setPlane(value:MprPlane){try{ready();publish(value);return true;}catch(error){c.fail(error);return false;}}
  function cancelDefinition(){defining.value=false;definitionPoints.value=[];}
  function beginDefinition(){try{ready();c.cancel();definitionPoints.value=[];defining.value=true;c.status.value='请在影像或三维对象上依次指定三个不共线的点';return true;}catch(error){c.fail(error);return false;}}
  function addDefinitionPoint(value:Vec3){
    if(!defining.value)return false;
    try{
      const grid=ready();if(value.length!==3||value.some(n=>!Number.isFinite(n)))throw new Error('定义平面的点必须是有限世界坐标。');
      if(definitionPoints.value.some(p=>Math.hypot(...p.map((n,a)=>n-value[a]))<1e-8))throw new Error('请选择不同的平面定义点。');
      const points=[...definitionPoints.value,[...value] as Vec3];if(points.length<3){definitionPoints.value=points;return true;}
      const u=points[1].map((n,a)=>n-points[0][a]) as Vec3,d=points[2].map((n,a)=>n-points[0][a]) as Vec3,normal:Vec3=[u[1]*d[2]-u[2]*d[1],u[2]*d[0]-u[0]*d[2],u[0]*d[1]-u[1]*d[0]];
      if(Math.hypot(...normal)<=1e-8*Math.hypot(...u)*Math.hypot(...d))throw new Error('三个点共线，不能定义重切片平面。');
      const un=unit(u),up=d.map((n,a)=>n-un[a]*dot(d,un)) as Vec3,center=points[0].map((_,a)=>(points[0][a]+points[1][a]+points[2][a])/3) as Vec3;
      const fitted=fitMprPlane(grid,{size:resolution.value,center,normal,up});publish(fitted,true);cancelDefinition();c.status.value='已用三个世界坐标点定义在线 MPR 平面';return true;
    }catch(error){c.fail(error);return false;}
  }
  function scroll(change:{distanceMm:number;plane:MprPlane}){
    try{ready();if(!plane.value||!Number.isFinite(change.distanceMm)||!planes.value.some(p=>sameMprPlane(p,change.plane)))return false;const n=mprPlaneNormal(change.plane);publish({...plane.value,origin:plane.value.origin.map((v,a)=>v+n[a]*change.distanceMm) as Vec3});return true;}catch(error){c.fail(error);return false;}
  }
  function locate(position:Vec3,context?:MprPlane){
    try{ready();if(position.length!==3||position.some(n=>!Number.isFinite(n)))throw new Error('MPR 定位坐标无效。');if(context)publish(context);else if(!enabled.value&&!open())return false;crosshair.value=[...position];return true;}catch(error){c.fail(error);return false;}
  }
  function syncToSource(){if(!crosshair.value||!c.grid.value||!c.volume.value)return false;const p=worldToVoxel(crosshair.value,c.grid.value);c.point.value=p.map((n,a)=>Math.max(0,Math.min(c.volume.value!.dims[a]-1,nearestVoxelCoordinate(n)))) as Vec3;c.status.value='已将 MPR 定位同步到原始三视图';return true;}
  function setInterpolation(value:'linear'|'nearest'){if(!['linear','nearest'].includes(value))return;interpolation.value=value;poseRevision.value++;}
  function setStep(value:number){if(!Number.isFinite(value)||value<=0){c.fail(new Error('MPR 层间距必须是有限正毫米数。'));return false;}step.value=value;poseRevision.value++;return true;}
  function snapshot():MprViewSnapshot|undefined{return plane.value?{enabled:enabled.value,plane:validateMprPlane(plane.value),step:step.value,interpolation:interpolation.value,...(crosshair.value?{crosshair:[...crosshair.value] as Vec3}:{})}:undefined;}
  function restore(value?:MprViewSnapshot){
    enabled.value=false;plane.value=null;crosshair.value=null;rotation.value=[0,0,0];resolution.value=[256,256];step.value=1;interpolation.value='linear';poseRevision.value++;cancelDefinition();
    if(!value)return;plane.value=validateMprPlane(value.plane);rotation.value=planeAngles(plane.value);enabled.value=value.enabled;step.value=value.step;interpolation.value=value.interpolation;crosshair.value=value.crosshair?[...value.crosshair]:mprPlaneCenter(value.plane);resolution.value=[...value.plane.size];
  }
  return{enabled,plane,planes,step,interpolation,crosshair,poseRevision,rotation,resolution,defining,definitionPoints,beginDefinition,cancelDefinition,addDefinitionPoint,setPlane,open,close,applyOrientation,preset,scroll,locate,syncToSource,setInterpolation,setStep,snapshot,restore};
}
