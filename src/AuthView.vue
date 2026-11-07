<script setup lang="ts">
import {computed,onMounted,ref} from 'vue';
import {api,authUser} from './api.ts';
import type {AuthUser,UserRole} from './api.ts';
import {encryptLoginPassword} from './browserCrypto.ts';
import type {LoginChallenge} from './browserCrypto.ts';
import UiIcon from './UiIcon.vue';
import './console.css';
import './authTheme.css';
const emit=defineEmits<{authenticated:[user:AuthUser]}>();
const mode=ref<'login'|'register'>('login'),username=ref(''),name=ref(''),password=ref(''),confirmPassword=ref(''),role=ref<UserRole>('worker'),busy=ref(false),error=ref('');
const allowHttp=ref(false),policyLoaded=ref(false);
const secure=computed(()=>location.protocol==='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname)||allowHttp.value);
onMounted(async()=>{try{allowHttp.value=(await api<{allowHttp:boolean}>('/api/auth/policy')).allowHttp;}catch{}finally{policyLoaded.value=true;}});
async function submit(){
  if(busy.value)return;error.value='';
  if(!secure.value){error.value='请通过 HTTPS 打开本站后再注册或登录。';return;}
  if(!username.value.trim()||!password.value){error.value='请输入用户名和密码。';return;}
  if(mode.value==='register'&&password.value!==confirmPassword.value){error.value='两次输入的密码不一致。';return;}
  if(new TextEncoder().encode(password.value).byteLength>256){error.value='密码 UTF-8 编码不能超过 256 字节。';return;}
  busy.value=true;
  try{
    const challenge=await api<LoginChallenge>('/api/auth/challenge');
    const encryptedPassword=await encryptLoginPassword(challenge,password.value);
    const result=await api<{user:AuthUser}>(`/api/auth/${mode.value}`,{method:'POST',body:JSON.stringify({username:username.value.trim(),challengeId:challenge.challengeId,encryptedPassword,...(mode.value==='register'?{name:name.value.trim()||username.value.trim(),role:role.value}:{})})});
    password.value='';confirmPassword.value='';authUser.value=result.user;emit('authenticated',result.user);
  }catch(reason){error.value=(reason as Error).message;}finally{busy.value=false;}
}
</script>
<template>
  <main class="auth-page auth-workspace">
    <header class="auth-topbar"><div class="console-brand">DeepMark</div><span class="auth-site-description">医学影像多人协作标注</span><span class="auth-workspace-label"><UiIcon name="layers" :size="17"/>团队工作台</span></header>
    <div class="auth-content">
    <section class="auth-intro" aria-labelledby="auth-intro-title">
      <span class="auth-eyebrow"><UiIcon name="layers" :size="18"/>影像标注 · 团队协作</span>
      <h1 id="auth-intro-title">从一份影像开始，<br/><span>让团队共同完成标注。</span></h1>
      <p>发布医学影像，由小组认领任务，在同一个工作区完成标注、查看进展与获取成果。</p>
      <div class="auth-role-summary">
        <article><span class="auth-role-icon"><UiIcon name="folder" :size="22"/></span><div><strong>发布者账号</strong><span>上传影像 · 实时监看 · 获取成果</span></div></article>
        <article><span class="auth-role-icon"><UiIcon name="users" :size="22"/></span><div><strong>工作者账号</strong><span>加入小组 · 认领任务 · 协同标注</span></div></article>
      </div>
      <p class="auth-workflow"><span>发布影像</span><UiIcon name="chevron" :size="14"/><span>小组认领</span><UiIcon name="chevron" :size="14"/><span>协同标注</span></p>
    </section>
    <section class="auth-card" aria-labelledby="auth-title"><div class="auth-tabs" role="group" aria-label="账号入口"><button data-testid="auth-mode-login" :aria-pressed="mode==='login'" :class="{active:mode==='login'}" :disabled="busy" @click="mode='login';error=''">登录</button><button data-testid="auth-mode-register" :aria-pressed="mode==='register'" :class="{active:mode==='register'}" :disabled="busy" @click="mode='register';error=''">注册账号</button></div><h2 id="auth-title">{{mode==='login'?'欢迎回来':'创建你的账号'}}</h2><p class="auth-card-note">{{mode==='login'?'登录工作台，继续你的团队任务。':'选择账号角色，进入对应的工作台。'}}</p>
      <p v-if="policyLoaded&&!secure" class="console-error" role="alert">本站登录需要 HTTPS 安全连接，请使用 HTTPS 地址访问。</p>
      <form data-testid="auth-form" @submit.prevent="submit"><label>用户名<input v-model="username" name="username" autocomplete="username" maxlength="40" required :disabled="busy"/></label><label v-if="mode==='register'">显示名称<input v-model="name" name="name" autocomplete="name" maxlength="40" placeholder="留空时使用用户名" :disabled="busy"/></label><label>密码<input v-model="password" name="password" type="password" :autocomplete="mode==='login'?'current-password':'new-password'" :minlength="mode==='register'?8:undefined" maxlength="128" required :disabled="busy"/></label><label v-if="mode==='register'">确认密码<input v-model="confirmPassword" type="password" autocomplete="new-password" maxlength="128" required :disabled="busy"/></label>
        <fieldset v-if="mode==='register'" :disabled="busy"><legend>账号角色</legend><label class="auth-role"><input v-model="role" type="radio" value="dispatcher"/><span><strong>发布者</strong><small>发布影像、监看任务、下载成果</small></span></label><label class="auth-role"><input v-model="role" type="radio" value="worker"/><span><strong>工作者</strong><small>创建或加入小组，完成协同标注</small></span></label></fieldset>
        <p v-if="error" class="console-error" role="alert">{{error}}</p><button data-testid="auth-submit" class="primary auth-submit" :disabled="busy||!secure">{{busy?'正在安全验证…':mode==='login'?'登录':'注册并进入工作台'}}<UiIcon v-if="!busy" name="chevron" :size="17"/></button><p class="auth-security"><UiIcon name="shield" :size="15"/><span>请使用自己的账号登录，标注记录将关联到你的团队身份。</span></p>
      </form>
    </section>
    </div>
  </main>
</template>
