import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import {exportNifti} from '../src/core.ts';
import {encodeProject,decodeProject} from '../src/mimics/project.ts';
import {meshStats} from '../src/mimics/geometry.ts';
import type {WorkspaceRepository,WorkspaceSnapshot,WorkspaceSummary} from '../src/mimics/workspaceRepository.ts';

// This adapter runs operations.worker.ts itself. It verifies controller/worker
// boundaries, not browser rendering, pointer capture, file pickers or downloads.
const workers=new Set<NodeWorker>();
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  worker:NodeWorker;
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads'; globalThis.self={postMessage:value=>parentPort.postMessage(value)}; await import(${JSON.stringify(url.href)}); parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));
    workers.add(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));
    this.worker.on('error',error=>this.onerror?.({message:error.message}));
    this.worker.on('exit',()=>workers.delete(this.worker));
  }
  postMessage(value:unknown){this.worker.postMessage(value);}
  terminate(){void this.worker.terminate();}
}
async function withEditor(run:(editor:ReturnType<typeof useWorkbench>)=>Promise<void>,options:Parameters<typeof useWorkbench>[0]={repository:null}){
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),editor=scope.run(()=>useWorkbench(options))!;
  try{await run(editor);}finally{if(options?.repository)await editor.flushLocalCache().catch(()=>{});editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...workers].map(worker=>worker.terminate()));}
}
function delayedFile(name:string){
  let resolve!:(bytes:ArrayBuffer)=>void;
  const promise=new Promise<ArrayBuffer>(done=>resolve=done);
  return {file:{name,arrayBuffer:()=>promise} as File,resolve};
}
function bytesFile(name:string,bytes:Uint8Array|ArrayBuffer){return new File([bytes instanceof Uint8Array?bytes.slice().buffer:bytes],name);}
function imageFile(options:{unit?:number;nativeScale?:number;name?:string}={}){
  // An explicit 8 x 6 x 3 image in mm, two separated 100-valued cuboids.
  const bytes=new Uint8Array(352+8*6*3*2),view=new DataView(bytes.buffer);
  view.setInt32(0,348,true);view.setInt16(40,3,true);
  const nativeScale=options.nativeScale??1;
  [8,6,3].forEach((n,a)=>{view.setInt16(42+a*2,n,true);view.setFloat32(80+a*4,nativeScale,true);});
  view.setInt16(70,4,true);view.setInt16(72,16,true);view.setFloat32(108,352,true);view.setUint8(123,options.unit??2);view.setInt16(254,1,true);
  [[1,0,0,10],[0,1,0,-20],[0,0,1,30]].forEach((row,r)=>row.forEach((n,c)=>view.setFloat32(280+r*16+c*4,n*nativeScale,true)));
  bytes.set([110,43,49,0],344);
  for(let z=0;z<3;z++)for(let y=0;y<6;y++)for(let x=0;x<8;x++)view.setInt16(352+2*(x+8*(y+6*z)),(x>=1&&x<=2&&y>=1&&y<=2||x===6&&y===4)&&z===1?100:0,true);
  return bytesFile(options.name??'foundation.nii',bytes);
}
const hasMembers=(data:Uint8Array)=>data.some(Boolean);
const close=(actual:number,expected:number,tolerance=1e-4)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} differs from ${expected}`);
function applyAnnotationProperties(e:ReturnType<typeof useWorkbench>){const draft=e.measurementEditor.draft.value;assert.ok(draft);assert.equal(e.measurementEditor.apply({name:draft.name,text:draft.text,color:draft.color,visible:draft.visible}),true);}

test('a new file request clears old series and replacement candidates without discarding committed dirty work',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;e.brushBegin(2,1);e.brushStroke([1,1,1],2,1);e.brushEnd();
  const original=e.state.value,volume=e.volume.value,revision=e.revision.value,undo=e.undoName.value;
  await e.openFiles([imageFile({name:'old-candidate.nii'})]);assert.equal(e.pendingReplacement.value?.volume.name,'old-candidate.nii');
  e.series.value=[{seriesInstanceUID:'synthetic-old-series',modality:'CT',slices:[]}] as typeof e.series.value;e.seriesChoice.value=7;
  const failed=e.openFiles([bytesFile('new-broken.nii',new Uint8Array([1,2,3]))]);
  assert.equal(e.pendingReplacement.value,null);assert.deepEqual(e.series.value,[]);assert.equal(e.seriesChoice.value,0);
  await failed;assert.ok(e.error.value);assert.ok(e.state.value===original);assert.ok(e.volume.value===volume);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.dirty.value,true);
  e.loadSeries();assert.ok(e.state.value===original);assert.ok(e.volume.value===volume);
}));

test('cancelling the file chooser keeps the existing candidate and committed state',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';e.brushBegin(2,1);e.brushStroke([1,1,1],2,1);e.brushEnd();
  await e.openFiles([imageFile({name:'waiting-candidate.nii'})]);const pending=e.pendingReplacement.value,original=e.state.value;
  assert.ok(pending);assert.equal(await e.openFiles(null),false);assert.equal(await e.openFiles([]),false);
  assert.ok(e.pendingReplacement.value===pending);assert.ok(e.state.value===original);assert.equal(e.dirty.value,true);
}));

for(const result of ['success','failure'] as const)test(`an obsolete cache-before-replacement ${result} cannot publish over a newer import or reset its busy state`,async()=>{
  let enter! :()=>void,release! :()=>void;
  const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve),records=new Map<string,WorkspaceSnapshot>();let writes=0;
  const repository:WorkspaceRepository={
    async save(snapshot){if(++writes===1){enter();await gate;if(result==='failure')throw new Error('obsolete synthetic cache failure');}records.set(snapshot.id,structuredClone(snapshot));},
    async load(id){return records.get(id)||null;},async list(){return[];}
  };
  await withEditor(async e=>{
    await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;e.brushBegin(2,1);e.brushStroke([1,1,1],2,1);e.brushEnd();
    const original=e.state.value,volume=e.volume.value;await e.openFiles([imageFile({name:'old-cache-candidate.nii'})]);
    const saving=e.confirmReplacement('cache');await entered;assert.equal(e.busy.value,true);
    const latest=delayedFile('latest-candidate.nii'),loading=e.openFiles([latest.file]);assert.equal(e.pendingReplacement.value,null);assert.equal(e.busy.value,true);
    release();await saving;
    assert.equal(e.busy.value,true,'old finally must not clear the new import busy flag');assert.equal(e.error.value,'','old failure must not overwrite the new request');assert.ok(e.state.value===original);assert.ok(e.volume.value===volume);
    latest.resolve(await imageFile().arrayBuffer());await loading;assert.equal(e.busy.value,false);assert.equal(e.pendingReplacement.value?.volume.name,'latest-candidate.nii');
    await e.confirmReplacement('discard');assert.equal(e.volume.value!.name,'latest-candidate.nii');assert.equal(e.dirty.value,false);
  },{repository,autosaveDelayMs:60_000});
});
function controlledMemoryRepo(){
  // Persistence test double only. The controller and WorkspaceSaveQueue are real;
  // this does not emulate IndexedDB transactions, quota, reload or browser storage.
  const records=new Map<string,WorkspaceSnapshot>(),attempts:string[]=[];
  let failSaves=false;
  const repository:WorkspaceRepository={
    async save(snapshot){attempts.push(snapshot.id);if(failSaves)throw new Error('synthetic cache quota failure');records.set(snapshot.id,structuredClone(snapshot));},
    async load(id){return records.has(id)?structuredClone(records.get(id)!):null;},
    async list(){return [...records.values()].map(snapshot=>({id:snapshot.id,name:snapshot.state.name,imageName:snapshot.volume.name,updatedAt:snapshot.updatedAt,dims:[...snapshot.volume.dims],maskCount:snapshot.state.masks.length,partCount:snapshot.state.parts.length} as WorkspaceSummary)).sort((a,b)=>b.updatedAt-a.updatedAt);}
  };
  return{repository,records,attempts,setFailure:(value:boolean)=>{failSaves=value;}};
}

test('failed image/project import preserves committed data, dirty state, history and location',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';await nextTick();
  e.brushBegin();e.brushStroke([2,2,1],2,1);e.brushEnd();e.point.value=[1,2,1];
  const state=e.state.value,volume=e.volume.value,undo=e.undoName.value;
  for(const name of ['broken.nii','broken.zip','broken.dcm']){
    await e.openFiles([bytesFile(name,new Uint8Array([1,2,3]))]);
    assert.ok(e.error.value);assert.ok(e.state.value===state,'failed import preserves committed project');assert.ok(e.volume.value===volume,'failed import preserves volume');
    assert.equal(e.dirty.value,true);assert.equal(e.undoName.value,undo);assert.deepEqual(e.point.value,[1,2,1]);assert.equal(e.busy.value,false);
  }
}));

test('cancelled image import cannot replace a subsequently loaded image',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const late=delayedFile('late.nii'),bytes=await imageFile().arrayBuffer();
  const pending=e.openFiles([late.file]);e.cancel();await e.openFiles([bytesFile('replacement.nii',bytes)]);const current=e.volume.value,state=e.state.value;
  late.resolve(bytes);await pending;
  assert.ok(e.volume.value===current,'late import cannot replace current volume');assert.ok(e.state.value===state,'late import cannot replace current project');assert.equal(e.busy.value,false);
}));

test('an obsolete import finally cannot clear busy or progress owned by the next import',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const oldFile=delayedFile('old.nii'),newFile=delayedFile('new.nii'),bytes=await imageFile().arrayBuffer();
  const oldImport=e.openFiles([oldFile.file]);e.cancel();const newImport=e.openFiles([newFile.file]);
  assert.equal(e.busy.value,true);
  // A nonzero progress signal belongs to the current request; obsolete cleanup
  // must leave it alone, irrespective of how the active reader produced it.
  e.progress.value=.25;oldFile.resolve(bytes);await oldImport;
  assert.equal(e.busy.value,true);assert.equal(e.progress.value,.25);
  newFile.resolve(bytes);await newImport;assert.equal(e.busy.value,false);assert.equal(e.progress.value,0);
}));

test('late Mask and STL imports cannot attach objects to a replacement project',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const labels=new Uint16Array(e.volume.value!.data.length);labels[1+8*(1+6)]=1;
  const maskBytes=exportNifti(e.volume.value!,labels);
  const maskFile=delayedFile('late-mask.nii'),maskImport=e.importMask(maskFile.file);
  e.cancel();await e.openFiles([imageFile()]);let current=e.state.value;maskFile.resolve(maskBytes);await maskImport;
  assert.ok(e.state.value===current,'old Mask import must not publish into the replacement image');
  assert.equal(e.error.value,'','discarded imports cannot report an error against the replacement project');
  const stlFile=delayedFile('late.stl'),stlImport=e.importStl(stlFile.file);
  e.cancel();await e.openFiles([imageFile()]);current=e.state.value;
  const text='solid known\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid known';
  stlFile.resolve(new TextEncoder().encode(text).buffer);await stlImport;
  assert.ok(e.state.value===current,'old STL import must not publish into the replacement image');
  assert.equal(e.error.value,'');
}));

test('same-sized Mask with different physical geometry is rejected without altering the project',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const state=e.state.value,bytes=await imageFile().arrayBuffer();
  new DataView(bytes).setFloat32(292,999,true); // srow_x translation, dimensions unchanged.
  await e.importMask(bytesFile('shifted.nii',bytes));
  assert.ok(e.error.value);assert.ok(e.state.value===state,'geometry rejection preserves project');assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');
}));

test('cancelled brush followed by end never commits and leaves no ghost draft',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';await nextTick();const before=e.state.value;
  e.brushBegin();e.brushStroke([2,2,1],2,1);assert.ok(e.draft.value?.some(Boolean));
  e.cancel();e.brushEnd();assert.ok(e.state.value===before,'cancelled brush never publishes a state');assert.equal(e.draft.value,null);assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');
}));

test('changing target during a brush cannot overwrite the new target',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const original=e.activeMask.value!.id;e.newMask();const target=e.activeMask.value!.id;e.selectMask(original);
  e.tool.value='paint';await nextTick();e.brushBegin();e.brushStroke([2,2,1],2,1);e.selectMask(target);e.brushEnd();
  assert.equal(hasMembers(e.state.value.masks.find(mask=>mask.id===target)!.data),false);
  assert.equal(e.draft.value,null);
}));

test('successive brush strokes commit independently and selection is cleared on image replacement',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;await nextTick();
  e.brushBegin();e.brushStroke([1,1,1],2,1);e.brushEnd();const first=e.activeMask.value!.data.slice();
  e.brushBegin();e.brushStroke([6,4,1],2,1);e.brushEnd();assert.equal(e.activeMask.value!.data.reduce((sum,n)=>sum+n,0),2);
  e.undo();assert.deepEqual(e.activeMask.value!.data,first);e.undo();assert.equal(hasMembers(e.activeMask.value!.data),false);
  e.tool.value='select';await nextTick();e.brushBegin();e.brushStroke([1,1,1],2,1);e.brushEnd();assert.ok(e.selection.value);
  const selection=e.selection.value,volume=e.volume.value,state=e.state.value;
  assert.equal(await e.openFiles([imageFile()]),false);
  assert.ok(e.pendingReplacement.value,'a parsed replacement waits for an explicit dirty-project decision');
  assert.ok(e.selection.value===selection,'the old selection belongs to the current image until replacement is confirmed');
  assert.ok(e.volume.value===volume);assert.ok(e.state.value===state);
  await e.confirmReplacement('discard');
  assert.equal(e.pendingReplacement.value,null);assert.equal(e.selection.value,null);assert.equal(e.draft.value,null);assert.equal(e.draftPoints.value.length,0);
}));

test('cancelling a parsed replacement preserves the dirty project, selection, history and view',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;await nextTick();
  e.brushBegin();e.brushStroke([1,1,1],2,1);e.brushEnd();
  e.tool.value='select';await nextTick();e.brushBegin();e.brushStroke([6,4,1],2,1);e.brushEnd();
  e.point.value=[1,2,1];e.activeAxis.value=1;e.center.value=42;e.width.value=350;
  const state=e.state.value,volume=e.volume.value,selection=e.selection.value,undo=e.undoName.value,revision=e.revision.value;
  assert.equal(await e.openFiles([bytesFile('replacement.nii',await imageFile().arrayBuffer())]),false);
  assert.ok(e.pendingReplacement.value);assert.ok(e.state.value===state);assert.ok(e.volume.value===volume);assert.equal(e.dirty.value,true);
  await e.confirmReplacement('cancel');
  assert.equal(e.pendingReplacement.value,null);assert.ok(e.state.value===state);assert.ok(e.volume.value===volume);assert.ok(e.selection.value===selection);
  assert.equal(e.dirty.value,true);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.busy.value,false);
  assert.deepEqual(e.point.value,[1,2,1]);assert.equal(e.activeAxis.value,1);assert.equal(e.center.value,42);assert.equal(e.width.value,350);assert.equal(e.tool.value,'select');
  assert.equal(e.activeMask.value!.data[1+8*(1+6)],1,'the committed brush member remains present');
  e.undo();assert.equal(hasMembers(e.activeMask.value!.data),false,'the preserved history can still undo the original stroke');
}));

test('seed collection is exclusive and changing tools clears its uncommitted constraints',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const state=e.state.value;e.advanced.startSeeds();await nextTick();
  await e.imagePick([1,1,1],2,1);assert.equal(e.advanced.seeds.value.length,1);assert.equal(e.draftPoints.value.length,0);assert.ok(e.state.value===state);
  e.tool.value='paint';await nextTick();assert.equal(e.advanced.seeds.value.length,0);assert.ok(e.state.value===state);
  e.advanced.startSeeds();await nextTick();await e.imagePick([1,1,1],2,1);e.cancel();assert.equal(e.advanced.seeds.value.length,0);assert.ok(e.state.value===state);
}));

test('worker failure and invalid region target leave data atomic and permit retry',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const initial=e.state.value;
  await e.runMask('morphology','invalid morphology',{radius:NaN});assert.ok(e.error.value);assert.ok(e.state.value===initial);assert.equal(e.busy.value,false);
  e.params.lower=100;e.params.upper=100;await nextTick();await e.thresholdPreview();assert.equal(e.error.value,'');e.applyPreview();
  const segmented=e.state.value;e.params.leaveOriginal=false;e.params.target='active';
  await e.runMask('region','invalid same source/target',{connectivity:6},[1,1,1]);assert.ok(e.error.value);assert.ok(e.state.value===segmented);
  e.params.target='new';await e.runMask('region','valid cut to new',{connectivity:6},[1,1,1]);assert.equal(e.error.value,'');assert.equal(e.state.value.masks.length,2);
  assert.equal(e.state.value.selectedMaskId,segmented.selectedMaskId,'a region target requires explicit activation');assert.equal(e.activeMask.value!.data.reduce((sum,n)=>sum+n,0),1);assert.equal(e.state.value.masks.find(mask=>mask.id!==segmented.selectedMaskId)!.data.reduce((sum,n)=>sum+n,0),4);
  e.undo();assert.equal(e.state.value.masks.length,1);assert.deepEqual(e.activeMask.value!.data,segmented.masks[0]!.data);
}));

test('changing threshold cleanup parameters invalidates the in-flight preview before Apply',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.params.lower=100;e.params.upper=100;await nextTick();const before=e.state.value;
  const pending=e.thresholdPreview();e.params.thresholdKeepLargest=true;await nextTick();await pending;
  assert.equal(e.preview.value,null,'preview calculated with superseded cleanup flags must be discarded');
  e.applyPreview();assert.ok(e.state.value===before,'superseded preview cannot commit');
  await e.thresholdPreview();e.applyPreview();assert.equal(e.error.value,'');assert.equal(e.activeMask.value!.data.reduce((sum,n)=>sum+n,0),4);
}));

test('Part geometry and provenance remain historical after source edits and ZIP restore',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.params.lower=100;e.params.upper=100;await nextTick();await e.thresholdPreview();e.applyPreview();
  const source=e.activeMask.value!;await e.runPart('calculate3d');assert.equal(e.error.value,'');const part=e.activePart.value!;
  assert.equal(part.sourceMaskId,source.id);assert.equal(part.sourceRevision,source.revision);const positions=part.mesh.positions.slice();
  e.clearMask();assert.notEqual(e.activeMask.value!.revision,part.sourceRevision);assert.deepEqual(e.activePart.value!.mesh.positions,positions);
  const restored=decodeProject(encodeProject(e.volume.value!,e.state.value));assert.equal(restored.state.parts[0]!.sourceRevision,source.revision);assert.deepEqual(restored.state.parts[0]!.mesh.positions,positions);
}));

test('worker project export and controller ZIP restore retain the saved working position and selected annotation',async()=>{
  let saved:Uint8Array|undefined;
  await withEditor(async e=>{
    await e.openFiles([imageFile()]);e.tool.value='annotation';e.params.annotationText='位置恢复';await nextTick();await e.imagePick([1,2,1],2,1);applyAnnotationProperties(e);
    const annotation=e.state.value.measurements[0]!;assert.equal(annotation.text,'位置恢复');
    e.selectedMeasurementId.value=annotation.id;e.point.value=[1,2,1];e.activeAxis.value=1;e.center.value=42;e.width.value=350;e.renderMode.value='volume';e.tab.value='measurements';
    assert.equal(e.dirty.value,true);const result=await e.saveProject();assert.equal(result?.status,'written');assert.equal(e.error.value,'');assert.ok(saved);assert.equal(e.dirty.value,false);
    e.point.value=[0,0,0];e.activeAxis.value=2;e.center.value=0;e.width.value=100;e.renderMode.value='parts';e.tool.value='navigate';e.tab.value='segmentation';e.selectedMeasurementId.value='';
    assert.equal(await e.openFiles([bytesFile('restored.deepmark.zip',saved!)]),true);assert.equal(e.pendingReplacement.value,null);
    assert.deepEqual(e.point.value,[1,2,1]);assert.equal(e.activeAxis.value,1);assert.equal(e.center.value,42);assert.equal(e.width.value,350);
    assert.equal(e.renderMode.value,'volume');assert.equal(e.tab.value,'measurements');assert.equal(e.tool.value,'annotation');assert.equal(e.selectedMeasurementId.value,annotation.id);
    assert.equal(e.state.value.measurements[0]!.text,'位置恢复');assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');
  },{repository:null,saveFile:async request=>{saved=await request.produce();return{status:'written',name:request.name};}});
});

test('save cancellation, write failure and unconfirmed download preserve dirty data and history',async()=>{
  let mode:'cancelled'|'failed'|'download-started'='cancelled',produced=0;
  await withEditor(async e=>{
    await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;await nextTick();e.brushBegin();e.brushStroke([1,1,1],2,1);e.brushEnd();
    const state=e.state.value,undo=e.undoName.value;
    assert.equal((await e.saveProject())?.status,'cancelled');assert.equal(produced,0);assert.equal(e.dirty.value,true);assert.ok(e.state.value===state);assert.equal(e.busy.value,false);
    mode='failed';assert.equal(await e.saveProject(),undefined);assert.match(e.error.value,/synthetic write failure/);assert.equal(e.dirty.value,true);assert.ok(e.state.value===state);assert.equal(e.undoName.value,undo);assert.equal(e.busy.value,false);
    mode='download-started';assert.equal((await e.saveProject())?.status,'download-started');assert.equal(e.error.value,'');assert.equal(e.dirty.value,true);assert.ok(e.state.value===state);assert.equal(e.undoName.value,undo);assert.equal(e.busy.value,false);assert.equal(produced,2);
  },{repository:null,saveFile:async request=>{if(mode==='cancelled')return{status:'cancelled',name:request.name};await request.produce();produced++;if(mode==='failed')throw new Error('synthetic write failure');return{status:'download-started',name:request.name};}});
});

test('cache-before-replacement failure preserves the dirty document, then successful retry restores its data and view',async()=>{
  const storage=controlledMemoryRepo();
  await withEditor(async e=>{
    await e.openFiles([imageFile()]);e.tool.value='paint';e.params.diameter=1;await nextTick();e.brushBegin();e.brushStroke([1,1,1],2,1);e.brushEnd();
    e.tool.value='annotation';e.params.annotationText='缓存恢复位置';await nextTick();await e.imagePick([1,2,1],2,1);applyAnnotationProperties(e);
    const annotation=e.state.value.measurements[0]!;e.selectedMeasurementId.value=annotation.id;e.point.value=[1,2,1];e.activeAxis.value=1;e.center.value=42;e.width.value=350;e.renderMode.value='volume';e.tab.value='measurements';
    const state=e.state.value,volume=e.volume.value,undo=e.undoName.value,mask=e.activeMask.value!.data.slice();
    storage.setFailure(true);
    assert.equal(await e.openFiles([imageFile({name:'replacement.nii'})]),false);const candidate=e.pendingReplacement.value;assert.ok(candidate);
    await e.confirmReplacement('cache');
    assert.ok(e.state.value===state,'failed persistence cannot install the replacement');assert.ok(e.volume.value===volume);assert.ok(e.pendingReplacement.value===candidate);
    assert.equal(e.dirty.value,true);assert.equal(e.undoName.value,undo);assert.equal(e.busy.value,false);assert.equal(e.cacheState.value,'error');assert.match(e.error.value,/synthetic cache quota failure/);assert.equal(storage.records.size,0);
    assert.deepEqual(e.point.value,[1,2,1]);assert.deepEqual(e.activeMask.value!.data,mask);
    storage.setFailure(false);await e.confirmReplacement('cache');
    assert.equal(e.pendingReplacement.value,null);assert.equal(e.volume.value!.name,'replacement.nii');assert.equal(e.dirty.value,false);assert.equal(e.error.value,'');
    assert.equal(storage.records.size,1,'the old document is stored before the replacement is installed');const [oldId,saved]=[...storage.records][0]!;
    assert.equal(saved.volume.name,'foundation.nii');assert.deepEqual(saved.state.masks[0]!.data,mask);assert.deepEqual(saved.state.viewState!.point,[1,2,1]);
    await e.openLocalProjects();assert.equal(e.showLocalProjects.value,true);assert.equal(e.localProjects.value.length,1);assert.equal(e.localProjects.value[0]!.id,oldId);
    await e.restoreLocalProject(oldId);assert.equal(e.showLocalProjects.value,false);assert.equal(e.error.value,'');assert.equal(e.volume.value!.name,'foundation.nii');assert.deepEqual(e.activeMask.value!.data,mask);
    assert.deepEqual(e.point.value,[1,2,1]);assert.equal(e.activeAxis.value,1);assert.equal(e.center.value,42);assert.equal(e.width.value,350);assert.equal(e.renderMode.value,'volume');assert.equal(e.tab.value,'measurements');assert.equal(e.tool.value,'annotation');assert.equal(e.selectedMeasurementId.value,annotation.id);
    assert.equal(e.state.value.measurements[0]!.text,'缓存恢复位置');assert.equal(e.dirty.value,false);assert.equal(e.undoName.value,'');
  },{repository:storage.repository});
});

test('missing or corrupt cached projects cannot replace a valid current document',async()=>{
  const storage=controlledMemoryRepo();
  await withEditor(async e=>{
    await e.openFiles([imageFile()]);await e.flushLocalCache();const state=e.state.value,volume=e.volume.value;
    await e.restoreLocalProject('missing');assert.ok(e.state.value===state);assert.ok(e.volume.value===volume);assert.match(e.error.value,/不存在/);assert.equal(e.busy.value,false);
    const [id,snapshot]=[...storage.records][0]!;const broken=structuredClone(snapshot);broken.state.masks[0]!.data=new Uint8Array(1);storage.records.set(id,broken);
    await e.restoreLocalProject(id);assert.ok(e.state.value===state);assert.ok(e.volume.value===volume);assert.ok(e.error.value);assert.equal(e.pendingReplacement.value,null);assert.equal(e.busy.value,false);assert.equal(e.dirty.value,false);
  },{repository:storage.repository});
});

test('unknown image units block 3D until explicit metre/mm/micron confirmation establishes one consistent millimetre grid',async()=>{
  for(const unit of [1,2,3] as const){
    const nativeScale=unit===1?.001:unit===3?1000:1;
    await withEditor(async e=>{
      await e.openFiles([imageFile({unit:0,nativeScale,name:'unknown-units.nii'})]);assert.equal(e.physicalUnitsKnown.value,false);assert.equal(e.volume.value!.unit,'影像单位');
      e.params.lower=100;e.params.upper=100;await nextTick();await e.thresholdPreview();e.applyPreview();const state=e.state.value,source=e.activeMask.value!,nativeAffine=e.volume.value!.affine.map(row=>[...row]),values=e.volume.value!.data,originalHeader=e.volume.value!.header;
      await e.runPart('calculate3d');assert.ok(e.state.value===state);assert.equal(e.state.value.parts.length,0);assert.match(e.error.value,/空间单位/);assert.equal(e.busy.value,false);
      e.spatialUnitChoice.value=unit;e.confirmSpatialUnit();
      assert.equal(e.physicalUnitsKnown.value,true);assert.equal(e.volume.value!.unit,'mm');assert.equal(e.volume.value!.header[123]!&7,unit);assert.equal(originalHeader[123]!&7,0);
      assert.deepEqual(e.volume.value!.affine,nativeAffine,'native affine remains suitable for original-unit NIfTI export');assert.ok(e.volume.value!.data===values);assert.deepEqual(e.activeMask.value!.data,source.data);
      e.volume.value!.spacing.forEach(value=>close(value,1));e.grid.value!.spacing.forEach(value=>close(value,1));
      [[1,0,0,10],[0,1,0,-20],[0,0,1,30]].forEach((row,r)=>row.forEach((value,c)=>close(e.grid.value!.affine![r]![c]!,value)));
      assert.equal(e.dirty.value,true);await e.runPart('calculate3d');assert.equal(e.error.value,'');assert.equal(e.state.value.parts.length,1);
      const stats=meshStats(e.activePart.value!.mesh);assert.equal(stats.closed,true);[10.5,-19.5,30.5].forEach((value,a)=>close(stats.bounds.min[a]!,value));[16.5,-15.5,31.5].forEach((value,a)=>close(stats.bounds.max[a]!,value));
    });
  }
});

test('two-label NIfTI import creates independent masks in one reversible controller transaction',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const before=e.state.value,bytes=await imageFile().arrayBuffer(),view=new DataView(bytes);for(let i=0;i<144;i++)view.setInt16(352+2*i,0,true);
  const label3=[57,58],label9=[86,87];for(const i of label3)view.setInt16(352+2*i,3,true);for(const i of label9)view.setInt16(352+2*i,9,true);
  await e.importMask(bytesFile('two-labels.nii',bytes));assert.equal(e.error.value,'');assert.equal(e.state.value.masks.length,3);assert.equal(hasMembers(e.state.value.masks[0]!.data),false);
  const [first,second]=e.state.value.masks.slice(1);assert.match(first!.name,/标签 3/);assert.match(second!.name,/标签 9/);assert.notEqual(first!.data.buffer,second!.data.buffer);
  assert.deepEqual(first!.data,Uint8Array.from({length:144},(_,i)=>Number(label3.includes(i))));assert.deepEqual(second!.data,Uint8Array.from({length:144},(_,i)=>Number(label9.includes(i))));
  e.clearMask();assert.equal(hasMembers(e.activeMask.value!.data),false);assert.deepEqual(e.state.value.masks[1]!.data,first!.data);
  e.undo();assert.deepEqual(e.activeMask.value!.data,second!.data);e.undo();assert.equal(e.state.value.masks.length,1);assert.deepEqual(e.state.value.masks[0]!.data,before.masks[0]!.data);assert.equal(e.undoName.value,'');
}));

test('Mask import accepts physically equivalent metre and micron headers into a millimetre controller project',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);const original=e.activeMask.value!.data;
  for(const [unit,nativeScale] of [[1,.001],[3,1000]] as const){
    await e.importMask(imageFile({unit,nativeScale,name:`labels-native-${unit}.nii`}));assert.equal(e.error.value,'');assert.equal(e.activeMask.value!.data.reduce((sum,value)=>sum+value,0),5);
    assert.equal(e.volume.value!.header[123]!&7,2,'adding a Mask does not reinterpret the image native unit');
  }
  assert.equal(e.state.value.masks.length,3);assert.ok(e.state.value.masks[0]!.data===original);assert.equal(hasMembers(original),false);assert.deepEqual(e.state.value.masks[1]!.data,e.state.value.masks[2]!.data);
}));

test('Calculate 3D batches two overlapping masks into one reversible transaction and keeps Calculate separate from Close',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.params.thresholdAutoPreview=false;e.params.lower=100;e.params.upper=100;await nextTick();await e.thresholdPreview();e.applyPreview();
  const original=e.activeMask.value!;e.duplicateMask();e.tool.value='paint';e.params.diameter=1;await nextTick();e.brushBegin();e.brushStroke([3,2,1],2,1);e.brushEnd();
  const second=e.activeMask.value!,before=e.state.value,revision=e.revision.value;assert.equal(original.data.reduce((sum,n,i)=>sum+Number(!!n&&!!second.data[i]),0),5,'both masks contain overlapping members');
  const sources=before.masks.map(mask=>({id:mask.id,revision:mask.revision,data:mask.data.slice()}));
  e.openCalculate3D();assert.equal(e.showCalculate3D.value,true);
  await e.calculateParts({maskIds:[original.id,second.id],quality:'custom',step:[1,1,1],topology:'resolved'});
  assert.equal(e.error.value,'');assert.equal(e.state.value.parts.length,2);assert.equal(e.revision.value,revision+1,'the batch commits once');assert.equal(e.showCalculate3D.value,true,'Calculate does not dismiss its dialog');
  assert.equal(e.objectTab.value,'parts');assert.equal(e.renderMode.value,'parts');
  for(const source of sources){const part=e.state.value.parts.find(part=>part.sourceMaskId===source.id);assert.ok(part);assert.equal(part.sourceRevision,source.revision);assert.ok(part.mesh.indices.length>0);assert.equal(meshStats(part.mesh).closed,true);assert.deepEqual(e.state.value.masks.find(mask=>mask.id===source.id)!.data,source.data);}
  const calculated=e.state.value;assert.equal(e.undoName.value,'Calculate 3D');
  e.closeCalculate3D();assert.equal(e.showCalculate3D.value,false);assert.ok(e.state.value===calculated,'Close does not modify the project');
  e.undo();assert.deepEqual(e.state.value,before,'one Undo removes both Parts together');assert.equal(e.state.value.parts.length,0);
  e.undo(true);assert.deepEqual(e.state.value,calculated,'one Redo restores the entire batch');assert.equal(e.state.value.parts.length,2);
}));

test('Calculate 3D publishes no partial batch when a later empty Mask fails and permits a valid retry',async()=>withEditor(async e=>{
  await e.openFiles([imageFile()]);e.params.thresholdAutoPreview=false;e.params.lower=100;e.params.upper=100;await nextTick();await e.thresholdPreview();e.applyPreview();
  const valid=e.activeMask.value!;e.newMask();const empty=e.activeMask.value!;assert.equal(hasMembers(empty.data),false);
  const before=e.state.value,revision=e.revision.value,undo=e.undoName.value,dirty=e.dirty.value;
  e.openCalculate3D();assert.equal(e.showCalculate3D.value,true);
  await e.calculateParts({maskIds:[valid.id,empty.id],quality:'optimal',step:[1,1,1],topology:'native-table'});
  assert.match(e.error.value,/没有可重建的成员/);assert.ok(e.state.value===before,'the earlier valid result must not be published before every selected mask succeeds');
  assert.equal(e.state.value.parts.length,0);assert.equal(e.revision.value,revision);assert.equal(e.undoName.value,undo);assert.equal(e.dirty.value,dirty);assert.equal(e.busy.value,false);assert.equal(e.progress.value,0);assert.equal(e.showCalculate3D.value,true);
  assert.equal(e.state.value.masks.find(mask=>mask.id===valid.id)!.data.reduce((sum,n)=>sum+n,0),5);
  await e.calculateParts({maskIds:[valid.id],quality:'optimal',step:[1,1,1],topology:'native-table'});
  assert.equal(e.error.value,'');assert.equal(e.state.value.parts.length,1);assert.equal(e.showCalculate3D.value,true);assert.equal(e.revision.value,revision+1);
  e.undo();assert.deepEqual(e.state.value,before,'the failed batch contributed no history entry');e.closeCalculate3D();assert.equal(e.showCalculate3D.value,false);
}));
