# Mimics 风格工作台：独立成果快照

日期：2026-11-05。此目录是可独立运行的 Vue 3 / TypeScript / Node.js 24 工程，不替换仓库已有前后端。

## 使用

```powershell
cd mimics-workbench
npm ci
npm run sample-data
npm run dev
```

开发网页默认在 http://127.0.0.1:5173。首次练习可使用自带合成影像。应用与工程格式是独立实现，不是 Mimics 程序，也不兼容其 .mcs 工程。

## 内容入口

- [工作台说明](README.md)
- [当前进度与已知缺口](docs/mimics-reconstruction-progress.md)
- [分割工具操作指南](work/mimics-tool-guides/分割工具操作指南.md)
- [可离线打开的图文指南](work/mimics-tool-guides/分割工具操作指南.html)
- [完整工具分析报告](work/mimics-17-analysis/report/Mimics17-完整分析报告.md)
- [可离线打开的完整报告](work/mimics-17-analysis/report/Mimics17-完整分析报告.html)
- [62项工具和16项跨链路要求](work/mimics-vue-reconstruction/requirements.json)
- [合成交换格式样本](work/mimics-vue-reconstruction/evidence/exchange-sample/README.md)
- [真实浏览器导出的合成文件](work/mimics-vue-reconstruction/evidence/browser-file-exchange/README.md)
- [本次快照文件清单](snapshot-manifest.json)
- [本次隔离验证记录](PUBLISH-VALIDATION.md)

## 范围与证据

保留独立 Mask、分割、三维重建、测量、MPR、RP、工程重切片、工程交换、持久化与现有协作入口的源码和测试。包含现有报告、指南、应用回归日志、合成夹具及部分浏览器证据。

没有打包原版 Mimics 的可执行程序、DLL/插件、提取帮助文件、IDA数据库或反编译代码目录，也没有打包本机工具链、依赖缓存、聊天记录或运行数据库。报告中的部分原始证据链接因此只在原分析工作区可用；报告结论及未知边界原样保留。

已实现或测试通过不等于原版或临床等价。全部62+16范围仍未完成，原报告和历史日志各自保留日期，不作为本次重新逐项浏览器验收。磁盘样本均为合成数据。

此快照冻结后不会自动包含原工作区之后的修改。源文件SHA256和快照时间见清单；本次测试与构建以 PUBLISH-VALIDATION.md 为准。
