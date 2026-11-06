import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constants,createHash,generateKeyPairSync,privateDecrypt,webcrypto} from 'node:crypto';
import {encryptLoginPassword,sha256Blob} from '../src/browserCrypto.ts';

test('HTTP crypto fallback keeps the RSA-OAEP SHA-256 envelope and the exact image fingerprint',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const challenge={challengeId:'http-unicode-challenge',publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),algorithm:'RSA-OAEP-256',expiresAt:Date.now()+120000},password='测试密码 空格!123';
 try{
  for(const crypto of [webcrypto,{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)}]){
   Object.defineProperty(globalThis,'crypto',{value:crypto,configurable:true});
   const encrypted=await encryptLoginPassword(challenge,password),decrypted=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(encrypted,'base64'));
   assert.deepEqual(JSON.parse(decrypted.toString('utf8')),{challengeId:challenge.challengeId,password});
   assert.notEqual(encrypted,await encryptLoginPassword(challenge,password));
   const bytes=Buffer.alloc(2*1024*1024+19);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
   assert.equal(await sha256Blob(new Blob([bytes])),createHash('sha256').update(bytes).digest('hex'));
   await assert.rejects(encryptLoginPassword(challenge,'x'.repeat(500)),/长度/);
  }
 }finally{if(original)Object.defineProperty(globalThis,'crypto',original);}
});

test('large CT fingerprints stream on secure origins without making a whole-file ArrayBuffer',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 const bytes=Buffer.alloc(8*1024*1024+19);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 class StreamOnlyBlob extends Blob {arrayBuffer():Promise<ArrayBuffer>{throw new Error('whole-file copy is forbidden');}}
 try{
  Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
  assert.equal(await sha256Blob(new StreamOnlyBlob([bytes])),createHash('sha256').update(bytes).digest('hex'));
 }finally{if(original)Object.defineProperty(globalThis,'crypto',original);}
});

test('a failed hash stream is cancelled, unlocked and never returns a partial fingerprint',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');let cancelled=0,released=0;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2,3]));},pull(controller){controller.error(new Error('hash input failed'));}});
 const reader=body.getReader(),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),release=reader.releaseLock.bind(reader);
 const file=new Blob([new Uint8Array([1,2,3])]);
 Object.defineProperty(file,'stream',{value:()=>({getReader:()=>({read,cancel:(reason?:unknown)=>{cancelled++;return cancel(reason);},releaseLock:()=>{released++;release();}})})});
 try{
  Object.defineProperty(globalThis,'crypto',{value:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},configurable:true});
  await assert.rejects(sha256Blob(file),/hash input failed/);assert.equal(cancelled,1);assert.equal(released,1);assert.equal(body.locked,false);
 }finally{if(original)Object.defineProperty(globalThis,'crypto',original);}
});

test('hash cancellation stops a pending read and releases the stream without a successful result',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto'),controller=new AbortController();let cancelled=0;
 const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array([7,8]));},cancel(){cancelled++;}});
 const file=new Blob([new Uint8Array([7,8])]);Object.defineProperty(file,'stream',{value:()=>body});
 try{
  Object.defineProperty(globalThis,'crypto',{value:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},configurable:true});
  const pending=sha256Blob(file,{signal:controller.signal});
  await new Promise<void>(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,1);assert.equal(body.locked,false);
  await assert.rejects(sha256Blob(file,{signal:controller.signal}),{name:'AbortError'});
 }finally{if(original)Object.defineProperty(globalThis,'crypto',original);}
});
