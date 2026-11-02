export type LoginChallenge={challengeId:string;publicKey:string;algorithm:string;expiresAt:number};
const binary=(bytes:Uint8Array)=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return value;};
const hex=(bytes:Uint8Array)=>Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');

/** Keep the same RSA-OAEP/SHA-256 envelope on HTTP origins without Web Crypto. */
export async function encryptLoginPassword(challenge:LoginChallenge,password:string):Promise<string>{
  if(challenge.algorithm!=='RSA-OAEP-256')throw new Error('服务器登录加密方式不受支持。');
  const payload=new TextEncoder().encode(JSON.stringify({challengeId:challenge.challengeId,password}));
  const publicKey=challenge.publicKey.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  if(globalThis.crypto?.subtle){
    const der=Uint8Array.from(atob(publicKey),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey('spki',der,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    if(payload.byteLength>(key.algorithm as RsaHashedKeyAlgorithm).modulusLength/8-66)throw new Error('密码编码长度超过当前安全通道限制，请使用较短的密码。');
    return btoa(binary(new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,payload))));
  }
  if(!globalThis.crypto?.getRandomValues)throw new Error('当前浏览器无法生成登录所需的随机数，请使用新版浏览器。');
  const {default:forge}=await import('node-forge');
  const key=forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(forge.util.decode64(publicKey)));
  if(payload.byteLength>Math.ceil(key.n.bitLength()/8)-66)throw new Error('密码编码长度超过当前安全通道限制，请使用较短的密码。');
  return forge.util.encode64(key.encrypt(binary(payload),'RSA-OAEP',{md:forge.md.sha256.create(),mgf1:{md:forge.md.sha256.create()}}));
}

/** Blob hashing also needs a fallback: SubtleCrypto is unavailable on LAN HTTP. */
export async function sha256Blob(file:Blob):Promise<string>{
  if(globalThis.crypto?.subtle)return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())));
  const {sha256}=await import('@noble/hashes/sha2.js'),hash=sha256.create(),reader=file.stream().getReader();
  try{while(true){const {value,done}=await reader.read();if(done)break;hash.update(value);}return hex(hash.digest());}
  finally{reader.releaseLock();hash.destroy();}
}
