# 三维内核与 WebGL 查看器：实际完成及证据边界

本模块只读分析既有反编译/报告，没有运行 Mimics、原厂 DLL、许可组件或修改原目录。实现是可测试的 TypeScript/Vue 独立重构；下述功能已实际编码，不代表全部数值行为与 Mimics 17 同源或逐点一致。

## 稳定 API

源文件：`src/mimics/geometry.ts`、`marchingTables.ts`、`PartViewport.vue`。共享 `types.ts` 未改动。

|调用|输入/返回|
|---|---|
|`calculateSurface(grid, mask, options?)`|`VolumeGrid` + 独立 `Uint8Array` Mask → `TriangleMesh`|
|`meshStats(mesh)`|顶点/三角形/边数、面积、signedVolume、volume/absoluteVolume、boundaryEdges、nonManifoldEdges/Vertices、inconsistentEdges、退化面数、components、Euler、bounds、closed|
|`smoothMesh(mesh, {iterations, factor, compensateShrinkage, compensationMethod, preserveBoundary})`|不修改来源的平滑网格；默认三次体积多项式补偿，另可显式选global-scale|
|`reduceMesh(mesh, {targetRatio,tolerance,preserveBoundary,featureAngle,iterations})`|不修改来源的 Quadric 边折叠网格；目标比例可因约束无法达到|
|`maskFromMesh(grid, mesh, control?)`|按影像完整 affine 逆变换后体素化，直接返回 `Uint8Array`|
|`wrapMesh(mesh,{resolution,closingDistance,dilate,protectThinWalls,maxVoxels})`|体素闭运算/偏移/MC 重新提面|
|`parseSTL(ArrayBuffer\|Uint8Array\|string)`|严格标准 Binary/ASCII STL → 合并相同坐标的网格，重算法线|
|`exportSTL(mesh,{binary?,name?})`|默认 binary 返回 `Uint8Array`；`binary:false` 返回 ASCII 字符串|
|`computeNormals(mesh)` / `validateMesh(mesh)`|物理空间面积加权法线 / 结构验证|
|`createMeshPicker(mesh)`|静态median BVH；`intersect(origin,direction,maxDistance?)` 返回最近world-mm hit、triangle、distance、barycentric，几何变化后需重建|

计算 API 接受 `progress(fraction)` / `cancelled()`；检查到取消时抛出明确错误。Wrap 的多阶段进度不是整条作业单调百分比，worker/UI 应在阶段间归一化，当前没有实现流式可恢复计算。

## Marching Cubes

原表来自 `work/mimics-17-analysis/evidence/reconstruction/marching-cubes-table.json`，RVA `0x142a20`，每项19字节、256项。`marchingTables.ts` 将全部1-based边号逐项减1，没有拿教科书表替换真实表。

根据 `MC-0x180017330.c` 的相邻配置 `(old >> 1) & 0x55` 和新位 `2/8/0x20/0x80`，并对照 `MC-0x1800011f0.c` 的12方向分派与 `MC-0x180001610.c` 坐标写出，角点顺序确认为：

```
0=000, 1=100, 2=010, 3=110,
4=001, 5=101, 6=011, 7=111  （XYZ）
edges 0..11:
01,02,23,13,45,46,67,57,15,04,37,26
```

这不是常见的方环角点顺序。测试遍历所有256表项，确认每条被使用的边都连接当前case的一内一外角点，并验证原始三角形数分布 `2/16/50/80/76/32`。

当前提面包括：真正逐cube case查表、跨cell共边顶点缓存、线性或中点内插、`0.001..0.999`交点比例钳位、六侧外部采样层、各向异性 spacing / 完整3×4或4×4 affine、按共享边统一面方向，再以原标量场方向判断外壳/内腔；法线在最终物理坐标重新计算。负 determinant 的反射 affine 也会得到向外面方向。空 Mask 返回空网格；非法尺寸、scalar阈值分类不一致、奇异/透视矩阵和非法步长会失败。

`scalarField` 是可选逐体素标量场，其 `>=threshold` 分类必须与 Mask 一致。没有该场时使用0/1 Mask与默认0.5阈值。该接口支持可验证的灰度线性插值；追加的 `native-local` 根据独立指令复核实现了mode=1的分段公式及5×5 trimmed extrema，XY缩减边也会选择与起点方向相同、变化最大的原始跨阈值段。`nativeZScale` 显式控制Z分母额外比例。完整公式、交叉验证及尚未证明的UI字段/边界编码详见 [native-geometry-depth.md](native-geometry-depth.md)；不能因此宣称全部灰度/Contour流程逐位还原。`step` 保留最后体素中心和六侧padding。

默认 `topology:'resolved'` 对四交点的共享face使用确定性 asymptotic decider，再沿cube内轮廓多边形提面，避免传统MC鞍点裂缝；零判别值用共享face的全局角点序打破平局，邻cube结果一致。这是独立鲁棒性扩展，不是已经确认的厂商分支。`topology:'native-table'` 保留全部原表三角形连接关系，不承诺任意鞍点配置闭合。多边形超过三点时使用内部重心扇面，内部点不保证正好位于连续三线性等值面上。

`quality` 接受 Low/Medium/High/Optimal/Custom 的名称，但没有伪造尚未恢复的预设数值表：各名字默认都使用full sampling，实际降低采样必须显式传 `step`。High在原帮助中的XY缩减语义与Optimal不同；当前不把二者说成原厂准确预设。平滑/减面是明确可选后处理，默认不悄悄执行。

## 后处理与体素化

平滑采用均匀邻域 Jacobi Laplacian，默认固定边界。补偿开关当前默认使用第二次Laplacian及 `V(p+μL)` 三次体积多项式，优先选 `[-1,0]` 最大实根，找不到时评价极值/边界与 `−factor`，保留约−0.95保护。这与 `_CalculateMu` 证据的数学设计对应，但不是原生复杂根求解器、整数化或所有枚举的逐位实现。`compensationMethod:'global-scale'` 显式保留全模型体积等比恢复备选；两种模式都不保证局部尺寸或不同壳层各自体积。

减面确实构造面平面4×4 Quadric，累积原始误差，评价可解的最优点/两端点/中点后排序，并执行边折叠。含link condition、锐边保护、边界约束、局部面法向翻转/退化与重复面防护；候选先转为最终Float32存储坐标再做几何检查，防止双精度候选通过、实际写入后才共线的退化。每轮选择互不相邻操作后重建邻接。`tolerance` 限制端点位移与相邻原面偏离，不是全局Hausdorff保证。并非对原厂 Point/Edge/Advanced Edge 三模式的逐项复制。输入自交不会因此自动修好，目标比例可能因拓扑/特征约束停在更高值。

网格统计识别不止非流形边，还检查每顶点link，发现“两个闭合壳仅接触一个顶点”的非流形点。`volume/absoluteVolume = abs(signedVolume)`，正确保留内腔反向壁的减体积。该数值只有在闭合、方向一致、无自交条件下才代表实体物理体积；自交完整检测未实现。

Part→Mask 为独立扫描线体素化：先完整affine逆变换，按每个voxel-centre YZ射线求三角交点、按奇偶配对填充X。小扰动避开恰逢网格边/点的射线。测试覆盖各向异性、剪切、反射、内腔与原Mask往返。输入必须闭合、方向一致、无退化；扫描中奇数交点也会显式报错。它不等同原厂“逐切片组轮廓后填充”的全部实现，开放/自交表面没有自动推断临床内外定义。

Wrap 用独立等距栅格、体素化、半 Closing Distance 半径的球形结构元 dilate→erode、可选原Mask并集保护和带符号额外dilate，再MC提面。Closing Distance在这里是明确的独立实现参数，不宣称等于原厂图像偏移中内部单位/分辨率/薄壁系数的完整公式。当前要求闭合输入，不能把开放STL自动当成可靠实体。默认上限200万体素、单次形态学4亿邻域访问，超过时要求用户提高resolution，防止浏览器无界分配；没有恢复原预算分支或锐边/颜色投影恢复。保护薄壁通过并集保留现有占用体素，低于栅格尺度的结构仍可能消失。

## STL 与 GPU 查看器

STL binary严格为80-byte header + uint32 triangle count + 50-byte records（normal3 + vertices9 的12 float32、attribute uint16）。原writer法线由叉积计算、拒绝退化面，在当前实现也已落实。ASCII包含完整solid/facet/outer loop/vertex/endloop/endfacet/endsolid结构。导入先按实际计数/长度识别binary，即使header以solid开头；支持带byteOffset的Uint8Array视图。拒绝截断、记录不一致、非有限数据、退化三角形和缺失标记。当前严格标准STL，不接受厂商压缩/Materialise项目序列化，不保留STL颜色attribute，自带法线重算而不是信任导入normal。

`PartViewport` props：`parts:PartObject[]`, `revision?:number`, `selectedId?:string`；emits：`select:string` 和 `pick:{partId,position:Vec3}`，拾取位置为world mm。依赖只有Vue；WebGL2优先，WebGL1回退，不需要Three/vtk或Uint32索引扩展（GPU上传展开三角形）。支持多对象颜色/opacity/可见性、选中高亮、网格边、正交投影、旋转/平移/缩放、Fit、正/顶/侧/等轴、触控捏合缩放和CPU BVH三角形射线拾取。ResizeObserver、RAF、GPU buffers/program、BVH缓存及context/keydown事件在销毁时释放。

新增可选 `measurements`, `measurementLabels`, `pendingPoints`, `selectedMeasurementId`：SVG覆盖层复用GPU同一R/中心/平移/缩放投影，显示测量线、三点角弧、外接圆、长轴端点/短轴点椭圆、多边形、annotation引线/文字标签与待完成点编号。`selectMeasurement` 只通知父级选中；关联partId的三维控制点拖拽用该Part的BVH表面交点更新child临时点，pointerup只发送一次 `moveMeasurementPoint:{id,index,position}` 供父级单次Undo事务；Escape/pointercancel取消临时点且不提交。无partId的切片测量只投影显示/选择，避免沿3D表面拖动破坏其平面语义。SVG覆盖层始终可见，不做GPU深度遮挡；长标签可能裁切但title保留完整文字，复杂标签避让未实现。

追加 `overlayLines?:{id,points:Vec3[],color,label?}[]` 独立显示中心线等world-mm密集折线，逐点投影，不冒充surface-distance。无可见Part时，fit/centre/radius改由可见未绑定Part测量、pending和overlayLines的物理点bounds确定，空态不遮盖已有几何，只显示小提示。surface-distance的密集路径完整绘制，仅首/末端显示编辑handle，避免把每个内部采样点画成控制点。项目/中心线状态仍由父级管理。

透明对象按对象重心排序，采用常规alpha混合；复杂相交透明壳体不是order-independent透明，不声称医学级逐片正确合成。CPU拾取已加入静态median BVH，66,816面本机建树约164ms、1000条命中射线约10.5ms；这是Node数学层单次量级，不是浏览器帧率保证。当前没有体绘制、裁切平面、GPU体素数据或原厂全部工程体网格/非流形多材料共享面功能。上下文丢失与WebGL不可用提供可见提示；尚无对所有显卡/浏览器实机回归的证据。本轮浏览器origin审批仍由主任务等待，没有绕过审批使用另一浏览器；覆盖层鼠标/触控与GPU显示需后续获准后实测。

## 验证

运行：

```
node --experimental-strip-types --test tests/mimics-geometry.test.ts
node_modules/.bin/vue-tsc --noEmit
```

18项几何测试通过，覆盖：256原表校验、255非空2³二值case及12组固定随机mask闭合、六侧边界、Euler、各向异性、20mm球面几何、剪切/反射affine、空腔与多壳、非流形/退化/错误索引诊断、标准binary/ASCII STL往返与失败、平滑来源不变及两种补偿、Quadric减面拓扑与体积及开放边界固定、Wrap封小隧道、取消和非法输入；新增mode1两方向/四分支、XY最强跨阈值段、66816三角骨壳Float32退化回归、BVH最近面/平行/内部/最大距离/重心坐标及24条任意方向球面射线。Vue类型检查通过。单元测试不能代替浏览器交互验收、原Mimics运行差分或临床/工程认证。

29³合成采样、半径10mm标量球：1902顶点/3800三角形，Euler2、边界/非流形/方向冲突/退化全0；面积1251.4342mm²（解析误差−0.4140%）、体积4157.3755mm³（−0.7500%）。原端点钳位使理论轴向20mm尺寸得到约20.002mm，这是已保留的数值特征。QEM目标55%、tolerance0.8mm后为2090三角形，保持Euler2和闭合，体积变化−0.05586%。4次、factor0.25平滑后多项式补偿体积4157.37548mm³。

结论：三维通用闭环已有可运行、有误差测试的独立内核和Vue查看器；原厂预设、复杂插值、完整native补偿/减面/Wrap策略、工程体网格和所有界面联动仍有明确差异，不能标记“完美同源重构完成”。
