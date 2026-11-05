<script setup lang="ts">
import {reactive} from 'vue';
import type {useAdvancedTools} from './useAdvancedTools.ts';
const props=defineProps<{tools:ReturnType<typeof useAdvancedTools>;busy:boolean;hasVolume:boolean;maskName?:string;partName?:string;surfaceOnly?:boolean}>();
const emit=defineEmits<{tool:[string];applyPreview:[]}>();
const a=reactive(props.tools);
function display(value?:number){return value===undefined||!Number.isFinite(value)?'—':value.toFixed(2);}
</script>
<template>
  <div class="mw-options advanced-panel">
    <template v-if="surfaceOnly">
      <div class="mw-divider"/><div class="mw-panel-title">平面切割</div>
      <p class="mw-hint">当前表面：{{partName||'未选择'}}。平面采用世界坐标 mm。</p>
      <button :disabled="!hasVolume||busy" @click="a.cutAtCrosshair">平面经过当前十字线</button>
      <div class="advanced-vector"><label v-for="(name,i) in ['X','Y','Z']" :key="name">{{name}}<input v-model.number="a.parameters.cutOrigin[i]" type="number" :disabled="busy"></label></div>
      <div class="advanced-vector"><label v-for="(name,i) in ['Nx','Ny','Nz']" :key="name">{{name}}<input v-model.number="a.parameters.cutNormal[i]" type="number" step=".1" :disabled="busy"></label></div>
      <label class="mw-check"><input v-model="a.parameters.cap" type="checkbox" :disabled="busy">封闭切面（保留孔洞）</label>
      <label class="mw-check"><input v-model="a.parameters.keepOriginals" type="checkbox" :disabled="busy">保留原模型</label>
      <button :disabled="!partName||busy" @click="a.cut">切割为平面两侧</button><button :disabled="!partName||busy" @click="a.splitParts">按连通壳分离</button>
      <div class="mw-divider"/><div class="mw-panel-title">表面修复</div>
      <button :disabled="!partName||busy" @click="a.repair('fixNormals')">修正方向，保留内部空腔</button>
      <label>边界缝合容差 mm<input v-model.number="a.parameters.stitchTolerance" type="number" min="0" step=".001" :disabled="busy"></label>
      <button :disabled="!partName||busy" @click="a.repair('stitch')">缝合邻近开放边</button>
    </template>
    <template v-else>
      <div class="mw-panel-title">轮廓与中心线</div>
      <select v-model="a.parameters.mode" :disabled="busy" aria-label="高级工具类别"><option value="centerline">中心线与截面量测</option><option value="polylines">切片轮廓 Polyline</option><option value="label">实体文字 Label</option><option value="smoothMask">Mask 平滑</option></select>
      <template v-if="a.parameters.mode==='centerline'">
        <div class="mw-panel-title">建立中心线</div>
        <label>输入<select v-model="a.parameters.centerlineSource" :disabled="busy"><option value="mask">当前 Mask：{{maskName||'未选择'}}</option><option value="part">当前表面：{{partName||'未选择'}}</option></select></label>
        <button class="mw-primary" :disabled="!hasVolume||busy" @click="a.startSeeds">在影像内指定根点和终点</button>
        <p class="mw-hint">第一个点为根点，后续为终点；可跨切片设置。路径在分割内部求解。</p>
        <div v-for="(p,i) in a.seeds" :key="i" class="advanced-seed"><span>{{i===0?'根点':'终点 '+i}}：{{p.join(', ')}}</span><button :disabled="busy" @click="a.seeds=a.seeds.filter((_,j)=>i!==j)">×</button></div>
        <div class="mw-two"><label>控制点间距 mm<input v-model.number="a.parameters.controlSpacingMm" type="number" min=".1" step=".5" :disabled="busy"></label><label>中心偏好<input v-model.number="a.parameters.centerWeight" type="number" min="0" step=".5" :disabled="busy"></label></div>
        <button :disabled="a.seeds.length<2||busy" @click="a.fit">计算中心线</button>
        <template v-if="a.centerlines.length">
          <div class="mw-divider"/><label>活动中心线<select :value="a.activeCenterline?.id" :disabled="busy" @change="a.selectCenterline(($event.target as HTMLSelectElement).value)"><option v-for="o in a.centerlines" :key="o.id" :value="o.id">{{o.name}}</option></select></label>
          <p class="mw-hint">{{a.activeCenterline?.graph.branches.length}} 个分支 · {{a.activeCenterline?.graph.nodes.length}} 个拓扑节点</p>
          <label>分支<select v-model="a.parameters.branchId" :disabled="busy" @change="a.parameters.pointIndex=0;a.setMovePoint()"><option value="">首分支</option><option v-for="b in a.activeCenterline?.graph.branches" :key="b.id" :value="b.id">{{b.id}} · {{b.points.length}} 路径点</option></select></label>
          <label>路径点索引<input v-model.number="a.parameters.pointIndex" type="number" min="0" :max="(a.branch?.points.length||1)-1" :disabled="busy" @change="a.setMovePoint"></label>
          <button :disabled="busy" @click="a.setMovePoint">读取控制点坐标</button>
          <div class="advanced-vector"><label v-for="(name,i) in ['X','Y','Z']" :key="name">{{name}} mm<input v-model.number="a.parameters.movePoint[i]" type="number" step=".1" :disabled="busy"></label></div>
          <label>编辑影响范围 mm<input v-model.number="a.parameters.influenceMm" type="number" min="0" step=".5" :disabled="busy"></label><button :disabled="busy" @click="a.movePoint">移动控制点</button>
          <div class="mw-two"><button :disabled="busy" @click="a.split">在此点分割</button><button :disabled="busy" @click="a.deleteBranch">删除分支</button></div>
          <button :disabled="busy" @click="a.grow">从此点生长至十字线</button>
          <div class="mw-two"><label>平滑强度<input v-model.number="a.parameters.smoothFactor" type="number" min="0" step=".05" :disabled="busy"></label><label>短分支 mm<input v-model.number="a.parameters.shortBranchMm" type="number" min="0" step=".5" :disabled="busy"></label></div>
          <div class="mw-two"><button :disabled="busy" @click="a.smooth">平滑中心线</button><button :disabled="busy" @click="a.filter">过滤短分支</button></div>
          <div class="mw-divider"/><div class="mw-panel-title">截面测量</div><p class="mw-hint">以当前三维表面求控制点处的正交截面。未求得闭合轮廓的点会保留错误说明。</p><button :disabled="!partName||busy" @click="a.measure">计算截面指标</button>
          <div v-if="a.rows.length" class="advanced-table"><table><thead><tr><th>分支/点</th><th>面积</th><th>Dfit</th><th>Dmin/max</th></tr></thead><tbody><tr v-for="row in a.rows.slice(0,100)" :key="row.branchId+':'+row.pointIndex" :title="row.error"><td>{{row.branchId}}/{{row.pointIndex}}</td><td>{{display(row.section?.area)}}</td><td>{{display(row.section?.Dfit)}}</td><td>{{display(row.section?.Dmin)}}/{{display(row.section?.Dmax)}}</td></tr></tbody></table></div>
          <button :disabled="busy" @click="a.exportCSV">导出中心线及指标 CSV</button>
        </template>
      </template>
      <template v-else-if="a.parameters.mode==='polylines'">
        <p class="mw-hint">从活动 Mask 提取切片轮廓，外环、孔洞与非连通区域分别保留。</p><label>方向<select v-model.number="a.parameters.polylineAxis" :disabled="busy"><option :value="2">K / 轴向</option><option :value="1">J</option><option :value="0">I</option></select></label><button :disabled="!maskName||busy" @click="a.calculatePolylines">计算所有切片轮廓</button>
        <template v-if="a.polylines.length"><label>轮廓集合<select :value="a.activePolyline?.id" :disabled="busy" @change="a.selectPolyline(($event.target as HTMLSelectElement).value)"><option v-for="o in a.polylines" :key="o.id" :value="o.id">{{o.name}}</option></select></label><span class="mw-hint">{{a.activePolyline?.set.layers.length}} 层 · {{a.physicalPolyline?'物理坐标轮廓':'原始切片轮廓'}}</span><template v-if="a.physicalPolyline"><label>物理轮廓层<select v-model.number="a.parameters.physicalLayer" :disabled="busy" aria-label="物理轮廓层"><option v-for="(layer,index) in a.activePolyline?.set.layers" :key="index" :value="index">{{index+1}} · {{layer.rings.length}} 环</option></select></label><button :disabled="busy||!a.activePolyline?.set.layers.length" @click="a.locatePolylineLayer">定位到此轮廓平面</button><p class="mw-hint">轮廓保留重切片前的物理形状；更新仅重新提取所选平面，其他层保留。</p></template><button :disabled="!maskName||busy" @click="a.updatePolylines">{{a.physicalPolyline?'更新所选物理层':'更新当前层轮廓'}}</button><button :disabled="busy" @click="a.fillPolylines">填充轮廓为新 Mask</button><button :disabled="busy" @click="a.exportPolylines">导出轮廓 JSON</button></template>
      </template>
      <template v-else-if="a.parameters.mode==='label'">
        <p class="mw-hint">实体文字会写入 Mask，并可成为后续三维几何。起点为当前十字线；文字沿当前切片方向放置。</p><button :disabled="busy" @click="emit('tool','navigate')">定位文字起点</button><label>文字<input v-model="a.parameters.labelText" maxlength="120" :disabled="busy"></label><label>字体<select v-model="a.parameters.labelFont" :disabled="busy"><option>Arial</option><option>Microsoft YaHei</option><option>Times New Roman</option><option>Consolas</option></select></label><div class="mw-two"><label>字高 mm<input v-model.number="a.parameters.labelHeightMm" type="number" min=".1" step=".5" :disabled="busy"></label><label>厚度 mm<input v-model.number="a.parameters.labelDepthMm" type="number" min=".1" step=".5" :disabled="busy"></label></div><label>作用<select v-model="a.parameters.labelOperation" :disabled="busy"><option value="add">增加实体</option><option value="remove">刻除文字</option></select></label><button :disabled="!maskName||busy" @click="a.label">计算实体文字预览</button><button :disabled="busy" @click="emit('applyPreview')">应用预览</button>
      </template>
      <template v-else>
        <p class="mw-hint">对体素成员做邻域多数平滑。此工具作用于 Mask；表面平滑在三维重建页。</p><label>独立多数滤波策略<select v-model="a.parameters.smoothStrategy" :disabled="busy"><option value="majority-6">6 邻域</option><option value="majority-26">26 邻域</option></select></label><label>迭代次数<input v-model.number="a.parameters.smoothIterations" type="number" min="1" max="30" :disabled="busy"></label><button :disabled="!maskName||busy" @click="a.smoothMask">平滑活动 Mask</button>
      </template>
    </template>
  </div>
</template>
<style scoped>
.advanced-panel{margin-top:8px}.advanced-vector{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.advanced-seed{display:flex;align-items:center;justify-content:space-between;color:#bacfe8;font-size:11px;background:#172a42;padding:3px 7px;border-radius:4px}.advanced-seed button{padding:1px 5px}.advanced-table{overflow:auto;max-height:240px}.advanced-table table{border-collapse:collapse;white-space:nowrap;font:10px Consolas}.advanced-table td,.advanced-table th{padding:4px 5px;border:1px solid #2b405b;color:#b2c6df}.advanced-table th{background:#1b304b}
</style>
