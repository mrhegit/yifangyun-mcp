# yifangyun-mcp-server

亿方云 OpenAPI 的 MCP Server。当前版本 `1.1.0-beta.3`。

默认能力：网盘浏览、检索、元数据读取、受控下载。可选启用 **Workspace**（业务范围约束）和 **Inventory**（完整目录清单与缺失审计）。

## 能力边界（必读）

| 要点 | 说明 |
|---|---|
| `yfy_download` 做什么 | 下载、版本校验、哈希、临时落盘，并返回交付句柄 |
| 文件怎么拿到 | **stdio**：返回本机绝对路径 `local_path`；**HTTP**：返回需认证的 `fetch_url` |
| 本服务不做什么 | 不解析 PDF/DOCX/XLSX/PPTX，不做 OCR；正文解析由 Host 端工具完成 |
| 下载成功意味着什么 | 字节已就绪，**不**表示模型已读过文件正文 |
| 搜索能否证明不存在 | **不能**。Provider 搜索是索引候选，非穷尽；“不存在”只能依据完整 Inventory 的终态结论 |

## 核心工具

| 工具 | 用途 |
|---|---|
| `yfy_status` | 查看身份、配置、下载交付方式、可用工作流 |
| `yfy_browse` | 浏览个人盘、协作空间、部门、文件夹或 Workspace |
| `yfy_search` | 非穷尽候选搜索；需消歧，并用 `yfy_get` 确认当前是否存在 |
| `yfy_resolve` | 按精确相对路径解析；遇同名返回候选，不自动猜测 |
| `yfy_get` / `yfy_get_many` | 获取当前元数据 |
| `yfy_versions` | 列出当前版与可复制的历史 `VersionRef` |
| `yfy_download` | 下载当前版或历史版；返回 path/URL、哈希、大小、TTL |
| `yfy_download_batch` | 将 1-20 个同身份的当前文件/文件夹打包为一个结构已校验的 ZIP |
| `yfy_download_release` | 可选：提前释放临时下载（幂等） |
| `yfy_workspace_validate` | 校验已配置的命名 Workspace |
| `yfy_membership_check` | 判断文件是否在 Workspace 内 / 外 / 证据不足 |
| `yfy_inventory_*` | 创建、查询、取消、释放目录清单（见下方「术语」） |

按需 toolset：`organization`、`collaboration`、`mutation`、`admin`、`transfer`。
**写操作**与 **Provider transfer URL** 默认均不注册。

### 术语速查（文档中常见难词）

| 说法 | 实际含义 |
|---|---|
| Workspace | 配置里划定的业务目录边界（根文件夹 + 访问身份）；**不**额外授予云盘权限 |
| membership | 文件是否仍落在该 Workspace 根目录子树内 |
| staged 下载 | HTTP 模式下，文件先落盘，再通过 `/staged/v1/...` 受认证 GET 取回 |
| 临时配额 / 预留（reservation） | 下载前先占住临时空间额度，成功后按实际大小计入；不足则拒绝新下载 |
| Inventory | 对 Workspace（或子树）做递归只读扫描，结果落本地 SQLite |
| commit_watermark（水位） | 已成功写入本地库的扫描进度标记；查询/分页绑定该值，避免读到未提交数据 |
| frontier | 尚未扫完的文件夹/分页任务队列 |
| `safe_to_claim_absence` | 清单已完整终态时，才允许在扫描范围内声明“某类文件不存在” |

## 推荐下载流程

**已知精确路径：**

1. `yfy_resolve({ path, from })`
2. `yfy_get({ ref })`
3. `yfy_download({ file })`
4. Host 打开 `download.local_path`，或带认证 GET `download.fetch_url`
5. （可选）`yfy_download_release({ download_id })`

**限制在 Workspace 内下载：**

1. `yfy_workspace_validate({ workspace })`
2. 在同一 Workspace 内 resolve / browse 得到目标文件
3. `yfy_download({ workspace, file, version?, expected? })`

传入 `workspace` 后，服务会在下载**前、后**各做一次 membership 校验。结果为 `outside` 或 `unavailable` 时**不会**返回可用文件。

**历史版本：** 必须原样复制 `yfy_versions` 返回的 `VersionRef`。当前版请省略 `version`，不要自行构造“当前版”引用。

**批量 ZIP：** `yfy_download_batch({ items, workspace?, expected? })` 接受 1-20 个同一非外协访问身份下的 FileRef/FolderRef。20 是本服务的请求放大保护上限，不是 Provider OpenAPI 上限。它只打包当前内容，不接受 VersionRef；服务校验 ZIP 中央目录、成员路径和本地文件头，并返回成员数、展开总大小及整个归档的哈希。该校验不证明 Provider 已包含每个文件夹的全部语义内容，调用方应避免同时传入文件夹及其子项。

## stdio 与 HTTP

| 模式 | 默认交付 | 适用场景 |
|---|---|---|
| `stdio` | `download.local_path` | MCP Host 与 Server **同机** |
| `http` | `download.fetch_url` | 远程 Host；通过受认证 staged GET 取文件 |

- stdio **不**启动 HTTP staged 服务，因此必须 `YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=enabled`。
- HTTP 可同时开启 path 与 staged URL；远程部署通常只开放 `fetch_url`。

staged 路由：

```text
GET /staged/v1/{download_id}/{optional_file_name}
```

与 `/mcp` 共用 Bearer、Host、Origin 防护。URL 过期、显式 release、完整性校验失败，或抓取次数用尽后均不可用。
每个 staged GET 还受 `YFY_DOWNLOAD_WALL_TIMEOUT_MS` 限制；慢客户端不能无限占用读租约或阻塞关闭。

## 最小配置

```env
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_TOOLSETS=drive
YFY_TRANSPORT=stdio
```

招投标（Tender）工作流：

```env
YFY_TOOLSETS=drive,workspace,inventory
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000000000","access_context":"default","tags":["tender"]}]
```

远程 HTTP 示例：

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=0.0.0.0
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled
YFY_DOWNLOAD_STAGED_HTTP=enabled
YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS=20
YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL=https://mcp.example.com
```

非回环监听，或 staged 对外 base URL 指向远程主机时：必须配置 Bearer、允许的 Host 与 Origin。
staged 响应从受保护本地文件句柄**单遍流式**输出；默认并发读 20，硬上限 40。生产建议由反向代理终止 TLS。

Provider 请求默认：同一访问身份并发 `20`，全局并发 `40`。预签名文件下载按身份单独限流，避免单身份占满全局容量。

Inventory 的 SQLite 在**专用 Worker 线程**中运行。Worker 异常退出后，新的 Inventory 请求会立即失败；服务关闭不会等待已失效的 RPC。

## 临时存储

下载中与已登记下载共用 `YFY_MAX_TEMP_BYTES`。服务**不会**为腾出空间而删除尚未过期的旧下载；空间不足返回 `YFY_LOCAL_STORAGE_INSUFFICIENT`。

`YFY_TEMP_DIR` 下由服务独占管理：

| 目录 | 作用 |
|---|---|
| `artifacts/` | Provider 流先写入的候选文件 |
| `downloads/{identity}/{download_id}/` | 校验通过后移入；含 manifest，支持崩溃恢复与 TTL 清理 |

启动时：先清理已过期或无效的 download，再对仍有效文件做配额校验。
`release` 仅在物理删除成功后才成功并扣减配额；删除失败会返回错误，不会假成功。

**不要**把 `YFY_STATE_DB` 或其他业务文件放进 `artifacts/`、`downloads/`。

## 运行与验证

```bash
npm ci
npm run build
npm test
npm run test:perf
npm pack --dry-run
```

启动（需 Node.js `>=24`）：

```bash
# 本地构建产物 + 项目根 .env
node --env-file=.env dist/index.js
```

### HTTP 模式（npx，跨平台）

需**检出本仓库**（脚本不随全局 npm 包分发）。无需本地 `npm install` 业务依赖、无需 `build`，通过 `npx` 拉发布包启动：

```bash
# 1) 准备脚本同目录环境文件
cp scripts/http.env.example scripts/.env   # Windows: Copy-Item scripts\http.env.example scripts\.env
# 编辑 scripts/.env，填写 Client ID/Secret 等，并保持 YFY_TRANSPORT=http

# 2) 启动（默认读 scripts/.env）
node scripts/start-npx.mjs
# 或: npm run start:http:npx

# 指定其它 env 文件（优先级更高）
node scripts/start-npx.mjs --env-file ./http.prod.env
```

本机验证：`curl http://127.0.0.1:3000/health`（若 `YFY_HTTP_HOST=0.0.0.0`，仍用 `127.0.0.1` 探测）。完整说明见 [部署指南 · HTTP 模式启动](docs/deployment.md#http-模式启动)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [配置指南](docs/configuration.md) | 环境变量、toolset、传输与下载交付 |
| [工具参考](docs/tools.md) | 各工具契约、参数与错误 |
| [架构与安全](docs/architecture-security.md) | 模块边界、下载与 staged 完整性 |
| [部署指南](docs/deployment.md) | stdio/HTTP、npx 启动、反向代理、容器与监控 |
| [OpenAPI 覆盖](docs/openapi-coverage.md) | Provider 能力与工具映射 |
| [测试指南](docs/testing.md) | 单元 / 性能 / Live 测试 |
