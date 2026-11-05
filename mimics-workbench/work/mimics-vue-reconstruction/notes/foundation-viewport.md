# 基础视口、物理几何与交互链路

本文件包含多轮阶段记录。下方早期的 25/29/32 条测试数及“密集笔刷点插值”描述为历史快照；当前笔刷实现和最新验证以末尾“连续宽高笔刷与审核修复”小节为准。

## 根整合后的最新检查点

后续多片方向/Type/插值屏障、临时独有紫色和源重叠黄色，以及LocalThresholdControls三范围已接入。viewport/dialog专项现21项通过，加volume-rendering14项共35项；根完整项目306/306与生产构建通过，日志`multiple-edit-regression.log`/`multiple-edit-build.log`。新增SFC像素检查直接读取真实ImageViewport离屏RGBA，并验证Workbench参数/状态接线和默认范围只读。

根随后执行了真实浏览器多片画笔、复制跳层、最终Erase与Undo/Redo、Calculate3D及新页面/刷新IndexedDB恢复。具体输入、结果、截图和未执行项以`foundation-browser-multiple-2026-11-05.md`为准。此新增段不把下文历史专项或所有视口参数升级为浏览器通过。

2026-11-05。本代理修改 ImageViewport、PartViewport、VolumeViewport、volumeRendering，新增 viewportGeometry 与 viewport 测试。没有改动主控制器、工程 schema、共享 types 或高级重建算法；没有读取患者资料、启动原 Mimics 或执行浏览器。浏览器由 root 在已授权的本机 synthetic-only 环境统一验收。

## 接线契约

- ImageViewport 增加 `cancel: []` 事件。父组件需将 `@cancel` 接到丢弃笔画草稿的 `brushCancel`。原 begin / stroke / end / point / pick 参数不变。`brushShape?: string` 传 `params.brushShape`，使方形轮廓与实际编辑一致。
- PartViewport 新增 `spatialUnit?: string`、`allowEdit?: boolean`。单位传 volume.unit；缺省明确显示“影像单位”。allowEdit=false 保留相机和对象选择，禁用表面 pick 编辑并取消测量拖点。
- VolumeViewport 新增 `spatialUnit?: string`、`intensityUnit?: string`。单位未知时不显示 mm 或 HU；采样步长与 alpha 的参考距离使用 grid 的物理坐标单位。
- `brushFootprint(grid, axis, diameter)` 返回 `{a,b,du,dv,contains(da,db)}`。圆形笔刷用 du/dv 枚举安全外包范围，再以 contains 判定完整 affine 距离。方形的 IJK 半宽仍是 radius / 对应 affine 列长度，不使用圆形外包范围作为方形边长。

## 本次修复

2D 显示、光标、拾取和三轴交叉线共用一套从体素中心到 CSS 像素的纯几何变换。体素支撑区明确为 [-0.5, dims-0.5]。每个原始 IJK 平面按 affine 的两条列向量嵌入正交的物理平面；列长度与夹角均保留，shear 对应平行四边形，包围盒中的空白角无法拾取。窗宽/窗位仅影响显示，不修改体素。

oblique 或 shear 数据明确显示“原始 IJK 切片”及 I/J/K 方向，不宣称完成标准医学 MPR 重采样。轴对齐数据保留既有方向文字。光标悬停数值 title 同时给出 IJK 和 affine 世界坐标，单位来自 volume.unit。

三视图仍通过父级一个共享整数 point 联动。滚轮更新当前轴；Ctrl/Shift 滚轮缩放围绕光标锚定；平移之后的光标、刷子、测量与拾取继续使用同一变换。仅改变另外两轴的 point 不会误取消当前导航拖动。

笔画按物理距离插值，采样间隔不大于直径四分之一及最小体素边长的一半，并补采 pointerup 最后位置。pointercancel、丢失 capture、Esc、切换工具/对象/当前切片/体数据、进入 busy、改变笔刷直径或形状，都会发 cancel 而非 end。离开图像后重新进入不会跨空白区连接。额外指针不接管当前笔画。既有测量端点只在导航或明确测量工具下可拖动，区域生长、动态生长、腔体、中心线等 seed 工具不会被端点命中拦截。

3D 渲染矩阵、覆盖层投影与拾取射线共用列优先 Y*X 相机 API。拾取仍用实际 mesh BVH 选择最近可见表面，隐藏或 opacity=0 对象不参与。取消/丢失 capture 不会被当成点击，双指缩放抬指后重设基准避免跳变。fit 使用场景包围球并考虑视口宽高比。新增世界 XYZ 方向标；通用 front/top/side 按钮补充 XY/XZ/YZ 及明确观察方向，不能解释为医学解剖前/上/侧标记。

体绘制继续使用完整 R32F 3D 纹理、全 affine 世界空间射线、体素中心手工三线性插值、传递函数和前向积分。WebGL2、纹理尺寸/内存或采样预算不足时明确显示错误；没有使用表面模型替代。修复重新载入失败时遗留旧 metadata，以及指针 capture / pinch 状态；单位从输入显式显示。

## 验证证据

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
25 tests, 25 passed, 0 failed
```

新增 11 条 viewport 测试使用完全合成的体素与 mesh：

- 手算屏幕坐标、半体素边界、真实 affine 长度/夹角、shear 空白角拒绝、三轴共享 point；不是仅用一个函数的逆变换作为 oracle。
- 物理笔刷的 shear 交叉项与连续路径的实际世界距离上界。
- 已知 90° 旋转、独立 GL clip 坐标、世界 ray 原点/方向、实际 BVH 三角形命中及宽窄视口 fit。
- 编译真实三个 Vue SFC 的 setup，驱动 ImageViewport 的 pointerup / pointercancel / lostcapture / Esc / tool / slice / target / busy、导航持续性、seed 互斥、pan 和光标锚定 zoom；驱动 PartViewport 最近表面/透明隐藏、平移后的 pick 和 busy/cancel；核验 VolumeViewport 未知单位与 WebGL2 缺失错误。
- 保留既有 14 条 volume-rendering 核测试：仿射/大平移、采样、传递 LUT、alpha 步长修正、内存及采样预算。

SFC setup 测试只使用最小 CSS canvas stub，没有挂载真实 DOM，没有模拟成功 WebGL，也不把它称作浏览器验收。真实画面、设备像素比、驱动 shader 和原生指针 capture 仍需 root 浏览器检查。没有运行全仓测试或应用构建。

## 保留边界

- 原始 IJK 切片具有正确物理几何，不提供任意 oblique MPR 重采样或三维剪切体的正交重建。
- 体纹理不自动降采样；内存/尺寸/4096 次积分预算不足时用户看到明确错误。
- 透明 Part 仍按对象中心排序，不能当作任意相交透明面的精确排序。
- 各视口的相机、pan/zoom 未写入工程保存 schema；未宣称重启可恢复这些状态。
- root 负责笔画事务目标和参数冻结、cancel 接线、未知空间单位确认和编辑门禁、总构建及浏览器验收。本说明中的组件能力不替代这些父级接线结果。

## 原生 Calculate 3D 操作补充

用户要求操作尽可能原生后，新增独立 `src/mimics/Calculate3DDialog.vue`，没有改父级文件。只读复核的本地参考为：

- `work/mimics-17-analysis/evidence/help/chm/Resources/Images/Calculate3D_common.png`：左侧 Mask 名称和下/上阈值列表、右侧 Quality 与 Options、底部 Calculate / Close / Help。
- 同目录 `Calculate3DParameters_common.png`：参数窗口按 Matrix reduction、Smoothing、Triangle reduction 分组，并有 OK / Cancel。
- `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Calculate 3D.txt`、`Calculate 3D_2.txt`、`Calculating a 3D.txt`、`STL STL VRML Parameters.txt`：Mask 选择、Ctrl 多选、Custom → Options → OK → Calculate，以及平滑和减面参数说明。

| 原生操作 | 本次对应行为 |
| --- | --- |
| 打开后预选活动 Mask | 初始化只预选存在的 activeMaskId；无有效活动 Mask 时保持空选择 |
| 选择源列表，Ctrl 多选 | Selected 勾选、名称、上下阈值；普通行单击单选，Ctrl/Meta 单击切换多选；阈值缺省显示 — |
| Quality | 只提供 Optimal 和 Custom，不暴露未复原精确常数的 Low / Medium / High |
| Options → 参数 → OK | 可展开参数子面板并以 OK 收起；正整数 XYZ 采样步长、可选平滑/减面及解决歧义面 |
| Calculate | 发出所选 Mask ID 与独立参数快照；保留窗口，不修改源 Mask、不自动发 Close |
| 运行进度和取消 | busy 时锁定选择/质量/参数与 Close，显示 0–1 progress；Cancel 或 Esc 发 cancel，仍由父级结束计算 |
| Close / Help | 空闲 Close 显式发 close；Help 显示当前支持操作的简要顺序；Esc 优先收起 Options，之后才关闭 |

事件契约为：

```ts
calculate: {
  maskIds: string[];
  quality: 'optimal' | 'custom';
  step: [number, number, number];
  smooth?: SmoothOptions;
  reduction?: ReduceOptions;
  topology: 'native-table' | 'resolved';
}
close: []
cancel: []
```

这里的 Optimal 明确定义为 step=[1,1,1]、native-table、无额外平滑或减面，是本重建的完整分辨率路径，**没有声称恢复原版 Optimal 的整套内部参数**。Custom 的可编辑初值也是本实现的明确值，不是原版默认值复原：step=[1,1,1]；平滑/减面默认关闭；开启时分别提供当前内核支持的 iterations/factor/compensateShrinkage 与 targetRatio/tolerance/featureAngle/iterations，边界保持开启。减面保留比例是目标，不保证一定达到。

原生帮助的 XY/Z grouping 术语与当前内核的 XYZ 正整数采样 stride 不应当作已证明逐项数值等价；本 UI 直接标明体素步长。未实现的原生灰度/轮廓插值切换、shell reduction、切片物理范围及原版减面 mode 没有虚设可操作控件。Tolerance 标注为模型坐标单位，组件契约没有空间单位输入，因此不擅自标为 mm。root 继续负责未知单位门禁以及选中多 Mask 的批量原子事务。

新增 4 条真实 SFC setup 交互测试，同时编译脚本与模板：预选/多选与源保持不变、Optimal 参数和不自动关闭；Custom 参数的完整快照及切回 Optimal；空/已删除选择与无效参数拒绝；busy/progress/一次取消和显式 Close。它们没有模拟成功 Worker 或 WebGL，也没有浏览器画面证据。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
29 tests, 29 passed, 0 failed
```

## 原生 Edit Masks：普通轮廓与多片临时编辑

后续按 root 授权只修改 ImageViewport、Workbench、自属测试和本说明；没有改 useWorkbench 或覆盖已集成 Calculate3DDialog。

原生依据为 `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Edit Masks.txt` 和同一帮助中的 `Resources/Images/EditMasks.png`。帮助明确：所有手动编辑针对 active mask；Type 与 Draw / Erase / Threshold 独立；Lasso 按住左键在切片绘制、松开结束；LiveWire 点击边界锚点；Threshold 仅重算编辑区内的成员，并保留编辑区外成员。不能把普通 Lasso/LiveWire 一概解释为临时选择后再 Apply。

本次 ImageViewport 的 Lasso 以一次按下/连续拖动/松开为一个闭合轮廓。通过既有 pick 事件送出起点、移动点和最终点（可用时读取浏览器 coalesced 样本），有效的非共线区域只在 pointerup 发 complete；普通单击、取消、丢失 capture、Esc、离开图像支撑区或切换目标均不发 complete。开始新 Lasso 先用既有 cancel 清旧轮廓；没有引入新的事件契约。LiveWire 继续采用点锚定方式，以原 complete / Enter / 按钮闭合。

Workbench 明确分成两种操作：

- 普通 Lasso/LiveWire：独立 `params.editOperation = add / remove / threshold`，界面显示 Draw / Erase / Threshold。Threshold 提供局部灰度上下限。轮廓仍通过 draftPoints/draftPlane 显示，闭合提示直接修改当前 Mask；不出现临时 Apply/复制/插值。
- Multiple Slice Edit / Select / Deselect：保留原临时选区、复制/插值与 Apply 链路，`pendingSelection` 仅包含这三项。普通轮廓不会叠加显示此前的临时 selection。

既有 cancel 由 Workbench 的 `cancelImageInteraction` 分派：普通轮廓调用 e.cancel 清父级 draft，刷子调用 e.brushCancel。root 负责修改 finishDrawing，按 Draw/Erase/Threshold 形成单笔原子历史事务，并冻结轮廓的目标/操作/阈值；本代理没有把 UI 接线测试称作这段控制器的数据结果验收。

新增 3 条专项测试：真实 ImageViewport SFC 拖动/最终点/有效区域和取消路径；真实 Workbench 脚本与模板编译后检查条件 VNode、生成的 operation 双向绑定以及 cancel 分派，证明普通轮廓隐藏 Apply，而三种临时编辑保留 Apply。Workbench 测试只替换控制器状态和子组件，未挂载 DOM directives，未替代实际 Worker、浏览器捕获或父级事务测试。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
32 tests, 32 passed, 0 failed
```

## 连续宽高笔刷与审核修复

本轮只修改 viewportGeometry、ImageViewport、Workbench 的笔刷 UI、useWorkbench 的参数/BrushTransaction/brushBegin/brushStroke 及必要 return、自属测试和本说明。没有修改 fileflow、region、工程 schema 或高级核，没有浏览器验收。原帮助 Edit Masks / The multiple slice edit interface 确认了独立 Width/Height、Same Width and Height、Ctrl+左拖调整及 Shift+左点击导航；帮助没有说明剪切坐标基和拖动数值增益，不能称这些公式已精确复原。

参数保留 diameter=6 兼容入口，新增 brushWidth=6、brushHeight=6、sameWidthHeight=true。diameter 是宽度别名，宽高联动时双向同步，采用重入 guard 避免 watcher 循环。setBrushSize 先验证两项有限正数再原子更新；同值请求不取消有效草稿，非法值保持旧参数并丢弃未提交笔画。改尺寸、形状、工具、目标或平面不会把半笔提交到 Mask。

宽高在当前切片的正交物理平面中定义，矩形/椭圆的枚举范围和命中测试使用完整 affine 的剪切项。circle/square 作为旧形状值继续兼容，宽高不同时分别表示 ellipse/rectangle。Ctrl+左拖在视口中预览宽高，松开一次 resizeBrush 参数事件；取消/丢失 capture/切目标/工具/plane 丢弃预览，不发笔画事件。双轴增益为本实现的 `2 × CSS 拖动 / 物理显示比例`，联动时取位移较大的一轴，最小值 0.1，尺寸保留六位小数，均为独立约定。Shift 优先于 Ctrl，只发一次 point；连续移动/松开或带 Shift 双击不生成笔画或完成轮廓。

审核发现并修复的四项问题：

1. 旧兼容点插值取所有三轴最小 spacing，会使 1e-5 的法向 spacing 错误限制平面拖动。interpolateBrushStroke 现在支持可选 axis，以实际切片物理基取样；无 axis 的旧调用只参考实际移动的 IJK 轴。该 helper 保留 65,536 点分配预算，但视口连续笔刷已经不依赖它。
2. ImageViewport 不再把一次 move 拆成几千个高度重叠的 stamp。controller 保存上一点，每个测得端点使用一次 segment sweep：ellipse 在物理归一化平面求点到线段最短距离，rectangle 用线段与以体素中心为中心的宽高盒求交。它是独立的连续笔刷定义，不是原版公式复原。
3. 按浏览器 coalesced 顺序处理轨迹点，然后补当前/最终点；不会把 U 形轨迹直接拉成起终点直线。保留原先跨图像外空白不连线的行为：stroke/brushStroke 新增兼容的可选第四参数 startSegment，仅在重新进入图像时开启。
4. 真实事件提供 buttons 时检查 primary bit。move/coalesced 点缺左键或 pointerup 后仍有其他键按下，会 cancel 整笔；正常 pointerup 的 buttons=0 可完成。历史无 buttons 的 synthetic stub 继续兼容，但不被当作真实鼠标测试。

每笔使用固定切片二维 covered bitmap 和每行计数，冻结操作/局部范围下每个命中体素只处理一次。满行跳过；整片已覆盖后后续点直接跳过。仍有复杂长路径的安全边界：累计候选扫描最多 33,554,432 次，单次输入最多 65,536 个测得轨迹点，数值精度或资源边界不足时明确报错并丢弃整笔，不会保留部分结果。部分重叠 bbox 仍可能重复检查，因此不能宣称已完全优化所有长路径。

最新定向验证：

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
45 tests, 45 passed, 0 failed
```

其中 31 项 viewport/SFC/controller 专项与 14 项体绘制核验证。新增证据包括：独立手算 sheared ellipse 9 体素、rectangle 13 体素及一次 Undo/Redo；宽高 alias、原子拒绝、尺寸/目标取消；真实 SFC Ctrl/Shift/buttons；明确 U 形三边 10 体素 oracle，底边中间两点必须保持空；薄法向 spacing 不改变平面笔刷；1024² 切片、3000 mm 矩形的完整局部阈值操作与 Undo，组件仅发 2 个 stroke，实际源灰度读取恰好 1,048,576 次；复杂重复 bbox 耗尽 32M 预算时原 Mask/历史不变。最后一次本机 Node 运行，大矩形整例约 247 ms，预算回滚例约 129 ms，包含 fixture 和事务操作，不是通用性能保证或浏览器验收。

root 另行执行的既有 controller/Worker 与最终全量/build 不计为本代理执行结果；以 root 最新日志为准。

## Annotation Properties、文字布局与编辑入口

本轮新增 `MeasurementPropertiesDialog.vue` 与共享 `annotationLayout.ts`，修改 Workbench 的测量列表、属性窗及视口编辑事件接线，修改 ImageViewport/PartViewport 的注释渲染、hover 和双击。没有修改区域生长工具区、useWorkbench、项目 schema 或 measurement composable；后两项由 root / project agent 完成。

只读依据：本地帮助 `Add Text Annotations.txt`、`Annotation.txt` 与 `Resources/Images/AnnotationProperties.png`。帮助明确先放锚点再打开 Properties；包含 Arrow Style、Text Rotation、Text Alignment、Text；长文以三个点显示，hover 全文、双击编辑；列表具有 Properties、Duplicate、Visible、Locate、Delete。图片中原版枚举/默认值不能作为已恢复全量数值的证据。

界面通过 `reactive(e.measurementEditor)` 解包 draft/editingId。表单只编辑本地 name/color/visible，以及 annotation 专属的 text/annotationStyle。Apply 发完整白名单属性，Cancel 不修改源几何；ordinary measurement 不展示或发送 annotation 字段。列表提供 Properties、Duplicate、Show/Hide、Locate、Delete，2D/3D 的 editMeasurement 统一转 openEdit。放锚点后的延迟创建、取消/换文档失效、单笔提交和 schema 持久化由 root / composable 负责，本小节不把 UI 测试等同于这些事务实现结果。

当前应用支持 arrow=`none|arrow|dot`、rotation 范围 [-360,360] 度、align=`left|center|right`。旧项目缺省按本 app 的 arrow/0/left 渲染；不是原版默认常数或全部枚举恢复。none 表示不画线端 marker，leader 仍可见。布局 helper 在渲染时按 360° 取余作防御处理，不修改存储值，也不扩大 schema 允许范围；Properties 同样在弹窗内拒绝 361 等越界输入。

共享布局生成旋转后的标签矩形、leader、箭头/圆点和 hit geometry。Canvas/SVG 都实际使用 rotation/alignment 和 marker；控制点拖动保留。2D canvas 原生 title 显示全文，点击文字区不误投新 anchor，双击文字只发 editMeasurement，不发 complete。3D SVG title 同样保留全文，label dblclick 阻止事件继续传播。隐藏注释不渲染、不参与文本 hit。

省略规则是本 app 的显式策略：超过 64 个 Unicode 码点、包含换行，或按共享字宽估计超过可用标签宽度时，屏幕文字为 `...`；完整源 text 保留并用于 title / Properties。可用标签宽度默认至多 220 CSS px，并受视口大小限制。字宽估计、自动标签偏移/边缘夹取及任意角度旋转是本实现布局约定，未称为原版精确排版。注释对象不写入 Mask，也不加入 STL。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
49 tests, 49 passed, 0 failed
```

本轮增加 4 条专项并扩展 Workbench 测试：独立手算 90° / 右对齐四角与命中边界；真实 canvas 命令、三个点、完整 title、只编辑的双击和 anchor 拖动；Properties 本地隔离/校验及 ordinary 白名单；真实 SVG 的 rotation/alignment、marker、全文 title、编辑事件和 busy/隐藏约束。Workbench 编译模板检查了列表五动作、dialog Apply/Cancel 及两视口编辑事件接线。总计 35 项 viewport/SFC/controller 与既有 14 项 volume 核，均为 synthetic-only、未挂载真实浏览器；root 的最终 build/全量和 composable/project 测试以其最新日志为准。

### 属性和文字命中的模式边界复核

后续复核修正 canvas annotation 分支 continue 后的不可达 kind 比较；本代理实际运行 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` 通过。

原帮助没有规定文字与种子/画笔重叠时的模式优先级，以下是本应用的互斥策略：只有 navigate、distance、angle、diameter、ellipse、area、density-rectangle、density-ellipse、annotation 模式可点击或双击文字/普通 measurement handles。region/dynamic/cavity/centerline、paint/erase/local-threshold、MSE 与轮廓编辑操作透传到图像或三维表面；Shift 单次定位仍最高。PartViewport 新增可选 tool prop，缺省按 navigate 兼容旧调用；Workbench 传当前 tool。surface-distance 仅保留其自身路径约束 handles，其他文字和 handles 不截获表面种子。

禁用输入命中不会禁用只读 hover：2D 保持 canvas title 全文，3D 在透明 SVG hit 模式下由 canvas 查询 label layout 并提供 title。SVG label/handle 通过 pointer-events:none 与 tabindex=-1 透传；相关事件处理器同样先检查模式，失败时不 stopPropagation、不发 select/edit。改变模式时取消不再允许的 pending handle drag。

新增两条真实 SFC 回归明确检查文字下面的 seed/brush 事件、完整 hover、无 edit，以及 3D 透传到实际 mesh picker、surface-distance 自身 handle 保留和切回 navigate 可编辑。Properties 测试增加 NaN/±361 的弹窗内拒绝与 input min/max；旧最小 Part 测试夹具补齐 MeasurementObject 必需的 name/color 字段。来源提示模板另按 root 要求改接 partSourceWarning，helper 与 provenance 逻辑由 root/project agent 负责。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
51 tests, 51 passed, 0 failed
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
exit 0
```

51 项为 37 项 viewport/SFC/controller 加 14 项 volume 核；没有执行全仓 build 或浏览器。

## Density ROI 交互、逐点 Part 来源与延迟事件

本轮自属修改 `roiGeometry.ts`、ImageViewport、PartViewport、Workbench 的密度工具区/接线和 viewport 测试；controller、measurements 核与 schema 由 root/project agent 负责。只读参考本地帮助 `Measure density in rectangle.txt`、`Measure density in ellipse.txt`：帮助描述点击放置或左拖放置、矩形边角标记调整、椭圆四标记调整、拖动非标记边框整体移动、松开重新计算、滚动切片更新测量。帮助未规定初始数值、屏幕命中容差或边界截取公式。

本应用的初始宽高独立可改，缺省为 10×10 image px，按原体素坐标轴跨度定义，不称为原版常数。点落默认框以点击为中心；拖动达到 3 CSS px 后改为起点/对角框。创建/缩放夹取到半体素图像支持域 `[-.5,dims-.5]`，整体移动保留尺寸并限制位移。矩形使用八个标记，椭圆使用四个基轴标记和 128 段显示轮廓；标记命中半径 8 CSS px 优先于非标记边框 6 CSS px，resize cursor 按实际屏幕方向量化到四类，均为本应用明确交互约定。空宽高不提交。

ImageViewport 只维护局部几何预览，松开才发 createDensityROI 或一次含两个 world 角点的 updateMeasurementGeometry；拖动中不改统计/历史/Mask。创建事件使用 voxel 角点，编辑使用冻结 grid 转换后的 world 角点，均带开始时 volume/revision。取消、capture loss、Escape、换文档/切片/工具/目标/尺寸/revision/measurement 都丢弃草稿。密度 ROI 不进入旧的单点 handle 拖动分支。实际显示使用 controller 的 displayMeasurements：随当前切片改变有效 plane、world 轮廓与统计，原存储 plane/两角不因翻片变更，也不产生 revision/历史；用户随后编辑时才以当前 plane 提交两角。Workbench 的事件缩写使用 create-density-r-o-i，编译后为 onCreateDensityROI。

PartViewport 每个 handle 根据 pointPartIds 取得自身 Part，沿自身 picker 移动；legacy partId 与 surface-distance 单来源仍兼容。混合来源任意一个 Part 缺失、隐藏或 opacity=0 时隐藏整条几何。Image/Part 普通 handle 同样冻结开始 volume/revision；geometry props、revision 或文档替换时同步取消，迟到 release 不覆盖新状态。密度对象继续保留在列表/图像视口，但不投影到 PartViewport：两角属于图像 ROI，不能由默认 worldCurve 误画成一条距离线。

新增独立 synthetic oracle：三种 affine 平面 click-default、release 前无创建及取消矩阵；真实 SFC→controller 剪切网格 ROI 创建/缩放/移动/翻片/三次 Undo，包含已知 world 两角、像素均值/总体标准差/有效计数/样本面积/几何面积和 Mask 不变；mixed-Part 重叠面验证两 handle 分别留在 z=0 与 z=5、legacy 兼容、隐藏/删除来源和普通 2D/3D 迟到 release；现有编译模板测试核对独立宽高、displayMeasurements、事件与 orphan 提示。面积与均值使用浮点容差，未降低几何或计数断言。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
56 tests, 56 passed, 0 failed
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
exit 0
```

上述为本代理最新运行的 42 项 viewport/SFC/controller 与 14 项 volume 核；没有浏览器或全仓 build 验收，全量结果以 root 日志为准。测试全为 synthetic-only，不使用患者资料、原版 Mimics 执行或许可行为。

## Area / Ellipse 二维编辑与即时数值

本轮仅修改 ImageViewport、自属 viewport tests 和本节；未修改 Workbench、controller、types/project 或 PartViewport。共享 `ellipseGeometry.ts`、3D 编辑由 audit agent 实现；标签 schema/持久化由 project agent、controller/Workbench 接线与创建校验由 root 实现。只读依据为 `foundation-measurement-interaction-gaps.md` 及原帮助 `Measure Area.txt`、`Measure Ellipse.txt`。原帮助明确 Area 控制点可右击 Add Point / Remove Point，Ellipse 可拖四轴端、中心、角点和标签，并在创建中显示 ellipse/变量；没有规定插入点位置、第三步最终确认键、handle 容差、标签保存坐标系。

Area 右击命中已有控制点才打开本地菜单，其余右键仍平移视图；支持 Escape、外部点击和上下文变更关闭。Add Point 插入在选点之后与下一点的 world 中点，可随后拖动，是界面提示的本应用约定。Remove Point 最少保留三个点，三点时菜单按钮禁用，程序入口也拒绝。增删先用现有 evaluator 检查候选，再发送一次 batch 几何事件，controller 负责同步全 null 图像来源数组长度和一次历史事务；不会替换为删除整个测量。自交拖动可见无效原因，但 release 不提交。

Ellipse 通过共享 frame 绘制 128 段物理轮廓，显示四个派生轴端、派生中心与轴方向 bounding-box 四角/虚线框；raw 第三点先剔除长轴方向分量，不能直接用作短轴端 handle。四轴端按固定中心对称缩放，中心移动与角点旋转操作完整三 world 点，保持 schema 点数为 3；零轴或无定义旋转不提交。所有实际屏幕命中经现有 affine/shear/zoom/pan 逆变换回冻结物理平面；普通测量没有密度 ROI 的图像边界夹取限制。Ellipse 继续无专属右键菜单。

Area / Ellipse label 使用共享 world anchor（有效面积质心 / 长轴中点），可拖到目标位置。`labelOffset` 是相对 anchor 的 world 向量，几何变更后随 anchor 平移，旋转时该 offset 仍按世界坐标解释；drop 只发送 updateMeasurementLabel，不改变几何/面积。标签命中在自身专用 handles 之后，普通 seed/brush 模式不会截获。默认屏幕文字另有 +10/-10 CSS 偏移；handle 8 CSS px 半径、标签估计字宽及框线样式为本应用命中/显示约定，非原版像素复原。

shape/普通 point 拖动中的轮廓和局部 label 共用同一临时 world 几何调用既有 evaluator，Ellipse 显示 D1/D2/E/P/A/DP/DA，Area 显示 A/P/Da/Dp/Lmax/L。未定义的数值显示破折号，非法候选明确 reason。previewMeasurementGeometry 仅向 controller 发布只读详情预览；松开或取消发 null，density 继续只在 release 后统计。标签拖动只维护本地 offset 预览，不发布形状预览。

从第一个长轴点后开始 mousemove 可见 ellipse/变量，暂定短半轴为长半轴的一半；第二点固定后 mousemove 确定短轴，第三次点击确认。这两个未由帮助规定的细节都有可见提示，属于应用选择。第三次点落在长轴上时保留两个已固定点并给出零短轴原因；移到有效候选后清除旧错误。创建仍通过原 pick/controller 路径，不发送额外 complete 或双重提交事件。

每个 menu/shape/label/普通 point 编辑都冻结 volume、grid、revision、plane 和测量几何/来源签名。换 slice、文档、模式、目标、busy、revision、删除/替换对象、Escape、pointercancel 或 capture loss 丢弃本地预览；move/release 还验证签名，覆盖同数组原地修改几何或逐点来源的情况。界面没有将 MPR 重采样纳入实现，也没有把二维面积菜单扩展成 3D area 工具。

```text
node --experimental-strip-types --test tests/mimics-viewport.test.ts tests/mimics-volume-rendering.test.ts
61 tests, 61 passed, 0 failed
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
exit 0
```

新增五条专项覆盖：真实 Area 菜单增删/禁用/一次 Undo 和临时详情；自交显示/拒交；带 shear 与 zoom/pan 的四轴端、平移、90° 旋转、label drop 及独立 world 坐标/面积 oracle；12 类中断及原地几何/来源替换；创建两个阶段的实际 Canvas 变量、零轴拒绝和第三次 click。Canvas 命令进一步验证画出投影短轴端，未画 raw p2 handle。61 为 47 项 viewport/SFC/controller 和 14 项 volume 核；本代理无浏览器与全仓 build 结果，最终全量以 root 日志为准。

主审后在同一 ellipse fixture 追加无移动的 v+、center、rotate++ click-release：原始第三点含轴向分量时，三个手势都不将 canonical 点写回、不新增 revision/历史，preview 仍清为 null。仅新增断言，源码未再修改；该现有用例定向重跑 1/1 通过，vue-tsc 再次 exit 0。
