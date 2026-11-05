import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {parseNifti} from '../src/core.ts';
import {volumeGrid,createProject,replaceMask,addPart} from '../src/mimics/project.ts';

// CLI/Worker format sample, explicitly not a browser file-picker receipt.
const caseRoot=new URL('../work/mimics-vue-reconstruction/',import.meta.url);
const fixture=await readFile(new URL('fixtures/foundation-sphere.nii',caseRoot));
const volume=parseNifti(fixture.buffer.slice(fixture.byteOffset,fixture.byteOffset+fixture.byteLength),'foundation-sphere.nii');
const workerUrl=new URL('../src/mimics/operations.worker.ts',import.meta.url);
const bridge=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(workerUrl.href)});parentPort.on('message',data=>self.onmessage({data}));`;
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bridge)));
let serial=0;
const pending=new Map();
worker.on('message',message=>{
  const job=pending.get(message.id);if(!job)return;
  if(message.type==='result'){pending.delete(message.id);job.resolve(message.result);}
  else if(message.type==='error'){pending.delete(message.id);job.reject(new Error(message.message));}
});
worker.on('error',error=>{for(const job of pending.values())job.reject(error);pending.clear();});
function run(kind,request={}){
  return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});worker.postMessage({type:'run',id,kind,...request});});
}

try{
  worker.postMessage({type:'init',grid:volumeGrid(volume)});
  const selected=await run('threshold',{options:{lower:500,upper:500}});
  const expected=new Uint8Array(24**3);
  for(let z=0;z<24;z++)for(let y=0;y<24;y++)for(let x=0;x<24;x++)expected[x+24*(y+24*z)]=Number((x-12)**2+(y-12)**2+((z-12)*1.5)**2<49);
  assert.deepEqual(selected.mask,expected,'fixture foreground has a hand-defined analytic oracle');
  const mesh=await run('calculate3d',{mask:selected.mask,options:{quality:'optimal',topology:'native-table'}});
  let state=createProject(volume);
  state=replaceMask(state,state.selectedMaskId,selected.mask,[500,500]);
  state=addPart(state,mesh,state.masks[0]);
  state={...state,name:'Synthetic exchange sample',viewState:{point:[12,12,12],activeAxis:2,window:{center:40,width:400},tool:'navigate',tab:'surface',renderMode:'parts'}};
  const out=new URL('evidence/exchange-sample/',caseRoot);await mkdir(out,{recursive:true});
  const outputs=[
    ['sample.deepmark.zip',await run('exportProject',{options:{volume,state}})],
    ['sample.stl',await run('exportSTL',{mesh})],
    ['sample-mask.nii',await run('exportMask',{mask:selected.mask,options:{volume}})],
  ];
  for(const [name,bytes] of outputs)await writeFile(new URL(name,out),bytes);
  const summary={origin:'Node operations.worker.ts; not browser UI or filesystem-picker verification',synthetic:true,dims:volume.dims,spacing:volume.spacing,maskVoxels:selected.count,triangles:mesh.indices.length/3,files:outputs.map(([name,bytes])=>({name,bytes:bytes.length}))};
  await writeFile(new URL('generation.json',out),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({directory:fileURLToPath(out),...summary},null,2));
}finally{await worker.terminate();}
