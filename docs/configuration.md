# 配置指南

本文说明每个环境变量控制什么能力、有哪些可选值，以及常见部署场景应如何组合。完整工具参数见 [工具参考](tools.md)，进程和网络部署见 [部署指南](deployment.md)。

## 先理解三个配置层次

| 层次 | 配置 | 解决的问题 | 是否授予亿方云权限 |
|---|---|---|---|
| 功能开关 | `YFY_TOOLSETS` | MCP Server 暴露哪些工具 | 否 |
| 业务边界 | `YFY_SCOPES_JSON` | 哪个目录、由哪个身份作为 Authority 范围 | 否，只会收窄已有权限 |
| 工作流模板 | `YFY_WORKFLOW_PROFILES` | 是否注册 Tender Prompt 和专用 Guidance | 否 |

普通读取工具和 Scope-bound 工具的边界不同：

```text
普通读取能力 = 亿方云 OAuth/用户权限 ∩ 已启用 Toolset
Scope-bound 能力 = 亿方云 OAuth/用户权限 ∩ 已启用 Toolset ∩ Authority Scope
```

Scope 不会全局限制 `yfy_item_get`、`yfy_item_search` 等 Core 工具。需要强制业务目录边界时，应使用 `yfy_scope_check(mode="assert")`、Snapshot 或 `yfy_evidence_capture`。

## 选择运行模式

| 场景 | Toolsets | Scope | Profile | 能力 |
|---|---|---|---|---|
| 只读浏览和搜索 | `core` | 不需要 | 留空 | 元数据、目录、搜索、路径、版本、评论、分享信息 |
| 只读并下载校验 | `core,evidence` | 必须 | 留空 | 上述能力加 Authority-bound 当前版/历史版捕获、哈希与验证 |
| 权威资料工作流 | `core,authority,snapshot,evidence` | 必须 | 留空 | 范围证明、完整目录快照和 Evidence Capture；由上层 Agent 自行编排 |
| 投标专用工作流 | `core,organization,authority,snapshot,evidence` | 必须 | `tender` | 上述能力加 Tender Prompt、Guidance 和启动 readiness 校验 |
| 云端内容变更 | 在所需组合上增加 `mutation` | 按业务决定 | 任意 | 创建、移动、删除、上传；属于云端写能力 |
| 管理和协作变更 | 增加 `collaboration` 或 `admin` | 按业务决定 | 任意 | 协作成员和企业管理操作，高风险 |

## 配置加载方式

服务只读取进程环境变量，不会因为目录中存在 `.env` 就自动加载。可以使用以下任一种方式：

- 在 MCP 客户端配置的 `env` 中传入变量。
- 由 Docker、systemd、Kubernetes 或进程管理器注入变量。
- Node.js 24 本地运行时使用 `node --env-file=.env dist/index.js`。

`.env.example` 是模板，不包含真实凭据。不要把包含密钥的 `.env` 提交到版本库。

常见值格式：

| 类型 | 示例 | 规则 |
|---|---|---|
| CSV | `core,authority,evidence` | 逗号分隔，首尾空格会被移除 |
| JSON 数组 | `[{"id":"reviewer","user_id":"531"}]` | 必须是合法 JSON，环境变量中通常写成单行 |
| 正整数 | `30000` | 必须大于 0；`0`、小数和负数会导致启动失败 |
| 布尔开关 | `enabled` | 接受 `enabled/true/1/yes` 和 `disabled/false/0/no` |
| URL | `https://open.fangcloud.com/api` | 非 localhost 必须使用 HTTPS，不能包含用户名或密码 |

## 必填凭据

| 变量 | 格式 | 作用 |
|---|---|---|
| `YFY_CLIENT_ID` | 非空字符串 | 亿方云 OAuth 应用 ID |
| `YFY_CLIENT_SECRET` | 非空字符串 | OAuth 应用密钥，也用于服务端签名和配置指纹 HMAC；不得暴露给 Agent |
| `YFY_ENTERPRISE_ID` | 纯数字字符串 | 企业 ID，用于企业级 OAuth 和管理接口 |
| `YFY_DEFAULT_USER_ID` | 纯数字字符串 | 自动生成 `default` Access Context 时使用的云盘用户 ID |

缺少任一变量时服务拒绝启动。凭据有效但用户没有目标文件权限时，服务可以启动，实际工具调用会返回认证或授权错误。

## Provider 地址

| 变量 | 默认值 | 何时修改 |
|---|---|---|
| `YFY_API_BASE_URL` | `https://open.fangcloud.com/api` | 私有化部署或代理 OpenAPI 时修改 |
| `YFY_OAUTH_BASE_URL` | `https://open.fangcloud.com` | 私有化 OAuth 地址不同时修改 |

非本地地址必须使用 HTTPS，URL 不允许包含 userinfo 凭据。

## Toolsets：选择暴露哪些功能

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
```

不配置时默认启用上面的五组。值为逗号分隔列表，重复项会自动去重，可选值如下：

| 值 | 云端行为 | 本地行为 | 主要工具和用途 | 建议 |
|---|---|---|---|---|
| `core` | 只读 | 无持久化写入 | 认证检查、元数据、目录、搜索、路径、版本、评论、分享元数据 | 几乎所有部署都应启用 |
| `authority` | 只读 | 无持久化写入 | 验证 Scope，查询或断言文件是否在业务范围内 | 使用 Scope 时启用 |
| `snapshot` | 只读扫描 | 写 SQLite | 后台遍历 Scope，生成完整性状态和可查询索引 | 需要完整性判断时启用 |
| `evidence` | 下载文件 | 写临时 Artifact | 当前/历史版本捕获、哈希、Scope 和漂移检测 | 需要原件或内容验证时启用 |
| `organization` | 只读 | 无 | 部门、企业用户和群组读取 | Tender Profile 强制要求；其他场景可选 |
| `collaboration` | 读取和写入 | 无 | 查询协作、邀请成员、改角色、移除协作 | 高风险，按需开启 |
| `mutation` | 写入 | 可读取上传目录 | 创建、更新、移动、复制、删除、恢复、上传 | 高风险，按需开启 |
| `admin` | 读取和写入 | 无 | 企业部门、群组、用户、日志和平台治理 | 仅管理员隔离环境开启 |
| `transfer` | 获取短时 URL | 无 | 返回敏感 Provider 下载 URL | 常规 Evidence 不需要，不建议默认开启 |

示例：只允许浏览，不允许下载或扫描：

```env
YFY_TOOLSETS=core
```

示例：通用权威资料工作流，但不开 Tender Prompt：

```env
YFY_TOOLSETS=core,authority,snapshot,evidence
YFY_WORKFLOW_PROFILES=
```

启用 Toolset 只决定工具是否注册，不会绕过 Provider 权限。`snapshot` 和 `evidence` 虽然不修改云端文件，但会写本地数据库或临时文件，因此不属于无副作用操作。

## Access Contexts：定义访问身份

服务始终根据 `YFY_DEFAULT_USER_ID` 自动生成：

```json
{"id":"default","user_id":"YFY_DEFAULT_USER_ID"}
```

`YFY_ACCESS_CONTEXTS_JSON` 用于定义附加身份，`YFY_DEFAULT_ACCESS_CONTEXT` 决定工具未传 `access_context` 时使用哪个身份：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"external_reviewer","user_id":"531","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=default
```

字段说明：

| 字段 | 必填 | 格式 | 作用 |
|---|---|---|---|
| `id` | 是 | 字母、数字、`_`、`-` | Agent 使用的稳定身份名称 |
| `user_id` | 是 | 纯数字字符串 | 实际访问亿方云的用户 ID |
| `external_enterprise_id` | 否 | 纯数字字符串 | 外部企业或跨企业访问上下文 |

多个身份示例：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"reviewer","user_id":"531"},{"id":"external_reviewer","user_id":"532","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=reviewer
```

注意：

- `default` 已自动创建，不能在 JSON 中再次定义。
- Context ID 必须唯一。
- 默认 Context 必须引用已存在的 ID。
- Context 只是封装身份，不会存储独立 OAuth 密钥。
- Agent 看到 Context ID，但 `yfy_context_get` 不返回裸 user ID。

## Authority Scopes：定义业务目录边界

```env
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

字段说明：

| 字段 | 必填 | 格式 | 作用 |
|---|---|---|---|
| `id` | 是 | 字母、数字、`_`、`-` | Agent 使用的稳定业务范围名称 |
| `root_folder_id` | 是 | 纯数字字符串 | Scope 根文件夹；后代目录属于该范围 |
| `access_context` | 否 | 已配置 Context ID，默认 `default` | 使用哪个身份访问该目录 |
| `tags` | 否 | 非空字符串数组 | 业务标签，仅用于说明和选择，不改变权限 |

Scope 是服务端业务边界，不是亿方云 ACL。它不会授予访问权，只能证明某文件是否位于配置目录内，并限制 Snapshot 和 Evidence Capture 的工作范围。

多个业务范围示例：

```env
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender","public-material"]},{"id":"contracts_archive","root_folder_id":"501000800000","access_context":"reviewer","tags":["contract"]}]
```

每个 Scope 必须引用已配置 Context，Scope ID 不能重复。配置只做结构校验；目录是否存在、身份是否真有权限，应在启动后调用 `yfy_authority_validate` 验证。

如何取得 ID：

- `YFY_ENTERPRISE_ID`、用户 ID：从亿方云应用或企业管理信息中取得。
- `root_folder_id`：先以 `core` 模式启动，使用 `yfy_root_list`、`yfy_folder_list` 或 `yfy_item_get` 找到目标文件夹 ID。
- 不需要多身份时直接使用自动生成的 `default` Context，无需配置 `YFY_ACCESS_CONTEXTS_JSON`。

典型用途：

- `yfy_scope_check(mode="query")`：越界时正常返回 `in_scope=false`。
- `yfy_scope_check(mode="assert")`：越界时返回工具错误，中断工作流。
- `yfy_snapshot_create`：只能扫描命名 Scope，Agent 不能传任意根目录。
- `yfy_evidence_capture`：下载前后都会验证文件仍在 Scope 内，调用方无需先执行重复的 assert。

## 三个容易误解的功能语义

### Search 空结果不等于资料不存在

`yfy_item_search` 查询 Provider 官方索引，只用于候选发现。索引可能存在延迟、权限过滤或 Provider 约束，因此即使 `candidates=[]`，也不能据此声明资料不存在。

需要完整性判断时，应创建 Snapshot，并检查：

| 字段 | 含义 |
|---|---|
| `pagination_complete` | 应访问的 Provider 页面是否全部遍历 |
| `safe_to_claim_absence` | 是否可以在本次已观察 Scope 内声明未找到 |
| `scope` | 不存在结论适用的范围 |
| `consistency_level` | 本次观察的一致性级别 |
| `incomplete_reasons` | 权限、分页、配额、取消等不完整原因 |

只有 `safe_to_claim_absence=true` 时，Agent 才能说“在本次已观察且可访问的 Scope 内不存在”。它不代表文件在整个企业云盘或用户无权访问的区域中不存在。

### Scope query 与 assert

- `mode="query"`：越界时正常返回 `in_scope=false`，适合筛选候选。
- `mode="assert"`：越界时返回 MCP 工具错误，适合必须在业务目录内的工作流。
- `yfy_evidence_capture`：始终在下载前后硬校验 Scope；外部 `yfy_scope_check(mode="assert")` 仅用于不下载的独立业务判断。

### Prompt 统一的是工作流报告

底层工具无论是否启用 Profile 都有稳定 output schema。Tender Prompt 额外要求 Agent 统一报告：

- 资料审计：确认匹配、歧义候选、缺失材料、完整性和观察窗口。
- 原件固化：file ID、Scope/path proof、下载版本、SHA-1、SHA-256、大小、观察时间和 resource URI。
- 版本比较：当前/历史版本、比较字段、匹配结论和不可证明的边界。

这是 Agent 编排约束，不会改变 Provider 权限，也不会替代工具自身的 schema 校验。

## Snapshot 与 SQLite

| 变量 | 默认值 | 可选范围和作用 |
|---|---:|---|
| `YFY_STATE_DB` | `<YFY_TEMP_DIR>/state.sqlite` | Snapshot SQLite 文件；生产环境建议配置固定绝对路径 |
| `YFY_SNAPSHOT_CONCURRENCY` | `2` | 单个 Snapshot 的 Provider 页面抓取并发，范围 `1-8` |
| `YFY_SNAPSHOT_TTL_SECONDS` | `604800` | 快照保留 7 天 |
| `YFY_MAX_STATE_BYTES` | `2147483648` | Snapshot 逻辑数据与 SQLite/WAL 物理大小上限 |
| `YFY_MAX_PAGE_CAPACITY` | `500` | 部署级 Provider 单页容量上限；Agent-facing `page_capacity` schema 最大为 500 |

SQLite 使用 WAL、外键和 5 秒 busy timeout。stdio 与同一进程内的 HTTP 请求共享数据库连接和进程内任务调度器。一个 SQLite 文件同一时间只允许一个 MCP 进程拥有。

页面可以并发抓取，但始终按持久化 FIFO frontier 的确定顺序提交，因此 `max_items`、receipt 和 observation digest 不依赖网络完成顺序。3 字符以上 Snapshot 子串查询使用 FTS5 trigram 索引，1-2 字符查询使用精确匹配。

调优建议：先保持并发 `2`。只有在 Provider 延迟较高、没有明显 429，且身份并发上限足够时再提高到 `4-8`。

## Evidence 临时文件

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `YFY_TEMP_DIR` | 系统临时目录下 `yifangyun-mcp` | Evidence 临时存储根目录 |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` | Artifact 最长保留 24 小时 |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` | 单次下载或上传安全上限，默认 256 MiB |
| `YFY_MAX_EVIDENCE_RESOURCE_BYTES` | `16777216` | 可通过 MCP resource 读取的最大文件，默认 16 MiB |
| `YFY_MAX_TEMP_BYTES` | `1073741824` | 所有 Evidence Artifact 总配额，默认 1 GiB |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` | 下载连续无数据超时 |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` | 单次下载总时长上限 |
| `YFY_ALLOW_PRIVATE_TRANSFER_URLS` | `disabled` | 是否允许 Provider 下载 URL 指向非公网地址 |
| `YFY_UPLOAD_ROOT_DIR` | 空 | `mutation` 上传可读取的本地根目录；为空时上传工具拒绝执行 |

`YFY_MAX_EVIDENCE_RESOURCE_BYTES` 不能大于 `YFY_MAX_DOWNLOAD_BYTES`。所有大小单位均为字节，所有超时单位均为毫秒。

默认拒绝解析到私网、回环、链路本地、运营商共享、组播和保留地址的 Provider transfer URL。只有可信私有化部署才应设置：

```env
YFY_ALLOW_PRIVATE_TRANSFER_URLS=enabled
```

布尔变量接受 `enabled/true/1/yes` 或 `disabled/false/0/no`。
Evidence 配额和 TTL 清理只作用于 `YFY_TEMP_DIR/artifacts`，不会扫描或删除同目录下的 Snapshot SQLite 文件。
`YFY_STATE_DB` 不允许位于 `YFY_TEMP_DIR/artifacts` 内。超过 Evidence resource 上限的文件仍会完成下载和哈希；stdio 返回 `artifact.delivery=local_file`、`local_path` 和可释放 URI，HTTP 会删除文件并返回 `artifact.delivery=omitted`。
`mutation` toolset 的本地上传仅允许读取 `YFY_UPLOAD_ROOT_DIR` 内的文件；未配置时 `yfy_file_upload` 和 `yfy_file_version_upload` 拒绝执行。

## 请求调度

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `YFY_REQUEST_TIMEOUT_MS` | `30000` | 单次 Provider API 请求超时 |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` | Token 到期前提前刷新秒数 |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` | 安全 GET/list 的最大尝试次数 |
| `YFY_RETRY_BASE_DELAY_MS` | `500` | 重试基础退避时间 |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` | Provider Retry-After 和退避上限 |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `4` | 整个进程的 Provider 请求并发上限 |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `2` | 每个 Access Context 身份的并发上限 |

GET/list 可以对 429/5xx 做 jitter 重试；非幂等 POST 不自动重试。

大空间扫描建议让 `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` 不小于 `YFY_SNAPSHOT_CONCURRENCY`。若同一身份还需要低延迟前台 Authority/Evidence 请求，可额外预留 1 个并发槽位。

## Transport：stdio 或 HTTP

| 变量 | 默认值 | 可选值和作用 |
|---|---|---|
| `YFY_TRANSPORT` | `stdio` | `stdio` 或 `http` |
| `YFY_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `YFY_HTTP_PORT` | `3000` | 正整数端口 |
| `YFY_HTTP_MAX_SESSIONS` | `100` | 最大有状态 MCP Session 数 |
| `YFY_HTTP_SESSION_IDLE_SECONDS` | `1800` | 空闲 Session 回收时间 |
| `YFY_HTTP_BEARER_TOKEN` | 空 | HTTP Bearer Token |
| `YFY_HTTP_ALLOWED_HOSTS` | 空 | 逗号分隔 Host 白名单 |
| `YFY_HTTP_ALLOWED_ORIGINS` | 空 | 逗号分隔 Origin 白名单 |

绑定非回环地址时，Bearer、allowed hosts 和 allowed origins 都是必填项，否则服务拒绝启动。仅本机使用时可保持 `127.0.0.1`，但仍建议配置 Bearer。

## Workflow Profile：是否注册专用工作流

`YFY_WORKFLOW_PROFILES` 是逗号分隔列表，默认留空；当前唯一可选值是 `tender`。

启用 `tender` 时必须同时满足：

- 启用 `core`、`organization`、`authority`、`snapshot`、`evidence` 五个 toolset
- 至少配置一个 Authority Scope

配置不完整时服务会拒绝启动，不会注册能力残缺的 Tender Prompt。启用后会注册资料完整性审计、原件固化和版本比较 Prompt。

| Prompt | 作用 | 主要通用工具 |
|---|---|---|
| `yfy_tender_material_audit` | 按材料清单建立 Snapshot，区分确认、歧义和缺失 | Authority Validate、Snapshot Create/Get/Query |
| `yfy_tender_lock_evidence` | 定位文件并在 Scope 内捕获当前原件 | Path/Search、Evidence Capture/Release |
| `yfy_tender_compare_versions` | 查看版本历史并在 Scope 内按已有哈希验证内容 | Context Get、File Versions、Evidence Capture/Release |

不开 Profile 不会移除底层能力。只要 Toolset 和 Scope 已配置，上层 Agent 仍可手动组合 Authority、Snapshot 和 Evidence 工具完成同一流程。

## 日志

```env
YFY_LOG_LEVEL=info
```

可选值为 `debug`、`info`、`warn`、`error`。日志写入 stderr，HTTP `/metrics` 返回进程内计数和延迟聚合。生产环境建议从 `info` 开始，排查 Provider 或 Snapshot 问题时临时使用 `debug`。

## 推荐配置示例

### 1. 最小只读浏览

```env
YFY_CLIENT_ID=...
YFY_CLIENT_SECRET=...
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_TOOLSETS=core
YFY_WORKFLOW_PROFILES=
YFY_SCOPES_JSON=[]
```

可以浏览、搜索、解析路径和查看版本；不能下载 Evidence、创建 Snapshot 或做 Scope 证明。

### 2. 通用权威资料工作流

```env
YFY_CLIENT_ID=...
YFY_CLIENT_SECRET=...
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_TOOLSETS=core,authority,snapshot,evidence
YFY_WORKFLOW_PROFILES=
YFY_SCOPES_JSON=[{"id":"documents","root_folder_id":"501000715605","access_context":"default","tags":["authority"]}]
```

可以做完整性 Snapshot、范围断言和 Evidence Capture，但不注册 Tender Prompt。

### 3. Tender Profile

```env
YFY_CLIENT_ID=...
YFY_CLIENT_SECRET=...
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_TOOLSETS=core,organization,authority,snapshot,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender","public-material"]}]
YFY_STATE_DB=D:/yifangyun-mcp/state.sqlite
YFY_TEMP_DIR=D:/yifangyun-mcp/temp
```

适用于固定、重复的投标资料审计和原件固化流程。Windows 路径示例仅供参考，生产环境应选择服务账户可读写的位置。

### 4. HTTP 部署

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=0.0.0.0
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
```

非回环监听必须同时配置三项安全限制。反向代理仍应限制请求体、连接数和速率。

## 启动时会拒绝的配置

- 缺少四个必填 OAuth/身份变量中的任意一个。
- 企业 ID、用户 ID、文件夹 ID 不是纯数字字符串。
- Toolset 或 Profile 使用未知值。
- Context、Scope ID 重复，或包含不允许的字符。
- Scope 引用不存在的 Context。
- 默认 Context 不存在。
- Tender 缺少任一必需 Toolset 或没有 Scope。
- Snapshot 并发不在 `1-8`。
- Evidence resource 上限大于下载上限。
- SQLite 位于 `YFY_TEMP_DIR/artifacts` 内。
- 非本地 Provider URL 未使用 HTTPS 或包含 userinfo 凭据。
- HTTP 非回环监听缺少 Bearer、Host 或 Origin 白名单。

## 启动后验证

配置通过只代表格式和依赖关系正确，不代表 Provider 凭据、目录和权限真实可用。首次部署建议依次执行：

1. `yfy_connection_check`：验证企业和用户 Token。
2. `yfy_context_get`：确认 Toolsets、Contexts、Scopes、Profile readiness 和服务器版本。
3. `yfy_authority_validate`：验证每个 Scope 的目录、业务路径和分页可达性。
4. 对小 Scope 执行一次 Snapshot，确认状态和完整性语义。
5. 对受控小文件执行 Evidence Lock 和 Release，确认下载、哈希和临时目录权限。
