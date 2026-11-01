import {shallowRef} from 'vue';

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
  if(!crypto.subtle)throw new Error('当前浏览器无法验证影像指纹，请通过 HTTPS 使用新版浏览器。');
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
