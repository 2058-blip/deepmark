# 基础几何与密度测量：原帮助和本轮控制器契约

2026-11-05。只读核查帮助、公式图片和现有kernel/controller；新增 `tests/mimics-measurement-workflow.test.ts`，不改共享业务代码、不操作浏览器。

## 原帮助与参数

原件均在 `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/`：

| 文件 | 可确认的操作/结果 |
| --- | --- |
| `Measure angle.txt` | CT/alignment/3D中左键三点定义角度，单位degree，可拖中心点或端点微调，有context menu。第二点作顶点是当前实现约定，正文没有逐字定义点击顺序。 |
| `Measure diameter.txt` | 图像/3D结构轮廓上点击三点，得到mm直径，可拖各点微调，有context menu；正文未给原版退化阈值/数值算法。 |
| `Measure Ellipse.txt` | D1最大直径、D2最小直径、E、P、A、DP、DA；两次click固定最大径端点，再move定义最小径；可拖两轴端点、转动角点、拖中心平移、拖标签，无context menu。 |
| `Measure Area.txt` | 单slice闭合polygon，double-click闭合即显示；A/P/Da/Dp/Centroid/Lmax/L⊥；可拖点、右键增删点，普通/MPR views均可。 |
| `Measure density in rectangle.txt` | click放置或左键drag放置并resize；边/角resize，yellow border平移；松键重算area/mean/std，scroll更新；有Delete/Hide/Measurements List context menu。 |
| `Measure density in ellipse.txt` | click放置或drag定大小；四marker resize，非marker yellow border平移；松键和scroll重算，结果单位mm²及HU/GV。 |
| `Measurements.txt` | 列表含Value/Unit/Deviation/Area，New/Delete/Properties/Duplicate/Locate，不应只靠一个合成label冒称完整details。 |

### Ellipse公式图片及编号冲突

人工读取 `work/mimics-17-analysis/evidence/help/chm/Resources/Images/Measure ellipse/03000001.png`：

`E = sqrt((R1² - R2²) / R1²) = sqrt(1 - (R2/R1)²)`，R1为较大半径。当前kernel公式相符。

DP由圆周`2πr`对应直径，故`DP=P/π`；DA由`πr²`对应直径，故`DA=2sqrt(A/π)`。

同目录 `02000002.jpg`示例却写D1=20.24、D2=26.42，与正文D1最大/D2最小的编号相反；E=.64符合使用较大/较小半径的公式。本应用按正文排序D1≥D2是可解释选择，不能声称与该截图轴编号等价。原版P积分方法未知；当前Simpson1024为独立数值实现。

### Area与密度的数值边界

Lmax必须是过面积centroid的最大距离，L⊥为也过centroid且垂直该方向的弦，不能替换成bounding-box边或任意顶点对。6×4矩形的Lmax=√52，L⊥=4√13/3，后者不是短边4。凹形的连通弦、并列方向及centroid落外部时的策略原文没有展开；当前kernel明确为独立政策。

密度正文不说明标准差分母、整数像素中心/边界规则或所显示area是采样面积还是连续几何面积。当前实现使用inclusive pixel-centre与总体std=N，并同时返回sampleArea/geometricArea；测试只认证这套明确的独立契约，不能认证原Mimics逐像素数值。窗宽窗位、颜色和显隐不得改变定量raw data。

## 本轮公开接口

- `measurementDetails(id)`返回结构化`{kind,valid,value,unit,details,reason?}`，几何details为kernel结果；密度value=mean，details含count/std/min/max/area/sampleArea/geometricArea等，不仅检查格式化label。
- `selectedMeasurementDetails`随选中ID变化。
- `createDensityROI({kind:'density-rectangle'|'density-ellipse',plane,points:[voxelCorner1,voxelCorner2]})`一次commit；legacy两次imagePick继续兼容。
- `displayMeasurements`将density的plane.index和world两角平移到当前`point[axis]`；raw对象和plane不改，scroll不增加history/dirty，details/labels同步。
- `updateMeasurementGeometry({id,points:worldPoints,plane?})`批量一条事务；area/density保单plane，kind/附件冻结，不接受provenance覆写。
- `pointPartIds`逐point保存`Part ID|null`，只有全来自同一Part时设置汇总partId；混合Part/图像/plane不绑定最后Part。新draft引用被删Part时取消；已提交历史source允许删除后保留world points。
- PartToMask通过实际Worker体素化，`addMask`第五参数为来源Part对象并记录Mask.sourcePartId，不能只保存名称而丢来源。

上述每点来源与生命周期属于应用数据模型，不是原帮助对内部存储的证明。完整四轴/旋转/中心/标签的原生Ellipse操作也不能仅由三anchor模型或batch API认证。

## 独立oracle与测试

4×5×3，affine `[[3,1,.5,10],[0,2,.25,-20],[0,0,4,30]]`，灰度`x+10*y+100*z`：

- 三点90°，三点圆diameter4；ellipse6×4：D1=6/D2=4/E=√5/3/A=6π/DA=2√6。独立binomial h-series取20项得到P=15.86543958929059、DP=5.050126269922894，不调用被测kernel生成期望。
- 6×4矩形A24/P20/centroid`[15.5,-17.75,34]`/Lmax√52/L⊥4√13/3；geometry batch改为3×4后A12/P14，一次Undo恢复。
- voxel corners`[0,1,z]`至`[2,3,z]`：rectangle count9、mean=21+100z、std=√(202/3)、sampleArea54、geometricArea24；ellipse count5、同mean、std=√(202/5)、sampleArea30、geometricArea6π。
- z1→z2时raw ROI不变，display world两角由`[11.5,-17.75,34]/[19.5,-13.75,34]`变为`[12,-17.5,38]/[20,-13.5,38]`；Z shear必须一并保留。
- 字面闭合平行六面体和字面triangle作为Part，不伪称真实picker；跨Part distance为5，batch/drag后点引用不丢；PartToMask的IJK bounds包含6个明确voxel，经过真实Worker与ZIP验证sourcePartId。

root新API接齐后，原14项已实际全部通过；补充必要的拒绝/生命周期及翻片反例后，当前专项为 **18/18通过**（本次约716ms），完整输出 `../evidence/measurement-workflow-current.tap`。

额外通过：跨plane/零尺寸输入拒绝且不加history；旧revision与同一measurement ID经ZIP重开后的旧volume gesture均不能改新doc；area四点删成三点只一条事务，null逐点来源长度同步且Undo/Redo正确；同点坐标下尝试覆写kind/partId/pointPartIds不会改变来源或新增无意义事务。

翻片不增加project revision，因此单靠volume/revision不足以冻结UI gesture。第18项捕获同volume/revision的density create/update和单点image measurement move请求后，仅把point从z1翻到z2；旧plane1请求均被静默拒绝，state引用、revision、Undo、dirty、status/error与point均不变。无snapshot的显式程序API仍可有意创建/更新任一合法plane；新的current-plane UI snapshot也能成功。本应用据此区分UI手势失效保护和程序指定平面的兼容语义。

只读核查当前实现未发现上述正常/拒绝路径的新阻塞性错误。结构化details按当前slice计算，display density world两角含Z shear，rawstate/plane不变；三维混合点与历史来源、PartToMask新Mask来源均有实际控制器/Worker证据。首轮实现期间14项1过13API未接的预备结果不代表当前失败，也不作为13个kernel错误。

ROI椭圆是在voxel-plane坐标中定义再经完整affine映射，所测面积采用叉积；这不证明原版在shear影像上使用相同ROI形状定义。仍不包含浏览器density拖边/角/平移、ellipse四轴/旋转/label拖动、任意MPR交互或原版runtime数值对比。相关源码接线与模块专项由root及对应代理另外验收。
