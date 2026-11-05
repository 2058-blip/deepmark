# 局部 Threshold 三范围

本轮独立新增 `src/mimics/useLocalThreshold.ts` 和 `tests/mimics-local-threshold.test.ts`，未修改 useWorkbench、Workbench 或其他代理文件。

## 原始证据

- `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Edit Masks.txt:62`：明确写有三组 threshold ranges，中间是当前活动 Mask 的 default，且不可更改；自定义值通过上下箭头选择、双击数值、输入后 Enter。
- 同文件第 64 行：局部编辑区内，范围内像素加入 Mask，范围外已有成员移除。第 66 行明确区分单张影像局部编辑与 Segmentation 菜单的全数据集阈值。
- 对应原始帮助 `.../chm/Mimics Reference Guide/Edit Masks.htm:79` 包含相同三范围说明，81 行引用 `../Resources/Images/Threshold.png`。
- 已直接查看原帮助 `chm/Resources/Images/Threshold.png` 与 `EditMasks.png`：显示 Threshold1/Threshold2、带 default 的中间行和上下箭头；截图示例数值为 226/1613。截图不能证明通用默认常数，本实现没有把 1613 或该组合硬编码为原版默认值。

## 模块接口与规则

```ts
useLocalThreshold(activeMask, volume)
// 返回 slot, ranges, range, choose(slot), update(slot, bound, value), reset()
```

slot 为 `0|1|2`，默认 1。ranges 三项各含 `{lower,upper,editable}`；中间只读，0/2 为相互独立的自定义草稿。range 只返回当前所选项的 bounds。choose/update 返回 boolean，非法 slot、bound、非有限值、lower>upper 或试图修改中间项都返回 false 且不改变旧值；允许相等和有限小数。修改未选中的自定义项不会改变有效 range，供控制器按当前选择执行局部编辑。

两个自定义草稿初始克隆中间范围。活动 Mask ID、保存 threshold 的数值或 volume 引用变化时同步 reset 并返回中间项；改名、颜色、体素 revision 或同值数组快照不清除草稿。显式 reset 也只改模块自己的本地状态。

没有 stored threshold 时使用现有应用 fallback：`Math.min(volume.max,226)..volume.max`，这是本应用约定，不能声称来自原版证据。没有影像时使用 `0..0` 中性占位并拒绝自定义编辑，同样不是原版默认。模块没有 global params 引用，也不写 Mask.threshold、体素或其他源 metadata。

## 验证及边界

根后续已完成controller接线，并新增`tests/mimics-local-threshold-controller.test.ts`实际笔刷专项7/7通过：三项范围、global参数隔离、范围内成员同时增删、ROI外/其他层/重叠Mask保持、一次Undo/Redo、stored threshold不变、重命名草稿保持、有效范围改变/换目标/取消原子性与真实Worker工程保存。该专项还复现“编辑未选范围误取消笔画”，根将取消监听改为按实际源值比较后通过。完整集成306/306与生产构建通过，见`../evidence/multiple-edit-regression.log`和`multiple-edit-build.log`。这些是代码与Worker证据，不是原版阈值数值对照或所有浏览器局部编辑手势验收。

```text
node --experimental-strip-types --test tests/mimics-local-threshold.test.ts
6 tests, 6 passed, 0 failed
```

覆盖只读默认、两个自定义项独立、选择后才生效、源数据不变、非法更新原子拒绝、相等/小数、Mask/threshold/volume 变化 reset、无关属性不 reset，以及缺省和空影像状态。测试发现 Vue 直接把 shallowRef 作为多源 watch 源时会强制触发，从而在无关属性更新时错误清空草稿；现改为读取 volume 的 getter 源，回归通过。

`npx vue-tsc --noEmit` 本次没有 useLocalThreshold 类型错误，但全局检查当时因其他代理尚在接线的 useWorkbench/Workbench 字段而失败；本轮没有替其他代理修改那些中间态。测试验证独立 Vue 状态模块，不包含浏览器按键/双击、笔刷/轮廓实际局部阈值应用或全局参数接线验收，后者由主代理整合。
