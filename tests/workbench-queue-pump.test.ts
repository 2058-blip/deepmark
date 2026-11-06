import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueuePump} from '../src/workbench/queuePump.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

test('a second completed edit is sent after an in-flight edit without a third action',async()=>{
  const queue=['paint'],started=gate(),release=gate(),sent:string[]=[],busy:boolean[]=[];
  const pump=createQueuePump({canRun:()=>true,key:(item:string)=>item,read:async()=>queue.slice(),send:async item=>{
    sent.push(item);if(item==='paint'){started.resolve();await release.promise;}queue.splice(queue.indexOf(item),1);
  },onBusy:value=>busy.push(value),onError:reason=>{throw reason;}});
  const first=pump.request();await started.promise;
  queue.push('delete-mask');const second=pump.request();release.resolve();
  await Promise.all([first,second]);
  assert.deepEqual(sent,['paint','delete-mask']);assert.deepEqual(queue,[]);assert.deepEqual(busy,[true,false]);pump.dispose();
});

test('an edit completed during a stale empty read wakes the pump again',async()=>{
  const queue:string[]=[],reading=gate(),release=gate(),sent:string[]=[];let reads=0;
  const pump=createQueuePump({canRun:()=>true,key:(item:string)=>item,read:async()=>{
    reads++;if(reads===1){reading.resolve();await release.promise;return[];}return queue.slice();
  },send:async item=>{sent.push(item);queue.splice(queue.indexOf(item),1);},onError:reason=>{throw reason;}});
  const first=pump.request();await reading.promise;queue.push('rename-mask');const second=pump.request();release.resolve();
  await Promise.all([first,second]);assert.deepEqual(sent,['rename-mask']);assert.deepEqual(queue,[]);pump.dispose();
});

test('an edit completed during the final recount is not left waiting',async()=>{
  const queue:string[]=[],settling=gate(),release=gate(),sent:string[]=[];let settlements=0;
  const pump=createQueuePump({canRun:()=>true,key:(item:string)=>item,read:async()=>queue.slice(),send:async item=>{
    sent.push(item);queue.splice(queue.indexOf(item),1);
  },onSettled:async()=>{if(++settlements===1){settling.resolve();await release.promise;}},onError:reason=>{throw reason;}});
  const first=pump.request();await settling.promise;queue.push('erase');const second=pump.request();release.resolve();
  await Promise.all([first,second]);assert.deepEqual(sent,['erase']);assert.deepEqual(queue,[]);pump.dispose();
});

test('an acknowledged operation awaiting its canonical event is not resent in a busy loop',async()=>{
  const sent:string[]=[];let reads=0;
  const pump=createQueuePump({canRun:()=>true,key:(item:string)=>item,read:async()=>{assert.ok(++reads<5);return['acknowledged'];},
    send:async item=>{sent.push(item);},onError:reason=>{throw reason;}});
  await pump.request();assert.deepEqual(sent,['acknowledged']);assert.equal(reads,2);pump.dispose();
});

test('network failures retry after the delay and additional requests do not bypass backoff',async()=>{
  const queue=['delete-mask'],sent:string[]=[],errors:unknown[]=[],timers:{callback:()=>void;delay:number;cancelled?:boolean}[]=[];
  const pump=createQueuePump({canRun:()=>true,key:(item:string)=>item,read:async()=>queue.slice(),send:async item=>{
    sent.push(item);if(sent.length===1)throw new Error('offline');queue.shift();
  },onError:reason=>errors.push(reason),schedule:(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;},
    cancelTimer:handle=>{(handle as typeof timers[number]).cancelled=true;}});
  await pump.request();assert.equal(sent.length,1);assert.equal(errors.length,1);assert.equal(timers.length,1);assert.equal(timers[0].delay,1500);
  await pump.request();assert.equal(sent.length,1);assert.equal(timers.length,1);
  timers[0].callback();await pump.request();assert.deepEqual(sent,['delete-mask','delete-mask']);assert.deepEqual(queue,[]);pump.dispose();
});

test('read-only access and disposal prevent sends, including a pending retry',async()=>{
  let allowed=false,reads=0,sends=0;const timers:{callback:()=>void;cancelled?:boolean}[]=[];
  const pump=createQueuePump({canRun:()=>allowed,key:(item:string)=>item,read:async()=>{reads++;return['paint'];},send:async()=>{sends++;throw new Error('offline');},
    onError:()=>{},schedule:callback=>{const timer={callback};timers.push(timer);return timer;},cancelTimer:handle=>{(handle as typeof timers[number]).cancelled=true;}});
  await pump.request();assert.equal(reads,0);assert.equal(sends,0);
  allowed=true;await pump.request();assert.equal(sends,1);allowed=false;timers[0].callback();await pump.request();assert.equal(sends,1);
  allowed=true;await pump.request();assert.equal(sends,2);pump.dispose();assert.equal(timers[1].cancelled,true);
  timers[1].callback();await pump.request();assert.equal(sends,2);
});

test('access revoked while reading prevents the queued operation from being sent',async()=>{
  let allowed=true,sends=0;
  const pump=createQueuePump({canRun:()=>allowed,key:(item:string)=>item,read:async()=>{allowed=false;return['delete-mask'];},send:async()=>{sends++;},onError:reason=>{throw reason;}});
  await pump.request();assert.equal(sends,0);pump.dispose();
});
