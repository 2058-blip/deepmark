import test from 'node:test';
import assert from 'node:assert/strict';
import {createHoverDwell,HOVER_DWELL_MS} from '../src/workbench/hoverDwell.ts';
import type {HoverDwellClock,HoverPointer} from '../src/workbench/hoverDwell.ts';

function fakeClock(ignoreClear=false){
  let now=0,next=0;
  const jobs=new Map<number,{time:number;callback:()=>void}>();
  const clock:HoverDwellClock={set(callback,delay){const id=++next;jobs.set(id,{time:now+delay,callback});return id;},clear(token){if(!ignoreClear)jobs.delete(token as number);}};
  return{clock,now:()=>now,advance(ms:number){
    const end=now+ms;
    while(true){const pending=[...jobs].filter(([,job])=>job.time<=end).sort((a,b)=>a[1].time-b[1].time||a[0]-b[0])[0];if(!pending)break;now=pending[1].time;jobs.delete(pending[0]);pending[1].callback();}
    now=end;
  }};
}
function setup(ignoreClear=false){
  const timer=fakeClock(ignoreClear),shown:{time:number;point:HoverPointer}[]=[],visibility:{value:HoverPointer|null}={value:null};
  const dwell=createHoverDwell({clock:timer.clock,show(point){shown.push({time:timer.now(),point});visibility.value=point;},hide(){visibility.value=null;}});
  return{...timer,dwell,shown,visibility};
}

test('a stationary pointer performs no show before 500 ms and shows once at the threshold',()=>{
  const {dwell,advance,shown,visibility}=setup();assert.equal(HOVER_DWELL_MS,500);
  dwell.move({clientX:10,clientY:20});advance(499);assert.deepEqual(shown,[]);assert.equal(visibility.value,null);
  advance(1);assert.deepEqual(shown,[{time:500,point:{clientX:10,clientY:20}}]);
  advance(5000);assert.equal(shown.length,1);
});

test('real movement immediately hides an open tooltip and restarts a full stationary interval',()=>{
  const {dwell,advance,shown,visibility}=setup();
  dwell.move({clientX:10,clientY:20});advance(500);assert.ok(visibility.value);
  dwell.move({clientX:10.25,clientY:20});assert.equal(visibility.value,null);advance(400);
  dwell.move({clientX:11,clientY:20});advance(499);assert.equal(shown.length,1);assert.equal(visibility.value,null);
  advance(1);assert.deepEqual(shown[1],{time:1400,point:{clientX:11,clientY:20}});
});

test('duplicate stationary pointer events neither postpone the deadline nor create repeated shows',()=>{
  const {dwell,advance,shown}=setup();const point={clientX:15,clientY:25};
  dwell.move(point);advance(250);dwell.move({...point});advance(250);assert.equal(shown.length,1);assert.equal(shown[0]!.time,500);
  dwell.move({...point});advance(1000);assert.equal(shown.length,1);
  point.clientX=99;assert.deepEqual(shown[0]!.point,{clientX:15,clientY:25},'input objects are copied, not retained');
});

test('pointer cancellation and disposal reject even callbacks already queued by a timer',()=>{
  const {dwell,advance,shown,visibility}=setup(true);
  dwell.move({clientX:1,clientY:2});advance(499);dwell.cancel();advance(1);assert.equal(shown.length,0);
  dwell.move({clientX:3,clientY:4});advance(500);assert.equal(shown.length,1);assert.ok(visibility.value);
  dwell.cancel();assert.equal(visibility.value,null);dwell.invalidate();advance(500);assert.equal(shown.length,1);
  dwell.move({clientX:5,clientY:6});advance(100);dwell.dispose();assert.equal(visibility.value,null);
  dwell.move({clientX:7,clientY:8});dwell.invalidate();advance(1000);assert.equal(shown.length,1);
});

test('view invalidation hides old information and resolves the latest view only after a new dwell',()=>{
  const timer=fakeClock(true),resolved:{version:number;time:number}[]=[];
  let version=1,visible=false;
  const dwell=createHoverDwell({clock:timer.clock,show(){resolved.push({version,time:timer.now()});visible=true;},hide(){visible=false;}});
  dwell.move({clientX:30,clientY:40});timer.advance(400);version=2;dwell.invalidate();
  timer.advance(499);assert.deepEqual(resolved,[]);assert.equal(visible,false);
  timer.advance(1);assert.deepEqual(resolved,[{version:2,time:900}]);assert.equal(visible,true);
  version=3;dwell.invalidate();assert.equal(visible,false);timer.advance(500);
  assert.deepEqual(resolved[1],{version:3,time:1400});
  dwell.cancel();version=4;dwell.invalidate();timer.advance(1000);assert.equal(resolved.length,2);
});

test('invalid positions cancel waiting and shown tooltips instead of resolving stale membership',()=>{
  const {dwell,advance,shown,visibility}=setup();
  dwell.move({clientX:10,clientY:20});advance(100);dwell.move({clientX:NaN,clientY:20});advance(1000);assert.deepEqual(shown,[]);
  dwell.move({clientX:10,clientY:20});advance(500);assert.ok(visibility.value);
  dwell.move({clientX:10,clientY:Infinity});assert.equal(visibility.value,null);advance(1000);assert.equal(shown.length,1);
});
