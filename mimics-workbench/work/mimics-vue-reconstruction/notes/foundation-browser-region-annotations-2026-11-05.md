# 区域生长、测量与文字属性：真实浏览器记录

仅使用cua_repl访问已授权的`http://127.0.0.1:5173/`，输入为既有合成练习工程，不含患者数据。本轮没有使用原生文件窗口、上传、磁盘另存为或原Mimics。主操作页1501583373；最终构建的新页面恢复为1501583374（已作为可查看的工作台输出保留）。

## 区域生长与来源

- 从真实本地副本恢复1 Mask、1 Part。活动Mask为32,424体素、48,636 mm³，阈值226–650、revision2；Part为66,856三角形。
- 进入Region Growing，Source明确为Mask 1，Target为New，Multiple开启、6连接、Leave Original开启。轴位骨壳内点击种子，得到第二个非空Mask；原活动Mask继续显示32,424，没有自动激活目标。
- 选择已有目标“区域生长”，关闭Leave Original，同位置点击：Source Mask 1变0体素、revision3；Target仍作为独立Mask显示。Part几何仍为66,856面，出现“源 Mask 已修改”提示。截图`../evidence/browser-region-stale-part.jpg`。
- 一次Undo恢复原Source为32,424体素、revision2。点击交换按钮后Source为“区域生长”、Target为Mask 1，活动Mask未因此改变。再次从非活动Source点击移动，随后手动选择该Source，实际显示0体素；这检查生长输入来自Source控件而非全局活动Mask。
- 两次Undo回到开始的1 Mask/1 Part，关闭区域生长。保留New选择项、无变化不创建历史等更细生命周期属于本应用明确约定，原帮助证据和控制器10项覆盖见`foundation-region-workflow.md`。

本轮未实际操作26连接、三种单层方向、背景种子或在途参数更改；它们的Node/Worker证据不升级为浏览器验收。

## 二维距离与文字属性

- 轴位两个点创建距离34.04 mm；拖第二端点后44.25 mm，一次Undo恢复34.04 mm。
- 点选文字工具和二维位置后先出现Annotation Properties草稿；测量对象数仍为1。Cancel关闭后不新增注释，Undo描述未变。
- 第二次创建：名称“二维核验注释”，两行完整合成文本，Dot、30°、Center。Apply才增加到2个测量对象。属性窗口截图`../evidence/browser-annotation-properties.jpg`。
- 图中长文显示三个点，圆点引线与旋转标签可见。双击实际二维标签再次打开Properties，值完整恢复；canvas的title通过只读DOM属性核对为完整两行原文，AX Help也包含全文。没有把这一属性核对夸大成原生系统tooltip像素验收。
- 编辑既有注释为−15°并在文字后追加“（已编辑）”，Apply不增加对象，Undo描述为修改属性。Duplicate增加一个独立对象；隐藏副本后其按钮变Show、对应覆盖层消失，原注释仍显示。

## 三维附着与恢复

- 在现有Part表面点选，Properties默认名称来自该Part，确认前对象数仍为3。填写“三维核验注释”/“三维表面附着注释”，Apply后为4个测量对象；3D中出现箭头引线和标签。截图`../evidence/browser-annotations-2d-3d.jpg`。
- 实际拖动表面锚点后用Locate核对：IJK从33/21/38变47/20/41；一次Undo再Locate恢复33/21/38。对象数保持4，Part仍66,856面。
- 等到本地副本保存完成，打开最终构建新页面，经本地工程恢复：1 Mask、1 Part、4个测量对象；距离34.04 mm；二维原注释、隐藏副本（Show按钮）和三维文字均保留。
- 从恢复后的二维注释打开Properties，直接核对Dot、−15°、Center和含“（已编辑）”的完整两行文本。完整AX见`../evidence/browser-annotation-restored.ax.txt`；截图`browser-annotation-restored-properties.jpg`。
- 取消属性编辑并Locate二维注释，位置为IJK40/38/34。最终工作台截图`../evidence/browser-annotations-restored.jpg`及AX`browser-annotations-restored.ax.txt`。旧Undo历史不在缓存恢复承诺内，没有把新页空历史当数据丢失。

主操作使用构建`index-B4ed6EnT.js`；最终新页恢复使用`index-D-MhWraW.js`。后续差异为模式互斥/hover及弹窗校验等收口；没有宣称全部鼠标步骤都在最后构建上重新执行。最终完整项目回归359/359及生产构建通过，日志`region-properties-regression.log`/`region-properties-build.log`。

## 未完成项

真实文件选择/导入和磁盘写入仍未验证；本轮成功的浏览器操作没有解除此前原生URL识别限制。角度/直径/椭圆/面积/密度及所有取消组合、多对象端点关联、三维文字双击等仍需各自补浏览器证据。新建注释删除来源Part后取消、历史孤立附件、派生Part旧来源继承有控制器/保存测试，未在本轮逐个操作浏览器。字形测量、三种arrow样式、默认值、长文阈值和mode冲突策略是明确应用实现，并非已证明原版所有数值/交互枚举一致。

完整基础gate与原62工具/16跨链路目标仍未完成，不以本轮部分闭环代替。
