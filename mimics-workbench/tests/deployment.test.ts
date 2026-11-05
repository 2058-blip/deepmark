import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appPath,socketUrl,collaborationCacheName,legacyCollaborationCacheName} from '../src/deployment.ts';

test('dataset, collaboration and export routes stay inside the configured application prefix',()=>{
  for(const path of ['/api/datasets','/api/datasets/scan/download','/api/collaboration/session','/api/collaboration/projects/p/export?revision=2']){
    assert.equal(appPath(path,'/'),path);
    assert.equal(appPath(path,'/mimics/'),'/mimics'+path);
    assert.equal(appPath(path,'/mimics'),'/mimics'+path);
  }
  assert.equal(appPath('api/datasets','/mimics/'),'/mimics/api/datasets');
});

test('websocket connections retain the public prefix and use the page origin and TLS protocol',()=>{
  const path='/api/collaboration/socket?project=abc';
  assert.equal(socketUrl(path,{protocol:'https:',host:'ddns.984797.xyz:8443'},'/mimics/'),'wss://ddns.984797.xyz:8443/mimics/api/collaboration/socket?project=abc');
  assert.equal(socketUrl(path,{protocol:'http:',host:'127.0.0.1:5173'},'/'),'ws://127.0.0.1:5173/api/collaboration/socket?project=abc');
});

test('collaboration operations and identities cannot open or migrate the platform databases',()=>{
  assert.notEqual(collaborationCacheName,legacyCollaborationCacheName);
  for(const name of [collaborationCacheName,legacyCollaborationCacheName]){
    assert.ok(name.startsWith('mimics-workbench-'));
    assert.ok(!['deepmark-workspaces','deepmark-collaboration','deepmark-mimics-workspaces-v1'].includes(name));
  }
});
