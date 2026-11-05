import test from 'node:test';
import assert from 'node:assert/strict';
import {SlicePixels} from '../src/mimics/slicePixels.ts';
import {DisplayMaskStatisticsJob} from '../src/mimics/displayMaskStatistics.ts';
import {maskStatistics} from '../src/mimics/segmentation.ts';
import {planeAxes,planePoint,indexOf} from '../src/core.ts';
import type {Volume} from '../src/core.ts';
import type {SlicePixelInput} from '../src/mimics/slicePixels.ts';
import type {MaskObject,Axis} from '../src/mimics/types.ts';

function input():SlicePixelInput{
  const dims:[number,number,number]=[7,5,4],data=Float32Array.from({length:140},(_,i)=>Math.sin(i*.37)*100+.125);
  const volume:Volume={name:'fixture',dims,data,spacing:[.6,.8,1.1],header:new Uint8Array(348),little:true,min:-100,max:101,
    affine:[[.6,0,0,0],[0,.8,0,0],[0,0,1.1,0]],oblique:false,unit:'mm'};
  const mask=(id:string,color:string,divisor:number):MaskObject=>({id,name:id,color,visible:true,opacity:.45,threshold:null,revision:0,data:Uint8Array.from(data,(_,i)=>Number(i%divisor===0))});
  return{volume,axis:2,slice:1,masks:[mask('a','#48d7ae',3),mask('b','#ffb35c',5)],revision:0,center:23.7,width:156.3,activeMaskId:'a',draftRevision:0};
}
/** Independently retained old per-pixel formula and indexing, not the cache implementation. */
function reference(p:SlicePixelInput){
  const [a,b]=planeAxes(p.axis),nx=p.volume.dims[a],ny=p.volume.dims[b],out=new Uint8ClampedArray(nx*ny*4);
  const rgb=(color:string)=>[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];
  const masks=p.masks.filter(m=>m.visible).map(m=>({m,color:rgb(m.color)})),active=p.masks.find(m=>m.id===p.activeMaskId)?.data;
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const i=indexOf(planePoint(p.axis,p.slice,x,ny-1-y),p.volume.dims),k=4*(x+y*nx),value=p.volume.data[i]!;
    let r=Math.max(0,Math.min(255,(value-p.center+p.width/2)/Math.max(1,p.width)*255));if(p.displayInverted)r=255-r;
    let g=r,b=r;
    for(const {m,color} of masks){if(p.preview&&p.previewReplacesActive&&m.id===p.activeMaskId)continue;
      if((m.id===p.activeMaskId&&p.draft?p.draft:m.data)[i]){r=r*(1-m.opacity)+color[0]!*m.opacity;g=g*(1-m.opacity)+color[1]!*m.opacity;b=b*(1-m.opacity)+color[2]!*m.opacity;}}
    if(p.temporarySelection?.[i]){const color=active?.[i]?[255,205,60]:[184,98,235];r=r*.35+color[0]!*.65;g=g*.35+color[1]!*.65;b=b*.35+color[2]!*.65;}
    if(p.preview?.[i]){r=r*.45+255*.55;g=g*.45+205*.55;b=b*.45+60*.55;}
    out[k]=r;out[k+1]=g;out[k+2]=b;out[k+3]=255;
  }
  return out;
}
test('cached compositor is byte-identical to all original slice/overlap/preview blending modes',()=>{
  for(const axis of [0,1,2] as Axis[])for(const inverted of [false,true])for(const replacement of [false,true])for(const temporary of [false,true]){
    const p=input(),cache=new SlicePixels();p.axis=axis;p.displayInverted=inverted;p.previewReplacesActive=replacement;
    p.preview=Uint8Array.from(p.volume.data,(_,i)=>Number(i%11===0));
    p.temporarySelection=temporary?Uint8Array.from(p.volume.data,(_,i)=>Number(i%7===0)):null;
    p.draft=Uint8Array.from(p.volume.data,(_,i)=>Number(i%2===0));
    cache.render(p);assert.deepEqual(cache.pixels,reference(p));
    const stored=cache.pixels;assert.equal(cache.render(p),null);assert.equal(cache.pixels,stored);
    p.masks[1]!.opacity=1;cache.render(p);assert.deepEqual(cache.pixels,reference(p));
    p.center=-16.5;p.width=90;cache.render(p);assert.deepEqual(cache.pixels,reference(p));
    p.masks[0]!.visible=false;cache.render(p);assert.deepEqual(cache.pixels,reference(p));
  }
});
test('bounded draft repaint preserves untouched pixels, other planes, cancellation and committed masks',()=>{
  const p=input();p.draft=p.masks[0]!.data.slice();
  const caches=([0,1,2] as Axis[]).map(axis=>{const cache=new SlicePixels();cache.render({...p,axis,slice:axis===0?0:1});return cache;});
  for(let y=1;y<=3;y++)for(let x=2;x<=4;x++)p.draft[indexOf([x,y,1],p.volume.dims)]=1;
  p.draftRevision=1;p.draftBounds={min:[2,1,1],max:[4,3,1]};
  caches.forEach((cache,axis)=>{const view={...p,axis:axis as Axis,slice:axis===0?0:1},rect=cache.render(view);
    if(axis===0)assert.equal(rect,null);else{assert.ok(rect);assert.ok(rect.width<=3&&rect.height<=3);}
    assert.deepEqual(cache.pixels,reference(view));
    view.draft=null;cache.render(view);assert.deepEqual(cache.pixels,reference(view));
  });
  p.masks=[{...p.masks[0]!,data:p.draft,revision:1},p.masks[1]!];p.draft=null;p.revision++;
  const cache=new SlicePixels();cache.render(p);assert.deepEqual(cache.pixels,reference(p));
});
test('cooperative display statistics are numerically identical for empty, dense, nonfinite and affine masks',()=>{
  const p=input();
  for(const affine of [undefined,[[.6,.2,0,100],[0,.8,.1,-20],[0,0,-1.1,5]]]){
    const grid={dims:p.volume.dims,spacing:p.volume.spacing,data:p.volume.data.slice(),affine};
    grid.data[5]=NaN;grid.data[8]=Infinity;
    for(const mask of [new Uint8Array(140),new Uint8Array(140).fill(1),p.masks[0]!.data]){
      const job=new DisplayMaskStatisticsJob(grid,mask);while(!job.step(7)){}
      assert.deepEqual(job.result(),maskStatistics(grid,mask));
    }
  }
});
