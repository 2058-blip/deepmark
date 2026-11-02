# 编辑器参考图实施验收

当前结果：passed。最终截图与参考图已做同视口全图和局部合成比较，无待修复 P0/P1/P2 问题。

## 对比目标与证据

- Source visual truth: `/root/.codex/attachments/8dd0a345-ceec-41d8-8810-ba1dd46293e4/B0AA66430E82F384FB2C502D83FDC5C4.png`。
- 参考图 1672 × 941 px；浏览器 CSS viewport 1672 × 941，deviceScaleFactor = 1，截图同为 1672 × 941 px，无缩放归一化。
- 展开状态比较布局：左右卡片展开、浅色顶栏/标签栏/工具栏、深色影像与协作区域。初始状态按用户要求两卡片收起，与参考图的展开状态有意不同。
- 使用隔离测试账户与程序生成的 NIfTI 胸部练习影像；病例、成员、标签和同步信息来自真实 API。参考图中的医生照片、虚构姓名、CT 内容和没有实现的功能不复制进产品。
- 首轮 full-view comparison: `/dsh/deepmark-reference-ui/iteration-1/comparison-expanded.png`。
- 首轮 focused comparisons: `/dsh/deepmark-reference-ui/iteration-1/comparison-navigation.png`、`/dsh/deepmark-reference-ui/iteration-1/comparison-collaboration.png`。

## 第一轮发现（blocked）

| 级别 | 位置与影响 | 修复 |
| --- | --- | --- |
| P1 | 现有生产后端没有新版病例详情 GET，更新前端后可能无法进入病例 | 详情 404 时回退到带权限检查的 status.dataset；其它错误不回退 |
| P2 | 先展开右侧协作再最大化，CSS 优先级留下空白宽度；告警随正文隐藏 | 最大化归零规则提高优先级，最大化仍展示协作告警并可返回查看 |
| P2 | 桌面缩窄后标签侧栏仍展开并覆盖导航 | 监听 1000px 断点切换，窄屏自动收起，按钮仍可手动展开 |
| P2 | 影像左上间距显示浮点尾数 `1.399999976158142` | 最多三位小数，去除尾零 |
| P1 | 切换病例下载失败会提前断开当前协作 | 下载准备完成后再切换；晚期失败恢复原影像并重新核验原任务权限 |

## 第二轮复验与发现（blocked）

- 第一轮五项已修复，使用当前生产 JAR 的独立副本通过 74 项浏览器断言。
- 后修复证据保存在 `/dsh/deepmark-reference-ui/iteration-2/`，包括 `both-expanded.png`、`narrow.png`、`maximized-expanded-collaboration.png` 与 `result.json`。
- [P2] 最大化时底部总页数字色被旧选择器覆盖，深色背景上对比不足：增加最大化专用 `.slice-page-total` 浅色规则。
- [P2] 新增病例导航的加载错误沿用普通文档流提示，会挤压全高工作台：改为编辑器固定浮层，并提供关闭按钮。

## 最终复验（passed）

最终浏览器截图均在 `/dsh/deepmark-reference-ui/`：

- Implementation screenshots: `both-expanded.png`、`default-collapsed.png`、`final-default.png`，1672 × 941 px。
- Full-view comparison: `comparison-expanded.png`（3344 × 973 px，32px 标题区；左右保持原始 1:1 尺寸）。
- 默认收起状态对比：`comparison-default.png`，其默认卡片状态按用户要求与参考图不同。
- Focused comparisons: `comparison-navigation.png`（左 rail、标签卡片、病例导航）与 `comparison-collaboration.png`（在线成员、活动、同步卡片）。已逐一打开并目视对比，不能只从全图推断细节。
- 最大化、错误浮层：`maximized-expanded-collaboration.png`、`failed-case-download.png`，1672 × 941 px。
- 窄屏：`narrow.png`、`narrow-case-expanded.png`、`narrow-collaboration-expanded.png`，CSS viewport / screenshot = 900 × 900、deviceScaleFactor = 1。
- 只读：`readonly.png`，1672 × 941 px。

| 必检表面 | 对比与结论 |
| --- | --- |
| 字体与排版 | 参考图为粗体中文无衬线层级；实现使用系统 Inter / Noto Sans CJK SC / 苹方 / 微软雅黑回退。保持品牌、任务标题、面板标题、标签和元数据层级；中文无缺字，长病例名截断带 title，长标签自然换行。功能参数比图稿略紧凑以保留现有窗位/工具设置，这是已接受的产品适配。最大化总页数已改浅色，可读。 |
| 空间与布局 | 顶部64px、rail64px、标签238px、展开病例174px，两侧展开时左侧合计476px，与图稿约470px接近；右侧288px。默认病例与协作各48px收起，为影像释放空间。横向工具栏、单幅主图、底部信息栏与参考图布局关系一致。900px自动收起标签，无横向或错误状态纵向溢出；最大化右侧无空白。 |
| 颜色与视觉token | 青绿主色 `#13b8b5`、浅色面板、淡绿标签卡片、深色影像 `#080c11` 与协作 `#191e21` 对应参考风格；同步绿色、错误暖红、独立键盘焦点环可区分。保持真实标签自定义色。 |
| 图像、图标与资产质量 | 沿用真实 Canvas 医学影像渲染，无截图铺底或伪造照片；低分辨率测试影像的块状外观来自128×128体素夹具，不是UI资产压缩。图标使用 Phosphor Vue 官方库，统一尺寸与线宽。品牌保持项目 DeepMark，成员头像显示真实账户首字，未复制图稿虚构医生身份。 |
| 文案与内容 | 病例、切片数量、标签、创建者、成员和同步来自真实API；空活动明确提示，无模拟动态。原工作空间详情/画笔说明/空气开关保持移除，灰度轮廓仅对应工具显示。界面保留项目支持的实际功能和权限，不添加参考图中尚不存在的测量/三维/邀请功能。 |

验证记录：

- Vue 类型检查与 Vite 生产构建通过；41/41 Node 测试通过。
- Chromium + 与生产一致的 Java JAR 隔离实例：78/78 断言通过，`result.json`；无浏览器 JavaScript 错误。真实用户注册、上传、认领、WebSocket同步均在临时目录，生产数据未用于测试。
- 左右卡片默认折叠；按钮与键盘 Enter/Space 展开、关闭，aria-expanded / aria-controls 与可见内容一致。
- 两处页码输入 Enter/失焦跳转、Esc恢复、上下界限制、小数/空输入恢复，滚轮与滑块保持同步；只读账号可翻片且不生成标注修订。
- 单幅、主辅、三列和最大化/恢复；协作先展开后最大化；900px断点往返；旧五项设置回归。
- 已确认旧生产后端病例详情404会回退status200。模拟第二病例下载503，原影像、页码、修订和可写协作均保留；错误提示不挤压工作区，可关闭。
- 10类病例故障分支验证通过，`case-recovery-result.json`，涵盖401/403/500不回退、缓存命中、晚期恢复与恢复失败只读。

## 接受的差异与验证边界

- “类似参考图”按产品适配实施；DeepMark品牌、现有窗位/灰度工具和真实任务内容优先保留。参考医生照片、虚构标签/活动、示例CT内容不作为逐像素目标。
- 参考图未提供窄屏、错误或只读状态；这些状态以现有功能、可用性与一致性验收。
- 现有历史成果、协作权限与生产账户不迁移；大体积CT、多电脑网络和全部断网续传场景未在本轮重新全面压测。
- 无剩余行动项 P0/P1/P2；未来如增加账户头像，可在当前真实首字头像位置接入。

## 实施清单

- [x] 两侧卡片默认收起且可展开。
- [x] 单幅大图、浅色横向工具栏、青绿标签与深色协作区。
- [x] 两处页码输入及只读浏览。
- [x] 修复全屏宽度、页数对比、响应断点、浮点尾数、旧接口兼容与切换失败提示。
- [x] 同视口全图/局部比较与浏览器状态复验。

final result: passed
