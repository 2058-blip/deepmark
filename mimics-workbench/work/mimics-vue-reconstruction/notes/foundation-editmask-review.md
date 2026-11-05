# Edit Masks 与 Multiple Slice Edit 只读核查

2026-11-05。只读原帮助和当前源码；没有修改共享实现，没有操作浏览器，没有把帮助未描述的取消行为当作原版事实。

以下问题表与源码行号保留初次审查的修复前快照。root已纠正普通轮廓的提交错接与非法测量fallback，后续控制器补验见本节；不能将下面的历史问题表理解为当前仍全部存在。

## 修复后控制器补验

新增 `tests/mimics-editmasks-controller.test.ts`，使用实际useWorkbench、operations.worker和Node worker_threads，**10/10通过**，完整输出：`../evidence/editmasks-controller-current.tap`。

7×6×2已知夹具上的矩形ROI为16体素；ramp灰度`x+10y+100z`配局部阈值[21,32]可直接手算6体素。三种Lasso操作与三种LiveWire操作均直接编辑活动Mask、保持temporary selection引用不变、一次Undo/Redo，且不改变ROI外/另一层和其他Mask。LiveWire使用常量影像与相邻体素锚点，经过真实Worker闭合已知矩形，没有调用LiveWire或polygonRaster作为输出oracle。

其他通过项：少于3点、共线、add/remove/threshold三种无变化轮廓不增加history；切目标、editOperation、阈值或切片取消未完成轮廓；LiveWire参数/操作变更及显式cancel丢弃在途旧结果；multiple/boolean/crop/未知工具不创建测量，Select只改临时Mask，真正annotation工具仍能创建有效对象。root同时报告全量`npm test`270/270和build通过；本审查独立执行确认的是此10项专项及此前22项foundation，不把root报告冒称本审查重新执行。

当前仍需保留的边界：浏览器freehand/coalesced pointer/松键与LiveWire双击/capture取消；真实边缘影像的LiveWire路径及原版数值对照；Multiple Slice Edit内的Lasso/LiveWire Type；所选方向锁定、隐藏其他Mask和相交色、非0复制跳层、插值Apply屏障；原生局部阈值三范围UI；self-intersection/非有限/越界轮廓的专项退化覆盖。本文件不将这些列为已通过。

后续Multiple Slice Edit控制器已补上述Type、方向、临时显隐、复制跳层和插值Apply屏障，并在 `tests/mimics-multiple-edit.test.ts` **18/18通过**；独立localThreshold三范围已接通。此后续记录取代前段中“多片控制器尚未实现”的部分，具体原帮助/独立约定与剩余浏览器颜色/指针边界见 `foundation-multiple-edit-review.md`。原版数值等价和复杂退化轮廓仍未认证。

修复前结论：普通Edit Masks与Multiple Slice Edit混用同一个临时selection路径。circle/square直接编辑活动Mask基本符合帮助，但普通lasso/livewire只创建需额外Apply的临时选区；普通编辑Type与Operation应分离，temporary Mask属于Multiple Slice Edit。这一主要提交错接现已修复并通过上述专项。

## 原帮助直接证据

以下路径均相对于仓库根目录：

| 证据 | 直接记载 |
| --- | --- |
| `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Edit Masks.htm:20` | “All manual editing functions are performed on the active mask.” 手动编辑作用于活动Mask。 |
| 同文件 `:34`、`:36` | Type 是square/circle/Lasso/Flood-fill/LiveWire；Lasso按住左键绘制，松开左键结束。 |
| 同文件 `:38` | LiveWire依次点边界，轮廓表示将应用“selected operation”的区域。并非固定生成需另选最终操作的临时Mask。 |
| 同文件 `:62`、`:70` | Draw “Draws in the active mask”；Erase “Erases in the active mask”。 |
| 同文件 `:78`、`:79`、`:83` | Threshold恢复所编辑区域的局部阈值；三组范围中间为活动Mask当前阈值，不能改；区域内符合范围的加入，不符合范围的现有成员移除。 |
| `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Editing Thresholding.htm` | case明确三种mode是Draw/Erase/Threshold；Draw加入经过区域的每个像素，Threshold还检查HU，并会移除不在阈值内的成员。修改局部范围不等于改变全数据集的global threshold。 |
| `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Multiple slice edit.htm:20` | Multiple Slice Edit明确创建“temporary mask”，其活动体素最后Add/Remove或用于原Mask局部Threshold。 |
| 同文件 `:26`、`:27`、`:28` | 先选Axial/Coronal/Sagittal；除活动Mask外其他Mask隐藏；临时Mask独立颜色，与活动Mask重叠部分第三种颜色；可以修改并继续复制。 |
| `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/The multiple slice edit interface.htm:33` | 多片编辑也有Type，包括Lasso，按住左键拖动、松开结束；同页也允许LiveWire创建临时Mask。 |
| 同文件 `:59`、`:62`、`:67`、`:70` | Select添加到临时Mask，Deselect从临时Mask删除。它们与最后对活动Mask的Add/Remove/Threshold是不同层次。 |
| 同文件 `:78`、`:86`、`:87` | Copy to slices锁定编辑及复制方向；0表示全部前/后切片，非0复制后跳到最后目的切片。 |
| 同文件 `:97`、`:98`、`:107` | 插值针对所选方向；前次插值Apply后才能对其他区域再次插值；最终操作作用于活动Mask的临时Mask成员位置。 |

`3D LiveWire.htm`与`The 3D LiveWire Interface.htm`描述另一套跨正交面约束、Automatic contour/turtle map、Segment产生新Mask的工作流，不能用其Segment按钮来论证普通2D Edit Masks必须先生成临时Mask。同理，3D页明确写双击闭合，但本次未找到2D页对LiveWire具体闭合/取消手势的同等直接描述。

## 修复前错接与风险快照

| 优先级 | 当前实现及证据 | 与帮助的差异/影响 |
| --- | --- | --- |
| P0 | `src/mimics/Workbench.vue:23` 将`lasso/livewire`一律归到`pendingSelection`；`:80`一律展示多片复制、插值、最终Apply。`src/mimics/useWorkbench.ts:244`闭合轮廓只赋`selection=result.mask`。 | 普通Lasso/LiveWire不能选择Draw/Erase/Threshold立即作用活动Mask；用户被强制转入Multiple Slice Edit流程。 |
| P0 | `tool='multiple'`不属于`ImageViewport.vue:22`的brush；`useWorkbench.imagePick`没有multiple分支，普通点落入`:239`；`finishDrawing`的`:245`按`tool as MeasurementKind`创建测量。 | 进入多片后未先点Select，直接点影像、Enter会创建`kind='multiple'`的非法测量；工程验证/保存可随后失败。不是仅UI风格差异。 |
| P1 | `ImageViewport.vue:61`–`:71`只有brush手势采样；Lasso走单击pick，完成靠`:85`双击或全局Enter。 | 帮助明确Lasso应左键拖出轮廓，松开结束。当前是点多边形工具。可保留点多边形为另一个独立工具，但不应称其已经完成原生Lasso。 |
| P1 | `params.lower/upper`供global threshold、local-threshold和临时选区最终threshold共用；`brushBegin:199`直接捕获这两个值。 | 局部阈值没有独立三组范围，也不以活动Mask保存的threshold作不可变默认。切换活动Mask后可能用上一次全局预览或另一Mask参数，而不是“恢复该Mask原始阈值”。当前区域内赋0/1的算法本身符合帮助。 |
| P1 | `finishDrawing:244`每次覆盖selection，没有根据临时Select/Deselect做并/差；Type与操作共用tool字符串。 | 多片Lasso/LiveWire无法像临时画笔一样累加或取消选择。选择Lasso即丢失Select/Deselect上下文。 |
| P1 | 多片复制/插值直接读`activeAxis/point`，可从任一视图继续编辑；所有可见Mask照常显示；黄色preview覆盖临时区域，未区分与源的相交颜色。 | 与帮助的Copy to slices所选方向、隐藏非活动Mask、第三种相交色不同；用户更难识别编辑对象和临时影响范围。 |
| P2 | Copy kernel支持0和正反方向，但控制器只更新selection，不移动point。 | 缺少帮助明确的“非0复制后跳最后目的层”。 |
| P2 | 插值直接更新selection，可连续再次插值；没有独立插值预览/Apply状态。 | 未实现帮助记载的前次插值应用屏障，尚不宜称插值交互原生一致。 |

## 提交和取消的准确边界（初次审查快照）

现在circle/square一次笔画仅在pointerup后commit一次，Escape/pointercancel/lostcapture丢弃当前draft，已提交成员不回滚。这是合理的安全事务实现；帮助只明确操作作用对象，没有给出原版精确Undo粒度，不能把“一笔一次Undo”标成已证实的原版事务。

`cancel()`清draft/points/livewire，却不清selection。因此当前Lasso闭合后按Escape，黄色selection仍在，且仍可Apply。这个现象与“取消未提交操作”的当前文案不一致。不过，帮助没有明确整个多片会话的Cancel/Close回滚规则，所以不应声称原版Escape必定删除所有临时Mask。

建议明确两个操作：取消当前未完成手势只丢draft/contour，不动已提交Mask；取消多片会话丢temporary selection并退出，不动活动Mask。全局Undo只回滚已提交事务，不用它模拟取消未完成轮廓。多片Apply后临时Mask究竟保留还是清空，帮助的文字不足以裁定，需显式标注独立策略或继续找原版入口证据。

## 最小纠正方案

1. 增加彼此独立的上下文：`editScope='active'|'multiple'`，`editOperation='draw'|'erase'|'threshold'`，`editType='circle'|'square'|'lasso'|'livewire'`。多片另保留`selectionMode='select'|'deselect'`及最终`selectionOperation`。不再用`tool='multiple'`进入通用测量fallback；进入多片时默认Select画笔，测量创建必须白名单。
2. 保留现有`brushFootprint`和笔画事务。普通circle/square按editOperation写active Mask；多片circle/square仅写temporary selection。将Type与Operation分离，不要求重写分割核。
3. Lasso新增专用pointer gesture：down记录平面、目标ID/revision、operation和首点，move采样，up闭合并调用已有`polygonRaster`。普通scope将结果通过已有`segmentation.applySelection`的add/remove/threshold作用于目标，并一次commit；多片scope按Select/Deselect与旧selection并/差，不commit原Mask。pointercancel/Escape只丢当前轮廓。
4. LiveWire继续复用现有worker树和闭合路径；完成后的分流与Lasso相同，普通scope直接用选定Draw/Erase/Threshold提交，多片scope才改变临时Mask。保留参数/target/revision取消保护；2D闭合手势的准确原版证据不足，先清楚标注双击/Enter为当前完成方式。
5. 最低限度先把局部阈值与global阈值参数拆开，提供“活动Mask默认范围”一键恢复，默认值来自`activeMask.threshold`；不修改该保存值。若要声称完整原生参数交互，再补不可变中间默认及上下两组自定义范围。
6. 多片会话保存开始时Mask ID和Copy to slices方向，隐藏其他Mask只改变显示而不提交显隐历史；保存/退出后恢复显示。临时成员和与活动Mask重叠分别着色。复制非0时计算实际裁剪后的最后目的层并更新point。

建议先实现1–4纠正对象/提交错接与非法测量，再补局部阈值默认和多片显示/复制；插值的单独Apply屏障可保留明确缺口，避免为赶UI再次混淆提交层次。

## 改后最小验收

- 同一Lasso轮廓分别Draw/Erase/Threshold：只改当前层ROI，其他层和ROI外逐字节不变；一条Undo可回退；不出现临时Apply。
- 多片同一轮廓Select/Deselect：只改临时selection，原Mask和dirty不变；最终Add/Remove/Threshold Apply才一次提交。
- Lasso左键拖动松开完成；中途Escape、pointercancel、换目标/切片均不提交；LiveWire未闭合取消不留可Apply的意外旧轮廓。
- 刚进入Multiple Slice Edit直接点影像、Enter不会创建任何测量；复制非0跳最后目的层，0复制到该方向边界。
- 对不同保存阈值的两个Mask切换后，局部默认随目标变化；自定义局部范围不覆盖global preview参数或Mask保存的默认threshold。

这些是建议验收，尚未执行，也没有把本次只读源码判断变成新的浏览器通过记录。
