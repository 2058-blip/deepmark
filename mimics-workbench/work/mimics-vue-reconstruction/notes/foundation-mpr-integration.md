# 在线任意平面 MPR：实现、用户操作和验证

本文记录489阶段。后续541阶段已加入RP对象、Ctrl蓝轴与共享Worker（见`foundation-mpr-interactive-integration.md`），恢复后的572阶段已加入三维RP显示/旋转/边框调整（见`foundation-reslice-gizmo-integration.md`）。文中对应缺口是历史记录；全浏览器和原版等价仍未验收。

## 原生流程依据与本轮范围

Mimics17帮助的`Online reslice`、`Along Plane/Along Plane2`描述非破坏的在线重切片：在二维图像或三维对象上取三个点定义平面，形成三个相互正交的视图；平面可旋转、移动和调整大小。蓝色交互十字线与原图交线十字线独立，不自动跟随普通滚片。`Reslice Project`另建项目及变换矩阵导出、沿曲线CPR是不同流程。

本轮已实现任意物理平面真实采样、三个正交MPR视图、三点/Euler定义及其测量/标注链路。完整Ctrl蓝十字拖动、Reslice Objects集合的增删/属性、沿曲线CPR和生成新重切片工程仍待补，不能用本轮实现宣称全部原生Reslice模块完成。帮助也没有证明原版插值、边界、Euler顺序、FOV或性能内核。

## 用户操作模块

工作台右侧新增Online Reslice区：

1. “显示 MPR 三正交视图”将三个源IJK窗口切换为三张MPR窗口，三维窗口保留；“返回原始三视图”恢复原视图，源影像与Mask不变。
2. “三点定义平面”先在当前影像/Part上取三个不同且不共线的点。初始未开MPR时，可直接在原始三视图取点；第三点有效才切换到MPR。共线第三点保留前两点供重试，Escape取消，不创建新体积或Mask。
3. 轴位/冠状/矢状预设以及世界坐标X→Y→Z右手角度可改变方向；输出宽高是采样数。采样尺寸调整不应把恢复后的斜平面暗中复位为XY，角度会从保存的u/v/normal恢复，包含±90度万向节情况。
4. 在任一MPR窗口滚轮，按其自身法线及毫米层间距平移平面；Ctrl滚轮缩放，右拖平移画面。MPR定位以精确world毫米保存，不自动改变原图整数IJK定位；明确点击“同步到原始三视图”才转换并定位原图。
5. 选择测量/文字工具，在重采样窗口直接放点、拖动、编辑Properties和标签。当前分割写入仍在源IJK视图，选择分割工具返回原切片；这不是已实现任意MPR画笔修改Mask的声明。

## 采样与物理坐标模块

`MprPlane={origin,u,v,size}`中，origin为输出sample(0,0)的world毫米中心，u/v为每一个输出像素的完整world步向量，正sample-y朝上；两步向量非零、正交但允许不同长度。每个输出sample真正经过完整world→voxel仿射反解，支持旋转、平移、各向异性、shear、reflection与源单位归一化；源IJK仿射显示仍是另一条管线。

FOV根据源半体素支持盒八角投影。三个视图方向为(u,v)、(v,n)、(n,u)，n是u×v单位法线；第0张保持保存plane精确clone，另外两张围绕同一世界中心拟合FOV。滚动一张平面沿其signed normal更新基础frame，不改两种crosshair或源数组。

| 数据 | 当前独立采样政策 |
|---|---|
| 灰度 | 可选三线性/nearest；定量有效域为源体素中心盒，域外或正权NaN贡献显示无效 |
| 独立Mask | 各自nearest、半体素支持域；重叠Mask分别alpha叠加，不合并成单标签 |
| 密度 | 使用相同物理采样plane和当前灰度插值方式，读原始灰度，不受窗宽窗位/颜色影响 |
| 资源 | 每边≤16,384，总输出≤4,194,304像素，helper输出预算≤128MiB；非法/取消不返回半结果 |

修复了线性密度路径中零权NaN污染的实际极端反例：相乘下溢为0的权重不再读取NaN贡献，正权NaN仍排除。该证据不是“所有NaN策略等同原版”的证明。重采样当前由视口同步调用，helper有取消回调和资源预算；大体积真实浏览器响应性及后台调度仍需独立验收。

## 标注与测量对象模块

测量新增可选`mprPlane`，与旧`plane:{axis,index}`互斥；points仍为world毫米，source/labelOffset合同不变。MPR与IJK/Part之间的自由距离、角度等继续保留真实world点和逐点Part来源，不把混合点强绑到某一切片或最后Part。Area与Density保持同一物理采样平面。

普通测量只在原物理面共面时显示。Density在u/v方向保持一致时随当前面沿normal平移显示及统计，raw角点和plane不被滚片修改，也不增加Undo/dirty。实际方向变化（包含微小角度）不会误分类为纯滚片，旧ROI不在新方向伪装成有效区域。拖动/批量编辑一次提交，预览与已提交数据分离；world标签偏移、原始来源和源数组保持。

`volume/revision/mprRevision/mprPlane`共同隔离旧输入。即使切走再返回同一几何plane，旧pose事件也不能重放；滚片事件同样验证epoch。关闭MPR后，三维Part仍可在对象自身保存的物理面上编辑其椭圆/标签；这类world事件不冒充已关闭MPR窗口的输入，明确的旧MPR事件仍被拒绝。

## 工程与生命周期模块

`viewState.mpr={enabled,plane,step,interpolation,crosshair?}`保存完整采样frame及精确world定位点，旧工程无字段仍合法。MPR plane/view严格验证plain稠密finite数组、未知字段、正交与预算；ZIP、history、复制和Properties草稿深拷/冻结所有向量及size。Properties metadata不允许覆写plane。源NIfTI header/affine、大小端、单位、原始体素和Mask均不被在线重切片修改。

## 实际验证

最终完整回归 **489/489通过**，生产构建通过，bundle为`index-CFyWRjl0.js`。全量含原协作/服务器测试，不是489项原生工具。证据：`../evidence/mpr-regression.log`、`mpr-build.log`；控制器专项另存`mpr-controller-current.log`。

新增53项分别为：数学/采样16、严格工程/Properties10、实际workbench/Worker工作流9、视口SFC8、独立useMprView复核10。独立world-linear灰度场解析oracle、source nearest字节、signed scroll、量测与ROI、世界坐标保存、pose返回、Part关闭后编辑等均有实际执行。父Workbench编译VNode另验证三实例、全部world事件路由、IJK/MPR切换、定义点与Part草稿隔离。

主审发现并修复：旧scroll未验证epoch；恢复角度控件与已存斜面不一致；微旋转被宽松dot容差误判为同方向；滚片后的Density标签与历史plane比较而被误拒绝。对应反例已通过，不只依据代码存在。

首次生产构建在系统TEMP中删除esbuild临时文件被拒，失败日志保留`mpr-build-first.log`。改用已解析验证位于工作区的专用TEMP/TMP目录后构建成功；环境变量仅本次构建进程有效，未改全局配置。Vite的大于500kB体积提示不是构建失败。

preview进程11063本轮确认仍running，未重启。CUA连接状态观察再次30秒超时，已结束本轮MPR浏览器阶段；没有新浏览器画面、文件落盘或原Mimics数值对照证据。完整Ctrl交互、曲线/新工程重切片、MPR分割写入、真实文件及全浏览器验收仍未完成。62工具与16跨链路范围、基础gate=false和总体active目标保持。
