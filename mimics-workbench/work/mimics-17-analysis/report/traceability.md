# 证据链、审核与复现附录

本章为报告的审计层。`validated`用于已由不同证据交叉支持的限定命题，绝不表示临床准确性已获验证；`candidate`保留尚未动态复现的具体算法和调用覆盖范围。所有发现均为普通功能逆向，severity统一为n/a_re。

## 原始证据索引

完整哈希及复现入口见 [证据索引](../evidence/INDEX.md)。

| 证据 | 内容 | 用法 |
|---|---|---|
| E-001 | 129个PE身份、哈希、节与依赖 | 按精确模块核对版本和符号 |
| E-002 / E-009 | 62项工作流、帮助源页与哈希审核 | 核对菜单、参数、提交时刻及版本限制 |
| E-003 | 分割反编译函数清单 | 追溯Threshold、Region Growing、DRG、Morphology、LiveWire等 |
| E-004 | 重建反编译函数清单 | 追溯图像转STL、MC、平滑、减面、Wrap和写出 |
| E-005 / E-006 | 测量创建事务与数值格式化 | 区分对象操作、撤销、量值和显示 |
| E-007 | 主程序CodeMeter与静态分析边界 | 不能把不可读IAT误判为功能缺失 |
| E-008 | 独立文档事实审核 | 纠正不同对话框预设命名和旧菜单描述 |

## Findings

### F-001 对象分层决定工具行为

- severity: n/a_re
- evidence_ids: [E-001, E-002, E-005]
- confidence: high
- location: MimicsBase.dll, Mimics.Script.plugin, Help/Mimics.chm
- status: validated

Mask、3D对象、Measurement和Annotation各有对象语义。Measure Distance的脚本创建链确实通过工程对象数据库和动作接口执行；帮助中对应列表、编辑方式与之相容。结论限于对象分层，不声称已恢复全部内存布局和持久化格式。

### F-002 分割并非统一的一个增长算法

- severity: n/a_re
- evidence_ids: [E-002, E-003]
- confidence: high
- location: MatImageOperations.dll, Mimics.Segmentation.plugin
- status: candidate

代表代码确证阈值、普通RLE连通生长、动态队列增长、布尔和形态学使用不同处理机制。每工具详细章节区分可见内核和受保护主程序动作工厂边界；没有对全部UI操作做运行时命中验证。

### F-003 图像/Mask到MC的外围调用链可恢复

- severity: n/a_re
- evidence_ids: [E-001, E-004]
- confidence: high
- location: MatOperationsStlImages.dll!0x180002630 -> MatStlMarchingCubes.dll!0x180017330
- status: candidate

已恢复相邻图像缓冲的准备/交换和TwoImagesToStl调用，及cube配置、插值、三角写出；这是具体外围模块间调用证据。未把GUI质量预设与每个私有字段完成逐项映射，也未量化具体病例输出误差。

### F-004 体绘制、表面重建和体网格是不同结果

- severity: n/a_re
- evidence_ids: [E-002, E-004]
- confidence: high
- location: Help Volume rendering / Calculate 3D / FEA pages; MatStlMarchingCubes.dll
- status: validated

帮助直接声明体绘制是显示工具，不能用于导出；MC代码确实生成三角形；FEA/3-matic章节描述另行体网格流程。不能把显示质量、网格质量和分割准确性混为一谈。

### F-005 测量创建具有事务边界

- severity: n/a_re
- evidence_ids: [E-005, E-006, E-002]
- confidence: high
- location: Mimics.Script.plugin!0x180049440; MimicsBase.dll!0x1800C9D90
- status: validated

已核查脚本Distance创建先开启事务、加两端点、加入数据库再Commit，移动点使用UndoManagerEx。基础量值格式化是独立函数。该结论只约束已核查入口，不能推出每个鼠标预览事件都写入Undo。

### F-006 主程序保护限制全量反编译结论

- severity: n/a_re
- evidence_ids: [E-001, E-007]
- confidence: high
- location: Mimics.exe __wibu00..__wibu08
- status: validated

DIE识别CodeMeter，PE多个wibu节熵接近8；主业务静态字符串与IAT受限。报告未将这一层声称为完整源码恢复，转而利用未保护外围模块和随包帮助。

### F-007 原始帮助与新版本名称需要隔离

- severity: n/a_re
- evidence_ids: [E-002, E-008, E-009]
- confidence: high
- location: Help/Mimics.chm; Calculate3D_common.png; STL+ parameters
- status: validated

本包实际工具名称、模块限制和3-matic协作上下文已逐项记录。Calculate 3D的Optimal与STL+的Maximum分属不同对话框，不能当作同一预设一一对应。截图参数仅为示例状态。

## Paths

### P-001 从分割到三角表面的证据路径

- path_type: callflow
- evidence_ids: [E-002, E-003, E-004]

帮助定义用户选择Mask及Calculate 3D的流程（E-002）；分割内核在其各自算子中更新成员集合（E-003）；`MatOperationsStlImages!_Operate`准备层缓冲并直接调用`MatStlMarchingCubes!TwoImagesToStl`（E-004）。从GUI动作工厂到这个重建算子的完整跳转尚未追通，因此数据流的连接与已证实的代码调用分别标注。

### P-002 从测量输入到可撤销对象

- path_type: callflow
- evidence_ids: [E-005, E-006, E-002]

`CreateDistanceMeasurement`绑定 → 检查工程 → BeginTransaction → 构造测量对象 → IAddPoint3D分别设点0/1和可选STL → AddObjectToDataBase → Commit（E-005）。对象量值与基础显示字符串分离（E-006）。UI两次点选和拖端点的操作语义由帮助支持（E-002），不冒称鼠标回调已经动态追踪。

### P-003 文档和代码互相约束

- path_type: solve
- evidence_ids: [E-001, E-002, E-003, E-004, E-007, E-008, E-009]

先固定样本与CHM哈希，盘点导入导出，再按帮助定位工具，再以RTTI/字符串/调用引用定位函数，保存反编译和地址，交叉审查文档与代码差异。无法解释的受保护调用、算法参数、旧菜单和专业模块行为保留缺口，避免把通用医学图像算法填作已恢复实现。

## 复现与交付检查

原始函数快照清单包含每个文件的SHA256，可按对应模块/VA重新反编译对照。完整报告的本地链接、HTML锚点、模块哈希和工具条数由 [report-validation.json](../evidence/report-validation.json) 记录；正式案例契约由 [case-review.json](../evidence/case-review.json) 记录。流程图SVG和Mermaid源码均保留。

报告构建工具：[build_report.py](../notes/build_report.py)。重新生成只写本案例文件，不启动Mimics：

```powershell
& 'C:\Users\wwulli\Tools\reverse-skill-python\Scripts\python.exe' 'C:\Users\wwulli\Desktop\deepmark\work\mimics-17-analysis\notes\archive_evidence.py'
& 'C:\Users\wwulli\Tools\reverse-skill-python\Scripts\python.exe' 'C:\Users\wwulli\Desktop\deepmark\work\mimics-17-analysis\notes\build_report.py'
```

分析过程及局部工具错误见 [timeline.md](../timeline.md)。经验总结写在 [本案例field-journal](../notes/field-journal.md)；遵从本轮不提问和仅分析任务的范围，没有向外提交、发布或改写共享技能索引。
