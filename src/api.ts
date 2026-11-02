import {shallowRef} from 'vue';
import {sha256Blob} from './browserCrypto.ts';

export type UserRole='dispatcher'|'worker';
export type AuthUser={id:string;username:string;name:string;role:UserRole};
export type Group={id:string;name:string;code:string;leaderId:string;members:{id:string;name:string;username:string}[];isLeader:boolean};
export type Dataset={id:string;name:string;folder?:string;size:number;modified:string;format:string;downloadUrl:string;status:'unassigned'|'in_progress'|'completed';groupId?:string|null;groupName?:string|null;ownerId?:string;projectId?:string|null;fingerprint?:string;revision?:number;progress?:unknown};
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
export async function downloadAuthenticated(url:string,filename:string):Promise<void>{
  const response=await authenticatedFetch(url);if(!response.ok)throw await responseError(response);
  const blob=await response.blob(),objectUrl=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=objectUrl;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
}
export async function fingerprint(file:Blob):Promise<string>{
  return sha256Blob(file);
}
export function uploadDataset(form:FormData,onProgress:(percent:number)=>void):Promise<{dataset:Dataset}>{
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open('POST','/api/datasets/upload');request.withCredentials=true;request.setRequestHeader('X-Deepmark-Request','1');
    request.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.min(100,Math.round(event.loaded/event.total*100)));};
    request.onload=()=>{let result;try{result=JSON.parse(request.responseText);}catch{reject(new Error('服务器返回了无效的上传结果。'));return;}if(request.status>=200&&request.status<300)resolve(result);else reject(Object.assign(new Error(result.error||'影像上传失败。'),{status:request.status}));};
    request.onerror=()=>reject(new Error('上传连接中断，请检查网络后重试。'));request.onabort=()=>reject(new Error('上传已取消。'));request.send(form);
  });
}
