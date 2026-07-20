# 配置指南

服务**只读进程环境变量**，不会自动加载 `.env`。
本地可用 Node.js `--env-file`；容器与生产应由部署系统注入配置。

## 必需配置

| 变量 | 说明 |
|---|---|
| `YFY_CLIENT_ID` | 亿方云应用 Client ID |
| `YFY_CLIENT_SECRET` | 亿方云应用 Client Secret；同时用于签名本地 Ref / Cursor |
| `YFY_ENTERPRISE_ID` | 企业 ID（仅数字） |
| `YFY_DEFAULT_USER_ID` | 默认用户 ID（仅数字） |

默认 Provider 地址：

| 变量 | 默认值 |
|---|---|
| `YFY_API_BASE_URL` | `https://open.fangcloud.com/api` |
| `YFY_OAUTH_BASE_URL` | `https://open.fangcloud.com` |

自定义非 localhost 地址必须使用 HTTPS，且 URL 不得含 userinfo（用户名密码）。

---

## Toolset（能力开关）

`YFY_TOOLSETS` 为逗号分隔列表，默认 `drive`。

| Toolset | 启用后提供的能力 |
|---|---|
| `drive` | status、browse、search、resolve、get、versions、单文件/批量 ZIP download、comments、shares |
| `workspace` | Workspace 校验、membership（归属）检查 |
| `inventory` | 递归只读扫描、本地 SQLite 清单、完整性与缺失审计 |
| `organization` | 部门 / 用户 / 群组只读 |
| `collaboration` | 协作关系读写 |
| `mutation` | 文件夹、文件、回收站、上传等写操作 |
| `admin` | 管理员操作 |
| `transfer` | 短时 Provider 直链（特殊集成；非普通读路径） |

未知 toolset 名会导致**启动失败**。建议从最小集合开始：

```env
YFY_TOOLSETS=drive
```

Tender（招投标）Profile 要求 `drive,workspace,inventory`，且至少配置一个 Workspace：

```env
YFY_TOOLSETS=drive,workspace,inventory
YFY_WORKFLOW_PROFILES=tender
```

`transfer`、写工具与组织工具**不会**因 Tender Profile 自动启用。

---

## 身份与 Workspace

默认访问身份 id 为 `default`。附加身份用 JSON 配置：

```env
YFY_DEFAULT_ACCESS_CONTEXT=default
YFY_ACCESS_CONTEXTS_JSON=[{"id":"reviewer","user_id":"531","external_enterprise_id":"9"}]
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 本地稳定名称；仅字母、数字、下划线、连字符 |
| `user_id` | 是 | Provider 用户 ID |
| `external_enterprise_id` | 否 | 外部企业上下文 |

Workspace 是**业务目录边界**，不授予新权限：

```env
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000000000","access_context":"default","tags":["tender"]}]
```

- 工具入参使用完整 `workspace:<id>` 形式。
- 传给 `yfy_download` 时，会在下载前后校验文件是否仍在配置根目录子树内。

---

## 传输模式（Transport）

### stdio（同机）

```env
YFY_TRANSPORT=stdio
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=enabled
YFY_DOWNLOAD_STAGED_HTTP=disabled
```

stdio **不**启动 HTTP Server，因此：

- 必须启用 `YFY_DOWNLOAD_EXPOSE_LOCAL_PATH`
- 必须禁用 `YFY_DOWNLOAD_STAGED_HTTP`
- 结果返回服务器上的绝对路径 `local_path`
- 仅适用于 Host 与 Server 同机（或共享同一文件系统）

非法组合在**启动期失败**，而不是返回不可达 URL。

### HTTP（本机开发）

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
```

HTTP 默认：

- `YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled`
- `YFY_DOWNLOAD_STAGED_HTTP=enabled`
- `yfy_download` 返回 `fetch_url`

localhost 可不配 Bearer，但仅建议用于可信本机开发。

启动方式（npx 脚本 / 全局包 / dist）见 [部署指南 · HTTP 模式启动](deployment.md#http-模式启动)。

### 远程 HTTP

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=0.0.0.0
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled
YFY_DOWNLOAD_STAGED_HTTP=enabled
YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL=https://mcp.example.com
```

以下任一成立即视为**远程交付**（需完整安全配置）：

- HTTP 绑定非回环地址
- staged 对外 base URL 指向非回环主机

远程交付必须同时配置：Bearer、Host 白名单、Origin 白名单。
Bearer 同时保护 `/mcp` 与 `/staged/v1/...`。

### 下载交付相关变量

| 变量 | 默认 | 约束 |
|---|---:|---|
| `YFY_DOWNLOAD_EXPOSE_LOCAL_PATH` | stdio 开 / HTTP 关 | 远程部署通常保持关闭 |
| `YFY_DOWNLOAD_STAGED_HTTP` | stdio 关 / HTTP 开 | 仅 HTTP transport 可启用 |
| `YFY_DOWNLOAD_STAGED_MAX_FETCHES` | `10` | 正整数；按 HTTP 获取**尝试**扣减 |
| `YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS` | `20` | 同时进行的 staged 流上限，最大 `40` |
| `YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL` | localhost 可自动生成 | 远程或通配监听必须显式配置 |

Public base 规则：

- 仅 HTTP/HTTPS
- 非 localhost 必须 HTTPS
- 禁止 userinfo、query、fragment
- 可带反向代理路径前缀，例如 `https://example.com/mcp-files`
- 配置后须确保代理把该前缀下的 `/staged/v1/...` 转到本服务

`0.0.0.0` 与 `::` 是监听地址，**不是**可对外广告的主机名，不能用于自动生成远程 URL。

---

## HTTP Server

| 变量 | 默认 | 说明 |
|---|---:|---|
| `YFY_HTTP_HOST` | `127.0.0.1` | 监听地址 |
| `YFY_HTTP_PORT` | `3000` | 监听端口 |
| `YFY_HTTP_MAX_SESSIONS` | `100` | 最大 MCP session 数 |
| `YFY_HTTP_SESSION_IDLE_SECONDS` | `1800` | 空闲 session 回收（秒） |
| `YFY_HTTP_BEARER_TOKEN` | 空 | Bearer Token |
| `YFY_HTTP_ALLOWED_HOSTS` | 空 | 逗号分隔 Host 白名单 |
| `YFY_HTTP_ALLOWED_ORIGINS` | 空 | 逗号分隔 Origin 白名单 |

端点：

```text
POST/GET/DELETE /mcp
GET /staged/v1/{download_id}/{optional_file_name}
GET /health
GET /metrics
```

staged URL 中的文件名仅影响下载显示名；真正的授权句柄是不可猜测的 `download_id`。

---

## 下载与临时存储

| 变量 | 默认 | 说明 |
|---|---:|---|
| `YFY_TEMP_DIR` | `<OS temp>/yifangyun-mcp` | 受管理的临时根目录 |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` | 已登记下载与未完成 artifact 的保留时间 |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` | 单个下载/上传最大字节（256 MiB） |
| `YFY_MAX_TEMP_BYTES` | `1073741824` | artifacts + downloads + 进行中预留 的共享总配额（1 GiB） |
| `YFY_TEXT_PREVIEW_MAX_BYTES` | `32768` | 可选 UTF-8 文本预览上限；配置最大允许 `1048576` |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` | 下载无进度超时 |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` | 单文件下载、批量前后校验 + ticket + ZIP 流，以及单次 staged HTTP 读租约的总耗时上限 |

`YFY_TEMP_DIR` 下由服务独占：

```text
artifacts/   下载进行中的候选文件
downloads/   已校验下载、manifest、release 状态
```

### 配额行为（与代码一致）

1. Provider 响应有 `Content-Length` 时，按该长度**预留**空间；无长度时按 `YFY_MAX_DOWNLOAD_BYTES` 预留。
2. 已登记 downloads 与进行中 artifacts 共用同一配额。
3. 配额不足时**只拒绝新请求**，不删除仍在 TTL 内的旧下载。
4. `release` 仅在物理删除成功后才扣减已用空间。
5. 启动恢复：先删除已过期或无效的合法 `download_id` 目录，再对剩余有效文件做配额断言。

### 启动恢复与 manifest

每个下载目录含随机 `download_id`、文件与原子写入的 `manifest.json`（含到期时间、文件名、哈希、大小、mtime、ctime 等）。

恢复阶段：

- 只校验 manifest、普通文件类型与元数据，**不**整文件重读内容
- 过期或已确定损坏的合法 download 目录会被删除
- 暂时性 I/O / 权限错误会中止启动并保留文件
- 未知根级条目不会自动删除，但仍计入配额
- 降低 `YFY_MAX_TEMP_BYTES` 不会驱逐仍在 TTL 内的有效下载；过期清理后的配额自愈不阻止启动

HTTP 抓取次数（fetch count）仅在进程内计数，**重启后重置**，避免每次 GET 重写 manifest。

`YFY_TEMP_DIR`、`artifacts/`、`downloads/` 必须是服务账户控制的**普通目录**，不能是符号链接或 Windows junction。
服务记录托管根目录的文件系统身份并在后续创建、配额扫描和清理前复验；替换整个托管根或子目录会使操作失败，而不是继续跟随新路径。
`YFY_STATE_DB` 不能位于 `artifacts/` 或 `downloads/` 内。

### 文本预览

默认关闭。调用方需显式传入：

```json
{"file":"file:...","include_text_preview":true}
```

仅当完整文件为受支持文本类型、大小不超过上限、且 UTF-8 严格解码成功时返回 preview。

---

## Inventory（目录清单）

| 变量 | 默认 | 说明 |
|---|---:|---|
| `YFY_STATE_DB` | `<YFY_TEMP_DIR>/state.sqlite` | Inventory SQLite 路径 |
| `YFY_INVENTORY_CONCURRENCY` | `2` | 递归读取并发，范围 1–8 |
| `YFY_INVENTORY_TTL_SECONDS` | `604800` | 清单保留时间（7 天） |
| `YFY_MAX_STATE_BYTES` | `2147483648` | SQLite + WAL + 逻辑状态上限（2 GiB） |

- 同一 `YFY_STATE_DB` **只允许一个进程**打开。
- 完整性结论仅在终态清单明确返回 `safe_to_claim_absence=true`（以及对应 `agent_guidance.may_claim_absence=true`）时成立。
- 查询分页绑定 `commit_watermark`（已提交的扫描进度标记），不会读到尚未写入本地库的观测结果。

---

## Provider 请求

| 变量 | 默认 |
|---|---:|
| `YFY_REQUEST_TIMEOUT_MS` | `30000` |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` |
| `YFY_MAX_PAGE_CAPACITY` | `500` |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` |
| `YFY_RETRY_BASE_DELAY_MS` | `500` |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `40` |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `20` |

- 两项并发硬上限均为 `40`；per-identity 不能高于全局。
- 访问身份由用户、Enterprise、external enterprise 共同界定；预签名文件下载按完整 access identity 单独分桶。
- **仅安全只读**请求自动重试；非幂等写请求不会自动重放。
- 收到响应头后的 transfer stream 若发生可重试中断，`yfy_download` 会**再获取一次 ticket**；第二次尝试只用 `YFY_DOWNLOAD_WALL_TIMEOUT_MS` 的**剩余**时间，不会重置完整超时。调用方取消后不重试。

`YFY_ALLOW_PRIVATE_TRANSFER_URLS` 默认 `disabled`。仅可信私有部署可启用：会放宽下载/上传 ticket 的 SSRF 地址限制。

---

## 其他

| 变量 | 默认 | 说明 |
|---|---:|---|
| `YFY_UPLOAD_ROOT_DIR` | 空 | mutation 本地上传白名单根目录 |
| `YFY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

`yfy_status` 返回非敏感配置摘要、下载交付方式、临时存储用量与 workflow readiness；**不**返回密钥、Bearer 或临时根路径。
