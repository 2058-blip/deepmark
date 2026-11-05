# 浏览器：工程重切片、实际下载与新页恢复

2026-11-05，仅在已授权`http://127.0.0.1:5173/`使用自带合成影像。本轮沿用Edge3；新操作页**1501583400**，最终恢复页**1501583401**，后者DOM模块明确为`/assets/index-wufMiC31.js`。预览原会话为2627；本阶段没有因观察超时而重启。原Mimics未执行，浏览器权限及下载目录设置未更改。

## 文件保存的实际边界

先在旧661构建的已保存合成工程页3396点击原“保存工程”，界面返回保存取消，源仍56体素/284面。未再次尝试此前失败的原生窗口URL识别或扩大file URL权限。

717构建增加显式“下载副本”正常用户入口，默认另存为不变。第一次在点击下载前注册download事件，事件监听20秒超时；随后界面只报告“已发起下载”。**没有据此判断文件失败或成功，也没有再次点击同一下载。** 对确切任务文件名进行只读检查，发现浏览器使用既有桌面下载位置，生成时间与操作吻合。复制到工作区后逐文件独立解析；物理文件存在、内容正确的证据来自文件本身，不来自“下载开始”文案。

| 用户点击的下载入口 | 桌面实际文件 | 字节 | 时间 |
| --- | --- | --- | --- |
| 原工程副本 | `C:/Users/wwulli/Desktop/合成练习影像.deepmark.zip` | 93644 | 19:00:00 |
| 原Mask NIfTI | `C:/Users/wwulli/Desktop/Mask 1.nii` | 1180000 | 19:02:07 |
| 原Part STL | `C:/Users/wwulli/Desktop/Mask 1 3D 1.stl` | 14284 | 19:02:55 |
| 恒等新工程 | `C:/Users/wwulli/Desktop/MPR-reslice-717-identity.deepmark.zip` | 94546 | 19:05:32 |
| 旋转并更新CS的新工程 | `C:/Users/wwulli/Desktop/MPR-reslice-717-oblique.deepmark.zip` | 81869 | 19:10:32 |

只复制明确的这五个任务文件作为证据，保留桌面原件。未读取浏览器profile/download数据库，未改变下载路径，未将脚本造出的文件冒充浏览器输出。应用依旧返回download-started，不会因外部核验而假装收到written回执。

## 工程级操作实测

源从本地副本恢复：96×96×64、1/1/1.5mm、Mask56/r2、Part284面、1RP、Y25°MPR、IJK48/48/32、窗位300/宽1400。

1. 打开Reslice Project，默认Update CS关闭、复制世界对象开启；宽高96mm、pixel1mm、层距1.5mm、线段从(47.5,47.5,0)到(47.5,47.5,94.5)。三幅MPR显示体框真实切线，三维显示完整框。
2. 名称`MPR-reslice-717-identity`，Generate后得到96×96×64新结果，灰度出界0。源标题/几何不变，未自动打开；下载标准新ZIP，确有矩阵TXT。独立核验589824灰度及全部Mask、Part数组零差异。
3. Draw Line时面板自动收起且不挡图像。MPR1在(490,300)和(590,360)实际点击两点，依次显示1/2、完成后展开参数；世界坐标约(33.897595,54.870835,54.576059)→(61.369799,36.683335,41.765561)，层数预览24。旧结果被参数变化清除，源对象没有提交。
4. 选择本应用世界X方向快捷设置，起点(0,47.5,47.25)、终点(95,47.5,47.25)、up=(0,1,0)；绕线30°、宽高96mm、pixel2mm、dz1.5mm、Update CS开启、仍复制世界对象。生成`MPR-reslice-717-oblique`，结果48×48×64、1Mask/1Part、灰度出界24448；源仍96×96×64。另行下载该ZIP。
5. 显式“打开新工程”后才切换源。新头48×48×64、2/2/1.5mm；Mask16/r3、96mm³、均值52.19；原有284面Part按刚体坐标变换保留，并明确提示源Mask已修改。该Part是保留的历史模型，不能称为从新16体素Mask重新重建的模型。
6. 新页面打开本地副本列表，同时看到原合成工程96×96×64和新工程48×48×64。恢复新工程后，Mask16/r3、Part284、RP1、MPR256²及其新坐标系方向、IJK23/24/32、窗位300/宽1400均保留。更新CS后保留RP的Euler显示约Y−65°、Z−30°，不是原世界坐标下的Y25°。

重采样后Mask由56×1.5=84mm³变为16×6=96mm³，是本例最近邻换网格的实测差异；不能宣称体积守恒或临床等价。原工程及其桌面ZIP仍保留原56成员。复制模型的统计由74.13显示为74.12mm³，坐标按Float32变换后与独立计算一致；不将显示舍入作为原版误差认证。

## 证据和未验收项

- [实际绘线AX](../evidence/browser-reslice-project-line.ax.txt)、[生成参数/结果AX](../evidence/browser-reslice-project-generated.ax.txt)。生成时截图`browser-reslice-project-generated.jpg`仍捕获导出busy画面，不用于证明当时所有按钮已恢复。
- [显式打开后AX](../evidence/browser-reslice-project-opened.ax.txt)、[源与新工程共存列表](../evidence/browser-reslice-project-copies.ax.txt)。
- [最终恢复截图](../evidence/browser-reslice-project-restored.jpg)、[完整AX](../evidence/browser-reslice-project-restored.ax.txt)。3401已markDeliverable，3400未标记可能被自动清理；CUA阶段已完成`Verified resliced project recovery`。
- [文件与核验README](../evidence/browser-file-exchange/README.md)、[独立解析主审](foundation-browser-reslice-independent-oracle-2026-11-05.md)。

实际浏览器文件选择、从这些磁盘ZIP重新导入网页、原生Save As写入回执、单独TXT另存为、3D/原始视图绘线、全部参数/错误分支未逐项实测。浏览器cache恢复不是磁盘ZIP重新导入，两者明确区分。旧IJK Polyline和剪切密度ROI的迁移与原版算法对照继续未完成；完整62+16和基础gate不完成。
