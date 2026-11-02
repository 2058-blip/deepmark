import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isProxy,reactive} from 'vue';
import type {Segment} from '../src/view.ts';
import {snapshotSegments} from '../src/segmentSnapshot.ts';

test('reactive label creators survive a structured-cloneable and isolated draft snapshot',()=>{
  const labels=reactive<Segment[]>([
    {id:1,name:'左肺',color:'#59b8b3',visible:true,createdBy:{id:'engineer-a',name:'张医生'},createdAt:'2026-11-02T10:00:00Z'},
    {id:2,name:'旧标签',color:'#123456',visible:false},
    {id:3,name:'未记录作者',color:'#abcdef',visible:true,createdBy:null,createdAt:null},
  ]);
  assert.ok(isProxy(labels[0].createdBy));
  assert.throws(()=>structuredClone(labels.map(label=>({...label}))),{name:'DataCloneError'});
  const snapshot=snapshotSegments(labels),stored=structuredClone(snapshot);
  assert.deepEqual(stored,JSON.parse(JSON.stringify(labels)));
  assert.equal(isProxy(snapshot[0].createdBy),false);
  labels[0].createdBy!.name='修改后的姓名';labels[0].name='改名';
  assert.equal(snapshot[0].createdBy!.name,'张医生');assert.equal(snapshot[0].name,'左肺');
  assert.equal(Object.hasOwn(stored[1],'createdBy'),false);assert.equal(Object.hasOwn(stored[1],'createdAt'),false);
  assert.equal(stored[2].createdBy,null);assert.equal(stored[2].createdAt,null);
});
