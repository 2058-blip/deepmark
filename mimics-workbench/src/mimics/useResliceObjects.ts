import {computed,shallowRef,watch} from 'vue';
import type {Ref,ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import {cloneResliceObject,objectId,validateResliceObject,volumeGrid} from './project.ts';
import type {ProjectState} from './project.ts';
import {createMprPlane,fitMprPlane,mprPlaneCenter,mprPlaneNormal,validateMprPlane} from './mpr.ts';
import type {MprPlane,ReslicePlaneObject,Vec3} from './types.ts';

export interface ResliceProperties {name:string;center:Vec3;angles:Vec3;widthMm:number;heightMm:number}
export type ReslicePropertiesPatch=Partial<ResliceProperties>;
export interface ReslicePropertiesDraft extends ResliceProperties {readonly id:string;readonly size:readonly[number,number]}
export interface ResliceObjectsContext {
  state:ShallowRef<ProjectState>;
  volume:ShallowRef<Volume|null>;
  busy:Ref<boolean>;
  commit:(name:string,next:ProjectState)=>void;
  fail:(error:unknown)=>void;
  onActivate:(object:ReslicePlaneObject|null)=>void;
}
const keys=['name','center','angles','widthMm','heightMm'] as const;
const vectorEqual=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((n,i)=>Math.abs(n-b[i]!)<=1e-8+Number.EPSILON*32*Math.max(Math.abs(n),Math.abs(b[i]!)));
function planeEqual(a:MprPlane,b:MprPlane){return a.size.every((n,i)=>n===b.size[i])&&(['origin','u','v'] as const).every(key=>vectorEqual(a[key],b[key]));}
function nameValue(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>512)throw new Error('重切片名称必须为1至512个字符。');return value.trim();}
function finiteTriple(value:unknown,label:string):Vec3{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==3||Reflect.ownKeys(value).length!==4)throw new Error(`${label}必须是普通三维数组。`);
  return Array.from({length:3},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable||typeof d.value!=='number'||!Number.isFinite(d.value))throw new Error(`${label}必须包含三个有限数。`);return d.value;}) as Vec3;
}
function propertyPatch(input:unknown):ReslicePropertiesPatch{
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('重切片属性必须是普通对象。');
  const result:ReslicePropertiesPatch={};
  for(const key of Reflect.ownKeys(input)){
    if(typeof key!=='string'||!keys.includes(key as typeof keys[number]))throw new Error(`不允许通过属性表修改字段：${String(key)}。`);
    const d=Object.getOwnPropertyDescriptor(input,key)!;if(!('value'in d)||!d.enumerable)throw new Error('重切片属性不能包含访问器或隐藏字段。');
    const field=key as typeof keys[number];
    if(field==='name')result.name=nameValue(d.value);
    else if(field==='center'||field==='angles')result[field]=finiteTriple(d.value,field==='center'?'世界中心':'世界旋转角');
    else{if(typeof d.value!=='number'||!Number.isFinite(d.value)||d.value<=0)throw new Error('重切片物理宽高必须是有限正毫米数。');result[field]=d.value;}
  }
  return result;
}
/** Euler display follows createMprPlane: extrinsic world X, then Y, then Z. */
export function resliceProperties(object:ReslicePlaneObject):ResliceProperties{
  const plane=validateMprPlane(object.plane),u=plane.u.map(n=>n/Math.hypot(...plane.u)) as Vec3,v=plane.v.map(n=>n/Math.hypot(...plane.v)) as Vec3,n=mprPlaneNormal(plane);
  const ry=Math.asin(Math.max(-1,Math.min(1,-u[2]))),cosY=Math.cos(ry),rx=Math.abs(cosY)>1e-8?Math.atan2(v[2],n[2]):Math.atan2(-n[1],v[1]),rz=Math.abs(cosY)>1e-8?Math.atan2(u[1],u[0]):0;
  const result={name:object.name,center:mprPlaneCenter(plane),angles:[rx*180/Math.PI,ry*180/Math.PI,rz*180/Math.PI] as Vec3,widthMm:plane.size[0]*Math.hypot(...plane.u),heightMm:plane.size[1]*Math.hypot(...plane.v)};
  if(![result.widthMm,result.heightMm,...result.center].every(Number.isFinite))throw new Error('重切片物理范围超出有限数值范围。');return result;
}
function fieldEqual(key:typeof keys[number],a:ResliceProperties,b:ResliceProperties){return key==='center'||key==='angles'?vectorEqual(a[key],b[key]):a[key]===b[key];}
function changedPlane(current:ReslicePlaneObject,next:ResliceProperties,changed:Set<string>):MprPlane{
  if(!['center','angles','widthMm','heightMm'].some(key=>changed.has(key)))return current.plane;
  const p=current.plane;
  if(changed.has('angles'))return createMprPlane({center:next.center,angles:next.angles,size:[...p.size],pixelSpacing:[next.widthMm/p.size[0],next.heightMm/p.size[1]]});
  const u=changed.has('widthMm')?p.u.map(n=>n/Math.hypot(...p.u)*next.widthMm/p.size[0]) as Vec3:[...p.u] as Vec3,v=changed.has('heightMm')?p.v.map(n=>n/Math.hypot(...p.v)*next.heightMm/p.size[1]) as Vec3:[...p.v] as Vec3;
  return validateMprPlane({origin:next.center.map((n,a)=>n-u[a]!*(p.size[0]-1)/2-v[a]!*(p.size[1]-1)/2),u,v,size:[...p.size]});
}

/** Named RP objects are document geometry. Selecting/activating one is view state; Properties commits only on Apply. */
export function useResliceObjects(c:ResliceObjectsContext){
  const objects=computed(()=>c.state.value.resliceObjects??[]),selected=computed(()=>objects.value.find(o=>o.id===c.state.value.selectedResliceId)),propertiesDraft=shallowRef<ReslicePropertiesDraft|null>(null);
  let baseline:ResliceProperties|null=null,sessionVolume:Volume|null=null,activationCount=0;
  function cancelProperties(){propertiesDraft.value=null;baseline=null;sessionVolume=null;}
  function ready(){if(c.busy.value)throw new Error('正在处理其他操作，请稍后编辑重切片。');const image=c.volume.value;if(!image||image.unit!=='mm')throw new Error('请先加载并确认影像空间单位。');return image;}
  function activate(object:ReslicePlaneObject|null){activationCount++;try{c.onActivate(object?cloneResliceObject(object):null);}catch(error){c.fail(error);}}
  function find(id=c.state.value.selectedResliceId??''){const object=objects.value.find(o=>o.id===id);if(!object)throw new Error('重切片对象已不存在。');validateResliceObject(object);return object;}
  function selectedId(){return c.state.value.selectedResliceId??'';}
  function replace(name:string,current:ReslicePlaneObject,next:ReslicePlaneObject){
    validateResliceObject(next);if(current.name===next.name&&planeEqual(current.plane,next.plane))return false;
    const copy=cloneResliceObject(next);c.commit(name,{...c.state.value,resliceObjects:objects.value.map(o=>o.id===current.id?copy:o)});return true;
  }
  function fromPlane(plane:MprPlane,name?:string):boolean{
    try{ready();const object:ReslicePlaneObject={id:objectId('reslice'),name:nameValue(name??`RP ${objects.value.length+1}`),kind:'plane',plane:validateMprPlane(plane)};validateResliceObject(object);
      c.commit('新建重切片平面',{...c.state.value,resliceObjects:[...objects.value,object],selectedResliceId:object.id});cancelProperties();return true;
    }catch(error){c.fail(error);return false;}
  }
  function newObject(name?:string):boolean{try{return fromPlane(fitMprPlane(volumeGrid(ready()),{size:[256,256]}),name);}catch(error){c.fail(error);return false;}}
  function select(id:string):boolean{
    try{ready();const object=id?find(id):null;cancelProperties();if(selectedId()!==id)c.state.value={...c.state.value,selectedResliceId:id};else activate(object);return true;}catch(error){c.fail(error);return false;}
  }
  function rename(id:string,name:string):boolean{try{ready();const current=find(id);return replace('重命名重切片',current,{...current,name:nameValue(name)});}catch(error){c.fail(error);return false;}}
  function duplicate(id=selectedId()):boolean{try{ready();const current=find(id),suffix=' 副本';return fromPlane(current.plane,current.name.slice(0,512-suffix.length)+suffix);}catch(error){c.fail(error);return false;}}
  function remove(id=selectedId()):boolean{
    try{ready();find(id);const active=selectedId()===id;c.commit('删除重切片',{...c.state.value,resliceObjects:objects.value.filter(o=>o.id!==id),...(active?{selectedResliceId:''}:{})});if(propertiesDraft.value?.id===id)cancelProperties();return true;}catch(error){c.fail(error);return false;}
  }
  function updatePlane(id:string,plane:MprPlane,name='调整重切片平面'):boolean{try{ready();const current=find(id);return replace(name,current,{...current,plane:validateMprPlane(plane)});}catch(error){c.fail(error);return false;}}
  function openProperties(id=selectedId()):boolean{
    try{ready();const object=find(id);if(!select(id))return false;baseline=resliceProperties(object);sessionVolume=c.volume.value;
      const draft:ReslicePropertiesDraft={...baseline,center:[...baseline.center],angles:[...baseline.angles],id:object.id,size:[...object.plane.size]};Object.freeze(draft.size);Object.defineProperty(draft,'id',{value:object.id,enumerable:true,writable:false,configurable:false});Object.defineProperty(draft,'size',{value:draft.size,enumerable:true,writable:false,configurable:false});propertiesDraft.value=draft;return true;
    }catch(error){c.fail(error);return false;}
  }
  function applyProperties(input?:ReslicePropertiesPatch):boolean{
    if(!propertiesDraft.value||!baseline)return false;
    try{
      ready();if(c.volume.value!==sessionVolume){cancelProperties();return false;}const current=find(propertiesDraft.value.id),draft=propertiesDraft.value;
      const patch=propertyPatch(input??{name:draft.name,center:draft.center,angles:draft.angles,widthMm:draft.widthMm,heightMm:draft.heightMm}),live=resliceProperties(current),next={...live},changed=new Set<string>();
      for(const key of keys)if(Object.hasOwn(patch,key)){const candidate={...baseline,[key]:patch[key]} as ResliceProperties;if(!fieldEqual(key,candidate,baseline)){Object.assign(next,{[key]:patch[key]});changed.add(key);}}
      const notified=activationCount,result=replace('修改重切片属性',current,{...current,name:next.name,plane:changedPlane(current,next,changed)});if(result&&notified===activationCount&&selectedId()===current.id)activate(find(current.id));cancelProperties();return result;
    }catch(error){c.fail(error);return false;}
  }
  watch([()=>c.busy.value,()=>c.volume.value,()=>objects.value.some(o=>o.id===propertiesDraft.value?.id),()=>c.state.value.selectedResliceId],()=>{if(propertiesDraft.value&&(c.busy.value||c.volume.value!==sessionVolume||!objects.value.some(o=>o.id===propertiesDraft.value!.id)||selectedId()!==propertiesDraft.value.id))cancelProperties();},{flush:'sync'});
  // History/ZIP installs and external selected-plane updates use this same path.
  // Geometry signatures avoid duplicate callbacks for identity-only state clones.
  watch([()=>c.volume.value,()=>c.state.value.selectedResliceId??'',()=>selected.value?JSON.stringify(selected.value.plane):''],()=>activate(selected.value??null),{flush:'sync'});
  return{objects,selected,propertiesDraft,fromPlane,newObject,select,rename,duplicate,remove,updatePlane,openProperties,applyProperties,cancelProperties};
}
