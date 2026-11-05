# 本次发布快照验证

日期：2026-11-05。测试和构建在独立的 mimics-workbench 副本中执行，未切换或修改原开发工作区。

- 完整测试：797/797 通过，0 失败、0 取消、0 跳过。
- 类型检查：vue-tsc --noEmit 通过。
- 生产构建：Vite 通过，128模块，主包 index-B8dulRLO.js；存在大于500kB的分包提示，不是构建失败。
- 依赖：复用本机已安装的依赖目录进行验证，没有重新执行在线 npm ci；新机器仍按锁文件 npm ci 安装。
- 浏览器：本次发布没有重新做完整浏览器验收，保留的浏览器证据属于各自历史构建。

## 发布副本中的唯一测试修正

首次快照运行得到796/797通过。实际Workbench新增STLCoordinateControls.vue后，tests/mimics-viewport.test.ts的子组件替身列表尚未包含它，Node测试加载.vue失败。本发布副本只在该列表追加STLCoordinateControls，未改变业务实现或断言；之后完整797项通过。原开发目录没有应用这行修改。

源码清单保留捕获时SHA256；snapshot-manifest.json中的publicationAdjustments列出发布副本的额外变更。

## 日志

- [最终测试日志](work/mimics-vue-reconstruction/evidence/publish-snapshot-test.log)
- [类型检查和构建日志](work/mimics-vue-reconstruction/evidence/publish-snapshot-build.log)

这些797项包含原有协作/服务端用例，不等于797项原版Mimics验收，也不证明所有功能、原版数值或临床等价。历史进度文档中的717及更早数字属于相应检查点；本文件只报告本次冻结快照的结果。
