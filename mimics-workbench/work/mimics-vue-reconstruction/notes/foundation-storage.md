# 基础缓存队列与文件保存验证

本轮新增 `tests/mimics-storage-transfer.test.ts`。经主代理确认文件所有权后，只对 `workspaceRepository.ts` 的保存队列以及 `fileTransfer.ts` 的 abort 清理做了小型修复；没有修改原生 IndexedDB 数据库适配器或推进高级算法。

## 已复现并修复的问题

1. 原保存队列只有一个全局 `next`。A1 正在写时，依次 enqueue B1、A2、C1，会互相覆盖不同文档的待写快照。现在按 document ID 各自保留最新 pending，底层仍串行写入。
2. 原保存错误也是全局变量。A 写入失败后 B 成功，会清掉 A 的错误，让等待 A 的 flush 误成功。现在错误按 document ID 隔离，`flush(snapshot)` 针对该文档核验结果；同文档更新的成功可以恢复先前失败，其他文档的成功不能掩盖失败。
3. drain 改为微任务启动，确保 `running` 先赋值，即使自定义 repository 同步抛错也不会把已完成的 Promise 留成永久运行状态。通知观察者异常不会停止其他文档写入，或把已成功的持久化误记为失败。
4. `failed` 回调现在接收 `(error, snapshot)`，保持一参回调兼容；主代理可用 snapshot.id 避免旧文档失败污染当前文档界面。
5. 原文件 abort 清理只吞异步 reject；abort 同步 throw 会掩盖原 write/close 失败。现在对清理单独 try/await/catch，保留主要写入失败。

最初受控测试为 10/12：跨文档 pending 丢失与 flush 错误被掩盖两个测试失败。修复后补同步 storage/observer 与同步 abort 测试；abort 回归先复现原始错误被遮盖，再修复为全部通过。

## 测试证据与边界

```text
node --experimental-strip-types --test tests/mimics-storage-transfer.test.ts
15 tests, 15 passed, 0 failed
```

- 用可手动 resolve/reject 的受控 repository 验证异步写入期间合并最新快照、跨文档隔离、单并发写入、flush 暴露本 ID 失败、显式重试与失败期间的新快照恢复。
- 用受控 Window/showSaveFilePicker 验证先选路径再 produce；取消不 produce；选定名称和 MIME/extension 正确；只写 Uint8Array 的有效视图范围；close 未成功前不能返回 written。
- 验证 picker、produce、createWritable、write、close 失败传播；abort 缺失、reject 或同步 throw 时都保留原始 write/close 错误。
- 用受控 anchor/URL/计时器验证不支持 picker 或非安全上下文的 fallback：只报告 download-started，触发下载后移除 anchor，并延迟释放 object URL。它不是磁盘写入凭证。
- 补充分类分割导入：多个标签各自保留为独立成员数据；NaN、Infinity、小数、负值、65536、全背景拒绝；实际分配预算边界和超过 256 类别拒绝。
- 补充几何匹配：native metre/mm/micron × little/big endian 转成相同毫米坐标后匹配；平移、尺寸、未知空间单位和 NaN affine 不匹配。
- 主代理修复 segmentationImport 后增加回归：NaN、Infinity、负值、小数及不安全整数预算不能绕过上限；100000 mm 原点处的 0.5 mm 平移和长图像上的累积 affine 漂移都被拒绝，小量浮点舍入仍可匹配。

这些测试没有操作真实 IndexedDB、系统文件选择器或磁盘权限，也没有执行浏览器下载接收验收。它们只证明队列时序、导出状态和数值校验的函数行为。真实原生存储和路径选择验收由主代理另外执行。

另外审查发现的 segmentationImport 预算与几何容差问题已由主代理修复，本代理只增加对应测试。新几何比较检查八个体素支撑边界角点，使用绝对容差和物理 spacing 的小比例，避免把巨大 world origin 当作误差尺度。
