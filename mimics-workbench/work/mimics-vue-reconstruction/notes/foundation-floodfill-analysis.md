# Edit Masks Flood-fill：只读静态深化

2026-11-05。结论：**已确认原功能的交互/参数语义、资源ID和编辑控件体系，但当前离线原件不足以恢复可核实的原版Flood-fill数值内核或按住生长循环。不得用普通连通填充、Region Growing、Cavity Fill或GDI ExtFloodFill冒充。**

本轮没有修改app源码、没有浏览器操作、没有运行Mimics/目标DLL、没有访问或修改许可证、没有安装工具。复用已有盘点和IDA数据库，未重新做全量CHM/PE盘点。

## 授权、路由和工具

- 既有 `work/mimics-vue-reconstruction/scope.md`：auth granted、R0、offline-sample，只读原样本；case-guard本轮返回OK。
- 本轮router返回R0 reverse-engineering，记录 `work/master-route-20261105-105856/route-scope.md`。现有case已初始化，保留而未重写scope。
- 读取本机reverse-skill-router、RULES、R0工作流、field-journal索引/precedent和tool-index。工具路径来自 `C:/Users/wwulli/.codex/skill-repositories/reverse-skill/skills/tool-index.md`。
- 静态资源脚本使用登记的Python与pefile；IDA以force_headless打开现有workspace副本数据库，`run_auto_analysis=false`、`build_caches=false`，最终`idb_close(save=false)`。启动的是分析工具，不是目标程序。
- 会话和边界记录：`../evidence/floodfill/analysis-session.json`。

## 原帮助与截图：可确认的契约

证据路径相对于仓库根目录：

1. `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/Edit Masks.htm:20,34–38`：Flood-fill是Type，与square/circle/Lasso/LiveWire并列；所有手动编辑作用active mask。原句：选择区域内一点，移动鼠标并保持左键按下，“The selected area grows until an edge in the image is detected.”
2. 同文件 `:46–54` 的Tolerance/Impatience说明：Tolerance控制边缘检测，越高需要越锐利的边缘才能停止轮廓向外生长；Impatience表示当前区域向外扩张的速度，接近边缘时速度逐渐下降。
3. 同文件 `:62,70,78,83`：Draw增加active mask、Erase删除active mask；Threshold在编辑区域内按局部范围加入或删除成员。Flood-fill是区域/轮廓生成Type，不能被固定解释成只做添加。
4. `work/mimics-17-analysis/evidence/help/chm/Mimics Reference Guide/The multiple slice edit interface.htm:33–34,46–54,62,70`：多片临时Mask也支持Flood-fill Type；Select/Deselect作用temporary mask。它不改变普通Edit Masks的active-mask对象语义。
5. 已人工查看 `work/mimics-17-analysis/evidence/help/chm/Resources/Images/EditMasks.png`。截图为**Square**，显示Width/Height各50及226/1613示例阈值，不能据此推出Flood-fill的Tolerance/Impatience默认值或单位。

帮助只给定性关系，**没有**给公式、数值范围、默认值、像素邻域、特征预处理、时间步长、推进队列、数据结构、取消/Undo粒度或精确松键提交时机。尤其不能把Impatience直接等同动画帧率、固定生长迭代次数或鼠标移动距离。

## 新静态资源证据

完整可复核输出：`../evidence/floodfill/resource-controls.json`；生成器 `inspect_resources.py`。原件 `MimicsENU.dll` SHA-256：`04eb585b317dedf41875948951512e274aa918e5764cf9561ff9d6111c893859`，base `0x180000000`。

| 字符串资源ID | 内容 | 静态VA | 文件偏移 |
| --- | --- | --- | --- |
| 287 | Impatience | `0x1802031C0` | `0x2023C0` |
| 303 | Flood-fill | `0x18020391E` | `0x202B1E` |
| 317 | Tolerance | `0x180203D32` | `0x202F32` |
| 33433 | Draw Mask with Flood-fill | `0x1801EF012` | `0x1EE212` |
| 33434 | Erase Mask with Flood-fill | `0x1801EF046` | `0x1EE246` |
| 33435 | Threshold Mask with Flood-fill | `0x1801EF07C` | `0x1EE27C` |

这些是经过RT_STRING解析的**字符串ID**。没有调用点证据时，不能把33433–33435自动称为已定位的WM_COMMAND处理器ID，也不能排除它们被用作操作/历史名称。

资源RT_DIALOG #154（RVA `0x3B8A0`）与帮助Edit Masks截图布局一致：

- Type Combo：17773（`0x456D`）。
- 默认Width label：17180；对应Edit：17775（`0x456F`）。
- 默认Height label：17183；对应Edit：17779（`0x4573`）。
- Draw：17783（`0x4577`）；Erase：17787（`0x457B`）；Threshold：17788（`0x457C`）；Close：17790。
- MSE资源RT_DIALOG #2804（RVA `0x37C30`）复用Type、尺寸Edit和17783/17787控件，后两者文本为Select/Deselect，并有独立最终Apply。

**尚未证实**Width/Height Edit在Flood-fill模式下是否原位复用为Tolerance/Impatience。资源只有默认标签，动态改标题与参数绑定的处理函数尚未定位；这是待验证假设，不能写成已恢复控制流。

## 已有PE、符号及反编译证据的排除

### 主EXE的可读性边界

复用 `work/mimics-17-analysis/evidence/triage/inventory.json`：`Mimics.exe`为x64，SHA-256 `faed50f99e74926de007299db0bdf58470213b1ee79654d06ea2b9b1ee6e6004`，base `0x140000000`。主要段为Wibu保护段：

| 段 | RVA | raw size | 既有熵 |
| --- | --- | --- | --- |
| `__wibu00` | `0x1000` | 12468736 | 8.0 |
| `__wibu01` | `0xBE6000` | 5458944 | 8.0 |
| `__wibu02` | `0x111B000` | 459264 | 8.0 |

本轮复用 `work/mimics-17-analysis/evidence/ida/Mimics.exe.i64`，没有重跑auto analysis。定向字符串查询`Flood|Impatience|Tolerance|FillTool|Smart.?Fill`为0；已识别函数名按Flood/Impat/Edit*Mask过滤为0。原件ASCII/UTF16定向字节搜索同样没有相应词。

这些结果表明当前可见原件没有建立符号锚点，**不证明功能不存在，也不证明算法一定完全位于EXE**。受保护代码里的自动函数边界/伪码没有被冒充为有意义的Flood-fill内核证据。

### 未保护模块中容易误判的名字

- `Mimics.Segmentation.plugin`的`FloodFilled*`是ITK迭代器RTTI。例如既有 `work/mimics-17-analysis/evidence/annotation/Mimics.Segmentation.plugin.anchors.txt:294–299`：
  - `FloodFilledImageFunctionConditionalIterator<Image<char,3>,RegionGrowImageFunction<...>>` vtable `0x18050A418`，列出函数`0x1800FC6A0`、`0x1800D7D00`、`0x1800F7620`等。
  - `FloodFilledImageFunctionConditionalIterator<Image<char,3>,BinaryThresholdImageFunction<...>>` vtable `0x18050A318`，列出函数`0x1800FC470`等。
  - 还有2D/3D、ellipsoid等实例。这些名字直接描述条件连通遍历，不含Tolerance/Impatience，也没有普通Edit Masks控件→调用点闭环。本轮没有把这些函数当Flood-fill内核反编译或宣称恢复。
- `work/mimics-17-analysis/evidence/triage/MatSoftTissue.dll.symbols.tsv:327` 的`ExtFloodFill`为GDI导入IAT槽`0x103FD0CC`，对应原模块x86（machine `0x14C`），而主EXE为x64。没有64位普通编辑工具到这个导入的调用证据；它也不表达图像边缘检测或Impatience。不能用Windows颜色填充替代。
- 对`Mat2D.dll`、`Mat2DSlices.dll`、`MatHPAlgorithms.dll`、`ImageOperations.dll`、`MatImageOperations.dll`的定向Flood/Impatience原字节搜索未命中。只说明没有这些词的直接锚点，不能排除匿名实现或间接调用。

### 定向控件/命令表检查

`../evidence/floodfill/command-map-candidates.json`及生成器`inspect_command_maps.py`，只检查已由资源确定的ID。对Mimics.exe、Segmentation plugin、MimicsBase、Mat2D、Mat2DSlices、MatHPAlgorithms扫描严格x64 MFC项：WM_COMMAND/反射项、相同起止ID以及image内处理器指针，**没有可靠候选**。

33433–33435和Type/操作控件ID在这些模块中没有形成可验证MFC表。某些低ID（287/303/317）有字面数值出现，但无类型/调用链，不能据此选择任意函数。没有进行动态解包、调试目标、内存转储或许可相关操作。

## 控制流：证实到哪里，断在哪里

| 阶段 | 可确认内容 | 证据级别/缺口 |
| --- | --- | --- |
| 选择Type | Flood-fill是独立Type字符串303，位于普通Edit Masks控件体系 | 资源B+帮助D；Combo选择项序号/枚举值未知 |
| 开始/继续输入 | 在区域内点选并按住左键移动，区域逐渐扩张 | 帮助D；具体mouse消息处理器、是否驻点自动推进、种子是否跟随鼠标未知 |
| 参数消费 | Tolerance越高越不易被弱边缘阻止；Impatience控制向外扩张速度，近边缘减速 | 帮助D+字符串B；数值域、默认值、缩放与字段偏移未知 |
| 图像特征 | 检测图像边缘 | 帮助D；gradient/滤波/归一化/窗位相关性未知 |
| 推进内核 | 会生成随交互扩张的区域/轮廓 | 只有定性D；front表示、邻域、传播/更新方程、停止判据及函数地址未知 |
| 应用编辑操作 | 同一Type支持Draw/Erase/Threshold；普通active Mask，多片temporary Select/Deselect | 资源B+帮助D；原版事务与取消细节未知 |

因此本轮**没有可交付的原版Flood-fill数值伪码，也没有已确认的kernel函数地址**。提供资源VA和错误候选的具体地址，是为了定位/排除，不是给未知内核套名。

## 下一轮最小静态锚点

1. 以RT_DIALOG #154、Type控件17773、数值Edit17775/17779为联合身份；只有单独常量17779不足以认定该工具。优先找Type选择处理器和对应DDX/数值更新方法，不再全库搜泛化“Fill”。
2. 在合法且可读的同版本静态代码/既有可读反编译中，找`MatResString`/`LoadString`对字符串287（`0x1802031C0`）和317（`0x180203D32`）的**成对**引用，以及Type303。若找到，先证明数值写入对象字段，再追这些字段的读取点；目前不能确认它们绑定17775还是17779。
3. 查同一对象如何消费左键开始/移动/结束，以及持续推进是timer、消息循环、worker还是每次移动触发。随后才查边缘特征计算、front更新和停止条件，至少建立一条“控件→字段→推进内核→Mask区域”的闭环。
4. 33433–33435先作为操作名称资源追查；确认消费者究竟是菜单路由、事务/Undo命名还是其他对象，再将Draw/Erase/Threshold的区域应用与推进内核分开。
5. 只有上述调用链实际到达某个Segmentation plugin/Mat2D/ImageOperations函数，才值得反编译那个具体入口。现有ITK FloodFilled迭代器不能作为起点替代UI链；当前保护段无需重复自动分析。

## 实现与后续边界

本轮不建议把现有`regionGrow`、`dynamicRegionGrow`或`cavityFill`改名接到Flood-fill：它们的种子/连通/偏差语义不能解释持续输入、图像边缘减速和两个原生参数的方向关系。也不能把全局灰度阈值当Tolerance。

若之后选择独立实现，应明确标记为独立的、边缘感知的交互式区域推进方法，先定义单位/时间积分/边缘特征和取消事务，再用合成弱/强边缘、泄漏通道、无边缘均匀区、不同spacing与不同参数的案例验证帮助层面的单调关系。它仍不是恢复原内核。当前高级/基础完成度中Flood-fill继续保留未恢复状态。

继续恢复原版需要新的合法静态可读证据，例如相同版本未保护的相关模块、可解析符号、已有合法反编译/转储中明确对应的控件调用链；当前授权只读原件范围不能用执行或动态解包来补这个缺口。本轮无需扩大权限即可完成上述结论。

## 复现命令

在仓库根目录执行以下静态分析器；只读预先固定的原件，输出写当前case：

```powershell
& 'C:\Users\wwulli\Tools\reverse-skill-python\Scripts\python.exe' work/mimics-vue-reconstruction/evidence/floodfill/inspect_resources.py
& 'C:\Users\wwulli\Tools\reverse-skill-python\Scripts\python.exe' work/mimics-vue-reconstruction/evidence/floodfill/inspect_command_maps.py
```

原始帮助/既有triage/RTTI证据均保留；没有重新提取整个CHM或重建全部二进制数据库。
