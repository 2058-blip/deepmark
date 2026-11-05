import test from 'node:test';
import assert from 'node:assert/strict';
import {ellipseFrame,ellipsePoints,ellipseHandles,moveEllipse,resizeEllipse,rotateEllipse,measurementLabelAnchor,measurementLabelPosition} from '../src/mimics/ellipseGeometry.ts';
import type {MeasurementObject,Vec3} from '../src/mimics/types.ts';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const point=(a:readonly number[],b:readonly number[])=>a.forEach((v,k)=>near(v,b[k]!));
const points=(a:readonly Vec3[],b:readonly Vec3[])=>{assert.equal(a.length,b.length);a.forEach((p,k)=>point(p,b[k]!));};
const source:Vec3[]=[[7,20,30],[13,20,30],[11,20,32]];

test('world ellipse frame removes raw third-point axial projection and keeps stored axis order',()=>{
  const frame=ellipseFrame(source);point(frame.center,[10,20,30]);point(frame.u,[1,0,0]);point(frame.v,[0,0,1]);point(frame.normal,[0,-1,0]);near(frame.a,3);near(frame.b,2);
  points(ellipsePoints(frame),[[7,20,30],[13,20,30],[10,20,32]]);
  const tall=ellipseFrame([[0,0,0],[2,0,0],[7,8,0]]);near(tall.a,1);near(tall.b,8);point(tall.u,[1,0,0]);point(tall.v,[0,1,0]);
  assert.deepEqual(source,[[7,20,30],[13,20,30],[11,20,32]],'canonicalization must not mutate stored points');
});

test('four ellipse axis handles lie on the curve and four rotation handles occupy bounding corners',()=>{
  const handles=ellipseHandles(source);assert.equal(handles.length,9);
  const expected:Record<string,Vec3>={'u-':[7,20,30],'u+':[13,20,30],'v-':[10,20,28],'v+':[10,20,32],center:[10,20,30],'rotate--':[7,20,28],'rotate-+':[7,20,32],'rotate++':[13,20,32],'rotate+-':[13,20,28]};
  for(const handle of handles){point(handle.position,expected[handle.id]!);if(handle.kind==='resize')near((handle.position[0]-10)**2/9+(handle.position[2]-30)**2/4,1);if(handle.kind==='rotate')near((handle.position[0]-10)**2/9+(handle.position[2]-30)**2/4,2);}
});

test('center-preserving axis resize projects onto the frozen frame and ignores off-plane displacement',()=>{
  points(resizeEllipse(source,'u-',[5,900,33]),[[5,20,30],[15,20,30],[10,20,32]]);
  points(resizeEllipse(source,'v-',[100,900,25]),[[7,20,30],[13,20,30],[10,20,35]]);
  assert.throws(()=>resizeEllipse(source,'u+',[10,20,100]),/轴长度/);
  assert.throws(()=>resizeEllipse(source,'other',[1,2,3]),/未知/);
});

test('world translation and rotation stay in the original plane and preserve both radii',()=>{
  points(moveEllipse(source,[5,9,-1]),[[12,20,29],[18,20,29],[15,20,31]]);
  const rotated=rotateEllipse(source,[13,90,30],[10,-5,33]);points(rotated,[[10,20,27],[10,20,33],[8,20,30]]);
  const frame=ellipseFrame(rotated);near(frame.a,3);near(frame.b,2);point(frame.center,[10,20,30]);
  assert.throws(()=>rotateEllipse(source,[10,20,30],[13,20,30]),/中心/);
});

test('ellipse helpers reject degenerate and nonfinite input before producing geometry',()=>{
  assert.throws(()=>ellipseFrame([[0,0,0],[0,0,0],[0,1,0]]),/第一轴/);
  assert.throws(()=>ellipseFrame([[0,0,0],[2,0,0],[7,0,0]]),/第二轴/);
  assert.throws(()=>ellipseFrame([[0,0,0],[2,0,0]]),/三个/);
  assert.throws(()=>moveEllipse(source,[NaN,0,0]),/有限/);
  assert.throws(()=>ellipseFrame([[0,0,0],[2,0,0],[0,Infinity,0]]),/有限/);
});

test('shared label anchors use area centroid and ellipse center with a world-relative offset',()=>{
  const m=(kind:MeasurementObject['kind'],p:Vec3[],extra:Partial<MeasurementObject>={}):MeasurementObject=>({id:'m',name:'m',kind,points:p,visible:true,color:'#fff',...extra});
  point(measurementLabelAnchor(m('area',[[0,0,0],[4,0,0],[4,2,0],[0,4,0]])),[16/9,14/9,0]);
  point(measurementLabelPosition(m('ellipse',source,{labelOffset:[2,-1,5]})),[12,19,35]);
  point(measurementLabelAnchor(m('angle',[[1,2,3],[4,5,6],[7,8,9]])),[4,5,6]);
  point(measurementLabelPosition(m('annotation',[[1,2,3],[4,5,6]],{labelOffset:[8,8,8]})),[4,5,6]);
  point(measurementLabelAnchor(m('distance',[[0,1,2],[6,3,4]])),[3,2,3]);
});
