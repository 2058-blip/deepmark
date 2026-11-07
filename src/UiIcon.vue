<script setup lang="ts">
import {computed} from 'vue';
import type {Component} from 'vue';
import {PhPlus,PhArrowLeft,PhCaretRight,PhCaretDown,PhPaintBrush,PhEraser,PhCircleHalf,PhSelection,PhEye,PhEyeSlash,PhExport,PhArrowUUpLeft,PhArrowUUpRight,PhLayout,PhColumns,PhSquare,PhCornersOut,PhCornersIn,PhCheck,PhQuestion,PhArchive,PhSignOut,PhHouse,PhFolder,PhTag,PhSun,PhHand,PhUsers,PhStack,PhX,PhMagnifyingGlass,PhArrowClockwise,PhUploadSimple,PhFile,PhShieldCheck,PhSignIn,PhGear,PhCrosshairSimple,PhMagnifyingGlassPlus} from '@phosphor-icons/vue';
const props=withDefaults(defineProps<{name:string;size?:number}>(),{size:18});
const icons:Record<string,Component>={plus:PhPlus,back:PhArrowLeft,chevron:PhCaretRight,down:PhCaretDown,brush:PhPaintBrush,eraser:PhEraser,threshold:PhCircleHalf,region:PhSelection,eye:PhEye,'eye-off':PhEyeSlash,export:PhExport,undo:PhArrowUUpLeft,redo:PhArrowUUpRight,focus:PhLayout,columns:PhColumns,single:PhSquare,maximize:PhCornersOut,restore:PhCornersIn,check:PhCheck,help:PhQuestion,cache:PhArchive,logout:PhSignOut,home:PhHouse,folder:PhFolder,tag:PhTag,sun:PhSun,hand:PhHand,users:PhUsers,layers:PhStack,close:PhX,search:PhMagnifyingGlass,refresh:PhArrowClockwise,upload:PhUploadSimple,file:PhFile,shield:PhShieldCheck,login:PhSignIn,settings:PhGear,fit:PhCrosshairSimple,'zoom-in':PhMagnifyingGlassPlus};
const icon=computed(()=>icons[props.name]||PhQuestion);
</script>
<template><component :is="icon" class="dm-icon" :size="size" weight="regular" aria-hidden="true" focusable="false"/></template>
