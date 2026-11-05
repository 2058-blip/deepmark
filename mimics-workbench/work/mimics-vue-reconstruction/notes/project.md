# 工程 ZIP 与撤销事务验证

本次直接审查并修复 `src/mimics/project.ts`，新增 `tests/mimics-project.test.ts`。未修改 useWorkbench、Workbench 或 ImageViewport，未使用 HTTP、原始病例或原版程序执行。

## 修复内容

- Part 的 normals 原先未保存；现在作为独立 little-endian float32 条目保存和回读。
- DICOM 的 HU/GV、MONOCHROME1、窗宽窗位元数据原先在 decode 中丢失；现在验证白名单后恢复，原始 quantitative 值不变。
- mask/part 的 `opacity=0` 原先被 `||` 默认值改写；现在精确保留，并拒绝越界或非有限透明度。
- 项目数值数组使用明确 little-endian 编解码，不依赖宿主 typed-array 字节序；NIfTI 原始 header 的大小端仍保留以供标签导出。
- 原预算只计 after 新 buffer，漏掉删除对象、旧版本、normals；现在按历史实际保留且不属于当前活跃状态的 backing buffers 去重计费，加序列化元数据长度估计。单笔超预算也会移除；默认最多 1000 条事务。预算 0 明确禁用历史保留。
- 历史对 descriptor、threshold、测量点和 plane 创建快照，避免外部 metadata 变更影响撤销。体素/网格 typed arrays 按不可变数据契约共享，编辑者必须先复制再改；本实现没有伪装提供对任意 in-place buffer 修改的防护。

## 验证与资源边界

解压前检查 ZIP 声明尺寸、条目数、重复/越界路径；默认压缩包最多 512 MiB、单条解压最多 512 MiB、总解压 1 GiB、10000 文件，project.json 最多 8 MiB。`decodeProject(bytes, limits?)` 可在测试/应用中进一步降低限制。默认上限不是浏览器可用内存保证；解压、校验和 JSON 构建仍是同步操作，浏览器级耗尽恢复需继续验收。

fflate 的 inflate 本身不验证 CRC，因此额外校验 central directory、长度和每条 CRC32。当前工程采用普通单卷 ZIP；ZIP64 和分卷明确不支持。项目格式为 deepmark-mimics-workbench v1；其他版本拒绝。

影像 data 长度、所有 float32 的有限性、metadata min/max、NIfTI header/dims/affine/单位的一致性均检查。用单体素 header probe 复用 core 的 qform/sform 与原始空间单位规则，避免再分配完整图像。`volumeGrid` 才把 native metre/micron affine 的全部 3×4 元素统一到 mm，原 header 和 native affine 仍用于原格式导出。

独立 mask 必须是 0/1 数组，尺寸与影像一致，阈值有序、revision 非负。Part 的索引/三角结构、法向长度和有限性验证；来源 revision 字段类型验证。测量类型、控制点数量、三维有限坐标、切片上下文、对象 ID 唯一和活动对象引用都检查。

删除来源 mask 后 Part 的 sourceMaskId/sourceRevision 可作为历史 provenance 保留；删除 Part 后测量的 world-space 锚点仍有效，允许保留孤立的 partId。应用需要提供孤立关联的提示/清除策略，此项未因解码允许而宣称完整实现。项目目前不持久化相机、窗位显示状态、任意 MPR plane、地标模板或时间相位，SYS04/SYS07/SYS08 继续为 partial/未完成。

v1 现在增加兼容旧文件的 optional `centerlines/polylines/selectedCenterlineId/selectedPolylineId`。CenterlineObject 保存独立 graph、名称/颜色/显隐与来源版本；PolylineObject 保存独立 ContourSet、同样的对象属性。读取中心线时调用 `validateCenterline` 拒绝错误节点/路径/集合或闭环编辑图；轮廓检查 image dims、axis/plane、每层分量、有限点/范围、实际 signed area/物理面积/周长、parent 关系无环、父轮廓包含、洞层级与方向。两者的元数据历史快照与预算估算一并涵盖。

曲面距离对象的 `controlPoints` 与 dense `points` 独立保存，前者至少两个有限三维点；`pathMethod='edge-graph'` 仅允许 surface-distance。历史也复制约束点，防止拖动外部数组改变旧事务。旧 v1 不含这些 optional 字段时原样恢复，不强制升级。

## 已执行证据

`node --experimental-strip-types --test tests/mimics-project.test.ts`：初版8/8；增加中心线、轮廓和曲面测量约束的持久化/损坏输入测试后为11/11。

1. 完整 ZIP 往返：重叠 mask 独立、revision/threshold/显隐/零 opacity、Part 索引/顶点/normals、测量点/文字/附件、恢复 buffer 与源独立，再保存再恢复。
2. metre/mm/micron × little/big endian：工程保留 native header/affine，工作 grid 为毫米，标签 NIfTI 再导出回读一致。
3. DICOM MONOCHROME1/HU/窗宽窗位保存，定量值不变。
4. 一条历史事务同时 source cut、新 target、annotation；Undo/Redo 原子还原，Undo 后分支清空旧 Redo。
5. 外部 metadata 修改不污染历史；buffer 共享的不可变契约明确测试。
6. 删除大 mask/mesh/normals 的预算计费、超大单笔淘汰、零预算、条数上限和 clear。
7. 错版本、缺条目、错长度、NaN、非二值 mask、错 min/max、header/affine/unit 冲突、无效 opacity/kind/plane/ID/活动引用拒绝。
8. 解压前限制、路径、CRC 损坏、JSON 损坏拒绝。

初次合并运行 `node --experimental-strip-types --test tests/mimics-*.test.ts`：59/59 通过。后续补充质心弦长、几何/LiveWire 分支和实际 worker-thread/composable 集成测试后，同命令为 70/70；`npx vue-tsc --noEmit` 通过。worker 测试覆盖取消后立即重跑、阈值预览/应用/撤销、三维→STL→工程恢复和临时画笔选区；它们不执行浏览器 WebGL、拾取或 pointer 事件。证据不能替代全部工具 UI 或原 Mimics 输出比对。requirements.json 按此界限初步更新，未标任何项 complete。
