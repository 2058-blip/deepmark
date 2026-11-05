# 独立导出文件验证器

新增 `scripts/verify-mimics-browser-exports.py`，只使用 Python 标准库（struct、zipfile、json、math、hashlib 等），不导入本应用解析/导出核、不执行 JavaScript、不安装依赖。读取当前 `project.ts` 的 v1 ZIP schema 作为格式契约；几何、数据统计和文件解析独立实现。

```text
python -I -S scripts/verify-mimics-browser-exports.py --self-test --output-json work/mimics-vue-reconstruction/evidence/exchange-sample/oracle-self-test.json

python -I -S scripts/verify-mimics-browser-exports.py --project work/mimics-vue-reconstruction/evidence/exchange-sample/sample.deepmark.zip --stl work/mimics-vue-reconstruction/evidence/exchange-sample/sample.stl --mask work/mimics-vue-reconstruction/evidence/exchange-sample/sample-mask.nii --output-json work/mimics-vue-reconstruction/evidence/exchange-sample/independent-validation.json
```

支持任选输入；提供 ZIP 与另外格式时按 ZIP 的 selectedMaskId/selectedPartId 对比，未选择且只有一个对象时使用唯一对象，多对象无法确定来源时明确报错。成功退出码 0，格式或定量比较失败退出码 1；报告保存输入 SHA256。`-I -S` 用于避开本机 Python 用户 site 注入；此机仍打印 Python 安装位置警告，但上述命令均正常完成且 exit 0。

## 独立检查

- ZIP：CRC、重复/越界路径、资源尺寸、引用条目、little-endian 数值数组、348 字节 NIfTI header 与 JSON 尺寸/仿射/spacing/单位/灰度统计一致性。独立 Mask 必须为 0/1、长度等于体素数，报告每个成员计数、范围、体素 bounds、物理体积及重叠体素数。Part 检查顶点/三角形结构、有限数和索引范围，报告 bounds、面积、边界边、非流形边和边方向冲突。
- 二进制 STL：独立解析 80 字节头、计数与每条 50 字节记录；按解码后精确 float32 坐标焊接，避免把每面的重复顶点误当作开放边。无容差强行补缝。与源 Part 对比三角面数、无向坐标指纹、保向坐标指纹、焊接边拓扑、面积，封闭且方向一致时另比较有向体积。
- NIfTI-1：大小端、dims、datatype/bitpix、offset、slope/intercept、sform/qform、原始单位与毫米仿射、数据统计；与源 Mask 逐体素精确比较，检查 uint16 标签、label intent、单位/方向/字节序保留。

STL 无单位字段；这里依据 Part 的毫米坐标契约进行对比。边拓扑不证明无自交、顶点流形或复杂壳体构成有效实体。封闭体积是有向曲面积分的代数体积绝对值。开放/非流形/退化或方向不一致表面不比较 signed volume，报告 `volume_comparison.status=not_applicable`；开放表面的该积分依赖参考点，不能作为同源失败依据。面坐标、方向、面积与边拓扑比较仍执行。

## 人工 oracle 自检

27 个独立已知正反例通过，结果为 `evidence/exchange-sample/oracle-self-test.json`。夹具在脚本内手工用 struct/ZIP 构造，不来自本应用 roundtrip：单位四面体面积 `(3+sqrt(3))/2`、体积 `1/6`、三开放边三角形、三面共边的非流形、两 Mask 各两成员且一处重叠、m/mm/µm × 大小端、signed/scaled 数据、qform 旋转/reflection。负例含错误成员但计数相同、非法 index、截断、datatype/bitpix、NaN、CRC 和三角形方向改变。

额外开放三角正例在源 Part 中保留未引用 vertex 0，首 face 为 `[1,2,3]`，从而使源 Part 与 STL 的积分参考点不同；仍正确判定相同表面，体积不适用。原有改变 winding 的负例继续拒绝。

## 本批样本结果与证据边界

`evidence/exchange-sample/generation.json` 明确记录来源为 **Node operations.worker.ts；不是浏览器 UI 或文件选择器**。本轮未操作浏览器，不能把该批文件或检查结果称作浏览器落盘验收。

`independent-validation.json` 总结果 `ok=true`：

- 24×24×24，NIfTI uint16/intent 1002，mm spacing 1×1×1.5。
- ZIP Mask 与 NIfTI 均 929 个成员，逐体素 mismatch 0，成员物理体积 1393.5 mm³。
- Part/STL 694 个顶点、1384 个三角面、2076 条边；开放边、非流形边、方向冲突均 0。
- Part/STL 无向与保向面指纹相同，面积差 0、体积差 0；面积 650.6533255657687 mm²，封闭表面体积 1380.75 mm³。
- Part bounds 为 `[5.5,5.5,11.25]..[18.5,18.5,24.75]` mm。

Mask 体素体积与网格表面体积是不同几何估计，本验证没有要求它们相等，也不据此宣称重建算法或临床结果已与原软件等价。高级可选对象仅计数，没有独立验证其算法语义。
