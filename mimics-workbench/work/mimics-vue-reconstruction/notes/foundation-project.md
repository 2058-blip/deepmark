# 基础工程数据、Undo 与保存恢复

范围：仅修改 `src/mimics/project.ts`、`tests/mimics-project.test.ts` 和本说明。没有读取原 Mimics/患者工程、启动原程序，或推进 volumeMesh、temporal、pulmonary 等高级算法；原 App 的协作 query 与控制器由主代理维护。

## 可供主代理使用的 API

```ts
import {validateProject, encodeProject, decodeProject} from './project.ts';
import type {ProjectState, ProjectViewState} from './project.ts';

validateProject(volume, state); // void；无效输入抛错，不修改输入
const bytes = encodeProject(volume, state);
const restored = decodeProject(bytes);
```

`validateProject` 用于从 IndexedDB 等可信内部存储读取后的重新核验，与 ZIP 读取共用同一个恢复/验证内核，不进行 ZIP 压缩/解压，也不复制体素、Mask 或 mesh 的 typed-array 数据。它仍会遍历这些数值，构建少量对象描述符、小型 header probe 和 JSON 元数据预算，因此是同步 CPU 操作。

`ProjectState.viewState?: ProjectViewState` 是旧 v1 格式的可选扩展：

```ts
interface ProjectViewState {
  point?: [number, number, number]; // dims 内的整数体素中心，不是世界坐标
  window?: {center: number; width: number}; // center 有限，width 有限且 > 0
  activeAxis?: 0 | 1 | 2;
  renderMode?: 'parts' | 'volume';
  tool?: string; // 仅当前工作台已实现的工具 ID 可通过校验
  selectedMeasurementId?: string; // 空串，或现有 measurement ID
  tab?: 'segmentation' | 'surface' | 'measurements' | 'analysis';
}
```

当前工具枚举包含 navigate、threshold、region、dynamic、paint、erase、local-threshold、lasso、livewire、multiple、boolean、morphology、cavity、fill、largest、smartExpand、crop、distance、angle、diameter、ellipse、area、density-rectangle、density-ellipse、annotation、surface-distance、select、deselect、centerline。

旧 v1 没有 viewState、centerlines 或 polylines 时保持缺省，不强制补入虚构对象。viewState 的保存、ZIP 恢复和 history 快照已实现；主代理仍需在控制器中捕获/应用这些字段。

## 本次修复

- 保存前先校验完整输入，避免生成下一次无法打开的工程；IDB、ZIP decode 与 encode 使用同一组对象规则。
- 对已支持的影像、DICOM、工程、Mask、Part/mesh、测量/plane、中心线及轮廓的嵌套 schema 明确拒绝未知字段；额外且未引用的 ZIP 二进制条目也拒绝。不会假装保存未实现的新高级对象，也不会静默丢弃它们。
- 不依赖 JSON.stringify 的隐式转换：拒绝非有限数、稀疏数组、循环、非普通对象、访问器、symbol 等不能忠实恢复的元数据。
- 保留多个重叠二值 Mask、revision/threshold/显隐与 opacity=0，Part 顶点/索引/normals、来源版本，以及测量点、标注、附件和曲面约束点；现有可选中心线与 Polyline 完整保留。
- 保留 DICOM MONOCHROME1、HU/GV 和窗宽窗位，定量体素值不作显示反转。NIfTI 原始 header 的 m/mm/µm、native affine 和大小端保留，工作 grid 使用毫米；ZIP 数值条目继续明确采用 little-endian。
- NIfTI probe 现在继续验证原 datatype、bitpix 与灰度缩放，并校验原始数据偏移和方向标记；不会以改写 probe 类型/缩放掩盖损坏的 header。
- 对现有来源 Mask，拒绝 sourceRevision 晚于它的 revision；允许更早的 revision 表达过期 Part/轮廓，也保留删除来源后的 provenance。来源/附件 ID 若指向现有的另一种对象类型则拒绝。
- Mask/mesh 基础构建操作对尺寸、二值性、阈值、版本溢出和非法网格先拒绝；输入状态不被修改。
- viewState 创建独立历史快照；事务快照/序列化失败先于栈修改，因此失败不会清掉 Redo 分支。运行时将历史预算改成负数/NaN 也在栈修改前拒绝，避免无限 prune。
- 保留现有 backing-buffer 去重预算与元数据估算、零预算、单笔超预算淘汰和条目上限。typed arrays 仍遵守不可变契约：编辑前复制 buffer，history 不对外部任意 in-place 数值修改提供隔离。

## 验证

仅运行本代理负责的测试：

```text
node --experimental-strip-types --test tests/mimics-project.test.ts
21 tests, 21 passed, 0 failed

npx vue-tsc --noEmit
exit 0
```

覆盖原有 ZIP/资源限额/CRC/损坏文件、m/mm/µm × 大小端、零透明度、重叠 Mask、DICOM、normals、高级可选对象、历史预算和分支；新增 viewState 往返与历史隔离、IDB 风格输入验证、保存前拒绝无效数据、未知字段/额外文件拒绝、来源版本/类型关系、无效操作原子拒绝和运行时预算拒绝。

新增一条完全合成的基础数据集成测试：`convertSeriesToVolume → 两个独立重叠 Mask → calculateSurface → Part → 0.5 mm 测量 → 单笔 Undo/Redo → ZIP encode/decode`。它核验数据链路，不替代浏览器交互、WebGL/拾取或原软件结果比较；本代理未运行全测试集或应用构建。

默认工程资源边界仍为压缩包 512 MiB、单条 512 MiB、解压总量 1 GiB、10000 文件、元数据 8 MiB。保存/内存验证也检查对应默认预算；这些上限不是浏览器可用内存保证。
