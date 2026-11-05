# 541 检查点：交互式 MPR、RP 对象与后台采样

本文补记暂停前已完成、恢复后已核对的稳定结果。完整`npm test`为541/541通过，生产构建通过，bundle=`index-5j05-rMT.js`，独立后台资源=`mprSampling.worker-DZopFQvd.js`。证据为`../evidence/mpr-interactive-regression.log`及`mpr-interactive-build.log`。总数含原协作/服务器用例，不等于541项原生功能验收；恢复后新增的三维RP显示/边框手柄由后续报告另行验收。

## 原生操作与 RP 数据对象

`Along Plane2`确认Ctrl抓蓝轴旋转、抓中心平移；蓝枢轴与原图/视图交线独立，普通滚片不移动它，最后交互位置保存为Reslice Objects中的RP。`Reslice Objects`确认选中即活动对象，以及New/Delete/Properties/Duplicate。实际拖动映射、抓取半径和提交时序没有原版代码/运行对照，当前本地预览、释放提交为应用约定。

实现采用`ReslicePlaneObject{id,name,kind:'plane',plane:MprPlane}`及唯一`selectedResliceId`。RP定义和浏览切片位置分开：普通滚片只改MPR视图，不写RP、不加历史；Ctrl旋转/平移、属性几何修改各一条事务。三点定义每次新增RP，保留先前活动对象。低层`setPlane`仍可做不创建对象的视图操作，用户New/三点/交互入口则存对象。

在原IJK和MPR窗口按住Ctrl可抓蓝中心/轴；退出交互模式恢复原Ctrl画笔尺寸操作，Ctrl滚轮仍缩放。RP中心可离当前显示平面：先做物理正交投影再绘制/命中，拖动仍保留真实world枢轴的法向距离。已修复层间shear下直接world→IJK再忽略法向造成的错误斜投影，明确反例为K5、pivot(8,4,0)应落I3/J4，而不是I8/J4。

Properties使用物理中心、世界XYZ角度、完整像素support的毫米宽高；采样点数只读。Apply延迟提交，Cancel无变更，较新live几何不会被旧表单无修改字段覆写。对象/历史/ZIP深拷，RP和既有Mask/Part/Measurement等ID不冲突；现存RP不能被误认成Part/Mask来源，真正缺失历史来源仍兼容。已有物理RP也阻止直接重新解释未知影像单位。

## 后台采样

三张MPR共享一个per-volume resident Worker，源影像和Mask只复制自有slice后transfer，原数组不detach。源data身份、几何以及各Mask的id/data/revision决定resident版本；颜色、透明度和纯元数据变化只重绘，不重新采样。无版本的同buffer裸写不保证可见；同buffer且Mask.revision递增有反例覆盖。

prepared sampler在源初始化时验证与预计算，避免每个输出strip重复扫描全源Mask；同一generator核心每4096输出像素让出执行，处理取消和新请求。每owner只接受最新结果，旧文档/旧源/旧位姿不覆盖新图。Worker失败显示错误，不回退到同步主线程伪装成功。单pane显式重试会恢复三个owner；失败、取消、销毁会撤销已排队恢复，避免盲重试和空白peer。

稳态额外resident约一份`4N+ΣMaskBytes`，另有主视口输出/Canvas及既有其他模块内存；单active输出预算128MiB不是整个进程内存上限。

采样优化暴露的半整数回归已用原解析oracle复现和修复：world(6.3125,-13.375,35)对应IJK(2.5,2,1.25)，nearest应取(3,2,1)，而浮点运算顺序曾使其落到下格。`nearestVoxelCoordinate`仅在half附近2 binary-ULP内归一为向正无穷tie，其余保持Math.round；MPR灰度/Mask/密度及同步原IJK共用。该规则是明确独立数值约定，不认证原Mimics边界等价。

## 证据边界

真实Node Worker覆盖共享源、latest结果、取消/替换、失败恢复与独立半值oracle；真实controller覆盖对象事务、Undo/Redo、故障回滚、旧pose拒绝及ZIP；SFC覆盖蓝轴Canvas/命中/拖动与父界面接线。最末本地HTTP检查`mpr-preview-http.json`证明首页包含541构建、Worker资源200且text/javascript；它不是浏览器渲染/实际指针或磁盘文件证据。

完整三维RP手柄/边框调整、MPR Mask写入、曲线CPR、新重切片工程、全部浏览器和原软件对照仍未在本检查点完成。原62工具+16跨链路范围不变，基础gate仍false。
