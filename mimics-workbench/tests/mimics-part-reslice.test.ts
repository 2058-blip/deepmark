import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import ts from 'typescript';
import {effectScope,reactive,proxyRefs,nextTick} from 'vue';
import {createMprPlane} from '../src/mimics/mpr.ts';
import {reslicePlaneFrame} from '../src/mimics/resliceGizmo.ts';
import type {Vec3} from '../src/mimics/types.ts';

// Production SFC handlers and SVG with CSS/capture fakes. No browser/WebGL evidence.
async function component(){
  const url=new URL('../src/mimics/PartViewport.vue',import.meta.url),descriptor=parse(await readFile(url,'utf8'),{filename:url.pathname}).descriptor;
  const script=compileScript(descriptor,{id:'part-reslice-test'}),template=compileTemplate({source:descriptor.template!.content,filename:url.pathname,id:'part-reslice-test',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);
  const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(_all,q,spec)=>`from ${q}${spec.startsWith('.')?new URL(spec,url).href:import.meta.resolve(spec)}${q}`);
  const load=(code:string)=>import(`data:text/javascript;base64,${Buffer.from(compile(code)).toString('base64')}`),c=(await load(script.content)).default;c.render=(await load(template.code)).render;return c;
}
const ready=component();
function quiet<T>(fn:()=>T):T{const warn=console.warn;console.warn=(message,...args)=>{if(!/^\[Vue warn\]: (on(Mounted|BeforeUnmount) is called|withDirectives can only be used inside render functions\.)/.test(String(message)))warn(message,...args);};try{return fn();}finally{console.warn=warn;}}
async function harness(withParts=false){
  const c=await ready,scope=effectScope(),old={window:globalThis.window,requestAnimationFrame:globalThis.requestAnimationFrame};(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;
  const mesh=(z:number)=>({positions:new Float32Array([-10,-10,z,10,-10,z,10,10,z,-10,10,z]),indices:new Uint32Array([0,1,2,0,2,3])});
  const props:any=reactive({parts:withParts?[{id:'A',name:'A',mesh:mesh(0),visible:true,opacity:1,color:'#fff'},{id:'B',name:'B',mesh:mesh(5),visible:true,opacity:1,color:'#fff'}]:[],measurements:[],volume:{name:'world'},revision:7,tool:'navigate',allowEdit:true,reslicePlane:createMprPlane({center:[0,0,1],size:[8,6],pixelSpacing:[1,1]}),resliceId:'rp-1',resliceRevision:23,resliceMode:'rotate'}),events:{name:string;args:any[]}[]=[];
  const view=quiet(()=>scope.run(()=>c.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}}))),captures=new Set<number>(),element={focus:()=>{},setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture:(id:number)=>captures.delete(id)};
  view.canvas.value={...element,getBoundingClientRect:()=>({left:0,top:0,width:500,height:400})};view.host.value={getBoundingClientRect:()=>({width:500,height:400})};view.resize();view.preset('front');view.fit();
  const pointer=(world:Vec3,type='pointermove',extra:Record<string,unknown>={})=>{const [clientX,clientY]=view.project(world);return{pointerId:1,button:0,buttons:type==='pointerup'?0:1,type,clientX,clientY,currentTarget:element,stopPropagation:()=>{},preventDefault:()=>{},...extra};};
  return{view,props,events,captures,pointer,render:()=>quiet(()=>c.render({},[],props,proxyRefs(view),{},{})),close:()=>{scope.stop();Object.assign(globalThis,old);}};
}
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`),point=(a:readonly number[],b:readonly number[])=>{assert.equal(a.length,b.length);a.forEach((n,k)=>near(n,b[k]!));};
const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[];
const updates=(h:Awaited<ReturnType<typeof harness>>)=>h.events.filter(e=>e.name==='updateReslicePlane');

test('selected RP renders and fits its full physical support without a Part, and view mode passes through',async()=>{
  const h=await harness();try{
    h.props.resliceMode='view';const shown=h.view.projectedReslice.value;assert.equal(shown.handles.length,0);point(shown.center,[250,200]);
    for(const p of shown.corners){assert.ok(p[0]>0&&p[0]<500);assert.ok(p[1]>0&&p[1]<400);}
    point(h.view.sceneBounds().min,[-4,-3,1]);point(h.view.sceneBounds().max,[4,3,1]);
    const nodes=walk(h.render()),rp=nodes.find(n=>n.props?.['aria-label']==='选中的三维 RP 平面');assert.ok(rp);assert.equal(rp.props.style['pointer-events'],'none');assert.equal(nodes.some(n=>n.props?.class==='empty-view'),false);assert.equal(nodes.filter(n=>n.props?.['data-reslice-handle']).length,0);
  }finally{h.close();}
});

test('RP Rotate exposes center and normal-axis corner handles; Resize exposes red border, side/corner dots and double arrows',async()=>{
  const h=await harness();try{
    let nodes=walk(h.render()),handles=nodes.filter(n=>n.props?.['data-reslice-handle']);assert.equal(handles.length,5);assert.equal(handles.filter(n=>String(n.props['aria-label']).includes('平面法线旋转')).length,4);
    h.props.resliceMode='resize';nodes=walk(h.render());handles=nodes.filter(n=>n.props?.['data-reslice-handle']);assert.equal(handles.length,9);assert.ok(nodes.some(n=>String(n.props?.class).includes('reslice-resize')));assert.equal(handles.find(n=>n.props['data-reslice-handle']==='u+').props.style.cursor,'ew-resize');assert.equal(handles.find(n=>n.props['data-reslice-handle']==='v+').props.style.cursor,'ns-resize');
    const source=await readFile(new URL('../src/mimics/PartViewport.vue',import.meta.url),'utf8');assert.match(source,/\.reslice-resize \.reslice-plane-border\{stroke:#ff625a/);
    for(const mutation of ['busy','tool','id']){if(mutation==='busy')h.props.allowEdit=false;else if(mutation==='tool'){h.props.allowEdit=true;h.props.tool='paint';}else{h.props.tool='navigate';h.props.resliceId=undefined;}assert.equal(h.view.projectedReslice.value.handles.length,0);}
  }finally{h.close();}
});

test('RP center drag previews locally without refitting or mesh snapping, then emits one captured drop',async()=>{
  const h=await harness(true);try{
    const original=h.props.reslicePlane,frozen=JSON.stringify(original),before=h.view.project([0,0,1]);h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');assert.equal(h.captures.size,1);
    h.view.moveMeasurementHandle(h.pointer([2,-1,1]));point(reslicePlaneFrame(h.view.temporaryReslicePlane.value).center,[2,-1,1]);assert.equal(h.events.length,0);point(h.view.project([0,0,1]),before);assert.equal(JSON.stringify(original),frozen);
    h.view.endMeasurementHandle(h.pointer([2,-1,1],'pointerup'));assert.equal(updates(h).length,1);const change=updates(h)[0]!.args[0];point(reslicePlaneFrame(change.plane).center,[2,-1,1]);assert.equal(change.id,'rp-1');assert.equal(change.action,'move');assert.equal(change.volume,h.props.volume);assert.equal(change.revision,7);assert.equal(change.resliceRevision,23);assert.equal('partId'in change,false);assert.equal(h.captures.size,0);assert.equal(h.view.temporaryReslicePlane.value,undefined);assert.equal(JSON.stringify(original),frozen);
    h.view.endMeasurementHandle(h.pointer([3,2,1],'pointerup'));assert.equal(updates(h).length,1);
  }finally{h.close();}
});

test('RP corner drag rotates around its own physical normal while preserving center, dimensions and sample count',async()=>{
  const h=await harness();try{
    h.view.startResliceHandle(h.pointer([4,3,1],'pointerdown'),'rotate++');h.view.endMeasurementHandle(h.pointer([-3,4,1],'pointerup'));assert.equal(updates(h)[0]!.args[0].action,'rotate');const plane=updates(h)[0]!.args[0].plane,frame=reslicePlaneFrame(plane);point(frame.center,[0,0,1]);point(frame.u,[0,1,0]);point(frame.v,[-1,0,0]);point(frame.normal,[0,0,1]);near(frame.width,8);near(frame.height,6);assert.deepEqual(plane.size,[8,6]);
  }finally{h.close();}
});

test('RP Resize side and corner drags change physical field of view symmetrically without resampling size',async()=>{
  for(const [id,start,end,width,height] of [['u+',[4,0,1],[6,0,1],12,6],['corner++',[4,3,1],[5,5,1],10,10]] as const){
    const h=await harness();try{h.props.resliceMode='resize';const frozen=JSON.stringify(h.props.reslicePlane);h.view.startResliceHandle(h.pointer([...start],'pointerdown'),id);h.view.endMeasurementHandle(h.pointer([...end],'pointerup'));assert.equal(updates(h)[0]!.args[0].action,'resize');const plane=updates(h)[0]!.args[0].plane,frame=reslicePlaneFrame(plane);point(frame.center,[0,0,1]);point(frame.u,[1,0,0]);point(frame.v,[0,1,0]);near(frame.width,width);near(frame.height,height);assert.deepEqual(plane.size,[8,6]);assert.equal(JSON.stringify(h.props.reslicePlane),frozen);}finally{h.close();}
  }
});

test('RP drag intersects the frozen oblique plane in physical space independently of all Part surfaces',async()=>{
  const h=await harness(true);try{
    h.props.reslicePlane=createMprPlane({center:[0,0,0],size:[8,6],pixelSpacing:[1,1],normal:[-1,0,1],up:[0,1,0]});const normal=reslicePlaneFrame(h.props.reslicePlane).normal;h.view.startResliceHandle(h.pointer([0,0,0],'pointerdown'),'center');h.view.endMeasurementHandle(h.pointer([1,2,1],'pointerup'));const frame=reslicePlaneFrame(updates(h)[0]!.args[0].plane);point(frame.center,[1,2,1]);point(frame.normal,normal);
  }finally{h.close();}
});

test('RP edits cancel on document, revision, selected object, pose epoch, frame, mode, tool or busy changes',async()=>{
  for(const mutation of ['volume','revision','id','resliceRevision','object','origin','u','v','size','mode','tool','busy']){
    const h=await harness();try{h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');h.view.moveMeasurementHandle(h.pointer([1,1,1]));
      if(mutation==='volume')h.props.volume={name:'other'};else if(mutation==='revision')h.props.revision++;else if(mutation==='id')h.props.resliceId='rp-other';else if(mutation==='resliceRevision')h.props.resliceRevision++;else if(mutation==='object')h.props.reslicePlane=structuredClone(JSON.parse(JSON.stringify(h.props.reslicePlane)));else if(mutation==='origin')h.props.reslicePlane.origin[0]++;else if(mutation==='u')h.props.reslicePlane.u[0]*=2;else if(mutation==='v')h.props.reslicePlane.v[1]*=2;else if(mutation==='size')h.props.reslicePlane.size[0]++;else if(mutation==='mode')h.props.resliceMode='resize';else if(mutation==='tool')h.props.tool='select';else h.props.allowEdit=false;
      assert.equal(h.view.temporaryReslicePlane.value,undefined,mutation);h.view.endMeasurementHandle(h.pointer([2,2,1],'pointerup'));assert.equal(updates(h).length,0,mutation);assert.equal(h.captures.size,0,mutation);
    }finally{h.close();}
  }
});

test('RP edits cancel on Escape, pointer cancellation, capture loss, button loss and camera controls',async()=>{
  for(const cancel of ['escape','pointercancel','lostpointercapture','buttons','wheel','fit','preset','resize']){
    const h=await harness();try{h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');h.view.moveMeasurementHandle(h.pointer([1,1,1]));
      if(cancel==='escape')h.view.measurementKey({key:'Escape',stopPropagation:()=>{},preventDefault:()=>{}});else if(cancel==='buttons')h.view.moveMeasurementHandle(h.pointer([2,2,1],'pointermove',{buttons:0}));else if(cancel==='wheel')h.view.wheel({deltaY:10,preventDefault:()=>{}});else if(cancel==='fit')h.view.fit();else if(cancel==='preset')h.view.preset('iso');else if(cancel==='resize')h.view.resize();else h.view.endMeasurementHandle(h.pointer([2,2,1],cancel));
      h.view.endMeasurementHandle(h.pointer([2,2,1],'pointerup'));assert.equal(updates(h).length,0,cancel);assert.equal(h.view.temporaryReslicePlane.value,undefined,cancel);assert.equal(h.captures.size,0,cancel);
    }finally{h.close();}
  }
});

test('RP click or a completed round trip emits nothing, and an unrelated pointer cannot complete a drag',async()=>{
  const h=await harness();try{
    h.view.startResliceHandle(h.pointer([4,3,1],'pointerdown'),'rotate++');h.view.endMeasurementHandle(h.pointer([4,3,1],'pointerup'));assert.equal(updates(h).length,0);
    h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');h.view.moveMeasurementHandle(h.pointer([1,1,1]));h.view.endMeasurementHandle(h.pointer([2,2,1],'pointerup',{pointerId:9}));assert.equal(h.captures.size,1);assert.equal(updates(h).length,0);h.view.endMeasurementHandle(h.pointer([0,0,1],'pointerup'));assert.equal(updates(h).length,0);assert.equal(h.captures.size,0);
  }finally{h.close();}
});

test('RP Resize preserves the initial hit-area grab offset so an off-center click neither jumps nor dirties',async()=>{
  const h=await harness();try{
    h.props.resliceMode='resize';h.view.startResliceHandle(h.pointer([4.2,.1,1],'pointerdown'),'u+');h.view.endMeasurementHandle(h.pointer([4.2,.1,1],'pointerup'));assert.equal(updates(h).length,0);
    h.view.startResliceHandle(h.pointer([4.2,.1,1],'pointerdown'),'u+');h.view.endMeasurementHandle(h.pointer([6.2,.1,1],'pointerup'));const frame=reslicePlaneFrame(updates(h)[0]!.args[0].plane);near(frame.width,12);near(frame.height,6);point(frame.center,[0,0,1]);
  }finally{h.close();}
});

test('RP edge-on or invalid planes refuse capture and view mode preserves ordinary Part picking',async()=>{
  const h=await harness(true);try{
    h.view.preset('top');h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');assert.equal(h.captures.size,0);assert.equal(h.view.temporaryReslicePlane.value,undefined);
    h.view.preset('front');h.props.reslicePlane.u=[0,0,0];assert.equal(h.view.projectedReslice.value,undefined);h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');assert.equal(h.captures.size,0);
    h.props.reslicePlane=createMprPlane({center:[0,0,1],size:[8,6],pixelSpacing:[1,1]});h.props.resliceMode='view';h.view.down(h.pointer([0,0,5],'pointerdown'));h.view.up(h.pointer([0,0,5],'pointerup'));assert.equal(h.events.find(e=>e.name==='pick')!.args[0].partId,'B');assert.equal(updates(h).length,0);
  }finally{h.close();}
});

test('RP external selection fits an empty scene, explicit fit includes distant RP and Parts, and preview never auto-fits',async()=>{
  const h=await harness();try{
    h.props.reslicePlane=createMprPlane({center:[40,20,10],size:[8,6],pixelSpacing:[1,1]});h.props.resliceId='other';await nextTick();point(h.view.projectedReslice.value.center,[250,200]);
    const before=h.view.project([40,20,10]);h.view.startResliceHandle(h.pointer([40,20,10],'pointerdown'),'center');h.view.moveMeasurementHandle(h.pointer([41,21,10]));await nextTick();point(h.view.project([40,20,10]),before);h.view.clearResliceDrag();h.props.reslicePlane=undefined;h.props.resliceId='';await nextTick();assert.equal(h.view.projectedReslice.value,undefined);point(h.view.sceneBounds().min,[-1,-1,-1]);point(h.view.project([0,0,0]),[250,200]);
  }finally{h.close();}
  const h2=await harness(true);try{h2.props.reslicePlane=createMprPlane({center:[70,0,1],size:[8,6],pixelSpacing:[1,1]});h2.view.fit();for(const corner of reslicePlaneFrame(h2.props.reslicePlane).corners){const p=h2.view.project(corner);assert.ok(p[0]>0&&p[0]<500);assert.ok(p[1]>0&&p[1]<400);}point(h2.view.project([32,0,2.5]),[250,200]);h2.props.reslicePlane=undefined;h2.props.resliceId='';h2.view.fit();assert.equal(h2.view.projectedReslice.value,undefined);point(h2.view.project([0,0,0]),[250,200]);}finally{h2.close();}
});

test('RP committed echo and revision update preserve the camera after a local drop',async()=>{
  const h=await harness();try{
    const before=h.view.project([0,0,1]);h.view.startResliceHandle(h.pointer([0,0,1],'pointerdown'),'center');h.view.endMeasurementHandle(h.pointer([2,1,1],'pointerup'));
    h.props.reslicePlane=updates(h)[0]!.args[0].plane;h.props.revision++;h.props.resliceRevision++;await nextTick();point(h.view.project([0,0,1]),before);point(reslicePlaneFrame(h.props.reslicePlane).center,[2,1,1]);
  }finally{h.close();}
});
