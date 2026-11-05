/// <reference types="vite/client" />

const buildBase=import.meta.env?.BASE_URL||'/';

/** API and WebSocket requests follow the same public prefix as the built assets. */
export function appPath(path:string,base=buildBase):string{
  return `${base.endsWith('/')?base:base+'/'}${path.replace(/^\/+/, '')}`;
}
export function socketUrl(path:string,location:Pick<Location,'protocol'|'host'>,base=buildBase):string{
  return `${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${appPath(path,base)}`;
}

// This independent workbench never imports or deletes the platform's cached identities or operations.
export const collaborationCacheName='mimics-workbench-workspaces';
export const legacyCollaborationCacheName='mimics-workbench-collaboration';
