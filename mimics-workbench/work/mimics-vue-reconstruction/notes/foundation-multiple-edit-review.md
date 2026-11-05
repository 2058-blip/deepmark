# Multiple Slice Edit：帮助契约与控制器验收

2026-11-05。本轮只负责新增 `tests/mimics-multiple-edit.test.ts` 和本说明，不改共享实现、不操作浏览器。

## 原帮助直接支持

以下路径相对于仓库根目录：

- `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Multiple slice edit.htm:20`：创建可编辑temporary mask，其活动体素最后Add/Remove或用于原Mask的局部Threshold；临时修改与最终活动Mask提交属于不同层次。
- 同文件 `:26`：先选Axial/Coronal/Sagittal，除active mask外其他Mask隐藏，临时Mask使用另一颜色。
- 同文件 `:27`：临时和active的相交部分第三种颜色；复制当前临时切片；0表示该方向全部切片。
- 同文件 `:28`：其他层仍可继续修改临时Mask，再复制；最后才作用于原Mask。
- `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/The multiple slice edit interface.htm:33`：Type有square/circle/Lasso/Flood-fill，并允许LiveWire创建临时Mask；Lasso按住左键画、松开结束。
- 同文件 `:62`、`:70`：Select添加temporary mask成员，Deselect从temporary mask删除。
- 同文件 `:78`：Copy to slices方向同时决定在哪个视图编辑与复制。
- 同文件 `:86`、`:87`：0复制全部前/后切片；非0明确要求复制后立即跳到最后目的切片。
- 同文件 `:97`、`:98`：插值沿选择的方向，前一次插值Apply后才能对其他区域继续插值。
- 同文件 `:107`：最终操作为对active mask的Add/Remove/局部Threshold，作用范围是temporary mask活动体素。

普通Edit Masks的Draw/Erase/Threshold直接作用active mask，见 `Edit Masks.htm:20,62,70,78,83`，不应与多片临时Mask混淆；原帮助的3D LiveWire为独立功能，不能作此2D多片流程的数值oracle。

## 本轮明确采用的实现约定

以下是本轮用户授权的独立生命周期/安全约定，不谎称全部来自原帮助：

- multiple/select/deselect共享一个会话；进入时固定当前activeAxis为selectionAxis。setSelectionAxis显式改变方向，保留已完成temporary成员，取消未完成手势；仅悬停/激活别的视图不改变该方向。
- 在Select/Deselect或Type之间切换保留已完成temporary mask；换目标、离开多片或Close清临时状态，不改变真实Mask。type/operation/axis/slice/target变化取消未完成轮廓及在途旧Worker结果。
- displayMasks只显示active mask并临时visible=true，真实Mask.visible和历史不改变。显示相交色仍需要组件/浏览器验收，本控制器测试不能证明颜色。
- 非0复制跳实际裁剪后的最后目的层；0不跳。帮助只明确非0跳层，因此0不跳是本轮明确策略。
- 插值后台只产生interpolationPreview；在Apply/Cancel前禁止再插值、画笔、轮廓、复制和最终活动MaskApply。ApplyInterpolation才替换temporary selection，CancelInterpolation只丢预览。帮助支持前次插值Apply屏障，但未给出本实现的完整安全状态机。
- 空、非法或取消的复制不改selection/point；失败或取消的插值不发布半结果。最终Apply为一个活动Mask事务。未完成temporary编辑不改dirty/history/Mask。
- 局部Threshold使用独立localThreshold.range，不污染或读取当前global threshold参数；三范围的不可变默认与可编辑范围由另一个模块负责，本测试只接其公开choose/update/range接口。

## 合成夹具与预期值

7×6×4、1mm体素的有效NIfTI及两个独立Mask，经真实工程ZIP导入到useWorkbench。默认灰度为`x+10*y+100*z`；LiveWire用常量10的影像与相邻体素锚点，闭合已知边界。

- 轴向矩形x/y均为1–3，恰好9体素；内矩形x/y均为2–3，恰好4体素。Select外矩形、Deselect内矩形的temporary结果为5体素，原Mask不变。
- 相同矩形分别位于z=0和z=2，原临时Mask18体素。相同锚层插值后的已知预期为z=0/1/2各9，共27体素；预览Apply前仍保持原18体素。这检查独立算法在相同形状间的恒等性，不调用被测插值函数生成oracle，也不认证原Mimics插值内核。
- z=1矩形灰度111–133，局部范围[121,132]恰好接受5体素；故意把global params.lower/upper设为0，最终局部Threshold仍应得到这5体素，ROI外不变。
- 复制用两个明确体素及一个应被完整目标切片替换清除的旧体素；直接按固定axis和目的索引计算预期，不调用copySelectionSlices作为oracle。

## 验收文件与边界

`tests/mimics-multiple-edit.test.ts`覆盖会话/方向、显示隔离、lasso与真实Worker LiveWire并差、在途变更、复制裁剪和跳层、插值预览屏障/Apply/Cancel、最终Add/Remove/Threshold的Undo/Redo，以及Close清理。使用实际OperationClient与operations.worker的Node worker_threads adapter。

首轮实际运行18项，**17通过、1失败**，保留在 `../evidence/multiple-edit-baseline.tap`。失败为插值预览存在时切换selectionType触发通用cancel，清除了interpolationPreview，随后编辑/复制/最终Apply可绕过预览屏障。已报告给root；需要修复后重跑，不能因另外17项通过就宣称本专项全部完成。

root修复Type watcher在插值预览期间的行为后，已实际重跑为 **18/18通过**，当前日志 `../evidence/multiple-edit-current.tap`。已通过隐藏active的临时显示/编辑、session方向固定、Lasso/LiveWire并差、在途旧结果取消、完整目的层复制替换/裁剪跳层、0双向复制不跳、预览写入屏障/Apply/Cancel、local range在global [0,0]下得到已知5体素、最终一次事务Undo/Redo和Close清理。基线失败保留用于复核，不再表示当前仍失败。

root浏览器发现同目标state对象更新误触发watch的新边界后，增加第19项：同ID重命名和最终Apply均保留已完成selection的同一引用；最终Apply只增加一次revision，一次Undo退回重命名后的原Mask而不撤销重命名，Redo可恢复。与独立 `mimics-auto-preview.test.ts` 联跑，**19+1=20/20通过**，见 `../evidence/multiple-preview-current.tap`。自动预览测试以显式6体素夹具确认结果，等待自动完成最多1秒，Apply后观察450ms无preview/busy/status/state/revision复活。此记录来自真实控制器/Worker，不是浏览器复验。

共享实现后续变更仍需重跑相关专项；全量集成和实际浏览器由root统一验收。此18项通过不等于所有帮助参数或所有交互形态都已完成。

本测试不执行浏览器canvas、pointer capture、freehand采样、交互颜色、文件选择或IndexedDB。未恢复Flood-fill，不证明复杂形状插值/真实边缘LiveWire与原版数值相同。帮助没有完整定义Close/Cancel回滚、零复制跳层或所有退化情况，以上约定已明确区分。
