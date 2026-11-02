import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sliceBox,sliceCoords,dragWindowLevel,slicePageIndex} from '../src/sliceGeometry.ts';

test('panning translates the displayed image and keeps the same voxel under the translated pointer',()=>{
  const original=sliceBox([700,500],512,396,.875,1,1.7);
  const moved=sliceBox([700,500],512,396,.875,1,1.7,[73,-41]);
  const originalVoxel=sliceCoords(original,340,240);
  const movedVoxel=sliceCoords(moved,413,199);
  assert.deepEqual(movedVoxel,originalVoxel);
  assert.notDeepEqual(sliceCoords(moved,340,240),originalVoxel);
  assert.equal(moved.w,original.w);assert.equal(moved.h,original.h);
  assert.equal(sliceCoords(moved,moved.ox-1,moved.oy+20),null);
});

test('zoom and pan do not change physical slice proportions or the inverse image mapping',()=>{
  for(const zoom of [.25,1,3,8]){
    const base=sliceBox([640,480],96,64,.7,1.4,zoom);
    const moved=sliceBox([640,480],96,64,.7,1.4,zoom,[-120,85]);
    const imageCenter=[base.ox+base.w/2,base.oy+base.h/2];
    const result=sliceCoords(moved,imageCenter[0]-120,imageCenter[1]+85)!;
    assert.ok(Math.abs(result[0]-47.5)<1e-10);assert.ok(Math.abs(result[1]-31.5)<1e-10);
    assert.equal(moved.w/moved.h,base.w/base.h);
    assert.deepEqual(sliceBox([640,480],96,64,.7,1.4,zoom,[0,0]),base);
  }
});

test('right-drag window level changes display center and width independently with a one-unit width floor',()=>{
  const initial={center:-600,width:1500};
  const horizontal=dragWindowLevel(initial.center,initial.width,40,0);
  assert.equal(horizontal.center,initial.center);assert.ok(horizontal.width>initial.width);
  const vertical=dragWindowLevel(initial.center,initial.width,0,40);
  assert.equal(vertical.width,initial.width);assert.ok(vertical.center>initial.center);
  assert.equal(dragWindowLevel(initial.center,initial.width,-1e6,0).width,1);
  assert.deepEqual(dragWindowLevel(initial.center,initial.width,0,0),initial);
  assert.deepEqual(initial,{center:-600,width:1500});
});

test('editable slice pages use one-based numbers, clamp to image bounds and reject unfinished or invalid input',()=>{
  assert.equal(slicePageIndex('1',320),0);assert.equal(slicePageIndex('128',320),127);assert.equal(slicePageIndex('320',320),319);
  assert.equal(slicePageIndex('0',320),0);assert.equal(slicePageIndex('-4',320),0);assert.equal(slicePageIndex('999',320),319);
  assert.equal(slicePageIndex('2',1),0);assert.equal(slicePageIndex(' 12 ',320),11);
  for(const input of ['', ' ', '-', 'abc', '1.5', 'NaN', 'Infinity', '1e309'])assert.equal(slicePageIndex(input,320),null,input);
  assert.equal(slicePageIndex('2',0),null);assert.equal(slicePageIndex('2',NaN),null);
});
