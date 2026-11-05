import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {effectScope,nextTick} from 'vue';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import {encodeProject,decodeProject} from '../src/mimics/project.ts';
import {meshStats,exportSTL,parseSTL} from '../src/mimics/geometry.ts';

// Exercise the actual worker module and structured-clone boundary without a browser.
// This does not replace WebGL, rendering, picking or pointer-event browser acceptance.
const running=new Set<NodeWorker>();
class WorkerAdapter {
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:((event:{message:string})=>void)|null=null;
  worker:NodeWorker;
  constructor(url:URL){
    const source=`import {parentPort} from 'node:worker_threads'; globalThis.self={postMessage:value=>parentPort.postMessage(value)}; await import(${JSON.stringify(url.href)}); parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(source)));
    running.add(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));
    this.worker.on('error',e=>this.onerror?.({message:e.message}));
    this.worker.on('exit',()=>running.delete(this.worker));
  }
  postMessage(value:unknown){this.worker.postMessage(value);}
  terminate(){void this.worker.terminate();}
}

test('workbench crosses real worker boundaries from preview to surface, STL and project restore with atomic undo',async()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope();const editor=scope.run(()=>useWorkbench())!;
  try {
    editor.demo();editor.params.lower=226;editor.params.upper=650;await nextTick();
    const before=editor.state.value;
    await editor.thresholdPreview();
    assert.equal(editor.error.value,'');assert.ok(editor.preview.value?.some(Boolean));
    assert.equal(editor.state.value,before,'preview must not publish a new project');
    assert.equal(editor.activeMask.value!.data.some(Boolean),false);
    editor.applyPreview();const segmented=editor.activeMask.value!.data;const count=segmented.reduce((s,n)=>s+n,0);
    assert.ok(count>10000);assert.deepEqual(editor.activeMask.value!.threshold,[226,650]);
    editor.undo();assert.equal(editor.activeMask.value!.data.some(Boolean),false);
    editor.undo(true);assert.deepEqual(editor.activeMask.value!.data,segmented);
    await editor.runPart('calculate3d');assert.equal(editor.error.value,'');
    assert.equal(editor.state.value.parts.length,1);const part=editor.activePart.value!;
    const stats=meshStats(part.mesh);assert.ok(stats.closed);assert.equal(stats.nonManifoldEdges,0);assert.ok(stats.volume>0);
    assert.deepEqual(editor.activeMask.value!.data,segmented,'mesh creation cannot alter source mask');
    const stl=exportSTL(part.mesh,{binary:true});assert.ok(stl instanceof Uint8Array);
    assert.equal(stl.length,84+stats.triangles*50);const restoredMesh=parseSTL(stl);
    assert.ok(Math.abs(meshStats(restoredMesh).volume-stats.volume)<.01);
    const restored=decodeProject(encodeProject(editor.volume.value!,editor.state.value));
    assert.deepEqual(restored.state.masks[0].data,segmented);
    assert.deepEqual(restored.state.parts[0].mesh.indices,part.mesh.indices);
    editor.undo();assert.equal(editor.state.value.parts.length,0);
    editor.undo(true);assert.deepEqual(editor.state.value.parts[0].mesh.positions,part.mesh.positions);
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...running].map(w=>w.terminate()));}
});

test('cancel and immediately rerun never lets an old job clear or commit the newer request',async()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),editor=scope.run(()=>useWorkbench())!;
  try{
    editor.demo();editor.params.lower=0;editor.params.upper=1000;await nextTick();
    const first=editor.thresholdPreview();editor.cancel();
    editor.params.lower=120;editor.params.upper=120;await nextTick();
    const second=editor.thresholdPreview();await Promise.all([first,second]);
    assert.equal(editor.error.value,'');assert.ok(editor.preview.value);
    const expected=editor.volume.value!.data.reduce((s,v)=>s+Number(v===120),0);
    assert.equal(editor.preview.value!.reduce((s,v)=>s+v,0),expected);
    assert.equal(editor.activeMask.value!.data.some(Boolean),false);
    editor.applyPreview();assert.equal(editor.activeMask.value!.data.reduce((s,v)=>s+v,0),expected);
    const maskBefore=editor.activeMask.value!.data;
    editor.params.roiMin=[32,32,16];editor.params.roiMax=[64,64,48];
    await editor.runMask('crop','ROI crop',{roi:{min:editor.params.roiMin,max:editor.params.roiMax}});
    assert.equal(editor.error.value,'','Vue proxy ROI options must cross structured-clone safely');
    assert.notEqual(editor.activeMask.value!.data,maskBefore);
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...running].map(w=>w.terminate()));}
});

test('temporary brush selection stays separate, then applies as one reversible mask operation',async()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),editor=scope.run(()=>useWorkbench())!;
  try{
    editor.demo();editor.tool.value='select';await nextTick();
    editor.brushBegin();editor.brushStroke([48,48,32],2,32);editor.brushEnd();
    assert.ok(editor.selection.value?.some(Boolean));assert.equal(editor.activeMask.value!.data.some(Boolean),false);
    await editor.runMask('selection','Apply selection',{operation:'add'});assert.equal(editor.error.value,'');
    assert.deepEqual(editor.activeMask.value!.data,editor.selection.value);
    editor.undo();assert.equal(editor.activeMask.value!.data.some(Boolean),false);
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...running].map(w=>w.terminate()));}
});

test('advanced controller preserves branch geometry and hole-aware contours through worker and project roundtrip',async()=>{
  const previous=globalThis.Worker;(globalThis as any).Worker=WorkerAdapter;
  const scope=effectScope(),editor=scope.run(()=>useWorkbench())!;
  try{
    editor.demo('vessel');editor.params.lower=226;editor.params.upper=400;await nextTick();
    await editor.thresholdPreview();editor.applyPreview();const original=editor.activeMask.value!.data.slice();
    editor.advanced.seeds.value=[[32,28,5],[16,28,55],[48,28,55]];
    await editor.advanced.fit();assert.equal(editor.error.value,'');
    const curve=editor.advanced.activeCenterline.value!;assert.ok(curve.graph.branches.length>=3);
    assert.equal(editor.advanced.seeds.value.length,0,'submitted constraints cease to be a preview chord');
    assert.equal(curve.sourceMaskId,editor.activeMask.value!.id);
    assert.ok(curve.graph.branches.every(b=>b.points.length>=b.controlPointIndices.length));
    await editor.advanced.calculatePolylines();assert.equal(editor.error.value,'');
    assert.equal(editor.advanced.polylines.value.length,1);
    await editor.advanced.fillPolylines();assert.equal(editor.error.value,'');
    assert.equal(editor.state.value.masks.length,2);assert.deepEqual(editor.activeMask.value!.data,original);
    await editor.runPart('calculate3d');assert.equal(editor.error.value,'');
    await editor.advanced.measure();assert.equal(editor.error.value,'');
    assert.ok(editor.advanced.rows.value.some(r=>r.section&&r.section.area>0));
    const restored=decodeProject(encodeProject(editor.volume.value!,editor.state.value));
    assert.deepEqual(restored.state.centerlines![0].graph,curve.graph);
    assert.deepEqual(restored.state.polylines![0].set,editor.advanced.polylines.value[0].set);
    const originalParts=editor.state.value.parts.length;
    editor.advanced.cutAtCrosshair();await editor.advanced.cut();assert.equal(editor.error.value,'');
    assert.equal(editor.state.value.parts.length,originalParts+2);
    for(const part of editor.state.value.parts.slice(-2)){const st=meshStats(part.mesh);assert.ok(st.closed);assert.equal(st.nonManifoldEdges,0);}
    editor.undo();assert.equal(editor.state.value.parts.length,originalParts,'two outputs are one cut transaction');
  }finally{editor.cancel();scope.stop();globalThis.Worker=previous;await Promise.all([...running].map(w=>w.terminate()));}
});
