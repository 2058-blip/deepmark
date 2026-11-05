# Native 几何深挖：局部插值、体积多项式与性能

本轮仅阅读案件已有反编译、原字节和DLL副本；不运行原软件/DLL/许可逻辑。新增 Capstone 复核使用既有 `C:\Users\wwulli\Tools\reverse-skill-python\Scripts\python.exe`、pefile/capstone，只读 `work/mimics-17-analysis/evidence/reconstruction/MatStlMarchingCubes.dll` 和 `MatStlOperations.dll`。未改历史原始证据。

## 1. 修正了什么认知

历史 `MC-0x1800013c0.c` 有 “local variable allocation has failed” 警告，参数出现double、int和`__m128`混杂。本轮按 Win64 调用现场和SSE单精度指令恢复了叶函数的数学参数，而没有照抄该伪C原型。`MC-0x180002880.c` 也存在负地址被反编译为无符号除法的伪表达式，独立原字节确认它实际是普通减地址读取，不是整数除法算法。

以下“已确认”指本条内核分支的静态实现，不意味着受保护的Mimics主UI调用映射全部已追通。

## 2. mode=1 的精确分段数学设计

近似源码原型（源码化命名由本轮赋予）：

```c
float interpolate(CubeInterpolUshort* c,
                  float value0, float value1,
                  float position0, float position1,
                  float lower, float upper, float scale);
```

调用现场 `0x18000255b/561` 从分段位置表读取 `position0/1`，`0x18000256d..580` 将两个USHORT样本转换到 `xmm1/xmm2`，`0x180002583` 调用本函数；`position0` 在 `xmm3`，后续参数来自栈。叶函数 `0x1800013dd..3e9` 正好保存 `p0`、形成 `Δ=p1−p0` 并保存 `v0,v1`。这解决了反编译错原型问题。

定义：

```
T = ushort(c + 0x10)
R = upper − lower
d0 = min(value0 − lower, upper − value0)
d1 = min(value1 − lower, upper − value1)
s = value1 > value0 ? +1 : −1
Δ = position1 − position0
```

mode0 是普通线性公式 `p0 + (T−v0)Δ/(v1−v0)`，并在叶函数限 `[0,1]`。mode1：

1. `R < FLT_EPSILON` → `0.5`。
2. `d0 >= d1`、`d0/R >= 0.1` 且 `d1/R <= 0.1` → `p0 + s*(T−v0)*Δ/(R*scale)`。
3. `d0 < d1`、`d1/R >= 0.1` 且 `d0/R <= 0.1` → `p1 + s*(T−v1)*Δ/(R*scale)`。
4. 其余 → 普通线性公式。

指令锚点：`0x180001430/46d` 得到d0/d1；`0x18000145f/474` 范围判定；`0x18000149a..4ae` 第一组0.1比较；`0x1800014b7` 将R乘scale；`0x1800014c6..4d2` / `4f3..4ff` 是第一端两方向；`0x180001516..526` 第二组判定；`0x180001570..57c` / `59e..5aa` 是第二端两方向；`0x180001528..543` 退回线性。

原字节浮点常数复核：

|RVA|float32|
|---|---|
|`0x1515f0`|`1.1920928955078125e-7`（FLT_EPSILON）|
|`0x1513b8`|`0.5`|
|`0x1515ec`|`0.10000000149011612`|
|`0x1515e8`|`1.0`|
|`0x1c7700` / `0x1c7704`|`0.001000000047...` / `0.999000012875...`|

最后一组钳位发生在方向caller，mode1叶函数自己并没有始终限 `[0,1]`；当前 `nativeLocalInterpolation` 导出函数把caller的最终edge clamp一并封装。因此直接调用该导出API与只调用原叶函数并非同一个返回契约。

XY caller在 `0x180002535/53d` 传 `scale=1`。Z caller在 `0x180002805/80a` 读取 `c+0x68` 传入；`MC-0x1800021e0.c` 在 `0x18000223c` 将其设为一个整数构造参数+1，而该参数来自MC对象+12 / `SetThresholdParameters` 最后一个整型字段。该字段的完整GUI语义没有验证，不能把它直接叫“Z matrix reduction UI值”。新实现将其作为显式 `nativeZScale`，默认1，保留未知映射。

## 3. 5×5 邻域与粗边采样

`sub_180002880` 读取同一原始图像平面25点：两个图像stride各在±0/1/2组合，完整5×5；跟踪最大/第二大、最小/第二小。最终 `0x180002e77..e8d`：第二小等于第二大时回退真正min/max，否则输出第二小/第二大。它是“剔除单个极端值的局部范围”，不是均值/高斯滤波，也不是全体CT直方图。

有问题的伪表达式 `a4[v31 / 0xfffffffffffffffe]`，对应原指令是 `0x180002bb5 mov rax,r11; 0x180002bb8 sub rax,r9; 0x180002bbb movzx eax,[rax]`，即负方向取样。不能把该伪C当作可编译算法。

XY粗边函数 `0x180002400/25c0`：采集原边 `s+1` 个样本；若起点在T内，就在所有“内→外”跨段中选择下降幅度最大者；起点在外，则选“外→内”上升幅度最大者。相等幅度保留首次（严格大于比较）。`MC-0x1800021e0.c` 的位置表为 `j/s`，最后一个位置被强制精确设1。Z函数直接在两张图之间插值，并组合两个平面的局部范围，不等同于XY的原边遍历。

已提升内核：`linear` 和 `native-local` 在XY step>1时使用上述同方向最大变化跨段；`native-local` 使用25点范围和分段式；Z接受显式scale。测试以 `[-10,10,-100,100,200]`、T0、step3验证选择j2的强跨段：linear返回x2.5；local分支受范围[-100,200]校正为x8/3。

仍不声称逐位一致：原函数USHORT编码和上层 `_MakeImage` 的转换、工作图边界扩展、内部枚举/GUI文本、不同重建入口、SSE每步float32舍入及原Z字段UI映射尚未全部复原。当前TS内部大多double、输出Float32，且会显式验证有限值/尺寸，原字段与float32异常行为没有逐位仿真。

## 4. `_CalculateMu` 已能解释的体积多项式

`OPS-0x180404200.c` 的 `0x1804042ea..37a` 取得每个三角形a/b/c；`0x1804043c5..448` 从 `MDataMask<MStlPoint,MMPoint3d<long>*>` 取得各点位移d。随后 `0x1804044ee / 633 / 6f1 / 713` 累加4个系数，`0x180404768` 各除6，`0x180404783` 对常数项减目标体积 `this+136`。这正是：

```
P(μ) = V(p + μd) − Vtarget = c0 + c1 μ + c2 μ² + c3 μ³
c0 = Σ det(a,b,c)/6 − Vtarget
c1 = Σ [det(da,b,c)+det(a,db,c)+det(a,b,dc)]/6
c2 = Σ [det(da,db,c)+det(da,b,dc)+det(a,db,dc)]/6
c3 = Σ det(da,db,dc)/6
```

`0x1804047af..7e0` 去除近零高次项；`0x18040480a` 调用根求解辅助；`0x18040488a..8b6` 过滤接近实数、`[-1,0]` 范围候选并保留最大的μ。无此根则由 `0x180404940..960` 形成导数系数，再求导数根，同时加入区间边界；`0x180404d63..e2d` 直接Horner评价候选体积，选最接近target者。`0x180404e43..e59` 复核了约−0.95条件及 `−this.factor` 备选保护，不能把该条件描述为所有μ无条件clamp到−0.95。

Operate的两个真实调用由原指令确认：`0x180402920` 首遍系数读 `this+32`，第二遍 `0x1804029b2` 读 `this+40`。`_DoGaussianStep` 在系数为0时调用CalculateMu（`0x180403408/412`）；因此不能说所有第二遍一定都是0或所有UI一定选择自适应μ。当前独立重构的补偿开关明确选择自适应μ模式。

实现提升：默认 `compensateShrinkage` 先Jacobi正向平滑，再重新计算邻域Laplacian，构造上述三次多项式；对导数分出的单调区间二分求实根，选最大 `[-1,0]` 根，找不到则评价极值/边界/−factor及−0.95保护。显式 `compensationMethod:'global-scale'` 保留简单等比体积恢复。测试证明二者几何结果不同，而球体均在约1e−8相对体积误差内。

尚未恢复：原复杂根求解器本体的所有数值细节、MInternalUnits整数位移/取整、每种邻域/锐边/边界枚举、对选中面/部分点的处理、容器改写策略及UI到参数字段全链。当前同一多项式设计有证据，但不等于普通Smoothing全部行为逐点相同；不能保证局部尺寸、无自交或每个独立壳体各自守恒。

## 5. QEM 性能实测与实际修复

实际输入为 `src/core.ts::makeDemo` 的96×96×64合成体，1×1×1.5mm spacing，Mask为HU≥226骨壳。该数据是**66816三角形、两个闭合壳**，不是仅1–2万面。一次本机Node实测：MC约0.40秒；QEM `targetRatio:.5,tolerance:1,featureAngle:70` 共10轮，约2.40秒，得到33408三角形。测试回归含网格完整诊断总体约2.8秒。时间是本机单次量级，不能视作跨机器性能保证。

算法每轮O(F)建立邻接/法线、O(E log E)对候选排序、局部link/法向检查，以互不相邻ring批量折叠；不是每折叠一边就重扫全部面。最多iterations轮，默认100，达到目标或无可折叠边即停止。极高价点的局部检查会更贵，拓扑Map/Set和字符串边键在几十万面上也会增加内存成本，尚未实现优先队列增量失效更新。

实测发现旧版候选以double最优点通过检查，写到Float32后才共线，骨壳减面产生5退化面。已改为**候选先Math.fround，再执行所有平面/法向/退化检查**。修复后相同数据0边界、0非流形边/点、0方向冲突、0退化，Euler4且两个壳保持。新增大骨壳回归测试防止反复出现。

建议：继续将MC/平滑/减面/Wrap放worker，UI取消通过terminate当前worker而不是等待消息处理中的同步计算响应；更大网格可允许显式采样或分批处理，但应显示分辨率误差。没有必要因66k面的2–3秒延迟改成假减面或删面抽样。

## 6. WebGL world坐标和正向检查

`PartViewport` 的column-major旋转为 `R=Ry(yaw)Rx(pitch)`，列向量正交、det=+1；positive yaw为右手Y旋转，positive pitch为右手X旋转。GPU上传 `mesh.position−sceneCentre`，模型坐标已经是world mm，不再应用第二次affine。正交投影 `clipZ=−viewZ/depth`，camera位于view+Z，较大的viewZ更靠近观察者。

拾取按屏幕NDC先减pan、乘halfHeight/aspect，取view起点 `(vx,vy,+reach)` 和方向 `(0,0,−1)`，再各用 `Rᵀ` 回world，并给起点加sceneCentre。Möller–Trumbore按最小非负t选最近面。因此GPU显示和CPU拾取使用同一旋转/中心/深度约定，Y屏幕朝下已在NDC转换反号。任意affine（包括反射）只改变已提取world几何，viewer自身不会额外反转左右。

这是代码和矩阵恒等式检查；未据此宣称所有浏览器/显卡实机拾取已验证。透明面仍是对象重心排序普通alpha，复杂相交壳不具order-independent透明。后续已为真实控制点拖拽新增静态median BVH：66,816面建树本机约164ms，1000条射线约10.5ms，替代每次鼠标移动全扫三角形。新增SVG测量/注释覆盖层复用同一投影；child临时拖拽、pointerup单次提交、Escape/pointercancel零提交，浏览器仍等待主任务origin审批，未绕过，也未拿Node射线测试代替UI验证。

## 验证状态

`node --experimental-strip-types --test tests/mimics-geometry.test.ts`：18项全部通过（包括BVH物理射线测试）；`vue-tsc --noEmit`通过。所有算法升级保持既有调用可用；UI仍可继续使用binary Mask默认linear MC，不能因新增native-local叶函数就把整条UI说成原厂Grey/Contour模式已完整重构。
