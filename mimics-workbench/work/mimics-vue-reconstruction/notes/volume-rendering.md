# 独立 Volume Rendering：真实体纹理光线积分

## 证据与同源边界

阅读了本机CHM提取页 `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Volume rendering.txt`：

- 无需先分割Mask即可显示影像体素；灰度/HU决定透明度。
- opacity曲线可左键拖点、在线上加点、右键删除；颜色控制点之间插值。
- 文档列bone、soft tissue、both三类CT预设，并有保存/删除自定义预设的说明。
- **纯可视化工具，不能用于导出。** 它与Mask→Marching Cubes→Part/STL是不同链路。

这些是D级文档证据。本轮没有恢复原Mimics GPU shader、纹理格式、采样步长、early termination、光照模型或原厂预设的数值曲线。当前实现是明确独立的WebGL2光线积分；不把行业算法说成原厂已逆向核实，不以表面mesh或静态截图替代体绘制。

## 文件与组件 API

- `src/mimics/VolumeViewport.vue`：pure WebGL2 3D纹理视图，只有Vue依赖。
- `src/mimics/volumeRendering.ts`：可单独验证的affine、ray-box、三线性、传递函数/浮点LUT、opacity校正和合成数学。
- `tests/mimics-volume-rendering.test.ts`：纯函数测试。

```ts
props: {
  grid: VolumeGrid;
  windowCenter?: number;
  windowWidth?: number;
  preset?: 'bone'|'soft'|'both';
  opacity?: number;
  maxTextureBytes?: number; // 默认256 MiB，显式资源预算
}
// expose: fit(), reload()
```

不接收Mask或Part，不调用MC，不生成TriangleMesh，不提供STL导出。原始grid替换时重建体纹理；如果外部原地改写同一grid.data，需要显式调用reload，避免对数百万体素做Vue深度侦听。组件内的传递函数编辑暂属于当前视图状态，未接入项目序列化或用户预设库。

界面包括bone/soft/both示例预设、旋转、Shift/右键平移、滚轮/触控捏合缩放、适配、光照开关、全局opacity、mm采样步长，以及传递函数编辑器。图内点击增加点、左键拖动灰度/alpha、右键或Delete删点、数字框精确编辑、color input改色；至少保留两个、灰度不能重复，拖动保持顺序。颜色与opacity共用一组控制点，是独立UI设计，没有照搬原厂分开两图的全部交互。

## 真正的GPU管线

1. 上传完整 `Float32Array` 为 `TEXTURE_3D / R32F / RED / FLOAT`。不创建网格，没有表面阈值假体绘制。
2. 全屏三角形逐fragment形成正交相机射线，使用 `R=Ry(yaw)Rx(pitch)` 的转置回到world。相机和ray都采用减去影像物理中心的相对坐标，避免较大DICOM translation消耗单精度有效位。
3. 用完整inverse affine把world ray转换成texture ray，clip到归一化box `[0,1]^3`，slab交点参数保持world-mm距离。
4. 沿ray按给定mm步长采样。3D纹理NEAREST，但shader用8次 `texelFetch` 手动完成三线性，支持缺少float-linear扩展的WebGL2；这是连续灰度采样，不是nearest体素堆叠。
5. 灰度映射到1024项 `RGBA32F` 传递纹理，手动用两次texelFetch插值。float sampler显式highp，不把alpha量化到8bit。不需要float FBO附件扩展。
6. 对每段长度dt，把1mm参考opacity校正为 `1−(1−alpha*globalOpacity)^dt`；前到后累积预乘颜色与alpha。最后一段使用实际剩余长度，采样点取该段中点；累积alpha>0.995后提前终止。
7. 可选梯度光照以邻体素中心差分求voxel gradient，通过inverse-affine转置映射成物理梯度，再进入view坐标做环境/漫反射。它是独立定性显示模型，不是原厂照明恢复或扫描物理光谱模拟。

窗宽/窗位仅调节颜色亮度：`color *= .3 + .7*clamp((value−WC)/WW+.5)`，透明度仍由原始灰度控制曲线决定，不会因窗位变化重新分割对象。RGB按当前控制值直接合成，没有做医用显示校准或完整色彩管理。

## 物理空间与边界

支持各向异性spacing、3×4或标准4×4 row-major affine，包括旋转、平移、剪切和负determinant反射；零/近奇异、非有限、透视矩阵显式拒绝。affine存在时是几何依据，不把spacing额外再乘一次。

体素中心索引为整数。体积支持域是voxel box `[-.5,-.5,-.5]` 到 `dims−.5`，因此归一化texture坐标为 `(voxel+.5)/dims`，完整物理盒尺寸包含全部体素宽度。外层半体素区域按clamp-to-edge保持边缘样本值；不把最后一个中心误当作体积外边界。

相机fit取8个物理角点的world AABB；**ray clip仍用inverse affine后的真实texture box**，并非把斜置影像误填成AABB。world direction归一化，因此ray t与采样步长单位均为mm。CPU参考采样与shader采用相同voxel-centred三线性公式。

## 内存、上限与失败

默认显式GPU体纹理预算256MiB，`textureBytes = voxelCount*4`；lookup约16KiB，除此还有浏览器framebuffer、driver staging与已有CPU体数据，因此预算不是整台显卡总内存保证。可由父级明确传 `maxTextureBytes`；没有按设备猜测后静默降低体素尺寸。

每次上传读取实际 `MAX_3D_TEXTURE_SIZE`，任何轴超限直接报错并显示原尺寸/硬件上限。NaN/Infinity、非法尺寸、数据长度不匹配、GPU分配/GL错误也显示明确错误，不切换成Part模型掩盖失败。

shader每ray最多4096段。组件按整个world AABB对角线/step作保守预算，可能比某个当前视角的实际穿透长度更大；超过预算时要求增加步长，不偷偷在4096截断后显示缺失体积。过小/无效步长、非正窗宽、超范围opacity也提示错误。

WebGL2不可用时直接提示该视图需要3D纹理，不以WebGL1表面显示替代。Context lost时提示等待恢复，恢复后重建shader和体纹理。ResizeObserver、RAF、3D/LUT纹理、program、context事件和pointer状态在销毁时释放。当前没有分块流式纹理、out-of-core加载或自动降采样；超大CT需要由用户在其他流程明确选择重采样或提高预算。

## 可复现测试与验证状态

```
node --experimental-strip-types --test tests/mimics-volume-rendering.test.ts
node_modules/.bin/vue-tsc --noEmit
```

14项纯函数测试通过：

- half-voxel物理支持尺寸、各向异性间距。
- 完整旋转/剪切/反射/平移affine往返、normalized texture坐标、world相对中心及大translation。
- parallel/inside/negative/missing ray-box与仿射下真实mm距离。
- 三线性采样在线性标量场精确复现，half-voxel外部返回undefined。
- MAX3D和内存预算显式失败，来源没有降采样/改写；NaN和非法affine失败。
- 控制点排序不变性、RGB/alpha插值、浮点LUT边界/中点与fresh示例预设。
- 同一均匀介质100小步与一大步得到相同衰减；前后颜色次序改变时结果不同，证明CPU数学不是选某个不透明等值面。
- 4096预算、非法步长和窗宽窗位边界。

现有96×96×64演示体的R32F体纹理为2.25MiB。上述是CPU数学与Vue类型检查，**不能算真实GPU验收**。本代理没有新开浏览器，按主任务要求交由root在已批准的5173 origin主审shader编译、实际图像、预设切换、透明度/步长变化、相机交互与资源释放。

未完成项：原厂GPU/预设的同源差分、真实显卡兼容矩阵/性能回归、传递函数项目持久化、自定义预设库、裁切平面/分块流式数据、显示校准和临床验证。独立Volume Rendering模块已经真实编码；“Mimics17全部体绘制行为完美复现”仍未达到。
