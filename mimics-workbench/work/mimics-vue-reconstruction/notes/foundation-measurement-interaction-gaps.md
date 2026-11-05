# Area / Ellipse 交互差距审核

**后续实现已覆盖本笔记的大部分整改项。** 最新436集成已有Area点菜单、Ellipse四轴/中心/角点/标签、实时数值与2D/3D staged创建，手势冻结亦已统一；当前实现与实际测试边界请先读`foundation-measurement-native-editing.md`。本文件保留为原帮助证据及整改前差距记录；任意MPR、真实浏览器和原版等价仍未完成。

本轮只读帮助、截图和当前源码，仅写本笔记；未改共享源码、未新增数值测试、未操作浏览器。下列位置以本次读取时为准，同时保留函数名便于后续定位。

## 直接帮助证据

| 工具 | 原帮助明确内容 | 证据 |
|---|---|---|
| Measure Area | 单张 2D 平面闭合多边形，逐点放置、双击闭合；修改已有控制点后更新；右击点可 Add Point / Remove Point；普通与 MPR 视图均可用 | `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Measure Area.txt:3,5,25,27`；对应 `.htm:27,50,52` |
| Area 结果 | Area、Perimeter、Da、Dp、Centroid、Lmax、过质心且垂直 Lmax 的 L | 同文本 `:11-23` |
| Measure Ellipse | 图像和 3D 模型；第一下设置长轴端点，显示椭圆及变量；第二下固定另一长轴端点，移动鼠标定义短轴；两轴四端点可拖；角点旋转、中心平移、标签拖放 | `.../Measure Ellipse.txt:3,19`；对应 `.htm:30` |
| Ellipse 结果/菜单 | D1、D2、E、P、A、DP、DA；**没有 context menu** | 同文本 `:5-17,21` |

已直接查看原帮助 `chm/Resources/Images/Measure_Area2.png`：点的菜单中有 Add Point / Remove Point，标签含多个 Area 指标；也查看 `chm/Resources/Images/Measure ellipse/02000002_142x125.jpg`。截图其他菜单项不等于本轮已确定其 area 语义。帮助没有说明 Add Point 插入前/后或新点初始位置、短轴最终确认键、3D aggregate 手柄的拖动投影约束、标签位置存储坐标系；这些细节须作为应用独立选择定义，不能编成已恢复原版规则。

## 当前已具备

- `useWorkbench.ts:384` 的 appendMeasurementPoint 与 `:423` finishDrawing：area 同一切片多点，双击/Enter 完成；ellipse 三个离散点后完成。partPick（`:539`）支持 3D ellipse，未将 area 扩成任意 3D 表面面积。
- `ImageViewport.vue:70-76` 绘制闭合 area 和三点定义的 ellipse，已有单点拖动预览；`PartViewport.vue:63-81` worldCurve 可投影物理椭圆，`:111-119` 有通用点 handle。单次拖动在 pointer-up 才提交，已有 Escape/丢失 capture 清理路径。
- `measurements.ts:122-136,138-193` 已返回 Ellipse/Area 的完整 details。本轮最后一次读取已看到 `Workbench.vue:49-66` measurementRows 和 `:150` 详情面板接入 `selectedMeasurementDetails`，不再把“缺少完整数值详情”列为现存缺口。视口简短标签仍主要展示主 value。
- `useWorkbench.ts:493` updateMeasurementGeometry 已有有限点、切片约束、no-op/事务处理，允许 image-only area 改点数；`:510` 的单点移动复用该入口。`project.ts:108-125` 与逐点附件规则继续约束点数和来源；这可作为后续交互基础，不必另写一套数值核。

已再次核对当前完整详情面板的物理单位：`Workbench.vue` measurementRows（`:54-66`）中，Ellipse 的 D1/D2/P/DP/DA 为 mm，A 为 mm²，E 无单位，Center 为 mm；Area 的 P/Da/Dp/Lmax/L 为 mm，A 为 mm²，Centroid 为 mm。其他 Length/Radius 为 mm，Angle 从 evaluator 的 degree 显示成 °；密度数值使用 HU/GV，采样/几何面积为 mm²。正常已确认空间单位的链路中，`project.ts` volumeGrid 将 native metre/micron affine 变成 mm，controller 以 physicalPoint 存世界点，因此面板没有把原始 m/µm 数值直接贴成 mm。中心/质心目前只标 mm，未标 RAS/世界坐标基准，这仍应在后续说明中澄清；本次不改共享源。

## Area 还缺什么

1. **点增删入口尚未存在。** ImageViewport 的 `down(:87)` 把右键先交给 pan，canvas 模板 `:134` 只有 `@contextmenu.prevent`，没有 area 点菜单/插入模式。PartViewport 只有 generic point handle，没有 Add/Remove。Area 原生说明是 2D 单片工具，不能因为 PartViewport 能画闭合线就宣称 3D area 创建/编辑已实现。
2. **需要定义插入与删除的应用状态机。** 右击命中具体 area/point 后提供 Add Point / Remove Point；明确插入在哪一段、何时用下一次左键放置，以及取消方式。不能用删除整个 measurement 代替 Remove Point。建议少于三点时拒绝删除/清楚提示，但这是为保持有效对象的应用约束，原帮助未说明退化处理政策。
3. **几何和来源必须一起更新。** 增删须同时维护 points 与 pointPartIds 的顺序/长度。当前通常是全 null 的图像 area；legacy/带 Part 的 area 不能被无条件重写成全 null 或最后一个 Part。保留同一物理平面，提交一次事务，Undo/Redo 一次完整恢复。
4. **临时数值未跟随临时轮廓。** Image 的 paint 使用 measurementDrag.position 画临时 points（`:70`），但标签仍读取 committed measurementLabels（`:76`）。Part 的 shown/temporaryPoint（`:99`）同样与 props label（`:102`）分离。拖动时应从临时几何复用既有 evaluator 生成只读预览结果，drop 才一次 commit；取消时几何和结果一起回退。
5. **MPR 不在当前完成范围。** 原帮助支持 resliced MPR；现有 viewportGeometry.ts:9/32 及 ImageViewport 的 rawSlice 标记明确是原 IJK plane 的物理显示，没有标准 MPR 重采样。点菜单可先覆盖已支持切片，MPR 仍须另项，不应标为完整原版 area 支持。

## Ellipse 还缺什么

| 交互 | 当前实现 | 后续要求 |
|---|---|---|
| 创建过程 | pendingPoints 画开放折线/点，第三次离散点后才成 ellipse（Image `:77`，Part `:454` 附近，controller `:395`） | 第一/第二长轴阶段有临时 ellipse/变量，第二点固定后 mousemove 定短轴；最终确认事件需明确应用选择，原帮助没有写清最后一步按键 |
| 两轴端点 | 只有 p0/p1/p2 三个 raw handle | 从参数计算长/短轴四个端点，拖任一端点有明确对称/中心保持规则；不能把任意 p2 直接当短轴端点 |
| 中心平移 | 没有中心 handle；只能各点分别拖 | 提供派生中心 `(p0+p1)/2`，平移整组几何，保持轴长/方向；不要误用当前通用 label 的三点均值 anchor（Part `:106`） |
| 角点旋转 | 没有旋转框/角点或角度手势 | 围绕 ellipse 中心在已定义平面内旋转全部参数，区分相机旋转与几何旋转；不能使用仅 annotation 可用的 annotationStyle.rotation 伪装 |
| 标签拖放 | Image `:76` 固定 p0 屏幕偏移；Part `:107-108` 自动定位，`:381` selectLabel 只选中，模板 `:448` pointerdown 只选择/双击属性 | 对普通 ellipse label 建 hit-test 与拖动状态，不启动新的 ellipse、切片导航或相机操作；标签移动不能改轴或面积 |
| 3D handle 约束 | `PartViewport.vue:344-363` 只对有逐点 Part ID 的点沿自身 Part ray-hit 移动；null 点不可在该视口拖 | center/rotation/轴编辑在模型上的投影或工作平面约束须单独定义，不能简单把 aggregate 手势分别 ray-snap 到不同曲面后仍声称刚性平移/旋转 |

一个确定的 handle 语义反例：P0=(-2,0)、P1=(2,0)、P2=(1,1) 时，既有 curve/kernel 将 P2 投影得短轴端 (0,1)，但两个视口都画 raw P2=(1,1) 的 handle（Image `:73,76`，Part `:75-80,111`）；这个点不在画出的 ellipse 上。这里不是重验面积公式，而是证明“原始第三参数点”不等于原帮助的“短轴端点”。派生 handle 应与渲染曲线一致；轴长角色翻转、极小轴与退化候选也须定义交互政策。

本次只读审核时 ellipse 严格保存三个 world points，尚无普通测量 label pose。中心、反向轴端和旋转角点应是派生 UI handle，不能直接 append 到 points 打破 schema。后续 labelOffset 轮次已明确选择可选的世界毫米偏移（相对几何 label anchor）并接入严格保存/clone，见 `foundation-measurement-label-offset.md`；这项数据契约本身不代表本笔记所列拖动手势均已完成。帮助本身不证明原软件采用哪种存储坐标系，也未明确持久化政策。

## 后续实现的共同验收要求

- 两工具的 hit-test 优先级要覆盖 label、专用 handle、area 菜单和创建模式，同时保留 Shift 导航/相机操作等已定义模式。Ellipse 保持无专属右键菜单，不能机械复用 area 菜单。
- 所有临时编辑捕获 volume、measurement ID、revision、plane/source；换文档、删除源、切换模式、busy、Escape、pointercancel/lost capture 时不半提交，pointer-up 才单条 Undo。当前 Image 通用 measurementDrag 没有 densityDrag 那样的 volume/revision capture，measurements watch（`:125`）只取消 densityDrag；Part revision watcher则会清除 drag。该静态差异需在后续事件回归中核实并统一，不能把只读审核当浏览器复现。
- 实时预览可按 animation frame 合并计算；显示无效候选时要明确 reason。自交、共线、零轴等的提交/回退政策不由这份帮助直接给出，不应静默当有效数值。
- 已有 details 面板保留；预览中的结果与已提交结果需可区分，质心/中心的世界坐标单位与坐标基准须标清，不能无证据声称与原版坐标显示完全相同。
- 后续只补事件/事务验收：area 右击增删并一次 Undo、double-click 不重复提交、ellipse 四轴端/center/rotation/label 各动作、shape 与 label 同步、缩放/各向异性/shear、3D source 变化及取消。复用现有数值用例，不新增镜像公式的重复测试。

本笔记判断的是原帮助可证实的交互与当前源码差距，不是原软件运行比对、浏览器验收或全部数值算法等价声明。
