import type {VolumeGrid} from './types.ts';
import {prepareMprSampler} from './mpr.ts';
import type {MprSamplerRequest,MprSamplerResponse} from './mprSamplingClient.ts';

const scope=self as unknown as {postMessage:(message:MprSamplerResponse,transfer?:Transferable[])=>void};
let residentGrid:VolumeGrid|null=null;
let residentMasks=new Map<string,Uint8Array>();
let epoch=-1,sampler:ReturnType<typeof prepareMprSampler>|null=null,running=false;
type SampleRequest=Extract<MprSamplerRequest,{type:'sample'}>;
const pending=new Map<number,SampleRequest>(),latest=new Map<number,number>();
const send=(message:MprSamplerResponse,transfer?:Transferable[])=>scope.postMessage(message,transfer);
async function drain(){
  if(running)return;running=true;
  try{while(pending.size){
    const [owner,request]=pending.entries().next().value!;pending.delete(owner);const resident=sampler,requestEpoch=epoch;
    const cancelled=()=>requestEpoch!==epoch||request.epoch!==epoch||latest.get(owner)!==request.id;
    if(!resident||cancelled())continue;
    try{
      // One full-budget allocation; the shared generator yields every 4096 output pixels.
      const result=await resident.sampleAsync(request.plane,{...request.options,interpolation:request.interpolation,cancelled});
      if(cancelled())continue;
      send({type:'result',epoch,owner,id:request.id,result},[result.gray.buffer,result.valid.buffer,result.support.buffer,...result.masks.map(mask=>mask.data.buffer)]);
    }catch(error){if(cancelled())continue;send({type:'error',epoch,owner,id:request.id,message:error instanceof Error?error.message:'MPR重采样失败。'});}
  }}finally{running=false;if(pending.size)void drain();}
}
self.onmessage=(event:MessageEvent<MprSamplerRequest>)=>{
  const message=event.data;
  if(message.type==='init'||message.type==='masks'){
    epoch=message.epoch;pending.clear();latest.clear();sampler=null;
    try{if(message.type==='init')residentGrid=message.grid;if(!residentGrid)throw new Error('MPR 源影像未初始化。');const masks=message.masks.map(mask=>{const data=mask.data??residentMasks.get(mask.id);if(!data)throw new Error('MPR Mask 缓存缺失。');return{id:mask.id,data};});residentMasks=new Map(masks.map(mask=>[mask.id,mask.data]));sampler=prepareMprSampler(residentGrid,masks);send({type:'ready',epoch});}catch(error){send({type:'fatal',epoch,message:error instanceof Error?error.message:'MPR采样源初始化失败。'});}return;
  }
  if(message.epoch!==epoch)return;
  if(message.type==='cancel'){pending.delete(message.owner);latest.delete(message.owner);return;}
  latest.set(message.owner,message.id);pending.set(message.owner,message);void drain();
};
