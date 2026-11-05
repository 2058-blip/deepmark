# 真实浏览器下载的合成交换文件

这些文件来自2026-11-05 Edge浏览器对localhost工作台的实际按钮操作，保留桌面原件后复制到本目录。不是CLI生成的导出样本。操作和版本证据见[浏览器记录](../../notes/foundation-browser-reslice-project-2026-11-05.md)。

| 文件 | 内容 |
| --- | --- |
| [source.deepmark.zip](source.deepmark.zip) | 原96×96×64合成工程，56成员Mask、284面Part、1RP |
| [source-mask.nii](source-mask.nii) | 真实浏览器导出的原Mask NIfTI |
| [source.stl](source.stl) | 真实浏览器导出的原Part二进制STL |
| [identity.deepmark.zip](identity.deepmark.zip) | 等尺寸/同坐标新工程，内含reslice-transform.txt |
| [oblique.deepmark.zip](oblique.deepmark.zip) | 世界X堆栈/绕线30°/2mm像素/UpdateCS的新48×48×64工程，16成员Mask及变换后的历史Part |

[source-independent-validation.json](source-independent-validation.json)证明源ZIP/NIfTI逐体素与ZIP/STL逐面一致。[identity-independent-validation.json](identity-independent-validation.json)及[identity-vs-source.json](identity-vs-source.json)证明589824个灰度、Mask和Part数组完全相同。

[oblique-format-validation.json](oblique-format-validation.json)检查格式与声明的矩阵；[oblique-independent-validation.json](oblique-independent-validation.json)从已记录参数独立推导147456个采样、最近邻Mask、T/R对象变换及RP框架，全部一致。

通用核验器为`C:/Users/wwulli/Desktop/deepmark/scripts/verify-mimics-browser-exports.py`，[41项自检](oracle-reslice-self-test.json)；特定旋转解析核验器为`C:/Users/wwulli/Desktop/deepmark/scripts/verify-mimics-reslice-browser.py`，[8项自检](oblique-oracle-self-test.json)。独立核验采用Python标准库，不调用生产TypeScript采样器。

文件哈希、原路径和时间见[来源清单](download-manifest.json)。物理文件读回不能代替浏览器文件选择/重新导入、原版比较或临床验证。应用正确保留download-started的未确认状态，未伪装文件写入回执。
