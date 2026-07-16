# 配置说明

## 必填凭据

| 变量 | 说明 |
|---|---|
| `YFY_CLIENT_ID` | OAuth Client ID |
| `YFY_CLIENT_SECRET` | OAuth Client Secret |
| `YFY_ENTERPRISE_ID` | 企业 ID，纯数字字符串 |
| `YFY_DEFAULT_USER_ID` | 默认云盘访问用户 ID |

## Provider 地址

| 变量 | 默认值 |
|---|---|
| `YFY_API_BASE_URL` | `https://open.fangcloud.com/api` |
| `YFY_OAUTH_BASE_URL` | `https://open.fangcloud.com` |

非本地地址必须使用 HTTPS，URL 不允许包含 userinfo 凭据。

## Toolsets

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
```

默认值即上面的五组。`collaboration`、`mutation`、`admin` 和 `transfer` 必须显式开启。

`transfer` 会暴露短时下载 URL。`admin` 可能返回敏感登录材料。两者不应在通用 Agent 环境中默认开启。

## Access Contexts

默认 context 自动生成：

```json
{"id":"default","user_id":"YFY_DEFAULT_USER_ID"}
```

附加 context：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"external_reviewer","user_id":"531","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=default
```

context ID 只能包含字母、数字、下划线和连字符。

## Authority Scopes

```env
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

每个 scope 必须引用已配置的 access context。

推荐为不同业务分别定义 scope：

- `tender_public`
- `contracts_archive`
- `supplier_qualification`
- `audit_workpapers`

## Snapshot 与 SQLite

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_STATE_DB` | `<temp>/state.sqlite` | SQLite 文件 |
| `YFY_SNAPSHOT_CONCURRENCY` | `2` | 单个 Snapshot 的 Provider 页面抓取并发，范围 `1-8` |
| `YFY_SNAPSHOT_TTL_SECONDS` | `604800` | 快照保留 7 天 |
| `YFY_MAX_STATE_BYTES` | `2147483648` | Snapshot 逻辑数据与 SQLite/WAL 物理大小上限 |
| `YFY_MAX_PAGE_CAPACITY` | `500` | Provider 单页上限 |

SQLite 使用 WAL、外键和 5 秒 busy timeout。stdio 与同一进程内的 HTTP 请求共享数据库连接和进程内任务调度器。页面可以并发抓取，但始终按持久化 FIFO frontier 的确定顺序提交，因此 `max_items`、receipt 和 observation digest 不依赖网络完成顺序。3 字符以上 Snapshot 子串查询使用 FTS5 trigram 索引，1-2 字符查询使用精确匹配。

## Evidence 临时文件

| 变量 | 默认值 |
|---|---:|
| `YFY_TEMP_DIR` | 系统临时目录下 `yifangyun-mcp` |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` |
| `YFY_MAX_EVIDENCE_RESOURCE_BYTES` | `16777216` |
| `YFY_MAX_TEMP_BYTES` | `1073741824` |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` |
| `YFY_ALLOW_PRIVATE_TRANSFER_URLS` | `disabled` |
| `YFY_UPLOAD_ROOT_DIR` | 空，禁用本地上传 |

默认拒绝解析到私网、回环、链路本地地址的 Provider transfer URL。
Evidence 配额和 TTL 清理只作用于 `YFY_TEMP_DIR/artifacts`，不会扫描或删除同目录下的 Snapshot SQLite 文件。
`YFY_STATE_DB` 不允许位于 `YFY_TEMP_DIR/artifacts` 内。超过 Evidence resource 上限的文件仍会完成下载和哈希，但不会生成远程 resource link。
`mutation` toolset 的本地上传仅允许读取 `YFY_UPLOAD_ROOT_DIR` 内的文件；未配置时 `yfy_file_upload` 和 `yfy_file_version_upload` 拒绝执行。

## 请求调度

| 变量 | 默认值 |
|---|---:|
| `YFY_REQUEST_TIMEOUT_MS` | `30000` |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` |
| `YFY_RETRY_BASE_DELAY_MS` | `500` |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `4` |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `2` |

GET/list 可以对 429/5xx 做 jitter 重试；非幂等 POST 不自动重试。

大空间扫描建议让 `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` 不小于 `YFY_SNAPSHOT_CONCURRENCY`。若同一身份还需要低延迟前台 Authority/Evidence 请求，可额外预留 1 个并发槽位。

## HTTP

| 变量 | 默认值 |
|---|---|
| `YFY_TRANSPORT` | `stdio` |
| `YFY_HTTP_HOST` | `127.0.0.1` |
| `YFY_HTTP_PORT` | `3000` |
| `YFY_HTTP_MAX_SESSIONS` | `100` |
| `YFY_HTTP_SESSION_IDLE_SECONDS` | `1800` |
| `YFY_HTTP_BEARER_TOKEN` | 空 |
| `YFY_HTTP_ALLOWED_HOSTS` | 空 |
| `YFY_HTTP_ALLOWED_ORIGINS` | 空 |

绑定非回环地址时，Bearer、allowed hosts 和 allowed origins 都是必填项。

## Profile 与日志

`YFY_LOG_LEVEL` 支持 `debug`、`info`、`warn`、`error`。`YFY_WORKFLOW_PROFILES` 是逗号分隔的工作流 profile；当前支持 `tender`，且仅在 Core、Authority、Snapshot、Evidence toolset 同时启用时注册 tender prompts。
