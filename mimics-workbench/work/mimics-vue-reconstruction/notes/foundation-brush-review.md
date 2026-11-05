# 宽高笔刷与修饰键只读审核

2026-11-05。**最终只读复核：先前四项问题已在continuous sweep实现中修正，未发现新的阻塞性正确性问题。** 本文件下半保留初审缺陷快照，不能理解为当前仍未修复。未修改代理源码、未操作浏览器、未执行大面积刷写重循环。

## continuous sweep最终复核

| 初审问题 | 当前源码修正 | 本审查确认的证据与边界 |
| --- | --- | --- |
| 每采样重复扫大footprint | 生产路径改为brushSweepFootprint连续扫掠；controller按本笔二维covered去重、coveredRows满行跳过、满平面早退；候选扫描在进入循环前累计32Mi上限，异常丢整笔draft | 已读控制流与原子取消路径；wide-brush source-read计数测试存在。本审查没有运行大循环或给浏览器耗时保证 |
| 无关法向spacing触发密集采样 | 生产画笔不再用dense interpolate；compatibility helper增加plane axis/运动分量尺度 | 1mm平面移动、法向1e-5的独立小案例返回2个compatibility样本；无旧误拒绝 |
| coalesced曲线被拉直 | 按提供顺序消费每个聚合点并补终点；连续性中断last=null，下次startSegment=true，不跨图外空白连线 | 已读事件分流与四参数@stroke接线；新测试有手写U形三边10体素oracle，不由sweep生成期望 |
| chord后松主键仍绘制 | move检查primary button，异常secondary-release/聚合样本primary-loss取消；正常pointerup buttons=0单独允许补末点和完成 | 已读guard次序和新增buttons分支测试；没有用缺少buttons的旧stub冒称真实按键验证 |

数学复核：椭圆先把物理ellipse归一为单位圆，使用点到segment最近点；矩形通过两个坐标slab的t区间交判断是否存在覆盖时刻。两者符合固定宽高brush沿直段平移的连续并集，shear通过同一metric进入。covered仅在实际命中后标记，且本笔operation/阈值冻结，因此重复命中跳过不会改变结果；startSegment只切断连线，不抹除同笔已覆盖区域。

本审查实际运行了五个极小、独立预期值的案例并全部通过：单位圆横扫capsule的17个体素、矩形横扫的21个体素、已知shear下手列9个ellipse扫掠体素、shear矩形的解析区间，以及tiny-normal平面例。没有调用被测核生成oracle，没有改源码或运行旧大loop。

root报告最终全量`320/320`及build通过，并有独立Python oracle与文件三件套核验；这些属于root执行证据，本审查未重复整套测试。读取的新SFC/controller测试也有手写轨迹和来源读取计数，不能再将初审四项列为现存缺陷。

32Mi约束的是候选体素检查，外加每段包围行元数据遍历和输入点处理，并非严格壁钟/帧时保证。宽高物理基、continuous sweep、resize倍率/最小值和中途modifier冻结仍是本实现的独立约定；真实canvas、触控/鼠标capture及原版数值一致性未由本次只读审查认证。

## 初审快照（下列四问题已修正）

原帮助：`work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Edit Masks.htm:46`支持独立Width/Height、Same Width and Height以及Ctrl+左键移动调整尺寸；`:100`支持Shift+左键1-click navigation。帮助没有给毫米正交基下的宽高定义、resize位移倍率、最小值、键盘同时按下的优先级或中途切modifier的细节；本实现选择的这些行为属于明确的独立交互约定。

## 可确认合理的部分

- `viewportGeometry.brushFootprint`在切片正交物理基使用`X=uLength*Δa+shear*Δb`、`Y=vHeight*Δb`。椭圆判断`(X/rx)^2+(Y/ry)^2≤1`，矩形为`|X|≤rx,|Y|≤ry`；其逆变换包围范围du/dv正确包含剪切交叉项。它定义的是物理正交椭圆/矩形，不是剪切IJK轴上的平行四边形，UI标题对此已有说明。
- 光标绘制用同一物理scale下的屏幕椭圆/矩形，宽高方向和上述基一致。没有发现本次宽高改造重新退回仅spacing对角度量。
- BrushTransaction冻结width/height/shape、目标、volume、revision、plane及阈值；尺寸、同宽高或shape修改取消未提交草稿。`setBrushSize`先验证整个pair，invalid pair保留旧配置、取消草稿；相同有效pair不额外取消。
- diameter明确作为width别名：linked时宽高一起更新，unlinked时只改变width。这符合当前兼容约定，不应再把unlinked的diameter标签解释成圆的唯一尺寸。
- resize只修改局部preview，pointerup一次emit，再由setBrushSize更新；pointercancel/lostcapture/Escape/目标/工具/plane改变不提交尺寸或笔画。当前helper已经补上输出finite检查，早先读取时看到的潜在Infinity问题已被代理实时修复，**不作为现存缺陷**。
- Shift在pointerdown时先于Ctrl resize、测量命中和绘制，Ctrl+Shift选择一次定位；Ctrl+wheel仍缩放。这些分支有实际SFC handler测试，但不是浏览器验收。

## 实际问题与小样例

### 1. 采样上限没有约束体素工作量

`src/mimics/viewportGeometry.ts:75–83`只限制每段最多65536个采样点；`src/mimics/useWorkbench.ts:296–303`对每个采样同步遍历整个裁剪footprint包围框。

明确有效案例：1024×1024×1、spacing=[1,1,1]、矩形width=height=3000mm，从(0,0,0)拖到(1023,1023,0)。纯helper实际返回**2894个采样点**，远低于65536；每个样本的3000mm矩形却包含整个平面，共约**3,034,578,944次体素检查**，并同步发生在pointer handler中。没有执行这30亿次循环，不给虚构耗时。

最小修正：除samples外，增加每段/笔画累计的裁剪candidate-voxel工作预算，在进入循环前估计并拒绝，或实现能避免重复整平面扫描的sweep/scanline。超过预算应取消本次draft、保留已提交Mask并提示；仅限制数组分配数量不足以保证交互可响应。

建议独立测试：合法大刷跨平面应在耗费巨大循环前明确失败/分块处理，取消后Mask/history不变；不要实际跑十亿级工作来作回归，也不要只重复断言常数65536。

### 2. 平面采样被无关法向spacing拖累

`interpolateBrushStroke`用`min(...geometry.physicalVoxelSize)/2`，包含当前切片法向轴；调用处没有传plane axis。

轻量实际复现：grid dims=[8,8,2]、spacing=[1,1,1e-5]，在轴2的XY面用6mm笔刷，从(0,0,0)移到(1,0,0)。物理平面仅移动1mm，但因法向Z的1e-5mm，步长变成5e-6mm，需要200000采样而抛65536上限。这一平面内运动本不依赖Z分辨率，且增大刷子也不能消除该spacing限制。

最小修正：让helper接收已冻结plane axis（viewport已有gesture.axis），采用该物理切片平面的采样尺度，而非三维最小边长。具体采样策略需说明对剪切的约定。测试应改变法向spacing而保持同一平面/相同笔画，确认不会无故改变采样行为。

### 3. 画笔忽略聚合事件的曲线路径

`src/mimics/ImageViewport.vue:80`仅Lasso消费`getCoalescedEvents()`；brush分支`:81`只插值last→当前event终点。

小样例：1mm刷子，last=(1,1)，同一pointermove中的聚合路径为(1,4)→(4,4)，最终点(4,1)。真实轨迹为U形三边，当前却刷底部直线(1,1)→(4,1)，漏掉曲线并写入未经过的位置。现有直线间距和末点测试不会发现此问题。

最小修正：依次消费同pointer的coalesced点并补最终点，每段按物理尺度插值，共享总工作预算；不能给每个子段重置预算。建议手写U形所经过体素集合做oracle，不调用同一个插值helper来生成期望路径。

### 4. 鼠标按键chording可能在主键已松开后继续绘制

ImageViewport不读取`event.buttons`。Pointer Events中：左键开始→再按右键（buttons=3）→松开左键但保持右键（buttons=2）时，通常不会产生最终pointerup，而是pointermove更新buttons；当前gesture仍为brush，后续move继续绘制，最后右键松开才end/commit。

最小修正：brush/resize处理pointermove时核对主键仍按下，缺失则取消；pointerup补最后位置的既有行为应独立保留，不能因该事件buttons=0就误取消正常结束。现有pointer stub无buttons字段，需要有意识补真实按钮状态案例。右/中键pan的按钮检查应按其起始button单独处理。

## 测试证据质量

`tests/mimics-viewport.test.ts`并非全部镜像实现：sheared椭圆/矩形有**手写9/13个体素offset集合**，并实际接通SFC handler与controller；物理点/屏幕坐标也有已知数字案例。这些是有价值的独立行为证据。相关预期可由`X=2i+j,Y=3j`的手算关系复核，不由被测brushFootprint生成。

部分helper测试直接断言du公式、resize倍率与常数65536，属于实现约定回归；不能单独证明原版交互或工作量安全。当前缺少上述正常宽刷总工作量、无关法向spacing、coalesced曲线路径和真实buttons状态边界。

另一个尚未定义的交互边界：Ctrl或Shift在**已开始**的brush gesture中途按下时，代码继续按pointerdown捕获的gesture绘制。帮助没有明确中途切换的语义，不能据此断言原版不符；建议明确选择冻结、取消或转换，并添加不产生意外Mask修改的测试。现有Ctrl/Shift测试仅覆盖按键在pointerdown前已按下。

本审查没有重新运行整套viewport测试，也没有操作浏览器；代理仍在补测试。以上问题需由负责实现的代理在最终源码上复核/纠正，再由root完成集成与实际交互验收。
