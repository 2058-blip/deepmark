# 测量选择与阈值面板状态

本轮只修改 `useWorkbench.ts` 的相关 helper、commit/undo/install 和两个同步 watch，新增 `tests/mimics-foundation-state.test.ts`；没有改动并行代理维护的选择区操作、params 或界面组件，也没有操作浏览器。

已复现两个问题：删除选中测量或撤销新增测量后，独立 `selectedMeasurementId` ref 仍指向不存在对象，实际工程导出快照会被严格 schema 拒绝；选择 Mask、恢复工程或撤销阈值应用后，面板 lower/upper 没有跟随对象 threshold，可能显示默认值或另一个 Mask 的范围。

修复方式：

- 测量集合或选中 ID 变化时同步检查选择，不存在的 ID 立即清空。commit、Undo/Redo、install 也清理嵌入 `state.viewState` 的悬空选择，避免返回状态本身无法通过 `validateProject`。仍存在的选择保持不变。
- install 读取活动 Mask 的已存 threshold；切换 Mask 或这两个阈值数值改变时同步面板。没有 threshold 的对象使用原有新工程默认值。
- watcher 比较 ID 和两个原始阈值数值，无关的改名/颜色等 metadata 更新不会丢弃尚未应用的面板草稿。

验证：

```text
node --experimental-strip-types --test tests/mimics-foundation-state.test.ts
5 tests, 5 passed, 0 failed
```

修复前五条测试均失败，修复后全部通过。覆盖选中测量删除及 Undo/Redo、撤销新测量、无效选择事件、实际 worker 工程保存与 decode/validate、ZIP 恢复、按 Mask 切换阈值、新建/复制/删除 Mask 与 Undo/Redo、实际阈值预览/应用、内存缓存恢复，以及无 viewState 的旧工程重置选择。

测试跨越真实 `operations.worker.ts` 的 Node worker-thread 边界；文件写入结果与缓存使用受控内存替身。它验证控制器与数据链路，不代表浏览器指针、界面视觉、真实 IndexedDB 或磁盘选择器验收。
