import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TouchSession} from '../src/touchSession.ts';

test('one viewport supports two fingers; crossing viewports cancels until all fingers lift',()=>{
  const session=new TouchSession<object>(),a={},b={};let cancelled=0;
  session.register(a,()=>cancelled++);session.register(b,()=>cancelled++);
  session.touchDown(1,a);session.touchDown(2,a);assert.equal(cancelled,0);assert.equal(session.allows(a),true);assert.equal(session.allows(b),false);
  session.end(2);session.touchDown(3,b);assert.equal(cancelled,2);assert.equal(session.allows(a),false);assert.equal(session.allows(b),false);
  session.end(1);assert.equal(session.allows(b),false);session.end(3);session.touchDown(4,b);assert.equal(session.allows(b),true);
});
test('a touch starting on surrounding controls cannot become a viewport annotation with a second finger',()=>{
  const session=new TouchSession<object>(),a={};let cancelled=0;session.register(a,()=>cancelled++);
  session.touchDown(1,null);session.touchDown(2,a);assert.equal(cancelled,1);assert.equal(session.allows(a),false);
  session.end(1);session.end(2);session.touchDown(3,a);assert.equal(session.allows(a),true);
});
test('palm touches are ignored without cancelling an active pen and stay blocked until lifted',()=>{
  const session=new TouchSession<object>(),a={};let cancelled=0;session.register(a,()=>cancelled++);
  session.penDown(8);session.touchDown(1,a);session.touchDown(2,a);assert.equal(cancelled,0);assert.equal(session.allows(a),false);
  session.end(8);assert.equal(session.allows(a),false);session.end(1);session.end(2);session.touchDown(3,a);assert.equal(session.allows(a),true);
});
test('pen starts cancel existing touch; reset after blur/unmount clears stale pointer and pen locks',()=>{
  const session=new TouchSession<object>(),a={};let cancelled=0;const unregister=session.register(a,()=>cancelled++);
  session.touchDown(1,a);session.penDown(8);assert.equal(cancelled,1);assert.equal(session.allows(a),false);
  session.reset();assert.equal(cancelled,2);session.touchDown(3,a);assert.equal(session.allows(a),true);
  unregister();assert.equal(session.allows(a),false);session.reset();session.touchDown(4,a);assert.equal(session.allows(a),true);
});
