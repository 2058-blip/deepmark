import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import ts from 'typescript';
import {effectScope,shallowReactive,proxyRefs} from 'vue';
import {meshToReference,meshFromReference} from '../src/mimics/meshExchange.ts';
import {exportSTL,parseSTL} from '../src/mimics/geometry.ts';
import {parseNifti,exportNifti} from '../src/core.ts';
import {createProject,volumeGrid,encodeProject,decodeProject} from '../src/mimics/project.ts';
import {resliceProject} from '../src/mimics/resliceProjectGeometry.ts';
import {buildReslicedProject} from '../src/mimics/resliceProjectData.ts';
import {physicalPoint,type TriangleMesh} from '../src/mimics/types.ts';
import type {NiftiReference} from '../src/mimics/niftiReference.ts';

const transform=():NiftiReference=>({frame:'RAS',applicationToReference:[[0,-1,0,10],[1,0,0,-20],[0,0,1,5],[0,0,0,1]]});
const mesh=():TriangleMesh=>({positions:new Float32Array([1,2,3,1,4,3,1,2,5]),indices:new Uint32Array([0,1,2]),normals:new Float32Array([1,0,0,1,0,0,1,0,0])});
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`),point=(a:readonly number[],b:readonly number[])=>a.forEach((n,k)=>near(n,b[k]!));

test('default STL exchange applies rigid point translation/rotation, rotates normals as vectors and preserves triangle winding',()=>{
  const source=mesh(),before=structuredClone(source),reference=transform(),snapshot=structuredClone(reference),result=meshToReference(source,reference);assert.deepEqual([...result.positions],[8,-19,8,6,-19,8,8,-19,10]);assert.deepEqual([...result.normals!],[0,1,0,0,1,0,0,1,0]);assert.deepEqual(result.indices,source.indices);assert.notEqual(result.positions,source.positions);assert.notEqual(result.indices,source.indices);assert.notEqual(result.normals,source.normals);assert.deepEqual(meshFromReference(result,reference),source);assert.deepEqual(source,before);assert.deepEqual(reference,snapshot);
});

test('application mode and no-reference legacy meshes are independent identity copies in either direction',()=>{
  const source=mesh();for(const operation of [meshToReference,meshFromReference])for(const [reference,frame] of [[undefined,undefined],[undefined,'application'],[transform(),'application']] as const){const result=operation(source,reference,frame);assert.deepEqual(result,source);assert.notEqual(result.positions.buffer,source.positions.buffer);assert.notEqual(result.indices.buffer,source.indices.buffer);assert.notEqual(result.normals!.buffer,source.normals!.buffer);}const aligned={...transform(),frame:'source-aligned' as const};assert.deepEqual(meshToReference(source,aligned),meshToReference(source,transform()),'source-aligned file coordinates still use their recorded rigid mapping');
});

test('STL exchange respects typed-array view offsets and preserves optional normals without inventing or normalizing them',()=>{
  const buffer=new Float32Array([99,...mesh().positions,99]),source={positions:buffer.subarray(1,10),indices:new Uint32Array([99,0,1,2,99]).subarray(1,4)},result=meshToReference(source,transform());assert.equal(result.positions.length,9);assert.equal(result.normals,undefined);assert.deepEqual([...result.indices],[0,1,2]);const nonUnit=mesh();nonUnit.normals!.fill(0);nonUnit.normals![0]=2;const rotated=meshToReference(nonUnit,transform());assert.deepEqual([...rotated.normals!].slice(0,3),[0,2,0]);assert.equal(buffer[0],99);assert.equal(buffer[10],99);
});

test('wrong coordinate modes, invalid rigid references and corrupted mesh buffers fail atomically',()=>{
  const source=mesh(),before=structuredClone(source);for(const operation of [meshToReference,meshFromReference]){
    for(const frame of [null,'RAS','local',false,3])assert.throws(()=>operation(source,transform(),frame as any),/坐标选项/);
    for(const invalid of [{...transform(),frame:'LPS'},{...transform(),extra:1},{...transform(),applicationToReference:[[2,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]},{...transform(),applicationToReference:[[-1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]},{...transform(),applicationToReference:[[1,.1,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}])for(const frame of ['reference','application'] as const)assert.throws(()=>operation(source,invalid as any,frame));
    const corrupt:any[]=[{...source,positions:new Float64Array(source.positions)},{...source,indices:new Uint16Array([0,1,2])},{...source,positions:new Float32Array([1,2])},{...source,indices:new Uint32Array([0,1])},{...source,indices:new Uint32Array([0,1,3])},{...source,normals:new Float32Array(6)},{...source,normals:new Float32Array([NaN,0,0,0,0,0,0,0,0])},{...source,positions:new Float32Array([Infinity,0,0,0,0,0,0,0,0])}];for(const invalid of corrupt)assert.throws(()=>operation(invalid,transform()));
  }assert.deepEqual(source,before);let reads=0;const getter={...source};Object.defineProperty(getter,'positions',{get(){reads++;return source.positions;}});assert.throws(()=>meshToReference(getter,transform()));assert.equal(reads,0);
});

test('shared/detached buffers and Float32 transformation overflow do not return partial output or alter source data',()=>{
  const source=mesh(),before=structuredClone(source);if(typeof SharedArrayBuffer!=='undefined')assert.throws(()=>meshToReference({...source,positions:new Float32Array(new SharedArrayBuffer(source.positions.byteLength))},transform()),/ArrayBuffer/);const detached=source.positions.slice();structuredClone(detached,{transfer:[detached.buffer]});assert.throws(()=>meshToReference({...source,positions:detached},transform()),/分离/);const overflow=transform();overflow.applicationToReference[0]![3]=1e100;assert.throws(()=>meshToReference(source,overflow),/Float32/);assert.deepEqual(source,before);
});

function localVolume(){
  const bytes=new Uint8Array(352+125*4),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[5,5,5].forEach((n,k)=>{h.setInt16(42+2*k,n,true);h.setFloat32(80+4*k,[1,2,3][k]!,true);});h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);h.setInt16(254,1,true);[[1,0,0,0],[0,2,0,0],[0,0,3,0]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+4*c,n,true)));bytes.set([110,43,49,0],344);const volume=parseNifti(bytes.buffer,'patient-source.nii'),state=createProject(volume);state.masks[0]!.data.fill(1);const sample=resliceProject(volumeGrid(volume),{start:[0,4,6],end:[4,4,6],up:[0,0,1],width:3,height:3,pixelSize:1,sliceDistance:1,updateCoordinateSystem:true},state.masks);return buildReslicedProject(volume,state,sample,{name:'Local CS',copyWorldObjects:true,updateCoordinateSystem:true});
}

test('real local-CS STL export aligns with standalone Mask NIfTI reference coordinates and ZIP reference metadata',()=>{
  const output=localVolume(),local:TriangleMesh={positions:new Float32Array([0,0,0,2,0,0,0,2,0]),indices:new Uint32Array([0,1,2]),normals:new Float32Array([0,0,1,0,0,1,0,0,1])};output.state.parts=[{id:'surface',name:'Local surface',visible:true,color:'#ffff00',opacity:1,mesh:local}];output.state.selectedPartId='surface';const snapshot=structuredClone(output),exchanged=meshToReference(local,output.volume.niftiReference),stl=parseSTL(exportSTL(exchanged) as Uint8Array),mask=parseNifti(exportNifti(output.volume,Uint16Array.from(output.state.masks[0]!.data))),indices=[[0,0,0],[2,0,0],[0,2,0]];
  for(let i=0;i<3;i++){const expected=physicalPoint(indices[i]!,volumeGrid(mask));point([...exchanged.positions.slice(3*i,3*i+3)],expected);point([...stl.positions.slice(3*i,3*i+3)],expected);}point([...exchanged.positions.slice(0,3)],[0,3,5]);assert.deepEqual(meshFromReference(exchanged,output.volume.niftiReference),local);const restored=decodeProject(encodeProject(output.volume,output.state));assert.deepEqual(meshToReference(restored.state.parts[0]!.mesh,restored.volume.niftiReference),exchanged);assert.deepEqual(output,snapshot);
});

const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.children)]:[];
const text=(node:any):string=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.children):'';
const controls=(async()=>{const url=new URL('../src/mimics/STLCoordinateControls.vue',import.meta.url),descriptor=parse(await readFile(url,'utf8'),{filename:url.pathname}).descriptor,script=compileScript(descriptor,{id:'stl-controls-test'}),template=compileTemplate({source:descriptor.template!.content,filename:url.pathname,id:'stl-controls-test',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(_all,q,spec)=>`from ${q}${spec.startsWith('.')?new URL(spec,url).href:import.meta.resolve(spec)}${q}`),load=(code:string)=>import('data:text/javascript;base64,'+Buffer.from(compile(code)).toString('base64'));const c=(await load(script.content)).default;c.render=(await load(template.code)).render;return c;})();

test('STL coordinate controls expose the reference/application decision only when meaningful and honor busy/invalid changes',async()=>{
  const c=await controls,scope=effectScope(),props=shallowReactive({frame:'reference',hasReference:true,busy:false}),events:any[]=[],view=scope.run(()=>c.setup(props,{emit:(name:string,...args:any[])=>events.push([name,...args]),expose:()=>{}}));try{const tree=c.render({},[],props,proxyRefs(view),{},{}),select=nodes(tree).find(n=>n.type==='select');assert.ok(select);assert.equal(select.props.value,'reference');assert.match(text(tree),/参考坐标（与 NIfTI 对齐）/);assert.match(text(tree),/应用坐标/);select.props.onChange({target:{value:'application'}});assert.deepEqual(events,[['change','application']]);assert.equal(props.frame,'reference','the control requests a parent change instead of mutating props');view.change({target:{value:'RAS'}});props.busy=true;view.change({target:{value:'reference'}});assert.equal(nodes(c.render({},[],props,proxyRefs(view),{},{})).find(n=>n.type==='select').props.disabled,true);props.hasReference=false;assert.equal(nodes(c.render({},[],props,proxyRefs(view),{},{})).some(n=>n.type==='select'),false);view.change({target:{value:'reference'}});assert.equal(events.length,1);}finally{scope.stop();}
});
