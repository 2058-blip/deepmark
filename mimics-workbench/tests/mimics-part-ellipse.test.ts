import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import ts from 'typescript';
import {effectScope,reactive,proxyRefs} from 'vue';
import type {Vec3} from '../src/mimics/types.ts';

// Production SFC handlers and SVG, with a CSS/capture fake. This is not browser/WebGL evidence.
async function component(){
  const url=new URL('../src/mimics/PartViewport.vue',import.meta.url),descriptor=parse(await readFile(url,'utf8'),{filename:url.pathname}).descriptor;
  const script=compileScript(descriptor,{id:'part-ellipse-test'}),template=compileTemplate({source:descriptor.template!.content,filename:url.pathname,id:'part-ellipse-test',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);
  const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(_all,q,spec)=>`from ${q}${spec.startsWith('.')?new URL(spec,url).href:import.meta.resolve(spec)}${q}`);
  const load=(code:string)=>import(`data:text/javascript;base64,${Buffer.from(compile(code)).toString('base64')}`),c=(await load(script.content)).default;c.render=(await load(template.code)).render;return c;
}
const ready=component();
function quiet<T>(fn:()=>T):T{const warn=console.warn;console.warn=(message,...args)=>{if(!/^\[Vue warn\]: (on(Mounted|BeforeUnmount) is called|withDirectives can only be used inside render functions\.)/.test(String(message)))warn(message,...args);};try{return fn();}finally{console.warn=warn;}}
async function harness(){
  const c=await ready,scope=effectScope(),old={window:globalThis.window,requestAnimationFrame:globalThis.requestAnimationFrame};(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;
  const mesh=(z:number)=>({positions:new Float32Array([-10,-10,z,10,-10,z,10,10,z,-10,10,z]),indices:new Uint32Array([0,1,2,0,2,3])});
  const props:any=reactive({parts:[{id:'A',name:'A',mesh:mesh(0),visible:true,opacity:1,color:'#fff'},{id:'B',name:'B',mesh:mesh(5),visible:true,opacity:1,color:'#fff'}],measurements:[{id:'ellipse',name:'ellipse',kind:'ellipse',points:[[-3,0,1],[3,0,1],[1,2,1]],pointPartIds:['A','B',null],visible:true,color:'#ffdf7a'}],volume:{name:'world'},revision:7,tool:'navigate',allowEdit:true,selectedMeasurementId:'ellipse',measurementLabels:{ellipse:'18.85 mm²'}}),events:{name:string;args:any[]}[]=[];
  const view=quiet(()=>scope.run(()=>c.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}}))),captures=new Set<number>(),element={focus:()=>{},setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture:(id:number)=>captures.delete(id)};
  view.canvas.value={...element,getBoundingClientRect:()=>({left:0,top:0,width:500,height:400})};view.host.value={getBoundingClientRect:()=>({width:500,height:400})};view.resize();view.preset('front');view.fit();
  const pointer=(world:Vec3,type='pointermove',extra:Record<string,unknown>={})=>{const [clientX,clientY]=view.project(world);return{pointerId:1,button:0,buttons:type==='pointerup'?0:1,type,clientX,clientY,currentTarget:element,stopPropagation:()=>{},preventDefault:()=>{},...extra};};
  return{view,props,events,captures,pointer,render:()=>quiet(()=>c.render({},[],props,proxyRefs(view),{},{})),close:()=>{scope.stop();Object.assign(globalThis,old);}};
}
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`),point=(a:readonly number[],b:readonly number[])=>a.forEach((n,k)=>near(n,b[k]!)),points=(a:readonly Vec3[],b:readonly Vec3[])=>{assert.equal(a.length,b.length);a.forEach((p,k)=>point(p,b[k]!));};
const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[];

test('Part ellipse SVG exposes four actual axis endpoints, a center and four bounding-corner rotation handles',async()=>{
  const h=await harness();try{const m=h.view.projectedMeasurements.value[0];assert.equal(m.handles.length,0,'raw third point is not an ellipse control handle');assert.equal(m.ellipseHandles.length,9);point(m.ellipseHandles.find((p:any)=>p.id==='v+').point,h.view.project([0,2,1]));assert.notDeepEqual(m.ellipseHandles.find((p:any)=>p.id==='v+').point,h.view.project([1,2,1]));
    const nodes=walk(h.render()),handles=nodes.filter(n=>n.props?.['data-handle']);assert.equal(handles.length,9);assert.equal(handles.filter(n=>String(n.props['aria-label']).includes('角点旋转')).length,4);assert.ok(nodes.some(n=>n.props?.class==='ellipse-box'));h.props.tool='paint';assert.ok(walk(h.render()).filter(n=>n.props?.['data-handle']).every(n=>n.props.style.pointerEvents==='none'));
  }finally{h.close();}
});

test('Part ellipse resize uses its plane across mixed Part sources and emits one canonical batch with read-only metric preview',async()=>{
  const h=await harness();try{const original=h.props.measurements[0],frozen=JSON.stringify(original);h.view.startEllipseHandle(h.pointer([0,2,1],'pointerdown'),'ellipse','v+');h.view.moveMeasurementHandle(h.pointer([0,4,1]));
    points(h.view.temporaryGeometry.value.points,[[-3,0,1],[3,0,1],[0,4,1]]);const preview=h.events.filter(e=>e.name==='previewMeasurementGeometry').at(-1)!.args[0];assert.equal(preview.volume,h.props.volume);assert.equal(preview.revision,7);assert.match(h.view.projectedMeasurements.value[0].label,/D1 8\.00 mm · D2 6\.00 mm/);assert.match(h.view.projectedMeasurements.value[0].label,/A 37\.70 mm²/);assert.equal(JSON.stringify(original),frozen,'preview does not mutate geometry or sources');assert.equal(h.events.some(e=>e.name==='updateMeasurementGeometry'),false);
    h.view.endMeasurementHandle(h.pointer([0,4,1],'pointerup'));const updates=h.events.filter(e=>e.name==='updateMeasurementGeometry');assert.equal(updates.length,1);points(updates[0]!.args[0].points,[[-3,0,1],[3,0,1],[0,4,1]]);assert.equal(updates[0]!.args[0].volume,h.props.volume);assert.equal(updates[0]!.args[0].revision,7);assert.equal('pointPartIds'in updates[0]!.args[0],false,'controller retains original per-point ancestry');assert.equal(h.events.filter(e=>e.name==='previewMeasurementGeometry').at(-1)!.args[0],null);assert.equal(h.events.some(e=>e.name==='moveMeasurementPoint'),false);assert.equal(h.captures.size,0);assert.equal(JSON.stringify(original),frozen);
  }finally{h.close();}
});

test('Part ellipse center and corner gestures translate or rotate all three points without surface snapping',async()=>{
  const h=await harness();try{
    h.view.startEllipseHandle(h.pointer([0,0,1],'pointerdown'),'ellipse','center');h.view.endMeasurementHandle(h.pointer([2,-1,1],'pointerup'));points(h.events.find(e=>e.name==='updateMeasurementGeometry')!.args[0].points,[[-1,-1,1],[5,-1,1],[2,1,1]]);
    h.events.length=0;h.view.startEllipseHandle(h.pointer([3,2,1],'pointerdown'),'ellipse','rotate++');h.view.endMeasurementHandle(h.pointer([-2,3,1],'pointerup'));points(h.events.find(e=>e.name==='updateMeasurementGeometry')!.args[0].points,[[0,-3,1],[0,3,1],[-2,0,1]]);
    h.events.length=0;h.view.startEllipseHandle(h.pointer([0,2,1],'pointerdown'),'ellipse','v+');h.view.endMeasurementHandle(h.pointer([0,2,1],'pointerup'));assert.equal(h.events.some(e=>e.name==='updateMeasurementGeometry'),false,'selecting an off-axis legacy ellipse does not canonicalize or dirty it');
  }finally{h.close();}
});

test('Part ellipse plane is physical and oblique rather than a fixed world slice or any source mesh',async()=>{
  const h=await harness();try{h.props.measurements=[{...h.props.measurements[0],points:[[-3,0,-3],[3,0,3],[2,2,2]]}];h.view.startEllipseHandle(h.pointer([0,0,0],'pointerdown'),'ellipse','center');h.view.endMeasurementHandle(h.pointer([1,2,1],'pointerup'));points(h.events.find(e=>e.name==='updateMeasurementGeometry')!.args[0].points,[[-2,2,-2],[4,2,4],[1,4,1]]);
  }finally{h.close();}
});

test('Part label drag emits world-relative displacement, preserves geometry and uses a captured document epoch',async()=>{
  const h=await harness();try{h.props.measurements[0].labelOffset=[1,2,3];const frozen=JSON.stringify(h.props.measurements[0]);h.view.startLabelDrag(h.pointer([1,2,4],'pointerdown'),'ellipse');h.view.moveMeasurementHandle(h.pointer([3,1,4]));point(h.view.temporaryLabel.value.offset,[3,1,3]);assert.equal(h.events.some(e=>e.name==='updateMeasurementLabel'),false);h.view.endMeasurementHandle(h.pointer([3,1,4],'pointerup'));
    const update=h.events.find(e=>e.name==='updateMeasurementLabel')!.args[0];point(update.offset,[3,1,3]);assert.equal(update.id,'ellipse');assert.equal(update.volume,h.props.volume);assert.equal(update.revision,7);assert.equal(JSON.stringify(h.props.measurements[0]),frozen);assert.equal(h.events.some(e=>e.name==='updateMeasurementGeometry'||e.name==='moveMeasurementPoint'),false);assert.equal(h.captures.size,0);
  }finally{h.close();}
});

test('Part ellipse or label gestures cancel on stale document, collection, nested geometry, sources, busy state or tool',async()=>{
  for(const label of [false,true])for(const mutation of ['volume','revision','collection','point','source','offset','hidden','busy','tool']){
    const h=await harness();try{if(label)h.view.startLabelDrag(h.pointer([0,0,1],'pointerdown'),'ellipse');else h.view.startEllipseHandle(h.pointer([0,0,1],'pointerdown'),'ellipse','center');h.view.moveMeasurementHandle(h.pointer([1,1,1]));
      if(mutation==='volume')h.props.volume={name:'replacement'};else if(mutation==='revision')h.props.revision++;else if(mutation==='collection')h.props.measurements=[...h.props.measurements];else if(mutation==='point')h.props.measurements[0].points[0][0]++;else if(mutation==='source')h.props.measurements[0].pointPartIds[0]='B';else if(mutation==='offset')h.props.measurements[0].labelOffset=[2,3,4];else if(mutation==='hidden')h.props.parts[0].visible=false;else if(mutation==='busy')h.props.allowEdit=false;else h.props.tool='paint';
      h.view.endMeasurementHandle(h.pointer([2,2,1],'pointerup'));assert.equal(h.events.some(e=>e.name==='updateMeasurementGeometry'||e.name==='updateMeasurementLabel'),false,`${label?'label':'ellipse'} ${mutation}`);assert.equal(h.view.temporaryGeometry.value,undefined);assert.equal(h.view.temporaryLabel.value,undefined);assert.equal(h.captures.size,0);if(!label)assert.equal(h.events.filter(e=>e.name==='previewMeasurementGeometry').at(-1)!.args[0],null);
    }finally{h.close();}
  }
});

test('Part aggregate gestures cancel on Escape, capture loss, pointer cancellation or primary button loss',async()=>{
  for(const label of [false,true])for(const cancel of ['pointercancel','lostpointercapture','escape','buttons']){const h=await harness();try{
    if(label)h.view.startLabelDrag(h.pointer([0,0,1],'pointerdown'),'ellipse');else h.view.startEllipseHandle(h.pointer([0,0,1],'pointerdown'),'ellipse','center');h.view.moveMeasurementHandle(h.pointer([1,1,1]));
    if(cancel==='escape')h.view.measurementKey({key:'Escape',stopPropagation:()=>{},preventDefault:()=>{}});else if(cancel==='buttons')h.view.moveMeasurementHandle(h.pointer([2,2,1],'pointermove',{buttons:0}));else h.view.endMeasurementHandle(h.pointer([2,2,1],cancel));h.view.endMeasurementHandle(h.pointer([2,2,1],'pointerup'));assert.equal(h.events.some(e=>e.name==='updateMeasurementGeometry'||e.name==='updateMeasurementLabel'),false,`${label?'label':'ellipse'} ${cancel}`);assert.equal(h.captures.size,0);
  }finally{h.close();}}
});

test('Part area point preview uses the existing evaluator for geometry metrics and clears without committing on cancel',async()=>{
  const h=await harness();try{h.props.measurements=[{id:'area',name:'area',kind:'area',points:[[0,0,0],[6,0,0],[6,4,0],[0,4,0]],pointPartIds:['A','A','A','A'],color:'#fff',visible:true}];h.view.startMeasurementHandle(h.pointer([0,0,0],'pointerdown'),'area',0);h.view.moveMeasurementHandle(h.pointer([1,0,0]));const label=h.view.projectedMeasurements.value[0].label;assert.match(label,/A 22\.00 mm² · P 19\.12 mm/);assert.match(label,/Da 5\.29 mm/);assert.ok(h.events.some(e=>e.name==='previewMeasurementGeometry'&&e.args[0]?.id==='area'));h.view.endMeasurementHandle(h.pointer([1,0,0],'pointercancel'));assert.equal(h.events.filter(e=>e.name==='previewMeasurementGeometry').at(-1)!.args[0],null);assert.equal(h.events.some(e=>e.name==='moveMeasurementPoint'),false);
  }finally{h.close();}
});

test('Part staged ellipse first two clicks are actual mesh hits and hover only previews an explicit provisional ellipse',async()=>{
  const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[];h.props.measurementDraftToken=10;
    h.view.down(h.pointer([-3,0,5],'pointerdown'));h.view.up(h.pointer([-3,0,5],'pointerup'));
    const first=h.events.find(e=>e.name==='pick')!.args[0];assert.equal(first.partId,'B');point(first.position,[-3,0,5]);assert.equal(h.events.some(e=>e.name==='completeEllipseCreation'),false);
    h.props.pendingPoints=[first.position];h.props.measurementDraftToken++;h.events.length=0;h.view.move(h.pointer([3,0,5]));
    points(h.view.creationPreview.value.points,[[-3,0,5],[3,0,5],[0,1.5,5]]);assert.equal(h.view.projectedCreation.value.stage,1);assert.match(h.view.projectedCreation.value.lines.join(' '),/D1 6\.00 mm · D2 3\.00 mm/);assert.match(h.view.projectedCreation.value.lines.join(' '),/A 14\.14 mm²/);assert.match(h.view.projectedCreation.value.hint,/应用预览约定/);assert.equal(h.events.length,0,'hover never picks or commits');
    h.view.down(h.pointer([3,0,5],'pointerdown'));h.view.up(h.pointer([3,0,5],'pointerup'));const second=h.events.find(e=>e.name==='pick')!.args[0];assert.equal(second.partId,'B');point(second.position,[3,0,5]);
    h.props.pendingPoints=[first.position,second.position];h.props.measurementDraftToken++;assert.equal(h.view.projectedCreation.value.stage,2);assert.ok(h.view.projectedCreation.value.lines.join(' ').includes('DP'));assert.ok(h.view.projectedCreation.value.lines.join(' ').includes('DA'));assert.ok(walk(h.render()).some(node=>node.props?.['aria-label']==='三维椭圆创建预览'));
  }finally{h.close();}
});

test('Part staged ellipse third click confirms the canonical frozen-plane point once without fabricating a surface source',async()=>{
  const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[[-3,0,5],[3,0,5]];h.props.measurementDraftToken=31;const frozen=JSON.stringify(h.props.pendingPoints);h.events.length=0;
    h.view.move(h.pointer([4,2,5]));points(h.view.creationPreview.value.points,[[-3,0,5],[3,0,5],[0,2,5]]);assert.match(h.view.projectedCreation.value.lines.join(' '),/A 18\.85 mm²/);assert.equal(h.events.length,0);assert.equal(JSON.stringify(h.props.pendingPoints),frozen);
    h.view.down(h.pointer([4,2,5],'pointerdown'));h.view.up(h.pointer([4,2,5],'pointerup'));const completions=h.events.filter(e=>e.name==='completeEllipseCreation');assert.equal(completions.length,1);const change=completions[0]!.args[0];point(change.position,[0,2,5]);assert.equal(change.draftToken,31);assert.equal(change.volume,h.props.volume);assert.equal(change.revision,7);assert.equal('partId'in change,false);assert.equal(h.events.some(e=>e.name==='pick'||e.name==='select'||e.name==='updateMeasurementGeometry'),false);
    h.view.move(h.pointer([4,3,5]));h.view.down(h.pointer([4,3,5],'pointerdown'));h.view.up(h.pointer([4,3,5],'pointerup'));assert.equal(h.events.filter(e=>e.name==='completeEllipseCreation').length,1,'same token cannot confirm twice before parent rendering catches up');assert.equal(h.view.creationPreview.value,undefined);assert.equal(h.captures.size,0);
  }finally{h.close();}
});

test('Part two-point ellipse creation freezes an oblique physical plane across camera changes',async()=>{
  const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[[-3,0,0],[3,0,5]];h.props.measurementDraftToken=42;h.view.move(h.pointer([0,2,2.5]));points(h.view.creationPreview.value.points,[[-3,0,0],[3,0,5],[0,2,2.5]]);
    h.view.preset('iso');h.view.render();h.view.move(h.pointer([0,2,2.5]));point(h.view.creationPreview.value.points[2],[0,2,2.5]);
    h.view.preset('top');h.view.render();h.view.move(h.pointer([0,2,2.5]));assert.equal(h.view.projectedCreation.value.valid,false);assert.match(h.view.projectedCreation.value.lines.join(' '),/冻结创建平面平行/);h.view.down(h.pointer([0,2,2.5],'pointerdown'));h.view.up(h.pointer([0,2,2.5],'pointerup'));assert.equal(h.events.some(e=>e.name==='completeEllipseCreation'||e.name==='pick'),false,'camera change cannot choose a fresh more convenient plane');
    h.view.preset('front');h.view.render();h.view.down(h.pointer([0,2,2.5],'pointerdown'));h.view.up(h.pointer([0,2,2.5],'pointerup'));point(h.events.find(e=>e.name==='completeEllipseCreation')!.args[0].position,[0,2,2.5]);
  }finally{h.close();}
});

test('Part staged ellipse release rejects a changed token, document, revision, endpoints, tool or busy state',async()=>{
  for(const mutation of ['token','document','revision','points','tool','busy']){const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[[-3,0,5],[3,0,5]];h.props.measurementDraftToken=50;h.view.move(h.pointer([0,2,5]));h.view.down(h.pointer([0,2,5],'pointerdown'));
    if(mutation==='token')h.props.measurementDraftToken++;else if(mutation==='document')h.props.volume={name:'other'};else if(mutation==='revision')h.props.revision++;else if(mutation==='points')h.props.pendingPoints[0][0]++;else if(mutation==='tool')h.props.tool='navigate';else h.props.allowEdit=false;
    h.view.up(h.pointer([0,2,5],'pointerup'));assert.equal(h.events.some(e=>e.name==='completeEllipseCreation'||e.name==='pick'),false,mutation);assert.equal(h.captures.size,0,mutation);
  }finally{h.close();}}
});

test('Part staged ellipse cancellation emits nothing and Escape reaches the parent draft cancel handler',async()=>{
  for(const cancel of ['pointercancel','lostpointercapture','escape','buttons']){const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[[-3,0,5],[3,0,5]];h.props.measurementDraftToken=61;h.view.move(h.pointer([0,2,5]));h.view.down(h.pointer([0,2,5],'pointerdown'));
    let swallowed=0;if(cancel==='escape')h.view.measurementKey({key:'Escape',stopPropagation:()=>swallowed++,preventDefault:()=>swallowed++});else if(cancel==='buttons')h.view.move(h.pointer([0,2,5],'pointermove',{buttons:0}));else h.view.up(h.pointer([0,2,5],cancel));
    h.view.up(h.pointer([0,2,5],'pointerup'));assert.equal(h.events.some(e=>e.name==='completeEllipseCreation'||e.name==='pick'),false,cancel);assert.equal(h.view.creationPreview.value,undefined,cancel);assert.equal(h.captures.size,0,cancel);assert.equal(swallowed,0);if(cancel==='escape'){h.view.move(h.pointer([0,3,5]));assert.equal(h.view.creationPreview.value,undefined,'the same escaped draft cannot resurrect locally before the parent token updates');}
  }finally{h.close();}}
});

test('Part staged ellipse refuses zero minor radius or duplicate long-axis endpoints without a third mesh pick',async()=>{
  const h=await harness();try{
    h.props.tool='ellipse';h.props.pendingPoints=[[-3,0,5],[3,0,5]];h.props.measurementDraftToken=71;h.view.move(h.pointer([1,0,5]));assert.equal(h.view.projectedCreation.value.valid,false);assert.match(h.view.projectedCreation.value.lines.join(' '),/短轴不能为零/);h.view.down(h.pointer([1,0,5],'pointerdown'));h.view.up(h.pointer([1,0,5],'pointerup'));assert.equal(h.events.length,0);
    h.props.pendingPoints=[[1,0,5],[1,0,5]];h.props.measurementDraftToken++;h.view.move(h.pointer([0,2,5]));assert.equal(h.view.creationPreview.value,undefined);h.view.down(h.pointer([0,2,5],'pointerdown'));h.view.up(h.pointer([0,2,5],'pointerup'));assert.equal(h.events.length,0);
  }finally{h.close();}
});
