import {shallowRef} from 'vue';
import {sha256Blob} from './browserCrypto.ts';
import {readTransferBlob,transferAborted,transferProgress} from './transfer.ts';
import type {TransferOptions,TransferProgress} from './transfer.ts';
export type {TransferOptions,TransferProgress} from './transfer.ts';

export type UserRole='dispatcher'|'worker';
export type AuthUser={id:string;username:string;name:string;role:UserRole};
export type Group={id:string;name:string;code:string;leaderId:string;members:{id:string;name:string;username:string}[];isLeader:boolean};
export type Dataset={id:string;name:string;folder?:string;size:number;modified:string;format:string;downloadUrl:string;status:'unassigned'|'in_progress'|'completed';groupId?:string|null;groupName?:string|null;ownerId?:string;projectId?:string|null;fingerprint?:string;revision?:number;progress?:unknown;editor?:'workbench';workbenchExport?:boolean};
export const authUser=shallowRef<AuthUser|null>(null);

export async function authenticatedFetch(path:string,options:RequestInit={}):Promise<Response>{
  const headers=new Headers(options.headers),method=(options.method||'GET').toUpperCase();
  if(!['GET','HEAD','OPTIONS'].includes(method))headers.set('X-Deepmark-Request','1');
  if(typeof options.body==='string'&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  return fetch(path,{...options,headers,credentials:'same-origin',cache:options.cache||'no-store'});
}
export async function responseError(response:Response):Promise<Error & {status:number}>{
  const body=await response.json().catch(()=>({error:`请求失败（${response.status}）`}));
  return Object.assign(new Error(body.error||body.message||`请求失败（${response.status}）`),{status:response.status});
}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  const response=await authenticatedFetch(path,options);
  if(!response.ok)throw await responseError(response);
  return response.status===204?undefined as T:response.json();
}
export async function loadCurrentUser():Promise<AuthUser|null>{
  const result=await api<{user:AuthUser|null}>('/api/auth/me');authUser.value=result.user;return result.user;
}
export async function downloadBlobAuthenticated(url:string,options:TransferOptions={}):Promise<Blob>{
  options.onProgress?.(transferProgress(0,null));
  const response=await authenticatedFetch(url,{signal:options.signal});if(!response.ok)throw await responseError(response);
  return readTransferBlob(response,options);
}
export async function downloadAuthenticated(url:string,filename:string,options:TransferOptions={}):Promise<void>{
  const blob=await downloadBlobAuthenticated(url,options);if(options.signal?.aborted)throw transferAborted();
  const objectUrl=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=objectUrl;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
}
export async function fingerprint(file:Blob,options:Pick<TransferOptions,'signal'>={}):Promise<string>{
  return sha256Blob(file,options);
}
export function uploadDataset(form:FormData,onProgress:(progress:TransferProgress)=>void,options:Pick<TransferOptions,'signal'>={}):Promise<{dataset:Dataset}>{
  return new Promise((resolve,reject)=>{
    if(options.signal?.aborted){reject(transferAborted());return;}
    const request=new XMLHttpRequest();request.open('POST','/api/datasets/upload');request.withCredentials=true;request.setRequestHeader('X-Deepmark-Request','1');
    let progress=transferProgress(0,null);
    const abort=()=>request.abort(),cleanup=()=>options.signal?.removeEventListener('abort',abort);
    request.upload.onprogress=event=>{progress=transferProgress(event.loaded,event.lengthComputable?event.total:null);onProgress(progress);};
    request.upload.onload=()=>{progress={...progress,complete:true};onProgress(progress);};
    request.onload=()=>{cleanup();let result;try{result=JSON.parse(request.responseText);}catch{reject(new Error('服务器返回了无效的上传结果。'));return;}if(request.status>=200&&request.status<300)resolve(result);else reject(Object.assign(new Error(result.error||'影像上传失败。'),{status:request.status}));};
    request.onerror=()=>{cleanup();reject(new Error('上传连接中断，请检查网络后重试。'));};request.onabort=()=>{cleanup();reject(transferAborted());};
    options.signal?.addEventListener('abort',abort,{once:true});onProgress(progress);
    try{if(options.signal?.aborted){cleanup();reject(transferAborted());return;}request.send(form);}catch(reason){cleanup();reject(reason);}
  });
}
