import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {shallowReactive} from 'vue';
import {foreignMaskLookup,gridViewportLookup,paintForeignGrid,createForeignGridPattern} from '../src/workbench/foreignGrid.ts';
import {WorkbenchClaims} from '../src/workbench/claims.ts';
import {diffMaskPackets} from '../src/workbench/maskRuns.ts';
import {createSliceViewport,sliceToScreen,screenToSlice} from '../mimics-workbench/src/mimics/viewportGeometry.ts';
import {imageHoverIndex,mprHoverLookup} from '../src/workbench/hover.ts';
import {mprBrushPreviewIndices} from '../mimics-workbench/src/mimics/mprBrushPreview.ts';
import type {MaskObject,MprPlane,Vec3,VolumeGrid} from '../mimics-workbench/src/mimics/types.ts';

function mask(id:string,indices:number[],count=64):MaskObject{
  const data=new Uint8Array(count);for(const index of indices)data[index]=1;
  return{id,name:id,data,color:'#ff8800',visible:true,opacity:.5,threshold:null,revision:0};
}
async function claim(claims:WorkbenchClaims,id:string,author:string,indices:number[],remove=false){
  const bits=new Uint8Array(64);for(const index of indices)bits[index]=1;
  for await(const packet of diffMaskPackets(remove?bits:null,remove?new Uint8Array(64):bits,[4,4,4]))claims.apply(id,author,packet,64);
}

test('foreign lookup uses voxel authors, keeps mixed-author overlap protected and ignores unrecorded membership',async()=>{
  const masks=[mask('shared',[0,1,2,3]),mask('unknown',[4])],claims=new WorkbenchClaims();
  await claim(claims,'shared','me',[0,2]);await claim(claims,'shared','other',[1,2,5]);
  const before=masks.map(value=>value.data.slice()),lookup=foreignMaskLookup(masks,claims,'me')!;
  assert.equal(lookup(0),false);assert.equal(lookup(1),true);assert.equal(lookup(2),true);
  assert.equal(lookup(3),false);assert.equal(lookup(4),false);assert.equal(lookup(5),false,'a stale claim outside current membership is invisible');
  for(const index of [-1,64,NaN,Infinity,.5])assert.equal(lookup(index),null);
  assert.deepEqual(masks.map(value=>value.data),before);
  assert.deepEqual(claims.authorsAt('shared',2),['me','other']);
  assert.equal(foreignMaskLookup([],claims,'me'),null);
  assert.equal(foreignMaskLookup([masks[1]!],claims,'me'),null,'unrecorded members do not enable the overlay');
  const own=mask('own',[0]);await claim(claims,'own','me',[0]);
  assert.equal(foreignMaskLookup([own],claims,'me'),null,'own-only masks do not enable the overlay');
});

test('foreign lookup omits hidden and zero-opacity masks and responds to removed claims',async()=>{
  const masks=[mask('visible',[1]),mask('hidden',[2]),mask('transparent',[3])],claims=new WorkbenchClaims();
  for(const value of masks)await claim(claims,value.id,'other',[1,2,3]);
  masks[1]!.visible=false;masks[2]!.opacity=0;
  const lookup=foreignMaskLookup(masks,claims,'me')!;
  assert.equal(lookup(1),true);assert.equal(lookup(2),false);assert.equal(lookup(3),false);
  await claim(claims,'visible','other',[1],true);assert.equal(lookup(1),false);
  assert.equal(foreignMaskLookup(masks,claims,'other'),null);
  await claim(claims,'visible','other',[2,3],true);
  assert.equal(foreignMaskLookup(masks,claims,'me'),null,'hidden and zero-opacity foreign masks do not enable the overlay');
});

test('source slice lookup follows anisotropic/sheared affine geometry for every axis without changing inputs',()=>{
  const grid:VolumeGrid={dims:[4,5,6],spacing:[2,3,4],data:new Float32Array(120),affine:[[2,1,.4,100],[0,3,.5,-20],[0,0,-4,50],[0,0,0,1]]};
  const point:Vec3=[1,2,3],before=JSON.stringify({grid,point});
  for(const axis of [0,1,2] as const){
    const view=createSliceViewport(grid,axis,[420,360],1.3,[11,-7]),lookup=gridViewportLookup({grid,axis,point,view});
    const a=view.a,b=view.b;
    for(let u=0;u<grid.dims[a];u++)for(let v=0;v<grid.dims[b];v++){
      const voxel=[...point] as Vec3;voxel[a]=u;voxel[b]=v;
      const screen=sliceToScreen(view,voxel),index=voxel[0]+grid.dims[0]*(voxel[1]+grid.dims[1]*voxel[2]);
      assert.equal(lookup(...screen),index);
    }
    assert.equal(lookup(-10000,-10000),null);assert.equal(lookup(NaN,0),null);
  }
  assert.equal(JSON.stringify({grid,point}),before);
  assert.equal(gridViewportLookup({grid,view:null})(0,0),null);
});

test('MPR screen lookup matches native nearest mask samples, support and Y direction for reflected/sheared grids',()=>{
  const grids:VolumeGrid[]=[
    {dims:[4,5,6],spacing:[1,2,3],data:new Float32Array(120)},
    {dims:[4,5,6],spacing:[2,3,4],affine:[[2,1,0,100],[0,3,0,-20],[0,0,-4,50],[0,0,0,1]],data:new Float32Array(120)},
  ];
  const planes:MprPlane[]=[
    {origin:[-.5,0,0],u:[.5,0,0],v:[0,1,0],size:[10,8]},
    {origin:[99,-20,50],u:[1,0,0],v:[0,3,0],size:[10,8]},
    {origin:[100,-20,48],u:[0,0,-2],v:[1,1.5,0],size:[10,8]},
  ];
  for(const grid of grids)for(const plane of planes){
    const before=JSON.stringify({grid,plane}),native=mprBrushPreviewIndices(grid,plane),view={nx:plane.size[0],ny:plane.size[1],left:17,top:23,dx:Math.hypot(...plane.u),dy:Math.hypot(...plane.v),scale:2.25};
    const lookup=gridViewportLookup({grid,plane,view}),screen=(x:number,y:number):[number,number]=>[view.left+(x+.5)*view.dx*view.scale,view.top+(view.ny-y-.5)*view.dy*view.scale];
    for(let y=0;y<plane.size[1];y++)for(let x=0;x<plane.size[0];x++){
      const expected=native[x+y*plane.size[0]]!;
      assert.equal(lookup(...screen(x,y)),expected<0?null:expected);
      assert.equal(lookup(...screen(x+.2,y-.2)),expected<0?null:expected);
    }
    assert.equal(lookup(...screen(-.50001,0)),null);assert.equal(lookup(...screen(plane.size[0]-.49999,0)),null);assert.equal(lookup(Infinity,0),null);
    assert.equal(JSON.stringify({grid,plane}),before);
  }
});

test('crosshatch clears old pixels and clips faint diagonal lines to foreign members',()=>{
  const width=24,height=24,pixels=new Uint8ClampedArray(width*height*4);pixels.fill(123);
  let queried=0;
  const indexAt=(x:number,y:number)=>{queried++;return x<18&&y<18?Math.floor(x)+24*Math.floor(y):null;};
  const lockedAt=(index:number)=>index%24<8;
  const count=paintForeignGrid(pixels,width,height,24,24,indexAt,lockedAt);
  let actual=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const value=pixels.slice(4*(x+y*width),4*(x+y*width+1)),alpha=value[3]!;
    if(alpha){actual++;assert.ok(x<8&&y<18);assert.ok(alpha<=64);assert.deepEqual([...value.slice(0,3)],[255,255,255]);}
    else assert.deepEqual(value,new Uint8ClampedArray(4));
  }
  assert.equal(count,actual);assert.ok(count>0);assert.ok(queried<width*height,'queries only grid lines');
  assert.ok(pixels[3]!>0);
  assert.equal(paintForeignGrid(pixels,width,height,24,24,()=>0,()=>false),0);assert.ok(pixels.every(value=>value===0));
});

test('crosshatch has both diagonal families, denser spacing and no darkened intersections',()=>{
  const width=36,pixels=new Uint8ClampedArray(width*width*4);
  paintForeignGrid(pixels,width,width,width,width,()=>0,()=>true);
  const alpha=(x:number,y:number)=>pixels[4*(x+y*width)+3]!;
  for(const[x,y]of [[2,2],[3,3],[1,7],[2,6],[13,4],[4,13]])assert.ok(alpha(x!,y!)>0,'both diagonal directions and 9px repeats are visible');
  assert.equal(alpha(4,2),0,'the pattern does not draw horizontal or vertical cross bars');
  assert.equal(alpha(4,4),alpha(2,2),'X crossings do not compound the two opacities');
  const crossings=[];for(let x=0;x<width;x++)if(alpha(x,2)>0&&(x===0||alpha(x-1,2)===0))crossings.push(x);
  assert.ok(crossings.length>width/12,'the 9px diagonal pattern is denser than the former 12px grid');
  assert.ok(pixels.every((value,index)=>index%4!==3||value<=64),'no pixel retains the opaque white or dark backing line');
});

test('thin diagonal spacing follows CSS coordinates without disappearing in reduced raster resolution',()=>{
  for(const factor of [.5,1,2]){
    const width=36*factor,height=36*factor,pixels=new Uint8ClampedArray(width*height*4);
    paintForeignGrid(pixels,width,height,36,36,()=>0,()=>true);
    const alpha=(x:number,y:number)=>pixels[4*(Math.floor(x*factor)+Math.floor(y*factor)*width)+3]!;
    assert.ok(alpha(6,6)>0,'the main diagonal survives pixel-footprint integration');
    assert.ok(alpha(13,4)>0,'the 9 CSS pixel diagonal repeat survives reduced canvas');
    assert.equal(alpha(4,0),0,'clear space between hatch strokes remains transparent');
  }
});

test('cached crosshatch keeps the exact previous pixel output at fractional and reduced viewport scales',()=>{
  // Independent goldens captured from the uncached painter before this optimization.
  const cases=[
    {w:36,h:36,lw:36,lh:36,count:378,hash:'f2094cc463b2f0022d341c905116f84d93e270beae5ed42564447e581dde20a0'},
    {w:20,h:15,lw:31.7,lh:22.9,count:95,hash:'726e3dd9ae46b3c42a04da104369a829f91bb66e321e72b117a8dc09cee2a9b4'},
    {w:72,h:54,lw:36,lh:27,count:646,hash:'56ca84a2f1d2e0d141331a74f77e14340d223fa6b8dceb43bbec8534bb2dd8d9'},
    {w:123,h:81,lw:123.7,lh:81.3,count:2990,hash:'32cc73312bf9ebfc02ceb8047ea8b8524c479266bb6f2390bb9bce9cc196cbf0'},
  ];
  for(const {w,h,lw,lh,count,hash}of cases){
    const cached=new Uint8ClampedArray(w*h*4),uncached=cached.slice(),pattern=createForeignGridPattern(w,h,lw,lh),beforeSamples=pattern.samples.slice(),beforeAlphas=pattern.alphas.slice();
    const lookup=(x:number,y:number)=>x>=3&&y>=2&&x<lw-2&&y<lh-1?Math.floor(x/2)+1000*Math.floor(y/2):null,locked=(index:number)=>index%11<7;
    assert.equal(paintForeignGrid(cached,w,h,lw,lh,lookup,locked,pattern),count);
    assert.equal(paintForeignGrid(uncached,w,h,lw,lh,lookup,locked),count);
    assert.deepEqual(cached,uncached);assert.equal(createHash('sha256').update(cached).digest('hex'),hash);
    assert.deepEqual(pattern.samples,beforeSamples);assert.deepEqual(pattern.alphas,beforeAlphas);
    // Membership/camera changes use the same fixed screen texture, not stale coverage.
    paintForeignGrid(cached,w,h,lw,lh,(x,y)=>lookup(x+2,y-1),locked,pattern);
    paintForeignGrid(uncached,w,h,lw,lh,(x,y)=>lookup(x+2,y-1),locked);
    assert.deepEqual(cached,uncached);
    assert.equal(paintForeignGrid(cached,w,h,lw,lh,lookup,()=>false,pattern),0);assert.ok(cached.every(value=>value===0));
  }
});

test('pattern reuse checks raster and logical sizes; invalid budgets never allocate a pattern',()=>{
  const old=createForeignGridPattern(24,24,24,24),a=new Uint8ClampedArray(25*24*4),b=a.slice();
  paintForeignGrid(a,25,24,24.5,24,()=>0,()=>true,old);
  paintForeignGrid(b,25,24,24.5,24,()=>0,()=>true);assert.deepEqual(a,b);
  const changedLogical=new Uint8ClampedArray(24*24*4),expected=changedLogical.slice();
  paintForeignGrid(changedLogical,24,24,27,19,()=>0,()=>true,old);
  paintForeignGrid(expected,24,24,27,19,()=>0,()=>true);assert.deepEqual(changedLogical,expected);
  assert.ok(old.samples instanceof Uint32Array);assert.ok(old.alphas instanceof Uint8Array);
  assert.equal(old.samples.length,old.alphas.length);assert.ok(old.samples.length<24*24);
  for(const values of [[0,24,24,24],[-1,24,24,24],[1.5,24,24,24],[24,24,Infinity,24],[24,24,24,0],[5000,5000,5000,5000]])
    assert.throws(()=>createForeignGridPattern(...values as [number,number,number,number]),RangeError);
  let queries=0;assert.equal(paintForeignGrid(a,0,24,24,24,()=>{queries++;return 0;},()=>true),0);assert.equal(queries,0);assert.ok(a.every(value=>value===0));
});

function randomSequence(){let seed=0x61d4e33;return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};}

test('scalar ordinary projection matches the existing nearest slice lookup across random shear, margins and camera poses',()=>{
  const random=randomSequence();
  for(let run=0;run<32;run++){
    const dims:Vec3=[3+Math.floor(random()*17),3+Math.floor(random()*19),3+Math.floor(random()*13)],spacing:Vec3=[.4+random()*3,.4+random()*4,.4+random()*2];
    const grid:VolumeGrid={dims,spacing,data:new Float32Array(dims[0]*dims[1]*dims[2]),affine:[[spacing[0],random()-.5,random()-.5,1000],[0,spacing[1],random()-.5,-2000],[0,0,(run%2?-1:1)*spacing[2],50],[0,0,0,1]]};
    for(const axis of [0,1,2] as const){
      const point=dims.map(n=>Math.floor(random()*n)) as Vec3,width=60+random()*460,height=60+random()*360,view=createSliceViewport(grid,axis,[width,height],.2+random()*4,[random()*80-40,random()*80-40]);
      const input=shallowReactive({grid,axis,point,view}),actual=gridViewportLookup(input),expected=(x:number,y:number)=>imageHoverIndex(screenToSlice(view,[x,y],point[axis]),dims,axis,point[axis]);
      for(let n=0;n<250;n++){const x=random()*(width+80)-40,y=random()*(height+80)-40;assert.equal(actual(x,y),expected(x,y));}
      const [a,,c,d,e,f]=view.transform;
      for(const u of [-1.1e-9,-1e-9,0,.5,view.nx-.5,view.nx,view.nx+1e-9,view.nx+1.1e-9])for(const v of [0,.5,view.ny-.5,view.ny]){
        const x=a*u+c*v+e,y=d*v+f;assert.equal(actual(x,y),expected(x,y));
      }
    }
  }
});

test('scalar MPR projection matches existing affine sampling and half-cell rounding with reactive inputs',()=>{
  const random=randomSequence();
  for(let run=0;run<32;run++){
    const grid:VolumeGrid={dims:[13,17,19],spacing:[1.1,1.4,2.3],data:new Float32Array(13*17*19),affine:[[1.1,run%2?.25:0,0,100+random()*1e5],[0,1.4,.17,-300],[0,0,run%2?-2.3:2.3,700],[0,0,0,1]]};
    const plane:MprPlane={origin:[grid.affine![0]![3]!+random()*8,grid.affine![1]![3]!+random()*10,grid.affine![2]![3]!+(run%2?-1:1)*random()*20],u:[.5+random(),0,0],v:run%3?[0,.5+random()*2,0]:[0,0,.7+random()] ,size:[28,24]};
    const view={left:random()*20-10,top:random()*20-10,dx:Math.hypot(...plane.u),dy:Math.hypot(...plane.v),scale:.2+random()*4,ny:plane.size[1]},actual=gridViewportLookup(shallowReactive({grid,plane,view})),reference=mprHoverLookup(grid,plane);
    const expected=(x:number,y:number)=>reference([(x-view.left)/(view.dx*view.scale)-.5,view.ny-.5-(y-view.top)/(view.dy*view.scale)]);
    for(let n=0;n<500;n++){const x=random()*180-30,y=random()*180-30;assert.equal(actual(x,y),expected(x,y));}
    for(const u of [-.500000001,-.5,0,.5,1.4999999999999998,27.5,27.500000001])for(const v of [-.5,0,.5,23.5]){
      const x=view.left+(u+.5)*view.dx*view.scale,y=view.top+(view.ny-v-.5)*view.dy*view.scale;assert.equal(actual(x,y),expected(x,y));
    }
    assert.equal(actual(NaN,0),null);assert.equal(actual(0,Infinity),null);
  }
});

test('hot projection closures do not reread reactive geometry or allocate by traversing input properties',()=>{
  const grid:VolumeGrid={dims:[4,5,6],spacing:[1,2,3],data:new Float32Array(120)},point:Vec3=[1,2,3],view=createSliceViewport(grid,2,[200,180]);
  let reads=0;const counted=<T extends object>(object:T)=>new Proxy(object,{get(target,key,receiver){reads++;return Reflect.get(target,key,receiver);}});
  const lookup=gridViewportLookup(counted({grid:counted(grid),axis:2 as const,point:counted(point),view:counted(view)})),before=reads;
  for(let n=0;n<1000;n++)lookup(n%200,n%180);assert.equal(reads,before);
  const plane:MprPlane={origin:[0,0,0],u:[1,0,0],v:[0,2,0],size:[4,5]},mprView={left:0,top:0,dx:1,dy:2,scale:2,ny:5};
  const mprLookup=gridViewportLookup(counted({grid:counted(grid),plane,view:counted(mprView)})),beforeMpr=reads;
  for(let n=0;n<1000;n++)mprLookup(n%20,n%20);assert.equal(reads,beforeMpr);
});
