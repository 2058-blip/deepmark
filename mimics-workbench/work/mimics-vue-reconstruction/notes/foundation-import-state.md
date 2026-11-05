# 基础导入与替换候选状态机

本轮检查的是当前Vue控制器的文件/本地工程导入生命周期，不把它称作原Mimics内部实现。

## 用户操作与提交边界

1. 文件选择器取消或文件列表为空：不开始新请求，保留当前工程和已有候选。
2. 真正选择新文件/缓存工程：取消旧后台工作，清除旧DICOM系列列表和旧pendingReplacement；保留已提交影像、Mask、Part、测量、dirty及Undo历史。
3. 新请求解析失败：只报告当前请求错误；已提交工程不替换，旧候选也不能被误认为本次新文件的结果。
4. 多DICOM系列：只展示本次解析所得series，选择一个才转换体积；busy时禁止触发加载旧系列。
5. 新候选已解析且当前无dirty：安装候选。当前有dirty：显示明确的取消/放弃并打开/保留本地副本并打开选择，直到用户作出选择前仍不替换工程。
6. 保留本地副本并打开：先等待当前工程缓存写完；只有该异步动作仍拥有同一请求generation和同一个candidate时才能安装。写入失败保留原工程和该候选供重试；操作过期后，无论旧写入成功或失败，都不能覆盖后来文件、错误、busy或progress。

`beginImport`对所有真正新导入清理volatile候选；这与失败时保留committed数据不同。`confirmReplacement('cache')`将异步缓存分支纳入generation归属；`loadSeries`有busy门禁，series UI的选择与加载也同步禁用。

## 已验证的回归

`tests/mimics-foundation.test.ts`新增4项，连同原22项实际执行**26/26通过**，日志`../evidence/import-candidate-current.tap`：

- 新坏文件请求清旧series/pending，却保留原dirty数据、revision和Undo。
- 选择器取消不清当前候选。
- 旧缓存成功时，新慢导入的busy和原工程保持，最终只有最新候选可安装。
- 旧缓存失败时，不把错误或busy/finally发布到新请求，也不复活旧候选。

测试使用实际Vue控制器/Worker与受控缓存写入闸门，确认错误顺序和所有权；不包含真实浏览器文件选择器或磁盘写入。新生成DICOM文件见`../fixtures/dicom/README.md`，供后续多系列和拒绝路径实际UI验收。
