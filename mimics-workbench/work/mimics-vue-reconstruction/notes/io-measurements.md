# 影像输入与物理量测实现边界

本实现为独立实现。原版帮助和静态证据确定的操作契约、原版尚未恢复的数值内核、我们的算法与测试证据必须分别表述。这里的“通过”仅指下面列出的独立合成验证，不代表与原 Mimics 输出完成数值比对。

## 稳定接口

- `src/mimics/measurements.ts`：`evaluateMeasurement(kind, points, options?)`；默认 `points` 是毫米世界坐标；`coordinateSpace:'voxel'` 必须同时传 `grid`。支持 `distance / angle / 3pointdiameter / ellipse / planarpolygon`，兼容 `diameter / area`。返回 `{kind,valid,value,unit,details,reason?}`。退化或非法几何返回 `valid:false`、`value:NaN`，UI 应显示原因而不是数字零。
- `worldToVoxel(point, grid)` 反解完整 3×4 仿射，支持平移、旋转、各向异性和剪切。传入仿射和世界点的长度单位必须一致，重构应用约定为 mm。
- `densityStatistics(grid, plane, roi, options?)`：`plane` 可为 `{axis,index}`，或 `{origin,u,v,size}`。后者 origin 是世界坐标的首个采样中心，u/v 是一个采样步长的完整毫米向量，size 为采样网格尺寸。ROI 坐标是该平面的采样索引坐标。
- ROI 类型：`{kind:'rect',min:[u,v],max:[u,v]}`、`{kind:'ellipse',center:[u,v],radius:[ru,rv],rotation?}`、`{kind:'polygon',points:[[u,v],...]}`。rotation 为弧度。
- `src/mimics/dicom.ts`：`parseDicom(ArrayBuffer|Uint8Array, filenameOrOptions?, options?)` 返回 `DicomSlice`；`groupDicomSeries(slices)` 返回按 SeriesInstanceUID 分组的 `DicomSeries[]`；`convertSeriesToVolume(seriesOrSlices, name?, control?)` 返回既有 `core.Volume` 加 `dicom` 元数据。`DicomError.code` 可供 UI 分类报错。

## 数值与交互语义

距离是三维欧氏距离；角度由第二点作为顶点，以 atan2 求 0–180°；三点直径为三点外接圆，重复点或近共线时拒绝。椭圆前两点是轴两端，第三点到该轴的垂距为另一半轴；长短轴自动排序，返回 D1/D2/E/P/A/DP/DA。E 的定义来自原帮助公式，周长使用 1024 区间的 Simpson 数值积分，原软件的周长实现尚未查明。

多边形在物理平面中求面积、周长、质心，拒绝非共面和自交。依据本地 `Measure Area.txt` 的 “Lmax - Maximum distance through the centroid” 和 “L - Distance perpendicular to the Lmax (also passing through the centroid)”，Lmax 为经过面积质心的最大弦长，L 在其垂直方向仍经过同一质心。最大顶点对距离不满足这个定义，已不再作为 Lmax。

独立求法是在物理平面中枚举从质心穿过每个顶点的方向，求直线和所有多边形边的连续交点，以半开穿越计数、奇偶区间配对和包含边界的共线段合并得到内部弦。两个相邻顶点方向之间，包含质心的正负射线端点分别落在固定边上，正射线距离形如正值的 `c/(n·d)`，关于方向角的二阶导数为 `r(1+2tan²)>0`，所以区间最大值在顶点方向边界；精确穿过凹顶点的切触方向也单独求交。这不是以固定角度步长搜索，不引入角度网格误差。L 使用选中最大弦方向的严格垂直方向，重新做同一求交过程。

凹多边形约定：只取包含质心的连通、含边界内部线段；不跨越外部空隙，也不累加其他孤立叶瓣。仅接触边界的相邻区间可连接。若面积质心落在轮廓外，面积/周长/质心仍有效，Lmax/L 为 NaN，`chordStatus='centroid_outside_polygon'`。若最大弦并列，用规范化世界方向字典序选定，以保证点序反转后 L 的取向可复现。

计算使用 Float64。`chordToleranceMm=1e-10*max(1, 最大顶点到质心距离)` 用于近共线/交点合并，它是几何判定容差而非全局误差保证；近切触、极薄或尺度极大的多边形可能病态，不能给出不依赖输入条件的绝对误差界。解析三角形和凹形夹具以 1e-8 mm 检查结果，含非 XY 平面和反转点序。原版的方向搜索、并列方向和凹多边形取舍仍未恢复，本方法只承诺上述文档语义及明确独立约定。

密度统计用定量原始/重标度值，默认 nearest，也可选择 linear。整数像素中心、含边界成员规则、总体标准差（分母 N）均为明确的独立约定。采用 Welford 累积，避免平方和抵消误差。`unit` 默认 GV；CT 导入调用方应依据 `volume.dicom.intensityUnit` 传 HU。窗宽窗位、MONOCHROME1 和颜色叠加都不进入统计。

`area`/`sampleArea` 为图像范围内有效采样数乘 `|u×v|`；`geometricArea` 是未裁剪连续 ROI 的解析面积。因此边长 2 个采样间隔、端点均包含的矩形可以含 3×3 个像素中心，这两个面积有意不同。`excluded` 统计采样平面网格内、落在 ROI 中但超出影像或为非有限数的点；ROI 超出整个采样网格的部分不枚举。没有有效采样时 mean/std/min/max 为 NaN，count 为 0。

## DICOM 支持范围

支持 Part-10 文件的 Implicit VR Little Endian、Explicit VR Little Endian、Explicit VR Big Endian；无 Part-10 元信息的原始数据集需要显式指定 `transferSyntaxUID`。读取 8/16/32 bit、单通道、整数 PixelData 的传统单帧 CT/MR；处理 BitsStored、HighBit、PixelRepresentation、RescaleSlope/Intercept。可跳过有限长或未定长嵌套非影像序列，嵌套深度上限 32。

SeriesInstanceUID 决定分组。ImageOrientationPatient 前三值对应列索引增加方向，后三值对应行索引增加方向；PixelSpacing 顺序为行、列。按 ImagePositionPatient 在切面法线上的投影排序，不用文件名或 InstanceNumber 猜测位置。允许规则切片序列中的一致倾斜/剪切位移，完整保存在 sform；不同方向、不同平面内尺寸、重复实例、重复切面、不规则间距、已声明间距与位置不符时明确拒绝。单层需有效层厚/层间距。没有 SpacingBetweenSlices 时，均匀缺片无法由几何单独判定，不能声称发现全部缺片。

转换时由 DICOM LPS 转为 NIfTI RAS（x/y 取负），数据存储仍是 x 最快，再 y，再 z。生成完整 NIfTI-1 348 字节头，datatype float32、vox_offset=352、sform、mm 单位和 magic；既有 `exportNifti` 可直接复用导出标签，并经 `parseNifti` 回读验证。NIfTI-1 每轴 32767、总量 128×1024×1024 体素上限明确检查。

`volume.dicom` 保留 modality、intensityUnit、photometricInterpretation、displayInverted、windowCenter/Width 和 coordinateSystem。MONOCHROME1 的 displayInverted 仅改变显示，绝不倒置 quantitative data。MR 默认 GV；CT 的 RescaleType 缺省或 HU 时标为 HU，其他重标度类型保守标为 GV。

明确未实现：JPEG/JPEG-LS/JPEG2000/RLE/Deflated 等压缩解码、Enhanced 多帧功能组、4D 时间相位、色彩/调色板、Float/Double Pixel Data、Modality LUT/Real World Value Mapping 与 Pixel Padding 特殊统计。前述压缩、浮点和非线性定量映射在解析时明确拒绝；PixelPadding 目前仍作为普通数值进入统计，不会自动排除。多相位、重复切面和多帧不会被静默压成三维。上述不足在 requirements.json 的 IO02/IO03/SYS08 中保留为未完成，拒绝路径并不等价于完整格式支持。

未创建网络调用；解析器仅保留影像白名单字段，不返回 PatientName/PatientID 等患者人口信息。测试只在内存构建合成 DICOM，不读取真实影像或 n_a 内容。UID 是本地分组标识，调用者仍须避免把项目或日志发送到外部。

## 验证证据

`node --experimental-strip-types --test tests/mimics-measurements.test.ts tests/mimics-dicom.test.ts`：初版 11/11 通过；补充质心弦长语义后为 13/13。

- 完整仿射反变换、旋转/各向异性/剪切距离、奇异矩阵拒绝。
- 角度、三点直径、椭圆七输出和已知周长、非矩形面积/质心、非共面/自交拒绝。
- Lmax 与最大顶点距离可区分的 3-4-5 三角形、对应垂直 L 的解析值；凹形连通弦不累加孤立叶瓣，质心在外时不伪造弦长；反转点序与非 XY 平面。
- 矩形/椭圆/多边形 raw-value 密度、总体标准差、采样/解析面积、半层 MPR 线性采样与裁剪。
- 三种未压缩传输语法、12-bit signed 与 HighBit=14、rescale、序列跳过。
- UID 分组、与实例号相反的物理排序、LPS→RAS、标签 NIfTI 回读坐标。
- MONOCHROME1 显示和值分离、MRI GV；压缩、多帧、非法位深、截断、重复/不规则/多相位/声明缺片及取消拒绝。

`npx vue-tsc --noEmit` 在本次接口交付时通过。UI 集成、worker 实际取消/陈旧结果隔离、浏览器文件流、项目恢复与原版输出对照由完整应用验收另行提供，不能由这些纯函数测试替代。
