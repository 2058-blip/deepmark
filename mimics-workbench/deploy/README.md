# 独立工作台部署

本服务通过现有 HTTPS 代理的 `/mimics/` 提供工作台，Node 仅监听 `127.0.0.1:8788`。主站 Java、账号、影像和数据库继续由原部署管理。

## 目录与构建

将每次发布放在 `/home/deepmark/mimics-runtime/releases/<提交号>/`，包含子工程的 `server/`、`src/`、构建后的 `dist/`、`package.json`、锁文件及生产 `node_modules/`。Node 24 原生执行 TypeScript 导入，因此服务器运行时也需要对应的 `src/`。前端按子路径构建：

```sh
npm ci
npm test
npm run build -- --base /mimics/
```

`/home/deepmark/mimics-runtime/current` 是指向已验证发布目录的软链接。先构建并验证完整发布，再原子替换该链接；切换前停止本服务，切换后单独启动。运行脚本使用 Node 的 `--preserve-symlinks-main`，使服务器入口判断与 `current/server/server.mjs` 参数一致。不要在当前发布目录覆盖源文件或依赖。

将本目录运行脚本安装在固定位置 `/home/deepmark/mimics-runtime/service/`，保持可执行权限。外部目录 `state/`、`datasets/`、`logs/` 和 PID 文件不随发布替换。`datasets/` 仅使用此独立应用的数据，不能指向主站的患者影像目录。生成示例时只放入合成练习影像。

可选的私有 `service.env` 支持 `MIMICS_NODE_BIN`（默认 `/home/deepmark/tools/node-24/bin/node`）和 `MIMICS_PORT`（默认 `8788`），这是受管理员控制的 shell 文件，应设为 `0600`。运行脚本固定设置独立数据路径及 `COOKIE_NAME=deepmark_mimics_session`、`COOKIE_PATH=/mimics/`、`PUBLIC_BASE_PATH=/mimics/`、`COOKIE_SECURE=1`。修改端口也要同步修改代理片段。

## 启动与维护

可从任意当前目录运行：

```sh
/home/deepmark/mimics-runtime/service/start.sh
/home/deepmark/mimics-runtime/service/status.sh
/home/deepmark/mimics-runtime/service/stop.sh
```

脚本可接受独立 runtime 的绝对路径为第一个参数，用于临时环境验证。启动等待内部 `/api/health` 正常，并严格核对返回的 Node PID 与当前服务进程一致；其他进程占用端口不会被误认作启动成功。监督进程持有 `flock` 锁，Node 退出后等待两秒自动重启；停止先阻止重启，只停止经过 `/proc` 参数和可执行文件核对的本服务进程。日志位于 `logs/node.log` 和 `logs/supervisor.log`。它不提供容器或宿主机重启后的启动钩子，届时由宿主机运行 `start.sh` 或配置对应管理服务。

## HTTPS 代理

将 `nginx.location.conf` 安装为现有 `/home/deepmark/runtime/proxy/services/mimics.conf`。根部署的 `deploy/nginx.conf.template` 在 HTTPS server 内包含 `services/*.conf`，因此原主站启动脚本重新生成代理配置时仍保留此片段。首次安装须在当前生效的 server 块加上同一 include，再执行该独立代理的 `nginx -t`；检查成功后仅向精确匹配的 nginx master 发送 HUP，以平滑加载。保留原配置备份，失败即恢复备份并复查。

前端资源、API、下载和 WebSocket 均经 `/mimics/` 访问；Cookie 名称和路径独立，浏览器工作缓存也使用独立名称。不要将原站 `/api/` 路由改到新 Node，不要运行主站的 `deploy/stop.sh` 来更新此应用。更换 Node 发布时无需停止主站 Java、代理或证书续期进程。部署后通过正常 HTTPS 核对入口、资源文件哈希、健康接口和浏览器流程。
