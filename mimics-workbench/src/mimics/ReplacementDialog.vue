<script setup lang="ts">
defineProps<{currentName:string;nextName:string;canCache:boolean;busy:boolean;error:string}>();
const emit=defineEmits<{choice:['cancel'|'discard'|'cache']}>();
</script>
<template>
  <div class="mw-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="replace-project-title" class="mw-modal mw-replace-dialog">
    <header><h2 id="replace-project-title">当前工程有未保存的修改</h2></header>
    <p>准备打开“{{nextName}}”。请选择如何处理“{{currentName}}”中的修改。</p>
    <p v-if="!canCache">本地缓存当前不可用。可先取消此次打开并导出工程，或明确放弃修改。</p>
    <div v-if="error" role="alert" class="mw-dialog-error">{{error}}</div>
    <footer><button :disabled="busy" @click="emit('choice','cancel')">取消打开</button><button :disabled="busy" @click="emit('choice','discard')">放弃修改并打开</button><button class="mw-primary" :disabled="busy||!canCache" @click="emit('choice','cache')">保留本地副本并打开</button></footer>
  </section></div>
</template>
