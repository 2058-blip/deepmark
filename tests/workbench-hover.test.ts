import test from 'node:test';
import assert from 'node:assert/strict';
import {annotationsAtVoxel,imageHoverIndex,mprHoverLookup} from '../src/workbench/hover.ts';
import {WorkbenchClaims} from '../src/workbench/claims.ts';
import {diffMaskPackets} from '../src/workbench/maskRuns.ts';
import {mprBrushPreviewIndices} from '../mimics-workbench/src/mimics/mprBrushPreview.ts';
import type {MaskObject,MprPlane,Vec3,VolumeGrid} from '../mimics-workbench/src/mimics/types.ts';

async function claim(claims:WorkbenchClaims,mask:string,author:string,indices:number[]){
  const data=new Uint8Array(64);for(const index of indices)data[index]=1;
  for await(const packet of diffMaskPackets(null,data,[4,4,4]))claims.apply(mask,author,packet,64);
}
function mask(id:string,name:string,indices:number[]):MaskObject{const data=new Uint8Array(64);for(const index of indices)data[index]=1;return{id,name,data,color:'#ff8800',visible:true,opacity:.5,threshold:null,revision:0};}
test('hover lists every covering Mask and every contributing author at that voxel, including offline coauthors',async()=>{
  const claims=new WorkbenchClaims(),masks=[mask('one','骨',[3,4]),mask('two','软组织',[3,5])],names=new Map([['A','作者A'],['B','作者B'],['C','作者C']]);
  await claim(claims,'one','A',[3,4]);await claim(claims,'one','B',[3]);await claim(claims,'two','C',[3,5]);
  assert.deepEqual(annotationsAtVoxel(masks,3,claims,names),[
    {id:'one',name:'骨',color:'#ff8800',authors:[{id:'A',name:'作者A'},{id:'B',name:'作者B'}]},
    {id:'two',name:'软组织',color:'#ff8800',authors:[{id:'C',name:'作者C'}]},
  ]);
  assert.deepEqual(annotationsAtVoxel(masks,4,claims,names)[0]!.authors,[{id:'A',name:'作者A'}]);
  assert.deepEqual(annotationsAtVoxel(masks,5,claims,names)[0]!.authors,[{id:'C',name:'作者C'}]);
  assert.deepEqual(annotationsAtVoxel(masks,6,claims,names),[]);
});
test('hover never invents authors, conflates equal display names, or includes hidden Masks',async()=>{
  const claims=new WorkbenchClaims(),masks=[mask('one','名称<script>',[0]),mask('two','Second',[0])],names=new Map([['A','同名'],['B','同名']]);
  await claim(claims,'one','A',[0]);await claim(claims,'one','B',[0]);
  assert.equal(annotationsAtVoxel(masks,0,claims,names)[0]!.authors.length,2);
  assert.deepEqual(annotationsAtVoxel(masks,0,claims,names)[1]!.authors,[]);
  masks[0]!.visible=false;assert.deepEqual(annotationsAtVoxel(masks,0,claims,names).map(item=>item.id),['two']);
  masks[1]!.opacity=0;assert.deepEqual(annotationsAtVoxel(masks,0,claims,names),[]);
  for(const invalid of [-1,NaN,Infinity,.5,64])assert.deepEqual(annotationsAtVoxel(masks,invalid,claims,names),[]);
});
test('slice hover uses the current slice with nearest membership and rejects unsupported points',()=>{
  const dims:Vec3=[4,5,6];assert.equal(imageHoverIndex([1,2,0],dims,2,4),1+4*(2+5*4));
  assert.equal(imageHoverIndex([-.5,4.5,0],dims,2,0),4*4);
  assert.equal(imageHoverIndex([3.5,0,0],dims,2,0),3);
  for(const p of [null,[NaN,0,0],[-.50001,0,0],[3.50001,0,0]] as (Vec3|null)[])assert.equal(imageHoverIndex(p,dims,2,0),null);
  assert.equal(imageHoverIndex([0,0,0],dims,2,6),null);
});
test('MPR hover matches native nearest Mask lookup for reflected/sheared affines, half ties and borders',()=>{
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
    const expected=mprBrushPreviewIndices(grid,plane),lookup=mprHoverLookup(grid,plane),before=JSON.stringify({dims:grid.dims,affine:grid.affine,plane});
    for(let y=0;y<plane.size[1];y++)for(let x=0;x<plane.size[0];x++){
      assert.equal(lookup([x,y]),expected[x+y*plane.size[0]]!<0?null:expected[x+y*plane.size[0]]);
      assert.equal(lookup([x+.49,y-.49]),lookup([x,y]),'screen subpixels query the rendered nearest output pixel');
    }
    assert.equal(lookup([-.50001,0]),null);assert.equal(lookup([plane.size[0]-.49999,0]),null);assert.equal(lookup([0,NaN]),null);
    assert.equal(JSON.stringify({dims:grid.dims,affine:grid.affine,plane}),before);
  }
});
