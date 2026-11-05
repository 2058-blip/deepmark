import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, reactive, shallowReactive, ref, proxyRefs, nextTick } from 'vue';
import { annotationLayout, annotationLabelHit, annotationDisplayText, DEFAULT_ANNOTATION_STYLE } from '../src/mimics/annotationLayout.ts';
import { defaultDensityROI, densityROIFromDrag, moveDensityROI, resizeDensityROI, densityROIMarkers, densityROIOutline, densityROIPointer, hitDensityROI } from '../src/mimics/roiGeometry.ts';
import { createSliceViewport, slicePlaneGeometry, sliceToScreen, screenToSlice, isAxisAlignedGrid, brushFootprint, brushSweepFootprint, interpolateBrushStroke, resizeBrushFromDrag, MAX_BRUSH_STROKE_SAMPLES, MAX_BRUSH_SCAN_VISITS, cameraRotation, rotateCameraVector, projectCameraPoint, cameraPickRay, fitCameraHalfHeight, cameraClipMatrix } from '../src/mimics/viewportGeometry.ts';
import { createMeshPicker } from '../src/mimics/geometry.ts';
import { physicalPoint, type Vec3, type VolumeGrid } from '../src/mimics/types.ts';
import { evaluateMeasurement, worldToVoxel } from '../src/mimics/measurements.ts';

const near = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const nearPoint = (a: readonly number[], b: readonly number[], tolerance = 1e-9) => { assert.equal(a.length, b.length); a.forEach((n, k) => near(n, b[k]!, tolerance)); };
const grid = (affine?: number[][]): VolumeGrid => ({ dims: [4, 6, 8], spacing: [2, 3, 4], data: new Float32Array(192), affine });
const sheared = [[2, 1, 0, 100], [0, 3, 0, -20], [0, 0, -4, 50], [0, 0, 0, 1]];

test('source IJK planes preserve known affine lengths, angles and half-voxel support', () => {
  const g = grid(sheared), view = createSliceViewport(g, 2, [280, 360], 1, [0, 0], 0);
  assert.equal(view.scale, 20); nearPoint(view.transform, [40, 0, -20, 60, 120, 0]);
  nearPoint(sliceToScreen(view, [0, 0, 3]), [30, 330]);
  nearPoint(sliceToScreen(view, [1, 0, 3]), [70, 330]);
  nearPoint(sliceToScreen(view, [0, 1, 3]), [50, 270]);
  nearPoint(screenToSlice(view, [110, 210], 3)!, [1, 2, 3]);
  assert.equal(screenToSlice(view, [5, 5], 3), null, 'empty corner of shear bounding box cannot pick a voxel');
  nearPoint(screenToSlice(view, [120, 0], 3)!, [0, 5, 3]);
  for (const axis of [0, 1, 2] as const) {
    const v = createSliceViewport(g, axis, [433, 287], 1.7, [29, -31]);
    const p: Vec3 = [1, 2, 3], q: Vec3 = [...p]; q[v.a] += .7; q[v.b] += 1.2;
    const s = sliceToScreen(v, p), t = sliceToScreen(v, q), wp = physicalPoint(p, g), wq = physicalPoint(q, g);
    near(Math.hypot(t[0] - s[0], t[1] - s[1]) / v.scale, Math.hypot(...wq.map((n, k) => n - wp[k]!)));
    nearPoint(screenToSlice(v, t, q[axis])!, q);
  }
});

test('raw source axes distinguish axis permutations from oblique and sheared planes', () => {
  assert.equal(isAxisAlignedGrid(grid([[0, -2, 0, 0], [3, 0, 0, 0], [0, 0, -4, 0]])), true);
  assert.equal(isAxisAlignedGrid(grid(sheared)), false);
  const c = Math.SQRT1_2;
  assert.equal(isAxisAlignedGrid(grid([[c, -c, 0, 0], [c, c, 0, 0], [0, 0, 1, 0]])), false);
  assert.equal(slicePlaneGeometry(grid(sheared), 2).vHeight, 3);
});

test('one shared IJK point independently determines all three linked slice positions', () => {
  const g = grid(), point: Vec3 = [1, 2, 3];
  const expected = [[131.25, 225], [137.5, 225], [127.77777777777777, 233.33333333333334]];
  for (const axis of [0, 1, 2] as const) {
    const view = createSliceViewport(g, axis, [300, 400], 1, [0, 0], 0);
    nearPoint(sliceToScreen(view, point), expected[axis]!);
    nearPoint(screenToSlice(view, expected[axis] as [number, number], point[axis])!, point);
  }
});

test('physical brush footprint includes shear cross terms and stroke interpolation bounds physical gaps', () => {
  const g = grid(sheared), footprint = brushFootprint(g, 2, 4);
  near(footprint.du, Math.sqrt(10) / 3); near(footprint.dv, 2 / 3);
  assert.equal(footprint.contains(1, 0), true); assert.equal(footprint.contains(1, .1), false);
  assert.equal(footprint.contains(-1, .1), true, 'negative I compensates the positive shear cross term');
  const from: Vec3 = [0, 0, 3], to: Vec3 = [3, 4, 3], samples = interpolateBrushStroke(from, to, g, 1);
  nearPoint(samples.at(-1)!, to); assert.ok(samples.length >= 40);
  let last = physicalPoint(from, g);
  for (const p of samples) { const world = physicalPoint(p, g); assert.ok(Math.hypot(...world.map((v, k) => v - last[k]!)) <= .25 + 1e-10); last = world; }
  assert.throws(() => interpolateBrushStroke(from, to, g, 0), /直径/);
});

test('independent physical ellipse and rectangle dimensions retain anisotropy and shear compensation',()=>{
  const g=grid(sheared),ellipse=brushFootprint(g,2,{width:8,height:3,shape:'circle'}),rectangle=brushFootprint(g,2,{width:8,height:3,shape:'square'});
  near(ellipse.du,Math.sqrt(4+.0625));near(ellipse.dv,.5);near(rectangle.du,2.25);near(rectangle.dv,.5);
  assert.equal(ellipse.contains(2,0),true);assert.equal(ellipse.contains(-.25,.5),true);assert.equal(ellipse.contains(0,.5),false);
  assert.equal(rectangle.contains(-2.25,.5),true,'physical x=-4,y=1.5 stays inside after shear compensation');assert.equal(rectangle.contains(1.75,.5),true);assert.equal(ellipse.contains(1.75,.5),false);
  const anisotropic={...grid(),spacing:[.5,2,3] as Vec3},e=brushFootprint(anisotropic,2,{width:4,height:8}),r=brushFootprint(anisotropic,2,{width:4,height:8,shape:'square'});
  near(e.du,4);near(e.dv,2);assert.equal(e.contains(4,0),true);assert.equal(e.contains(0,2),true);assert.equal(e.contains(3,2),false);assert.equal(r.contains(4,2),true);
  const samples=interpolateBrushStroke([0,0,1],[2,2,1],g,{width:10,height:.5}),world=samples.map(p=>physicalPoint(p,g));let previous=physicalPoint([0,0,1],g);for(const point of world){assert.ok(Math.hypot(...point.map((v,k)=>v-previous[k]!))<=.125+1e-10);previous=point;}
});

test('brush interpolation refuses an explicit work budget before allocating samples; resizing has independent dimensions',()=>{
  assert.equal(MAX_BRUSH_STROKE_SAMPLES,65536);
  assert.throws(()=>interpolateBrushStroke([0,0,0],[1,1,0],grid(),{width:1e-12,height:1e-12}),/65536.*采样上限/);
  assert.throws(()=>interpolateBrushStroke([1e308,0,0],[-1e308,0,0],grid(),1),/采样上限/);
  assert.deepEqual(resizeBrushFromDrag({width:8,height:4},[20,10],10,false),{width:12,height:6});
  assert.deepEqual(resizeBrushFromDrag({width:6,height:6},[0,10],10,true),{width:8,height:8});
  assert.deepEqual(resizeBrushFromDrag({width:6,height:4},[-100,-100],10,false),{width:.1,height:.1});
});

test('plane brushes ignore tiny normal spacing and sweep complete segments without stamp sampling',()=>{
  const g={dims:[7,7,3] as Vec3,spacing:[1,1,1e-5] as Vec3},from:Vec3=[1,1,1],to:Vec3=[2,1,1];
  assert.equal(interpolateBrushStroke(from,to,g,6,2).length,2);assert.equal(interpolateBrushStroke(from,to,g,6).length,2);
  const sweep=brushSweepFootprint(g,2,1,[1,1,1],[1,4,1]);
  assert.equal(sweep.candidateCount,4);assert.equal(sweep.contains(1,2),true);assert.equal(sweep.contains(2,2),false);
  const shearedSweep=brushSweepFootprint(grid(sheared),2,{width:4,height:2,shape:'square'},[0,1,1],[2,1,1]);assert.equal(shearedSweep.contains(1,1),true);assert.equal(shearedSweep.contains(1,2),false);
});

test('3D handedness, GL clipping, overlays and ray picking match independent known coordinates', () => {
  nearPoint(rotateCameraVector([1, 0, 0], cameraRotation(0, Math.PI / 2)), [0, 0, -1]);
  nearPoint(rotateCameraVector([0, 0, 1], cameraRotation(0, Math.PI / 2)), [1, 0, 0]);
  nearPoint(rotateCameraVector([0, 1, 0], cameraRotation(Math.PI / 2, 0)), [0, 0, 1]);
  const camera = { center: [10, 20, 30] as Vec3, rotation: cameraRotation(0, 0), halfHeight: 10, width: 400, height: 200, pan: [2, -3] as [number, number] };
  nearPoint(projectCameraPoint([14, 25, 35], camera), [260, 80]);
  const matrix = cameraClipMatrix(camera, 100), clip = [0, 1, 2].map(r => matrix[r]! * 4 + matrix[r + 4]! * 5 + matrix[r + 8]! * 5 + matrix[r + 12]!);
  nearPoint(clip, [.3, .2, -.05], 1e-7);
  const ray = cameraPickRay([260, 80], camera, 100);
  nearPoint(ray.origin, [14, 25, 130]); nearPoint(ray.direction, [0, 0, -1]);
  const picker = createMeshPicker({ positions: new Float32Array([12, 24, 35, 16, 24, 35, 14, 28, 35]), indices: new Uint32Array([0, 1, 2]) });
  nearPoint(picker.intersect(ray.origin, ray.direction)!.position, [14, 25, 35]);
  const side = cameraPickRay([100, 100], { ...camera, center: [0, 0, 0], rotation: cameraRotation(0, Math.PI / 2), width: 200, height: 200, pan: [0, 0] }, 100);
  nearPoint(side.origin, [-100, 0, 0]); nearPoint(side.direction, [1, 0, 0]);
  const sidePicker = createMeshPicker({ positions: new Float32Array([3, -2, -1, 3, 2, -1, 3, 0, 3]), indices: new Uint32Array([0, 1, 2]) });
  nearPoint(sidePicker.intersect(side.origin, side.direction)!.position, [3, 0, 0]);
});

test('fit keeps anisotropic bounds inside wide and narrow canvases at arbitrary rotations', () => {
  const min: Vec3 = [-2, -3, -8], max: Vec3 = [2, 3, 8];
  for (const [width, height] of [[700, 180], [140, 600]]) for (const [pitch, yaw] of [[0, 0], [-.5, .55], [1.3, 2.7]]) {
    const camera = { center: [0, 0, 0] as Vec3, rotation: cameraRotation(pitch!, yaw!), halfHeight: fitCameraHalfHeight(min, max, width!, height!), width: width!, height: height!, pan: [0, 0] as [number, number] };
    for (let k = 0; k < 8; k++) { const p = [0, 1, 2].map(a => k & (1 << a) ? max[a] : min[a]) as Vec3, [x, y] = projectCameraPoint(p, camera); assert.ok(x > 0 && x < width! && y > 0 && y < height!); }
  }
});

test('annotation layout uses known rotated/aligned bounds, independent ending markers and explicit long-text dots',()=>{
  const layout=annotationLayout([100,100],'abcdef',{arrow:'dot',rotation:90,align:'right'},{viewport:[500,300],labelPoint:[160,80]});
  assert.equal(layout.width,56);assert.equal(layout.height,24);layout.corners.forEach((point,index)=>nearPoint(point,[[178,24],[178,80],[154,80],[154,24]][index]!));
  assert.equal(annotationLabelHit(layout,[166,50],0),true);assert.equal(annotationLabelHit(layout,[180,50],0),false);assert.equal(layout.textX,-7);assert.deepEqual(layout.dot,[100,100]);assert.equal(layout.arrowHead,null);nearPoint(layout.leader[1]!,[154,80]);
  const arrow=annotationLayout([100,100],'text',undefined,{viewport:[500,300]});assert.deepEqual(arrow.style,DEFAULT_ANNOTATION_STYLE);nearPoint(arrow.arrowHead![0]!,[100,100]);assert.equal(arrow.dot,null);
  const none=annotationLayout([100,100],'text',{arrow:'none'},{viewport:[500,300]});assert.equal(none.arrowHead,null);assert.equal(none.dot,null);assert.equal(none.leader.length,2);
  assert.ok(annotationLayout([100,100],'text',{rotation:1e308},{viewport:[500,300]}).corners.every(point=>point.every(Number.isFinite)));
  assert.equal(annotationDisplayText('short'),'short');assert.equal(annotationDisplayText('i'.repeat(50)),'i'.repeat(50));assert.equal(annotationDisplayText('🩺'.repeat(65)),'...');assert.equal(annotationDisplayText('line 1\nline 2'),'...');assert.equal(annotationDisplayText('WWW',20),'...');
});

test('density ROI helpers preserve voxel extents, image support and physical shear for marker/border geometry',()=>{
  const dims:Vec3=[20,20,3],plane={axis:2 as const,index:1},points:[Vec3,Vec3]=[[2,3,1],[6,7,1]],g={...grid(sheared),dims},view=createSliceViewport(g,2,[400,400]);
  assert.deepEqual(defaultDensityROI([10,10,1],[4,2],plane,dims),[[8,9,1],[12,11,1]]);
  assert.deepEqual(densityROIFromDrag([7,8,1],[1,2,1],plane,dims),[[1,2,1],[7,8,1]]);
  assert.deepEqual(moveDensityROI(points,[3,3,1],[100,-100,1],plane,dims),[[15.5,-.5,1],[19.5,3.5,1]]);
  assert.deepEqual(resizeDensityROI(points,'e',[9,100,1],plane,dims),[[2,3,1],[9,7,1]]);assert.deepEqual(resizeDensityROI(points,'n',[100,10,1],plane,dims),[[2,3,1],[6,10,1]]);
  assert.equal(densityROIMarkers('density-rectangle',points,plane).length,8);assert.equal(densityROIMarkers('density-ellipse',points,plane).length,4);
  assert.equal(hitDensityROI(view,'density-rectangle',points,plane,sliceToScreen(view,[6,7,1]))?.handle,'ne');assert.equal(hitDensityROI(view,'density-rectangle',points,plane,sliceToScreen(view,[3,3,1]))?.action,'move');
  const ellipseBorder:Vec3=[4+Math.SQRT2,5+Math.SQRT2,1];assert.equal(hitDensityROI(view,'density-ellipse',points,plane,sliceToScreen(view,ellipseBorder))?.action,'move');
  const outline=densityROIOutline('density-rectangle',points,plane).map(p=>physicalPoint(p,g));nearPoint(outline[0]!,[107,-11,46]);nearPoint(outline[1]!,[115,-11,46]);nearPoint(outline[2]!,[119,1,46]);
  const edge=sliceToScreen(view,[-.5,3,1]);nearPoint(densityROIPointer(view,edge,1)!,[-.5,3,1]);assert.equal(densityROIPointer(view,[-100,-100],1),null);
});

// Compile the real SFC setup so cancellation/seed assertions cover production event handlers.
// A minimal canvas fake supplies CSS geometry only; it does not claim browser/WebGL coverage.
async function viewportComponent(name: string, replacements: Record<string,string> = {}, attachRender = false) {
  const url = new URL(`../src/mimics/${name}.vue`, import.meta.url), source = await readFile(url, 'utf8');
  const descriptor = parse(source, { filename: url.pathname }).descriptor;
  const script = compileScript(descriptor, { id: 'viewport-test' });
  const template = compileTemplate({ source: descriptor.template!.content, filename: url.pathname, id: 'viewport-test', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, [], `${name} template must compile`);
  let javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const rewrite = (code: string) => code.replace(/import (['"])[^'"]+\.css\1;?/g,'').replace(/from (['"])([^'"]+)\1/g, (_all, quote, specifier) => `from ${quote}${replacements[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier))}${quote}`);
  javascript = rewrite(javascript);
  const component = (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).default;
  if(attachRender){const render=ts.transpileModule(template.code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;component.render=(await import(`data:text/javascript;base64,${Buffer.from(rewrite(render)).toString('base64')}`)).render;}
  return component;
}
function setupWithoutMount<T>(fn: () => T): T {
  const previous = console.warn;
  console.warn = (message, ...args) => { if (!/^\[Vue warn\]: (on(Mounted|BeforeUnmount) is called|withDirectives can only be used inside render functions\.)/.test(String(message))) previous(message, ...args); };
  try { return fn(); } finally { console.warn = previous; }
}
async function imageHarness(onEmit?: (name:string,args:any[])=>void,attachRender=false) {
  const component = await viewportComponent('ImageViewport',{},attachRender);
  const previous = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  (globalThis as any).document = { createElement: () => ({}) };
  (globalThis as any).requestAnimationFrame = () => 1;
  const g = grid(), props = shallowReactive({ volume: { ...g, name: 'synthetic', affine: [[2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0]], min: 0, max: 1, unit: 'mm', oblique: false }, grid: g, axis: 2, point: [1, 2, 3], masks: [], revision: 0, center: 0, width: 1, tool: 'paint', diameter: 1, brushShape: 'circle', activeMaskId: 'mask-a', measurements: [], measurementLabels: {}, draftPoints: [], allowEdit: true });
  const events: { name: string; args: any[] }[] = [], scope = effectScope();
  const view = setupWithoutMount(() => scope.run(() => component.setup(props, { emit: (name: string, ...args: any[]) => {events.push({ name, args });onEmit?.(name,args);}, expose: () => {} })));
  const captured = new Set<number>();
  view.canvas.value = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 400 }), focus: () => {}, setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
  function pointer(p: Vec3, type = 'pointermove') { const [clientX, clientY] = view.screen(p); return { pointerId: 1, button: 0, clientX, clientY, ctrlKey: false, type }; }
  return { component,view, props, events, pointer, close: () => { scope.stop(); Object.assign(globalThis, previous); } };
}
async function brushController(options:{dims?:Vec3;affine?:number[][];value?:number;field?:(x:number,y:number,z:number)=>number}={}) {
  const {useWorkbench}=await import('../src/mimics/useWorkbench.ts'),{parseNifti}=await import('../src/core.ts'),{createProject}=await import('../src/mimics/project.ts');
  const dims:Vec3=options.dims??[9,9,3],count=dims[0]*dims[1]*dims[2],buffer=new ArrayBuffer(352+count*2),header=new DataView(buffer),affine=options.affine??[[2,1,0,100],[0,3,0,-20],[0,0,4,50]];
  header.setInt32(0,348,true);header.setInt16(40,3,true);dims.forEach((value,k)=>{header.setInt16(42+k*2,value,true);header.setFloat32(80+k*4,Math.hypot(affine[0]![k]!,affine[1]![k]!,affine[2]![k]!),true);});
  header.setInt16(70,4,true);header.setInt16(72,16,true);header.setFloat32(108,352,true);header.setFloat32(112,1,true);header.setInt16(254,1,true);header.setUint8(123,2);affine.forEach((row,r)=>row.forEach((value,c)=>header.setFloat32(280+r*16+c*4,value,true)));new Uint8Array(buffer,344,4).set([110,43,49,0]);
  if(options.value!==undefined||options.field)for(let i=0;i<count;i++)header.setInt16(352+i*2,options.field?options.field(i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))):options.value!,true);
  const volume=parseNifti(buffer,'synthetic-brush.nii'),scope=effectScope(),editor=setupWithoutMount(()=>scope.run(()=>useWorkbench({repository:null})))!;
  editor.volume.value=volume;editor.state.value=createProject(volume);editor.point.value=dims.map(n=>Math.floor(n/2)) as Vec3;editor.tool.value='paint';
  return {editor,close:()=>{editor.cancel();scope.stop();}};
}

test('controller brush sizes keep the diameter alias without loops, reject invalid pairs atomically and cancel changed targets',async()=>{
  const h=await brushController(),e=h.editor;
  try{
    assert.deepEqual([e.params.diameter,e.params.brushWidth,e.params.brushHeight,e.params.sameWidthHeight],[6,6,6,true]);
    e.params.diameter=10;assert.deepEqual([e.params.brushWidth,e.params.brushHeight],[10,10]);e.params.brushHeight=8;assert.deepEqual([e.params.diameter,e.params.brushWidth,e.params.brushHeight],[8,8,8]);
    e.params.sameWidthHeight=false;e.params.brushWidth=4;e.params.brushHeight=12;assert.deepEqual([e.params.diameter,e.params.brushWidth,e.params.brushHeight],[4,4,12]);
    e.brushBegin(2,1);e.brushStroke([4,4,1],2,1);const draft=e.draft.value;assert.ok(draft?.some(Boolean));assert.equal(e.setBrushSize(4,12),true);assert.equal(e.draft.value,draft,'an identical valid pair does not cancel the pending stroke');
    assert.equal(e.setBrushSize(9,NaN),false);assert.deepEqual([e.params.diameter,e.params.brushWidth,e.params.brushHeight],[4,4,12]);assert.equal(e.draft.value,null);e.brushEnd();assert.equal(e.activeMask.value!.data.some(Boolean),false);assert.equal(e.undoName.value,'');
    e.brushBegin(2,1);e.brushStroke([4,4,1],2,1);e.params.brushHeight=6;e.brushEnd();assert.equal(e.draft.value,null);assert.equal(e.activeMask.value!.data.some(Boolean),false);
    const {addMask}=await import('../src/mimics/project.ts'),originalId=e.state.value.selectedMaskId;e.state.value=addMask(e.state.value,e.volume.value!.data.length,'second');const second=e.state.value.selectedMaskId;e.selectMask(originalId);e.brushBegin(2,1);e.brushStroke([4,4,1],2,1);e.selectMask(second);e.brushEnd();assert.ok(e.state.value.masks.every(mask=>!mask.data.some(Boolean)));assert.equal(e.undoName.value,'');
    e.params.sameWidthHeight=true;assert.deepEqual([e.params.diameter,e.params.brushWidth,e.params.brushHeight],[4,4,4]);
  }finally{h.close();}
});

test('real SFC and controller paint known sheared ellipse/rectangle voxels as one undo and sweep narrow paths',async()=>{
  const c=await brushController(),e=c.editor;
  e.params.sameWidthHeight=false;e.setBrushSize(4,12);
  const h=await imageHarness((name,args)=>{if(name==='begin')e.brushBegin(args[0],args[1]);else if(name==='stroke')e.brushStroke(args[0],args[1],args[2]);else if(name==='end')e.brushEnd();else if(name==='cancel')e.brushCancel();else if(name==='resizeBrush')e.setBrushSize(args[0].width,args[0].height);});
  const expected=(offsets:number[][])=>{const result=new Uint8Array(9*9*3);for(const [a,b] of offsets)result[4+a!+9*(4+b!+9)]=1;return result;};
  const ellipse=expected([[1,-2],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[-1,2]]),rectangle=expected([[0,-2],[1,-2],[2,-2],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[-2,2],[-1,2],[0,2]]);
  try{
    Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:[4,4,1],tool:'paint',diameter:4,brushWidth:4,brushHeight:12,sameWidthHeight:false,masks:e.state.value.masks,activeMaskId:e.state.value.selectedMaskId});
    h.view.down(h.pointer([4,4,1],'pointerdown'));h.view.end(h.pointer([4,4,1],'pointerup'));assert.deepEqual(e.activeMask.value!.data,ellipse);
    e.undo();assert.equal(e.activeMask.value!.data.some(Boolean),false);assert.equal(e.undoName.value,'');e.undo(true);assert.deepEqual(e.activeMask.value!.data,ellipse);e.undo();
    e.params.brushShape='square';h.props.brushShape='square';h.view.down(h.pointer([4,4,1],'pointerdown'));h.view.end(h.pointer([4,4,1],'pointerup'));assert.deepEqual(e.activeMask.value!.data,rectangle);
    let before=e.activeMask.value!.data.slice();const undo=e.undoName.value,narrow=before.slice();for(let i=0;i<9;i++)narrow[i+9*(i+9)]=1;e.setBrushSize(1e-6,1e-6);Object.assign(h.props,{diameter:1e-6,brushWidth:1e-6,brushHeight:1e-6});h.view.down(h.pointer([0,0,1],'pointerdown'));assert.ok(e.draft.value);h.view.move(h.pointer([8,8,1]));h.view.end(h.pointer([8,8,1],'pointerup'));assert.equal(h.view.interactionError.value,'');assert.equal(e.draft.value,null);assert.deepEqual(e.activeMask.value!.data,narrow);e.undo();assert.deepEqual(e.activeMask.value!.data,before);e.undo(true);before=narrow;assert.equal(e.undoName.value,undo);
    h.events.length=0;e.setBrushSize(4,12);Object.assign(h.props,{diameter:4,brushWidth:4,brushHeight:12});const start={...h.pointer([4,4,1],'pointerdown'),ctrlKey:true},scale=h.view.geometry.value.scale;h.view.down(start);h.view.end({...start,clientX:start.clientX+scale,clientY:start.clientY+scale,type:'pointerup'});assert.deepEqual([e.params.brushWidth,e.params.brushHeight],[6,14]);assert.deepEqual(e.activeMask.value!.data,before);assert.equal(e.undoName.value,undo);assert.equal(h.events.filter(event=>event.name==='resizeBrush').length,1);assert.equal(h.events.some(event=>['begin','stroke','end'].includes(event.name)),false);
  }finally{h.close();c.close();}
});

test('actual image handlers include the final pointerup and cancel rather than commit on interruption', async () => {
  const h = await imageHarness();
  try {
    h.view.down(h.pointer([0, 1, 3], 'pointerdown')); h.view.end(h.pointer([3, 4, 3], 'pointerup'));
    assert.equal(h.events.filter(e => e.name === 'begin').length, 1); assert.equal(h.events.filter(e => e.name === 'end').length, 1);
    nearPoint(h.events.filter(e => e.name === 'stroke').at(-1)!.args[0], [3, 4, 3]);
    for (const interruption of ['pointercancel', 'lostpointercapture', 'Escape', 'tool', 'slice', 'target', 'busy', 'diameter', 'shape', 'volume']) {
      h.props.tool = 'paint'; h.props.allowEdit = true; h.events.length = 0; h.view.down(h.pointer([1, 2, 3], 'pointerdown'));
      if (interruption === 'Escape') h.view.key({ key: 'Escape' });
      else if (interruption === 'tool') h.props.tool = 'region';
      else if (interruption === 'slice') h.props.point = [1, 2, 4];
      else if (interruption === 'target') h.props.activeMaskId += '-changed';
      else if (interruption === 'busy') h.props.allowEdit = false;
      else if (interruption === 'diameter') h.props.diameter += .5;
      else if (interruption === 'shape') h.props.brushShape = 'square';
      else if (interruption === 'volume') h.props.volume = { ...h.props.volume, name: 'new synthetic' };
      else h.view.cancelPointer({ pointerId: 1, type: interruption });
      h.view.end(h.pointer([2, 2, 3], 'pointerup'));
      assert.equal(h.events.filter(e => e.name === 'cancel').length, 1, interruption);
      assert.equal(h.events.filter(e => e.name === 'end').length, 0, interruption);
      h.props.point = [1, 2, 3];
    }
  } finally { h.close(); }
});

test('density click defaults work in all three affine planes and ROI creation cancels without an early commit',async()=>{
  const h=await imageHarness(),dims:Vec3=[30,24,10],data=new Float32Array(30*24*10),g={dims,spacing:[2,Math.sqrt(10),4] as Vec3,data,affine:sheared},volume={...g,name:'synthetic',oblique:true,unit:'mm',min:0,max:0};
  try{
    Object.assign(h.props,{volume,grid:g,point:[12,11,5],densitySize:[4,6],revision:7});
    const expected=[[[12,9,2],[12,13,8]],[[10,11,2],[14,11,8]],[[10,8,5],[14,14,5]]];
    for(const kind of ['density-rectangle','density-ellipse'])for(const axis of [0,1,2]){
      h.props.tool=kind;h.props.axis=axis;h.events.length=0;h.view.down({...h.pointer([12,11,5],'pointerdown'),buttons:1});assert.equal(h.events.some(event=>event.name==='createDensityROI'),false);assert.ok(h.view.densityPreview.value);h.view.end({...h.pointer([12,11,5],'pointerup'),buttons:0});
      const request=h.events.find(event=>event.name==='createDensityROI')!.args[0];assert.equal(request.kind,kind);assert.deepEqual(request.plane,{axis,index:[12,11,5][axis]});request.points.forEach((p:Vec3,index:number)=>nearPoint(p,expected[axis]![index]!));assert.equal(request.volume,volume);assert.equal(request.revision,7);assert.equal(h.events.some(event=>event.name==='pick'||event.name==='complete'||event.name==='moveMeasurementPoint'),false);
    }
    h.props.axis=2;h.props.tool='density-rectangle';
    for(const interruption of ['pointercancel','lostpointercapture','Escape','slice','tool','target','document','revision','size']){
      Object.assign(h.props,{volume,grid:g,point:[12,11,5],tool:'density-rectangle',densitySize:[4,6],revision:7});h.events.length=0;h.view.down({...h.pointer([10,8,5],'pointerdown'),buttons:1});h.view.move({...h.pointer([16,15,5]),buttons:1});assert.equal(h.events.some(event=>event.name==='createDensityROI'),false);
      if(interruption==='Escape')h.view.key({key:'Escape'});else if(interruption==='slice')h.props.point=[12,11,6];else if(interruption==='tool')h.props.tool='region';else if(interruption==='target')h.props.activeMaskId+='-next';else if(interruption==='document')h.props.volume={...volume,name:'new'} as any;else if(interruption==='revision')h.props.revision=8;else if(interruption==='size')(h.props as any).densitySize=[5,6];else h.view.cancelPointer({pointerId:1,type:interruption});
      h.view.end({...h.pointer([16,15,5],'pointerup'),buttons:0});assert.equal(h.events.some(event=>event.name==='createDensityROI'||event.name==='updateMeasurementGeometry'),false,interruption);assert.equal(h.view.densityPreview.value,null);
    }
  }finally{h.close();}
});

test('real density ROI drag/resize/move updates both world corners only on release; scrolling changes display and statistics without commits',async()=>{
  const c=await brushController({field:(x,y,z)=>x+10*y+100*z}),e=c.editor;e.tool.value='density-rectangle';
  const h=await imageHarness((name,args)=>{if(name==='createDensityROI')e.createDensityROI(args[0]);else if(name==='updateMeasurementGeometry')e.updateMeasurementGeometry(args[0]);});
  const sync=()=>Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,axis:2,point:e.point.value,tool:e.tool.value,revision:e.revision.value,masks:e.state.value.masks,activeMaskId:e.state.value.selectedMaskId,measurements:e.displayMeasurements.value,measurementLabels:e.measurementLabels.value,densitySize:[e.params.densityWidth,e.params.densityHeight]});
  const pointer=(p:Vec3,type='pointermove',buttons=1)=>({...h.pointer(p,type),buttons});
  try{
    sync();const maskBefore=e.activeMask.value!.data.slice(),revision=e.revision.value;h.view.down(pointer([.25,.25,1],'pointerdown'));h.view.move(pointer([3.75,3.75,1]));assert.equal(e.state.value.measurements.length,0);assert.equal(e.revision.value,revision);h.view.end(pointer([3.75,3.75,1],'pointerup',0));assert.equal(e.error.value,'');assert.equal(e.state.value.measurements.length,1);
    const id=e.state.value.measurements[0]!.id,original=e.state.value.measurements[0]!;nearPoint(original.points[0]!,[100.75,-19.25,54]);nearPoint(original.points[1]!,[111.25,-8.75,54]);const details=e.measurementDetails(id);assert.equal(details.value,122);assert.equal(details.details.count,9);near(Number(details.details.std),Math.sqrt(202/3));assert.equal(details.details.area,54);near(Number(details.details.geometricArea),73.5);
    const request=h.events.find(event=>event.name==='createDensityROI')!.args[0];assert.equal(request.volume,e.volume.value);assert.equal(request.revision,revision);assert.equal(e.createDensityROI(request),false,'late creation cannot be replayed after its starting revision');
    const committed=e.revision.value;e.point.value=[4,4,2];assert.equal(e.revision.value,committed);assert.equal(e.state.value.measurements[0]!.plane!.index,1);assert.equal(e.displayMeasurements.value[0]!.plane!.index,2);assert.equal(e.measurementDetails(id).value,222);nearPoint(e.displayMeasurements.value[0]!.points[0]!,[100.75,-19.25,58]);sync();
    const beforeResize=e.state.value.measurements[0]!.points.map(p=>[...p]);h.events.length=0;h.view.down(pointer([3.75,3.75,2],'pointerdown'));h.view.move(pointer([4.75,4.75,2]));assert.deepEqual(e.state.value.measurements[0]!.points,beforeResize);assert.equal(e.measurementDetails(id).value,222);assert.equal(h.events.some(event=>event.name==='moveMeasurementPoint'||event.name==='updateMeasurementGeometry'),false);h.view.end(pointer([4.75,4.75,2],'pointerup',0));assert.equal(e.error.value,'');const changed=e.state.value.measurements[0]!;assert.equal(changed.plane!.index,2);nearPoint(changed.points[0]!,[100.75,-19.25,58]);nearPoint(changed.points[1]!,[114.25,-5.75,58]);assert.equal(e.measurementDetails(id).value,227.5);assert.equal(e.measurementDetails(id).details.count,16);assert.equal(h.events.filter(event=>event.name==='updateMeasurementGeometry').length,1);sync();
    h.view.down(pointer([1.375,.25,2],'pointerdown'));h.view.move(pointer([2.375,.75,2]));near(e.measurementDetails(id).value,227.5);h.view.end(pointer([2.375,.75,2],'pointerup',0));near(e.measurementDetails(id).value,233.5);assert.equal(e.measurementDetails(id).details.count,20);assert.deepEqual(e.activeMask.value!.data,maskBefore);
    e.undo();nearPoint(e.state.value.measurements[0]!.points[1]!,[114.25,-5.75,58]);e.undo();assert.equal(e.state.value.measurements[0]!.plane!.index,1);e.undo();assert.equal(e.state.value.measurements.length,0);assert.equal(e.undoName.value,'');
  }finally{h.close();c.close();}
});

test('2D ordinary handle release carries its starting epoch and cannot overwrite replaced geometry, revision or document',async()=>{
  const h=await imageHarness(),volume=h.props.volume,note:any={id:'distance',name:'distance',kind:'distance',points:[[2,6,12],[6,9,12]],plane:{axis:2,index:3},visible:true,color:'#ffdf7a'};
  const start=()=>{Object.assign(h.props,{volume,tool:'navigate',revision:15,measurements:[note]});h.events.length=0;h.view.down({...h.pointer([1,2,3],'pointerdown'),buttons:1});h.view.move({...h.pointer([2,2,3]),buttons:1});};
  try{
    start();h.view.end({...h.pointer([2,2,3],'pointerup'),buttons:0});const change=h.events.find(event=>event.name==='moveMeasurementPoint')!.args[0];nearPoint(change.position,[4,6,12]);assert.equal(change.volume,volume);assert.equal(change.revision,15);assert.equal('grid' in change,false);assert.deepEqual(note.points,[[2,6,12],[6,9,12]]);
    for(const kind of ['geometry','revision','document']){
      start();if(kind==='geometry')(h.props as any).measurements=[{...note,points:[[2,9,12],[6,9,12]]}];else if(kind==='revision')h.props.revision=16;else h.props.volume={...volume,name:'replacement'};h.view.end({...h.pointer([2,2,3],'pointerup'),buttons:0});assert.equal(h.events.some(event=>event.name==='moveMeasurementPoint'),false,kind);
    }
    assert.equal(change.revision,15,'a saved event never reads a newer release-time epoch');
  }finally{h.close();}
});

test('source IJK Ctrl blue axes translate and rotate the saved RP without painting or moving the independent white crosshair',async()=>{
  const h=await imageHarness(),base={origin:[0,0,10],u:[1,0,0],v:[0,1,0],size:[8,12]},pivot:Vec3=[3.5,5.5,10],sourcePoint=[...h.props.point],previousWindow=globalThis.window,calls:any[]=[],target:any={fillText:(...args:any[])=>calls.push(['text',...args]),arc:(...args:any[])=>calls.push(['arc',...args,target.fillStyle])},ctx=new Proxy(target,{get:(object,key)=>key in object?object[key]:()=>{}});(globalThis as any).window={devicePixelRatio:1};(h.view.offscreen as any).getContext=()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}});(h.view.canvas.value as any).getContext=()=>ctx;
  const event=(world:Vec3,type='pointermove',ctrlKey=true)=>({...h.pointer([world[0]/2,world[1]/3,3],type),ctrlKey,buttons:type==='pointerup'?0:1,shiftKey:false});
  try{
    Object.assign(h.props,{tool:'paint',revision:8,mprRevision:12,interactiveEnabled:true,interactivePlane:base,interactiveCenter:pivot});const projected:Vec3=[3.5,5.5,12],original=h.props.volume.data.slice();h.view.controlKey({key:'Control',type:'keydown'});h.view.draw();assert.equal(h.view.interactiveOverlay().axes.length,2);assert.ok(calls.some(call=>call[0]==='text'&&call[1].includes('拖蓝轴旋转')));const screen=h.view.worldScreen(pivot);assert.ok(calls.some(call=>call[0]==='arc'&&call[6]==='#45a6ff'&&Math.hypot(call[1]-screen[0],call[2]-screen[1])<1e-9));
    h.events.length=0;h.view.down(event(projected,'pointerdown'));h.view.move(event([4.5,8.5,12]));nearPoint(h.view.interactivePreview.value.crosshair,[4.5,8.5,10]);assert.equal(h.events.some(event=>event.name==='transformMpr'),false);assert.deepEqual(h.props.interactiveCenter,pivot);assert.deepEqual(h.props.interactivePlane,base);h.view.end(event([4.5,8.5,12],'pointerup'));let transform=h.events.find(event=>event.name==='transformMpr')!.args[0];nearPoint(transform.plane.origin,[1,3,10]);nearPoint(transform.crosshair,[4.5,8.5,10]);assert.equal(transform.volume,h.props.volume);assert.equal(transform.revision,8);assert.equal(transform.mprRevision,12);nearPoint(transform.sourcePlane.u.map((v:number)=>v/Math.hypot(...transform.sourcePlane.u)),[1,0,0]);assert.equal(h.events.some(event=>['begin','stroke','end','resizeBrush','point','pick','moveMeasurementPoint'].includes(event.name)),false);assert.deepEqual(h.props.point,sourcePoint);assert.deepEqual(h.props.volume.data,original);
    h.events.length=0;h.view.down(event([4.5,5.5,12],'pointerdown'));h.view.move(event([3.5,6.5,12]));h.view.end(event([3.5,6.5,12],'pointerup'));transform=h.events.find(event=>event.name==='transformMpr')!.args[0];nearPoint(transform.plane.origin,[9,2,10]);nearPoint(transform.plane.u,[0,1,0]);nearPoint(transform.plane.v,[-1,0,0]);nearPoint(transform.crosshair,pivot);assert.equal(h.events.filter(event=>event.name==='transformMpr').length,1);
    h.events.length=0;h.props.point=[1,2,4];nearPoint(h.view.interactiveOverlay().crosshair,pivot);nearPoint(h.props.interactiveCenter,pivot);assert.equal(h.events.length,0,'scrolling the source changes only the projection of the saved blue pivot');h.props.point=sourcePoint;h.view.down(event(projected,'pointerdown'));h.view.end(event(projected,'pointerup'));assert.equal(h.events.some(event=>event.name==='transformMpr'),false,'blue click without drag is not a new pose');
    h.events.length=0;h.props.interactiveEnabled=false;h.view.down(event(projected,'pointerdown'));h.view.end(event([4.5,6.5,12],'pointerup'));assert.equal(h.events.filter(event=>event.name==='resizeBrush').length,1,'stopping interactive MPR restores the existing Ctrl brush size gesture');assert.equal(h.events.some(event=>event.name==='transformMpr'||event.name==='stroke'),false);
  }finally{h.close();(globalThis as any).window=previousWindow;}
});

test('source blue-axis preview preserves sheared physical coordinates and rejects canceled or stale RP drags',async()=>{
  const h=await imageHarness(),volume=h.props.volume,originalGrid=h.props.grid,base={origin:[0,0,10],u:[1,0,0],v:[0,1,0],size:[8,12]},pivot:Vec3=[3.5,5.5,10];
  const reset=()=>Object.assign(h.props,{volume,grid:originalGrid,tool:'paint',point:[1,2,3],allowEdit:true,revision:8,mprRevision:12,interactiveEnabled:true,interactivePlane:{...base,origin:[...base.origin]},interactiveCenter:[...pivot]}),pointer=(x=1.75,y=5.5/3,type='pointermove')=>({...h.pointer([x,y,3],type),ctrlKey:true,buttons:type==='pointerup'?0:1,shiftKey:false});
  try{
    for(const interruption of ['Escape','pointercancel','lostpointercapture','keyup','ctrl-up-event','blur','tool','busy','slice','revision','pose','document','grid','RP','pivot','disabled','mouse-chord']){reset();h.events.length=0;h.view.down(pointer(1.75,5.5/3,'pointerdown'));h.view.move(pointer(2,2.1));if(interruption==='Escape')h.view.key({key:'Escape'});else if(interruption==='pointercancel'||interruption==='lostpointercapture')h.view.cancelPointer({pointerId:1,type:interruption});else if(interruption==='keyup')h.view.controlKey({key:'Control',type:'keyup'});else if(interruption==='ctrl-up-event')h.view.move({...pointer(2,2.1),ctrlKey:false});else if(interruption==='blur')h.view.controlBlur();else if(interruption==='tool')h.props.tool='area';else if(interruption==='busy')h.props.allowEdit=false;else if(interruption==='slice')h.props.point=[1,2,4];else if(interruption==='revision')h.props.revision=9;else if(interruption==='pose')h.props.mprRevision=13;else if(interruption==='document')h.props.volume={...volume,name:'replacement'};else if(interruption==='grid')h.props.grid={...originalGrid};else if(interruption==='RP')h.props.interactivePlane={...base,origin:[1,0,10]};else if(interruption==='pivot')h.props.interactiveCenter=[4,5.5,10];else if(interruption==='disabled')h.props.interactiveEnabled=false;else h.view.move({...pointer(2,2.1),buttons:2});h.view.end(pointer(2,2.1,'pointerup'));assert.equal(h.events.some(event=>['transformMpr','begin','stroke','end','resizeBrush','pick'].includes(event.name)),false,interruption);assert.equal(h.view.interactivePreview.value,null);}
    const g={...originalGrid,affine:[[2,1,0,0],[0,3,0,0],[0,0,4,0]]};reset();Object.assign(h.props,{grid:g,interactiveCenter:[5.5,5.5,10],interactivePlane:{...base,origin:[2,0,10]}});h.events.length=0;const start={...h.pointer([1.75,5.5/3,3],'pointerdown'),ctrlKey:true,buttons:1};h.view.down(start);const finish={...h.pointer([2.25,5.5/3+1,3],'pointerup'),ctrlKey:true,buttons:0};h.view.end(finish);const transform=h.events.find(event=>event.name==='transformMpr')!.args[0];nearPoint(transform.crosshair,[7.5,8.5,10]);nearPoint(transform.plane.origin,[4,3,10]);assert.equal(transform.sourcePlane.u[2],0);assert.equal(transform.sourcePlane.v[2],0);
  }finally{h.close();}
});

test('source blue center is orthogonally projected before IJK inversion when the normal affine column contains in-plane shear',async()=>{
  const h=await imageHarness(),dims:Vec3=[12,12,10],data=new Float32Array(1440),affine=[[1,0,1,0],[0,1,0,0],[0,0,1,0]],g={dims,spacing:[1,1,Math.SQRT2] as Vec3,data,affine},previousWindow=globalThis.window,calls:any[]=[],target:any={arc:(...args:any[])=>calls.push(['arc',...args,target.fillStyle])},ctx=new Proxy(target,{get:(object,key)=>key in object?object[key]:()=>{}});(globalThis as any).window={devicePixelRatio:1};(h.view.offscreen as any).getContext=()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}});(h.view.canvas.value as any).getContext=()=>ctx;
  try{
    Object.assign(h.props,{volume:{...g,name:'normal-column-shear',unit:'mm',oblique:true,min:0,max:1},grid:g,axis:2,point:[6,6,5],tool:'paint',interactiveEnabled:true,mprRevision:9,interactivePlane:{origin:[-3,-3,0],u:[1,0,0],v:[0,1,0],size:[7,7]},interactiveCenter:[0,0,0]});
    // At K=5 the plane is world z=5. The normal projection of world origin is
    // (0,0,5), whose source inverse is (-5,0,5), rather than pivot IJK (0,0,0).
    nearPoint(h.view.interactiveOverlay().center,h.view.screen([-5,0,5]));
    const pivot:Vec3=[8,4,0],base={origin:[5,1,0],u:[1,0,0],v:[0,1,0],size:[7,7]};Object.assign(h.props,{interactivePlane:base,interactiveCenter:pivot});const correct=h.view.screen([3,4,5]),wrong=h.view.screen([8,4,5]);assert.ok(Math.abs(correct[0]-wrong[0])>100);nearPoint(h.view.interactiveOverlay().center,correct);h.view.controlKey({key:'Control',type:'keydown'});h.view.draw();const blueCenters=calls.filter(call=>call[0]==='arc'&&call[6]==='#45a6ff'&&call[3]===5);assert.equal(blueCenters.length,1);nearPoint(blueCenters[0].slice(1,3),correct);assert.equal(blueCenters.some(call=>Math.hypot(call[1]-wrong[0],call[2]-wrong[1])<1e-9),false);
    const start={...h.pointer([3,4,5],'pointerdown'),ctrlKey:true,buttons:1};assert.equal(h.view.interactiveAt(start).action,'move');assert.equal(h.view.interactiveAt({...h.pointer([8,4,5]),ctrlKey:true}).action,'rotate','the old oblique-inverse location must not be a center handle');h.events.length=0;h.view.down(start);h.view.move({...h.pointer([4,6,5]),ctrlKey:true,buttons:1});nearPoint(h.view.interactivePreview.value.crosshair,[9,6,0]);assert.equal(h.events.some(event=>event.name==='transformMpr'),false);h.view.end({...h.pointer([4,6,5],'pointerup'),ctrlKey:true,buttons:0});const transform=h.events.find(event=>event.name==='transformMpr')!.args[0];nearPoint(transform.crosshair,[9,6,0]);nearPoint(transform.plane.origin,[6,3,0]);nearPoint(transform.plane.u,[1,0,0]);nearPoint(transform.plane.v,[0,1,0]);assert.equal(h.events.filter(event=>event.name==='transformMpr').length,1);assert.equal(h.events.some(event=>['begin','stroke','resizeBrush','point'].includes(event.name)),false);assert.deepEqual(h.props.interactiveCenter,pivot);
  }finally{h.close();(globalThis as any).window=previousWindow;}
});

test('real Area point menu inserts after the selected point, removes one point and commits each complete geometry as one undo',async()=>{
  const c=await brushController({dims:[12,12,3]}),e=c.editor,world=(p:Vec3)=>physicalPoint(p,e.grid.value!);e.tool.value='area';
  const original:any={id:'area-menu',name:'Area',kind:'area',points:[[2,2,1],[6,2,1],[6,6,1],[2,6,1]].map(p=>world(p as Vec3)),plane:{axis:2,index:1},pointPartIds:[null,null,null,null],visible:true,color:'#ffdf7a'};e.state.value={...e.state.value,measurements:[original]};
  const h=await imageHarness((name,args)=>{if(name==='updateMeasurementGeometry')e.updateMeasurementGeometry(args[0]);else if(name==='previewMeasurementGeometry')e.previewMeasurementGeometry(args[0]);},true),sync=()=>Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:e.point.value,tool:e.tool.value,revision:e.revision.value,measurements:e.displayMeasurements.value,measurementLabels:e.measurementLabels.value});
  const click=(p:Vec3,button=0,type='pointerdown')=>({...h.pointer(p,type),button,buttons:type==='pointerup'?0:button===2?2:1,preventDefault:()=>{}}),nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.children)]:[];
  try{
    sync();const revision=e.revision.value,mask=e.activeMask.value!.data.slice();h.view.down(click([2,2,1],2));assert.equal(h.view.areaMenu.value.index,0);assert.equal(e.revision.value,revision);const tree=setupWithoutMount(()=>h.component.render({},[],h.props,proxyRefs(h.view),{},{}));assert.equal(nodes(tree).filter(node=>node.props?.role==='menuitem').length,2);h.view.editAreaPoint('add');assert.equal(e.error.value,'');assert.equal(e.state.value.measurements[0]!.points.length,5);nearPoint(e.state.value.measurements[0]!.points[1]!,world([4,2,1]));assert.deepEqual(e.state.value.measurements[0]!.pointPartIds,[null,null,null,null,null]);assert.equal(e.revision.value,revision+1);assert.equal(h.events.filter(event=>event.name==='updateMeasurementGeometry').length,1);
    e.undo();assert.deepEqual(e.state.value.measurements[0]!.points,original.points);e.undo(true);assert.equal(e.state.value.measurements[0]!.points.length,5);sync();h.view.down(click([4,2,1],2));h.view.editAreaPoint('remove');assert.deepEqual(e.state.value.measurements[0]!.points,original.points);e.undo();assert.equal(e.state.value.measurements[0]!.points.length,5);
    sync();h.events.length=0;h.view.down(click([2,2,1]));h.view.move(click([3,3,1],0,'pointermove'));assert.equal(e.state.value.measurements[0]!.points.length,5);nearPoint(e.state.value.measurements[0]!.points[0]!,world([2,2,1]));assert.equal(e.measurementDetails(original.id).preview,true);assert.ok(h.view.imageMeasurements()[0].lines[0].startsWith('预览'));h.view.end(click([3,3,1],0,'pointerup'));assert.equal(e.measurementPreview.value,null);nearPoint(e.state.value.measurements[0]!.points[0]!,world([3,3,1]));assert.equal(h.events.filter(event=>event.name==='updateMeasurementGeometry').length,1);e.undo();nearPoint(e.state.value.measurements[0]!.points[0]!,world([2,2,1]));
    e.state.value={...e.state.value,measurements:[{...original,points:original.points.slice(0,3),pointPartIds:[null,null,null]}]};sync();h.events.length=0;h.view.down(click([2,2,1],2));const triangle=setupWithoutMount(()=>h.component.render({},[],h.props,proxyRefs(h.view),{},{}));assert.equal(nodes(triangle).filter(node=>node.props?.role==='menuitem')[1].props.disabled,true);h.view.editAreaPoint('remove');assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false);assert.match(h.view.interactionError.value,/三个/);assert.deepEqual(e.activeMask.value!.data,mask);
  }finally{h.close();c.close();}
});

test('Area local invalid contour displays its evaluator reason and never submits a self-intersection',async()=>{
  const h=await imageHarness(),area:any={id:'area',name:'Area',kind:'area',points:[[2,3,12],[6,3,12],[6,12,12],[2,12,12]],plane:{axis:2,index:3},pointPartIds:[null,null,null,null],visible:true,color:'#ffdf7a'};
  try{
    Object.assign(h.props,{tool:'area',measurements:[area]});h.view.down({...h.pointer([1,1,3],'pointerdown'),buttons:1});h.view.move({...h.pointer([3,5,3]),buttons:1});const candidate=h.view.shapePreview.value.points;assert.equal(evaluateMeasurement('area',candidate).valid,false);assert.match(h.view.imageMeasurements()[0].lines[0],/预览无效/);assert.deepEqual(area.points,[[2,3,12],[6,3,12],[6,12,12],[2,12,12]]);assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false);h.view.end({...h.pointer([3,5,3],'pointerup'),buttons:0});assert.match(h.view.interactionError.value,/自交|相交|重叠|交叉/);assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false);assert.equal(h.events.filter(event=>event.name==='previewMeasurementGeometry').at(-1)!.args[0],null);
  }finally{h.close();}
});

test('real sheared Image Ellipse exposes four derived axis ends and batches resize, center translation, rotation and label drops',async()=>{
  const c=await brushController({dims:[20,20,3],affine:[[2,1,0,0],[0,3,0,0],[0,0,4,0]]}),e=c.editor;e.tool.value='ellipse';const original:any={id:'ellipse-ui',name:'Ellipse',kind:'ellipse',points:[[24,30,4],[36,30,4],[33,33,4]],plane:{axis:2,index:1},pointPartIds:[null,null,null],visible:true,color:'#ffdf7a'};e.state.value={...e.state.value,measurements:[original]};
  const h=await imageHarness((name,args)=>{if(name==='updateMeasurementGeometry')e.updateMeasurementGeometry(args[0]);else if(name==='previewMeasurementGeometry')e.previewMeasurementGeometry(args[0]);else if(name==='updateMeasurementLabel')e.updateMeasurementLabel(args[0]);}),sync=()=>Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:e.point.value,tool:e.tool.value,revision:e.revision.value,measurements:e.displayMeasurements.value,measurementLabels:e.measurementLabels.value}),pointer=(world:Vec3,type='pointermove')=>({...h.pointer(worldToVoxel(world,e.grid.value!),type),buttons:type==='pointerup'?0:1});
  const previousWindow=globalThis.window,calls:any[]=[],ctx=new Proxy({arc:(...args:any[])=>calls.push(['arc',...args]),strokeRect:(...args:any[])=>calls.push(['rect',...args]),fillText:(...args:any[])=>calls.push(['text',...args])} as any,{get:(object,key)=>key in object?object[key]:()=>{}});(globalThis as any).window={devicePixelRatio:1};(h.view.offscreen as any).getContext=()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}});(h.view.canvas.value as any).getContext=()=>ctx;
  try{
    sync();h.view.zoom.value=1.7;h.view.pan.value=[13,-17];let item=h.view.imageMeasurements()[0];assert.equal(item.handles.length,9);assert.deepEqual(item.handles.filter((h:any)=>h.kind==='resize').map((h:any)=>h.id),['u-','u+','v-','v+']);nearPoint(item.handles.find((h:any)=>h.id==='v+').position,[30,33,4]);assert.equal(item.handles.some((h:any)=>h.position.every((v:number,k:number)=>v===original.points[2][k])),false,'raw p2 contains a discarded major-axis component');h.view.draw();const derived=h.view.worldScreen([30,33,4]),raw=h.view.worldScreen([33,33,4]);assert.ok(calls.some(call=>call[0]==='arc'&&Math.hypot(call[1]-derived[0],call[2]-derived[1])<1e-9));assert.equal(calls.some(call=>call[0]==='arc'&&Math.hypot(call[1]-raw[0],call[2]-raw[1])<1e-9),false);assert.equal(calls.filter(call=>call[0]==='rect').length,5);
    for(const id of ['v+','center','rotate++']){h.events.length=0;const handle=item.handles.find((handle:any)=>handle.id===id),revision=e.revision.value;h.view.down(pointer(handle.position,'pointerdown'));h.view.end(pointer(handle.position,'pointerup'));assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false,`${id} click must preserve off-axis raw p2`);assert.equal(e.revision.value,revision);assert.deepEqual(e.state.value.measurements[0]!.points,original.points);assert.equal(e.measurementPreview.value,null);}
    const actions:[string,Vec3,Vec3[]][]=[['u-',[22,34,4],[[22,30,4],[38,30,4],[30,33,4]]],['u+',[38,34,4],[[22,30,4],[38,30,4],[30,33,4]]],['v-',[31,25,4],[[24,30,4],[36,30,4],[30,35,4]]],['v+',[31,35,4],[[24,30,4],[36,30,4],[30,35,4]]],['center',[34,36,4],[[28,36,4],[40,36,4],[34,39,4]]],['rotate++',[27,36,4],[[30,24,4],[30,36,4],[27,30,4]]]];
    for(const [id,target,expected] of actions){sync();h.events.length=0;item=h.view.imageMeasurements()[0];const start=item.handles.find((handle:any)=>handle.id===id).position,revision=e.revision.value;h.view.down(pointer(start,'pointerdown'));h.view.move(pointer(target));assert.equal(e.revision.value,revision);assert.deepEqual(e.state.value.measurements[0]!.points,original.points);assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false);assert.equal(e.measurementDetails(original.id).preview,true);assert.ok(h.view.imageMeasurements()[0].lines.some((line:string)=>line.includes('D1')));h.view.end(pointer(target,'pointerup'));assert.equal(h.events.filter(event=>event.name==='updateMeasurementGeometry').length,1,id);assert.equal(h.events.some(event=>event.name==='moveMeasurementPoint'),false);e.state.value.measurements[0]!.points.forEach((p,i)=>nearPoint(p,expected[i]!));assert.equal(e.measurementPreview.value,null);assert.equal(e.state.value.measurements[0]!.points.length,3);assert.deepEqual(e.state.value.measurements[0]!.pointPartIds,[null,null,null]);if(id==='center'||id==='rotate++')near(e.measurementDetails(original.id).value,18*Math.PI);e.undo();assert.deepEqual(e.state.value.measurements[0]!.points,original.points);}
    sync();h.events.length=0;const revision=e.revision.value;h.view.down(pointer([30,33,4],'pointerdown'));h.view.move(pointer([35,30,4]));assert.match(h.view.interactionError.value,/轴长度|轴不能|大于零/);h.view.end(pointer([35,30,4],'pointerup'));assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'),false);assert.equal(e.revision.value,revision);assert.equal(e.measurementPreview.value,null);
    sync();h.events.length=0;item=h.view.imageMeasurements()[0];const label=item.label,start={pointerId:1,button:0,buttons:1,type:'pointerdown',clientX:label.x+18,clientY:label.y-5,ctrlKey:false},deltaStart=h.view.locate(start)!;h.view.down(start);h.view.move({...h.pointer([deltaStart[0]+1,deltaStart[1]+2,1]),buttons:1});assert.deepEqual(e.state.value.measurements[0]!.points,original.points);assert.equal(e.state.value.measurements[0]!.labelOffset,undefined);nearPoint(h.view.labelPreview.value.offset,[4,6,0]);h.view.end({...h.pointer([deltaStart[0]+1,deltaStart[1]+2,1],'pointerup'),buttons:0});assert.equal(h.events.filter(event=>event.name==='updateMeasurementLabel').length,1);nearPoint(e.state.value.measurements[0]!.labelOffset!,[4,6,0]);assert.equal(h.events.some(event=>['pick','point','updateMeasurementGeometry','moveMeasurementPoint'].includes(event.name)),false);near(e.measurementDetails(original.id).value,18*Math.PI);e.undo();assert.equal(e.state.value.measurements[0]!.labelOffset,undefined);
  }finally{h.close();c.close();(globalThis as any).window=previousWindow;}
});

test('Image aggregate geometry, label drags and Area menus discard frozen gestures when their slice or document context changes',async()=>{
  const h=await imageHarness(),volume=h.props.volume,ellipse:any={id:'ellipse',name:'Ellipse',kind:'ellipse',points:[[0,6,12],[6,6,12],[4,9,12]],plane:{axis:2,index:3},visible:true,color:'#ffdf7a'},area:any={id:'area',name:'Area',kind:'area',points:[[0,0,12],[6,0,12],[6,12,12],[0,12,12]],plane:{axis:2,index:3},visible:true,color:'#ffdf7a'};
  try{
    for(const action of ['geometry','label','menu'])for(const interruption of ['pointercancel','lostpointercapture','Escape','tool','slice','target','busy','revision','document','delete','geometry-in-place','source-in-place']){
      Object.assign(h.props,{volume,tool:'navigate',allowEdit:true,point:[1,2,3],revision:8,measurements:[{...(action==='menu'?area:ellipse),points:(action==='menu'?area:ellipse).points.map((p:Vec3)=>[...p]),pointPartIds:(action==='menu'?area:ellipse).points.map(()=>null)}]});h.events.length=0;const item=h.view.imageMeasurements()[0],label=item.label,event=action==='label'?{pointerId:1,button:0,type:'pointerdown',buttons:1,clientX:label.x+20,clientY:label.y-5,ctrlKey:false}:{...h.pointer(action==='menu'?[0,0,3]:[1.5,2,3],'pointerdown'),button:action==='menu'?2:0,buttons:action==='menu'?2:1};h.view.down(event);if(action!=='menu')h.view.move({...event,clientX:event.clientX+16,clientY:event.clientY+12,type:'pointermove'});
      if(interruption==='Escape')h.view.key({key:'Escape'});else if(interruption==='tool')h.props.tool='region';else if(interruption==='slice')h.props.point=[1,2,4];else if(interruption==='target')h.props.activeMaskId+='-next';else if(interruption==='busy')h.props.allowEdit=false;else if(interruption==='revision')h.props.revision=9;else if(interruption==='document')h.props.volume={...volume,name:'replacement'};else if(interruption==='delete')(h.props as any).measurements=[];else if(interruption==='geometry-in-place')(h.props as any).measurements[0].points[0][0]+=.5;else if(interruption==='source-in-place')(h.props as any).measurements[0].pointPartIds[0]='deleted-source';else h.view.cancelPointer({pointerId:1,type:interruption});
      h.view.end({...event,type:'pointerup',buttons:0});h.view.editAreaPoint('add');assert.equal(h.events.some(event=>event.name==='updateMeasurementGeometry'||event.name==='updateMeasurementLabel'),false,`${action}/${interruption}`);assert.equal(h.view.shapePreview.value,null);assert.equal(h.view.labelPreview.value,null);assert.equal(h.view.areaMenu.value,null);
    }
  }finally{h.close();}
});

test('Ellipse creation renders live physical variables after each long-axis stage and third click confirms once',async()=>{
  const c=await brushController({dims:[20,20,3],affine:[[2,1,0,0],[0,3,0,0],[0,0,4,0]]}),e=c.editor;e.tool.value='ellipse';const h=await imageHarness((name,args)=>{if(name==='pick')e.imagePick(args[0],args[1],args[2],args[3]);}),sync=()=>Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:e.point.value,tool:e.tool.value,revision:e.revision.value,measurements:e.displayMeasurements.value,draftPoints:e.draftPoints.value,draftPlane:e.draftPlane.value});
  const pointer=(p:Vec3,type='pointermove')=>({...h.pointer(p,type),buttons:type==='pointermove'?0:1});
  const previousWindow=globalThis.window,texts:string[]=[],ctx=new Proxy({fillText:(text:string)=>texts.push(text)} as any,{get:(object,key)=>key in object?object[key]:()=>{}});(globalThis as any).window={devicePixelRatio:1};(h.view.offscreen as any).getContext=()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}});(h.view.canvas.value as any).getContext=()=>ctx;
  try{
    sync();h.view.down(pointer([7,10,1],'pointerdown'));sync();h.view.move(pointer([13,10,1]));let draft=h.view.draftEllipse();assert.ok(draft);assert.equal(e.state.value.measurements.length,0);assert.equal(draft.outline.length,128);assert.ok(draft.lines[0].includes('D1 12.00 mm'));assert.match(draft.hint,/暂定/);h.view.draw();assert.ok(texts.some(text=>text.includes('D1 12.00 mm')));h.view.down(pointer([13,10,1],'pointerdown'));sync();h.view.down(pointer([10,10,1],'pointerdown'));assert.match(h.view.interactionError.value,/短轴不能/);assert.equal(e.draftPoints.value.length,2);assert.equal(h.events.filter(event=>event.name==='pick').length,2);h.view.move(pointer([11,11,1]));assert.equal(h.view.interactionError.value,'');draft=h.view.draftEllipse();assert.ok(draft.lines[0].includes('D2 6.00 mm'));assert.match(draft.hint,/第三次点击确认/);h.view.draw();assert.ok(texts.some(text=>text.includes('第三次点击确认')));assert.equal(e.state.value.measurements.length,0);h.view.down(pointer([11,11,1],'pointerdown'));assert.equal(e.state.value.measurements.length,1);near(e.measurementDetails(e.state.value.measurements[0]!.id).value,18*Math.PI);assert.equal(h.events.filter(event=>event.name==='pick').length,3);assert.equal(h.events.some(event=>event.name==='complete'),false);sync();assert.equal(h.view.draftEllipse(),null);
  }finally{h.close();c.close();(globalThis as any).window=previousWindow;}
});

test('actual navigation survives linked point updates and seed tools cannot drag measurement handles', async () => {
  const h = await imageHarness();
  try {
    h.props.tool = 'navigate'; h.view.down(h.pointer([1, 2, 3], 'pointerdown')); h.props.point = [2, 2, 3];
    h.view.move(h.pointer([3, 2, 3])); nearPoint(h.events.filter(e => e.name === 'point').at(-1)!.args[0], [3, 2, 3]); h.view.end(h.pointer([3, 2, 3], 'pointerup'));
    (h.props.measurements as any).push({ id: 'm', kind: 'distance', visible: true, plane: { axis: 2, index: 3 }, points: [[4, 6, 12], [6, 9, 12]] });
    for (const tool of ['region', 'dynamic', 'cavity', 'centerline']) {
      h.props.tool = tool; h.events.length = 0; h.view.down(h.pointer([2, 2, 3], 'pointerdown'));
      assert.equal(h.events.filter(e => e.name === 'pick').length, 1, tool);
    }
  } finally { h.close(); }
});

test('actual image pan and cursor-anchored zoom preserve the picked physical point', async () => {
  const h = await imageHarness();
  try {
    const point: Vec3 = [2, 3, 3], event = h.pointer(point);
    h.view.wheel({ ...event, ctrlKey: true, deltaY: -150 });
    nearPoint(h.view.locate(event)!, point);
    h.view.down({ ...event, button: 2, type: 'pointerdown' });
    const moved = { ...event, button: 2, clientX: event.clientX + 41, clientY: event.clientY - 27 };
    h.view.move(moved); nearPoint(h.view.locate(moved)!, point);
    h.view.end({ ...moved, type: 'pointerup' });
    assert.equal(h.events.some(e => e.name === 'begin' || e.name === 'end' || e.name === 'pick'), false);
  } finally { h.close(); }
});

test('Ctrl-left resize previews independently, emits once on release, and cancels without any painting events',async()=>{
  const h=await imageHarness();
  try{
    Object.assign(h.props,{brushWidth:8,brushHeight:4,sameWidthHeight:false});const start={...h.pointer([1,2,3],'pointerdown'),ctrlKey:true},scale=h.view.geometry.value.scale;
    h.view.down(start);h.view.move({...start,clientX:start.clientX+scale*2,clientY:start.clientY+scale,type:'pointermove'});
    assert.deepEqual(h.view.brushResizePreview.value,{width:12,height:6});assert.equal((h.props as any).brushWidth,8);assert.equal(h.events.some(event=>['begin','stroke','end','pick','complete','resizeBrush'].includes(event.name)),false);
    h.view.end({...start,clientX:start.clientX+scale*2,clientY:start.clientY+scale,type:'pointerup'});assert.deepEqual(h.events.filter(event=>event.name==='resizeBrush'),[{name:'resizeBrush',args:[{width:12,height:6}]}]);assert.equal(h.events.some(event=>['begin','stroke','end','pick','complete'].includes(event.name)),false);
    for(const interruption of ['pointercancel','lostpointercapture','Escape','tool','target','plane']){
      h.props.tool='paint';h.props.point=[1,2,3];h.events.length=0;h.view.down(start);h.view.move({...start,clientX:start.clientX+scale,type:'pointermove'});
      if(interruption==='Escape')h.view.key({key:'Escape'});else if(interruption==='tool')h.props.tool='erase';else if(interruption==='target')h.props.activeMaskId+='-next';else if(interruption==='plane')h.props.point=[1,2,4];else h.view.cancelPointer({pointerId:1,type:interruption});
      h.view.end({...start,type:'pointerup'});assert.equal(h.events.some(event=>['resizeBrush','begin','stroke','end','pick','complete'].includes(event.name)),false,interruption);assert.equal(h.view.brushResizePreview.value,null);
    }
    h.props.tool='paint';h.events.length=0;h.view.wheel({...start,deltaY:-100});assert.ok(h.view.zoom.value>1);assert.equal(h.events.some(event=>event.name==='resizeBrush'),false,'Ctrl wheel continues to zoom the view');
  }finally{h.close();}
});

test('Shift-left performs one navigation click before brush, resize, contour or measurement handling',async()=>{
  const h=await imageHarness();
  try{
    (h.props.measurements as any).push({id:'m',kind:'distance',visible:true,plane:{axis:2,index:3},points:[[2,6,12],[4,9,12]]});
    for(const tool of ['paint','local-threshold','multiple','lasso','distance']){
      h.props.tool=tool;h.events.length=0;h.view.down({...h.pointer([1,2,3],'pointerdown'),shiftKey:true,ctrlKey:true});h.view.move({...h.pointer([2,3,3]),shiftKey:true,ctrlKey:true});h.view.end({...h.pointer([2,3,3],'pointerup'),shiftKey:true,ctrlKey:true});h.view.doubleClick({shiftKey:true,ctrlKey:true});
      assert.deepEqual(h.events.filter(event=>event.name==='point'),[{name:'point',args:[[1,2,3]]}],tool);assert.equal(h.events.some(event=>['begin','stroke','end','pick','complete','resizeBrush','moveMeasurementPoint'].includes(event.name)),false,tool);
    }
  }finally{h.close();}
});

test('coalesced U-shaped brush input preserves three sides on a thin-normal slice and mouse chording cancels the entire draft',async()=>{
  const c=await brushController({dims:[7,7,1],affine:[[1,0,0,0],[0,1,0,0],[0,0,1e-5,0]]}),e=c.editor;e.params.diameter=1;
  const h=await imageHarness((name,args)=>{if(name==='begin')e.brushBegin(args[0],args[1]);else if(name==='stroke')e.brushStroke(args[0],args[1],args[2],args[3]);else if(name==='end')e.brushEnd();else if(name==='cancel')e.brushCancel();});
  const pointer=(point:Vec3,type='pointermove',buttons=1)=>({...h.pointer(point,type),buttons});
  try{
    Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:[1,1,0],diameter:1,masks:e.state.value.masks,activeMaskId:e.state.value.selectedMaskId});
    h.view.down(pointer([1,1,0],'pointerdown'));h.view.move({...pointer([4,1,0]),getCoalescedEvents:()=>[pointer([1,4,0]),pointer([4,4,0])]});h.view.end(pointer([4,1,0],'pointerup',0));
    const expected=new Uint8Array(49);for(let i=1;i<=4;i++){expected[1+7*i]=1;expected[4+7*i]=1;expected[i+7*4]=1;}
    assert.deepEqual(e.activeMask.value!.data,expected);assert.equal(e.activeMask.value!.data[2+7],0);assert.equal(e.activeMask.value!.data[3+7],0);
    const points=h.events.filter(event=>event.name==='stroke').map(event=>event.args[0]);assert.equal(points.length,4);points.forEach((point,index)=>nearPoint(point,[[1,1,0],[1,4,0],[4,4,0],[4,1,0]][index]!));
    e.undo();assert.equal(e.activeMask.value!.data.some(Boolean),false);assert.equal(e.undoName.value,'');
    for(const endKind of ['move-loses-primary','release-with-secondary','coalesced-loses-primary']){
      h.events.length=0;h.view.down(pointer([1,1,0],'pointerdown'));h.view.move(pointer([1,4,0],'pointermove',3));assert.ok(e.draft.value?.some(Boolean));
      if(endKind==='move-loses-primary')h.view.move(pointer([4,4,0],'pointermove',2));
      else if(endKind==='release-with-secondary')h.view.end(pointer([4,4,0],'pointerup',2));
      else h.view.move({...pointer([4,4,0]),getCoalescedEvents:()=>[pointer([2,4,0],'pointermove',2)]});
      h.view.end(pointer([4,4,0],'pointerup',0));assert.equal(e.draft.value,null);assert.equal(e.activeMask.value!.data.some(Boolean),false,endKind);assert.equal(e.undoName.value,'');assert.equal(h.events.some(event=>event.name==='end'),false,endKind);
    }
  }finally{h.close();c.close();}
});

test('a 3000 mm rectangular brush on a 1024-square slice visits source voxels once and commits a complete legitimate operation',async()=>{
  const size=1024,count=size*size,c=await brushController({dims:[size,size,1],affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],value:100}),e=c.editor;
  let sourceReads=0;const original=e.volume.value!;
  const counted=new Proxy(original.data,{get(target,key){if(typeof key==='string'&&/^\d+$/.test(key))sourceReads++;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  e.volume.value={...original,data:counted};e.tool.value='local-threshold';e.params.brushShape='square';e.setBrushSize(3000,3000);
  const h=await imageHarness((name,args)=>{if(name==='begin')e.brushBegin(args[0],args[1]);else if(name==='stroke')e.brushStroke(args[0],args[1],args[2],args[3]);else if(name==='end')e.brushEnd();else if(name==='cancel')e.brushCancel();});
  try{
    Object.assign(h.props,{volume:e.volume.value,grid:e.grid.value,point:[0,0,0],tool:'local-threshold',diameter:3000,brushWidth:3000,brushHeight:3000,brushShape:'square',masks:e.state.value.masks,activeMaskId:e.state.value.selectedMaskId});
    h.view.down({...h.pointer([0,0,0],'pointerdown'),buttons:1});h.view.move({...h.pointer([1023,1023,0]),buttons:1});h.view.end({...h.pointer([1023,1023,0],'pointerup'),buttons:0});
    assert.equal(h.events.filter(event=>event.name==='stroke').length,2,'the view emits measured endpoints, never thousands of overlapping stamps');
    assert.equal(sourceReads,count,'covered slice voxels are evaluated once across the entire stroke');assert.equal(e.error.value,'');assert.equal(e.activeMask.value!.data.length,count);assert.ok(e.activeMask.value!.data.every(value=>value===1));
    e.undo();assert.equal(e.activeMask.value!.data.some(Boolean),false);assert.equal(e.undoName.value,'');
  }finally{h.close();c.close();}
});

test('repeated partial sweep boxes hit an explicit cumulative work limit and roll back the entire uncommitted stroke',async()=>{
  const c=await brushController({dims:[512,512,1],affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]]}),e=c.editor;
  try{
    e.setBrushSize(600,600);e.brushBegin(2,0);e.brushStroke([256,256,0],2,0);assert.ok(e.draft.value?.some(Boolean));
    let attempts=0;while(e.draft.value&&attempts<1000){e.brushStroke([256+(attempts%2?.001:0),256,0],2,0);attempts++;}
    assert.ok(attempts>1&&attempts<1000);assert.equal(MAX_BRUSH_SCAN_VISITS,33554432);assert.match(e.error.value,/33554432.*已取消整笔/);assert.equal(e.draft.value,null);e.brushEnd();assert.equal(e.activeMask.value!.data.some(Boolean),false);assert.equal(e.undoName.value,'');
  }finally{c.close();}
});

test('actual image pixel buffer separates active-only, temporary-only, overlap and threshold preview colors', async () => {
  const h=await imageHarness(),previousWindow=globalThis.window;
  (globalThis as any).window={devicePixelRatio:1};
  let pixels=new Uint8ClampedArray();
  const ctx=new Proxy({}, {get:()=>()=>{}}),offscreen={createImageData:(width:number,height:number)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData:(image:{data:Uint8ClampedArray})=>{pixels=image.data;}};
  (h.view.offscreen as any).getContext=()=>offscreen;(h.view.canvas.value as any).getContext=()=>ctx;
  const data=new Float32Array(4),g={dims:[2,2,1],spacing:[1,1,1],data,affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]]};
  const active={id:'active',name:'active',data:new Uint8Array([1,0,1,0]),color:'#00cc00',opacity:1,visible:true,threshold:null,revision:0};
  try{
    Object.assign(h.props,{volume:{...g,name:'synthetic',oblique:false,unit:'mm',min:0,max:1},grid:g,point:[0,0,0],masks:[active],activeMaskId:'active',center:.5,width:1,temporarySelection:new Uint8Array([0,1,1,0])});
    h.view.draw();
    const voxel=(index:number)=>[...pixels.slice((index<2?index+2:index-2)*4,(index<2?index+2:index-2)*4+4)];
    assert.deepEqual(voxel(0),[0,204,0,255]);assert.deepEqual(voxel(1),[120,64,153,255]);assert.deepEqual(voxel(2),[166,205,39,255]);assert.deepEqual(voxel(3),[0,0,0,255]);
    (h.props as any).draft=new Uint8Array([1,1,1,1]);h.view.draw();assert.equal(voxel(1)[0],120,'draft membership cannot turn a temporary-only voxel into overlap');
    (h.props as any).draft=null;(h.props as any).temporarySelection=null;(h.props as any).preview=new Uint8Array([0,1,0,0]);h.view.draw();assert.deepEqual(voxel(1),[140,113,33,255],'ordinary threshold preview remains yellow');
  }finally{h.close();(globalThis as any).window=previousWindow;}
});

test('real canvas annotation draws style and dots, exposes full hover text, and double-click edits without completing a contour',async()=>{
  const h=await imageHarness(undefined,true),previousWindow=globalThis.window;(globalThis as any).window={devicePixelRatio:1};
  const calls:any[]=[],target:any={fillText:(text:string,x:number,y:number)=>calls.push(['text',text,x,y,target.textAlign]),translate:(x:number,y:number)=>calls.push(['translate',x,y]),rotate:(angle:number)=>calls.push(['rotate',angle]),arc:(...args:any[])=>calls.push(['arc',...args])},ctx=new Proxy(target,{get:(object,key)=>key in object?object[key]:()=>{}});
  (h.view.offscreen as any).getContext=()=>({createImageData:(width:number,height:number)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData:()=>{}});(h.view.canvas.value as any).getContext=()=>ctx;
  const full='完整注释 with multiple lines\n'.repeat(12),note:any={id:'annotation',name:'comment',kind:'annotation',points:[[2,6,12]],plane:{axis:2,index:3},visible:true,color:'#ffdf7a',text:full,annotationStyle:{arrow:'dot',rotation:90,align:'right'}};
  const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[];
  try{
    (h.props.measurements as any)=[note];h.props.tool='navigate';h.view.draw();assert.ok(calls.some(call=>call[0]==='text'&&call[1]==='...'&&call[4]==='right'));assert.ok(calls.some(call=>call[0]==='rotate'&&Math.abs(call[1]-Math.PI/2)<1e-12));assert.ok(calls.some(call=>call[0]==='arc'&&call[3]===3.5));
    const layout=h.view.imageAnnotations()[0].layout,point=layout.corners[0].map((v:number,k:number)=>(v+layout.corners[2][k])/2),event:any={pointerId:1,button:0,buttons:1,type:'pointerdown',clientX:point[0],clientY:point[1],shiftKey:false,ctrlKey:false,preventDefault:()=>{},stopPropagation:()=>{}};
    h.view.move({...event,type:'pointermove',buttons:0});assert.equal(h.view.annotationHover.value,full);const tree=setupWithoutMount(()=>h.component.render({},[],h.props,proxyRefs(h.view),{},{})),canvas=walk(tree).find(node=>node.type==='canvas');assert.equal(canvas.props.title,full);
    h.events.length=0;h.view.down(event);canvas.props.onDblclick(event);assert.deepEqual(h.events.filter(event=>event.name==='editMeasurement'),[{name:'editMeasurement',args:['annotation']}]);assert.equal(h.events.some(event=>['pick','point','complete','begin','end'].includes(event.name)),false);
    h.events.length=0;h.view.down({...h.pointer([1,2,3],'pointerdown'),buttons:1});h.view.move({...h.pointer([2,2,3]),buttons:1});h.view.end({...h.pointer([2,2,3],'pointerup'),buttons:0});const change=h.events.find(event=>event.name==='moveMeasurementPoint')!.args[0];assert.equal(change.id,'annotation');nearPoint(change.position,[4,6,12]);assert.deepEqual(note.points,[[2,6,12]]);
    (h.props.measurements as any)=[{...note,visible:false}];h.view.move({...event,type:'pointermove',buttons:0});assert.equal(h.view.annotationHover.value,'');
  }finally{h.close();(globalThis as any).window=previousWindow;}
});

test('2D annotation hover remains readable while seed, brush and temporary-edit clicks pass through the label',async()=>{
  const h=await imageHarness(),full='read-only full annotation '.repeat(10),note:any={id:'note',name:'note',kind:'annotation',points:[[2,6,12]],plane:{axis:2,index:3},visible:true,color:'#ffdf7a',text:full};
  try{
    (h.props.measurements as any)=[note];const layout=h.view.imageAnnotations()[0].layout,point=layout.corners[0].map((v:number,k:number)=>(v+layout.corners[2][k])/2),event:any={pointerId:1,button:0,buttons:1,type:'pointerdown',clientX:point[0],clientY:point[1],shiftKey:false,ctrlKey:false,preventDefault:()=>{},stopPropagation:()=>{}};assert.ok(h.view.locate(event));
    for(const tool of ['region','dynamic','cavity','centerline','lasso','livewire']){
      h.props.tool=tool;h.events.length=0;h.view.move({...event,type:'pointermove',buttons:0});assert.equal(h.view.annotationHover.value,full);h.view.down(event);h.view.end({...event,type:'pointerup',buttons:0});h.view.doubleClick(event);
      assert.equal(h.events.filter(item=>item.name==='pick').length,1,tool);assert.equal(h.events.some(item=>item.name==='editMeasurement'||item.name==='moveMeasurementPoint'),false,tool);
    }
    for(const tool of ['paint','erase','local-threshold','multiple','select','deselect']){
      h.props.tool=tool;h.events.length=0;h.view.down(event);h.view.end({...event,type:'pointerup',buttons:0});h.view.doubleClick(event);assert.equal(h.events.filter(item=>item.name==='begin').length,1,tool);assert.equal(h.events.filter(item=>item.name==='end').length,1,tool);assert.equal(h.events.some(item=>item.name==='editMeasurement'||item.name==='pick'),false,tool);
    }
    h.props.tool='navigate';h.events.length=0;h.view.down(event);h.view.doubleClick(event);assert.deepEqual(h.events.filter(item=>item.name==='editMeasurement'),[{name:'editMeasurement',args:['note']}]);assert.equal(h.events.some(item=>item.name==='pick'||item.name==='complete'),false);
  }finally{h.close();}
});

test('measurement Properties form isolates source geometry, validates annotation style and excludes annotation fields for ordinary measurements',async()=>{
  const component=await viewportComponent('MeasurementPropertiesDialog',{},true),scope=effectScope(),original:any={id:'note',name:'note',kind:'annotation',points:Object.freeze([Object.freeze([1,2,3])]),text:'source',color:'#123456',visible:true},props=reactive({measurement:original,editingId:'note',busy:false}),events:any[]=[];
  const view=setupWithoutMount(()=>scope.run(()=>component.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}})));
  try{
    assert.deepEqual([view.arrow.value,view.rotation.value,view.align.value],['arrow',0,'left']);view.name.value=' edited ';view.color.value='#abcdef';view.visible.value=false;view.text.value='new\nfull text';view.arrow.value='dot';view.rotation.value=-30;view.align.value='center';view.apply();
    assert.deepEqual(events.at(-1),{name:'apply',args:[{name:'edited',color:'#abcdef',visible:false,text:'new\nfull text',annotationStyle:{arrow:'dot',rotation:-30,align:'center'}}]});assert.equal(original.name,'note');assert.equal(original.text,'source');assert.deepEqual(original.points,[[1,2,3]]);
    const count=events.length;for(const angle of [NaN,361,-361]){view.rotation.value=angle;view.apply();assert.equal(events.length,count);assert.match(view.error.value,/无效.*360/);}const annotationTree=setupWithoutMount(()=>component.render({},[],props,proxyRefs(view),{},{})),annotationNodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(annotationNodes):node&&typeof node==='object'?[node,...annotationNodes(node.children)]:[],angleInput=annotationNodes(annotationTree).find(node=>node.type==='input'&&node.props.type==='number');assert.equal(Number(angleInput.props.min),-360);assert.equal(Number(angleInput.props.max),360);view.cancel();assert.equal(events.at(-1).name,'cancel');
    props.measurement={id:'distance',name:'distance',kind:'distance',points:[[0,0,0],[1,0,0]],color:'#ffdf7a',visible:true} as any;await nextTick();view.text.value='must not leak';view.arrow.value='dot';view.name.value='renamed';view.apply();assert.deepEqual(events.at(-1),{name:'apply',args:[{name:'renamed',color:'#ffdf7a',visible:true}]});
    const tree=setupWithoutMount(()=>component.render({},[],props,proxyRefs(view),{},{})),walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[];assert.equal(walk(tree).some(node=>node.type==='textarea'||node.type==='select'),false);
    props.busy=true;const before=events.length;view.apply();view.cancel();assert.equal(events.length,before);
  }finally{scope.stop();}
});

test('native Lasso sends a continuous freehand contour and completes only on a valid pointerup', async () => {
  const h = await imageHarness();
  try {
    h.props.tool = 'lasso'; h.view.down(h.pointer([0, 1, 3], 'pointerdown'));
    assert.equal(h.events.filter(event => event.name === 'complete').length, 0);
    h.view.move(h.pointer([3, 1, 3])); h.view.end(h.pointer([2, 4, 3], 'pointerup'));
    const picks = h.events.filter(event => event.name === 'pick');
    assert.equal(picks.length, 3); nearPoint(picks[0]!.args[0], [0, 1, 3]); nearPoint(picks.at(-1)!.args[0], [2, 4, 3]);
    assert.equal(h.events.at(-1)!.name, 'complete'); assert.equal(h.events.filter(event => event.name === 'complete').length, 1);
    assert.equal(h.events.some(event => event.name === 'begin' || event.name === 'stroke' || event.name === 'end'), false);
    h.events.length = 0; h.view.down(h.pointer([1, 1, 3], 'pointerdown')); h.view.end(h.pointer([1, 1, 3], 'pointerup'));
    assert.equal(h.events.some(event => event.name === 'complete'), false, 'a click is not a closed freehand area'); assert.equal(h.events.at(-1)!.name, 'cancel');
  } finally { h.close(); }
});

test('native Lasso pointer cancellation, capture loss, Escape and leaving the image never complete', async () => {
  const h = await imageHarness();
  try {
    h.props.tool = 'lasso';
    for(const interruption of ['pointercancel','lostpointercapture','Escape','outside','target']) {
      h.events.length = 0; h.view.down(h.pointer([0, 1, 3], 'pointerdown')); h.view.move(h.pointer([3, 1, 3])); h.view.move(h.pointer([2, 4, 3]));
      if(interruption==='Escape')h.view.key({key:'Escape'});
      else if(interruption==='outside')h.view.move({...h.pointer([2,4,3]),clientX:-30,clientY:-30});
      else if(interruption==='target')h.props.activeMaskId+='-next';
      else h.view.cancelPointer({pointerId:1,type:interruption});
      h.view.end(h.pointer([1, 3, 3], 'pointerup'));
      assert.equal(h.events.some(event=>event.name==='complete'),false,interruption); assert.equal(h.events.at(-1)!.name,'cancel',interruption);
    }
    h.props.tool='livewire';h.events.length=0;h.view.down(h.pointer([1,2,3],'pointerdown'));h.view.move(h.pointer([2,3,3]));h.view.end(h.pointer([2,3,3],'pointerup'));
    assert.equal(h.events.filter(event=>event.name==='pick').length,1,'LiveWire retains point anchors');assert.equal(h.events.some(event=>event.name==='complete'),false);
  } finally { h.close(); }
});

test('Multiple Slice Edit enters with a working Select brush and leaves the active Mask unchanged until Apply', async () => {
  const {useWorkbench}=await import('../src/mimics/useWorkbench.ts'),{makeDemo}=await import('../src/core.ts'),{createProject}=await import('../src/mimics/project.ts');
  const scope=effectScope(),editor=setupWithoutMount(()=>scope.run(()=>useWorkbench()))!;
  editor.volume.value=makeDemo();editor.state.value=createProject(editor.volume.value);editor.tool.value='multiple';editor.params.diameter=2;
  const mask=editor.activeMask.value!,before=mask.data.slice();
  const h=await imageHarness((name,args)=>{if(name==='begin')editor.brushBegin(args[0],args[1]);else if(name==='stroke')editor.brushStroke(args[0],args[1],args[2]);else if(name==='end')editor.brushEnd();else if(name==='cancel')editor.brushCancel();});
  try{
    Object.assign(h.props,{volume:editor.volume.value,grid:editor.grid.value,point:[48,48,32],tool:'multiple',diameter:2,masks:editor.state.value.masks,activeMaskId:mask.id});
    assert.equal(h.view.brush.value,true);h.view.down(h.pointer([48,48,32],'pointerdown'));h.view.move(h.pointer([50,48,32]));h.view.end(h.pointer([50,50,32],'pointerup'));
    assert.equal(editor.tool.value,'multiple');assert.ok(editor.selection.value?.some(Boolean));assert.equal(editor.draft.value,null);assert.deepEqual(editor.activeMask.value!.data,before);assert.equal(editor.undoName.value,'');
    assert.equal(h.events.filter(event=>event.name==='begin').length,1);assert.equal(h.events.filter(event=>event.name==='end').length,1);assert.equal(h.events.some(event=>event.name==='pick'),false);
  }finally{h.close();editor.cancel();scope.stop();}
});

test('actual Workbench renders direct Lasso/LiveWire operation controls while Multiple Slice Edit retains temporary Apply', async () => {
  const key='__mimicsWorkbenchViewportTest',previous=(globalThis as any)[key],scope=effectScope();
  const selection=new Uint8Array([1,0,1]),draft=new Uint8Array([0,1,0]),preview=new Uint8Array([1,1,0]);
  let contourCancels=0,brushCancels=0;
  const localUpdates:any[]=[],localChoices:number[]=[],brushSizes:number[][]=[],measurementActions:any[]=[],densityActions:any[]=[],mprActions:any[]=[],resliceActions:any[]=[],resliceProjectActions:any[]=[];
  const editor:any={advanced:{overlayLines:[],physicalPolylineLines:ref([]),centerlines:[],polylines:[]},params:reactive({selectionType:'brush',editOperation:'add',selectionOperation:'add',lower:100,upper:300,diameter:4,brushWidth:4,brushHeight:4,sameWidthHeight:true,brushShape:'circle',densityWidth:10,densityHeight:10,livewireWeight:.6,livewireAttraction:0,startSlice:0,endSlice:2}),cancel:()=>contourCancels++,brushCancel:()=>brushCancels++,cacheAvailable:false,localThreshold:{slot:ref(1),ranges:ref([{lower:10,upper:40,editable:true},{lower:100,upper:300,editable:false},{lower:50,upper:500,editable:true}]),choose:(slot:number)=>localChoices.push(slot),update:(...args:any[])=>localUpdates.push(args)},createDensityROI:(value:any)=>densityActions.push(['create',value]),updateMeasurementGeometry:(value:any)=>densityActions.push(['update',value]),displayMeasurements:ref([])};
  const mprPlanes=[{origin:[10,20,30],u:[1,0,0],v:[0,1,0],size:[32,24]},{origin:[10,20,30],u:[0,1,0],v:[0,0,1],size:[32,24]},{origin:[10,20,30],u:[0,0,1],v:[1,0,0],size:[32,24]}];
  editor.mpr={enabled:ref(false),plane:ref(mprPlanes[0]),planes:ref(mprPlanes),step:ref(2),interpolation:ref('linear'),crosshair:ref([101,202,303]),poseRevision:ref(23),resliceMode:ref('view'),resliceId:ref(''),brushPreview:ref(null),brushPreviewRevision:ref(0),contourDraft:ref(null),contourPending:ref(false),contourSettingsKey:ref('mpr-contour-config'),rotation:ref([12,24,36]),resolution:ref([32,24]),defining:ref(false),definitionPoints:ref([]),displayMeasurements:ref([]),draftPoints:ref([]),draftPlane:ref(null),interactive:ref(false),interactivePlane:ref(mprPlanes[0]),interactiveCenter:ref([77,88,99])};
  for(const name of ['locate','scroll','pick','moveMeasurementPoint','updateMeasurementGeometry','previewMeasurementGeometry','updateMeasurementLabel','createDensityROI','preset','applyOrientation','syncToSource','transform','editInteractive','modifyPlane','beginBrush','brushStroke','endBrush','cancelBrush','cancelBrushGesture','beginContour','contourPoint','previewContourPoint','completeContour','cancelContourGesture'])editor.mpr[name]=(...args:any[])=>mprActions.push([name,...args]);
  editor.mpr.beginPlaneModify=(mode:string,id=editor.state.value.selectedResliceId)=>{mprActions.push(['beginPlaneModify',mode,id]);editor.mpr.resliceMode.value=mode;editor.mpr.resliceId.value=id;editor.state.value={...editor.state.value,selectedResliceId:id};editor.tool.value='navigate';};editor.mpr.endPlaneModify=()=>{mprActions.push(['endPlaneModify']);editor.mpr.resliceMode.value='view';editor.mpr.resliceId.value='';};
  editor.mpr.startInteractive=()=>{mprActions.push(['startInteractive']);editor.mpr.interactive.value=true;};editor.mpr.stopInteractive=()=>{mprActions.push(['stopInteractive']);editor.mpr.interactive.value=false;};
  editor.reslices={objects:ref([]),propertiesDraft:ref(null)};for(const name of ['select','rename','openProperties','duplicate','remove','applyProperties','cancelProperties'])editor.reslices[name]=(...args:any[])=>resliceActions.push([name,...args]);
  editor.reslices.selected=computed(()=>editor.reslices.objects.value.find((object:any)=>object.id===editor.state.value.selectedResliceId)??null);
  editor.resliceProject={open:ref(false),draft:ref(null),preview:ref({plan:null,error:'',effectiveWidthMm:0,effectiveHeightMm:0,estimatedBytes:0,warnings:[]}),drawing:ref(false),linePoints:ref([]),lineToken:ref(0),lines:ref([]),summary:ref(null),error:ref('')};for(const name of ['show','updateDraft','preset','drawLine','cancelLine','addLinePoint','useCurrentMpr','generate','saveResult','downloadResult','saveTransforms','openResult','cancel','close'])editor.resliceProject[name]=(...args:any[])=>resliceProjectActions.push([name,...args]);
  editor.mpr.open=()=>{mprActions.push(['open']);editor.mpr.enabled.value=true;};editor.mpr.close=()=>{mprActions.push(['close']);editor.mpr.enabled.value=false;};editor.mpr.beginDefinition=()=>{mprActions.push(['beginDefinition']);editor.mpr.defining.value=true;};editor.mpr.setStep=(value:number)=>{mprActions.push(['setStep',value]);editor.mpr.step.value=value;};editor.mpr.setInterpolation=(value:string)=>{mprActions.push(['setInterpolation',value]);editor.mpr.interpolation.value=value;};editor.finishDrawing=()=>mprActions.push(['complete']);
  editor.setBrushSize=(width:number,height:number)=>{brushSizes.push([width,height]);editor.params.brushWidth=width;editor.params.diameter=width;editor.params.brushHeight=editor.params.sameWidthHeight?width:height;return true;};
  editor.measurementEditor={draft:ref(null),editingId:ref(''),openEdit:(id:string)=>measurementActions.push(['edit',id]),duplicate:(id:string)=>measurementActions.push(['duplicate',id]),toggle:(id:string)=>measurementActions.push(['toggle',id]),apply:(properties:any)=>measurementActions.push(['apply',properties]),cancel:()=>measurementActions.push(['cancel'])};editor.locateMeasurement=(id:string)=>measurementActions.push(['locate',id]);editor.deleteMeasurement=(id:string)=>measurementActions.push(['delete',id]);
  for(const [name,value] of Object.entries({showCalculate3D:false,physicalUnitsKnown:true,spatialUnitChoice:2,renderMode:'parts',pendingReplacement:null,showLocalProjects:false,localProjects:[],cacheState:'saved',cacheError:'',volume:null,state:{name:'synthetic',masks:[],parts:[],measurements:[],selectedMaskId:'',selectedPartId:''},grid:null,point:[1,2,3],activeAxis:2,tool:'lasso',tab:'segmentation',objectTab:'masks',center:40,width:400,dirty:false,status:'',error:'',busy:false,progress:0,preview:null,selection,draft,draftRevision:0,draftPoints:[[1,1,3],[2,1,3],[2,3,3]],draftPlane:{axis:2,index:3},series:[],seriesChoice:0,activeMask:null,activePart:null,maskInfo:null,partInfo:null,undoName:'',redoName:'',measurementLabels:{},revision:0,imageMeta:null,selectedMeasurementId:''}))editor[name]=ref(value);
  editor.multipleEditing=computed(()=>['multiple','select','deselect'].includes(editor.tool.value));editor.imageTool=computed(()=>editor.multipleEditing.value&&editor.params.selectionType!=='brush'?editor.params.selectionType:editor.tool.value);editor.selectionAxis=ref(2);editor.interpolationPreview=ref(null);editor.displayMasks=ref([]);
  (globalThis as any)[key]=editor;
  const stub='data:text/javascript,export default {}',replacements:Record<string,string>={'./useWorkbench.ts':`data:text/javascript,export function useWorkbench(){return globalThis.${key}}`};
  for(const name of ['ImageViewport','MprViewport','PartViewport','VolumeViewport','AdvancedPanel','LocalProjectsDialog','ReplacementDialog','Calculate3DDialog','LocalThresholdControls','MeasurementPropertiesDialog','ReslicePropertiesDialog','ResliceProjectDialog','STLCoordinateControls'])replacements[`./${name}.vue`]=stub;
  const component=await viewportComponent('Workbench',replacements,true),view=setupWithoutMount(()=>scope.run(()=>component.setup({}, {expose:()=>{}})));
  const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.children)]:[];
  const text=(node:any):string=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.children):'';
  // Inspect compiled conditional VNodes and their generated update handlers, without mounting DOM directives.
  const render=()=>setupWithoutMount(()=>component.render({},[],{},proxyRefs(view),{},{}));
  try{
    for(const tool of ['lasso','livewire']){
      editor.tool.value=tool;assert.equal(view.pendingSelection.value,false);assert.equal(view.displayPreview.value,null);assert.equal(view.contourTool.value,true);
      const tree=render(),all=nodes(tree);assert.equal(all.some(node=>node.type==='button'&&text(node)==='应用选区'),false);assert.ok(text(tree).includes('修改当前 Mask'));
      const operation=all.find(node=>node.type==='select'&&nodes(node).filter(option=>option.type==='option').map(option=>option.props.value).join(',')==='add,remove,threshold');
      assert.ok(operation);operation.props['onUpdate:modelValue']('remove');assert.equal(editor.params.editOperation,'remove');
      view.cancelImageInteraction();
    }
    assert.equal(contourCancels,2);assert.equal(brushCancels,0);
    for(const tool of ['multiple','select','deselect']){editor.tool.value=tool;assert.equal(view.pendingSelection.value,true);assert.equal(view.displayPreview.value,null);assert.deepEqual(view.temporaryPreview.value,draft);const tree=render(),all=nodes(tree);assert.ok(all.some(node=>node.type==='button'&&text(node)==='Apply · 应用到活动 Mask'));if(tool==='multiple'){assert.ok(text(tree).includes('笔刷直径'));const select=all.find(node=>node.type==='button'&&text(node)==='Select · 选择');assert.match(select.props.class,/active/);}}
    editor.tool.value='multiple';editor.params.selectionType='lasso';assert.equal(view.viewportTool(2),'lasso');assert.equal(view.viewportTool(0),'navigate');view.cancelImageInteraction();assert.equal(contourCancels,3);
    const g=grid();editor.volume.value={...g,name:'synthetic',oblique:false,unit:'mm',min:0,max:1,affine:[[2,0,0,0],[0,3,0,0],[0,0,4,0]]};editor.grid.value=g;
    let all=nodes(render()),planes=all.filter(node=>node.props?.axis!==undefined);assert.equal(planes.length,3);assert.equal(all.filter(node=>node.props?.['view-id']!==undefined).length,0);for(const plane of planes){assert.equal(plane.props.tool,plane.props.axis===2?'lasso':'navigate');assert.equal(plane.props['allow-edit'],plane.props.axis===2);assert.deepEqual(plane.props['temporary-selection'],draft);assert.equal(plane.props.masks,editor.displayMasks.value);}
    editor.activeAxis.value=0;assert.equal(view.viewportTool(2),'lasso');
    editor.interpolationPreview.value=preview;assert.deepEqual(view.temporaryPreview.value,preview);all=nodes(render());for(const label of ['预览选区插值','Apply · 应用到活动 Mask','清除临时选区','Close · 关闭多片编辑','Select · 选择','Deselect · 取消选择'])assert.equal(all.find(node=>node.type==='button'&&text(node)===label)!.props.disabled,true,label);for(const label of ['应用插值预览','取消插值预览'])assert.equal(all.find(node=>node.type==='button'&&text(node)===label)!.props.disabled,false,label);for(const plane of all.filter(node=>node.props?.axis!==undefined))assert.equal(plane.props['allow-edit'],false);
    editor.interpolationPreview.value=null;
    for(const tool of ['local-threshold','lasso','multiple']){editor.tool.value=tool;editor.params.editOperation='threshold';editor.params.selectionOperation='threshold';const threshold=nodes(render()).find(node=>node.props?.ranges);assert.ok(threshold,tool);assert.equal(threshold.props.slot,1);threshold.props.onChoose(0);threshold.props.onUpdateRange(0,'lower',20);}
    assert.deepEqual(localChoices,[0,0,0]);assert.deepEqual(localUpdates,[[0,'lower',20],[0,'lower',20],[0,'lower',20]]);assert.equal(editor.params.lower,100);assert.equal(editor.params.upper,300);
    editor.tool.value='paint';view.cancelImageInteraction();assert.equal(brushCancels,1);
    let labels=nodes(render()).filter(node=>node.type==='label'),height=nodes(labels.find(label=>text(label)==='Height · 高度 mm')).find(node=>node.type==='input');assert.equal(height.props.disabled,true);
    const same=nodes(labels.find(label=>text(label).includes('Same Width and Height'))).find(node=>node.type==='input');same.props['onUpdate:modelValue'](false);
    labels=nodes(render()).filter(node=>node.type==='label');height=nodes(labels.find(label=>text(label)==='Height · 高度 mm')).find(node=>node.type==='input');assert.equal(height.props.disabled,false);height.props.onChange({target:{value:'8'}});assert.deepEqual(brushSizes.at(-1),[4,8]);
    const plane=nodes(render()).find(node=>node.props?.axis===2);assert.equal(plane.props['brush-width'],4);assert.equal(plane.props['brush-height'],8);assert.equal(plane.props['same-width-height'],false);plane.props.onResizeBrush({width:7,height:3});assert.deepEqual(brushSizes.at(-1),[7,3]);
    editor.preview.value=preview;assert.deepEqual(view.displayPreview.value,preview);
    const note={id:'note',name:'评论',kind:'annotation',points:[[0,0,0]],pointPartIds:['missing'],color:'#ffdf7a',visible:true,text:'完整长注释'.repeat(40)};editor.state.value={...editor.state.value,measurements:[note]};editor.objectTab.value='measurements';all=nodes(render());assert.ok(all.some(node=>node.type==='small'&&text(node).includes('来源模型已删除')));
    for(const label of ['Properties · 属性','Duplicate · 复制','Hide · 隐藏','Locate · 定位','Delete · 删除'])all.find(node=>node.type==='button'&&text(node)===label)!.props.onClick({stopPropagation:()=>{}});
    assert.deepEqual(measurementActions.slice(-5),[['edit','note'],['duplicate','note'],['toggle','note'],['locate','note'],['delete','note']]);assert.ok(all.some(node=>node.type==='span'&&node.props?.title===note.text&&text(node)==='...'));
    editor.measurementEditor.draft.value=note;editor.measurementEditor.editingId.value='note';all=nodes(render());const properties=all.find(node=>node.props?.measurement?.id==='note');assert.ok(properties);assert.equal(properties.props['editing-id'],'note');properties.props.onApply({name:'changed',color:'#123456',visible:false});properties.props.onCancel();assert.deepEqual(measurementActions.slice(-2),[['apply',{name:'changed',color:'#123456',visible:false}],['cancel']]);
    all.find(node=>node.props?.axis===2).props.onEditMeasurement('note');all.find(node=>node.props?.parts).props.onEditMeasurement('note');assert.deepEqual(measurementActions.slice(-2),[['edit','note'],['edit','note']]);
    editor.tool.value='density-rectangle';editor.tab.value='measurements';editor.displayMeasurements.value=[{...note,id:'effective-roi',kind:'density-rectangle',plane:{axis:2,index:4},points:[[1,2,4],[3,4,4]],pointPartIds:[null,null]}];all=nodes(render());const width=nodes(all.find(node=>node.type==='label'&&text(node)==='Width · 初始宽度 (image px)')).find(node=>node.type==='input');assert.ok(width);width.props['onUpdate:modelValue'](12);all=nodes(render());const image=all.find(node=>node.props?.axis===2),part=all.find(node=>node.props?.parts);assert.deepEqual(image.props['density-size'],[12,10]);assert.equal(image.props.measurements,editor.displayMeasurements.value);assert.equal(part.props.measurements,editor.displayMeasurements.value);const create={kind:'density-rectangle',plane:{axis:2,index:4},points:[[1,2,4],[3,4,4]]};image.props.onCreateDensityROI(create);image.props.onUpdateMeasurementGeometry({id:'effective-roi',points:[[1,2,4],[3,4,4]]});assert.deepEqual(densityActions,[['create',create],['update',{id:'effective-roi',points:[[1,2,4],[3,4,4]]}]]);assert.equal(text(render()).includes('在切片上依次放置'),false);
    const sourcePoint=editor.point.value,originalCancel=editor.cancel;editor.cancel=()=>{mprActions.push(['cancel']);originalCancel();};
    editor.mpr.enabled.value=true;editor.mpr.interactive.value=true;editor.tool.value='ellipse';editor.draftPlane.value=null;editor.draftPoints.value=[[7,8,9],[10,11,12]];editor.mpr.draftPoints.value=[[101,202,303],[104,205,306]];editor.mpr.draftPlane.value=mprPlanes[0];editor.mpr.displayMeasurements.value=[{...note,id:'mpr-note',pointPartIds:[null],mprPlane:mprPlanes[0]}];all=nodes(render());let mprViews=all.filter(node=>node.props?.['view-id']!==undefined);assert.equal(mprViews.length,3);assert.equal(all.filter(node=>node.props?.axis!==undefined).length,0);assert.equal(all.filter(node=>node.props?.parts).length,1);assert.deepEqual(all.find(node=>node.props?.parts).props['pending-points'],[],'MPR world drafts must not enter the Part ellipse creation path');
    mprActions.length=0;const expectedRoutes:any[]=[];
    for(const [index,child] of mprViews.entries()){
      assert.equal(child.props['view-id'],index);assert.equal(child.props.plane,editor.mpr.planes.value[index]);assert.equal(child.props['mpr-revision'],23);assert.equal(child.props.crosshair,editor.mpr.crosshair.value);assert.equal(child.props.point,sourcePoint);assert.equal(child.props['draft-points'],editor.mpr.draftPoints.value);assert.equal(child.props['draft-plane'],editor.mpr.draftPlane.value);assert.equal(child.props.measurements,editor.mpr.displayMeasurements.value);assert.equal(child.props.masks,editor.state.value.masks);assert.equal(child.props['allow-edit'],true);assert.equal(child.props.step,2);assert.equal(child.props.interpolation,'linear');assert.deepEqual(child.props['density-size'],[12,10]);
      assert.equal(child.props.interactiveEnabled,true);assert.equal(child.props.interactivePlane,editor.mpr.interactivePlane.value);assert.equal(child.props.interactiveCenter,editor.mpr.interactiveCenter.value);assert.notEqual(child.props.interactiveCenter,child.props.crosshair,'RP blue pivot is distinct from the ordinary MPR crosshair');
      const world=[101+index,202,303],payload={id:`mpr-${index}`,mprPlane:editor.mpr.planes.value[index],volume:editor.volume.value,revision:editor.revision.value,mprRevision:23,points:[[101,202,303],[104,205,306]]};
      for(const [event,handler,value] of [['onPoint','locate',world],['onScroll','scroll',{distanceMm:2,plane:payload.mprPlane,viewId:index}],['onPick','pick',{...payload,position:world}],['onMoveMeasurementPoint','moveMeasurementPoint',{...payload,index:0,position:world}],['onUpdateMeasurementGeometry','updateMeasurementGeometry',payload],['onPreviewMeasurementGeometry','previewMeasurementGeometry',payload],['onPreviewMeasurementGeometry','previewMeasurementGeometry',null],['onUpdateMeasurementLabel','updateMeasurementLabel',{...payload,offset:[1,2,3]}],['onCreateDensityROI','createDensityROI',{...payload,kind:'density-ellipse'}],['onTransformMpr','transform',{plane:payload.mprPlane,crosshair:world,sourcePlane:payload.mprPlane,volume:payload.volume,revision:payload.revision,mprRevision:payload.mprRevision}]] as const){assert.equal(typeof child.props[event],'function',event);child.props[event](value);expectedRoutes.push([handler,value]);}
      child.props.onComplete();expectedRoutes.push(['complete']);child.props.onCancel();expectedRoutes.push(['cancel']);child.props.onEditMeasurement('mpr-note');
    }
    assert.deepEqual(mprActions,expectedRoutes);assert.equal(editor.point.value,sourcePoint,'MPR world positioning is routed separately from source IJK');assert.deepEqual(measurementActions.slice(-3),[['edit','mpr-note'],['edit','mpr-note'],['edit','mpr-note']]);assert.equal(densityActions.length,2,'MPR density must not use the IJK controller handlers');editor.busy.value=true;assert.ok(nodes(render()).filter(node=>node.props?.['view-id']!==undefined).every(node=>node.props['allow-edit']===false));editor.busy.value=false;
    all=nodes(render());all.find(node=>node.type==='button'&&text(node)==='返回原始三视图').props.onClick();assert.equal(editor.mpr.enabled.value,false);assert.equal(editor.mpr.interactive.value,true,'closing the sampled layout preserves interactive RP editing');all=nodes(render());planes=all.filter(node=>node.props?.axis!==undefined);assert.equal(planes.length,3);for(const child of planes){assert.equal(child.props.interactiveEnabled,true);assert.equal(child.props.interactivePlane,editor.mpr.interactivePlane.value);assert.equal(child.props.interactiveCenter,editor.mpr.interactiveCenter.value);assert.equal(child.props['mpr-revision'],23);const transform={plane:mprPlanes[0],crosshair:[77,88,99],sourcePlane:mprPlanes[1],volume:editor.volume.value,revision:0,mprRevision:23};child.props.onTransformMpr(transform);assert.deepEqual(mprActions.at(-1),['transform',transform]);}assert.equal(editor.point.value,sourcePoint);
    all.find(node=>node.type==='button'&&text(node)==='停止蓝轴交互').props.onClick();assert.deepEqual(mprActions.at(-1),['stopInteractive']);assert.equal(editor.mpr.interactive.value,false);all=nodes(render());all.find(node=>node.type==='button'&&text(node)==='交互式 MPR · 新建 RP').props.onClick();assert.deepEqual(mprActions.at(-1),['startInteractive']);assert.equal(editor.mpr.interactive.value,true);editor.mpr.enabled.value=true;
    editor.mpr.draftPlane.value=null;all=nodes(render());assert.deepEqual(all.find(node=>node.props?.parts).props['pending-points'],editor.draftPoints.value.map((p:Vec3)=>physicalPoint(p,g)),'free Part draft still receives world points');editor.mpr.defining.value=true;editor.mpr.definitionPoints.value=[[31,41,51],[32,42,52]];all=nodes(render());assert.equal(all.find(node=>node.props?.parts).props['pending-points'],editor.mpr.definitionPoints.value,'three-point plane definition uses its own exact world points');editor.mpr.defining.value=false;
    editor.tab.value='segmentation';const previousMasks=editor.state.value.masks,previousMaskId=editor.state.value.selectedMaskId,sourceBits=new Uint8Array(g.data.length),otherBits=new Uint8Array(g.data.length).fill(1);editor.state.value={...editor.state.value,masks:[{id:'mpr-brush-source',name:'source',visible:true,color:'#f00',opacity:.5,data:sourceBits,revision:0,threshold:null},{id:'other-mask',name:'other',visible:true,color:'#0f0',opacity:.5,data:otherBits,revision:0,threshold:null}],selectedMaskId:'mpr-brush-source'};editor.mpr.brushPreview.value=sourceBits.slice();editor.mpr.brushPreviewRevision.value=37;const sourceMasks=editor.state.value.masks;
    for(const [id,label] of [['paint','✎绘制'],['erase','▱擦除'],['local-threshold','◈局部阈值']]){
      editor.mpr.interactive.value=true;all=nodes(render());const button=all.find(node=>node.type==='button'&&text(node)===label);assert.ok(button);button.props.onClick();assert.equal(editor.tool.value,id);assert.equal(editor.mpr.enabled.value,true,`${id} preserves the MPR layout`);assert.equal(editor.mpr.interactive.value,false);assert.deepEqual(mprActions.slice(-2),[['endPlaneModify'],['stopInteractive']]);all=nodes(render());const children=all.filter(node=>node.props?.['view-id']!==undefined),config={width:editor.params.brushWidth,height:editor.params.brushHeight,same:editor.params.sameWidthHeight,shape:editor.params.brushShape};assert.equal(children.length,3);assert.equal(all.filter(node=>node.props?.axis!==undefined).length,0);const globalCancels=contourCancels,sourceBrushCancels=brushCancels;
      for(const [index,child] of children.entries()){
        assert.equal(child.props.tool,id);assert.equal(child.props.activeMaskId,'mpr-brush-source');assert.equal(child.props.brushWidth,config.width);assert.equal(child.props.brushHeight,config.height);assert.equal(child.props.sameWidthHeight,config.same);assert.equal(child.props.brushShape,config.shape);assert.equal(child.props.brushPreview,editor.mpr.brushPreview.value);assert.equal(child.props.brushPreviewRevision,37);assert.equal(child.props.masks,sourceMasks,'the worker retains source Masks rather than the full draft');assert.equal(child.props.masks[0].data,sourceBits);assert.equal(child.props.masks[1].data,otherBits);assert.notEqual(child.props.masks[0].data,child.props.brushPreview);
        const epoch=Object.freeze({activeMaskId:'mpr-brush-source',strokeId:100+index,mprPlane:child.props.plane,volume:editor.volume.value,revision:editor.revision.value,mprRevision:23}),stroke=Object.freeze({...epoch,position:[101+index,202,303],startSegment:true});for(const [event,handler,payload] of [['onBeginBrush','beginBrush',epoch],['onBrushStroke','brushStroke',stroke],['onEndBrush','endBrush',epoch],['onCancelBrush','cancelBrushGesture',epoch]] as const){assert.equal(child.props[event],editor.mpr[handler]);child.props[event](payload);assert.deepEqual(mprActions.at(-1),[handler,payload]);assert.equal(mprActions.at(-1)[1],payload,'opaque brush payload retains its frozen stroke id, epoch and world coordinates');}child.props.onResizeBrush({width:8+index,height:4+index});assert.deepEqual(brushSizes.at(-1),[8+index,4+index]);
      }
      assert.equal(contourCancels,globalCancels,'distinct brush cancellation does not call the global source-job cancel');assert.equal(brushCancels,sourceBrushCancels,'MPR cancellation does not use the source-IJK brush handler');editor.mpr.brushPreviewRevision.value=38;const refreshed=nodes(render()).filter(node=>node.props?.['view-id']!==undefined);assert.ok(refreshed.every(child=>child.props.brushPreviewRevision===38&&child.props.brushPreview===editor.mpr.brushPreview.value&&child.props.masks===sourceMasks));editor.mpr.brushPreviewRevision.value=37;
    }
    for(const [id,label] of [['lasso','◇闭合轮廓'],['livewire','⌁LiveWire']]){
      editor.mpr.interactive.value=true;all=nodes(render());all.find(node=>node.type==='button'&&text(node)===label).props.onClick();assert.equal(editor.tool.value,id);assert.equal(editor.mpr.enabled.value,true);assert.equal(editor.mpr.interactive.value,false);assert.deepEqual(mprActions.slice(-2),[['endPlaneModify'],['stopInteractive']]);const draftEpoch={sessionId:300,activeMaskId:'mpr-brush-source',mprPlane:editor.mpr.planes.value[0],volume:editor.volume.value,revision:editor.revision.value,mprRevision:23};editor.mpr.contourDraft.value={...draftEpoch,points:[[101,202,303]],anchors:[[101,202,303]],hover:[],pending:false};const globalCancels=contourCancels;
      const children=nodes(render()).filter(node=>node.props?.['view-id']!==undefined);assert.equal(children.length,3);for(const child of children){assert.equal(child.props.tool,id);assert.equal(child.props.contourDraft,editor.mpr.contourDraft.value);assert.equal(child.props.contourSettingsKey,'mpr-contour-config');assert.equal(child.props.masks,sourceMasks);const epoch={...draftEpoch,mprPlane:child.props.plane},point={...epoch,position:[101,202,303]},hover={...epoch,position:null},completion={...epoch,...(id==='lasso'?{points:[[101,202,303],[104,202,303],[104,205,303]]}:{})};for(const [event,handler,payload] of [['onBeginContour','beginContour',epoch],['onContourPoint','contourPoint',point],['onPreviewContourPoint','previewContourPoint',point],['onPreviewContourPoint','previewContourPoint',hover],['onCompleteContour','completeContour',completion],['onCancelContour','cancelContourGesture',epoch]] as const){assert.equal(child.props[event],editor.mpr[handler]);child.props[event](payload);assert.deepEqual(mprActions.at(-1),[handler,payload]);assert.equal(mprActions.at(-1)[1],payload);}}
      assert.equal(contourCancels,globalCancels,'contour cancellation does not invoke the global source-job cancel');editor.busy.value=true;editor.mpr.contourPending.value=true;assert.ok(nodes(render()).filter(node=>node.props?.['view-id']!==undefined).every(child=>child.props['allow-edit']===true),'a pending own contour tree keeps the local UI lease enabled');editor.mpr.contourPending.value=false;assert.ok(nodes(render()).filter(node=>node.props?.['view-id']!==undefined).every(child=>child.props['allow-edit']===false));editor.busy.value=false;editor.mpr.contourDraft.value=null;
    }
    all=nodes(render());all.find(node=>node.type==='button'&&text(node)==='◉填充腔体').props.onClick();assert.equal(editor.tool.value,'cavity');assert.equal(editor.mpr.enabled.value,false);assert.deepEqual(mprActions.slice(-3),[['endPlaneModify'],['stopInteractive'],['close']],'unsupported segmentation tools still return to original source slices');all=nodes(render());assert.equal(all.filter(node=>node.props?.axis!==undefined).length,3);assert.equal(all.filter(node=>node.props?.['view-id']!==undefined).length,0);assert.equal(densityActions.length,2);editor.state.value={...editor.state.value,masks:previousMasks,selectedMaskId:previousMaskId};editor.mpr.brushPreview.value=null;editor.mpr.brushPreviewRevision.value=0;
    const rp1={id:'rp-first',name:'Saved RP',kind:'plane',plane:mprPlanes[0]},rp2={id:'rp-second',name:'Other RP',kind:'plane',plane:mprPlanes[1]};editor.reslices.objects.value=[rp1,rp2];editor.state.value={...editor.state.value,selectedResliceId:rp1.id};all=nodes(render());const objectTotal=all.find(node=>node.type==='div'&&node.props?.class==='mw-panel-title'&&text(node).startsWith('工程对象'));assert.equal(text(nodes(objectTotal).find(node=>node.type==='span')),'3','object total includes both RP objects and the existing annotation');const rpTab=all.find(node=>node.type==='button'&&text(node)==='RP 2');assert.ok(rpTab);rpTab.props.onClick();assert.equal(editor.objectTab.value,'reslices');all=nodes(render());let rpRows=all.filter(node=>String(node.props?.class??'').includes('mw-reslice-row'));assert.equal(rpRows.length,2);assert.match(rpRows[0].props.class,/selected/);assert.equal(String(rpRows[1].props.class).includes('selected'),false);
    resliceActions.length=0;const stop={stopPropagation:()=>{}};rpRows[1].props.onClick();nodes(rpRows[0]).find(node=>node.props?.['aria-label']==='激活重切片 Saved RP').props.onClick(stop);nodes(rpRows[0]).find(node=>node.type==='input').props.onChange({target:{value:'Renamed RP'}});for(const label of ['Properties · 属性','Duplicate · 复制','Delete · 删除'])nodes(rpRows[0]).find(node=>node.type==='button'&&text(node)===label).props.onClick(stop);nodes(rpRows[0]).find(node=>node.type==='button'&&text(node)==='交互编辑').props.onClick(stop);assert.deepEqual(resliceActions,[['select',rp2.id],['select',rp1.id],['rename',rp1.id,'Renamed RP'],['openProperties',rp1.id],['duplicate',rp1.id],['remove',rp1.id]]);assert.deepEqual(mprActions.at(-1),['editInteractive',rp1.id]);
    let rpPart=all.find(node=>node.props?.parts);assert.equal(rpPart.props.reslicePlane,editor.reslices.objects.value[0].plane);assert.equal(rpPart.props.resliceId,rp1.id);assert.equal(rpPart.props.resliceMode,'view');assert.equal(rpPart.props.resliceRevision,23);assert.equal(rpPart.props.onUpdateReslicePlane,editor.mpr.modifyPlane);
    nodes(rpRows[1]).find(node=>node.type==='button'&&text(node)==='Rotate · 旋转').props.onClick(stop);assert.deepEqual(mprActions.at(-1),['beginPlaneModify','rotate',rp2.id]);all=nodes(render());rpPart=all.find(node=>node.props?.parts);assert.equal(rpPart.props.reslicePlane,editor.reslices.objects.value[1].plane,'Part RP geometry follows the selected saved object');assert.notEqual(rpPart.props.reslicePlane,editor.mpr.plane.value,'ordinary MPR plane is not substituted for the selected RP');assert.equal(rpPart.props.resliceId,rp2.id);assert.equal(rpPart.props.resliceMode,'rotate');assert.equal(editor.mpr.enabled.value,false,'3D modify buttons preserve a closed sampled layout');
    let modify=all.find(node=>node.props?.['aria-label']==='三维重切片平面修改');assert.ok(modify);assert.match(nodes(modify).find(node=>node.type==='button'&&text(node)==='Rotate · 旋转/移动').props.class,/active/);nodes(modify).find(node=>node.type==='button'&&text(node)==='Resize · 调整边框').props.onClick();assert.deepEqual(mprActions.at(-1),['beginPlaneModify','resize',rp2.id]);editor.mpr.poseRevision.value=24;all=nodes(render());rpPart=all.find(node=>node.props?.parts);assert.equal(rpPart.props.resliceMode,'resize');assert.equal(rpPart.props.resliceRevision,24);const rpDrop={id:rp2.id,plane:editor.reslices.objects.value[1].plane,action:'resize',volume:editor.volume.value,revision:editor.revision.value,resliceRevision:24};rpPart.props.onUpdateReslicePlane(rpDrop);assert.deepEqual(mprActions.at(-1),['modifyPlane',rpDrop]);assert.equal(densityActions.length,2,'RP changes route to their own controller');
    modify=all.find(node=>node.props?.['aria-label']==='三维重切片平面修改');nodes(modify).find(node=>node.type==='button'&&text(node)==='结束平面修改').props.onClick();assert.deepEqual(mprActions.at(-1),['endPlaneModify']);assert.equal(nodes(render()).find(node=>node.props?.parts).props.resliceMode,'view');
    rpRows=nodes(render()).filter(node=>String(node.props?.class??'').includes('mw-reslice-row'));nodes(rpRows[0]).find(node=>node.type==='button'&&text(node)==='Resize · 调整边框').props.onClick(stop);assert.deepEqual(mprActions.at(-1),['beginPlaneModify','resize',rp1.id]);all=nodes(render());modify=all.find(node=>node.props?.['aria-label']==='三维重切片平面修改');nodes(modify).find(node=>node.type==='button'&&text(node)==='Rotate · 旋转/移动').props.onClick();assert.deepEqual(mprActions.at(-1),['beginPlaneModify','rotate',rp1.id]);view.chooseTool('distance');assert.deepEqual(mprActions.at(-1),['endPlaneModify'],'measurement tools also end the selected RP modify session');assert.equal(editor.mpr.resliceMode.value,'view');editor.mpr.poseRevision.value=23;
    all.find(node=>node.type==='button'&&text(node)==='New · 三点 RP').props.onClick();assert.deepEqual(mprActions.at(-1),['beginDefinition']);all.find(node=>node.type==='button'&&text(node)==='New · 交互 RP').props.onClick();assert.deepEqual(mprActions.at(-1),['startInteractive']);
    const rpDraft={id:rp1.id,name:rp1.name,center:[25.5,31.5,30],angles:[0,0,0],widthMm:32,heightMm:24,size:Object.freeze([32,24])};editor.reslices.propertiesDraft.value=rpDraft;all=nodes(render());const modal=all.find(node=>node.props?.draft?.id===rp1.id);assert.ok(modal);assert.equal(modal.props.draft,editor.reslices.propertiesDraft.value);const rpProperties={name:'Edited RP',center:[10,20,30],angles:[15,25,35],widthMm:64,heightMm:72},sampleCounts=[...editor.reslices.objects.value[0].plane.size];modal.props.onApply(rpProperties);modal.props.onCancel();assert.deepEqual(resliceActions.slice(-2),[['applyProperties',rpProperties],['cancelProperties']]);assert.equal('size'in resliceActions.at(-2)[1],false);assert.deepEqual(editor.reslices.objects.value[0].plane.size,sampleCounts,'read-only output sample counts are not converted into geometry edits by the modal route');
    all=nodes(render());let projectButton=all.find(node=>node.type==='button'&&text(node)==='Reslice Project…');assert.ok(projectButton);assert.equal(projectButton.props.disabled,false);projectButton.props.onClick();assert.deepEqual(resliceProjectActions.at(-1),['show']);editor.busy.value=true;assert.equal(nodes(render()).find(node=>node.type==='button'&&text(node)==='Reslice Project…').props.disabled,true);editor.busy.value=false;editor.physicalUnitsKnown.value=false;assert.equal(nodes(render()).find(node=>node.type==='button'&&text(node)==='Reslice Project…').props.disabled,true);editor.physicalUnitsKnown.value=true;
    editor.resliceProject.open.value=true;editor.resliceProject.draft.value={name:'New reslice project',start:[0,0,0],end:[0,0,10],up:[0,1,0],rotationDegrees:0,widthMm:32,heightMm:24,pixelSize:1,sliceDistance:2,interpolation:'linear',background:0,updateCoordinateSystem:false,copyWorldObjects:true};editor.resliceProject.preview.value={plan:null,error:'',effectiveWidthMm:32,effectiveHeightMm:24,estimatedBytes:1234,warnings:['quantized']};editor.resliceProject.summary.value={name:'New reslice project',dims:[32,24,6],masks:1,parts:2,measurements:3,grayOutside:5,written:false};editor.resliceProject.error.value='project-specific status';editor.resliceProject.drawing.value=true;editor.resliceProject.linePoints.value=[[9,8,7]];editor.resliceProject.lineToken.value=41;
    const projectBoxCorners=Array.from({length:8},(_,i)=>[i&1?1:0,i&2?1:0,i&4?1:0] as Vec3),projectLines:any[]=[];for(let i=0;i<8;i++)for(const bit of [1,2,4])if(!(i&bit))projectLines.push({id:`reslice-project-box:${projectLines.length}`,points:[projectBoxCorners[i],projectBoxCorners[i|bit]],color:'#f5cb6b'});editor.resliceProject.lines.value=projectLines;editor.advanced.physicalPolylineLines.value=[{id:'physical-triangle:0',points:[[1,1,3],[4,1,3],[2,4,3],[1,1,3]],color:'#8eefa0',label:'Physical layer 1'}];view.advanced.overlayLines=[{id:'existing-analysis',points:[[1,2,3],[4,5,6]],color:'#0af'},...view.advanced.physicalPolylineLines];editor.tool.value='reslice-project-line';editor.mpr.enabled.value=false;all=nodes(render());const referenceRoute=editor.resliceProject.addLinePoint,mprBeforeReferences=mprActions.length,sourceChildren=all.filter(node=>node.props?.axis!==undefined);assert.equal(sourceChildren.length,3);
    for(const [index,child] of sourceChildren.entries()){assert.equal(child.props['reference-lines'],view.imageReferenceLines.value);assert.deepEqual(child.props['reference-lines'].slice(0,12),editor.resliceProject.lines.value);assert.equal(child.props['reference-lines'][12],view.advanced.physicalPolylineLines[0]);assert.equal(child.props['reference-lines'].length,13);assert.equal(child.props['reference-point-token'],41);assert.equal(child.props.onReferencePoint,referenceRoute);const payload=Object.freeze({position:[index+.25,2,3],volume:editor.volume.value,revision:editor.revision.value,lineToken:41});child.props.onReferencePoint(payload);assert.deepEqual(resliceProjectActions.at(-1),['addLinePoint',payload]);assert.equal(resliceProjectActions.at(-1)[1],payload);}
    let projectPart=all.find(node=>node.props?.parts);assert.equal(projectPart.props['reference-point-token'],41);assert.equal(projectPart.props.onReferencePoint,referenceRoute);assert.equal(projectPart.props['pending-points'],editor.resliceProject.linePoints.value,'world line points override unrelated MPR or IJK construction drafts');assert.equal(projectPart.props['overlay-lines'].length,14);assert.equal(projectPart.props['overlay-lines'][0],view.advanced.overlayLines[0]);assert.equal(projectPart.props['overlay-lines'][1],view.advanced.physicalPolylineLines[0]);assert.equal(projectPart.props['overlay-lines'].filter((line:any)=>line.id==='physical-triangle:0').length,1,'Part does not append physical lines already included in analysis overlays a second time');assert.deepEqual(projectPart.props['overlay-lines'].slice(2),editor.resliceProject.lines.value,'Part keeps existing analysis and physical lines and appends all twelve project edges');const partLinePoint=Object.freeze({position:[7,8,9],partId:'surface-id',volume:editor.volume.value,revision:editor.revision.value,lineToken:41});projectPart.props.onReferencePoint(partLinePoint);assert.equal(resliceProjectActions.at(-1)[1],partLinePoint);
    editor.mpr.enabled.value=true;editor.resliceProject.lineToken.value=42;all=nodes(render());const referenceMprViews=all.filter(node=>node.props?.['view-id']!==undefined);assert.equal(referenceMprViews.length,3);for(const [index,child] of referenceMprViews.entries()){assert.equal(child.props['reference-lines'],view.imageReferenceLines.value);assert.deepEqual(child.props['reference-lines'].slice(0,12),editor.resliceProject.lines.value);assert.equal(child.props['reference-lines'][12],view.advanced.physicalPolylineLines[0]);assert.equal(child.props['reference-lines'].length,13);assert.equal(child.props['reference-point-token'],42);assert.equal(child.props.onReferencePoint,referenceRoute);const payload=Object.freeze({position:[101+index,202,303],mprPlane:child.props.plane,mprRevision:editor.mpr.poseRevision.value,volume:editor.volume.value,revision:editor.revision.value,lineToken:42});child.props.onReferencePoint(payload);assert.deepEqual(resliceProjectActions.at(-1),['addLinePoint',payload]);assert.equal(resliceProjectActions.at(-1)[1],payload);}assert.equal(mprActions.length,mprBeforeReferences,'qualified project points do not enter ordinary MPR positioning or measurement routes');assert.equal(all.find(node=>node.props?.parts).props['reference-point-token'],42);
    let projectDialog=all.find(node=>node.props?.onDrawLine&&node.props?.preview===editor.resliceProject.preview.value);assert.ok(projectDialog);assert.equal(projectDialog.props.open,true);assert.equal(projectDialog.props.draft,editor.resliceProject.draft.value);assert.equal(projectDialog.props.preview,editor.resliceProject.preview.value);assert.equal(projectDialog.props.drawing,true);assert.equal(projectDialog.props['line-point-count'],1);assert.equal(projectDialog.props.busy,false);assert.equal(projectDialog.props.result,editor.resliceProject.summary.value);assert.equal(projectDialog.props.error,'project-specific status');const patch=Object.freeze({widthMm:64.5,start:[1,2,3]});projectDialog.props.onUpdateDraft(patch);assert.deepEqual(resliceProjectActions.at(-1),['updateDraft',patch]);assert.equal(resliceProjectActions.at(-1)[1],patch);projectDialog.props.onPreset('world-y');assert.deepEqual(resliceProjectActions.at(-1),['preset','world-y']);for(const [event,handler] of [['onDrawLine','drawLine'],['onCancelLine','cancelLine'],['onUseCurrentMpr','useCurrentMpr'],['onGenerate','generate'],['onSaveResult','saveResult'],['onDownloadResult','downloadResult'],['onSaveTransforms','saveTransforms'],['onOpenResult','openResult'],['onClose','close']] as const){assert.equal(projectDialog.props[event],editor.resliceProject[handler]);projectDialog.props[event]();assert.deepEqual(resliceProjectActions.at(-1),[handler]);}editor.busy.value=true;projectDialog=nodes(render()).find(node=>node.props?.onDrawLine);assert.equal(projectDialog.props.busy,true);editor.busy.value=false;
  }finally{scope.stop();(globalThis as any)[key]=previous;}
});

test('LocalThresholdControls selects three ranges and permits edits only in finite, ordered custom ranges',async()=>{
  const component=await viewportComponent('LocalThresholdControls',{},true),scope=effectScope(),props=reactive({slot:1,ranges:[{lower:10,upper:40,editable:true},{lower:100,upper:300,editable:false},{lower:50,upper:500,editable:true}],disabled:false}),events:any[]=[];
  const view=scope.run(()=>component.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}}));
  const input=(value:string)=>({target:{value}});
  try{
    view.choose(0);view.choose(2);view.choose(8);view.update(1,'lower',input('150'));view.update(0,'lower',input('20'));view.update(2,'upper',input('400'));
    assert.deepEqual(events,[{name:'choose',args:[0]},{name:'choose',args:[2]},{name:'update-range',args:[0,'lower',20]},{name:'update-range',args:[2,'upper',400]}]);assert.equal(props.ranges[1]!.lower,100);
    const length=events.length;view.update(0,'lower',input('50'));assert.match(view.error.value,/不能大于/);view.update(0,'lower',input(''));view.update(2,'upper',input('Infinity'));assert.equal(events.length,length);
    props.disabled=true;view.choose(0);view.update(0,'upper',input('35'));assert.equal(events.length,length);
    const tree=setupWithoutMount(()=>component.render({},[],props,proxyRefs(view),{},{})),walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[];
    const rows=walk(tree).filter(node=>node.type==='tr');assert.equal(rows.length,4);const middle=walk(rows[2]).filter(node=>node.type==='input'&&node.props.type==='number');assert.equal(middle.length,2);assert.ok(middle.every(node=>node.props.readonly===true));
  }finally{scope.stop();}
});

test('actual Part handlers pick the nearest visible surface after pan and suppress canceled or busy edits', async () => {
  const component = await viewportComponent('PartViewport'), scope = effectScope(), previous = globalThis.requestAnimationFrame, previousWindow = globalThis.window;
  (globalThis as any).requestAnimationFrame = () => 1;
  (globalThis as any).window = { devicePixelRatio: 1 };
  const mesh = (z: number) => ({ positions: new Float32Array([-2, -2, z, 2, -2, z, 0, 3, z]), indices: new Uint32Array([0, 1, 2]) });
  const props = reactive({ parts: [{ id: 'back', mesh: mesh(-3), visible: true, opacity: 1, color: '#fff', name: 'back' }, { id: 'front', mesh: mesh(3), visible: true, opacity: 1, color: '#fff', name: 'front' }], revision: 0, measurements: [{ id: 'm', name:'m', color:'#ffdf7a', kind: 'distance', partId: 'front', visible: true, points: [[0, 0, 3], [1, 1, 3]] }], allowEdit: true });
  const events: { name: string; args: any[] }[] = [];
  const view = setupWithoutMount(() => scope.run(() => component.setup(props, { emit: (name: string, ...args: any[]) => events.push({ name, args }), expose: () => {} })));
  const captured = new Set<number>(), element = { focus: () => {}, setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
  view.canvas.value = { ...element, getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 400 }) }; view.host.value = { getBoundingClientRect: () => ({ width: 500, height: 400 }) };
  const pointer = (type: string, x = 250, y = 200, button = 0) => ({ type, clientX: x, clientY: y, button, pointerId: 1, shiftKey: false, stopPropagation: () => {}, preventDefault: () => {}, currentTarget: element });
  try {
    view.resize(); view.preset('front'); view.fit(); view.pick(250, 200);
    assert.equal(events.at(-1)!.args[0].partId, 'front'); nearPoint(events.at(-1)!.args[0].position, [0, 0, 3]);
    view.down(pointer('pointerdown', 250, 200, 2)); view.move(pointer('pointermove', 300, 180, 2)); view.up(pointer('pointerup', 300, 180, 2)); view.pick(300, 180);
    nearPoint(events.at(-1)!.args[0].position, [0, 0, 3]);
    props.parts[1]!.opacity = 0; view.pick(300, 180); assert.equal(events.at(-1)!.args[0].partId, 'back');
    for (const type of ['pointercancel', 'lostpointercapture']) { events.length = 0; view.down(pointer('pointerdown', 300, 180)); view.up(pointer(type, 300, 180)); assert.equal(events.some(e => e.name === 'pick'), false, type); }
    props.allowEdit = false; events.length = 0; view.pick(300, 180); assert.equal(events.some(e => e.name === 'pick'), false);
    props.parts[1]!.opacity = 1; props.allowEdit = true;
    view.startMeasurementHandle(pointer('pointerdown', 300, 180), 'm', 0); events.length = 0; view.endMeasurementHandle(pointer('pointercancel', 310, 180)); assert.equal(events.some(e => e.name === 'moveMeasurementPoint'), false);
  } finally { scope.stop(); globalThis.requestAnimationFrame = previous; (globalThis as any).window = previousWindow; }
});

test('real Part SVG annotation preserves full title and rotation/alignment, renders endings and double-clicks Properties',async()=>{
  const component=await viewportComponent('PartViewport',{},true),scope=effectScope(),previousWindow=globalThis.window,previousRaf=globalThis.requestAnimationFrame;(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;
  const text='This annotation is intentionally much longer than a screen label. '.repeat(8),props=reactive({parts:[],measurements:[{id:'note',name:'note',kind:'annotation',points:[[0,0,0]],text,color:'#ffdf7a',visible:true,annotationStyle:{arrow:'dot',rotation:-30,align:'center'}}],allowEdit:true}),events:any[]=[];
  const view=setupWithoutMount(()=>scope.run(()=>component.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}})));
  view.canvas.value={getBoundingClientRect:()=>({left:0,top:0,width:500,height:400})};view.host.value={getBoundingClientRect:()=>({width:500,height:400})};
  const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[],content=(node:any):string=>typeof node==='string'?node:Array.isArray(node)?node.map(content).join(''):node&&typeof node==='object'?content(node.children):'';
  const render=()=>setupWithoutMount(()=>component.render({},[],props,proxyRefs(view),{},{}));
  try{
    view.resize();view.preset('front');view.fit();let all=walk(render()),label=all.find(node=>node.props?.class==='measurement-label');assert.ok(label.props.transform.includes('rotate(-30)'));assert.equal(walk(label).find(node=>node.type==='text').props['text-anchor'],'middle');assert.equal(content(walk(label).find(node=>node.type==='text')),'...');assert.equal(content(walk(label).find(node=>node.type==='title')),text);assert.ok(all.some(node=>node.type==='circle'&&node.props?.class==='annotation-ending'));
    label.props.onDblclick({preventDefault:()=>{},stopPropagation:()=>{}});assert.deepEqual(events,[{name:'editMeasurement',args:['note']}]);
    props.measurements=[{...props.measurements[0]!,annotationStyle:{arrow:'none',rotation:0,align:'right'}}];all=walk(render());assert.equal(all.some(node=>node.props?.class==='annotation-ending'),false);label=all.find(node=>node.props?.class==='measurement-label');assert.equal(walk(label).find(node=>node.type==='text').props['text-anchor'],'end');
    props.allowEdit=false;events.length=0;label.props.onDblclick({preventDefault:()=>{},stopPropagation:()=>{}});assert.equal(events.length,0);props.measurements[0]!.visible=false;assert.equal(view.projectedMeasurements.value.length,0);
  }finally{scope.stop();(globalThis as any).window=previousWindow;globalThis.requestAnimationFrame=previousRaf;}
});

test('3D labels and foreign handles pass seed tools to the surface while surface-distance retains its own constraints',async()=>{
  const component=await viewportComponent('PartViewport',{},true),scope=effectScope(),previousWindow=globalThis.window,previousRaf=globalThis.requestAnimationFrame;(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;
  const full='full annotation '.repeat(15),part={id:'part',name:'part',color:'#ffffff',visible:true,opacity:1,mesh:{positions:new Float32Array([-10,-10,0,10,-10,0,10,10,0,-10,10,0]),indices:new Uint32Array([0,1,2,0,2,3])}},props:any=reactive({parts:[part],tool:'navigate',allowEdit:true,measurements:[{id:'note',name:'note',kind:'annotation',points:[[0,0,0]],partId:'part',visible:true,color:'#ffdf7a',text:full},{id:'path',name:'path',kind:'surface-distance',points:[[-1,0,0],[1,0,0]],controlPoints:[[-1,0,0],[1,0,0]],partId:'part',visible:true,color:'#ffdf7a'}]}),events:any[]=[];
  const view=setupWithoutMount(()=>scope.run(()=>component.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}}))),captures=new Set<number>(),element={focus:()=>{},setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture:(id:number)=>captures.delete(id)};
  view.canvas.value={...element,getBoundingClientRect:()=>({left:0,top:0,width:500,height:400})};view.host.value={getBoundingClientRect:()=>({width:500,height:400})};
  const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.children)]:[],render=()=>setupWithoutMount(()=>component.render({},[],props,proxyRefs(view),{},{}));
  try{
    view.resize();view.preset('front');view.fit();
    for(const tool of ['centerline','region','dynamic','cavity','paint','erase','multiple','surface-distance']){
      props.tool=tool;events.length=0;const item=view.projectedMeasurements.value.find((item:any)=>item.id==='note'),layout=item.annotationLabel,point=layout.corners[0].map((v:number,k:number)=>(v+layout.corners[2][k])/2);let intercepted=0;const event:any={pointerId:1,button:0,buttons:1,type:'pointerdown',clientX:point[0],clientY:point[1],shiftKey:false,currentTarget:element,stopPropagation:()=>intercepted++,preventDefault:()=>intercepted++};
      const all=walk(render()),label=all.find(node=>node.props?.class==='measurement-label'&&node.props['aria-label']===full),annotationHandle=all.find(node=>String(node.props?.class??'').includes('measurement-handle')&&String(node.props?.['aria-label']??'').includes(full));assert.equal(label.props.style.pointerEvents,'none',tool);assert.equal(label.props.tabindex,-1);assert.equal(annotationHandle.props.style.pointerEvents,'none',tool);
      label.props.onPointerdown(event);label.props.onDblclick(event);view.startMeasurementHandle(event,'note',0);assert.equal(intercepted,0,tool);assert.equal(events.length,0,tool);
      view.move({...event,type:'pointermove',buttons:0});assert.equal(view.hoveredAnnotation.value,full);view.down(event);view.up({...event,type:'pointerup',buttons:0});assert.ok(events.some(item=>item.name==='pick'),tool);assert.equal(events.some(item=>item.name==='editMeasurement'||item.name==='selectMeasurement'||item.name==='moveMeasurementPoint'),false,tool);
    }
    props.tool='surface-distance';events.length=0;const event:any={pointerId:1,button:0,buttons:1,type:'pointerdown',clientX:250,clientY:200,currentTarget:element,stopPropagation:()=>{},preventDefault:()=>{}};view.startMeasurementHandle(event,'path',0);assert.equal(view.temporaryPoint.value.id,'path');view.endMeasurementHandle({...event,type:'pointercancel'});assert.equal(view.temporaryPoint.value,undefined);assert.equal(events.some(item=>item.name==='moveMeasurementPoint'),false);
    props.tool='navigate';events.length=0;const label=walk(render()).find(node=>node.props?.class==='measurement-label'&&node.props['aria-label']===full);assert.equal(label.props.style.pointerEvents,'auto');label.props.onDblclick(event);assert.deepEqual(events,[{name:'editMeasurement',args:['note']}]);
  }finally{scope.stop();(globalThis as any).window=previousWindow;globalThis.requestAnimationFrame=previousRaf;}
});

test('mixed-Part handles stay on their own source and a late 3D release cannot replace newer geometry or epochs',async()=>{
  const component=await viewportComponent('PartViewport',{},true),scope=effectScope(),previousWindow=globalThis.window,previousRaf=globalThis.requestAnimationFrame;(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;
  const mesh=(z:number)=>({positions:new Float32Array([-10,-10,z,10,-10,z,10,10,z,-10,10,z]),indices:new Uint32Array([0,1,2,0,2,3])}),volume:any={...grid(),name:'synthetic',unit:'mm'},mixed:any={id:'mixed',name:'mixed',kind:'distance',points:[[0,0,0],[0,0,5]],pointPartIds:['A','B'],visible:true,color:'#ffdf7a'},legacy:any={id:'legacy',name:'legacy',kind:'distance',points:[[0,0,5],[1,1,5]],partId:'B',visible:true,color:'#ffdf7a'},props:any=reactive({parts:[{id:'A',name:'A',color:'#ffffff',visible:true,opacity:1,mesh:mesh(0)},{id:'B',name:'B',color:'#ffffff',visible:true,opacity:1,mesh:mesh(5)}],measurements:[mixed,legacy],volume,revision:5,tool:'navigate',allowEdit:true}),events:any[]=[];
  const view=setupWithoutMount(()=>scope.run(()=>component.setup(props,{emit:(name:string,...args:any[])=>events.push({name,args}),expose:()=>{}}))),captures=new Set<number>(),element={focus:()=>{},setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture:(id:number)=>captures.delete(id)};
  view.canvas.value={...element,getBoundingClientRect:()=>({left:0,top:0,width:500,height:400})};view.host.value={getBoundingClientRect:()=>({width:500,height:400})};
  const pointer=(x:number,y:number,type='pointermove')=>({pointerId:1,button:0,type,clientX:x,clientY:y,currentTarget:element,stopPropagation:()=>{},preventDefault:()=>{}});
  try{
    view.resize();view.preset('front');view.fit();let item=view.projectedMeasurements.value.find((m:any)=>m.id==='mixed');assert.deepEqual(item.handles.map((h:any)=>h.partId),['A','B']);assert.deepEqual(view.projectedMeasurements.value.find((m:any)=>m.id==='legacy').handles.map((h:any)=>h.partId),['B','B']);
    props.measurements=[mixed,legacy,...(['density-rectangle','density-ellipse'] as const).map(kind=>({...legacy,id:kind,kind,partId:undefined,plane:{axis:2,index:0}}))];assert.deepEqual(view.projectedMeasurements.value.map((m:any)=>m.id),['mixed','legacy'],'image density ROI corners must not render as Part lines');assert.equal(props.measurements.length,4);
    for(const index of [0,1]){events.length=0;view.startMeasurementHandle(pointer(250,200,'pointerdown'),'mixed',index);view.moveMeasurementHandle(pointer(280,210));assert.equal(view.temporaryPoint.value.position[2],index===0?0:5);view.endMeasurementHandle(pointer(280,210,'pointerup'));const change=events.find(event=>event.name==='moveMeasurementPoint').args[0];assert.equal(change.index,index);assert.equal(change.position[2],index===0?0:5);assert.equal(change.volume,props.volume);assert.equal(change.revision,5);}
    assert.deepEqual(mixed.points,[[0,0,0],[0,0,5]]);props.parts[1].visible=false;assert.equal(view.projectedMeasurements.value.some((m:any)=>m.id==='mixed'),false);props.parts[1].visible=true;props.parts=props.parts.filter((part:any)=>part.id!=='A');assert.equal(view.projectedMeasurements.value.some((m:any)=>m.id==='mixed'),false);
    props.parts=[{id:'A',name:'A',color:'#ffffff',visible:true,opacity:1,mesh:mesh(0)},{id:'B',name:'B',color:'#ffffff',visible:true,opacity:1,mesh:mesh(5)}];
    for(const kind of ['geometry','revision','document']){
      props.measurements=[mixed,legacy];props.revision=5;props.volume=volume;events.length=0;view.startMeasurementHandle(pointer(250,200,'pointerdown'),'mixed',0);view.moveMeasurementHandle(pointer(280,210));assert.ok(view.temporaryPoint.value);
      if(kind==='geometry')props.measurements=[{...mixed,points:[[1,0,0],[0,0,5]]},legacy];else if(kind==='revision')props.revision=6;else props.volume={...volume,name:'replacement'};view.endMeasurementHandle(pointer(280,210,'pointerup'));assert.equal(events.some(event=>event.name==='moveMeasurementPoint'),false,kind);assert.equal(view.temporaryPoint.value,undefined);
    }
  }finally{scope.stop();(globalThis as any).window=previousWindow;globalThis.requestAnimationFrame=previousRaf;}
});

test('actual volume setup keeps unknown units explicit and unavailable WebGL2 produces a visible error', async () => {
  const component = await viewportComponent('VolumeViewport'), scope = effectScope(), props = reactive({ grid: grid() });
  const view = setupWithoutMount(() => scope.run(() => component.setup(props, { expose: () => {} })));
  try {
    assert.equal(view.spatialUnit.value, '影像单位');
    view.canvas.value = { getContext: () => null }; view.initialise();
    assert.match(view.fatalError.value, /需要 WebGL2/); assert.equal(view.info.value, undefined);
    (props as any).spatialUnit = 'mm'; assert.equal(view.spatialUnit.value, 'mm');
  } finally { scope.stop(); }
});

async function calculationHarness() {
  const component = await viewportComponent('Calculate3DDialog'), scope = effectScope();
  const mask = (id: string, threshold: [number, number] | null) => ({ id, name: `${id} mask`, color: '#43aa65', visible: true, opacity: .5, data: new Uint8Array([1, 0, 1, 0]), threshold, revision: 2 });
  const props = reactive({ masks: [mask('a', [100, 300]), mask('b', null)], activeMaskId: 'b', busy: false, progress: 0, error: '' });
  const events: { name: string; args: any[] }[] = [];
  const view = setupWithoutMount(() => scope.run(() => component.setup(props, { emit: (name: string, ...args: any[]) => events.push({ name, args }), expose: () => {} })));
  return { props, events, view, close: () => scope.stop() };
}

test('native Calculate 3D flow selects source masks, emits full-resolution Optimal and stays open', async () => {
  const h = await calculationHarness(), before = h.props.masks.map(mask => ({ data: mask.data.slice(), threshold: mask.threshold?.slice(), revision: mask.revision }));
  try {
    assert.deepEqual(h.view.selectedIds.value, ['b']);
    h.view.selectRow('a', true); h.view.calculate();
    assert.deepEqual(h.events, [{ name: 'calculate', args: [{ maskIds: ['a', 'b'], quality: 'optimal', step: [1, 1, 1], topology: 'native-table' }] }]);
    assert.equal(h.events.some(event => event.name === 'close'), false);
    const request = h.events[0]!.args[0]; request.maskIds.length = 0; request.step[0] = 9;
    h.view.calculate(); assert.deepEqual(h.events.at(-1)!.args[0].maskIds, ['a', 'b']); assert.deepEqual(h.events.at(-1)!.args[0].step, [1, 1, 1]);
    h.view.close(); assert.equal(h.events.at(-1)!.name, 'close');
    h.props.masks.forEach((mask, i) => { assert.deepEqual(mask.data, before[i]!.data); assert.deepEqual(mask.threshold, before[i]!.threshold ?? null); assert.equal(mask.revision, before[i]!.revision); });
  } finally { h.close(); }
});

test('Calculate 3D Custom Options emits explicit XYZ, smoothing, reduction and topology without changing Optimal', async () => {
  const h = await calculationHarness();
  try {
    h.view.quality.value = 'custom'; h.view.optionsOpen.value = true; h.view.step.value = [2, 3, 4];
    h.view.smoothEnabled.value = true; h.view.smoothIterations.value = 7; h.view.smoothFactor.value = .45; h.view.compensateShrinkage.value = true;
    h.view.reduceEnabled.value = true; h.view.remainingPercent.value = 35; h.view.tolerance.value = .2; h.view.featureAngle.value = 60; h.view.reduceIterations.value = 8; h.view.resolveAmbiguous.value = true;
    h.view.finishOptions(); assert.equal(h.view.optionsOpen.value, false); assert.equal(h.events.length, 0);
    h.view.calculate();
    const request = h.events[0]!.args[0];
    assert.deepEqual(request, { maskIds: ['b'], quality: 'custom', step: [2, 3, 4], topology: 'resolved', smooth: { iterations: 7, factor: .45, compensateShrinkage: true, preserveBoundary: true }, reduction: { targetRatio: .35, tolerance: .2, featureAngle: 60, iterations: 8, preserveBoundary: true } });
    h.view.step.value[0] = 5; h.view.smoothFactor.value = .1; assert.deepEqual(request.step, [2, 3, 4]); assert.equal(request.smooth.factor, .45);
    h.view.quality.value = 'optimal'; h.view.calculate();
    assert.deepEqual(h.events.at(-1)!.args[0], { maskIds: ['b'], quality: 'optimal', step: [1, 1, 1], topology: 'native-table' });
    h.view.quality.value = 'custom'; h.view.smoothEnabled.value = false; h.view.reduceEnabled.value = false; h.view.calculate();
    assert.equal('smooth' in h.events.at(-1)!.args[0], false); assert.equal('reduction' in h.events.at(-1)!.args[0], false);
  } finally { h.close(); }
});

test('Calculate 3D rejects empty or stale selection and invalid Custom parameters before emitting', async () => {
  const h = await calculationHarness();
  try {
    h.view.toggleMask('b'); h.view.calculate(); assert.equal(h.events.length, 0); assert.match(h.view.localError.value, /至少一个 Mask/);
    h.view.selectRow('a', false); h.view.quality.value = 'custom';
    for (const step of [[0, 1, 1], [1, 1.5, 1], [1, 1, NaN]]) { h.view.step.value = step; h.view.calculate(); assert.equal(h.events.length, 0); assert.match(h.view.localError.value, /采样步长/); }
    h.view.step.value = [1, 1, 1]; h.view.smoothEnabled.value = true; h.view.smoothFactor.value = 2; h.view.calculate(); assert.equal(h.events.length, 0); assert.match(h.view.localError.value, /平滑/);
    h.view.smoothEnabled.value = false; h.view.reduceEnabled.value = true; h.view.remainingPercent.value = 0; h.view.calculate(); assert.equal(h.events.length, 0); assert.match(h.view.localError.value, /减面/);
    h.view.reduceEnabled.value = false; h.props.masks = h.props.masks.filter(mask => mask.id !== 'a'); h.view.calculate(); assert.equal(h.events.length, 0); assert.match(h.view.localError.value, /至少一个 Mask/);
    assert.deepEqual(h.view.selectedIds.value, []);
  } finally { h.close(); }
});

test('Calculate 3D busy state preserves selection, shows bounded progress, cancels once and leaves Close explicit', async () => {
  const h = await calculationHarness();
  try {
    h.props.busy = true; h.props.progress = 1.5; h.view.calculate(); h.view.close(); h.view.toggleMask('a'); h.view.selectRow('a', false);
    assert.equal(h.events.length, 0); assert.deepEqual(h.view.selectedIds.value, ['b']); assert.equal(h.view.progressFraction.value, 1);
    h.view.escape(); h.view.cancel(); assert.deepEqual(h.events, [{ name: 'cancel', args: [] }]);
    h.props.busy = false; h.props.error = '批量计算失败，源 Mask 已保留'; assert.equal(h.view.shownError.value, h.props.error);
    h.view.optionsOpen.value = true; h.view.escape(); assert.equal(h.view.optionsOpen.value, false); assert.equal(h.events.length, 1);
    h.view.escape(); assert.equal(h.events.at(-1)!.name, 'close');
  } finally { h.close(); }
});
