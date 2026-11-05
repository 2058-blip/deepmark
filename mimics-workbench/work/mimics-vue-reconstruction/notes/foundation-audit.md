# 基础链路审查与验收差距

## 根后续整合与部分浏览器证据

恢复后最新572全量与构建通过；暂停前541也已核对并补报告。RP三维平面、中心/法线旋转/红边角FOV、严格epoch/mode与关闭布局回放见`foundation-reslice-gizmo-integration.md`。本轮无浏览器成功观察，31新增项属解析/SFC/controller证据；MPR写Mask/完整native映射/文件与原版对照仍缺，gate=false。下文489及更早是历史阶段。

最新489集成已新增真实任意平面3MPR、测量/标注和保存链路，见`foundation-mpr-integration.md`与`mpr-regression.log`/`mpr-build.log`。53项新增专项和父VNode接线通过，native Ctrl蓝十字/Reslice Objects/curve/project及MPR Mask写入、浏览器/实际文件/原版对照仍未完成；本轮CUA状态观察超时，gate依旧false。下文436及更早是历史阶段。

最新原生测量交互整合已通过436/436与构建（`measurement-native-regression.log`、`measurement-native-build.log`），包括Area点菜单、Ellipse2D/3D staged创建及专用编辑、labelOffset、临时完整指标和旧草稿token隔离。下文390/306为历史；本轮没有浏览器成功观察，gate仍false，MPR/实际文件和全浏览器/原版对照仍待验收。详`foundation-measurement-native-editing.md`。

最新测量/ROI整合已通过390/390与生产构建，见`foundation-measurement-review-2026-11-05.md`及`measurement-roi-regression.log`。18项实际控制器/Worker与56项viewport/volume专项覆盖新ROI当前片/原始灰度/一条事务、逐点Part及旧手势隔离。新增UI的浏览器连接观察超时，未获新浏览器通过证据；原生Ellipse专用交互、Area右键增删和真实文件等缺口仍保留，gate继续false。下列306等数字均为历史阶段记录。

后续完整项目回归306/306及生产构建通过；根实际浏览器已验证合成Threshold、多片临时画笔/三色/复制跳层/最终Erase/Undo-Redo、单Mask Optimal三维，以及真实IndexedDB新页面和刷新恢复。证据见`foundation-browser-multiple-2026-11-05.md`与`multiple-edit-regression.log`。原先“实际IndexedDB完全未验收”这一缺口已有所列成功路径证据，但quota、错误、新浏览器进程、真实磁盘文件流及其余交互未完成，基础release_gate仍为false。下文22项为专项范围，不能拿其数量替代新增整合或浏览器证据。

2026-11-05 审查。范围是影像导入、独立 Mask、标注/选区编辑、3D、测量/导出、工程保存恢复。没有新增高级算法，没有操作浏览器，也没有改动其他代理负责的共享实现。逐条输入、操作、期望、证据和缺口见 `foundation-acceptance.json` 的 F01–F25。

本审查新增 `tests/mimics-foundation.test.ts`，以真实 `operations.worker.ts` 和 Node `worker_threads` adapter 测试 Vue 控制器。夹具是显式构造的 8×6×3 毫米 NIfTI，其中阈值 100 对应一个 4 体素连通块与一个 1 体素孤岛，期望值可以直接计算。没有复制被测分割/重建算法作为 oracle。

## 当前验收结果

root 修复基础状态链路后，本文件负责的控制器回归已扩展为 **22/22 通过**，完整输出在 `../evidence/foundation-current.tap`。修复前基线保留在 `../evidence/foundation-baseline.tap`，便于核对缺陷确实被触发过。当前22项还覆盖了原先失败的旧导入、busy/progress、画笔取消/换目标、seed清理和预览参数一致性。

新增的未保存保护按真实工作流测试：新影像解析成功后，旧工程、dirty、历史、selection和视图保持不变，并出现 pendingReplacement；明确 discard 后才安装新影像和清理选区；选择 cancel 后原历史仍能撤销原笔画。这不是绕过保护直接清dirty。

保存位置测试通过实际 Worker 的 exportProject 产生ZIP，再用 openFiles 安装该ZIP，恢复 point、activeAxis、窗宽窗位、renderMode、tool、tab、selectedMeasurementId和文字。另测取消保存、写入失败、仅发起download三种状态均保持dirty和已提交数据。只有确认written的工程保存会清dirty。此证据不包含真实文件系统写入或浏览器下载。

缓存新增受控WorkspaceRepository，实际执行useWorkbench与WorkspaceSaveQueue：cache保存失败时不安装待替换工程、不丢dirty/历史/位置，成功重试先保存旧doc，再安装新工程；通过openLocalProjects和restoreLocalProject恢复旧doc内容、文字和全部已承诺viewState。缺失或损坏缓存也不会安装。存储test double只负责clone、保存/加载和受控报错，不模拟IndexedDB事务或真实quota。

单位与标签新增控制器链路：未知单位先分割Mask，3D被明确阻止；分别选择metre/mm/micron后，原native affine与旧header不被原地修改，新工作grid和spacing均一致为mm，真实Worker生成的模型bounds满足已知毫米真值。两标签导入产生两个独立buffer的Mask，清空其一不改另一个，导入整体一次Undo。metre和micron的物理等价Mask均可附加到mm影像。

Calculate 3D新增实际Worker批量验收：两个含5体素重叠且第二个另有成员的Mask生成两个闭合Part，源数据不变、来源revision正确、只增加一次工程revision，一次Undo全部退回、Redo全部恢复。Calculate保持对话框打开，Close只关闭窗口。按valid→empty顺序计算时，空Mask导致整批失败，没有发布先计算完成的Part，state/revision/history/dirty不变，随后单个有效Mask可重试。这只验证控制器和Worker，尚未操作浏览器中的对话框。

普通Edit Masks随后新增独立专项 `tests/mimics-editmasks-controller.test.ts`，**10/10通过**，输出在 `../evidence/editmasks-controller-current.tap`。它补验普通Lasso/LiveWire三种操作直接活动Mask事务、ROI外保留、Undo/Redo、无变化/非法轮廓、切目标/参数/切片取消及非measurement白名单。此前foundation套件仍为独立22项；此处不混淆两份日志和测试计数。该专项不操作浏览器，也不证明真实影像或原版LiveWire路径等价，详见 `foundation-editmask-review.md` 修复后补验。

Multiple Slice Edit随后另有 `tests/mimics-multiple-edit.test.ts`，**18/18通过**，日志 `../evidence/multiple-edit-current.tap`。覆盖临时session方向、隐藏active的显示/编辑、Lasso/LiveWire并差、复制与跳层、独立插值预览屏障/Apply/Cancel、localThreshold和最终事务。首轮插值屏障问题为17/18，修复前证据保留 `multiple-edit-baseline.tap`。帮助直接支持与本轮独立策略已在 `foundation-multiple-edit-review.md` 分列；不把控制器通过当浏览器和原版数值认证。

## 修复前基线

命令：`node --experimental-strip-types --test --test-reporter=tap tests/mimics-foundation.test.ts`。

稳定的小夹具基线为 **12 条：5 通过，7 失败**，完整输出保存在 `../evidence/foundation-baseline.tap`。这是共享源码修复前的快照，后续变更必须重跑；本文件不会把进行中的修复提前标为通过。

通过：损坏 NIfTI/ZIP/DICOM 导入保留已提交数据、dirty、历史和位置；同尺寸不同 affine Mask 拒绝；连续笔画分别撤销且换影像清临时选区；Worker 参数失败可重试且 region 非法目标不产生半事务；Part 来源 revision 和历史几何在源修改及 ZIP 恢复后保留。

失败：旧影像返回覆盖已打开的新影像；旧导入 finally 清除新导入的 busy/progress；旧 Mask 导入附加到新工程；取消后 brushEnd 仍提交；切目标后笔画写入新目标；切工具后中心线 seed 仍保留；改变 keepLargest 后旧阈值预览仍被发布。旧 Mask 断言先失败，因此同一测试的 STL 后半段须在修复后继续完成验证。

另外本轮实际执行 project、workbench、segmentation、dicom、measurements 五个既有套件，共 **55/55 通过**。其中 project 套件包含并行新增的 view schema、数据校验和 provenance 测试。这证明当时的核与既有 Worker 主链路可运行，未替代新边界回归；后续修复仍由root执行整体集成测试。geometry 套件本轮尚未由本审查运行。

## 基线问题的处理状态

1. 文件导入已按generation控制返回、错误和finally归属；旧影像、有效非空Mask和有效STL在取消换工程后均被丢弃，新busy/progress不被旧finally清除。控制器测试通过。
2. 笔画已有开始时目标/工具/volume/revision/参数，换目标、工具和取消会清草稿。ImageViewport新增cancel事件，pointercancel与lostpointercapture不再调用提交。控制器测试通过；真实事件次序仍待浏览器。
3. 阈值预览同时保存完整参数指纹、对象和revision，返回及Apply检查一致性；keepLargest变化旧结果不能应用。控制器测试通过。
4. 退出seed工具和cancel已清临时约束；组件源码只在测量工具下命中测量端点，避免种子模式被测量拖动抢占。控制器清理通过，屏幕上的互斥拾取仍待浏览器。
5. sameImageGeometry已按统一mm grid比较完整affine；同尺寸不同空间继续拒绝。多标签拆为独立二值Mask，概率图和空前景明确拒绝。本审查已对空间冲突、两标签独立导入及物理等价metre/micron导入做控制器测试；额外标签失败规则由相关套件补证据。
6. dirty工程的新候选在解析成功后进入原生替换对话框；cancel/discard/cache控制器分支均通过。cache成功和失败使用受控内存仓库，实际IndexedDB和对话框由root补浏览器证据。
7. 工程保存和安装已接通可选v1 viewState，并完成真实Worker导出/控制器恢复测试。3D相机及各视图pan/zoom未纳入viewState，不宣称已恢复这些字段。

## 链路验收摘要

| 输入与操作 | 期望 | 当前证据 | 尚缺 |
| --- | --- | --- | --- |
| NIfTI/DICOM→选择系列→打开 | 原始值、单位和 affine 正确，失败保留旧工程 | 原有格式纯函数测试；新控制器失败保持测试通过 | 文件选择、gzip、多系列 UI、真实显示 |
| dirty 工程→打开新工程或取消 | 明确保留/丢弃，失败不丢工作 | pending→discard/cancel/cache控制器通过 | 原生对话框和真实cache浏览器验证 |
| 慢导入→取消→新导入→旧返回 | 新工程和新请求 busy/progress 不受旧结果影响 | 新控制器测试通过 | 浏览器慢文件取消 |
| 重叠 Mask→CRUD/属性→Undo | 独立成员与一次事务 | 原有工程测试；源码接线 | 完整对象 UI 与状态一致性 |
| 阈值→预览→取消/Apply→Undo | 预览不修改源、完整参数一致 | 原有Worker链路；新flags陈旧测试通过 | 黄色预览与Apply浏览器验证 |
| 绘制→连续笔画→撤销 | 每笔一次事务 | 新测试通过 | pointer 插值和 capture |
| 笔画中→换目标/取消→旧 end | 不污染新目标、不提交取消的草稿 | 新控制器测试通过；独立组件cancel接线 | 真实指针事件验证 |
| 测量端点附近→seed 点击 | seed 与测量拖动互斥 | 源码互斥；临时seed清理测试通过 | 浏览器互斥验证 |
| region→cut 到新 Mask→Undo | 同时恢复源和目标，非法目标不半提交 | 新实际 Worker 测试通过 | copy/已有目标/单层多轴和 Ctrl 连续增长 |
| 临时选区→复制/插值→Apply→换影像 | Apply 前源不变，旧选区不跨影像 | 原有核测试与 Worker 测试；新换影像检查通过 | 多片编辑完整 UI |
| Mask→3D→编辑源→保存 | source ID/revision 保留，旧模型明确陈旧 | 新Worker+ZIP测试通过；后处理源码继承来源 | 叠合、选中、陈旧提示实际显示；后处理来源补控制器覆盖 |
| Part→旋转/缩放→拾取/测量 | 最近可见表面的正确世界坐标 | 原有 BVH 纯函数测试；组件源码 | WebGL、屏幕射线、拖点和取消 |
| Part→STL→回读 | 有效二进制、mm 坐标与几何 | 原有核与 Worker 测试 | 浏览器下载文件、第三方独立解析器 |
| 2D/3D测量及文字→移动/Locate/删除 | 物理量、锚点与事务正确 | 原有测量纯函数、工程往返 | 真实标注操作、列表编辑能力 |
| 工程保存→关闭→恢复 | 原图、对象、引用与已承诺工作位置恢复 | ZIP核；新Worker导出/安装恢复工作位置通过 | 下载实际落地、新会话与本地缓存 |
| cache再替换→失败/重试→恢复旧doc | 失败不丢旧工程，成功后内容/视图可恢复 | 实际控制器和queue；受控内存仓库通过 | 真实IndexedDB、新会话、quota |
| 无单位影像→3D→确认单位 | 明确确认后才能建立毫米几何 | m/mm/µm三个控制器+真实Worker几何案例通过 | 单位选择UI |
| 多标签/不同native单位→导入Mask | 独立标签、空间等价、一次事务 | 两标签及m/µm→mm控制器测试通过 | 文件流UI |

## 证据边界和保留限制

- 本次没有执行浏览器。现存 `browser-loaded.jpg`、`browser-surface.jpg`、`browser-volume.jpg` 是历史可见画面证据，不能证明指针取消、文件流或保存关闭恢复。浏览器由 root 统一验收。
- 原有 `mimics-workbench.test.ts` 已使用真实 Worker，覆盖预览→Apply→Undo→3D→STL→ZIP、取消重跑和临时选区；本轮五套件55项执行通过。geometry 套件仅审读源码，未将历史结果当本轮执行结果。
- `volumeGrid()` 将已知metre/micron affine转成毫米，统计使用determinant，测量和几何使用完整affine。并行实现的viewportGeometry已采用完整剪切平面映射和画笔metric，本审查读过源码但未运行其专项套件；不能以本文件的22项控制器回归证明屏幕显示精度。unknown单位已在控制器中阻止毫米几何，须显式选择单位；不把未知长度认证为毫米。
- PartViewport现有allowEdit并已接busy，源码抑制测量拖点和编辑拾取；计算期间的选择与相机操作仍须浏览器验证。基础runPart后处理现在继承来源Mask ID/revision，本测试仅直接覆盖Calculate3D的来源。
- 当前 STL 导出与回读使用同模块，属于格式往返检查，不能写成第三方格式认证。STL 不保存颜色或文字。
- ZIP对象恢复、文件实际写入、当前工作位置恢复和自动缓存恢复是不同证据。当前保存仅在written回执后清dirty；download-started保留dirty，相关控制器边界测试已通过。原生picker和缓存刷新恢复仍待浏览器验收。
- 没有运行原 Mimics 输出对照；这份审查不证明原版数值等价，也不把高级工具按钮存在当作高级链路完成。

当前22项基础控制器回归通过。完整基础链路仍待root补齐浏览器的导入→标注→3D→导出→保存关闭恢复及失败/取消证据；尚未标为全部验收完成。
