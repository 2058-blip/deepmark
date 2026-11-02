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
