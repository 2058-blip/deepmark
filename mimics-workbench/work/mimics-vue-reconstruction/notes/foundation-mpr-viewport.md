# Physical MPR viewport integration

本阶段自属文件为 `src/mimics/MprViewport.vue` 与 `tests/mimics-mpr-viewport.test.ts`；没有修改既有 ImageViewport、PartViewport、Workbench、controller、types 或 project。`mpr.ts` 重采样核由 audit agent、共享 MprPlane/schema 由 project agent、MPR view/controller 与 Workbench 接线由 root 负责。

只读帮助证据：`Online reslice.txt` 明确原项目保留、可由 2D/3D 三点定义 plane、工具箱支持 rotate/move/resize；`Online reslice2.txt` 同样区分非破坏的在线重切片；`Measure Area.txt` 明确 normal/MPR area 与点菜单，`Measure Ellipse.txt` 明确轴端、中心、角点、标签和创建中的变量。帮助没有给出本次三线性插值核、边缘 valid、输出分辨率、命中容差或坐标 epoch 的算法，不能作为原版数值等价证明。

## Display and coordinates

组件直接调用 `sampleMprSlice` 在物理平面上重采样源 grid，没有创建虚拟 source volume，也没有调用原 Image 控制器。MprPlane 的 origin 是 sample(0,0) 中心 world mm，u/v 是正交的完整像素步长向量，size 是输出像素数。显示约定为 sample x 向右、sample y 向上；ImageData 行在写入时翻转。像素支持域到半像素边界，独立 dx/dy 物理间距经统一 mm→CSS 比例显示；world↔canvas 使用真实 plane 映射，不把 IJK 当 MPR pixel。

灰度默认 linear，可选择 nearest；gray valid=0 时画明确背景色。source half-cell support 与 gray center-box valid 独立：边缘 gray 无效而 nearest Mask 仍有效时仍可叠加 Mask。每个 Mask 保留独立 nearest 采样及原顺序 opacity 叠加，不合并或重写 source Mask。实际 grid/Mask 数据身份或每个 Mask.revision 更新会使采样缓存失效；仅名称/颜色/opacity 与不改变内容的工程 revision 更新只重绘。相同 Uint8Array 的成员修改须显式递增 Mask.revision；无版本裸写不是受支持的外部修改协议。source grid/plane 校验或资源预算失败时提供可见错误。资源上限由 `mpr.ts` 验证，不宣称此 SFC 另有原版内存策略。

crosshair 接收独立精确 world 点；没有提供时才将原 point IJK 转 world。右键/中键平移，Ctrl/Shift+wheel 保持指针下的 world 点缩放，普通 wheel 发送有符号 mm 距离及当前 plane/viewId；组件不自行移动 shared plane、不修改原 IJK。Shift+左键只发一次世界定位；navigate 支持持续拖动定位。每个实例只在自己的 host 处理键盘，不创建三个 window Enter 监听；可由 Workbench 用相同组件渲染三张独立正交 MPR。

## World-plane events and editing

所有 pick/edit payload 使用专门的 `mprPlane` 字段，不伪装成 SlicePlane 的 axis/index；world corners 用于 density 创建。事件包含开始时 volume、document revision 和 mprRevision（缺省 0），mprPlane 是独立 clone。scroll 使用 `{distanceMm,plane,viewId,volume,revision,mprRevision}`。point 仅发连续 world 向量，由 root 决定更新独立 crosshair；原 IJK 同步是 root 的显式操作。

支持 distance/angle/diameter/area/ellipse/annotation 放点与普通控制点拖动；`mpr-plane` 工具也发 world pick，供 root 独立收集三点，不创建测量。普通对象只在真实共面的 MPR 显示，使用 root 的 `coplanarMprPlanes`：单位法向量差（含反向等价）小于 1e-12，origin 法向距离小于 1e-5 mm。Density 还必须通过共享 `sameMprOrientation`，u/v 单位方向差各小于 1e-12；微小旋转也不能将旧 sample ROI 解释成新方向的框。

Area 右击具体点 Add/Remove；本应用在选点到下一点的 world 中点插入新点，可再拖动。至少保留三个点。候选使用既有 evaluator 验证，自交只预览原因，release 不提交。增删发一次完整 world 点数组，来源长度和历史事务由专门 MPR controller 处理。

Ellipse 复用共享 frame，显示四个派生轴端、中心、bounding-box 四角与真实物理轮廓。raw p2 的长轴分量不被误画为短轴 handle。四端缩放、刚性中心平移、绕法向角点旋转保持三个 world 参数；无移动 click 不 canonicalize 旧点、不发历史提交。labelOffset 相对共享 world anchor，标签拖动只发 label 更新。创建第一点后用暂定短半轴 a/2 显示预览，第二点后 mousemove 定短轴，第三次点击确认；这些未由帮助规定的操作在画布中明示为应用选择。零短轴第三点不发送 pick，移动到有效候选清除旧错误。

Annotation 使用既有共享布局绘制 rotation/alignment/arrow、长文三个点和完整 hover；双击文字只发 Properties，不完成轮廓；anchor 拖动保持 world-plane 约束。普通几何编辑的 label/详情预览调用既有 evaluator，并发只读 previewMeasurementGeometry；end/cancel 清为 null。密度只预览轮廓，不提前更新统计。

Density rectangle/ellipse 在 sample-plane 坐标编辑，默认宽高来自 densitySize（缺省 10×10 output pixels）。点击默认放置、拖动三 CSS px 后由起点/对角定义；矩形八标记、椭圆四标记，非标记边框整体移动。位置夹到 output half-pixel 支持，松开才将两角转 world 并提交一次。无零宽高提交。

所有手势冻结 plane、grid、volume、document revision、mprRevision 与测量几何/来源签名。取消/capture loss/Escape/换工具/busy/换 plane/pose-cycle/插值模式/换文档或 revision 不提交迟到事件；原地逐点来源改变也会失效。局部 preview 不修改 source Mask、source grid 或工程对象。

## Verification and boundaries

```text
node --experimental-strip-types --test tests/mimics-mpr-viewport.test.ts
8 tests, 8 passed, 0 failed
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
exit 0
```

真实 SFC/编译模板测试覆盖：带 shear 源 affine 的斜物理 plane 上独立灰度 419/3 oracle 与 nearest 对照、valid/support 边缘背景及重叠 Mask；同身份数组 revision 刷新；连续 world 定位、指针锚定 zoom/pan、viewId normal scroll；七种工具 world-plane snapshots；Area 点拖/menu/自交拒交；Ellipse 派生 handle、无移动 no-op、真实 canvas、中心/90° 旋转/label；staged 变量与 Annotation；两类 Density click/drag/resize/border；微旋转/微法向差的显示隔离；五种编辑 × 十二种失效场景。

测试只用 synthetic fixtures 与最小 Canvas 命令记录；没有真实浏览器验收、患者数据、原版运行或许可行为。全仓/controller/项目恢复/build 以 root 和相应代理日志为准。此为第一阶段记录；Ctrl 蓝十字在下节继续实现。CPR 曲线重建仍不在该物理平面视口中，不能把本组件等同于完整原版 Online Reslice。

## Ctrl blue axes and asynchronous sampling integration

后续阶段自属新增修改了 MprViewport、必要的 ImageViewport 与各自 SFC 测试。`mprInteraction.ts` 几何/原始 IJK 的正交物理上下文由 root 提供，RP 对象持久化、选择、历史和 Workbench 接线由 root/project agent 负责；Worker/client/useMprSampling 由 audit agent 独占。本节不把组件事件测试等同于 RP 工程恢复或真实 Worker 全链路测试。

直接读原帮助 `Along Plane2.txt`：Ctrl 时 crosshair 变蓝，抓轴旋转、抓中心平移；在所有二维图像可操作；蓝色交互十字与视图相交定位十字独立，滚片不会自动更新蓝十字的位置。帮助没有说明松开还是拖动中重采样、屏幕容差或投影公式。本实现明确使用本地蓝轴预览，drop 才发一次 transformMpr；不宣称已复原原版实时刷新策略。

组件接收 interactivePlane（当前选中的 RP）、interactiveCenter（RP 世界枢轴）、interactiveEnabled，蓝色枢轴不是普通白色 crosshair/point。仅 Ctrl 按住时显示蓝轴与中心；普通白色定位十字同时保留。使用共享 helper 计算两条 base 法向平面与当前显示面的交线，MPR 由 viewId 保持轴身份，原始 IJK 由最平行法向选择排除轴，不画三线星。中心优先 8 CSS px，轴线容差 6 CSS px，均为本应用选择。

Ctrl+左键抓中心得到当前显示平面内的 world 位移，同时平移 RP 和真实枢轴；抓轴绕当前显示面的单位法向、经过真实枢轴旋转完整 RP。枢轴可离开当前 slice，渲染投影和旋转均保留其法向偏移，不把枢轴吸到当前 slice。原始 Image 的鼠标反变换继续使用完整 shear affine，再由 helper 给出 orthogonal sourcePlane 元数据，不重新创建 volume/采样旧图像。MPR 蓝轴拖动不改变传给异步采样器的显示 plane，因此不会为本地预览请求新灰度。

Ctrl 命中优先于测量与画笔；interactiveEnabled 时 Ctrl 未命中也不穿透为测量或笔画，Ctrl-wheel 继续镜头缩放，既有 Shift 单次定位优先级保留。停止 interactive 后原 Ctrl 刷子尺寸手势继续可用。window 只为 Ctrl 视觉监听 keydown/keyup/blur，不新增全局 Enter。释放 Ctrl、blur、Escape、capture loss/pointercancel、换源面/工具/busy/文档/revision/mprRevision/RP/枢轴均丢弃 preview。release payload 包含候选 RP plane/crosshair、冻结 sourcePlane、volume、document revision、mprRevision；只有实际移动且候选有效才发出，不用点击 canonicalize RP。

MprViewport 已接入 useMprSampling：samples/loading/error 驱动显示，loading 有可见状态，新请求不画上一 pose 的灰度；Worker 失败显示错误，不在 UI 线程静默同步回退；卸载 dispose 释放该视口 owner。颜色/window/opacity 仅重新组合像素。相同 Mask buffer 内容修改配合 Mask.revision 递增的回归仍保留；未将无版本原地写入加入缓存协议。

```text
node --experimental-strip-types --test tests/mimics-mpr-viewport.test.ts tests/mimics-viewport.test.ts
60 tests, 60 passed, 0 failed
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
exit 0
```

60 项为 49 项既有 viewport/controller/SFC 与 11 项 MPR SFC。新增 source/MPR 两侧蓝轴实际 Canvas、平移、90° 旋转、离 slice 枢轴、白十字不变、无早提交、Ctrl miss/no-op/brush 恢复、source shear 的独立 world oracle，以及两侧各 17 类取消/上下文失效。MPR 快测通过确定性的 composable adapter 调用真实 sampleMprSlice 维持画布与事件 oracle；真实 Worker 的 source resident/generation/取消由 audit 专项验证。另有一条实际 useMprSampling 在无 Worker 环境的 SFC 错误测试，确认 samples/raster 为 null、显示错误且不放测量点。没有浏览器验收或全仓 build 声明。

### 原始 IJK 法向列 shear 的蓝轴投影修复

主审找到原始 Image 蓝轴的实际物理误差：直接将离片 world pivot 逆变成 IJK 再忽略法向坐标，会沿 affine 的法向列斜投。现在仅对蓝枢轴及其轴端先按 sourceSliceMprPlane 的真实单位法向投影到当前物理 slice，再调用原 worldToVoxel/screen；普通测量投影及 pointerWorld 没有全域改动。

新增独立反例 affine=`[[1,0,1,0],[0,1,0,0],[0,0,1,0]]`、slice K=5：world 原点应先投到 (0,0,5)，对应 I=-5，而非 I=0。进一步用可见 pivot=(8,4,0) 验证实际 Canvas 蓝中心在 I=3/J=4，未画在旧 I=8/J=4；正确位置 hit 为平移中心，旧位置只能是轴线。真实拖动从 I3/J4 到 I4/J6 后只在 drop 发一次 world delta=(1,2,0)，RP 枢轴仍保持 z=0，未误旋转、写 Mask 或移动白十字。

修复后重新运行两个视口测试文件：61/61（50 viewport +11 MPR）通过，vue-tsc --noEmit exit 0。只有 Image 蓝轴投影、对应测试和本说明变更。
