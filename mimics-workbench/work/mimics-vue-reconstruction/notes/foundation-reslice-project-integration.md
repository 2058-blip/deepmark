# 工程级重切片与实际文件交换：主审整合

2026-11-05。当前全量 **717/717通过**，类型检查与生产构建通过；主包`index-wufMiC31.js`，运算Worker`operations.worker-B78TBspI.js`，共享MPR采样Worker仍为`mprSampling.worker-DZopFQvd.js`。本阶段整合Sol xhigh子代理的几何、数据/schema、视口和独立工作流审查。完整62工具+16跨链路目标仍在进行，基础gate未完成。

## 原文与用户操作

原帮助明确Reslice Project通过直线确定新堆栈，允许在2D/3D点起终点、编辑坐标、绕线旋转、选择方向，输入图像宽高、像素尺寸与层距并查看层数；新体积框显示在视图中。**原截图的宽高是mm，不是样本数。Update CS默认关闭。** 原文还要求输出变换矩阵，打开Update CS后会重设坐标系；精确预设名称、取整、中心/角点、矩阵文件格式和对象继承规则仍未恢复。详[原文与数据审计](foundation-reslice-project-native-audit.md)。

当前独立工作流：

1. 顶栏`Reslice Project…`打开非模态面板；原工程继续显示。指定毫米宽高、像素尺寸、层距、背景和灰度插值，预览实时给出样本数、有效FOV、层数及输出内存。
2. `Draw Line`收起面板，在原始切片、MPR或Part表面点两端；坐标随后仍可编辑。使用当前MPR或本应用的源方向/世界轴快捷设置，也可得到初始线段。新体积的12条物理边在三维显示，2D只画当前切面真实截线，不投影全部体框。
3. `Generate`在后台生成独立新体积；完成前后都不替换源、不中途发布Mask。结果需另行保存、下载或显式打开。取消/失败仍保留源工程。
4. `保存新工程`保留原另存为策略；`下载新工程副本`提供正常的浏览器下载。标准工程ZIP含固定的`reslice-transform.txt`，也可单独导出TXT。打开新结果复用未保存工程保护，生成的新工程保持dirty，不能因发起下载就宣称已写入。

## 重采样和坐标规则

控制器将毫米参数明确量化成内部整数宽高：`max(1,round(mm/pixelSize))`，显示实际FOV，再交给`resliceProjectGeometry.ts`。层数取`floor(lineLength/sliceDistance)+1`，并校验浮点乘积，确保最后层不越终点；不拉伸末层。起点为第一层中心，首像素中心按半个中心跨度移到线段中心旁。行方向投影与绕线右手旋转规则都是独立定义，不称原版默认。

灰度支持线性/最近邻；无源中心支持或非有限灰度填有限背景。独立Mask按完整仿射和半体素支持最近邻重采样，保留ID、属性和阈值，版本推进一次。Mask可以重叠。源数据和源头保持原样；新头为规范小端Float32/mm/sform，源原dtype/slope仍随原工程保留。

Update CS关闭时保留世界坐标；开启时新堆栈为自身正XYZ坐标，首存储样本中心为原点。输出明确记录：旧世界毫米→新世界毫米T、逆T、以及`Aold^-1 * inverse(T) * Anew`的新IJK→旧IJK采样映射。**原生“左上角”的中心/角点映射尚未确认**，不能把此应用约定当成原版恢复。

默认复制可表示的世界对象：Part顶点/测量点/曲面控制点/中心线点/RP原点用T；法线、平面步向量和labelOffset只旋转。旧IJK测量平面转为物理MPR平面，视图IJK经旧世界、新世界和新网格重新定位。保留Part及中心线的旧sourceRevision，避免将旧几何冒称新Mask的最新重建。DICOM强度/显示元数据保留；更新后的局部坐标标为`reslice-local`，不冒称患者RAS。

原IJK Polyline及剪切源切片上的双角点密度ROI目前无法无损复制，复制世界对象时明确拒绝。用户可显式选择只生成影像与全部Mask，其余对象保留在源工程，并列出未复制数量；没有静默丢弃。本限制继续保留在完整目标内，不能将本功能称为全部对象迁移完成。

## 事务、资源与格式

- 绘线事件冻结Volume、工程版本和递增lineToken；MPR还检查姿态、共面/FOV，Part引用须仍可见。旧点击、稀疏坐标或离面点不能进入新线段。
- 生成任务用generation持有取消权。重复Generate不夺走在途任务的working状态，旧结果/finally不清新任务；参数、源版本或体积变化会取消旧结果。
- 预览只查轻量对象和坐标元数据，不扫描整卷；完整校验在真正构建中执行。默认输出16M体素/256MiB，硬上限128M/512MiB，单维32767；Mask逐项二值验证支持取消。资源上限不是原版默认。
- 717全量中新增56项：几何17、数据/schema14、面板/交线/专用拾点12、真实Worker工作流11、显式下载2。包含旧协作/服务器测试，不是717项原生验收。
- schema可选`resliceTransform`只允许非空UTF-8文本至64KiB。ZIP仅允许与其逐字节一致的固定TXT条目；缺失、不一致、无声明额外条目及任意未知路径仍拒绝，旧v1兼容。

## 实际验证

[完整回归](../evidence/reslice-project-regression.log)、[生产构建](../evidence/reslice-project-build.log)、[工作流审计](foundation-reslice-project-workflow-audit.md)。浏览器实际验证见[本阶段浏览器记录](foundation-browser-reslice-project-2026-11-05.md)。

已实际下载源ZIP/NIfTI/STL及两份新工程，并用独立Python读回：

- 原三格式的Mask逐体素和Part逐面一致。
- 恒等重切片589,824个Float32、全部Mask及网格数组零差异；矩阵方向/采样映射独立核验。
- 世界X方向、绕线30°、2mm像素、Update CS开启的新工程：147,456个灰度、Mask成员、保留Part坐标/法线均与独立解析计算完全一致；RP与矩阵残差约1e-14。
- 通用核验器41项自检、专用斜切解析8项自检另行通过。详[独立核验记录](foundation-browser-reslice-independent-oracle-2026-11-05.md)及[实际文件](../evidence/browser-file-exchange/README.md)。

真实另存为picker回执、浏览器文件导入/回读、全部参数/取消矩阵、世界Polyline及剪切密度ROI迁移、CPR与原版同输入对照仍未完成。标准ZIP已含实际TXT，尚不支持自动写到原工程所在文件夹；浏览器原文件也可能没有目录授权。目标保持active，不宣称原版/临床等价。
