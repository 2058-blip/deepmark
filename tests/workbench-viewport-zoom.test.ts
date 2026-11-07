import test from 'node:test';
import assert from 'node:assert/strict';
import {sliderToZoom,zoomToSlider,zoomWheelInput} from '../src/workbench/viewportZoom.ts';

const rect={left:70,top:100,width:640,height:480};
function close(actual:number,expected:number){assert.ok(Math.abs(actual-expected)<=1e-10*Math.max(1,Math.abs(expected)),`${actual} should equal ${expected}`);}
const nativeZoom=(current:number,deltaY:number)=>Math.max(.15,Math.min(12,current*Math.exp(-deltaY*.002)));

test('slider requests use the native wheel formula and the canvas centre anchor',()=>{
  for(const current of [.15,.3,1,2.5,12])for(const target of [.15,.25,.8,1,4,12]){
    const before={...rect},input=zoomWheelInput(current,target,rect);
    if(current===target){assert.equal(input,null);continue;}
    assert.ok(input);assert.equal(input.ctrlKey,true);
    assert.equal(input.clientX,390);assert.equal(input.clientY,340);
    close(nativeZoom(current,input.deltaY),target);
    assert.equal(input.deltaY<0,target>current);
    assert.deepEqual(rect,before);
  }
});

test('wheel requests clamp to native zoom bounds and avoid no-op events at limits',()=>{
  const lower=zoomWheelInput(1,1e-5,rect),upper=zoomWheelInput(1,100,rect);
  assert.ok(lower&&upper);close(nativeZoom(1,lower.deltaY),.15);close(nativeZoom(1,upper.deltaY),12);
  assert.equal(zoomWheelInput(.15,.01,rect),null);assert.equal(zoomWheelInput(12,100,rect),null);
  assert.equal(zoomWheelInput(1,1+Number.EPSILON,rect),null);
  const outOfRangeCurrent=zoomWheelInput(.1,1,rect);assert.ok(outOfRangeCurrent);close(nativeZoom(.1,outOfRangeCurrent.deltaY),1);
});

test('invalid zoom and invalid canvas rectangles never create a wheel request',()=>{
  for(const current of [NaN,Infinity,-Infinity,0,-1])assert.equal(zoomWheelInput(current,1,rect),null);
  for(const target of [NaN,Infinity,-Infinity,0,-1])assert.equal(zoomWheelInput(1,target,rect),null);
  for(const field of ['left','top','width','height'] as const){
    for(const invalid of [NaN,Infinity,-Infinity])assert.equal(zoomWheelInput(1,2,{...rect,[field]:invalid}),null);
  }
  for(const field of ['width','height'] as const)for(const invalid of [0,-1])assert.equal(zoomWheelInput(1,2,{...rect,[field]:invalid}),null);
  assert.equal(zoomWheelInput(1,2,{left:Number.MAX_VALUE,top:0,width:Number.MAX_VALUE,height:1}),null);
});

test('logarithmic slider is reciprocal, bounded and gives equal travel to equal zoom ratios',()=>{
  close(zoomToSlider(.15),0);close(zoomToSlider(12),1000);
  close(sliderToZoom(0),.15);close(sliderToZoom(1000),12);
  for(const zoom of [.15,.2,.5,1,2,5,8,12])close(sliderToZoom(zoomToSlider(zoom)),zoom);
  for(const value of [0,.5,100,255,500,750,999,1000])close(zoomToSlider(sliderToZoom(value)),value);
  close(zoomToSlider(2)-zoomToSlider(1),zoomToSlider(4)-zoomToSlider(2));
  close(sliderToZoom(500),Math.sqrt(.15*12));
  assert.equal(zoomToSlider(-20),0);assert.equal(zoomToSlider(100),1000);
  close(sliderToZoom(-20),.15);close(sliderToZoom(10000),12);
  for(const invalid of [NaN,Infinity,-Infinity]){assert.equal(zoomToSlider(invalid),0);close(sliderToZoom(invalid),.15);}
});

test('wheel enlargement and reciprocal reduction recover the original zoom',()=>{
  for(const current of [.15,.25,1,4,12]){
    const target=current<2?current*2:current/2,input=zoomWheelInput(current,target,rect);
    assert.ok(input);const changed=nativeZoom(current,input.deltaY),reverse=zoomWheelInput(changed,current,rect);
    assert.ok(reverse);close(nativeZoom(changed,reverse.deltaY),current);close(reverse.deltaY,-input.deltaY);
  }
});
