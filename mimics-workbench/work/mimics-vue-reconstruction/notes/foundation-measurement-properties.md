# 测量/文字属性状态与工程保存

范围仅 `types.ts`、`project.ts`、新增 `useMeasurementProperties.ts` 与自属 `tests/mimics-measurement-properties.test.ts`。控制器接线和对话框/绘制由其他代理负责，本轮未操作浏览器。

原证据：`help/text/Mimics Reference Guide/Add Text Annotations.txt:3` 描述先点 2D/3D anchor，再弹 Properties 输入文字；7/15/23 行分别说明 Arrow Style、Text Rotation、Text alignment，37 行说明双击编辑。`Annotation.txt:7/15/23/31` 列出 Name/Visible/Object/Text，61/65/73 行说明 Properties/Duplicate/Locate。本模块不据此声称所有原版枚举或默认样式已完整恢复。

保存契约：新增可选 `MeasurementObject.annotationStyle`，支持应用约定 `{arrow:'none'|'arrow'|'dot',rotation:number,align:'left'|'center'|'right'}`，仅 annotation 可使用。rotation 直接保存，不归一化，必须有限且在 [-360,360]；未知字段/枚举/缺字段拒绝。旧 v1 对象没有 style 仍合法，不自动补默认。工程 decode、encode、validate 与 history 均检查样式并独立复制，其他字段、跨对象引用与历史预算规则保留。原测量对象验证提取为 `validateMeasurementObject(m,dims)` 供编辑器复用，避免每次文字编辑扫描全部影像/Mask。

`useMeasurementProperties({state,selectedMeasurementId,busy,volume,commit,fail})` 返回 draft/editingId 和 openCreate/openEdit/apply/cancel/duplicate/toggle。

- openCreate 不发布对象、不提前选择未发布 ID；Apply 后才一次 commit，再选中新 ID。Cancel 不产生 dirty/history。openEdit 选中已有对象并建立深拷草稿。
- 表单只能传 name/text/color/visible/annotationStyle，其他字段明确拒绝。draft 的几何、类型、ID、attachment 冻结只读；existing Apply 从当前 live 对象取 points/controlPoints/plane/partId 等，再只合并合法属性，防止旧表单覆盖新 anchor。
- 非法 Apply 保留草稿、通过 fail 报错且不 commit。已有对象无属性变化时关闭草稿，返回 false，无事务。显式 text/style=undefined 移除该可选字段；name/color/visible=undefined 拒绝。
- busy、volume 引用变化或正在编辑的测量被删除时同步关闭草稿。无影像、对象不存在、ID 重复或附件跨对象类型的动作拒绝。相同 volume 对象被复用于新文档时，调用者仍须在 install/cancel 中显式 editor.cancel；root 已按此接线计划处理。
- 后续按 root 安全策略补充：仅对未提交的新建草稿，源 Part 不存在时拒绝打开，草稿期间删除源 Part 时同步取消并在 Apply 再核验；已提交的历史孤立注释仍可编辑/保存附件与世界坐标。
- duplicate 深拷 points/controlPoints/plane/style，保留 attachment/pathMethod，一次事务后再选择副本。toggle 仅翻转当前对象 visible，一次事务。commit 回调按控制器契约须同步发布状态；回调在提交前抛错时编辑器保留草稿、不选择未发布 ID。

验证：

```text
node --experimental-strip-types --test tests/mimics-part-provenance.test.ts tests/mimics-measurement-properties.test.ts tests/mimics-project.test.ts
36 tests, 36 passed, 0 failed
```

其中 properties 10 条覆盖真实 ZIP/旧对象兼容、样式非法输入/历史原子拒绝、history 样式隔离、deferred creation/Cancel、表单只改 metadata 并保留最新 live 几何、非法与无变化、busy/换文档/删除、深复制、toggle、optional 删除、失败 commit，以及新建草稿源 Part 删除。原工程 21 条继续全部通过，另有 provenance 5 条。

后续来源复查轮次 `npx vue-tsc --noEmit` 已整体通过（exit 0）；本模块未修改其他代理的组件。专项验证纯 Vue 状态、真实工程 encode/decode 与 history；不代替对话框键鼠、双击、样式绘制或浏览器最终验收。
