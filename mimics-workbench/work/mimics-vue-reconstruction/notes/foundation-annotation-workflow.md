# 文字注释的完整控制器接入

## 根最终整合

pending新注释源Part删除的watch/Apply guard已补齐。根实际联跑本文件8项、区域10项和属性模块10项，**28/28通过**，见`../evidence/annotation-region-current.tap`；随后完整项目**359/359及生产构建通过**。本文件下文7/8是补丁前记录，不再表示现存失败。

根还完成了真实浏览器二维/三维Properties创建/取消/Apply、二维文字双击编辑、完整文本title、样式/复制/隐藏、距离和三维锚点拖动/Undo，以及新页IndexedDB恢复文字/样式/隐藏状态，详`foundation-browser-region-annotations-2026-11-05.md`。模式互斥和rotation范围已由viewport修复并通过SFC回归；所有取消组合、全部枚举/字体和原版数值对照仍未认证。

2026-11-05。新增 `tests/mimics-annotation-workflow.test.ts`，使用实际useWorkbench、OperationClient和Node worker_threads中的operations.worker。只检查控制器状态和文件字节，不操作浏览器，不认证字体/视觉布局或原版Properties完整参数。

## 接入契约与已检查路径

- 2D annotation点选通过完整mm affine建立world anchor与plane，先打开measurementEditor创建草稿，尚不写state/history/dirty；Cancel无提交，Apply只新增一条事务，Undo/Redo对应一个对象。
- 3D annotation只接受仍存在、可见、opacity>0且位置为有限3-vector的Part拾取；同样延迟到Properties Apply。模型通过实际worker从小Mask生成，注释操作不得改源Mask、Part网格或sourceMaskId/sourceRevision。
- workbench实例实际调用Properties编辑、Duplicate、Hide/Show，并经worker工程导出→ZIP回读→openFiles恢复样式、文字、锚点和选择引用。 optional缺失字段与undefined按序列化语义比较，不把解码器补undefined误判成数据损坏。
- cancel、安装新doc、busy任务开始和已编辑measurement被删除时，旧Properties草稿不能复活对象或留下无效selectedMeasurementId。
- 已提交注释的Part删除后，既有政策保留partId历史来源与world points，仍可编辑/保存；这不是非法悬空选择。**新建中的**3D注释若来源Part删除，本轮新增应用安全约定为取消creation，避免产生全新的orphan。

## 合成夹具

4×4×3，完整affine为`[[0,-3,0,10],[2,0,0,-20],[0,0,4,30]]`。voxel `[1,2,1]`的world anchor直接手算为`[4,-18,34]`，不调用被测坐标函数生成期望。两个独立Mask含4体素小块及1体素重叠；3D Part实际经calculate3d Worker生成，取其已有有限顶点作为受控picker输入。

## 执行记录（含补丁前历史）

首轮新增7项为6过1失败；失败仅因ZIP恢复optional partId补undefined的字段存在性比较，已改成正确序列化语义比较，不作为app缺陷。

确认pending新3D注释的Part删除策略后增加第8项。补丁前记录 **8项7过1失败**，见 `../evidence/annotation-workflow-baseline.tap` 与当时的`annotation-workflow-current.tap`。唯一失败是Properties模块当时未在new creation来源Part删除时取消draft；现已补livePart watch/Apply guard，旧已提交orphan政策不改变。根已按顶部记录重跑通过。

## 只读集成结论

普通region的source快照、Target预检、generation/revision/参数指纹检查、source/target同一次提交、新Mask不抢active以及whole-operation no-op路径未发现新的半提交问题。

partPick的live/visible/opacity/有限vector guard已通过控制器非法输入案例，不改变state、selectedPart或point，也不开Properties草稿。2D/3D deferred、真实Worker Part来源保留、Cancel/Apply/Undo、编辑/duplicate/hide/ZIP、新doc和busy失效路径均已通过当前专项。

另观察到Properties dialog对rotation只做finite检查而module限定[-360,360]，无效361会由controller拒绝但modal本地error可能不可见；已告知root，由viewport代理统一收口，未重复修改其文件。

剩余浏览器边界：Properties真实焦点/输入/Apply/Cancel、标签拾取与双击、遮挡和Part surface picker、字体/箭头/旋转显示。这里的受控命中和ZIP字节不能替代这些UI证据。
