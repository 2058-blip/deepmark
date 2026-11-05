# Mimics 标注与三维完整链路重构：执行状态

更新：2026-11-05。**目标仍在进行中，尚未达到“完美重构”。** 本文描述已落地的代码与验证边界，不以核心流程可运行替代全部功能的完成。

## 最新成果快照（2026-11-05）

- **最新717/717全量回归及生产构建通过**，`index-wufMiC31.js`：工程级Reslice Project已接入毫米参数、2D/MPR/3D绘线、真实切面体框、整卷灰度/独立Mask重采样、UpdateCS与世界对象变换、保留源和显式打开新工程。标准ZIP严格携带变换TXT。旧IJK Polyline/剪切密度ROI无损复制仍缺，详[主审报告](../work/mimics-vue-reconstruction/notes/foundation-reslice-project-integration.md)。
- **真实磁盘导出缺口取得新证据**：显式浏览器下载的原ZIP/NIfTI/STL及两份新工程已实际落到桌面并独立读回；原三格式逐体素/逐面一致，恒等重切片589824灰度零差异，旋转/UpdateCS新工程147456灰度与Mask及对象变换均符合独立解析。浏览器实际绘线、生成、打开和新页恢复通过，源与新工程缓存共存。原生SaveAs回执和网页从磁盘重新导入仍未验收。见[浏览器记录](../work/mimics-vue-reconstruction/notes/foundation-browser-reslice-project-2026-11-05.md)及[实际文件](../work/mimics-vue-reconstruction/evidence/browser-file-exchange/README.md)。
- **最新661/661全量测试、类型检查和生产构建通过**，`index-CRqnicsV.js`：任意MPR的Lasso拖放与LiveWire锚点/候选/闭合已整合，Draw/Erase/Threshold最终只改活动Mask一次；严格会话身份与后台所有权防旧树/旧轮廓结果覆盖新工作，不可达路径禁止直线回退。详[整合报告](../work/mimics-vue-reconstruction/notes/foundation-mpr-contour-integration.md)。
- **本轮恢复真实浏览器验收**：25°斜切LiveWire绘制346体素、擦除0、50–60局部阈值保留56；Undo/Redo/Escape通过，Calculate3D生成284面（开放/非流形边0），新页面IndexedDB恢复56体素、284面和Y25°。详[浏览器证据](../work/mimics-vue-reconstruction/notes/foundation-browser-mpr-contour-2026-11-05.md)。自由Lasso正例、真实文件落盘与其他工具仍待验收，不能把本轮提升为所有MPR功能实机通过。
- **最新606/606全量测试及生产构建通过**，`index-Q3i0YVh4.js`：任意物理MPR中已整合连续绘制、擦除、局部阈值，私有预览、松开一次事务、物理源体素覆盖、整笔预算和严格笔画身份隔离。旧Begin/Stroke/End/Cancel不能误改新笔画；局部阈值读原始灰度，其他重叠Mask不变。详[实现与操作审核](../work/mimics-vue-reconstruction/notes/foundation-mpr-brush-integration.md)。这是独立写回策略，原版任意RP写回核尚未恢复，且本阶段没有新浏览器验收。此前572记录为历史基线，完整62+16与基础gate未完成。
- 最新**572/572全量通过及生产构建通过**：三维视口显示选中RP，无Part场景也能适配；支持中心平移、法线旋转、红色边角调整毫米FOV且采样数不变，局部预览/释放一事务、无移动不提交。关闭MPR布局时修改/Undo/Redo/ZIP仍保持关闭，严格对象/volume/双epoch与模式验证。详[RP三维整合报告](../work/mimics-vue-reconstruction/notes/foundation-reslice-gizmo-integration.md)。
- 恢复后也已补记暂停前**541/541通过及生产构建通过**的交互式MPR蓝轴、RP命名对象/Properties/事务与共享后台Worker。此前489记录保留为历史；详细实现和证据见[541阶段报告](../work/mimics-vue-reconstruction/notes/foundation-mpr-interactive-integration.md)。
- 真正任意物理平面MPR已接入工作台：三正交重采样视图、三点/Euler定义、独立world定位与显式IJK同步、各向异性/shear/reflection支持；source影像和独立Mask不改。MPR可创建/编辑Area/Ellipse/距离/角度/直径、文字和Density，并保存其`mprPlane`与完整view状态。详[在线MPR实现与操作报告](../work/mimics-vue-reconstruction/notes/foundation-mpr-integration.md)。
- 新增53项MPR数学、schema、SFC、真实controller/Worker和独立主审反例全部通过。父Workbench已验3MPR实例/world事件接线、源视图返回与Part草稿隔离。完整Ctrl蓝十字交互、Reslice Objects集合、曲线CPR、新重切片工程和MPR分割写入仍未完成；真实浏览器观察仍超时，未升级为实机验收。
- Area/Ellipse原生交互已补：右击点增删、四轴端/中心/外接框角点、独立标签拖放、2D/3D分阶段创建与实时测量预览。几何运算统一在物理平面进行，3D第三点明确为平面几何点，不伪称Part拾取；草稿token防同revision下取消重建后旧确认重放。详[工具实现与用户操作报告](../work/mimics-vue-reconstruction/notes/foundation-measurement-native-editing.md)。
- 标签偏移已严格保存/复制/撤销，曲面路径重算保留名称/颜色/显隐/标签；预览不改raw/history/dirty，实际Worker导出只写已提交对象。任意MPR、全工具浏览器操作与原版数值对照仍未完成；此前交互差距笔记保留为整改依据，以本轮新报告为现状。
- 本轮测量整合已补齐Density ROI点击/拖放创建、矩形边角/椭圆四标记调整、边框移动、松开一次事务与翻片重算。翻片仅派生显示坐标/统计，不改原ROI/history/dirty；完整affine的法向shear也保留。新增完整测量详情、逐点Part来源与实际Part→Mask反向来源，见[主代理审核](../work/mimics-vue-reconstruction/notes/foundation-measurement-review-2026-11-05.md)。
- 此前390阶段的测量控制器18项、来源/属性/保存相关44项、视口与体绘制56项定向通过；手势冻结工程/版本/平面，过期release不得修改新对象。[原生交互差距](../work/mimics-vue-reconstruction/notes/foundation-measurement-interaction-gaps.md)中Ellipse专用交互与Area点菜单已由本轮实现，任意MPR和完整浏览器/原版对照仍未补齐。
- 本轮浏览器列标签、既有标签与连接状态观察均超时，已结束UI验证；没有重启已确认存活的preview进程11063，也没有扩大权限。新增ROI/测量UI仍未获浏览器验收，历史成功截图仅证明各自记录的构建。
- 完整分析报告已保存为 [离线 HTML](../work/mimics-17-analysis/report/Mimics17-完整分析报告.html) 和 [Markdown](../work/mimics-17-analysis/report/Mimics17-完整分析报告.md)。按62项工具工作流组织，依据562个本地帮助主题、129个PE文件分诊及关键函数反编译；覆盖工作流不代表每个工具的内核都已恢复。
- 普通区域生长已核查RLE扫描行区段、邻行/邻层连通检测与环形队列；动态增长已核查访问图、灰度接纳谓词及可选在线均值。三维已核查Marching Cubes的相邻切片、case查表、插值及三角形写出，后续数学深挖见 [native-geometry-depth.md](../work/mimics-vue-reconstruction/notes/native-geometry-depth.md)。原生GUI到各内核的所有映射尚未完全追通。
- 区域生长现有独立Source/Target与交换、Close，生成目标不抢活动Mask；支持copy/cut的原子事务和整体无变化不加历史。新建目标继承源阈值，新选择项保持New属明确应用约定。实际浏览器已验证复制、移动到已有目标、交换后从非活动源移动和一次撤销；详见 [区域工作流](../work/mimics-vue-reconstruction/notes/foundation-region-workflow.md)。
- Vue基础链路已有影像导入、独立可重叠Mask、阈值/编辑/区域增长、三维表面、测量和交换格式导出、工程保存恢复的实现。最新补齐导入竞态隔离、笔画取消回滚、未保存工程替换保护、未知空间单位确认、多标签独立导入与工作位置保存。
- Calculate 3D对话框已按Mask多选→Quality/Options→Calculate→Close组织；批量成功一次提交/撤销，任一Mask失败不发布部分结果，Calculate与Close独立。
- 普通Edit Masks的Lasso已改为左键拖动、松开闭合；Lasso/LiveWire按Draw、Erase或Threshold直接修改活动Mask，不再强制经过临时Apply。多片编辑另支持Lasso/LiveWire的Select/Deselect，固定编辑/复制方向，非0复制跳最后目的层，插值预览必须Apply/Cancel后才能继续；临时区域和与源重叠区域采用不同颜色。普通轮廓专项10项、多片专项19项通过。
- 局部Threshold已有独立三范围：中间跟随Mask保存阈值且只读，上下自定义，切换范围只影响局部编辑，不改global threshold或Mask.threshold。模块6项、实际笔刷控制器7项通过。修复自动阈值Apply后预览复活、同目标更新误清选区，以及编辑未选范围误取消笔画等监听问题。
- 修复删除/撤销测量后选中ID悬空导致无法保存的问题；切换Mask、恢复工程和Undo/Redo后阈值面板跟随对应Mask。状态专项5项通过。
- 二维/三维文字标注已按点选位置→Properties→Apply/Cancel延迟提交，支持文字/名称/颜色/显隐、三种端点、旋转与对齐、长文省略/全文提示、双击编辑、复制和Locate；样式随工程保存且兼容旧对象。文字/控制点不再抢种子或画笔输入。实际浏览器验证了这些基础路径、34.04→44.25 mm距离拖动/撤销、三维锚点移动/撤销和新页恢复完整文字/样式/隐藏副本。
- Cut/Split/修复派生Part不再丢失旧sourceMaskId/sourceRevision；来源提示区分已删除、版本未知、已修改。新建中的三维注释若来源Part删除则取消，已提交历史附件及世界坐标保留；边界见 [来源审核](../work/mimics-vue-reconstruction/notes/foundation-provenance-review.md)。
- 笔刷增加独立Width/Height、宽高联动、物理椭圆/矩形、Ctrl左拖调尺寸和Shift单击定位。连续笔画按聚合鼠标轨迹逐段覆盖，使用切片二维覆盖状态避免重复刷写；1024²大矩形专项只读每个源体素一次。法向薄层不再干扰平面笔画，主键松开/取消不提交；复杂路径超过明确候选预算时整笔回滚。视口/SFC/控制器专项31项通过，真实浏览器新笔刷参数仍待验收。
- 新请求会清理旧DICOM系列和待替换候选，旧缓存保存成功或失败均不能覆盖新导入或busy/error。新增4项后基础专项为26/26通过，见 [导入状态机](../work/mimics-vue-reconstruction/notes/foundation-import-state.md)。
- 本地工程仓库已实现IndexedDB持久化与按工程排队保存。浏览器实际完成新页面及刷新恢复，保留32,424体素Mask、66,856三角形Part、I/J/K=48/48/34与窗位55/窗宽500。真实磁盘对话框仍待验收；只有实际写入完成回执才清dirty。
- 最近一次完整回归记录为 **717/717通过**，生产构建通过（`index-wufMiC31.js`），见 [回归日志](../work/mimics-vue-reconstruction/evidence/reslice-project-regression.log) 与 [构建日志](../work/mimics-vue-reconstruction/evidence/reslice-project-build.log)。沿用仅进程有效的工作区TEMP/TMP。测试总数包含原有协作/服务器测试，不是717项原生功能验收；独立Python41/8项自检另列，661/606及更早记录保留。
- 独立Python格式核验器27项人工正反例通过，且确认实际Worker导出的ZIP/NIfTI逐体素一致、STL/Part逐三角坐标/绕向一致。可打开的 [合成交换样本](../work/mimics-vue-reconstruction/evidence/exchange-sample/README.md) 含929体素Mask和1384三角面；另有 [10个有效DICOM与5个独立拒绝样例](../work/mimics-vue-reconstruction/fixtures/dicom/README.md)。这些是Node/CLI文件证据，不是浏览器落盘。
- 浏览器实际完成合成影像阈值→195体素临时画笔→复制两层585体素并跳片→Apply移除54体素→一次Undo/Redo→Calculate3D→本地副本新页面和刷新恢复。Calculate后窗口保持，Close独立；表面开放/非流形边均0。详情与截图见 [本轮浏览器证据](../work/mimics-vue-reconstruction/notes/foundation-browser-multiple-2026-11-05.md)。
- 后续真实浏览器区域生长、测量和文字属性/三维锚点及其恢复的输入、结果、截图与版本边界见 [区域和注释证据](../work/mimics-vue-reconstruction/notes/foundation-browser-region-annotations-2026-11-05.md)。
- **基础验收门仍未通过**：文件导入/真实落盘、所有指针取消、区域copy/cut、测量、插值与轮廓完整浏览器操作、quota/错误等仍待验证；详见 [foundation-audit.md](../work/mimics-vue-reconstruction/notes/foundation-audit.md) 和 [25项验收清单](../work/mimics-vue-reconstruction/notes/foundation-acceptance.json)。未进行原Mimics同输入输出对照，不声明原版数值等价。此前上传接口和原生窗口中止记录仍保留，未改变扩展权限。
- 本轮再次恢复原工程后，另存为返回取消；原生窗口控制随后因工具无法可靠识别浏览器URL而中止。已停止全部UI操作，真实文件对话框和落盘继续未验收，见 [本轮文件记录](../work/mimics-vue-reconstruction/notes/foundation-file-attempt-2026-11-05.md)。
- Flood-fill已追加 [资源、控件和静态地址深化](../work/mimics-vue-reconstruction/notes/foundation-floodfill-analysis.md)，但推进内核仍未知，没有用普通连通填充替代。

下文保留代码分组及此前浏览器检查的背景；此前截图不作为最新基础改动的验收证据。

## 完整范围

验收契约保留原报告62项工具与16项跨链路要求，见 [requirements.json](../work/mimics-vue-reconstruction/requirements.json)。其中包含原始影像/物理坐标、独立可重叠Mask、预览/提交/取消、撤销、网格/测量对象、工程保存恢复、Worker并发与所有专业工具。原版算法尚不明确的地方按证据单独标记，独立实现不等于原版逐体素/逐三角形一致。

## 已落地的代码

- Vue工作台：三切片与WebGL三维视图、对象列表、参数面板、阈值预览、种子选择、手工笔刷/临时选区、轮廓、测量和工程导入导出。
- 独立Mask数据模型：不同Mask可重叠；Boolean运算、阈值和画笔不会因单标签数组而抹掉其他Mask。
- 分割内核：阈值、RLE区段区域增长、动态增长、Boolean、形态学、最大连通域、腔体/孔洞、裁剪、复制选区、层间插值与LiveWire。已恢复语义和独立算法差异见 [segmentation.md](../work/mimics-vue-reconstruction/notes/segmentation.md)。
- 三维内核：真实256项MC表及原版角点/边编号、物理仿射、法线、质量检查、平滑、QEM边折叠减面、独立Wrap、Part→Mask以及ASCII/二进制STL。进一步恢复了局部灰度插值与体积多项式补偿，见 [geometry.md](../work/mimics-vue-reconstruction/notes/geometry.md) 和 [native-geometry-depth.md](../work/mimics-vue-reconstruction/notes/native-geometry-depth.md)。
- 量测：物理距离、角度、三点直径、椭圆、二维多边形、密度ROI，以及仿射反解。
- DICOM：未压缩显式LE/BE、隐式LE的CT/MR单帧系列，空间排序、signed stored bits、rescale、LPS→RAS；压缩、多帧和不规则系列明确拒绝，不静默读取错误结果。
- 项目：ZIP保存原始影像、独立Mask、网格和测量；原子Undo/Redo；项目输入验证及历史内存预算。
- Worker：使用真实后台模块；取消时终止工作线程，陈旧结果不提交；Vue代理参数在消息边界转换为可克隆数据。

## 验证证据

已通过的纯代码测试覆盖：区间端点与连通性、动态均值/拒绝不重试、各向异性、仿射体积、封闭/泄漏孔洞、LiveWire最短路径、MC配置/边界闭合/球体误差、法线和拓扑、减面、STL记录和回读、DICOM定量和方向、项目ZIP恢复及撤销。

`tests/mimics-workbench.test.ts` 以Node worker_threads适配运行**实际 operations.worker.ts**，证明“阈值预览→提交→撤销/重做→表面→STL→工程ZIP恢复”经过真实消息边界，同时验证“取消后立即再计算”和临时选区事务。这是控制器/Worker端到端测试，**不等于浏览器指针、WebGL画面与交互验收**。

用户已明确授权浏览器连接器访问 **仅 `http://127.0.0.1:5173`**，测试只使用合成影像。随后实际通过四视图加载、阈值预览/应用/撤销/重做、三维表面生成、二维距离放点、控制点拖动及撤销；截图在 `evidence/browser-loaded.jpg` 和 `evidence/browser-surface.jpg`。骨壳为66,816三角形，开放/非流形边均0；距离从34.04 mm拖到44.26 mm，撤销回34.04 mm。浏览器下载等待曾超时，尚未验证实际落盘；其他新模块浏览器验收仍待完成。授权已保存，不再重复询问。

## 如何运行

```powershell
npm run build
npm test
npm run dev
```

主页面为新工作台；`?workspace=collaboration` 保留原有多人协作工作台。新工作台工程的格式为 `.deepmark.zip`，不是Mimics的`.mcs`；STL/NIfTI为交换格式。不要把“保存成功”理解为已获得原版MCS格式互通。

## 尚未完成的明确要求

完整逐项状态以requirements与各模块最新证据为准。高级模块中已有Smart Expand、中心线、轮廓、实体Label、Cut/Split、体绘制、体网格和时序相关代码或进一步分析，但其原版等价性、全部UI接线与浏览器验收尚未统一完成；不能把文件或按钮存在视为工具完成。原版准确参数/算子映射、三维LiveWire轮廓融合、专业器官完整流程、完整MPR交互/分割/曲线及新工程重切片、原版工程互通等仍有缺口。当前优先完成基础链路及浏览器验收，再推进高级功能；完整范围不缩减。

新增代码集中在 `src/mimics/`；原始项目源码备份位于 `work/mimics-vue-reconstruction/baseline/source-before.zip`。原始Mimics文件仍只读。
