# 子路径部署验证

日期：2026-11-05。此记录针对独立工作台在 `/mimics/` 下的部署适配，源码以本文件所在提交为准；最初导入快照为 `c846aa247af1e3f3fd3ee18d0300b1e12eabf12c`。

## 部署行为

- Vite 按 `/mimics/` 构建。网页、Worker、API、下载和 WebSocket 使用同一前缀，由 HTTPS 代理剥除前缀后转发到独立 Node 服务。
- 独立 Cookie 名称及路径避免覆盖主站会话。旧协作入口的副本、身份及迁移缓存使用独立 IndexedDB 名称；新工作台原有独立工程缓存保持。
- 服务端支持 `COOKIE_NAME`、`COOKIE_PATH`、`PUBLIC_BASE_PATH`，开发默认值兼容原入口。健康接口返回服务进程 PID，监督脚本精确比对当前进程，拒绝端口上其他 Node 的健康响应。
- 发布目录、生产依赖与源码固定在独立 release 中，持久数据在 `/home/deepmark/mimics-runtime/`。服务不连接原 Java 主站的数据库、账号或影像目录；初始服务器数据仅含合成练习影像。
- 独立启停及两秒自动重启脚本与 nginx 片段见 [部署说明](deploy/README.md)。根 nginx 模板仅增加服务片段 include。

## 实际验证

- 原分支基线 797/797 测试通过；加入部署适配后最终 804/804 通过，0 失败、0 跳过。Vue 类型检查与 Vite 生产构建通过，最终主包 `index-CCyy-fj8.js`。
- Chromium 在临时 Node 18789 与 HTTPS 代理 18443 上完成 29/29 检查：真实子路径加载、合成影像三视图和翻片、阈值生成 32,478 体素 Mask、三维重建 66,816 三角形、工程 ZIP 下载与独立 Python 内容校验、自动缓存及刷新恢复。
- 同一浏览器预置主站 Cookie、IndexedDB v2 和旧迁移缓存标记，再验证旧协作入口的数据集下载、昵称会话、真实认证 WebSocket 与注销；主站标记保持，API 无根路径泄漏，资源/API 失败与 JavaScript 错误均为 0。
- 健康接口增加 PID 后单独补验 9/9：HTTPS 下 GET 的 PID 等于实际测试 Node，HEAD 200 且无响应体；全部 SQLite 文件位于临时 state 目录。
- 服务脚本流程 13/13、真实软链接入口服务 9/9、其他 Node 占端口的负例 5/5 通过；shell 语法与独立 nginx 配置检查通过。实际入口须使用 `--preserve-symlinks-main`，已通过真实服务器复现并修正缺少该参数时不监听的问题。
- 独立只读复核通过，无剩余 P1/P2 发布阻断。所有写入验收使用临时目录、合成影像和独立端口；测试服务均已停止。

证据位于部署服务器 `/dsh/deepmark-mimics-deploy/`，浏览器结果在 `browser-qa/result.json` 与 `browser-qa/health-result.json`，服务结果为同目录 `service-*-result.json`，源码与最终部署包哈希记录在 `verification-result.json`。正式线上发布结果另外记录为 `deployment.json`。

390px 仅验证既有工作台渲染，桌面布局的部分列仍在窄视口外；本轮没有实施或宣称完整移动端适配。此次部署验证不替代快照已有的功能进度与准确性边界记录。

final result: passed
