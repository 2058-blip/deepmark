import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computed,effectScope,shallowRef} from 'vue';
import {parseNifti} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import {makeMask} from '../src/mimics/project.ts';
import {useLocalThreshold} from '../src/mimics/useLocalThreshold.ts';
import type {LocalThresholdSlot} from '../src/mimics/useLocalThreshold.ts';
import type {MaskObject} from '../src/mimics/types.ts';

function image(max=1000):Volume{
  const buffer=new ArrayBuffer(360),h=new DataView(buffer),bytes=new Uint8Array(buffer);
  h.setInt32(0,348,true);h.setInt16(40,3,true);[2,1,1].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,1,true);});
  h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);
  bytes.set([110,43,49,0],344);h.setFloat32(352,max-100,true);h.setFloat32(356,max,true);return parseNifti(buffer,'synthetic.nii');
}
function setup(threshold:[number,number]|null=[100,500]){
  const scope=effectScope(),volume=shallowRef<Volume|null>(image()),mask=shallowRef<MaskObject|undefined>({...makeMask(2),threshold});
  const activeMask=computed(()=>mask.value),local=scope.run(()=>useLocalThreshold(activeMask,volume))!;
  return{scope,volume,mask,local};
}
const bounds=(lower:number,upper:number)=>({lower,upper});

test('three ranges start from the mask default and the middle choice cannot change source metadata',()=>{
  const {scope,mask,local}=setup(),before=structuredClone(mask.value);
  try{
    assert.equal(local.slot.value,1);assert.deepEqual(local.range.value,bounds(100,500));
    assert.deepEqual(local.ranges.value,[{lower:100,upper:500,editable:true},{lower:100,upper:500,editable:false},{lower:100,upper:500,editable:true}]);
    assert.equal(local.update(1,'lower',0),false);assert.equal(local.update(1,'upper',600),false);
    assert.throws(()=>{(local.ranges.value[1] as any).lower=0;},TypeError);
    assert.deepEqual(local.range.value,bounds(100,500));assert.deepEqual(mask.value,before);
  }finally{scope.stop();}
});

test('editing either custom range only becomes effective after that range is chosen',()=>{
  const {scope,mask,local}=setup(),sourceThreshold=mask.value!.threshold,sourceData=mask.value!.data;
  try{
    assert.equal(local.update(0,'lower',50),true);assert.equal(local.update(0,'upper',250),true);
    assert.deepEqual(local.range.value,bounds(100,500));assert.equal(local.slot.value,1);
    assert.equal(local.choose(0),true);assert.deepEqual(local.range.value,bounds(50,250));
    assert.equal(local.update(2,'upper',600),true);assert.equal(local.update(2,'lower',300),true);
    assert.deepEqual(local.range.value,bounds(50,250));assert.equal(local.choose(2),true);assert.deepEqual(local.range.value,bounds(300,600));
    local.choose(1);assert.deepEqual(local.range.value,bounds(100,500));
    assert.equal(mask.value!.threshold,sourceThreshold);assert.deepEqual(sourceThreshold,[100,500]);assert.equal(mask.value!.data,sourceData);assert.deepEqual([...sourceData],[0,0]);
  }finally{scope.stop();}
});

test('invalid local bounds and choices reject atomically and equality or fractional bounds remain valid',()=>{
  const {scope,local}=setup();
  try{
    local.choose(0);const before=structuredClone(local.ranges.value);
    for(const value of [NaN,Infinity,-Infinity])for(const bound of ['lower','upper'] as const)assert.equal(local.update(0,bound,value),false);
    assert.equal(local.update(0,'lower',501),false);assert.equal(local.update(0,'upper',99),false);
    assert.equal(local.update(-1 as LocalThresholdSlot,'lower',0),false);assert.equal(local.update(3 as LocalThresholdSlot,'lower',0),false);
    assert.equal(local.update(0,'invented' as any,0),false);assert.equal(local.choose(3 as LocalThresholdSlot),false);
    assert.equal(local.slot.value,0);assert.deepEqual(local.ranges.value,before);
    assert.equal(local.update(0,'upper',100),true);assert.deepEqual(local.range.value,bounds(100,100));
    assert.equal(local.update(0,'lower',99.5),true);assert.deepEqual(local.range.value,bounds(99.5,100));
  }finally{scope.stop();}
});

test('mask or stored threshold changes reset custom drafts, while unrelated metadata and voxel edits preserve them',()=>{
  const {scope,mask,local}=setup();
  try{
    local.update(0,'lower',50);local.choose(0);
    mask.value={...mask.value!,name:'renamed',revision:1,data:new Uint8Array([1,0]),threshold:[100,500]};
    assert.equal(local.slot.value,0);assert.deepEqual(local.range.value,bounds(50,500));
    mask.value={...mask.value!,threshold:[200,600]};
    assert.equal(local.slot.value,1);assert.deepEqual(local.ranges.value.map(r=>({lower:r.lower,upper:r.upper})),[bounds(200,600),bounds(200,600),bounds(200,600)]);
    local.update(2,'upper',800);local.choose(2);mask.value={...mask.value!,id:'another-mask'};
    assert.equal(local.slot.value,1);assert.deepEqual(local.ranges.value[2],{lower:200,upper:600,editable:true});
    local.update(0,'lower',150);local.choose(0);local.reset();assert.equal(local.slot.value,1);assert.deepEqual(local.ranges.value[0],{lower:200,upper:600,editable:true});
  }finally{scope.stop();}
});

test('replacing the volume resets drafts even when the active mask and its stored values stay the same',()=>{
  const {scope,volume,mask,local}=setup(),source=mask.value;
  try{
    local.update(0,'lower',0);local.choose(0);volume.value=image(2000);
    assert.equal(mask.value,source);assert.equal(local.slot.value,1);assert.deepEqual(local.range.value,bounds(100,500));assert.deepEqual(local.ranges.value[0],{lower:100,upper:500,editable:true});
  }finally{scope.stop();}
});

test('missing stored thresholds use the existing application fallback and no image supplies only a neutral placeholder',()=>{
  const {scope,mask,volume,local}=setup(null);
  try{
    assert.deepEqual(local.range.value,bounds(226,1000));local.update(0,'lower',100);local.choose(0);
    mask.value={...mask.value!,threshold:[226,1000]};assert.equal(local.slot.value,1);assert.deepEqual(local.ranges.value[0],{lower:226,upper:1000,editable:true});
    mask.value={...mask.value!,threshold:null};volume.value=image(120);assert.deepEqual(local.range.value,bounds(120,120));
    volume.value=image(-300);assert.deepEqual(local.range.value,bounds(-300,-300));
    mask.value=undefined;volume.value=null;assert.equal(local.slot.value,1);assert.deepEqual(local.range.value,bounds(0,0));assert.equal(local.update(0,'upper',100),false);
  }finally{scope.stop();}
});
