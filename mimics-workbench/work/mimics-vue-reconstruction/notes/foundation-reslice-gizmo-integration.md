# RP 三维平面显示与修改：572 整合报告

## 用户流程和原生依据

`Along Plane2`的Properties说明包含Rotate、移动旋转手柄中心，以及Resize时红色边框/边点；`Reslice Objects`将平面作为独立RP对象管理。三维视口现显示选中RP的半透明矩形参考面，即使没有Part也可适配查看。该参考面是编辑覆盖层，不会变成Part或STL三角网格。

在RP对象行或右侧面板选择Rotate/Resize：

- Rotate模式：拖中心在该平面内移动，拖四角绕自身法线旋转；其他方向仍可在Properties使用世界XYZ角度。
- Resize模式：红色边框显示四边及四角手柄。拖边/角以固定中心对称改变毫米范围，输出采样点数不变；中心仍可移动。
- 结束修改或切换工具退出手柄模式。进入蓝轴交互会退出三维修改，反向切换也会退出蓝轴，避免同时写同一个RP。

原帮助未给出精确的三维抓取投影、对称缩放/固定对边选择、最小FOV或提交节奏。这些是本应用明确的独立约定；当前鼠标旋转映射只绕RP自身法线，不声称恢复了原版全部三维旋转环。

## 物理几何模块

新`resliceGizmo.ts`从`MprPlane`生成中心、单位u/v/normal、完整support边界及手柄。若输出宽高为w/h，步长为u/v，物理范围是`w*|u|`与`h*|v|`；像素中心origin不是左下角边界。矩形四角为`center ± w*u/2 ± h*v/2`，单像素也有完整物理面积。

缩放投影到冻结平面的轴向，用相对中心距离决定大小；到达中心时限制正视野，越过后重新扩展而不翻转方向。默认最小FOV为0.001mm，同时服从plane步长验证限制。旋转使用物理中心和有向角；无移动返回保留原数值的clone，不因标准化旧rounded frame新增事务。

三维视口将相机、平面、抓取偏移和版本冻结；拖动只更新局部覆盖层，释放才一次提交。不会把参考面吸附到Part曲面。普通查看模式允许鼠标穿过平面，不抢原网格拾取；临时预览和同一RP提交回显不会自动重设相机。已修复RP适配补偿影响旧Part-only相机的兼容回归，原测试期望保持不变。

## 控制器、历史与布局模块

`e.mpr.beginPlaneModify(mode,id?)`开启模式，`modifyPlane({id,plane,action,volume,revision,resliceRevision})`提交，`endPlaneModify`退出。运行时强制完整文档身份/对象/版本/模式匹配，不只依赖TypeScript字段；蓝轴入口遗漏volume/revision可提交的问题也已补反例修复。

Move保持方向/步长/采样数，位移在原平面；Rotate保持中心、法线、步长和采样数；Resize保持中心、带符号方向及采样数。非法候选、旧事件、非选中对象或提交失败不写半对象，不破坏真实Redo分支。保存对象和现有Measurement.mprPlane互不追写。

三维修改时若MPR布局关闭，提交、Undo/Redo及ZIP恢复仍保持关闭，同时更新隐藏的RP采样配置；选择/激活另一个对象可按既有行为切换布局。蓝轴/三维模式是临时操作状态，安装新工程会清理。普通切片浏览与保存RP几何仍分开。

## 验证证据

完整`npm test` **572/572通过**，`npm run build`通过；当前bundle=`index-yJct2Maa.js`，MPR Worker=`mprSampling.worker-DZopFQvd.js`。日志为`../evidence/reslice-gizmo-regression.log`和`reslice-gizmo-build.log`。首次自动审批等待超时发生在进程创建前，按工具规则重试一次后正常完成，并非代码测试失败。构建使用工作区内、仅本进程有效的TEMP/TMP；Vite体积提示不等于构建失败。

本轮新增31项：解析几何12、Part/RP实际SFC事件13、独立真实controller/Worker审核6。已有父Workbench编译VNode还验证了所选RP而非浏览切片frame的传递、pose版本、完整action路由、对象行/面板按钮和结束模式。测试覆盖非方采样[7,5]的14×15→28×7.5mm缩放、反射/shear、离平面拖动、正视野、90度旋转、相机保持、无移动、取消/陈旧输入、关闭布局下Undo/Redo与实际ZIP，以及故障回滚。

暂停前541阶段的RP对象/蓝轴/后台采样报告已补记为`foundation-mpr-interactive-integration.md`。相关独立明细见`foundation-reslice-gizmo-geometry.md`、`foundation-reslice-part-viewport.md`和`foundation-reslice-gizmo-workflow-audit.md`。

## 未完成边界

恢复后的浏览器连接状态观察仍超时，已结束本轮CUA阶段，无新实机截图/WebGL/指针验证；SFC、Node Worker和构建不替代浏览器验收。当前尚缺任意MPR分割写入、完整旋转环/原版手柄映射、Medcad/Normal plane对象选择、曲线CPR、新重切片工程、实际磁盘文件流及原版同输入输出对照。62工具+16跨链路范围不变，基础gate与整体目标仍未完成。
