import {test} from 'node:test';
import assert from 'node:assert/strict';
import {touchPair,pinchView,touchSlice,touchTap} from '../src/touchGeometry.ts';
import {sliceBox,sliceCoords} from '../src/sliceGeometry.ts';

test('pinch scales about the touch midpoint and preserves the image point while translating',()=>{
  const size=[720,520],pan=[31,-27],zoom=1.3,start=[295,215],current=[330,240];
  const before=sliceBox(size,128,96,.8,1.2,zoom,pan),voxel=sliceCoords(before,...start as [number,number])!;
  const next=pinchView(zoom,pan,size,start,120,current,204);
  const after=sliceBox(size,128,96,.8,1.2,next.zoom,next.pan),mapped=sliceCoords(after,...current as [number,number])!;
  assert.ok(Math.abs(voxel[0]-mapped[0])<1e-10);assert.ok(Math.abs(voxel[1]-mapped[1])<1e-10);
  assert.ok(Math.abs(next.zoom-2.21)<1e-10);
  assert.deepEqual(pinchView(zoom,pan,size,start,120,start,120),{zoom,pan});
});

test('pinch translation works with fixed distance and zoom limits retain the touch anchor',()=>{
  assert.deepEqual(pinchView(2,[11,17],[600,400],[230,150],50,[260,180],50),{zoom:2,pan:[41,47]});
  for(const distance of [0,1e6]){
    const start=[210,140],next=pinchView(2,[11,17],[600,400],start,100,start,distance),scale=next.zoom/2;
    assert.equal(next.zoom,distance===0?.25:8);
    for(let axis=0;axis<2;axis++)assert.ok(Math.abs((start[axis]-[300,200][axis]-next.pan[axis])/scale-(start[axis]-[300,200][axis]-[11,17][axis]))<1e-10);
  }
});

test('coincident touch points do not create nonfinite zoom and can still translate',()=>{
  assert.deepEqual(touchPair({x:20,y:40},{x:20,y:40}),{center:[20,40],distance:0});
  assert.deepEqual(touchPair({x:0,y:0},{x:6,y:8}),{center:[3,4],distance:10});
  assert.deepEqual(pinchView(1,[0,0],[600,400],[20,40],0,[40,80],30),{zoom:1,pan:[20,40]});
  assert.deepEqual(pinchView(1,[0,0],[600,400],[20,40],NaN,[20,40],30),{zoom:1,pan:[0,0]});
});

test('single finger slice motion is stable, directional and bounded',()=>{
  assert.equal(touchSlice(20,200,164,48),22);assert.equal(touchSlice(20,200,236,48),18);
  assert.equal(touchSlice(20,200,196,48),20);assert.equal(touchSlice(20,200,183,48),20);assert.equal(touchSlice(20,200,-2000,48),47);
  assert.equal(touchSlice(20,200,2000,48),0);assert.equal(touchSlice(0,0,-100,1),0);
  assert.equal(touchSlice(20,200,180,48,10),22);assert.equal(touchSlice(20,200,182,48,0),21);
});

test('tap recognition excludes swipes and long holds',()=>{
  assert.equal(touchTap({x:10,y:20},{x:16,y:28},500),true);
  assert.equal(touchTap({x:10,y:20},{x:16,y:29},200),false);
  assert.equal(touchTap({x:10,y:20},{x:10,y:20},501),false);
  assert.equal(touchTap({x:10,y:20},{x:10,y:20},-1),false);
});
