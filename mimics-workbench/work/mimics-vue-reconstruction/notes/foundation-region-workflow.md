# 普通 Region Growing：帮助契约与控制器回归

2026-11-05。只读对照原帮助和应用，新增 `tests/mimics-region-workflow.test.ts`；共享controller/UI由root修改，本审查不操作浏览器。

## 原帮助直接支持

- `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Region Growing1.txt:5,8`：Source是原Mask；Target可以是new或existing，existing时把选中区域加入该对象。
- 同文件 `:11–24` Multiple layer：Off只做一个slice，On在全部slice上做3D。6-connectivity只看共享面的六邻接，26看面/边/角的全部三维邻域。单层中对应只保留所选plane的邻域，不应固定为轴向。
- 同文件 `:28` 点击：设置参数后，在Source当前分割成员上用十字左键点击，即计算该Source中与种子连接的成员，并移动至Target；不是另外一个Preview/Apply步骤。
- 同文件 `:30` double arrow：当Source和Target都是现有Mask时可交换。
- 同文件 `:32` Leave Original：勾选copy/paste，保留Source；未勾选cut/paste，从Source移除并放进Target。
- `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Region growing2.txt:7,9,11`：先选Source Green、Target New Mask，再点击原分割内部，结果成为Yellow；之后Close。该案例明确说要激活新Mask需另选Yellow，所以不能根据addMask helper的默认行为自动激活结果Mask。

## 当前基础贴合契约

Source、Target和活动可视化Mask应是独立的状态。进入region工具时默认Source=current active、Target=new；Source控件修改不强制修改active；用户在对象列表改变active，也不悄悄改变已经指定的Source。新建目标成功后保留原selectedMaskId。

本轮采用的保守应用约定：Target选择new时，每次非空点击创建一个独立新Mask，并保持选择项new；重复累加需要用户明确选择已有Target。帮助没有逐字规定新建后的选择项生命周期，故不能把本约定写成原生内部状态恢复。

两个existing且不同的Source/Target允许Swap，交换控件值但不改Mask成员、active或history。Source=Target作为当前应用的无效配置明确拒绝，帮助本身没有详细定义这个退化输入。

Leave Original=false的Source删除和Target并入必须作为同一事务发布。是否no-op应比较**整个操作**：即使Target早已包含所选区域，只要Source仍需删除，就必须提交真实cut事务；重复copy且Source/Target都不改变则不建历史。背景种子/空结果不创建空Target和Undo。这些失败、原子性和历史策略是本应用明确安全契约，帮助不提供精确Undo粒度。

运行时捕获Source、Target、Source/Target版本与volume/revision及connectivity、multiple、leaveOriginal；任何相关修改/取消都丢弃旧结果，不能先改Source再等待Target。换文档清理旧ID，删除Source/Target后明确选择有效回退或new，不能保留悬空引用。tool非region的legacy runMask(region)在独立Source缺失时仍兼容active Source。

## 独立合成案例

7×6×3小体数据，所有影像强度均100，因此只按强度生长会误填整个126体素；普通region必须遵守显式Source成员。

- Face component：`(1,1,0),(2,1,0),(1,1,1)`，6连接为3体素。
- Diagonal pair：`(3,2,0),(3,2,1)`，只通过边/角与Face component相接；26连接从同种子应为5体素，6连接仍为3。
- Remote component：`(5,4,0),(5,4,1)`，与上述均分离，为2体素。
- Existing Target包含一个重叠成员`(1,1,0)`和远端marker`(0,5,2)`。Face component并入后Target恰为4成员，Source保留7或剪切后保留4。
- Single plane：轴2/z0的6连接为2、26连接为3；轴0/x1的6连接为2；轴1/y1的6连接为3。

预期由上述坐标集合直接构造，没有调用regionGrow或复制其遍历逻辑作oracle。测试使用实际Vue controller、OperationClient和operations.worker经Node worker_threads structured clone。

## 执行记录与边界

当前实现已由root联跑region10、measurement properties9、foundation26、ordinary10和state5，**60/60通过**，日志 `../evidence/region-properties-current.tap`。本审查读取该日志确认计数与region各项通过，没有重复执行该60项。

专项初次落盘时root尚未添加regionSource公开API，10项在访问未提供API时失败；旧初始化记录另存 `../evidence/region-workflow-preimplementation.tap`，不代表当前失败，也不代表发现10个算法错误。

10项覆盖独立Source/Target/active与Swap、稳定new选择、existing累加/重复copy无变化、cut只改变Source也需提交、背景/无效目标、6/26和三轴单层、5种在途参数变化、取消立即重跑、删除/换文档以及legacy直接调用。

本专项不执行真实鼠标十字点击、Source/Target控件、Swap或Close对话框，不认证原Mimics完整交互/数值内核。取消、Source=Target、no-op及Target New生命周期中的独立约定均已与帮助直接证据分开。
