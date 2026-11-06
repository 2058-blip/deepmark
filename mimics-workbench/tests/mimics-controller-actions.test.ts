import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer,defineComponent,h} from 'vue';
import {useWorkbench} from '../src/mimics/useWorkbench.ts';
import {validateProject} from '../src/mimics/project.ts';

type HostNode={parent:HostNode|null;children:HostNode[];text:string};
const node=(text=''):HostNode=>({parent:null,children:[],text});
const renderer=createRenderer<HostNode,HostNode>({
  patchProp(){},
  insert(child,parent,anchor=null){child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;if(index<0)parent.children.push(child);else parent.children.splice(index,0,child);},
  remove(child){if(child.parent){const siblings=child.parent.children,index=siblings.indexOf(child);if(index>=0)siblings.splice(index,1);}child.parent=null;},
  createElement:()=>node(),createText:text=>node(text),createComment:text=>node(text),
  setText(element,text){element.text=text;},setElementText(element,text){element.text=text;},
  parentNode:element=>element.parent,
  nextSibling:element=>element.parent?.children[element.parent.children.indexOf(element)+1]??null,
});

class WindowEvents extends EventTarget{
  tagName='DIV';isContentEditable=false;
  listeners=new Map<string,Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:boolean|AddEventListenerOptions){
    if(callback){let listeners=this.listeners.get(type);if(!listeners)this.listeners.set(type,listeners=new Set());listeners.add(callback);}
    super.addEventListener(type,callback,options);
  }
  override removeEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:boolean|EventListenerOptions){
    if(callback)this.listeners.get(type)?.delete(callback);super.removeEventListener(type,callback,options);
  }
  press(key:string,shiftKey=false){
    const event=new Event('keydown',{cancelable:true});
    Object.defineProperties(event,{key:{value:key},ctrlKey:{value:true},metaKey:{value:false},shiftKey:{value:shiftKey}});
    this.dispatchEvent(event);return event;
  }
}

type Editor=ReturnType<typeof useWorkbench>;
function withMountedEditor(run:(editor:Editor,events:WindowEvents)=>void){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new WindowEvents(),host=node();let editor!:Editor;
  Object.defineProperty(globalThis,'window',{value:events,writable:true,configurable:true});
  const component=defineComponent({setup(){editor=useWorkbench({repository:null});editor.params.thresholdAutoPreview=false;return()=>h('div');}});
  try{
    renderer.render(h(component),host);
    assert.equal(events.listeners.get('keydown')?.size,1,'real onMounted must install the keyboard handler');
    editor.demo();run(editor,events);
  }finally{
    renderer.render(null,host);
    if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else Reflect.deleteProperty(globalThis,'window');
  }
  assert.equal(events.listeners.get('keydown')?.size,0,'unmount must remove the keyboard handler');
}

test('mounted keyboard Undo and Redo call the same public wrapper used by collaboration',()=>withMountedEditor((editor,events)=>{
  const original=editor.undo,calls:boolean[]=[],id=editor.activeMask.value!.id;
  editor.undo=(redo=false)=>{calls.push(redo);return original(redo);};
  editor.deleteMask();assert.equal(editor.state.value.masks.length,0);
  assert.equal(events.press('z').defaultPrevented,true);assert.equal(editor.activeMask.value?.id,id);
  assert.equal(events.press('y').defaultPrevented,true);assert.equal(editor.state.value.masks.length,0);
  events.press('z');assert.equal(editor.activeMask.value?.id,id);
  events.press('Z',true);assert.equal(editor.state.value.masks.length,0);
  assert.deepEqual(calls,[false,true,false,true]);
}));

test('deleting the last Mask through the public controller can be undone and redone with a valid project',()=>withMountedEditor(editor=>{
  const id=editor.activeMask.value!.id;
  editor.deleteMask();assert.equal(editor.state.value.masks.length,0);assert.equal(editor.state.value.selectedMaskId,'');assert.equal(editor.activeMask.value,undefined);
  validateProject(editor.volume.value!,editor.state.value);
  assert.equal(editor.undo(),true);assert.equal(editor.activeMask.value?.id,id);
  validateProject(editor.volume.value!,editor.state.value);
  assert.equal(editor.undo(true),true);assert.equal(editor.state.value.masks.length,0);assert.equal(editor.state.value.selectedMaskId,'');
  validateProject(editor.volume.value!,editor.state.value);assert.equal(editor.error.value,'');
}));

test('a failed history snapshot during Mask deletion preserves the Mask and shows a visible controller error',()=>withMountedEditor(editor=>{
  editor.state.value={...editor.state.value,polylines:[]};
  const before=editor.state.value,revision=editor.revision.value,id=editor.activeMask.value!.id,clone=globalThis.structuredClone;
  try{
    globalThis.structuredClone=()=>{throw new Error('synthetic delete snapshot failure');};
    assert.doesNotThrow(()=>editor.deleteMask());
  }finally{globalThis.structuredClone=clone;}
  assert.equal(editor.state.value,before);assert.equal(editor.activeMask.value?.id,id);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,'');
  assert.match(editor.error.value,/delete snapshot failure/);assert.equal(editor.status.value,editor.error.value);
  editor.deleteMask();assert.equal(editor.state.value.masks.length,0);assert.equal(editor.error.value,'');assert.equal(editor.undo(),true);assert.equal(editor.activeMask.value?.id,id);
}));

test('the public controller catches failed Undo and Redo snapshots without changing committed objects or history',()=>withMountedEditor(editor=>{
  editor.state.value={...editor.state.value,polylines:[]};
  const id=editor.activeMask.value!.id,baseline=editor.activeMask.value!.name;
  editor.updateMask(id,{name:'later name'});
  for(const redo of [false,true]){
    const before=editor.state.value,revision=editor.revision.value,undo=editor.undoName.value,future=editor.redoName.value,dirty=editor.dirty.value,clone=globalThis.structuredClone;
    try{
      globalThis.structuredClone=()=>{throw new Error('synthetic controller history failure');};
      assert.equal(editor.undo(redo),false);
    }finally{globalThis.structuredClone=clone;}
    assert.equal(editor.state.value,before);assert.equal(editor.revision.value,revision);assert.equal(editor.undoName.value,undo);assert.equal(editor.redoName.value,future);assert.equal(editor.dirty.value,dirty);
    assert.match(editor.error.value,/controller history failure/);assert.equal(editor.status.value,editor.error.value);
    assert.equal(editor.undo(redo),true);assert.equal(editor.activeMask.value!.name,redo?'later name':baseline);assert.equal(editor.error.value,'');
  }
}));
