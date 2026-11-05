# Cut、Split、曲面路径与有限修复工具

范围保持 `scope.md`：原软件和DLL不执行，许可逻辑不修改。阅读本地CHM提取文本、既有符号表和案件DLL副本；只对自己的Vue/TS实现做合成测试。新代码 `src/mimics/meshTools.ts`，测试 `tests/mimics-mesh-tools.test.ts`。这些是有证据约束的独立重构，不是已经达到全部Mimics工具逐点同源的结论。

## CHM 中可确认的流程

来自 `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/`：

|帮助页|明确内容|当前覆盖边界|
|---|---|---|
|`Cut.txt`|三种工具：With Polyplane、With Curve、Orthogonal to Screen；路径点可拖动；Polyplane Properties有depth/thickness/front/end extensions/closed与Preview；Curve要求延长线浮于模型外，OK时cut并split|当前只实现**单平面**三角面裁切，不能称为全部三种Cut工具|
|`Cutting.txt`|教程把depth从20mm调30mm、Closed、Preview、Keep Originals后OK，新对象加入列表|20/30mm是教程例子，未当作默认常量|
|`Splitting.txt`|选择freeform对象、keep all parts、Keep Originals、Preview、OK，得到两个不同对象/颜色|当前连通壳拆分可供此类结果使用，UI默认项/全部策略尚未逐项复原|
|`Shortest distance over surface.txt`|在3D对象表面指定多个控制点，显示mm，拖动控制点微调，端点右键上下文菜单|当前按控制点顺序、表面投影后边图Dijkstra；明确不是已证实的连续精确测地线|

## 新读到的 Native 实现证据

本轮在IDA headless只读打开案件副本 `evidence/reconstruction/MatStlOperations.dll`；会话 `e97a2d4a` 在关键读取完成后 `save:true` 关闭，已释放槽位给其他模块。地址均为基址`0x180000000`的首选VA。

### PlaneCut（B2）

`MStlBaseOperatorPlaneCut::Operate` **0x180316770** 的完整反编译确认：

1. 依据内部开关复制输入或操作工作容器，并检查进度取消。
2. 构造 `MNewSlicer`；`0x180316b86` 复制plane；`0x180316b93/bb0/bcd` 分别装入 `StatusPlaneSlice`、`DistancePlaneSlice`、`CalculatePlaneSlicePoint`。
3. `0x180316c21` 调用slicer，随后 `0x180316cbd` `_FilterCutBorderCheckingFlips`。
4. 按需 `SplitBorderInBelowAndAbove`；`0x180316d07/d16` 分别 `_AddTrianglesTo` 两个输出，`0x180316d1e` `_FillCutSurfaces`。
5. 更新各Surface borders，并以内部状态字段是否为0返回结果。不是仅按面重心丢弃整片三角面。

`_FillCutSurfaces` **0x1803172d0**：

- `0x18031730e` 检查FillSection开关；遍历每条边界的闭合标记；不全闭合时 `0x180317348` 置错误状态1。
- `0x18031735c..391` 构造 `MStlBorderFiller`、设置输入border并调用Holefiller。
- 输出A采用filler顶点 `0,2,1`（`0x1803173da/400/426`），输出B采用 `0,1,2`（`0x1803174ba/4e0/506`）。反向封面次序有直接依据。
- 还有选中三角形/多个border集合的分支；本轮没有把底层filler全部三角化数学恢复成同源代码。

符号表的 `SetPlane` **0x1801793e0**、`SetOutputStl` **0x1801793f0**、`SetCutInputStl` **0x180179400**、`SetFillSection` **0x180179410**、`SetMaxDistanceOnCutBorder` **0x180179430** 与上述执行链相互印证；不据此推断所有GUI字段已经一一追通。

### 路径（B2），GraphOperations（B1）

`MStlWrapperOperatorShortestPath_Dijkstra<StlImpl>::Operate` **0x18038c3c0** 已读到实质算法：

- 初始化距离为DBL_MAX、源点距离0，保留前驱指针。
- `0x18038c64b` 对相邻点整型坐标差平方和开方得到**欧氏边长**。
- `0x18038c658..69e` 计算新距离、比较已有距离和最大距离、记录距离与前驱。
- `0x18038c6e7..7ce` decrease-key与二叉堆上浮；`0x18038c950..985` 弹出堆顶并恢复堆。

因此库中“基于相邻网格点欧氏边长的Dijkstra”是实际读过的分支，不仅是从导出名猜测。不过未证明Measure Distance Over the Surface主UI一定只调用这个分支，也未恢复控制点投影/沿面优化的完整上层路径。

`TStlBaseOperatorShortestPath<MStlEdgeFilterUseAllEdges>::Operate` **0x180385d80** 是另一层容器初始化与反复 `_FindShortestPathTop` **0x1803858a0** 的路径；没有把这个wrapper当作连续测地线求解器。

`evidence/triage/MatStlGraphOperations.dll.symbols.tsv` 及JSON表明该DLL含 `semgl::GraphBaseInterface`、`CycleGraph`、`Path/ClosedPath`、CycleComplex及观察者等图结构。示例 `GraphBaseInterface::RemoveEdge` **0x180018cf0**、`CycleGraph::RemoveCyclesAroundVertex` **0x1800698b0**、`Path::reverse` **0x18001a800**。记录SHA256为 `de3f2ba9d1e1fb5179a690d144262f3ef68211037683ca50885fa8ed4dd716d8`。本轮没有把这些通用图容器直接等同于UI最短测地线路径；有算法实读证据的是上面MatStlOperations的Dijkstra分支。

### Split 与修复证据边界

`MStlBaseOperatorSplitBase::Operate` **0x1803378a0** 实际是多个导出同地址的**trivial return 1**，IDA显示 `_InRegion` 等别名。不能把这个符号名字当作完整连通拆分算法。

真实 `MStlOperatorSplitSurfaces::Operate` **0x1803026a0** 先清结果容器、初始化再遍历输入Surface，并在 `0x180302707` 调用 `_SplitSurface` **0x180301a10**；本轮未把后者完整恢复到每个UI拆分选项。代码里的edge-connected shell split是明确独立实现。

`MStlBaseMultiOperatorZipperStitch::Operate` **0x18031e870** 实际按对象建立/更新locator（`0x18031e8ab`），随后以0.9与0.25对应的blend参数多次执行 `_TrimBlendBorderToBorderStretch`、`_TrimBlendBorderToBorderShrink` 与 `_TrimBorderShrink`。所以近点weld不能称为“原厂完整Zipper Stitch”；当前实现有意只承诺**容差边界顶点缝合**。

`MStlBaseOperatorFixNormals::Operate` **0x18044cea0** 再次确认edge、shell raycast、supershell raycast、shell positive-volume等位选路径；标记后可仅统计或真正Invert，最终UpdateMembers。现独立实现局部邻接定向和闭壳嵌套/有向体积，不模拟全部raycast参数与状态枚举。

## API 与实际算法

所有几何位置使用输入 `TriangleMesh` 的物理mm空间；所有函数不修改来源。支持 `cancelled()`（抛出取消错误）和可选progress，长边遍历/BFS/切面三角化/路径搜索设有检查；主UI也可terminate worker取消同步计算。

```ts
cutMeshByPlane(mesh, {origin,normal}, {cap:true,epsilon?,...control})
  // -> {positive,negative,contours,openContours,capped,intersects}
splitConnectedComponents(mesh, {connectivity:'edge'|'vertex',...control})
  // -> TriangleMesh[]，按三角形数降序
surfacePath(mesh, viaPoints, {maxProjectionDistance?,...control})
  // -> {points,length,projectedPoints,projectionDistances,
  //     method:'edge-graph',approximate:true,chordLowerBound}
mergeMeshes(meshes,{weldTolerance?,...control}) // -> TriangleMesh
stitchMesh(mesh,{tolerance:1e-6,boundaryOnly:true,orient:true,...control})
fixMeshNormals(mesh,{outward:true,preserveCavities:true,...control})
diagnoseMesh(mesh,control?)
```

### Plane cut

归一化法向，按signed distance对每个三角形做真正半空间多边形裁切，截到四边形时再三角化。原顶点和原边交点都有共享key，避免相邻面切点不一致；Float32最终写入前验证，不把产生退化面静默删除。近面顶点按epsilon投影，默认 `max(1e-8, diagonal*1e-8)`mm。完全共面的原三角形按其法向归入单侧，避免相切时复制出零体积实体。

从两侧真实新边界提取位于plane的contour，支持多个独立闭环。封面建立局部正交二维基，识别嵌套深度，偶数深度实体外环与奇数深度孔环可见桥接，再约束ear clipping；所有原边界点保留，避免省略共线中间点后出现T-junction。两侧封面法向相反。填面后重新检查closed、边/点非流形、方向冲突和退化；失败显式抛错，不提交半成品。

`contours`闭环末点重复首点，`openContours`为开放链。`capped`只在确实添加封面时为true；完全空切/相切会有一侧原体、一侧空网格，contours空、capped false。可 `cap:false` 对开放表面真实裁切并保留开放边界。当前cap要求闭合、方向一致输入；分叉/自交/不稳定孔桥接会失败，不推断任意开放模型的内部。

### Split、merge、stitch、normal fix、diagnostics

Split默认以共享**边索引**连通；两个壳仅共用一个点时仍分开；可显式vertex连接。没有隐式合并坐标相同而索引独立的点。高价顶点/非流形边的邻接采用star连接而不是全对全clique，连通结果等价，避免不必要二次开销。

Merge是数组级实体集合合并，不是实体Boolean union，不消除重叠体积。可显式调用容差stitch：默认只处理开放边界点，空间hash邻格搜索，选择在容差内的原点作为代表，避免逐次均值造成累计漂移；0容差为精确同点weld。若会制造退化、重复面、非流形点/边则拒绝，不以删面让诊断“看起来闭合”。默认随后统一法向，来源仍不变。

法线修正通过共享边BFS布尔约束一致化；不可定向/非流形/退化输入拒绝。对闭合壳，根据与其他壳的包含深度保留外壳向外、内腔壁向内；可显式 `preserveCavities:false` 让每壳正体积。开放壳只统一相邻面次序，不假定全局内外。壳接触或零有向体积会拒绝；尚未完整检测壳体之间相交，嵌套分类假定它们互不穿插。

Diagnostics保留面积/有向体积/边界/非流形/Euler等，并提取boundaryLoops、openBoundaryChains、branchBoundaryVertices；`selfIntersections:'not-checked'`明确说明未做完整三角自交检测。边界闭环是拓扑边界诊断，不证明每个孔都该填，也不自动恢复解剖真实表面。当前没有完整RBF/扩散补洞、去重叠体、重网格或“全自动修复”承诺。

### Surface path

每个控制点对所有有效三角形执行七Voronoi区域最近点投影，保留面号和投影距离，超出允许距离失败。投影点连到所在三角形三个顶点，两个控制点位于同一三角面时可直接连线，再对相邻via点依次执行欧氏边长Dijkstra（最小堆）。返回路径由三角形内部连接段和实际网格边构成，能在曲面上显示并满足途经点顺序；不同连通壳无法生成路线，会失败。

这是一种**边图近似**，不是连续面内精确测地线。粗网格即便整体共面，跨三角面的最短直线也可能比边图短很多；测试专门保留这一差异，防止以后误标“原版精确最短”。`chordLowerBound`只是各投影via之间空间直线距离之和，不是误差上限；没有普适固定误差百分比。细化/更均匀三角网格一般可改善近似，但不能因此保证一定收敛速度或各向同性。

## 实测与验证

`node --experimental-strip-types --test tests/mimics-mesh-tools.test.ts`：13项通过。覆盖真实三角裁切、截面共线点共享、18组斜切/过原顶点边、空切/相切、两个断开轮廓、单孔/双孔与三层嵌套岛的封面、凹L形截面、开放输入与失败、来源不变、edge/vertex split、面内投影/途经点/断壳路径、球面边图近似、随机反面修正、内腔嵌套、triangle soup缝合、危险容差/重复面拒绝与洞诊断。

对已有96×96×64、1×1×1.5mm合成影像HU≥226骨壳（66816三角形）实测：

|操作|结果|本机单次时间量级|
|---|---|---|
|x=48平面切割|contour点数229/213，两侧各33848面，均Euler2闭合，体积各24644.25mm³|约376ms|
|z=48平面切割|contour点数261/241，两侧各33908面，闭合、方向/退化全0|约326ms|
|normal=(1,.31,.27)斜切|contour点数506/458，两侧各35328面，闭合，体积和误差约8.3e−6mm³|约373ms|
|表面端点(84,48,48)→(48,78,48)|边图路径66点、54.16295mm；空间chord下界46.15734mm|约111ms|

上述时间是本机Node数学层量级，不是浏览器GPU/交互帧率或厂商原运行差分。完整“Polyplane/Curve/Orthogonal Cut”UI、连续测地线、完整zipper/补洞/自交修复仍有清晰缺口，完美标准尚未达成。
