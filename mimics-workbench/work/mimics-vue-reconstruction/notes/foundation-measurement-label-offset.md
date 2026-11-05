# 非注释测量标签偏移保存契约

新增可选 `MeasurementObject.labelOffset?: Vec3`：相对几何 label anchor 的**世界毫米位移向量**，不是绝对标签点、体素坐标或屏幕像素。仅非 annotation 测量可用；annotation 继续既有样式契约。参考空间是本应用明确选择，不声称原软件用相同字段或存储方式。

types/project/useMeasurementProperties 已接入：

- 必须普通 Array.prototype 数组、长度 3、稠密的有限 number；拒绝 typed array、子类/异常原型、null、稀疏、undefined、NaN/Infinity、访问器与额外属性。访问器在求值前即拒绝。其他未知 measurement 字段仍拒绝。
- encode/decode/history 深拷向量；旧对象没有字段仍保持缺省，显式 `[0,0,0]` 可保留。NIfTI native m/mm/µm 与原始大小端不会再次缩放该世界毫米向量。
- duplicate 和待创建对象独立复制。Properties draft 冻结向量及其字段，metadata Apply 不允许传 labelOffset（包括 undefined），按 live 对象保留最新偏移，避免旧表单覆盖已移动标签。普通属性无变化时不新增事务。
- Cancel、busy、换 volume 等生命周期不发布半对象；点坐标、逐点 Part 来源及附件保持原契约。

验证：

```text
node --experimental-strip-types --test tests/mimics-measurement-label-offset.test.ts tests/mimics-measurement-attachments.test.ts tests/mimics-measurement-properties.test.ts tests/mimics-part-provenance.test.ts tests/mimics-project.test.ts
50 tests, 50 passed, 0 failed
```

其中新专项 6 条覆盖所有非 annotation 类型、六种原始单位/字节序组合、旧文件与零向量、严格负例、ZIP/history/duplicate 隔离、只读草稿、metadata 拒绝几何 patch/保留较新 live offset，以及创建与取消。未新增重复数值算法测试，未改 controller/Workbench/Image/Part。

本轮 vue-tsc 未报告独占文件错误；当时全局因并行 PartViewport 的 CapturedGesture 必填字段接线中间态未通过，最终联检由 root 完成。本证据证明保存和状态契约，不代表标签的屏幕定位、拖动 hit-test、相机/切片投影或浏览器交互已验收。
