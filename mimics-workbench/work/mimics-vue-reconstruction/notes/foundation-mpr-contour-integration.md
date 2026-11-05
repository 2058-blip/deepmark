# 任意MPR的Lasso与LiveWire：实现和主审

2026-11-05。当前检查点 **661/661全量测试通过，类型检查与生产构建通过**。主包`index-CRqnicsV.js`，运算Worker`operations.worker-DGg-ign_.js`，共享采样Worker仍为`mprSampling.worker-DZopFQvd.js`。主代理整合三位Sol xhigh子代理的几何、视口与独立审计成果。本阶段没有运行原Mimics。

## 用户操作与原生证据

- Lasso按住左键连续描绘，松开闭合，按当前Draw/Erase/Threshold作用活动Mask；中途取消不提交。支持聚合轨迹和最终抬起点，源Mask保持独立。
- LiveWire逐次点击锚点，移动时沿现有路径树显示候选；至少三个不同锚点后Enter、双击或面板按钮闭合。每个新锚点在后台计算新路径树，等待时保留当前会话，不接受重复锚点/完成。不可达点明确拒绝，绝不以端点直线代替缺失路径。
- 源数据、平面、工具、Mask或有效参数变化取消当前轮廓；Ctrl蓝轴与Shift定位优先，普通Ctrl不意外新建轮廓。文字和测量标签不抢分割输入。
- 局部阈值只读原始源体素灰度，绘制/擦除/阈值均只在最终候选集合中修改活动Mask；其他重叠Mask不受影响。操作松开/闭合后一次提交，一次Undo可回退；无变化不增加历史。

原帮助直接记载Lasso拖放和LiveWire锚点吸附、活动Mask及三种Operation。**二维LiveWire的具体完成手势、任意RP源Mask写回核尚未由原版证据恢复**；Enter/双击和以下物理规则是明确的独立实现。XZ/YZ可编辑、Area可在MPR测量，均不能扩大成所有原生MPR分割已确认。详[原文边界审计](foundation-mpr-contour-native-boundary-audit.md)。

## 几何、灰度和资源

`mprContour.ts`采用完整仿射的源体素中心投影、闭source-cell slab和MPR完整FOV，沿用上一阶段画笔的物理覆盖政策；平面穿过源切片中心退化为单层，半层接触允许两层。轮廓用含边界的奇偶填充，支持凹轮廓、自交和零有符号面积的蝴蝶结；至少三个不同且非共线的投影点。局部逆仿射包围盒限制扫描，返回唯一升序索引，不读灰度、不改源。

`mprLivewire.ts`在后台重采样原灰度及有效支持，建立局部`[w,h,1]`网格，物理间距来自平面u/v长度，复用现有LiveWire内核。无效支持为图障碍；结果仍是局部整数路径，再映射回冻结物理平面。高斯预处理的原生精确性缺口继续保留，显示插值会影响路径特征，最终局部阈值仍取源灰度。

轮廓默认最多100万扫描/100万候选/800万边处理，硬上限800万/400万/6400万；最多65,536个点。边预算对包围矩形候选与边数作保守前置检查，可能早于更小精确区域拒绝。LiveWire输出最多1,048,576像素，超过明确报错，不暗中降低采样。上述限制是当前工程预算，不是原版默认或大体积响应性认证。

## 异步、所有权与撤销

`useMprContour.ts`使用既有单运算Worker，不额外常驻复制一份源体积。会话冻结安全递增sessionId、活动Mask、源buffer及版本、Volume身份、工程版本、MPR姿态、物理平面、Operation和有效参数。无关参数不会取消；有效范围或LiveWire参数变化同步取消，旧异步参数通知不能误清后来会话。

所有Point/Hover/Complete/Cancel都要求完整匹配当前会话；无效/旧事件忽略。已接纳ID高水位拒绝重放Begin。取消只终止自己持有的`mpr-contour-*`任务，不杀后续全局阈值任务。迟到路径树和迟到栅格结果均无法提交或清除新会话。发布的draft与调用者的数组均不共享私有几何。

完成前原Mask不变；首次发现真正不同成员才分配源副本。提交只替换活动Mask一次，源灰度、其他Mask、历史测量、Part及RP不变。真实History.push失败保留源、dirty和Redo分支；预算/分配/后台失败没有部分发布。

## 验证

- 轮廓几何20项、MPR LiveWire适配15项、真实控制器/Worker11项、额外独立所有权审计2项，合计48项。
- MPR视口累计28项，其中新增7项轮廓手势/状态/取消；父Workbench实际SFC用例验证所有props、事件和MPR布局保持。
- [全量回归](../evidence/mpr-contour-regression.log)：661/661、0失败，比606基线新增55项；总数包含旧协作和服务器测试。
- [生产构建](../evidence/mpr-contour-build.log)：112个模块，类型检查通过。使用已验证的工作区TEMP/TMP，仅本构建进程有效。
- [真实浏览器证据](foundation-browser-mpr-contour-2026-11-05.md)：25°斜切LiveWire Draw/Erase/Threshold、Undo/Redo/Escape、3D及新页面IndexedDB恢复。自由Lasso轨迹和全参数浏览器验收仍缺。

完整62工具+16跨链路范围及基础gate未完成。后续优先真实文件导入/落盘/回读、其余基础交互和原版证据缺口；MPR多片编辑、曲线CPR、新重切片工程等继续在范围内。
