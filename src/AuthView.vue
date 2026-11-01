<script setup lang="ts">
import {computed,ref} from 'vue';
import {api,authUser} from './api.ts';
import type {AuthUser,UserRole} from './api.ts';
import './console.css';
const emit=defineEmits<{authenticated:[user:AuthUser]}>();
const mode=ref<'login'|'register'>('login'),username=ref(''),name=ref(''),password=ref(''),confirmPassword=ref(''),role=ref<UserRole>('worker'),busy=ref(false),error=ref('');
const secure=computed(()=>!!crypto.subtle&&isSecureContext&&(location.protocol==='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname)));
function bytes(value:string){const text=value.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}
function encode(value:ArrayBuffer){let text='';for(const n of new Uint8Array(value))text+=String.fromCharCode(n);return btoa(text);}
async function submit(){
  if(busy.value)return;error.value='';
  if(!secure.value){error.value='请通过 HTTPS 打开本站后再注册或登录。';return;}
  if(!username.value.trim()||!password.value){error.value='请输入用户名和密码。';return;}
  if(mode.value==='register'&&password.value!==confirmPassword.value){error.value='两次输入的密码不一致。';return;}
  if(new TextEncoder().encode(password.value).byteLength>256){error.value='密码 UTF-8 编码不能超过 256 字节。';return;}
  busy.value=true;
  try{
    const challenge=await api<{challengeId:string;publicKey:string;algorithm:string;expiresAt:string}>('/api/auth/challenge');
    const key=await crypto.subtle.importKey('spki',bytes(challenge.publicKey),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const payload=new TextEncoder().encode(JSON.stringify({challengeId:challenge.challengeId,password:password.value}));
    const maxBytes=((key.algorithm as RsaHashedKeyAlgorithm).modulusLength/8)-66;
    if(payload.byteLength>maxBytes)throw new Error('密码编码长度超过当前安全通道限制，请使用较短的密码。');
    const encryptedPassword=encode(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,payload));
    const result=await api<{user:AuthUser}>(`/api/auth/${mode.value}`,{method:'POST',body:JSON.stringify({username:username.value.trim(),challengeId:challenge.challengeId,encryptedPassword,...(mode.value==='register'?{name:name.value.trim()||username.value.trim(),role:role.value}:{})})});
    password.value='';confirmPassword.value='';authUser.value=result.user;emit('authenticated',result.user);
  }catch(reason){error.value=(reason as Error).message;}finally{busy.value=false;}
}
</script>
<template>
  <main class="auth-page">
    <section class="auth-intro"><div class="console-brand">✚ DeepMark</div><h1>让标注任务与团队工作连接起来</h1><p>派活账号发布医学影像并查看进展，干活账号组成小组，使用三切面工具共同完成标注。</p><div class="auth-role-summary"><strong>派活</strong><span>上传影像 · 实时监看 · 获取成果</span><strong>干活</strong><span>加入小组 · 认领任务 · 协同标注</span></div></section>
    <section class="auth-card" aria-labelledby="auth-title"><div class="auth-tabs"><button data-testid="auth-mode-login" :class="{active:mode==='login'}" :disabled="busy" @click="mode='login';error=''">登录</button><button data-testid="auth-mode-register" :class="{active:mode==='register'}" :disabled="busy" @click="mode='register';error=''">注册账号</button></div><h2 id="auth-title">{{mode==='login'?'欢迎回来':'创建你的账号'}}</h2>
      <p v-if="!secure" class="console-error" role="alert">本站登录需要 HTTPS 安全连接，请使用 HTTPS 地址访问。</p>
      <form data-testid="auth-form" @submit.prevent="submit"><label>用户名<input v-model="username" name="username" autocomplete="username" maxlength="40" required :disabled="busy"/></label><label v-if="mode==='register'">显示名称<input v-model="name" name="name" autocomplete="name" maxlength="40" placeholder="留空时使用用户名" :disabled="busy"/></label><label>密码<input v-model="password" name="password" type="password" :autocomplete="mode==='login'?'current-password':'new-password'" :minlength="mode==='register'?8:undefined" maxlength="128" required :disabled="busy"/></label><label v-if="mode==='register'">确认密码<input v-model="confirmPassword" type="password" autocomplete="new-password" maxlength="128" required :disabled="busy"/></label>
        <fieldset v-if="mode==='register'" :disabled="busy"><legend>账号角色</legend><label class="auth-role"><input v-model="role" type="radio" value="dispatcher"/><span><strong>派活</strong><small>发布影像、监看任务、下载成果</small></span></label><label class="auth-role"><input v-model="role" type="radio" value="worker"/><span><strong>干活</strong><small>创建或加入小组，完成协同标注</small></span></label></fieldset>
        <p v-if="error" class="console-error" role="alert">{{error}}</p><button data-testid="auth-submit" class="primary auth-submit" :disabled="busy||!secure">{{busy?'正在安全验证…':mode==='login'?'登录':'注册并进入工作台'}}</button><p class="auth-security">密码通过一次性公钥挑战加密后发送，登录状态使用受保护的会话 Cookie。</p>
      </form>
    </section>
  </main>
</template>
