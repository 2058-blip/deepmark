import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSSRApp} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {useEditor} from '../src/useEditor.ts';
import type {Change,Volume} from '../src/core.ts';

async function editorFixture(){
  let editor!:ReturnType<typeof useEditor>;
  await renderToString(createSSRApp({setup(){editor=useEditor();return ()=>null;}}));
  const volume:Volume={name:'touch-fixture',dims:[5,5,1],spacing:[1,1,1],data:new Float32Array(25).fill(40),header:new Uint8Array(348),little:true,min:40,max:40,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],oblique:false,unit:'mm'};
  editor.install(volume);editor.diameter.value=1;return editor;
}
test('cancelled collaborative paint restores the combined display, not the personal before value',async()=>{
  const editor=await editorFixture(),changes:Change[]=[];editor.setChangeHandler(change=>changes.push(change));editor.setPersonalValueHandler(()=>null);editor.mask.value.fill(2);
  editor.startStroke('touch');editor.stroke(2,0,2,2);assert.equal(editor.mask.value[12],1);assert.equal(editor.pendingChange()!.before[0],0);
  editor.cancelStroke();assert.equal(editor.mask.value[12],2);assert.equal(editor.pendingChange(),null);assert.equal(editor.strokeActive.value,false);assert.equal(changes.length,0);assert.equal(editor.history.value.length,0);assert.equal(editor.dirty.value,false);
});
test('cancelled deferred erasure preserves another displayed opinion even when the personal opinion differs',async()=>{
  const editor=await editorFixture();editor.setChangeHandler(()=>assert.fail('cancel must not broadcast'));editor.setPersonalValueHandler(()=>1);editor.setDisplayValueHandler(()=>2);editor.mask.value.fill(2);editor.tool.value='erase';
  editor.startStroke('touch');editor.stroke(2,0,2,2);assert.equal(editor.pendingChange()!.before[0],1);assert.equal(editor.mask.value[12],2);editor.cancelStroke();assert.equal(editor.mask.value[12],2);
});
test('cancelling after a remote refresh keeps the latest combined baseline and does not change original transaction ownership',async()=>{
  const editor=await editorFixture();editor.setChangeHandler(()=>assert.fail('cancel must not broadcast'));editor.setPersonalValueHandler(()=>null);editor.mask.value.fill(2);
  editor.startStroke('touch');editor.stroke(2,0,2,2);const preview=editor.pendingDisplayChange()!;
  editor.restorePendingBase();assert.equal(editor.mask.value[12],2);editor.mask.value[12]=3;editor.rebasePending(editor.mask.value);preview.indices.forEach((index,k)=>editor.mask.value[index]=preview.after[k]);
  assert.equal(editor.pendingChange()!.before[0],0);editor.cancelStroke();assert.equal(editor.mask.value[12],3);
});
test('touch snapshots use the baseline and interruption cancels while an explicit pen completion remains undoable',async()=>{
  const editor=await editorFixture(),changes:Change[]=[];editor.setChangeHandler(change=>changes.push(change));editor.setPersonalValueHandler(()=>null);editor.mask.value.fill(2);
  editor.startStroke('touch');editor.stroke(2,0,2,2);assert.equal(editor.isInterruptibleStroke(),true);const snapshot=editor.mask.value.slice();editor.restorePendingBase(snapshot);assert.equal(snapshot[12],2);assert.equal(editor.mask.value[12],1);
  editor.interruptStroke();assert.equal(changes.length,0);assert.equal(editor.mask.value[12],2);
  editor.startStroke('pen');editor.stroke(2,0,2,2);editor.interruptStroke();assert.equal(changes.length,1);assert.equal(editor.history.value.length,1);assert.equal(editor.mask.value[12],1);
});
