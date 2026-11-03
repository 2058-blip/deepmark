import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSSRApp} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {unzipSync} from 'fflate';
import {useEditor} from '../src/useEditor.ts';
import type {Change,Volume} from '../src/core.ts';
import {exportNifti,makeDemo,parseNifti} from '../src/core.ts';
import {annotationArchive} from '../src/exportArchive.ts';
import {opinionIndex,projectOpinion,projectRegions} from '../src/optimisticOpinions.ts';
import type {VoxelOpinion} from '../src/optimisticOpinions.ts';
import type {ParallelRegion} from '../src/collaborationTypes.ts';
import {applyShared} from '../server/sharedModel.mjs';

async function editorFixture(){
  let editor!:ReturnType<typeof useEditor>;
  await renderToString(createSSRApp({setup(){editor=useEditor();return ()=>null;}}));
  const volume:Volume={name:'optimistic-eraser',dims:[5,5,1],spacing:[1,1,1],data:new Float32Array(25).fill(40),header:new Uint8Array(348),little:true,min:40,max:40,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],oblique:false,unit:'mm'};
  editor.install(volume);editor.diameter.value=1;editor.tool.value='erase';
  const changes:{change:Change;kind?:string}[]=[];
  editor.setChangeHandler((change,kind)=>changes.push({change,kind}));
  return {editor,changes};
}

test('collaborative eraser renders during the stroke and stays erased while its operation awaits acknowledgement',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;editor.setPersonalValueHandler(index=>index===12?1:null);
  editor.startStroke('mouse');editor.stroke(2,0,2,2);
  assert.equal(editor.mask.value[12],0,'dragging must show the erasure before any operation can be sent');
  assert.equal(changes.length,0,'a drag is not a committed collaboration operation');
  assert.deepEqual([...editor.pendingChange()!.before],[1]);
  assert.deepEqual([...editor.pendingChange()!.after],[0]);
  assert.deepEqual([...editor.pendingDisplayChange()!.after],[0]);
  editor.endStroke();
  assert.equal(editor.mask.value[12],0,'releasing must not restore the old server image');
  assert.equal(changes.length,1);assert.equal(editor.history.value.length,1);
  assert.deepEqual([...changes[0].change.after],[0]);
});

test('eraser cannot remove another author or a different personal label',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=2;
  for(const own of [null,2]){
    editor.setPersonalValueHandler(()=>own);editor.startStroke('mouse');editor.stroke(2,0,2,2);editor.endStroke();
    assert.equal(editor.mask.value[12],2);assert.equal(changes.length,0);assert.equal(editor.history.value.length,0);
  }
});

test('undo and redo update the optimistic erased display without waiting for a server callback',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;editor.setPersonalValueHandler(index=>index===12?1:null);
  editor.startStroke('mouse');editor.stroke(2,0,2,2);editor.endStroke();
  editor.undo();assert.equal(editor.mask.value[12],1);assert.equal(changes[1].kind,'undo');assert.deepEqual([...changes[1].change.after],[1]);
  editor.undo(true);assert.equal(editor.mask.value[12],0);assert.equal(changes[2].kind,'redo');assert.deepEqual([...changes[2].change.after],[0]);
});

test('cancelling a touch eraser restores its display baseline without publishing or making history',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;editor.setPersonalValueHandler(index=>index===12?1:null);
  editor.startStroke('touch');editor.stroke(2,0,2,2);assert.equal(editor.mask.value[12],0);
  const cache=editor.mask.value.slice();editor.restorePendingBase(cache);assert.equal(cache[12],1,'an interruptible touch snapshot keeps the baseline');
  editor.cancelStroke();assert.equal(editor.mask.value[12],1);assert.equal(editor.strokeActive.value,false);assert.equal(editor.pendingChange(),null);
  assert.equal(changes.length,0);assert.equal(editor.history.value.length,0);assert.equal(editor.dirty.value,false);
});

test('an active erasure can be reapplied to a refreshed baseline and cancelled without losing unrelated remote edits',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;editor.setPersonalValueHandler(index=>index===12?1:null);
  editor.startStroke('touch');editor.stroke(2,0,2,2);const preview=editor.pendingDisplayChange()!;
  assert.ok(preview,'an active erasure has a local display overlay');
  editor.restorePendingBase();editor.mask.value[13]=2;editor.rebasePending(editor.mask.value);
  preview.indices.forEach((index,k)=>{editor.mask.value[index]=preview.after[k];});
  assert.equal(editor.mask.value[12],0);assert.equal(editor.mask.value[13],2);
  editor.cancelStroke();assert.equal(editor.mask.value[12],1);assert.equal(editor.mask.value[13],2);assert.equal(changes.length,0);
});

test('read-only, edit-locked and busy editors never make an optimistic erasure',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;editor.setPersonalValueHandler(()=>1);
  for(const locked of [editor.readOnly,editor.editLocked,editor.busy]){
    locked.value=true;editor.startStroke('mouse');editor.stroke(2,0,2,2);editor.endStroke();locked.value=false;
    assert.equal(editor.mask.value[12],1);assert.equal(changes.length,0);assert.equal(editor.history.value.length,0);
  }
});

test('an eraser transaction removes the personal label while its immediate display reveals another author',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;
  editor.setPersonalValueHandler(index=>index===12?1:null);editor.setDisplayValueHandler((_index,after)=>after===0?2:after);
  editor.startStroke('mouse');editor.stroke(2,0,2,2);
  assert.equal(editor.mask.value[12],2);
  assert.deepEqual([...editor.pendingChange()!.after],[0],'the server receives withdrawal, not the other author label');
  assert.deepEqual([...editor.pendingDisplayChange()!.after],[2],'rendering follows the merged display separately');
  editor.endStroke();assert.equal(editor.mask.value[12],2);assert.deepEqual([...changes[0].change.after],[0]);
  editor.undo();assert.equal(editor.mask.value[12],1);editor.undo(true);assert.equal(editor.mask.value[12],2);
});

test('remote opinion changes update an active eraser preview and cancellation restores the latest shared display',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value[12]=1;let remaining=2;
  editor.setPersonalValueHandler(index=>index===12?1:null);editor.setDisplayValueHandler((_index,after)=>after===0?remaining:after);
  editor.startStroke('touch');editor.stroke(2,0,2,2);assert.equal(editor.mask.value[12],2);
  // Rebuild the authoritative baseline after a new remote label, then re-project the same local intent.
  editor.restorePendingBase();editor.mask.value[12]=3;remaining=3;editor.rebasePending(editor.mask.value);editor.renderPending();
  assert.equal(editor.mask.value[12],3);assert.deepEqual([...editor.pendingChange()!.after],[0]);
  editor.cancelStroke();assert.equal(editor.mask.value[12],3);assert.equal(changes.length,0);
});

test('optimistic withdrawals agree with the server model for own, foreign and mixed parallel opinions',()=>{
  const cases:{owner:string;rows:VoxelOpinion[];actor:string}[]=[
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:2}],actor:'a'},
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:1}],actor:'a'},
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:2},{author:'c',label:3}],actor:'a'},
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:2},{author:'c',label:2}],actor:'a'},
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:0},{author:'c',label:2}],actor:'a'},
    {owner:'a',rows:[{author:'a',label:1},{author:'b',label:0}],actor:'a'},
    {owner:'b',rows:[{author:'a',label:1},{author:'b',label:2},{author:'c',label:3}],actor:'a'},
    {owner:'b',rows:[{author:'a',label:1},{author:'b',label:2}],actor:'c'},
    {owner:'a',rows:[{author:'a',label:1}],actor:'a'},
  ];
  for(const scenario of cases){
    const authors=[...new Set(scenario.rows.map(row=>row.author))].map(id=>({id,name:id}));
    const canonical=scenario.rows.find(row=>row.author===scenario.owner)!.label;
    const model={dims:[1,1,1],mask:Uint16Array.of(canonical),owners:Uint32Array.of(authors.findIndex(row=>row.id===scenario.owner)+1),authors,
      regions:[{id:'region',indices:[0],annotations:scenario.rows.map((row,n)=>({id:String(n),author:row.author,name:row.author,values:[[0,row.label]],created:''})),bounds:{min:[0,0,0],max:[0,0,0]},created:'',updated:''}]};
    const original=structuredClone(scenario.rows),optimistic=projectOpinion(scenario.actor,0,canonical,scenario.owner===scenario.actor,scenario.rows);
    applyShared(model,{id:scenario.actor,name:scenario.actor},[[0,scenario.rows.find(row=>row.author===scenario.actor)?.label||0,0]]);
    const remaining=model.regions.flatMap(region=>region.annotations.flatMap(row=>row.values.filter(([index])=>index===0).map(([,label])=>label)));
    const serverChoices=remaining.length?[...new Set(remaining)]:model.mask[0]?[model.mask[0]]:[];
    assert.equal(optimistic.value,model.mask[0],JSON.stringify(scenario));
    assert.deepEqual([...optimistic.choices].sort(),serverChoices.sort(),JSON.stringify(scenario));
    assert.deepEqual(scenario.rows,original,'projecting must not change the authoritative region metadata');
  }
});

test('same-color agreement metadata preserves a remaining author before any acknowledgement arrives',()=>{
  const index=opinionIndex([],[[12,['a','b']]],()=>1),opinions=index.get(12)!;
  const projected=projectOpinion('a',0,1,true,opinions);
  assert.equal(projected.value,1);assert.deepEqual(projected.choices,[1]);assert.deepEqual(projected.opinions.map(row=>row.author),['b']);
  assert.deepEqual(opinions.map(row=>row.author),['a','b']);
  const again=projectOpinion('a',0,projected.value,false,projected.opinions);
  assert.deepEqual(again,projected,'an already projected withdrawal must not erase the remaining author a second time');
});

test('explicit region opinions take precedence over same-color claims and retain zero-valued disagreement',()=>{
  const region:ParallelRegion={id:'r',indices:[12],annotations:[{id:'a-opinion',author:'a',name:'A',values:[[12,1]],created:''},{id:'b-opinion',author:'b',name:'B',values:[[12,0]],created:''},{id:'c-opinion',author:'c',name:'C',values:[[12,2]],created:''}],bounds:{min:[2,2,0],max:[2,2,0]},created:'',updated:''};
  const index=opinionIndex([region],[[12,['a','b','c']]],()=>1),projected=projectOpinion('a',0,1,true,index.get(12));
  assert.equal(projected.value,2);assert.deepEqual(projected.choices,[0,2]);assert.deepEqual(projected.opinions.map(row=>[row.author,row.label]),[['b',0],['c',2]]);
  assert.deepEqual(region.annotations.map(row=>row.values[0][1]),[1,0,2]);
});

test('queued erase, undo and redo compose without dropping the remaining author or mutating server metadata',()=>{
  const canonical:VoxelOpinion[]=[{author:'a',label:1},{author:'b',label:2}],original=structuredClone(canonical);
  const erased=projectOpinion('a',0,1,true,canonical);assert.equal(erased.value,2);assert.deepEqual(erased.choices,[2]);
  const undone=projectOpinion('a',1,1,true,erased.opinions);assert.equal(undone.value,1);assert.deepEqual([...undone.choices].sort(),[1,2]);
  const redone=projectOpinion('a',0,1,true,undone.opinions);assert.deepEqual(redone,erased);assert.deepEqual(canonical,original);
  const acknowledged=projectOpinion('a',0,2,false,[{author:'b',label:2}]);assert.deepEqual(acknowledged,erased,'the authoritative acknowledgement must not change the already projected display');
});

function recordAuthority(editor:ReturnType<typeof useEditor>,owned:boolean){
  const authority=new Map<number,number>();
  editor.setDisplayValueHandler((index,after,before)=>{
    if(!authority.has(index))authority.set(index,before??editor.mask.value[index]);
    return projectOpinion('local',after,authority.get(index)!,owned).value;
  });
  return authority;
}

test('gray-region fill records the pre-fill authority so undo has no ghost while acknowledgement is delayed',async()=>{
  const {editor,changes}=await editorFixture(),authority=recordAuthority(editor,false);
  editor.setPersonalValueHandler(()=>null);editor.tool.value='region';
  editor.selectRegion(2,0,Uint32Array.of(12));
  assert.equal(editor.mask.value[12],1);assert.equal(authority.get(12),0,'the baseline must be captured before region fill changes the mask');
  assert.deepEqual([...changes[0].change.before],[0]);assert.deepEqual([...changes[0].change.after],[1]);
  editor.undo();assert.equal(editor.mask.value[12],0,'undo must not mistake the local fill for another author annotation');
  editor.undo(true);assert.equal(editor.mask.value[12],1);assert.equal(authority.get(12),0);
});

test('threshold additions preserve the original empty authority through delayed undo and redo',async()=>{
  const {editor,changes}=await editorFixture(),authority=recordAuthority(editor,false);
  editor.setPersonalValueHandler(()=>null);editor.tool.value='threshold';editor.thresholdMin.value='40';editor.thresholdMax.value='40';
  await editor.runThreshold();
  assert.equal(changes.length,1);assert.equal(editor.mask.value.every(value=>value===1),true);
  assert.equal(authority.size,25);assert.equal([...authority.values()].every(value=>value===0),true);
  editor.undo();assert.equal(editor.mask.value.some(Boolean),false,'the still-pending threshold fill must disappear immediately');
  editor.undo(true);assert.equal(editor.mask.value.every(value=>value===1),true);
});

test('threshold removals preserve the owned authority through delayed undo and redo',async()=>{
  const {editor,changes}=await editorFixture();editor.mask.value.fill(1);const authority=recordAuthority(editor,true);
  editor.setPersonalValueHandler(()=>1);editor.tool.value='threshold';editor.thresholdMin.value='100';editor.thresholdMax.value='101';
  await editor.runThreshold();
  assert.equal(changes.length,1);assert.equal(editor.mask.value.some(Boolean),false);
  assert.equal(authority.size,25);assert.equal([...authority.values()].every(value=>value===1),true);
  assert.equal([...changes[0].change.after].every(value=>value===0),true);
  editor.undo();assert.equal(editor.mask.value.every(value=>value===1),true);
  editor.undo(true);assert.equal(editor.mask.value.some(Boolean),false);
});

test('a main opinion update keeps the same author incoming alternative, while withdrawal removes both like the server',()=>{
  const rows:VoxelOpinion[]=[
    {author:'a',label:1,sourceKey:'a',annotationId:'main'},
    {author:'a',label:2,sourceKey:'a:incoming',annotationId:'incoming'},
    {author:'b',label:3,sourceKey:'b',annotationId:'other'},
  ];
  for(const after of [4,0]){
    const model={dims:[1,1,1],mask:Uint16Array.of(1),owners:Uint32Array.of(1),authors:[{id:'a',name:'A'},{id:'b',name:'B'}],
      regions:[{id:'r',indices:[0],annotations:rows.map(row=>({id:row.annotationId,sourceKey:row.sourceKey,author:row.author,name:row.author,values:[[0,row.label]],created:''})),bounds:{min:[0,0,0],max:[0,0,0]},created:'',updated:''}]};
    const projected=projectOpinion('a',after,1,true,rows);
    applyShared(model,{id:'a',name:'A'},[[0,1,after]]);
    const remaining=model.regions.flatMap(region=>region.annotations.flatMap(row=>row.values.filter(([index])=>index===0).map(([,label])=>label)));
    const expectedChoices=remaining.length?[...new Set(remaining)]:model.mask[0]?[model.mask[0]]:[];
    assert.equal(projected.value,model.mask[0]);assert.deepEqual([...projected.choices].sort(),expectedChoices.sort());
    if(after){
      assert.deepEqual(projected.opinions.find(row=>row.sourceKey==='a:incoming'),rows[1]);
      assert.equal(projected.opinions.find(row=>row.sourceKey==='a')!.label,4);
    }else assert.equal(projected.opinions.some(row=>row.author==='a'),false);
    assert.deepEqual(rows.map(row=>row.label),[1,2,3]);
  }
});

test('local rescue export removes withdrawn opinions and recomputes a reduced parallel region without mutating authority',()=>{
  const region:ParallelRegion={id:'r',indices:[11,12],annotations:[
    {id:'own',author:'a',name:'本人',values:[[11,1],[12,1]],created:'original'},
    {id:'other',author:'b',name:'同事',values:[[11,2],[12,2]],created:'original'},
    {id:'third',author:'c',name:'另一位同事',values:[[12,0]],created:'original'},
  ],bounds:{min:[1,2,0],max:[2,2,0]},created:'original',updated:'original'};
  const original=structuredClone(region),indexed=opinionIndex([region],[],()=>1),intents=new Map([[11,0],[12,0]]);
  const projected=projectRegions([region],intents,(index,after)=>projectOpinion('a',after,1,true,indexed.get(index)),[5,5,1],{id:'a',name:'本人'});
  assert.equal(projected.length,1);assert.deepEqual(projected[0].indices,[12]);
  assert.deepEqual(projected[0].bounds,{min:[2,2,0],max:[2,2,0]});
  assert.deepEqual(projected[0].annotations.map(row=>({author:row.author,name:row.name,values:row.values})),[
    {author:'b',name:'同事',values:[[12,2]]},{author:'c',name:'另一位同事',values:[[12,0]]},
  ],'a foreign zero-valued opinion must survive withdrawal of the current author');
  assert.deepEqual(region,original,'the rescue export must not rewrite the authoritative region');
});

test('local rescue export adds parallel metadata for a pending paint outside every server region and round trips its ZIP',async()=>{
  const volume=makeDemo(),mask=new Uint16Array(volume.data.length),index=12;
  const projection=projectOpinion('a',1,2,false),regions=projectRegions([],new Map([[index,1]]),()=>projection,volume.dims,{id:'a',name:'本人'});
  mask[index]=projection.value;
  assert.equal(mask[index],2,'the other author remains the canonical segmentation while the new local opinion is pending');
  assert.equal(regions.length,1);assert.deepEqual(regions[0].indices,[index]);
  assert.deepEqual(regions[0].bounds,{min:[12,0,0],max:[12,0,0]});
  assert.deepEqual(regions[0].annotations.map(row=>[row.author,row.name,row.values]),[
    ['unknown-primary','已有标注（作者待查询）',[[index,2]]],['a','本人',[[index,1]]],
  ],'an unknown canonical author must not be attributed to the local author');
  const archive=await annotationArchive(exportNifti(volume,mask),[{id:1,name:'本人标签',color:'#123456'},{id:2,name:'同事标签',color:'#abcdef'}],{local:true,projectId:'pending-project',revision:5,parallelRegions:regions});
  const files=unzipSync(new Uint8Array(archive)),json=(name:string)=>JSON.parse(new TextDecoder().decode(files[name]));
  const restored=parseNifti(files['segmentation.nii'].slice().buffer);
  assert.equal(restored.data[index],2);assert.deepEqual(restored.dims,volume.dims);
  assert.equal(json('manifest.json').parallelFile,'parallel-annotations.json');
  assert.equal(json('manifest.json').local,true);assert.equal(json('parallel-annotations.json').revision,5);
  assert.deepEqual(json('parallel-annotations.json').parallelRegions,regions,'the archive must contain both displayed opinions before synchronization');
});

test('local rescue export does not invent conflicts for empty or same-color pending opinions and resolves known claim authors',()=>{
  const intents=new Map([[0,0],[1,1],[2,1],[3,1]]),claims=opinionIndex([],[[1,['a','b']],[3,['b','c']]],index=>index===3?2:1);
  const regions=projectRegions([],intents,(index,after)=>projectOpinion('a',after,index===0?0:index===2||index===3?2:1,index===1,claims.get(index)),[5,1,1],{id:'a',name:'本人'},new Map([['b','同事 B'],['c','同事 C']]));
  assert.deepEqual(regions.map(region=>region.indices),[[2],[3]],'only multi-label pending opinions need a parallel file');
  assert.deepEqual(regions[1].annotations.map(row=>[row.author,row.name,row.values[0][1]]),[['b','同事 B',2],['c','同事 C',2],['a','本人',1]]);
});
