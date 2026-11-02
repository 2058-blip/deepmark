<script setup lang="ts">
import {computed} from 'vue';
const props=withDefaults(defineProps<{name:string;size?:number}>(),{size:18});
const paths:Record<string,string[]>={
  plus:['M12 5v14','M5 12h14'],back:['m10 6-6 6 6 6','M4 12h15'],chevron:['m9 6 6 6-6 6'],
  brush:['m9 14 9-10a2 2 0 0 1 3 3L11 16','m9 14 2 2','M9 14c-3-2-5 1-4 3 0 1-1 2-2 3 4 1 8-1 8-4'],
  eraser:['m4 13 9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8H9l-5-4a2 2 0 0 1 0-3Z','M8 9l9 8','M13 20h8'],
  threshold:['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z','M12 4v16','M6 8h6','M4 12h8','M6 16h6'],
  region:['M6 4h3m4 0h4l3 3v3m0 4v3l-3 3h-3m-4 0H7l-3-3v-3m0-4V7l2-3Z','M14 12a2 2 0 1 0-4 0 2 2 0 0 0 4 0'],
  eye:['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z','M14.5 12a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0'],
  'eye-off':['m3 3 18 18','M10.5 6.1 12 6c6 0 9.5 6 9.5 6a23 23 0 0 1-3 3.6','M6.2 7.7A22 22 0 0 0 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-1'],
  export:['M12 3v12','m8 7 4-4 4 4','M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'],
  undo:['m8 5-5 5 5 5','M3 10h11a6 6 0 0 1 0 12'],redo:['m16 5 5 5-5 5','M21 10H10a6 6 0 0 0 0 12'],
  focus:['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z','M14 4v16','M14 12h7'],
  columns:['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z','M9 4v16','M15 4v16'],
  maximize:['M8 3H3v5','M16 3h5v5','M21 16v5h-5','M3 16v5h5'],
  restore:['M3 8h5V3','M21 8h-5V3','M16 21v-5h5','M8 21v-5H3'],
  check:['m5 12 4 4L19 6'],help:['M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0','M9.3 9a2.8 2.8 0 1 1 4.2 2.4c-1 .5-1.5 1-1.5 2.1','M12 17v.1'],
  cache:['M4 7h16v13H4Z','M7 3h10v4','M9 12h6'],logout:['M9 4H4v16h5','M12 12h9','m17 8 4 4-4 4']
};
const lines=computed(()=>paths[props.name]||paths.help);
</script>
<template><svg class="dm-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path v-for="(path,index) in lines" :key="index" :d="path"/></svg></template>
