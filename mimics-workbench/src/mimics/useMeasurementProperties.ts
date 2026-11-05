import {ref,shallowRef,watch} from 'vue';
import type {Ref,ShallowRef} from 'vue';
import type {Volume} from '../core.ts';
import {objectId,validateMeasurementObject} from './project.ts';
import type {ProjectState} from './project.ts';
import type {MeasurementObject,Vec3} from './types.ts';
import {measurementPartIds} from './measurementAttachments.ts';
import {validateMprPlane} from './mpr.ts';
import {validateAffinePlane} from './affinePlane.ts';

export type MeasurementProperties=Partial<Pick<MeasurementObject,'name'|'text'|'color'|'visible'|'annotationStyle'>>;
export interface MeasurementPropertiesContext {
  state:ShallowRef<ProjectState>;
  selectedMeasurementId:Ref<string>;
  busy:Ref<boolean>;
  volume:ShallowRef<Volume|null>;
  commit:(name:string,next:ProjectState)=>void;
  fail:(error:unknown)=>void;
}
const propertyKeys=['name','text','color','visible','annotationStyle'] as const;
function cloneMeasurement(m:MeasurementObject):MeasurementObject{
  return{...m,points:m.points.map(point=>[...point] as Vec3),...(m.pointPartIds!==undefined?{pointPartIds:[...m.pointPartIds]}:{}),...(m.labelOffset!==undefined?{labelOffset:[...m.labelOffset] as Vec3}:{}),...(m.controlPoints?{controlPoints:m.controlPoints.map(point=>[...point] as Vec3)}:{}),...(m.plane?{plane:{...m.plane}}:{}),...(m.mprPlane!==undefined?{mprPlane:validateMprPlane(m.mprPlane)}:{}),...(m.densityPlane!==undefined?{densityPlane:validateAffinePlane(m.densityPlane)}:{}),...(m.annotationStyle?{annotationStyle:{...m.annotationStyle}}:{})};
}
function geometryReadOnly(m:MeasurementObject):MeasurementObject{
  for(const point of m.points)Object.freeze(point);Object.freeze(m.points);
  if(m.controlPoints){for(const point of m.controlPoints)Object.freeze(point);Object.freeze(m.controlPoints);}
  if(m.plane)Object.freeze(m.plane);
  if(m.pointPartIds)Object.freeze(m.pointPartIds);
  if(m.labelOffset)Object.freeze(m.labelOffset);
  if(m.mprPlane){Object.freeze(m.mprPlane.origin);Object.freeze(m.mprPlane.u);Object.freeze(m.mprPlane.v);Object.freeze(m.mprPlane.size);Object.freeze(m.mprPlane);}
  if(m.densityPlane){Object.freeze(m.densityPlane.origin);Object.freeze(m.densityPlane.u);Object.freeze(m.densityPlane.v);Object.freeze(m.densityPlane.size);Object.freeze(m.densityPlane);}
  for(const field of ['id','kind','points','pointPartIds','labelOffset','controlPoints','plane','mprPlane','densityPlane','partId','pathMethod'] as const)Object.defineProperty(m,field,{value:m[field],enumerable:true,writable:false,configurable:false});
  return m;
}
function sameProperties(a:MeasurementObject,b:MeasurementObject){
  if(a.name!==b.name||a.text!==b.text||a.color!==b.color||a.visible!==b.visible)return false;
  const x=a.annotationStyle,y=b.annotationStyle;
  return x===undefined&&y===undefined||!!x&&!!y&&x.arrow===y.arrow&&x.align===y.align&&x.rotation===y.rotation;
}
function propertyPatch(value:unknown):MeasurementProperties{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('测量属性必须是普通对象。');
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!propertyKeys.includes(key as typeof propertyKeys[number]))throw new Error(`不允许通过属性表修改字段：${String(key)}。`);
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!descriptor.enumerable||!('value' in descriptor))throw new Error('测量属性不能包含访问器或隐藏字段。');
  }
  return{...value};
}

/** A deferred properties transaction. Geometry is displayed read-only and never patched by a form. */
export function useMeasurementProperties(c:MeasurementPropertiesContext){
  const draft=shallowRef<MeasurementObject|null>(null),editingId=ref('');
  let sessionVolume:Volume|null=null,creation:MeasurementObject|null=null;
  function cancel(){draft.value=null;editingId.value='';sessionVolume=null;creation=null;}
  function ready(){
    if(c.busy.value)throw new Error('正在处理其他操作，请稍后编辑测量属性。');
    if(!c.volume.value)throw new Error('请先加载影像。');
    return c.volume.value;
  }
  function creationSourcesPresent(){const parts=c.state.value.parts;return!creation||measurementPartIds(creation).every(id=>parts.some(part=>part.id===id));}
  function validate(m:MeasurementObject,replacing=false){
    const image=ready(),state=c.state.value;
    validateMeasurementObject(m,image.dims);
    const foreign=[...state.masks,...state.parts,...(state.centerlines??[]),...(state.polylines??[]),...(state.resliceObjects??[])];
    if(foreign.some(o=>o.id===m.id)||state.measurements.filter(o=>o.id===m.id).length!==(replacing?1:0))throw new Error('测量对象 ID 重复或已不存在。');
    for(const id of measurementPartIds(m))if(!state.parts.some(p=>p.id===id)&&[...state.masks,...state.measurements,...(state.centerlines??[]),...(state.polylines??[]),...(state.resliceObjects??[])].some(o=>o.id===id))throw new Error('测量附件引用了其他类型对象。');
  }
  function openCreate(m:MeasurementObject):boolean{
    try{
      validate(m);if(measurementPartIds(m).some(id=>!c.state.value.parts.some(part=>part.id===id)))throw new Error('新建测量的锚定模型已不存在。');const copy=cloneMeasurement(m);
      sessionVolume=c.volume.value;creation=copy;editingId.value='';draft.value=geometryReadOnly(cloneMeasurement(copy));return true;
    }catch(error){c.fail(error);return false;}
  }
  function openEdit(id:string):boolean{
    try{
      ready();const current=c.state.value.measurements.find(m=>m.id===id);if(!current)throw new Error('测量对象已不存在。');validate(current,true);
      const copy=cloneMeasurement(current);sessionVolume=c.volume.value;creation=null;editingId.value=id;draft.value=geometryReadOnly(copy);c.selectedMeasurementId.value=id;return true;
    }catch(error){c.fail(error);return false;}
  }
  function apply(properties:MeasurementProperties):boolean{
    if(!draft.value)return false;
    try{
      ready();if(c.volume.value!==sessionVolume){cancel();return false;}
      if(!creationSourcesPresent()){cancel();return false;}
      const current=editingId.value?c.state.value.measurements.find(m=>m.id===editingId.value):creation;
      if(!current){cancel();return false;}
      const patch=propertyPatch(properties),next:MeasurementObject={...current,...patch};
      // Explicit undefined removes an optional property; it never creates a JSON-only placeholder.
      if(Object.hasOwn(patch,'text')&&patch.text===undefined)delete next.text;
      if(Object.hasOwn(patch,'annotationStyle')&&patch.annotationStyle===undefined)delete next.annotationStyle;
      validate(next,!!editingId.value);
      if(editingId.value&&sameProperties(current,next)){cancel();return false;}
      const isEdit=!!editingId.value,committed=cloneMeasurement(next),state=c.state.value;
      c.commit(isEdit?'修改测量属性':next.kind==='annotation'?'添加文字标注':'添加测量',{...state,measurements:isEdit?state.measurements.map(m=>m.id===editingId.value?committed:m):[...state.measurements,committed]});
      // Publish the object before selection: workbench synchronously clears dangling selections.
      c.selectedMeasurementId.value=committed.id;cancel();return true;
    }catch(error){c.fail(error);return false;}
  }
  function duplicate(id:string):boolean{
    try{
      ready();const current=c.state.value.measurements.find(m=>m.id===id);if(!current)throw new Error('测量对象已不存在。');validate(current,true);
      const copy=cloneMeasurement({...current,id:objectId('measurement'),name:current.name+' 副本'});validate(copy);
      c.commit('复制测量/标注',{...c.state.value,measurements:[...c.state.value.measurements,copy]});c.selectedMeasurementId.value=copy.id;cancel();return true;
    }catch(error){c.fail(error);return false;}
  }
  function toggle(id:string):boolean{
    try{
      ready();const current=c.state.value.measurements.find(m=>m.id===id);if(!current)throw new Error('测量对象已不存在。');validate(current,true);const changed={...current,visible:!current.visible};validate(changed,true);
      c.commit('修改测量显隐',{...c.state.value,measurements:c.state.value.measurements.map(m=>m.id===id?changed:m)});return true;
    }catch(error){c.fail(error);return false;}
  }
  watch([()=>c.busy.value,()=>c.volume.value,()=>editingId.value?c.state.value.measurements.some(m=>m.id===editingId.value):true,creationSourcesPresent],()=>{
    if(draft.value&&(c.busy.value||c.volume.value!==sessionVolume||editingId.value&&!c.state.value.measurements.some(m=>m.id===editingId.value)||!creationSourcesPresent()))cancel();
  },{flush:'sync'});
  return{draft,editingId,openCreate,openEdit,apply,cancel,duplicate,toggle};
}
