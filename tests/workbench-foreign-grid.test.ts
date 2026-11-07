import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignMaskLookup,gridViewportLookup,paintForeignGrid} from '../src/workbench/foreignGrid.ts';
import {WorkbenchClaims} from '../src/workbench/claims.ts';
import {diffMaskPackets} from '../src/workbench/maskRuns.ts';
import {createSliceViewport,sliceToScreen} from '../mimics-workbench/src/mimics/viewportGeometry.ts';
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
