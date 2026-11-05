import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computed,effectScope,ref,shallowRef} from 'vue';
import {parseNifti} from '../src/core.ts';
import {addPart,createProject,decodeProject,encodeProject,ProjectHistory,replaceMask,validateProject,volumeGrid} from '../src/mimics/project.ts';
import type {ProjectState} from '../src/mimics/project.ts';
import {inheritPartSource,partSourceStatus} from '../src/mimics/partProvenance.ts';
import {useAdvancedTools} from '../src/mimics/useAdvancedTools.ts';
import type {OperationRequest} from '../src/mimics/operationClient.ts';

const mesh={positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])};
function fixture(){
  const buffer=new ArrayBuffer(360),h=new DataView(buffer),bytes=new Uint8Array(buffer);
  h.setInt32(0,348,true);h.setInt16(40,3,true);[2,2,2].forEach((n,a)=>{h.setInt16(42+a*2,n,true);h.setFloat32(80+a*4,1,true);});h.setInt16(70,2,true);h.setInt16(72,8,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);bytes.set([110,43,49,0],344);
  const volume=parseNifti(buffer,'synthetic-provenance.nii');let fresh=createProject(volume);
  fresh=replaceMask(fresh,fresh.selectedMaskId,new Uint8Array(8).fill(1));fresh=addPart(fresh,mesh,fresh.masks[0]);
  const originalPartId=fresh.selectedPartId,maskId=fresh.selectedMaskId;
  fresh={...fresh,measurements:[{id:'annotation',name:'historical anchor',kind:'annotation',points:[[0,0,0]],partId:originalPartId,text:'preserve world point',visible:true,color:'#ffffff'},{id:'path',name:'historical path',kind:'surface-distance',points:[[0,0,0],[1,0,0]],controlPoints:[[0,0,0],[1,0,0]],pathMethod:'edge-graph',partId:originalPartId,visible:true,color:'#112233'}]};
  const stale=replaceMask(fresh,maskId,new Uint8Array([1,0,0,0,0,0,0,0]));return{volume,fresh,stale,originalPartId,maskId};
}
function harness(initial?:ProjectState){
  const input=fixture(),state=shallowRef(initial??input.stale),volume=shallowRef(input.volume),history=new ProjectHistory(1_000_000),scope=effectScope();
  const activeMask=computed(()=>state.value.masks.find(m=>m.id===state.value.selectedMaskId)),activePart=computed(()=>state.value.parts.find(p=>p.id===state.value.selectedPartId));
  const commit=(name:string,next:ProjectState)=>{history.push(name,state.value,next);state.value=next;};
  // Only update callbacks are exercised. These literal outputs do not certify cut/split/repair algorithms.
  let resultOverride:unknown=undefined;
  const runJob=async(request:OperationRequest,name:string,update?:(result:any,state:ProjectState)=>ProjectState)=>{
    const result=resultOverride??(request.kind==='cut'?{intersects:true,positive:mesh,negative:mesh}:request.kind==='split'?[mesh,mesh]:mesh);
    if(update)commit(name,update(result,state.value));return result as any;
  };
  const tools=scope.run(()=>useAdvancedTools({state,volume,grid:computed(()=>volumeGrid(input.volume)),activeMask,activePart,point:ref([0,0,0]),activeAxis:ref(2),tool:ref('navigate'),objectTab:ref('parts'),busy:ref(false),status:ref(''),commit,fail:error=>{throw error;},runJob,runMask:async()=>{}}))!;
  return{...input,state,volume,history,scope,tools,setResult:(result:unknown)=>{resultOverride=result;}};
}
const normal=(value:unknown)=>JSON.parse(JSON.stringify(value));

test('source status distinguishes external, missing, unknown, current and stale without inventing a revision',()=>{
  const {fresh,stale}=fixture(),part=fresh.parts[0]!;
  assert.equal(partSourceStatus(part,fresh.masks),'current');assert.equal(partSourceStatus(part,stale.masks),'stale');
  assert.equal(partSourceStatus(part,[]),'missing');assert.equal(partSourceStatus({...part,sourceRevision:undefined},[]),'missing');
  assert.equal(partSourceStatus({...part,sourceRevision:undefined},fresh.masks),'unknown');
  assert.equal(partSourceStatus({...part,sourceMaskId:undefined,sourceRevision:undefined},fresh.masks),'external');
  assert.deepEqual(inheritPartSource({...part,sourceRevision:undefined}),{sourceMaskId:part.sourceMaskId});assert.deepEqual(inheritPartSource({...part,sourceMaskId:undefined,sourceRevision:undefined}),{});
});

test('cut, split and repair update callbacks retain old mask ancestry across ZIP and one atomic undo-redo',{timeout:10000},async()=>{
  for(const operation of ['cut','splitParts','fixNormals','stitch'] as const)for(const keep of [true,false]){
    const h=harness();try{
      h.tools.parameters.keepOriginals=keep;const original=h.state.value.parts[0]!,before=normal(h.state.value),maskBefore=h.state.value.masks[0]!.data.slice();
      if(operation==='cut')await h.tools.cut();else if(operation==='splitParts')await h.tools.splitParts();else await h.tools.repair(operation);
      const outputs=h.state.value.parts.filter(p=>p.id!==h.originalPartId);assert.equal(outputs.length,operation==='cut'||operation==='splitParts'?2:1);
      for(const part of outputs){assert.equal(part.sourceMaskId,original.sourceMaskId);assert.equal(part.sourceRevision,1);assert.equal(partSourceStatus(part,h.state.value.masks),'stale');}
      assert.equal(h.state.value.masks[0]!.revision,2);assert.deepEqual(h.state.value.masks[0]!.data,maskBefore);assert.deepEqual(h.state.value.measurements.map(m=>m.partId),[h.originalPartId,h.originalPartId]);
      assert.equal(h.history.past.length,1);const expected=normal(h.state.value),restored=decodeProject(encodeProject(h.volume.value,h.state.value)).state;assert.deepEqual(normal(restored),expected);
      assert.equal(restored.parts.some(p=>p.id===h.originalPartId),operation==='fixNormals'||operation==='stitch'||keep);
      assert.deepEqual(normal(h.history.undo()),before);assert.deepEqual(normal(h.history.redo()),expected);
    }finally{h.scope.stop();}
  }
});

test('legacy unknown or deleted ancestry and truly external Parts remain distinct after derived outputs and ZIP',{timeout:10000},async()=>{
  for(const mode of ['unknown','deleted-known','deleted-unknown','external'] as const){
    const h=harness();try{
      const base=h.state.value,part=base.parts[0]!,changed={...part,...(mode==='unknown'||mode==='deleted-unknown'?{sourceRevision:undefined}:{}),...(mode==='external'?{sourceMaskId:undefined,sourceRevision:undefined}:{})};
      h.state.value={...base,parts:[changed],...(mode.startsWith('deleted')?{masks:[],selectedMaskId:''}:{})};h.tools.parameters.keepOriginals=false;
      await h.tools.cut();const expected=mode.startsWith('deleted')?'missing':mode==='unknown'?'unknown':'external';
      for(const output of h.state.value.parts){assert.equal(partSourceStatus(output,h.state.value.masks),expected);assert.equal(output.sourceRevision,mode==='deleted-known'?1:undefined);assert.equal(output.sourceMaskId,mode==='external'?undefined:part.sourceMaskId);}
      const restored=decodeProject(encodeProject(h.volume.value,h.state.value)).state;
      for(const output of restored.parts)assert.equal(partSourceStatus(output,restored.masks),expected);
      assert.equal(restored.measurements[0]!.partId,h.originalPartId);assert.deepEqual(restored.measurements[0]!.points,[[0,0,0]]);
    }finally{h.scope.stop();}
  }
});

test('mask edit/delete, Part delete and replay preserve historical measurement attachments without silent retargeting',()=>{
  const {volume,fresh,stale,originalPartId}=fixture(),history=new ProjectHistory(1000000);
  history.push('edit mask',fresh,stale);assert.equal(partSourceStatus(stale.parts[0]!,stale.masks),'stale');
  const missing={...stale,masks:[],selectedMaskId:''};history.push('delete source',stale,missing);
  const missingPart={...missing,parts:[],selectedPartId:''};history.push('delete Part',missing,missingPart);
  const restored=decodeProject(encodeProject(volume,missingPart)).state;
  assert.equal(restored.parts.length,0);assert.deepEqual(restored.measurements.map(m=>m.partId),[originalPartId,originalPartId]);assert.deepEqual(restored.measurements[1]!.controlPoints,[[0,0,0],[1,0,0]]);
  const withPart=history.undo()!;assert.equal(partSourceStatus(withPart.parts[0]!,withPart.masks),'missing');assert.equal(withPart.measurements[0]!.partId,originalPartId);
  const withMask=history.undo()!;assert.equal(partSourceStatus(withMask.parts[0]!,withMask.masks),'stale');const original=history.undo()!;assert.equal(partSourceStatus(original.parts[0]!,original.masks),'current');
  validateProject(volume,withPart);validateProject(volume,withMask);validateProject(volume,original);
});

test('rejected cut/split results cannot publish partial derived Parts or history entries',async()=>{
  for(const operation of ['cut','splitParts'] as const){
    const h=harness();try{
      const before=normal(h.state.value);h.setResult(operation==='cut'?{intersects:false,positive:mesh,negative:mesh}:[mesh]);
      await assert.rejects(operation==='cut'?h.tools.cut():h.tools.splitParts());assert.deepEqual(normal(h.state.value),before);assert.equal(h.history.past.length,0);
    }finally{h.scope.stop();}
  }
});
