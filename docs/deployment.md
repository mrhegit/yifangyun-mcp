# 部署指南

## 安装

```bash
npm install -g yifangyun-mcp-server@1.1.0-beta.3
```

或由 Host 固定版本运行：

```json
{
  "command": "npx",
  "args": ["-y", "yifangyun-mcp-server@1.1.0-beta.3"],
  "env": {
    "YFY_CLIENT_ID": "...",
    "YFY_CLIENT_SECRET": "...",
    "YFY_ENTERPRISE_ID": "115",
    "YFY_DEFAULT_USER_ID": "530",
    "YFY_TOOLSETS": "drive",
    "YFY_TRANSPORT": "stdio"
  }
}
```

---

## stdio（同机）

适合 Desktop / CLI Agent，Host 与 Server 同机：

```env
YFY_TRANSPORT=stdio
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=enabled
YFY_DOWNLOAD_STAGED_HTTP=disabled
```

Host 必须能访问 Server 返回的绝对路径。
容器化 stdio 时，Host 与 Server 需共享同一文件系统命名空间或 volume。
Host 正常退出时应先关闭 stdin，并在宽限期后终止完整子进程树。Server 会把 stdin EOF、管道关闭或写端失败视为连接终止，停止 transport、Inventory Worker、下载资源和本地客户端；清理默认最多等待 15 秒，超时后以失败状态强制退出。

---

## 远程 HTTP

推荐架构：

```text
Remote MCP Host
  -> HTTPS reverse proxy
  -> yifangyun-mcp-server 127.0.0.1:3000
  -> Yifangyun OpenAPI
```

Server 配置示例：

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled
YFY_DOWNLOAD_STAGED_HTTP=enabled
YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL=https://mcp.example.com
```

反向代理须转发：

```text
POST/GET/DELETE /mcp
GET /staged/v1/*
GET /health
GET /metrics
```

注意：

- **不要**重写 `Authorization`
- staged GET 与 MCP 使用相同 Bearer
- 代理超时应大于最大预期文件传输时间
- 若 public base 含前缀（如 `https://example.com/yfy-mcp`），须把 `/yfy-mcp/staged/v1/*` 映射到 Server 的 `/staged/v1/*`

---

## HTTP 模式启动

服务**只读进程环境变量**，不会自动加载 `.env`。HTTP 模式必须设置 `YFY_TRANSPORT=http`（未设置时默认 `stdio`，不会监听端口）。

变量语义见 [配置指南 · 传输模式](configuration.md#传输模式transport) 与 [HTTP Server](configuration.md#http-server)。

### 方式一：npx 启动脚本（推荐，Win / macOS / Linux）

仓库提供跨平台脚本 [`scripts/start-npx.mjs`](../scripts/start-npx.mjs)（**需检出本仓库**；不随 `npm install -g` 全局包分发）：通过 `npx` 拉取发布包启动，**无需**在业务目录 `npm install` 业务依赖，也**无需**本地 `npm run build`。

| 项 | 说明 |
|---|---|
| 运行时 | Node.js `>=24`，本机 `npm` / `npx` 在 PATH 中 |
| 默认环境文件 | **脚本同目录** `scripts/.env` |
| 参数覆盖 | `--env-file` / `-e` 指定任意路径（**优先于**默认文件） |
| 合并规则 | 进程中**非空**变量优先于文件；**缺失或空字符串**可由文件补全 |
| env 格式 | 最小 `KEY=VALUE`；`#` 整行注释；未加引号值支持行内 `#`；UTF-8 BOM 可识别 |
| 包版本 | 默认读取仓库 `package.json` 的 `name@version`；可用 `--package` 覆盖（仅允许安全 npm 说明符） |
| Transport | 文件与进程均未设置（或为空）`YFY_TRANSPORT` 时，脚本默认注入 `http` |
| npx 工作目录 | 使用系统临时目录下的中立路径（非仓库根）。在本仓库根执行同名 `npx yifangyun-mcp-server@…` 会与本地 package 冲突，Windows 上常报「不是内部或外部命令」；脚本已规避。仍为 npx 临时缓存，**不**写入项目 `node_modules` |
| 关闭 | Ctrl+C / SIGTERM；Windows 下脚本会尝试 `taskkill` 清理进程树，若端口仍占用请手动结束残留 `node` |

准备环境文件：

```bash
# 从示例复制到脚本同目录（默认读取路径）
cp scripts/http.env.example scripts/.env
# Windows PowerShell:
# Copy-Item scripts\http.env.example scripts\.env

# 编辑 scripts/.env，至少填写：
# YFY_CLIENT_ID / YFY_CLIENT_SECRET / YFY_ENTERPRISE_ID / YFY_DEFAULT_USER_ID
# YFY_TRANSPORT=http
# YFY_HTTP_HOST=127.0.0.1
# YFY_HTTP_PORT=3000
```

启动：

```bash
# 默认读取 scripts/.env
node scripts/start-npx.mjs

# 或 npm script（等价）
npm run start:http:npx

# 参数指定 env（优先级更高；路径可为绝对或相对当前工作目录）
node scripts/start-npx.mjs --env-file ./http.prod.env
node scripts/start-npx.mjs -e /etc/yifangyun-mcp/env

# 固定/覆盖发布包版本
node scripts/start-npx.mjs --package yifangyun-mcp-server@1.1.0-beta.3

# 帮助
node scripts/start-npx.mjs --help
```

本机验证：

```bash
curl -sS http://127.0.0.1:3000/health
# 若配置了 YFY_HTTP_BEARER_TOKEN，则所有路径（含 /health）均需：
# curl -sS -H "Authorization: Bearer <token>" http://127.0.0.1:3000/health
```

| 端点 | 用途 |
|---|---|
| `GET /health` | 存活检查 |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP |
| `GET /staged/v1/{download_id}/...` | `yfy_download` 的 `fetch_url` |
| `GET /metrics` | 进程内指标快照 |

### 方式二：直接 npx（不经仓库脚本）

适合临时拉起；环境须由 shell 或编排系统注入。

**重要（Windows 尤其）：不要在本仓库根目录执行** `npx -y yifangyun-mcp-server@…`。  
本仓库 `package.name` 与发布包同名，在仓库根直接 npx 常导致「不是内部或外部命令」或误用本地/祖先目录安装。  
请先 `cd` 到**非本仓库**路径（如用户主目录或 `%TEMP%`），或改用方式一脚本（已自动使用中立 cwd）。有仓库时**更推荐方式一**。

```bash
# 先离开本仓库根目录，例如：
# cd $TEMP          # bash
# cd $env:TEMP      # PowerShell

export YFY_CLIENT_ID=...
export YFY_CLIENT_SECRET=...
export YFY_ENTERPRISE_ID=115
export YFY_DEFAULT_USER_ID=530
export YFY_TRANSPORT=http
export YFY_HTTP_HOST=127.0.0.1
export YFY_HTTP_PORT=3000
npx -y yifangyun-mcp-server@1.1.0-beta.3
```

用 env 文件时（Node 将 `--env-file` 传给子进程）。**路径勿含未转义空格**；`NODE_OPTIONS` 会影响该 npx 链路中的 Node 进程：

```bash
# 同样须在非本仓库根目录执行
# Unix（路径无空格时）
NODE_OPTIONS='--env-file=/path/to/http.env' npx -y yifangyun-mcp-server@1.1.0-beta.3

# Windows PowerShell
$env:NODE_OPTIONS = "--env-file=C:\path\to\http.env"
npx -y yifangyun-mcp-server@1.1.0-beta.3
```

### 方式三：全局安装 / 本地 dist

```bash
npm install -g yifangyun-mcp-server@1.1.0-beta.3
# 注入环境后：
yifangyun-mcp-server
```

或仓库构建产物：

```bash
npm run build
node --env-file=.env dist/index.js
```

### 本机 HTTP 与生产 HTTP

**本机开发（回环）最小集：**

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
```

HTTP 默认：`YFY_DOWNLOAD_STAGED_HTTP=enabled`，`YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled`，下载返回 `fetch_url`。localhost 可不配 Bearer，仅建议可信本机使用。

**生产 / 远程交付**（下列任一成立即须完整安全配置）：

- `YFY_HTTP_HOST` 非回环，或
- `YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL` 指向非回环主机

此时必须同时配置：`YFY_HTTP_BEARER_TOKEN`、`YFY_HTTP_ALLOWED_HOSTS`、`YFY_HTTP_ALLOWED_ORIGINS`；非 localhost 的 public base 必须为 HTTPS。推荐进程只监听 `127.0.0.1`，由反向代理终止 TLS（见上一节「远程 HTTP」）。

### 常见启动失败

| 现象 | 原因 |
|---|---|
| 无端口监听 | 未设置 `YFY_TRANSPORT=http`（服务默认 stdio；直接 npx 不会自动注入 http） |
| 启动报 Bearer / Host / Origin | 远程可访问但安全项不全 |
| 缺 Client ID | env 未注入、文件路径错误，或 shell 里空串未被子进程/文件正确覆盖 |
| npx 失败 /「不是内部或外部命令」 | ① 在**本仓库根**直接 `npx yifangyun-mcp-server`（应用方式一或先 `cd` 到非仓库目录）；② Node &lt; 24 / npm 不在 PATH |
| health / 日志版本与请求的 `@版本` 不一致 | 祖先路径上有旧安装（如 `%USERPROFILE%\node_modules\yifangyun-mcp-server`）被优先使用。排查：`npm ls yifangyun-mcp-server --prefix %USERPROFILE%`（Unix: `$HOME`）；卸掉旧包或升到目标版本后重试 |
| Inventory database already open | 另一实例占用同一 `YFY_STATE_DB`，或异常退出留下 `.lock`。结束旧进程；必要时删除 `<state>.lock`（确认无存活进程后） |
| Windows 关不干净 | Ctrl+C 后端口仍占用：结束残留 node，或检查防火墙/其它进程 |

---

## 临时目录与状态库

生产环境建议显式设置：

```env
YFY_TEMP_DIR=/var/lib/yifangyun-mcp/temp
YFY_STATE_DB=/var/lib/yifangyun-mcp/state/state.sqlite
YFY_MAX_TEMP_BYTES=1073741824
YFY_TEMP_FILE_TTL_SECONDS=86400
```

要求：

| 要求 | 说明 |
|---|---|
| 目录归属 | 运行用户独占 `YFY_TEMP_DIR/artifacts` 与 `downloads` |
| 状态库位置 | `YFY_STATE_DB` 不在上述两个目录内 |
| 文件系统 | 支持原子 rename |
| 监控 | 磁盘、inode、删除失败日志 |
| 多实例 | **不要**让多个实例共享同一 `YFY_TEMP_DIR` 或同一 SQLite |

正常关闭会释放当前下载；异常退出由下次启动根据 manifest 恢复或清理。

### Inventory SQLite

- 放在持久 volume
- 备份使用 SQLite backup API，或停服后同时处理数据库与 WAL
- 同一数据库只允许一个进程打开；水平扩展需独立状态后端，**不能**多实例直接共享该文件
- SQLite 由专用 Worker 线程持有；Worker 异常退出会使 Inventory RPC 立即失败——应视为实例故障并重启

---

## 容器建议

- 非 root 用户
- 只读根文件系统
- temp / state 使用独立可写 volume
- 明确 memory、CPU、磁盘与进程限制
- Client Secret 不写入镜像
- 健康检查：`GET /health`

HTTP staged 文件由 Node.js 流式输出，无需把整个文件载入容器内存。

---

## 监控

至少关注：

| 信号 | 说明 |
|---|---|
| Provider 401 / 403 / 429 / 5xx | 上游鉴权与可用性 |
| `YFY_LOCAL_STORAGE_INSUFFICIENT` | 临时盘配额不足 |
| `YFY_LOCAL_STORAGE_WRITE_FAILED` | 临时目录权限或本地文件系统故障 |
| `YFY_DOWNLOAD_CLEANUP_FAILED` | 删除失败（占用/权限） |
| `YFY_DOWNLOAD_INTEGRITY_FAILED` | 完整性校验失败 |
| staged 404 / 410、流中断 | 取文件链路问题 |
| Inventory partial / failed | 清单不完整 |
| Inventory Worker exit / error | 进程内 SQLite Worker 故障 |
| SQLite / WAL 体积 | 状态库膨胀 |
| `YFY_TEMP_DIR` 已用空间 | 磁盘压力 |

`yfy_status.temp_storage` 便于 Agent 侧排障；系统级磁盘指标仍应由宿主监控采集。

---

## 发布验证

```bash
npm ci
npm run build
npm test
npm run test:perf
npm pack --dry-run
```

`npm run build` 会把包版本、构建 ID 和 Git commit 固化到编译产物；本地脏工作区的自动 build ID 带 `.dirty` 后缀。发布 workflow 在 job 级注入 tag 与 commit，只生成一次真实 `.tgz`，检查其 build metadata 和文档 denylist，再发布同一个 tarball。运行时 `yfy_status` 不依赖部署目录存在 `.git`。

发布前还应实际启动一次 HTTP transport，并对 staged 文件做真实 GET，不能只验证 URL 字符串是否生成。

npx 启动脚本冒烟（不拉起长驻服务也可）：

```bash
node scripts/start-npx.mjs --help
node --test scripts/start-npx.test.mjs
```
