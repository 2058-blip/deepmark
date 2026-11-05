import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportNifti,parseNifti} from '../src/core.ts';
import {parseNiftiPhaseFiles,parseNiftiTemporal} from '../src/mimics/temporalIO.ts';
import {createTemporalStudy,beginPhasePropagation,cancelPhasePropagation,finishPhasePropagation,registerPhases,validatePhaseTransform,validateTemporalStudy,validateFrameGraph} from '../src/mimics/temporal.ts';
import type {TemporalPhase} from '../src/mimics/temporal.ts';

function fixture(options:{little?:boolean;frames?:number;spatialUnit?:number;temporalUnit?:number;sform?:boolean}={}){
  const little=options.little??true,frames=options.frames??3,buffer=new ArrayBuffer(352+8*frames*2),view=new DataView(buffer);
  view.setInt32(0,348,little);view.setInt16(40,frames===1?3:4,little);
  for(let a=1;a<=3;a++){view.setInt16(40+2*a,2,little);view.setFloat32(76+4*a,a,little);}view.setInt16(48,frames,little);
  view.setInt16(70,4,little);view.setInt16(72,16,little);view.setFloat32(108,352,little);view.setFloat32(112,2,little);view.setFloat32(116,-10,little);
  view.setUint8(123,(options.spatialUnit??2)|(options.temporalUnit??16));view.setFloat32(92,25,little);view.setFloat32(136,100,little);
  if(options.sform!==false){view.setInt16(254,1,little);[[0,-2,0,7],[1,0,0,-5],[0,0,3,9]].flat().forEach((n,i)=>view.setFloat32(280+4*i,n,little));}
  new Uint8Array(buffer,344,4).set([110,43,49,0]);for(let i=0;i<8*frames;i++)view.setInt16(352+i*2,i,little);
  return buffer;
}
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);

test('NIfTI true 4D split preserves phase order, endian, scalar scaling, seconds and rotated spatial affine',()=>{
  for(const little of [true,false]){
    const input=fixture({little}),before=input.slice(0),series=parseNiftiTemporal(input,'cardiac.nii');
    assert.equal(series.frames.length,3);assert.equal(series.source,'nifti-4d');close(series.timeStep!,.025);close(series.timeOffset!,.1);series.times!.forEach((t,i)=>close(t,.1+i*.025));
    series.frames.forEach((frame,i)=>{assert.deepEqual(frame.dims,[2,2,2]);assert.deepEqual(frame.spacing,[1,2,3]);assert.deepEqual(frame.affine,[[0,-2,0,7],[1,0,0,-5],[0,0,3,9]]);assert.equal(frame.little,little);assert.deepEqual([...frame.data],Array.from({length:8},(_,j)=>(8*i+j)*2-10));assert.equal(new DataView(frame.header.buffer).getInt16(40,little),3);assert.equal(frame.header[123],2);});
    assert.notEqual(series.frames[0]!.data.buffer,series.frames[1]!.data.buffer);assert.deepEqual(input,before);
  }
});

test('metre and micron spatial units normalize complete affine, translation, spacing and exported phase headers to mm',()=>{
  for(const [spatialUnit,factor] of [[1,1000],[3,.001]] as const){
    const series=parseNiftiTemporal(fixture({spatialUnit})),frame=series.frames[1]!;
    frame.affine.forEach((row,r)=>row.forEach((n,c)=>close(n,[[0,-2,0,7],[1,0,0,-5],[0,0,3,9]][r]![c]!*factor)));
    frame.spacing.forEach((n,i)=>close(n,(i+1)*factor));assert.equal(frame.unit,'mm');
    const restored=parseNifti(exportNifti(frame,new Uint16Array(8).fill(1)));restored.affine.forEach((row,r)=>row.forEach((n,c)=>close(n,frame.affine[r]![c]!)));assert.deepEqual([...restored.data],Array(8).fill(1));
  }
});

test('qform-only 4D inputs normalize offsets and temporal microseconds',()=>{
  const input=fixture({spatialUnit:1,temporalUnit:24,sform:false}),view=new DataView(input);view.setInt16(252,1,true);view.setFloat32(268,2,true);view.setFloat32(272,-3,true);view.setFloat32(276,4,true);
  const out=parseNiftiTemporal(input);assert.deepEqual(out.frames[0]!.affine,[[1000,0,0,2000],[0,2000,0,-3000],[0,0,3000,4000]]);close(out.timeStep!,25e-6);close(out.timeOffset!,100e-6);
});

test('4D importer rejects truncation, unknown or frequency units, invalid time, channel dimensions, invalid grids and budgets',()=>{
  assert.throws(()=>parseNiftiTemporal(fixture().slice(0,-1)),/截断/);
  assert.throws(()=>parseNiftiTemporal(fixture({spatialUnit:0})),/空间单位/);
  for(const temporalUnit of [0,32,40,48])assert.throws(()=>parseNiftiTemporal(fixture({temporalUnit})),/时间单位/);
  for(const step of [0,-1,NaN,Infinity]){const input=fixture();new DataView(input).setFloat32(92,step,true);assert.throws(()=>parseNiftiTemporal(input),/时间/);}
  const channels=fixture();new DataView(channels).setInt16(40,5,true);new DataView(channels).setInt16(50,2,true);assert.throws(()=>parseNiftiTemporal(channels),/多通道/);
  const grid=fixture();new DataView(grid).setFloat32(80,0,true);assert.throws(()=>parseNiftiTemporal(grid),/间距/);
  assert.throws(()=>parseNiftiTemporal(fixture(),undefined,{maxFrames:2}),/预算/);assert.throws(()=>parseNiftiTemporal(fixture(),undefined,{maxTotalVoxels:23}),/预算/);
  const nonfinite=fixture();new DataView(nonfinite).setFloat32(112,Infinity,true);assert.throws(()=>parseNiftiTemporal(nonfinite),/缩放/);
});

test('multiple 3D files preserve supplied identity, optional irregular timing and strict physical compatibility',()=>{
  const files=[0,.03,.09].map((timeSeconds,i)=>({buffer:fixture({frames:1}),name:`p${i}.nii`,timeSeconds})),out=parseNiftiPhaseFiles(files);
  assert.deepEqual(out.times,[0,.03,.09]);assert.equal(out.timeStep,undefined);assert.deepEqual(out.frames.map(v=>v.name),['p0.nii','p1.nii','p2.nii']);
  assert.equal(parseNiftiPhaseFiles(files.map(({timeSeconds,...file})=>file)).times,undefined);
  close(parseNiftiPhaseFiles(files.map((file,i)=>({...file,timeSeconds:i*.02}))).timeStep!,.02);
  assert.throws(()=>parseNiftiPhaseFiles([{buffer:fixture()}]),/单个三维/);
  assert.throws(()=>parseNiftiPhaseFiles([files[0]!,{...files[1]!,timeSeconds:undefined}]),/全部/);
  assert.throws(()=>parseNiftiPhaseFiles([files[1]!,files[0]!]),/递增/);
  const moved=fixture({frames:1});new DataView(moved).setFloat32(292,99,true);assert.throws(()=>parseNiftiPhaseFiles([files[0]!,{buffer:moved,timeSeconds:.03}]),/网格不兼容/);
  assert.throws(()=>parseNiftiPhaseFiles(files,{maxTotalVoxels:23}),/预算/);
});

test('decoded temporal study validation rejects corrupted order, metadata, masks, provenance, graphs and pending work',()=>{
  const grid=parseNiftiTemporal(fixture({frames:1})).frames[0]!,phase=(id:string):TemporalPhase=>({id,name:id,grid,masks:id==='A'?[{id:'m',name:'M',data:new Uint8Array(8).fill(1),revision:0}]:[],revision:0,status:'unprocessed'});
  const initial=createTemporalStudy([phase('A'),phase('B')],'A'),pending=beginPhasePropagation(initial,'B'),transform=registerPhases(grid,grid,{iterations:0}),done=finishPhasePropagation(pending.study,pending.ticket,transform);
  validateTemporalStudy(initial);validateTemporalStudy(pending.study);validateTemporalStudy(done);validateTemporalStudy(structuredClone(done));
  const badOrder=structuredClone(done);badOrder.order.push('B');assert.throws(()=>validateTemporalStudy(badOrder),/顺序/);
  const badImage=structuredClone(done);badImage.phases[0]!.grid.data[0]=NaN;assert.throws(()=>validateTemporalStudy(badImage),/图像/);
  const badOrigin=structuredClone(done);badOrigin.phases[1]!.masks[0]!.origin!.transformId='missing';assert.throws(()=>validateTemporalStudy(badOrigin),/来源/);
  const badTransform=structuredClone(transform);badTransform.source.spacing=[10,2,3];assert.throws(()=>validatePhaseTransform(badTransform),/仿射/);
  const badStats=structuredClone(transform);badStats.validSampleFraction=2;assert.throws(()=>validatePhaseTransform(badStats),/统计/);
  const badPending=structuredClone(pending.study);badPending.pending!.targetRevision++;assert.throws(()=>validateTemporalStudy(badPending),/待处理/);
  assert.throws(()=>cancelPhasePropagation(pending.study,{...pending.ticket,previousStatus:'completed'}),/过期/);
  assert.throws(()=>validateFrameGraph({nodes:[],links:[],revision:-1}),/版本/);
});
