# 测量预览、几何提交与标签更新审核

本轮在 labelOffset 保存契约完成后，只读审查 root 的 `previewMeasurementGeometry`、`updateMeasurementGeometry`、`updateMeasurementLabel` 和既有 controller tests。仅新增 `tests/mimics-measurement-editing-audit.test.ts`；三处 controller 修复由 root 完成，本代理未修改 controller 或视口。

## 发现并修复的真实边界

1. **原始标签偏移被复制洗白。** 原 updateMeasurementLabel 先 `[...offset]` 再校验，会把 Float32Array 或带额外属性/访问器的数组转换成普通 Vec3。root 现先对原始 offset 调用严格对象 validator，再复制；新回归验证三种 payload 均拒绝、访问器求值次数为 0，state/revision/dirty/history 均不变。
2. **预览与提交的平面约束不一致。** 原 preview 接受整体位于 z=2 的有效多边形，却声明当前 plane z=1，显示有效数值；release 才拒绝。root 现让 preview 使用与提交相同的 worldToVoxel 点在 plane 上的检查。它仍可接受 schema 合法但几何自交/退化的临时候选以显示 invalid reason；这不代表可提交，release 的 evaluator 会拒绝非法 Area/Ellipse。
3. **旧 uniform 附件绕过点数变更限制。** 原 gate 只检查 pointPartIds.some，旧无数组但带 partId 的 area 可增删点，违背本应用“仅 image-only area 可改点数”政策。root 现统一用 measurementPartIds(found).length，同时拒绝 legacy 和逐点 Part 来源的改点数；不自动抹掉来源。

对应源码入口为当前 `useWorkbench.ts` 的 previewMeasurementGeometry（约 :503）、updateMeasurementLabel（约 :517）和 updateMeasurementGeometry（约 :538），以函数名为准。

## 保留的契约

- preview 只影响临时结果/数值标签，不写原始 measurement、image、Mask、dirty、revision 或 history；保存使用 committed state，实际 worker ZIP 不含预览。
- geometry release 独立校验 Area/Ellipse 的有效性。image-only area 合法 4→5→3 点时，pointPartIds 同步保持等长全 null；保留 labelOffset。标签移动只更新 labelOffset，不改变点和来源数组。
- 三个实际操作（插入、删除、移动标签）各是一条事务，Undo/Redo 分别恢复完整的 geometry/offset/source metadata，ZIP 再读取一致。
- preview 与 release 都检查 volume/revision/current slice；模式、切片、对象变化、Properties 和显式 cancel 清除预览。视口额外负责 pointer capture/鼠标状态，本审核不替代其事件验收。
- root 另发现并修复 surfacePath 重算覆盖用户属性和 labelOffset 的问题，并新增真实 worker 回归；本代理未重复编写该项。

## 执行证据

```text
node --experimental-strip-types --test tests/mimics-measurement-editing-audit.test.ts tests/mimics-measurement-editing.test.ts
15 tests, 15 passed, 0 failed
```

其中本代理新增 4 条：raw label payload、wrong-plane preview、两种 Part 来源 area 点数拒绝、image-only area 增删/label/Undo/Redo/worker ZIP 正例。root controller suite 当次已有 11 条，包含无效新增几何、曲面路径 metadata、3D ellipse draft token 及取消后相同轴重建的旧 payload 拒绝。

本轮使用真实 composable/controller 和 Node worker export，小合成文件。没有浏览器或原 Mimics 运行比对，也不以 controller API 通过代替原生 Area/Ellipse 全部鼠标交互完成。独立 labelOffset/schema 套件此前联跑为 50/50；它与这里的 15 条是分别执行的相关检查，不冒充一次全量应用验收。
