# Part 来源与工程恢复一致性

本轮最初只读审查 `useWorkbench.runPart/calculateParts`、`useAdvancedTools`、工程存储和 Part 警告。复现后，经主代理明确授权，仅修复 `useAdvancedTools.ts` 的 cut/split/repair 来源继承，新增 `partProvenance.ts`、自属回归，并补新建测量草稿的源 Part 删除防护。未修改 useWorkbench/Workbench/viewport，未操作浏览器；Workbench 提示接线由 root 完成。

## 已确认与修复

最小例：Mask 当前 r2，Part 保存 `sourceMaskId=m, sourceRevision=1`。原 cut/splitParts 的新对象只复制 name/color，repair(fixNormals/stitch) 直接 addPart，四种路径都把来源变为 undefined。Undo 恢复原 r1；Redo 和 ZIP 忠实保留已经丢来源的输出。因此问题发生在派生对象构建，非 history/ZIP 层。

现在四种路径都复制输入 Part 的已有来源字段，绝不重绑定当前 Mask r2。旧对象仅有 sourceMaskId、没有 sourceRevision 时保持未知，外部/未追踪 Part 不虚构 Mask 关联。其他算法与对象显示属性政策未改。

`partSourceStatus(part,masks)` 返回：

| 条件 | 状态 |
|---|---|
| 没有 sourceMaskId | external，表示未追踪来源，不表示同步 |
| 有 sourceMaskId，但 Mask 不存在 | missing，优先于版本未知 |
| Mask 存在，但没有 sourceRevision | unknown |
| 来源 revision 与当前 Mask 相同 | current |
| revision 不同 | stale |

root 已在 Workbench 接入 helper，分别提示“已删除”“计算版本未知”“已修改”。旧 predicate 对 missing+unknown 的 `undefined!==undefined` 为 false，会完全漏提示；这条路径现在归类 missing。current 只表示来源 Mask 版本相同，不证明平滑/包络后的几何与 Mask 完全相等。

## 完整基础路径审核

| 路径 | 当前来源行为 |
|---|---|
| 单 Mask Calculate 3D | 捕获输入 Mask 的 ID/revision；addPart 要求该来源仍在当前状态且版本一致 |
| 批量 Calculate 3D | 各输出按 worker 回传 maskId 对应输入来源；事务/任务 generation 和 revision 守卫由 runJob 保证 |
| smooth/reduce/wrap | 保留输入 Part 的旧 sourceMaskId/sourceRevision；不会把陈旧来源刷新为当前版本 |
| cut/split/fixNormals/stitch | 本轮修复为同样保留输入来源；没有实现或更改高级几何算法 |
| Part → Mask | 新建独立 Mask，revision=0、threshold=null；源 Part 和已有附件记录保留。后续 attachments 轮次已新增 sourcePartId 历史来源，创建守卫要求源 ID/mesh 仍存在，不虚构 Part revision，也不宣称完整衍生历史图 |
| 编辑/删除 Mask | Part 几何与来源字段不被改写；旧来源成为 stale/missing。Undo/Redo 按完整状态恢复相同 ID/revision |
| 删除/替换旧 Part | 已提交 measurement.partId 及世界 points/controlPoints 保留，不自动重指到新 Part；这是历史附件，可显示“来源模型已删除” |

project 的 Part 快照复制 metadata 与 mesh descriptor，voxel/mesh buffers 仍按既有不可变契约共享。encode/decode 保留来源标量与 measurement.partId；已删除来源允许作为历史 provenance，存在但类型错误的引用拒绝，来源 revision 晚于现存 Mask 也拒绝。存储层没有把未知来源补为新来源，没有删除历史附件。中心线 sourcePartId 也是历史引用，不被自动重定向。

以上来源/孤立引用/Part→Mask 独立对象规则是本应用明确选择。本轮没有原 Mimics 对这些生命周期政策的直接证据，不能声称完整恢复原版来源管理或全衍生历史图。3D 渲染当前会过滤依赖已删除/隐藏 Part 的测量；数据及列表/Locate 保留不等于缺源几何可继续拾取/重新求曲面路径。

## 新建注释草稿安全策略

未提交的新建草稿若锚定 Part 不存在，拒绝创建；草稿期间 Part 被删除时同步取消，Apply 也再次核验。已提交的历史 annotation 仍可编辑和保存其孤立 partId/世界坐标，不受这条新建策略清除。这是 root 明确指定的应用安全政策。

## 验证证据

```text
node --experimental-strip-types --test tests/mimics-part-provenance.test.ts tests/mimics-measurement-properties.test.ts tests/mimics-project.test.ts
36 tests, 36 passed, 0 failed

npx vue-tsc --noEmit
exit 0
```

新 provenance 5 条实际调用 useAdvancedTools 的更新回调，使用字面量 mesh 结果隔离几何算法；验证 keepOriginals 两种路径、旧 r1 对当前 r2、legacy unknown、缺源、external、ZIP、单笔 Undo/Redo、历史附件和拒绝结果无半事务。此证据证明对象构建/恢复规则，不冒充算法 worker、切割封口或原版输出验收。properties 10 条与原工程 21 条继续通过；实际 root annotation workflow 由 audit 另测。
