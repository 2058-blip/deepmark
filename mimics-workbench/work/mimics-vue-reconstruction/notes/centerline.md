# 中心线、分支与截面分析

实现 `src/mimics/centerline.ts`；验证 `tests/mimics-centerline.test.ts`。目标仍包括 C01–C09 的完整工作流；这里交付可测试的独立后端，并不把原版完整提取器、全部交互、CPR、IGES 或末端切割宣布完成。没有运行 Mimics/原厂 DLL，原目录只读。反编译在工作区副本 `evidence/centerline/MatCenterline3D.dll` 上进行。

## 本地操作与静态证据

| 来源 | 已确证的契约/局部证据 | 尚不能据此推断 |
| --- | --- | --- |
| CHM `Centerline.txt` | 输入 3D object；Fourier 平滑；阈值为 smooth factor × 平均 branch radius；手动 resolving resolution 与 fixed/variable control spacing；branch sets/segments；按估计体积排序 | 自动细枝检测、内切球与 fast marching 的完整求解公式、全部参数默认值 |
| `Edit centerline control points.txt` | 2D/3D 选控制点，两个限制点和 influence distance；分叉点由相邻分支多个限制点约束；双击应用 | 实际形变基函数、完整鼠标/事务路径 |
| `Centerline post processing.txt` | Fourier 高频去噪；按同一半径比例阈值限制；滤掉短 peripheral/loose branches | 原频谱、重分布采样、边界和所有分支过滤模式 |
| `Grow Segment...`、`Add Branch...`、`Split centerline.txt` | STL 上指定目标增长/新枝；在控制点拆分；双击确认 | 原路径优化、自动连接位置、分离对象处理枚举 |
| `Centerline measurements.txt` | 截面法向沿中心线；Dfit 自 MIS16 起为最小二乘圆；Scf/Area；Dmin/Dmax 以中心线点到轮廓半径×2；Dh=4Area/Scf，Xh=Dh/Dmax；二次多项式导数曲率；T=1−直距/沿枝距 | 最小二乘目标的具体形式/权重、邻域窗、截面退化规则、拟合椭圆求解器 |
| `Centerline properties.txt`、`Export of centerline properties.txt` | Mimics17 默认 cubic spline，也可 quadratic；按 branch segment 导出控制点/切向/法向/副法向和测量；Text 与 IGES | 独立稠密折线等于原 cubic spline，或 CSV 等于原 Text/IGES 文件 |

既有导出清单 `work/mimics-17-analysis/evidence/triage/MatCenterline3D.dll.symbols.tsv` 明确包含：

- `MStlBaseOperatorFindCenterline::Operate` `0x18003CE60`、cardiovascular `Operate` `0x1800437E0`；字符串出现 `_OperateInscribingSpheres` 和 `_OperateFastMarching`，进口包含 `MBoundedDistanceField`。这是两种原生路径的证据，不是恢复完整内核。
- `MCenterlineActions::SmoothenFourier` `0x1800285E0`、`SmoothCenterline` `0x180029600`、`DeleteShorterSegments` `0x1800220B0`、`FindShortestPath` `0x180023EF0`。
- Grow `Operate` `0x180034390`、Split `Operate` `0x1800384B0`、SplitWithContour `Operate` `0x18003B180`；GetOutput/SetInput/SetVoxelSize 等相关接口。

本轮新增 JSON 反编译证据在 `evidence/centerline/native-*.json`：

1. `0x1800437E0` 根据对象 byte+30 分派到 `0x180045FA0` 或 `0x1800438C0`。未从这个开关自行命名 GUI 参数。
2. `SmoothenFourier` 先 `RedistributePoints`，复制/镜像坐标序列，调用变换函数、清零高频系数，逆变换；按空间偏差参数 a3 和可选 `CheckStlIntersection` 调节截断。该函数完整伪代码已保存，支持 Fourier/阈值/几何检查的局部结论，尚未逐指令重构。
3. `DeleteShorterSegments` 检查 `threshold >= stored segment length`，可通过 `_GetLooseEnds` 限制为有松散端的分支，然后调用对象删除接口。
4. `FindShortestPath` 包装器进入 `sub_1800225B0(...,1)`，本轮未恢复该核心。
5. 两个大提取函数请求所得伪代码只返回截断预览（原长度约 69,939 和 94,631 字符）；它们不作为完整求解器的证据。未在文档中把截断预览当作分析完成。

## API 和数据

`fitCenterline(grid, mask, {root,endpoints,coordinateSpace?,controlSpacingMm?,centerWeight?,clearancePower?,maxVoxels?,...control})`，默认输入种子为 world-mm；voxel 模式先取最近体素中心，必须是前景。`fitCenterlineFromMesh(grid, mesh, options)` 先用既有闭合网格体素化；不会给未封闭曲面猜测内部。

返回 `CenterlineGraph`：

- `nodes`: id、world-mm position、root/endpoint/junction/control。
- `branches`: start/end node IDs、逐步 **dense** world-mm `points`、估计 `radiiMm`、单独的 `controlPointIndices`。控制点间距目前为固定沿线累计距离选择已有 dense 点，不能丢掉 dense 路径后直接连接控制点来宣称仍在内部。
- `branchSets`: 当前按连通分量组织，使用 `Σπr²·ds` 估计体积排序。这是明确的独立分组/体积约定。
- `cyclePolicy='rooted-shortest-path-tree'`、algorithm/coordinateSystem/warnings。源体积可以有环，但只返回指定端点的根最短路树，不恢复环。传入闭环/平行边的编辑图会被拒绝。

## 路径数学规格

1. 完整 voxel-to-mm affine 提供三条物理基向量。体素面间距用 determinant/cross-product 得到，剪切与各向异性参与物理代价；不是以索引距离冒充毫米。
2. 前景边界中心以最近外侧体素面的半高初始化 clearance，在前景安全 26 邻域上用物理步长 Dijkstra 传播。它是 **图距离 clearance 估计**，不是精确 Euclidean signed distance 或原版 medial axis 半径。
3. 对角邻接要求其所有轴组合中间体素都为前景，防止角/边接触时越过背景。路由代价为 `step_mm * [1 + centerWeight * (maxClearance / meanEdgeClearance)^clearancePower]`。
4. 根到各端点共享同一个确定性前驱树，取路径并集，按分支/端点分解。分离区域不会被直线连接；所有输出 dense 边都在被接受的体素单元联合内部。
5. 默认最多 2,000,000 体素。内存为 clearance/cost/predecessor 和堆；没有自动原版 resolving-resolution 调节或无限体数据支持。计算支持 cooperative cancellation/progress，浏览器需在 worker 内使用。

## 编辑、平滑、分离

- `moveCenterlineControlPoint(graph,branchId,pointIndex,newWorldPosition,{influenceMm,domain?})`：沿原分支弧长线性衰减位移，远端节点固定；移动分叉时同步所有相邻分支端点。传 domain 后，完整线段在 voxel 空间求所有半整数单元边界交点，逐区间验证前景，不用有限步长采样掩盖细小背景穿越。缺 domain 时返回明确未校验 warning。原版黑色限制点、形变基函数和 UI 仍是差异。
- `smoothCenterline(graph,{factor,domain?})`：端点固定的独立 sine/Fourier 残差低通，逐次删高频，最大移动不超过 factor × 提取平均半径；可加同样的体内约束。默认每枝最多 2048 点，O(n²)。没有冒充原版镜像变换、重分布和二分频谱选择。平滑/编辑后原 extraction radii 仅为旧估计，截面量应重算。
- `filterShortBranches(graph,threshold,{preserveRoot?})`：反复删长度 ≤ 阈值且具有自由端的枝，默认保护根枝；不删除两分叉点间的短内部连接。
- `splitCenterline(graph,branchId,pointIndex)` 在内部 dense/control 索引复制断点并返回两个独立图；`deleteCenterlineBranch` 目前仅删整个分支，尚未实现 C05 任意两控制点间删除路径。
- `growCenterlineBranch(graph,grid,mask,{branchId,pointIndex,end,...})` 重新在内部路由，在最后一个与旧线共享的体素处接入，必要时分裂旧 branch 成 junction；终点已在旧线上时拒绝重复/闭环。不是从连接点到目标画直线。
- C06 Cut Ending 所需 STL 正交截断/封口和替换事务仍未实现；不会把 split graph 当作 STL 已被切割。

## 截面与测量规格

`sectionAt(closedMesh,worldPoint,worldTangent,{toleranceMm?,fitSamples?})` 把三角形与真实物理法向平面求交、焊接、组闭环，选择包含该中心线点的实体分量。多个不相交截面不会相加。开放、分叉/退化拓扑、点在实体外、带孔截面均明确失败；带孔没有被忽略并当成整圆面积。

- Area 为闭合折线鞋带面积，Scf 为物理边长和；Dmin 为该中心线点到连续轮廓边的最短距离×2，Dmax 为到轮廓顶点最远距离×2。拟合圆心偏离中心线点时仍保持这两个定义。
- 为减轻三角剖分密度偏差，默认等弧长重采样 256 点。Dfit 使用尺度归一化的代数最小二乘圆 `x²+y²+Dx+Ey+F=0`；不是平均半径×2。E 使用独立代数最小二乘椭圆 conic，非椭圆解时 E 为 NaN。原最小二乘几何/代数目标与权重未恢复。
- Dh=4Area/Scf，Xh=Dh/Dmax。截面容差默认 1e-6×max(1,mesh span) mm。多边形网格逼近圆/椭圆本身存在离散误差，未声称解析曲面完全精确。
- `centerlineKinematics(points,index,windowMm?)` 按局部三点、非均匀弧长二次插值求一/二阶导数，曲率 `|r'×r''|/|r'|³`，单位 1/mm；端部单边，直线 Frenet normal/binormal 不定义并返回 null。T 使用全枝或指定的截断中心窗。
- `distanceOverCenterline(graph,from,to)` 沿真实 dense 分支图求路径长度和 tortuosity；跨分枝也沿图走，不用两点直距代替。
- `measureCenterline` 对控制点批量记录上述量，失败截面保留独立 error；`exportCenterlineCSV(graph,rows?)` 分 branch set/branch 导出 mm/mm²/1/mm、位置/TNB 和全部截面数值，缺失项为空。Twist Angle 和原 IGES/Text 模板仍未实现。

## 验证

`node --experimental-strip-types --test tests/mimics-centerline.test.ts`：10/10 通过。夹具覆盖旋转/各向异性物理长度、直管、绕过背景的 U 弯管、Y 分枝共享/新枝接入、源体积环的显式树投影、断开与对角接触拒绝、节点/分叉编辑越界拒绝、Fourier 偏移阈值/降噪/端点保持、短枝过滤/删除、拆分长度守恒、圆/椭圆/偏心/斜平面/多实体截面、解析圆曲率/TNB/扭曲度、CSV 单位及 mesh→mask→line 路径、取消与预算。

`tests/mimics-project.test.ts` 已增加中心线与带洞 polyline 的 v1 optional schema 往返、metadata 历史隔离和损坏 graph/ring/parent/metric/ID 拒绝。该测试与中心线套件联合 21/21 通过（工程测试11项）。这不证明浏览器拾取、控制点拖动、CPR、临床等价或原 Mimics 输出一致；requirements 继续 partial。
