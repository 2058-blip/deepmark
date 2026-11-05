import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse,compileScript} from '@vue/compiler-sfc';
import ts from 'typescript';
import {effectScope,shallowReactive} from 'vue';
import {parseNifti,type Volume} from '../src/core.ts';
import {direction,edgeDirection,displayedDirectionGrid,hasAnatomicalDirections} from '../src/view.ts';
import {createProject,volumeGrid} from '../src/mimics/project.ts';
import {resliceProject} from '../src/mimics/resliceProjectGeometry.ts';
import {buildReslicedProject} from '../src/mimics/resliceProjectData.ts';
import {referenceAffineMm,identityReferenceMatrix,validateReferenceHeader} from '../src/mimics/niftiReference.ts';
import type {Vec3} from '../src/mimics/types.ts';

function source(code=1):Volume{
  const bytes=new Uint8Array(352+125*4),h=new DataView(bytes.buffer);h.setInt32(0,348,true);h.setInt16(40,3,true);[5,5,5].forEach((n,k)=>{h.setInt16(42+k*2,n,true);h.setFloat32(80+k*4,[1,2,3][k]!,true);});h.setInt16(70,16,true);h.setInt16(72,32,true);h.setFloat32(108,352,true);h.setFloat32(112,1,true);h.setUint8(123,2);h.setInt16(254,code,true);[[1,0,0,0],[0,2,0,0],[0,0,3,0]].forEach((row,r)=>row.forEach((n,c)=>h.setFloat32(280+r*16+c*4,n,true)));bytes.set([110,43,49,0],344);for(let i=0;i<125;i++)h.setFloat32(352+i*4,i,true);return parseNifti(bytes.buffer,'patient-source.nii');
}
function resliced(options:{start:Vec3;end:Vec3;up:Vec3;code?:number;rotation?:number;update?:boolean}){
  const volume=source(options.code),state=createProject(volume),sampling=resliceProject(volumeGrid(volume),{start:options.start,end:options.end,up:options.up,rotationDegrees:options.rotation??0,width:3,height:3,pixelSize:1,sliceDistance:1,updateCoordinateSystem:options.update!==false},state.masks);
  return buildReslicedProject(volume,state,sampling,{name:'CS-local',copyWorldObjects:true,updateCoordinateSystem:options.update!==false}).volume;
}

test('legacy direction and edge labels retain their established affine/oblique behavior',()=>{
  const volume=source();assert.equal(volume.niftiReference,undefined);assert.equal(hasAnatomicalDirections(volume),true);assert.deepEqual([0,1,2].map(axis=>direction(volume,axis as 0|1|2)),['矢状位','冠状位','轴位']);assert.deepEqual([0,1,2].map(axis=>edgeDirection(volume,axis as 0|1|2,true)),['R','A','S']);volume.oblique=true;assert.equal(direction(volume,0),'I 轴');assert.equal(edgeDirection(volume,1,false),'−J');assert.equal(hasAnatomicalDirections(volume),false);volume.oblique=false;volume.affine[0]![1]=.2;assert.equal(direction(volume,0),'矢状位','legacy direct helper still honors the original oblique flag');
});

test('real CS-on permutations and sign flips label the unchanged stored slices from patient RAS instead of local XYZ',()=>{
  for(const reversed of [false,true]){
    const options={start:(reversed?[4,4,6]:[0,4,6]) as Vec3,end:(reversed?[0,4,6]:[4,4,6]) as Vec3,up:[0,0,1] as Vec3},on=resliced(options),off=resliced({...options,update:false}),before=on.data.slice();assert.doesNotThrow(()=>validateReferenceHeader(on));assert.deepEqual(on.data,off.data);assert.deepEqual(referenceAffineMm(on),referenceAffineMm(off));assert.deepEqual(on.affine,[[1,0,0,0],[0,1,0,0],[0,0,1,0]]);assert.equal(hasAnatomicalDirections(on),true);assert.deepEqual([0,1,2].map(axis=>direction(on,axis as 0|1|2)),['冠状位','轴位','矢状位']);assert.deepEqual([0,1,2].map(axis=>edgeDirection(on,axis as 0|1|2,true)),reversed?['P','S','L']:['A','S','R']);assert.deepEqual([0,1,2].map(axis=>edgeDirection(on,axis as 0|1|2,false)),reversed?['A','I','R']:['P','I','L']);assert.notDeepEqual(displayedDirectionGrid(on)!.affine,on.affine);assert.deepEqual(on.data,before);
  }
});

test('CS-on oblique reference planes and source-aligned unknown frames never claim anatomical RAS labels',()=>{
  const oblique=resliced({start:[1,3,5],end:[3,5,7],up:[0,1,0]});assert.equal(oblique.oblique,false,'application axes are locally diagonal');assert.equal(hasAnatomicalDirections(oblique),false);assert.equal(direction(oblique,2),'K 轴');assert.equal(edgeDirection(oblique,0,true),'+I');const unknown=resliced({start:[0,4,6],end:[4,4,6],up:[0,0,1],code:0});assert.equal(unknown.niftiReference!.frame,'source-aligned');assert.equal(displayedDirectionGrid(unknown),null);assert.equal(hasAnatomicalDirections(unknown),false);assert.deepEqual([0,1,2].map(axis=>edgeDirection(unknown,axis as 0|1|2,true)),['+I','+J','+K']);
});

test('reference labels retain strict shared frame/code/header validation rather than guessing patient axes from local affine',()=>{
  const volume=resliced({start:[0,4,6],end:[4,4,6],up:[0,0,1]});for(const mutation of ['frame','code','certificate']){const invalid=structuredClone(volume);if(mutation==='frame')(invalid.niftiReference as any).frame='LPS';else if(mutation==='code')new DataView(invalid.header.buffer).setInt16(254,0,true);else invalid.niftiReference!.applicationToReference[0]![3]!+=1;assert.equal(displayedDirectionGrid(invalid),null);assert.equal(hasAnatomicalDirections(invalid),false);assert.equal(direction(invalid,0),'I 轴');assert.equal(edgeDirection(invalid,1,true),'+J');}const aligned={...source(1),niftiReference:{frame:'source-aligned' as const,applicationToReference:identityReferenceMatrix()}};assert.equal(hasAnatomicalDirections(aligned),false,'source-aligned cannot use a patient-reference code as an anatomical certificate');
});

const imageComponent=(async()=>{const url=new URL('../src/mimics/ImageViewport.vue',import.meta.url),descriptor=parse(await readFile(url,'utf8'),{filename:url.pathname}).descriptor,script=compileScript(descriptor,{id:'direction-label-test'}),code=ts.transpileModule(script.content,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(_all,q,spec)=>`from ${q}${spec.startsWith('.')?new URL(spec,url).href:import.meta.resolve(spec)}${q}`);return(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;})();
async function viewport(volume:Volume){
  const c=await imageComponent,scope=effectScope(),saved={document:globalThis.document,window:globalThis.window,requestAnimationFrame:globalThis.requestAnimationFrame};(globalThis as any).document={createElement:()=>({})};(globalThis as any).window={devicePixelRatio:1};(globalThis as any).requestAnimationFrame=()=>1;const props:any=shallowReactive({volume,grid:volumeGrid(volume),axis:0,point:[0,0,0],masks:[],revision:0,center:0,width:1,tool:'navigate',diameter:6,activeMaskId:'',measurements:[],measurementLabels:{},draftPoints:[],allowEdit:false});const warn=console.warn;console.warn=()=>{};let view:any;try{view=scope.run(()=>c.setup(props,{emit:()=>{},expose:()=>{}}));}finally{console.warn=warn;}return{props,view,close:()=>{scope.stop();Object.assign(globalThis,saved);}};
}

test('actual ImageViewport uses reference label status and keeps unknown/oblique local-diagonal reslices in IJK mode',async()=>{
  const aligned=resliced({start:[0,4,6],end:[4,4,6],up:[0,0,1]}),a=await viewport(aligned);try{assert.equal(a.view.rawSlice.value,false);assert.equal(a.view.sliceLabel.value,'冠状位');assert.equal(a.view.edgeLabel(0,true),'A');}finally{a.close();}for(const volume of [resliced({start:[1,3,5],end:[3,5,7],up:[0,1,0]}),resliced({start:[0,4,6],end:[4,4,6],up:[0,0,1],code:0})]){const h=await viewport(volume);try{assert.equal(h.view.rawSlice.value,true);assert.match(h.view.sliceLabel.value,/IJK/);assert.equal(h.view.edgeLabel(0,true),'+I');}finally{h.close();}}
  const legacy=source();legacy.affine[0]![1]=.2;legacy.oblique=false;const h=await viewport(legacy);try{assert.equal(h.view.rawSlice.value,true,'legacy full-shear guard remains in place independently of the old oblique flag');}finally{h.close();}
});

test('reference-aligned patient labels remain correct when application coordinates themselves are rotated',async()=>{
  const volume=source(),angle=Math.PI/4,c=Math.cos(angle),s=Math.sin(angle),app=[[c,-2*s,0,0],[s,2*c,0,0],[0,0,3,0]],reference={frame:'RAS' as const,applicationToReference:[[c,s,0,0],[-s,c,0,0],[0,0,1,0],[0,0,0,1]]};volume.affine=app;volume.oblique=true;volume.niftiReference=reference;assert.doesNotThrow(()=>validateReferenceHeader(volume));assert.equal(hasAnatomicalDirections(volume),true);assert.equal(direction(volume,0),'矢状位');const h=await viewport(volume);try{assert.equal(h.view.rawSlice.value,false,'application-space rotation cannot hide a truly axis-aligned patient reference');assert.equal(h.view.edgeLabel(0,true),'R');}finally{h.close();}
});
