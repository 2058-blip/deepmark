# 合成交换格式示例

三个文件包含同一个解析球体，不含患者数据：

- `sample.deepmark.zip`：可在本项目Vue工作台打开的完整工程，含原始影像、Mask和Part；不是Mimics `.mcs`。
- `sample-mask.nii`：24×24×24、1×1×1.5 mm的二值分割，929个成员体素。
- `sample.stl`：对应表面，694个唯一顶点、1384个三角形。

文件由实际`operations.worker.ts`在Node环境导出，再由独立Python标准库解析器核验。NIfTI与工程逐体素一致，STL与工程逐三角坐标和方向一致。开放边、非流形边、方向冲突边均0；详细结果与输入SHA256见`independent-validation.json`。

这不是浏览器下载/原生文件选择器的落盘验收，也没有与原Mimics输出对照。Mask成员体积1393.5 mm³与闭合表面体积1380.75 mm³是两种表示下的不同估计。

从项目根目录复现：

```powershell
node --experimental-strip-types scripts/create-mimics-exchange-sample.mjs
python -I -S scripts/verify-mimics-browser-exports.py --project work/mimics-vue-reconstruction/evidence/exchange-sample/sample.deepmark.zip --stl work/mimics-vue-reconstruction/evidence/exchange-sample/sample.stl --mask work/mimics-vue-reconstruction/evidence/exchange-sample/sample-mask.nii --output-json work/mimics-vue-reconstruction/evidence/exchange-sample/independent-validation.json
```
