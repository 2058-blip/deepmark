import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchResources} from '../src/workbench/wire.ts';
import {retryWorkbenchEncoding,retryableEncodingError} from '../src/workbench/encodingRetry.ts';
import type {ProjectState} from '../mimics-workbench/src/mimics/project.ts';

function meshState(): ProjectState {
  return {name:'Synthetic upload recovery',masks:[],measurements:[],selectedMaskId:'',selectedPartId:'triangle',parts:[{
    id:'triangle',name:'Synthetic triangle',color:'#123456',visible:true,opacity:1,
    mesh:{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])},
  }]};
}

for (const firstFailure of ['network','http503'] as const) {
  test(`mesh resource ${firstFailure} failure resumes encoding and becomes ready without reload`,async t=>{
    const previousFetch=globalThis.fetch,requests=new Map<string,number>(),controller=new AbortController();
    const resources=new WorkbenchResources('encoding-test','worker-a');
    t.after(()=>{globalThis.fetch=previousFetch;resources.dispose();controller.abort();});
    globalThis.fetch=async(input,options)=>{
      const id=String(input).split('/').at(-1)!,attempt=(requests.get(id)||0)+1;requests.set(id,attempt);
      if(id.startsWith('f32-')&&attempt===1){
        if(firstFailure==='network')throw new TypeError('Failed to fetch');
        return Response.json({error:'Temporarily unavailable'},{status:503});
      }
      const body=options?.body as Blob;
      return Response.json({id,kind:id.split('-')[0],length:body.size/4});
    };
    // The durable placeholder survives the failed resource PUT. The same state
    // and WorkbenchResources instance retry; no page reload or recovery call.
    const operation={id:'same-operation',status:'encoding'},state=meshState();
    let attempts=0,retries=0,manifest:Awaited<ReturnType<WorkbenchResources['manifest']>>|undefined;
    await retryWorkbenchEncoding(async assertActive=>{
      attempts++;
      const result=await resources.manifest(state);
      assertActive();manifest=result;operation.status='ready';
    },{signal:controller.signal,active:()=>true,initialDelayMs:2,maximumDelayMs:8,onRetry:()=>{
      retries++;assert.equal(operation.id,'same-operation');assert.equal(operation.status,'encoding');
    }});
    assert.equal(attempts,2);assert.equal(retries,1);assert.equal(operation.status,'ready');
    const mesh=manifest!.parts[0]!.mesh;
    assert.equal(mesh.positions.__workbenchResource.kind,'f32');
    assert.equal(mesh.indices.__workbenchResource.kind,'u32');
    assert.equal([...requests].find(([id])=>id.startsWith('f32-'))?.[1],2);
  });
}

test('permission failure is surfaced once and retains the incomplete operation for recovery',async t=>{
  const previousFetch=globalThis.fetch,controller=new AbortController(),resources=new WorkbenchResources('forbidden-test','worker-a');
  t.after(()=>{globalThis.fetch=previousFetch;resources.dispose();controller.abort();});
  const deniedRequests=new Map<string,number>();let retries=0,status='encoding';
  globalThis.fetch=async input=>{const id=String(input);deniedRequests.set(id,(deniedRequests.get(id)||0)+1);return Response.json({error:'No longer a group member'},{status:403});};
  await assert.rejects(retryWorkbenchEncoding(async assertActive=>{
    await resources.manifest(meshState());assertActive();status='ready';
  },{signal:controller.signal,active:()=>true,initialDelayMs:2,onRetry:()=>retries++}),
  (reason:any)=>reason.status===403);
  // The two mesh buffers may already be uploading concurrently. Neither one
  // may be retried after its permission denial.
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.ok(deniedRequests.size>0);assert.ok([...deniedRequests.values()].every(count=>count===1));assert.equal(retries,0);assert.equal(status,'encoding');
});

test('revoked permission or disposal interrupts retry sleep without another attempt',async()=>{
  const controller=new AbortController();let attempts=0;
  await assert.rejects(retryWorkbenchEncoding(async()=>{
    attempts++;throw new TypeError('Failed to fetch');
  },{signal:controller.signal,active:()=>true,initialDelayMs:5000,onRetry:()=>controller.abort()}),
  (reason:any)=>reason.name==='AbortError');
  assert.equal(attempts,1);
  assert.equal(retryableEncodingError(Object.assign(new Error('Denied'),{status:401})),false);
  assert.equal(retryableEncodingError(Object.assign(new Error('Read-only'),{status:423})),false);
  assert.equal(retryableEncodingError(new Error('Invalid geometry')),false);
});

test('an interrupted in-flight encoder cannot mark the operation ready later',async()=>{
  const controller=new AbortController();let release!:()=>void,started!:()=>void,ready=false;
  const start=new Promise<void>(resolve=>started=resolve),pending=new Promise<void>(resolve=>release=resolve);
  const result=retryWorkbenchEncoding(async assertActive=>{
    started();await pending;assertActive();ready=true;
  },{signal:controller.signal,active:()=>true});
  await start;controller.abort();
  await assert.rejects(result,(reason:any)=>reason.name==='AbortError');
  release();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(ready,false);
});
