# 浏览器：斜切LiveWire到三维和本地恢复

日期2026-11-05。仅访问已授权的`http://127.0.0.1:5173/`，只使用应用自带96×96×64合成练习影像（1/1/1.5mm），不运行原Mimics、不上传患者资料。本记录是实际Edge扩展浏览器操作；不将Node/SFC测试冒称浏览器证据。

## 环境与版本

旧preview会话11063已不在工具进程表中；进一步获准的本地只读检查确认5173无监听并拒绝连接。因而在完成本轮构建后重新启动`npm run preview -- --port 5173 --strictPort`，得到会话**2627**，绑定127.0.0.1。不是因为观察超时而重启。

CUA库存恢复可用，沿用Edge browser3。原操作新页**1501583395**，恢复新页**1501583396**。后一页实际DOM中的模块script为`/assets/index-CRqnicsV.js`，与本轮构建一致。仅使用浏览器API；没有重复已知原生URL识别/文件权限失败、没有扩大扩展权限。

## 实际步骤与结果

| 步骤 | 实际观察 |
| --- | --- |
| 加载自带合成影像，显示MPR，Y方向25°并应用 | 三幅256×256线性重采样MPR、独立RP及三维RP边框可见；I/J/K仍48/48/32。 |
| Lasso直线拖动 | 明确报告投影点不能全部共线；Mask保持0、r0，Undo仍指向此前调整方向。仅证明退化路径拒绝，不是自由轮廓正例。 |
| LiveWire四锚点，Draw，点击面板闭合 | 锚点及黄色/候选路径可见；未闭合时仍0体素；闭合得到**346体素、519mm³、均值52.29、r1**。 |
| Undo→Redo | 实际0/r0→346/r1；Undo/Redo名称为MPR轮廓绘制。 |
| Operation=Erase，同四锚点，Enter闭合 | 得到**0体素、r2**；Undo恢复346/r1。 |
| Operation=Threshold，自定义1=50至60，同四锚点，Enter | 得到**56体素、84mm³、均值53.8、r2**；Undo346/r1、Redo56/r2。面板默认行仍226至650。 |
| 新放一个未闭合锚点后Escape | 当前轮廓取消按钮消失，Mask仍56/r2，没有新增可撤销的Mask操作。 |
| 三维重建→Calculate 3D→Optimal→Calculate | 得到**284三角形、表面积134.07mm²、网格体积74.13mm³、开放边0、非流形边0、连通分量1**；Calculate完成窗口仍在，Close另行关闭。 |
| 新页面→本地工程→恢复17:55:13的当前工程 | 实际IndexedDB恢复1Mask/1Part/1RP，56/r2、84mm³、均值53.8、284三角形、Y25°、256²、线性采样、窗位300/宽1400和IJK48/48/32；恢复页无Undo历史符合当前工程设计。 |

四个绘制锚点来自屏幕观察的MPR1图像范围：(510,290)、(580,290)、(580,350)、(510,350)。它们是这一截图/窗口尺度的记录，不能当通用坐标或自动化定位契约。原始采样矩阵保持96×96×64。

关于阈值的边界：上述“默认226–650”是局部阈值面板的当前默认行；此新建未经过全局Threshold的Mask在Calculate3D表中原阈值属性显示“—”。不能把面板默认行误说成已保存的Mask.threshold=[226,650]。保存阈值元数据不被局部编辑修改的断言由独立控制器夹具验证。

## 保存的证据

- [绘制后截图](../evidence/browser-mpr-livewire-draw.jpg)、[完整AX](../evidence/browser-mpr-livewire-draw.ax.txt)。
- [擦除后完整AX](../evidence/browser-mpr-livewire-erase.ax.txt)、[阈值后完整AX](../evidence/browser-mpr-livewire-threshold.ax.txt)。
- [表面统计完整AX](../evidence/browser-mpr-contour-surface.ax.txt)。中间`browser-mpr-contour-surface.jpg`仍捕获Calculate3D窗口画面，不用于证明Close后的即时画面；最终恢复截图另有完整证据。
- [新页恢复截图](../evidence/browser-mpr-contour-restored.jpg)、[恢复完整AX](../evidence/browser-mpr-contour-restored.ax.txt)。恢复页3396已markDeliverable；原操作页3395未标记，可能被自动清理。

截图由CUA直接获取，原字节是JPEG，因此按.jpg保存，未改图。恢复图清楚显示Mask统计、三幅MPR、Y25°、RP和三维模型/284三角形状态；这是本次最终浏览器交付图。

## 未完成的浏览器验收

当前公开浏览器动作只有两端点drag，未提供持续按住的多点自由轨迹；本阶段仅验证直线Lasso退化拒绝。没有通过自定义注入事件、隐式应用方法或另一套窗口控制规避限制。自由Lasso正例保留未验收，数学/真实Worker/SFC正例单独列证。

LiveWire双击闭合、全部参数/跨三个视图、全部异常/中途取消矩阵、其他MPR画笔/测量/RP手柄、实际文件选择与磁盘导出/回读均未在本阶段逐项实测。浏览器UI统计不是源体素逐项独立oracle，不能宣称完整原版或临床等价。完整62+16与基础gate继续未完成。
