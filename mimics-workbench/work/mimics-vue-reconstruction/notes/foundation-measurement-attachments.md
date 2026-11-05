# 逐点 Part 附件与 Mask 反向来源

范围：独占 `types.ts`、`project.ts`、`useMeasurementProperties.ts`，新增 `measurementAttachments.ts` 和 `tests/mimics-measurement-attachments.test.ts`。未修改 useWorkbench/Workbench/viewport 或测量计算核。root/viewport 分别负责实际选点和绘制接线。

原脚本 IAddPoint3D 可逐点关联 IStl 是本轮需求依据；以下字段名、null 语义、summary 与反向来源保存规则是本应用的明确契约，不声称恢复了原版工程的同名序列化结构或全部历史政策。

## 逐点附件

`MeasurementObject.pointPartIds?: (string|null)[]` 与 points 等长，null 表示图像/未关联 Part，字符串是可保留的历史 Part ID。仅非 surface-distance 类型可使用；曲面路径继续使用单一 partId。若 partId 与数组同时存在，每项都必须等于 partId；混合 Part、null 或图像点不能被最后一个 Part 的 summary 覆盖。旧对象无数组时继续沿用 partId，无法凭旧数据恢复此前未保存的逐点来源。

helper API：

```ts
measurementPointPartId(m,index): string|null
measurementPartIds(m): string[]
uniformMeasurementPartId(ids: readonly (string|null)[]): string|undefined
```

首个函数以已存在的数组为准，不会把 null 回退成 summary；无数组时使用旧 partId，越界返回 null。第二个函数过滤图像点、去重并保留首次出现顺序。uniform 仅在非空且全部为同一非空字符串时返回 ID，null/空/混合返回 undefined。

encode/decode/history/duplicate 与属性草稿均复制数组，不能把全部条目误改为 m.partId。readonly 草稿冻结该数组，Properties 白名单不能覆写它；metadata Apply 继续保留当前 live points/ref 数组。新建草稿核验全部来源 Part，任意一个被删除则取消；图像点不构成 Part 依赖。已提交的孤立附件仍可编辑、复制及保存，不删除世界坐标。

## Part → Mask 来源

MaskObject 新增可选 `sourcePartId:string`。addMask 第五参为 `source?:PartObject`，创建时必须在当前 state.parts 中找到相同 ID 和相同 mesh 对象；已删除或已替换几何的捕获源拒绝，无半状态。四参调用保持原样，传入非当前 selected Part 也只记录明确传入的来源。

此字段是历史来源，不增加或推测 sourceRevision/sourcePartRevision。当前应用的 Part 后处理生成新 ID，因此记录 ID 足以区分该次来源；这不是完整衍生历史图或原版存储政策声明。

两类新引用均允许已删除 Part 的历史 ID；若引用 ID 仍存在却属于 Mask/measurement/curve 等其他类型，则严格拒绝。pointPartIds 长度、空 ID、非字符串/null、稀疏/undefined 元素、错误 summary、surface-distance 与未知字段均拒绝。新增约束同样保护 history push，失败不会清掉已有 Redo。

## 验证

```text
node --experimental-strip-types --test tests/mimics-measurement-attachments.test.ts tests/mimics-measurement-properties.test.ts tests/mimics-part-provenance.test.ts tests/mimics-project.test.ts
44 tests, 44 passed, 0 failed

npx vue-tsc --noEmit
exit 0
```

其中新专项 8 条覆盖跨 Part distance、Part/图像混合 angle、uniform diameter、旧附件及 surface 路径、ZIP/Undo/Redo、数组隔离、严格负例、反向 Mask 创建守卫、metadata 编辑/duplicate、删除任一来源取消新建与图像点无虚假依赖。固定两点 (0,0,0)/(3,4,0) 在保存恢复后仍为距离 5；此检查只说明几何未被元数据改写，不验证点是否实际位于声明网格表面。

本轮未操作浏览器，也未验收最终 pointer/raycast、跨对象控制器选点或各视图显隐策略；后者由 root/viewport/audit 的接线测试负责。
