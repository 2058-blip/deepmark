# 双角色控制台与 Java 服务

DeepMark 使用 Vue 3/TypeScript 网页界面，Java 17、Javalin 6 和 SQLite 提供账户、任务和协同 API。Node.js 用于前端构建及开发脚本；生产 API 与 WebSocket 由 Java 进程提供。

## 角色与任务流程

注册时选择以下一种账户角色。登录后进入对应控制台，账户角色由服务器会话确定。

| 操作 | 数据发布人员 `dispatcher` | 标注人员 `worker` |
| --- | --- | --- |
| 发布 NIfTI 数据集 | 可以 | 不可以 |
| 查看自己的发布记录、领取状态和小组成员 | 可以 | 查看自己可访问的任务 |
| 创建小组、使用邀请码加入小组 | 不可以 | 可以；创建者成为组长 |
| 为小组领取未标注任务 | 不可以 | 仅该小组组长 |
| 编辑已领取任务的共享标注 | 不可以 | 该小组成员 |
| 实时只读监看已发布任务 | 可以 | 可查看本组任务 |
| 确认任务完工 | 不可以 | 仅领取小组的组长 |
| 下载已完工的成果 ZIP | 可以 | 可访问本组成果 |

任务状态依次为：

`unassigned（未领取） → in_progress（标注中） → completed（已完工）`

发布人员上传 `.nii` 或 `.nii.gz` 后，任务进入待领取列表。组长创建小组并分享 12 位邀请码，成员加入后即可共同工作。两个组同时领取同一个任务时，数据库事务只允许其中一个组成功，另一个请求得到冲突响应。

领取后，小组成员打开同一共享工程，完成的笔画、区域填充和标签变更通过 WebSocket 同步；HTTP 提交用于兼容回退。发布人员使用同一工程的只读视图监看进度，服务端拒绝其标注写入。未加入领取小组的标注人员不能读取该任务的影像或工程。

组长确认完工时必须携带当前修订号（非负整数）；缺省、空值、字符串或小数均被拒绝。若期间已有新操作，先刷新成果再确认。完工后，服务端锁定 HTTP 和已连接 WebSocket 的编辑请求，并向在线视图推送状态。发布人员可下载最终 ZIP。

## 账户与会话

- 用户名为 3–40 位英文字母、数字、下划线、点或短横线；服务器统一为小写。
- 密码为 8–128 个字符，UTF-8 编码不超过 256 字节，不包含控制字符。
- 网页先获取一次性挑战与 RSA 公钥，再用 RSA-OAEP SHA-256 加密包含挑战编号和密码的载荷。注册、登录接口拒绝明文 `password` 字段。
- 默认挑战有效期为 120 秒，并在一次解密尝试后消费。测试服务可用 `DEEPMARK_CHALLENGE_TTL_SECONDS` 将有效期设为 1–300 秒。
- 数据库保存每账户独立随机盐和 PBKDF2-HMAC-SHA256 密码验证值；会话令牌只保存 SHA-256 摘要。
- 浏览器使用 HttpOnly、SameSite=Lax 会话 Cookie。修改请求需要 `X-Deepmark-Request: 1`，并接受同源校验；WebSocket 使用同一会话及任务权限。
- 同一浏览器重新登录时更换当前会话；其他设备的独立会话继续有效。注销会使当前会话失效。

默认远程部署使用 HTTPS，并代理同源的 API 与 WebSocket。密码载荷加密不能替代 HTTPS 对网页、公钥、会话和标注数据的保护。局域网 HTTP 测试可显式设置 `DEEPMARK_ALLOW_HTTP=1`；网页会启用 HTTP 兼容加密与影像指纹计算，账号和任务权限仍然检查。后端只信任本机反向代理提供的 HTTPS 协议头。

## 构建与运行

需要 JDK 17+、Maven，以及用于前端工具和集成测试的 Node.js 24+。

在仓库根目录执行：

```powershell
npm ci
npm run build:server
npm run build
npm start
```

`build:server` 生成 `backend/target/deepmark-server.jar`。也可直接运行：

```powershell
mvn -f backend/pom.xml test package
java -jar backend/target/deepmark-server.jar
```

Java 服务默认监听 `127.0.0.1:8787`，并提供已有的 `dist` 网页。开发时先构建 Java JAR，再运行 `npm run dev`；开发脚本启动 Java API 和 Vite，并代理 `/api`（包括 WebSocket）。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Java 服务监听地址 |
| `PORT` | `8787` | Java 服务端口 |
| `STATE_DIR` | `server-data/platform` | SQLite 持久目录，数据库为 `deepmark.sqlite` |
| `DATASET_DIR` | `server-data/datasets` | 上传影像存储目录 |
| `DIST_DIR` | `dist` | 已构建前端目录 |
| `DEEPMARK_CHALLENGE_TTL_SECONDS` | `120` | 一次性登录挑战有效期，测试可设 `3` |

开发脚本的端口配置以当前 `scripts/dev.mjs` 为准。发布生产版本前应重新构建 JAR 与网页，避免 API 和界面版本不一致。

## 数据与导出

发布的数据集记录归属于发布账户。影像上传后保存内容指纹，打开协同工程必须提交匹配的指纹，避免旧浏览器用错坐标网格。需要变更影像内容时重新发布，不直接替换已发布的服务器文件。

SQLite 保存账户、小组、任务、协同工程和修订记录；上传原文件保存在 `DATASET_DIR`。备份时同时保留数据库与原文件。SQLite 使用 WAL，在线备份应采用一致性备份方式，不能只复制正在写入的单个主数据库文件。

成果 ZIP 至少包含：

- `segmentation.nii`：整数标签图，空间网格与原始影像一致。
- `labels.json`：标签编号、名称与颜色。
- `manifest.json`：项目和修订等导出信息。
- `README.txt`：导出包说明。
- `parallel-annotations.json`：有并列标注意见时附带；单一 NIfTI 无法同时表达这些意见。

成果包不包含原始 CT/MRI。当前输入仍限于支持的三维灰度 NIfTI-1；DICOM、4D、AI 分割和三维重建不在此控制台迁移范围内。

## HTTP 与 WebSocket 集成测试

`tests/platform-integration.mjs` 面向正在运行的 Java 服务，不启动或下载后端。它创建随机名称的账户、小组和影像，不删除现有数据。测试要求显式提供 URL，并要求数据库位于操作系统临时目录，防止误用生产数据库。

先在终端一启动独立测试服务（PowerShell 示例）：

```powershell
$integrationRoot = Join-Path $env:TEMP ('deepmark-integration-' + [Guid]::NewGuid().ToString('N'))
$env:STATE_DIR = Join-Path $integrationRoot 'state'
$env:DATASET_DIR = Join-Path $integrationRoot 'datasets'
$env:HOST = '127.0.0.1'
$env:PORT = '18787'
$env:DEEPMARK_CHALLENGE_TTL_SECONDS = '3'
java -jar backend/target/deepmark-server.jar
```

在终端二设置实际路径并运行：

```powershell
$env:DEEPMARK_TEST_URL = 'http://127.0.0.1:18787'
$env:DEEPMARK_TEST_DB = 'C:\Users\你的用户名\AppData\Local\Temp\deepmark-integration-实际编号\state\deepmark.sqlite'
node tests/platform-integration.mjs
```

测试进程必须能只读访问服务对应的 SQLite 文件。Linux 服务器可使用 `/tmp/deepmark-integration-实际编号/state/deepmark.sqlite`，并在该服务器运行测试。测试完成后保留数据库与影像，便于排查；请先停止测试服务，再自行处理这份临时目录。

测试覆盖 RSA 注册登录、挑战一次性与过期、明文密码拒绝、Cookie 会话、同源写入保护、独立密码盐与哈希、角色限制、邀请码入组、组长认领与完工、并发认领、成员 HTTP/WS 协作、操作幂等、只读实时监看、非成员拒绝、完工后的既有连接写锁，以及 ZIP 内容读取。无效 qform、不可逆 sform 和 NaN 像素的上传必须返回 400，且不能留下幽灵任务。它使用合成影像；浏览器交互、真实医学影像和多机网络性能仍应分别验证。

## 真实重启后的持久化验证

运行集成测试前，可将 `DEEPMARK_TEST_CHECKPOINT` 设置为操作系统临时目录中的新文件路径，例如：

```powershell
$env:DEEPMARK_TEST_CHECKPOINT = Join-Path $env:TEMP ('deepmark-checkpoint-' + [Guid]::NewGuid().ToString('N') + '.json')
node tests/platform-integration.mjs
```

主集成测试全部通过后才会创建 checkpoint，已有文件不会覆盖。夹具包含两位作者、第二个自定义标签和非空并列意见区域，主标签图保留原作者的标签。文件保存本次测试的会话 Cookie、最终工程快照、全部 64 个体素的作者、历史和 ZIP SHA-256，不包含密码。POSIX 上使用 `0600` 权限，Windows 上继承临时目录 ACL；不要把该文件提交或分享。

随后停止并重新启动 Java 进程，保持原来的 `STATE_DIR`、`DATASET_DIR`、主机和端口。在保留上述测试环境变量的终端运行：

```powershell
node tests/platform-restart.mjs
```

该脚本只发送 GET 请求，检查既有 Cookie 仍有效、角色及任务状态不变、相同工程的标签图/标签/并列区域/修订历史/每体素作者一致，并比较原始 NIfTI 和成果 ZIP 的 SHA-256。它还复验匿名、其他小组和其他发布者不能读取源文件、工程或成果包。脚本要求 checkpoint、同一临时数据库和同一服务来源，不能通过改变 URL 将会话发送给另一服务。完成后 checkpoint 和测试数据均保留，便于排查。
