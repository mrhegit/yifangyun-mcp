# 配置指南

beta.10 默认只启用轻量 Drive 平面。Workspace、Inventory、Capture、Organization 和写入能力都必须显式开启。`transfer` 不进 Tender 默认矩阵。

服务只读取当前进程环境变量，不会自动加载项目目录中的 `.env`。本地运行可使用 `node --env-file=.env dist/index.js`；MCP Host、容器和进程管理器应通过各自的 env 配置注入。运行后以 `yfy_status.runtime` 和 `capabilities` 为实际生效值。

## 配置层次

| 层次 | 配置 | 作用 |
|---|---|---|
| Toolset | `YFY_TOOLSETS` | 决定注册哪些工具 |
| Access Context | `YFY_ACCESS_CONTEXTS_JSON` | 定义可选择的 Provider 用户身份 |
| Workspace | `YFY_WORKSPACES_JSON` | 将命名业务目录绑定到身份 |
| Workflow Profile | `YFY_WORKFLOW_PROFILES` | 注册 Tender Guidance 和 Prompt，不授予权限 |

普通 Drive 权限是 Provider 权限与已启用 toolset 的交集。Workspace-bound 能力还要求文件位于配置目录内。

## 必填变量

| 变量 | 作用 | 格式与约束 |
|---|---|---|
| `YFY_CLIENT_ID` | 亿方云 OAuth 应用 ID，用于企业和用户 token 交换 | 非空字符串；必须与 secret、企业和回调配置属于同一应用 |
| `YFY_CLIENT_SECRET` | OAuth 应用密钥；同时用于 cursor、Inventory ref 和配置指纹签名 | 非空敏感值；不得写入日志、Prompt 或仓库；轮换后旧 cursor/ref 立即失效 |
| `YFY_ENTERPRISE_ID` | 默认企业 ID | 纯数字字符串 |
| `YFY_DEFAULT_USER_ID` | 自动创建的 `default` Access Context 所使用的用户 ID | 纯数字字符串；该用户的 Provider ACL 决定默认 Drive 可见范围 |

缺少任一必填变量时服务拒绝启动。ID 不应转为 JavaScript number 后再写入配置，以免大整数精度丢失。

## Toolsets

```env
YFY_TOOLSETS=drive
```

| 值 | 云端行为 | 本地行为 | 主要能力 |
|---|---|---|---|
| `drive` | 只读和下载 | 临时 Resource | status、browse、search、resolve、get、versions、open、comments、shares、Resource release |
| `workspace` | 只读 | 无 | Workspace 校验和成员关系 |
| `inventory` | 递归只读扫描 | SQLite | refresh、完整性、固定水位搜索、取消和释放 |
| `evidence` | 下载 | 临时 Resource | Workspace-bound Capture 和共享 Resource release |
| `organization` | 只读 | 无 | department、user、group 明确工具 |
| `collaboration` | 读写 | 无 | 协作读取和变更 |
| `mutation` | 写入 | 可读取上传目录 | 创建、移动、删除、恢复、上传 |
| `admin` | 读写 | 无 | 企业管理和日志 |
| `transfer` | 读取短时 URL | 无 | 敏感 Provider 下载 ticket（**永不进入投标默认**） |

`YFY_TOOLSETS` 是逗号分隔列表，重复值会去重，未知值会导致启动失败。建议从最小集合开始：

- `drive` 是普通浏览、搜索、元数据和 `yfy_open` 的基础平面。
- `workspace` 只提供范围校验，不自动限制普通 Drive 工具。
- `inventory` 会产生 Provider 递归读取和本地 SQLite 写入，但不修改云端。
- `evidence` 会下载并暂存原件，但不修改云端。
- `collaboration`、`mutation`、`admin` 含云端写操作，应只在明确需要时启用。
- `transfer` 直接返回短时 Provider URL，敏感度高于普通 `yfy_open`；**投标与只读审计流不要启用**。

### Tender Profile 工具矩阵

| 场景 | `YFY_TOOLSETS` | 说明 |
|---|---|---|
| 仅浏览 | `drive` | 默认 |
| **投标完整工作流** | **`drive,workspace,inventory,evidence`** | Profile `tender` 强制要求；`transfer` / `organization` / 写工具均不在默认矩阵 |
| 投标 + 组织通讯录 | `drive,workspace,inventory,evidence,organization` | 可选扩展，非 Profile 强制 |
| 显式下载 ticket | 在矩阵上**额外**追加 `,transfer` | 仅在明确需要短时 Provider URL 时；永不默认 |

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
```

`YFY_WORKFLOW_PROFILES` 是逗号分隔列表。当前仅支持 `tender`；它注册 Guidance 和 Prompt，不授予额外权限。启用 `tender` 时必须同时启用 `drive,workspace,inventory,evidence`，并至少配置一个 Workspace，否则服务拒绝启动。**`transfer` 永不作为 tender 默认或强制依赖。**

## Access Context

服务自动创建 `default` Context。附加身份：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"reviewer","user_id":"531","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=default
```

| 配置/字段 | 必填 | 作用与约束 |
|---|---|---|
| `YFY_DEFAULT_ACCESS_CONTEXT` | 否 | 未显式传 `access_context` 时使用的 Context；默认 `default`，必须引用已存在 Context |
| `YFY_ACCESS_CONTEXTS_JSON` | 否 | 附加身份数组；默认 `[]` |
| `id` | 是 | Context 稳定名称，只能包含字母、数字、`_`、`-`；不能重复，也不能再次定义 `default` |
| `user_id` | 是 | 该 Context 代表的 Provider 用户，纯数字字符串 |
| `external_enterprise_id` | 否 | 跨企业/外部企业场景需要的 Provider 企业 ID，纯数字字符串；普通单企业部署省略 |

每个 Context 独立参与 token、请求并发桶和 Workspace 绑定。增加 Context 不会扩大 Provider ACL，只是允许工具显式选择另一个已授权用户身份。

## Workspace

```env
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | Agent 使用的稳定 Workspace 名称 |
| `root_folder_id` | 是 | 业务目录根文件夹 ID |
| `access_context` | 否 | 默认 `default` |
| `tags` | 否 | 说明性标签，不改变权限 |

Workspace 不会授予 Provider 权限。启动后使用 `yfy_workspace_validate` 验证目录、业务路径和身份可达性。

普通位置引用为 `workspace:<id>`。Workspace、Inventory 和 Capture 工具也只接受该完整 Ref，不接受裸 `id`。Drive 工具可从该位置开始，但只有 Workspace/Inventory/Capture 工具提供范围保证。

Workspace 的 `root_folder_id`、`access_context` 或身份配置变化后，旧 ItemRef、Inventory Ref 和 Inventory cursor 不应继续使用。Inventory 会持久化创建时的配置 Workspace 根和实际 scan root；当前配置根不匹配时返回 `YFY_INVENTORY_STALE`，不会动态重解释旧扫描。`inventory` 为稳定 MAC 句柄（`inventory:<uuid>@<access_context>.<mac24>`），MAC 绑定 `YFY_CLIENT_SECRET`、Inventory ID 和 Access Context，状态访问时再复核 workspace fingerprint；同一 inventory 多次返回相同字符串。更换 secret 后必须重新创建 Inventory 以取得新 Ref。调用 `yfy_status` 获取新的 PlaceRef，并从 Browse、Resolve、Search 或 Inventory 结果重新发现项目。

## Inventory

| 变量 | 默认值 | 作用 | 约束与调优建议 |
|---|---:|---|---|
| `YFY_STATE_DB` | `<YFY_TEMP_DIR>/state.sqlite` | Inventory 状态、frontier、item 索引和 receipt 的 SQLite 文件 | 使用绝对或可解析路径；不能位于 `<YFY_TEMP_DIR>/artifacts`；同一文件只允许一个服务进程持有锁 |
| `YFY_INVENTORY_CONCURRENCY` | `2` | 单个 Inventory worker 同时读取的 Provider 页面数 | 允许 1-8；提高会加快宽目录扫描，也会增加 429、Provider 延迟和前台请求竞争 |
| `YFY_INVENTORY_TTL_SECONDS` | `604800` | Inventory 本地状态的失效/保留时间 | 正整数；运行任务会刷新活动 TTL，终态超过 TTL 后清理；不等同于 freshness |
| `YFY_MAX_STATE_BYTES` | `2147483648` | SQLite 主文件、WAL 和索引增长的物理配额 | 正整数；达到上限时任务失败为 `YFY_INVENTORY_STORAGE_INSUFFICIENT`，不会静默丢项 |

保留期决定本地状态何时可清理；`yfy_inventory_create.refresh.max_age_seconds` 决定本次调用是否接受复用。两者是独立概念：TTL 长并不表示观察仍足够新，freshness 短也不会立即删除旧状态。

beta.10 重新建立内部状态和签名格式。`0.4.0` 的 `YFY_SCAN_DIR` 文件状态不兼容，不会自动迁移、覆盖或删除；升级时必须停止旧进程并配置新的空 `YFY_STATE_DB`。

`yfy_inventory_create` 不提供隐藏的 limits 默认值，每次调用必须显式传。可选 `root_folder` 将扫描限制在 Workspace 内已验证的子树（适合大资料库）：

```json
{
  "workspace":"workspace:tender_public",
  "root_folder":"folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa",
  "refresh":{"mode":"reuse_if_fresh","max_age_seconds":300},
  "limits":{"max_item_depth":8,"max_items":10000}
}
```

`max_item_depth` 允许 1-100，`max_items` 允许 1-1,000,000。达到任一边界会使 Inventory 不完整，因此 limits 是业务证明边界，不只是性能配置。`reuse_if_fresh.max_age_seconds` 允许 0-604800，省略时为 300；`force_refresh` 不接收 max age，并始终创建新任务。缺失结论仅在 `safe_to_claim_absence=true` / `agent_guidance.may_claim_absence=true` 时成立。

`yfy_inventory_search` 的首次调用默认 `limit=25`，最大 100；默认搜索 name 和 path，大小写不敏感。cursor 固定首次查询的 commit watermark，后台扫描新增提交不会改变已有分页视图。

物理配额以 `retention.storage.database_bytes`、`logical_bytes` 和 `wal_bytes` 观察。`database_bytes` 代表 SQLite 活动文件占用，WAL 单独报告；达到 `YFY_MAX_STATE_BYTES` 时任务显式失败，不会通过丢弃 item 或 receipt 继续。

## Content Resource

| 变量 | 默认值 | 作用 | 约束与调优建议 |
|---|---:|---|---|
| `YFY_TEMP_DIR` | `<OS temp>/yifangyun-mcp` | 下载临时文件、Evidence artifacts 和默认 SQLite 的父目录 | 运行用户必须可写；生产环境应使用持久、受限权限、容量可监控的目录 |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` | 注册 Resource 和遗留临时文件的最长本地生存期 | 正整数；到期读取失败并删除内容；正常消费后仍应立即调用 `yfy_resource_release` |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` | 单次下载或上传 safeguard 的最大字节数 | 正整数；有无 Content-Length 都执行；超过时中止，不保留部分内容 |
| `YFY_MAX_EVIDENCE_RESOURCE_BYTES` | `16777216` | 单个 MCP Resource/part 的最大字节数 | 必须小于等于 `YFY_MAX_DOWNLOAD_BYTES`；大文件改为 multipart，不改变原件总大小 |
| `YFY_MAX_TEMP_BYTES` | `1073741824` | 当前进程所有并发临时下载的共享预留配额 | 正整数；无 Content-Length 时按单次最大下载量预留，防止并发耗尽磁盘 |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` | 下载流连续无进展的超时 | 正整数；慢但持续传输不会触发，网络挂起会中止 |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` | 单次下载从开始到结束的总时限 | 正整数；应大于 idle timeout，超大文件或低带宽部署可谨慎提高 |
| `YFY_ALLOW_PRIVATE_TRANSFER_URLS` | `disabled` | 是否允许下载/上传 ticket 解析到私网、回环或保留地址 | 接受 `enabled/disabled`、`true/false`、`1/0`、`yes/no`；仅可信私有部署可开启，开启会扩大 SSRF 风险面 |
| `YFY_UPLOAD_ROOT_DIR` | 未配置 | 本地上传源文件允许目录 | 仅 `mutation` 上传工具使用；未配置时拒绝本地上传；路径解析、打开文件句柄和后续上传绑定同一已验证文件 |

单个 Resource 超过 `YFY_MAX_EVIDENCE_RESOURCE_BYTES` 时返回 multipart manifest，每个 part 不超过该上限。该上限不能大于 `YFY_MAX_DOWNLOAD_BYTES`。

任何 Agent-facing 结果都不返回服务器本地路径。Open/Capture 的 `include_text_preview` 默认 true：不超过 32 KiB 的可预览 UTF-8 内容在 Registry 复核大小和 SHA-256 后，以 MCP embedded resource 和 `structuredContent.resource.preview_text` 返回；compact text 不重复正文。设为 false 时只返回 resource link。Resource 到期、释放或完整性失败后会删除临时内容。

## Provider 与重试

| 变量 | 默认值 | 作用 | 约束与调优建议 |
|---|---:|---|---|
| `YFY_API_BASE_URL` | `https://open.fangcloud.com/api` | 亿方云 OpenAPI 根地址 | 自动移除末尾 `/`；非 localhost 必须 HTTPS；禁止 URL userinfo；私有部署才需要覆盖 |
| `YFY_OAUTH_BASE_URL` | `https://open.fangcloud.com` | 企业和用户 OAuth token 根地址 | URL 约束同上；通常与 API base 属于同一部署 |
| `YFY_REQUEST_TIMEOUT_MS` | `30000` | 每次 Provider HTTP 尝试的 wall timeout | 正整数；从一次尝试开始计时，包含身份/全局并发排队和实际请求，不替代下载专用 timeout |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` | token 到期前提前刷新的安全窗口 | 正整数；过小可能在请求途中到期，过大会增加 token 交换频率 |
| `YFY_MAX_PAGE_CAPACITY` | `500` | 发给 Provider 的单页容量硬上限，也是 Inventory page capacity | 正整数；工具的 Agent-facing limit 可以更小；提高会增加单响应内存和输出投影成本 |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` | 幂等安全请求面对 429、5xx 或网络错误时的总尝试次数 | 正整数，包含首次请求；非幂等 POST 默认不自动重试 |
| `YFY_RETRY_BASE_DELAY_MS` | `500` | 指数退避的基础延迟 | 正整数；过小会放大 Provider 压力，过大会延长恢复时间 |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` | 单次重试等待上限 | 正整数；Provider `Retry-After` 和退避结果都会受该上限约束 |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `4` | 当前进程所有 Provider 请求的全局并发上限 | 正整数；保护租户和本机资源；应不小于单身份上限，通常不宜大幅提高 |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `2` | 每个 Access Context/请求桶的并发上限 | 正整数；防止单一身份占满全局容量；多个 Context 可共享全局上限 |

非 localhost URL 必须使用 HTTPS，不能含 userinfo 凭据。

重试等待和并发排队都响应 MCP 取消信号。增大 timeout 或 retry 次数不会削弱客户端取消；但会提高无人取消时的最坏完成时间，应结合 Provider SLA 计算。

## HTTP

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=
YFY_HTTP_ALLOWED_HOSTS=
YFY_HTTP_ALLOWED_ORIGINS=
```

| 变量 | 默认值 | 作用 | 约束与调优建议 |
|---|---:|---|---|
| `YFY_TRANSPORT` | `stdio` | MCP 传输模式 | 仅允许 `stdio` 或 `http`；stdio 不监听网络端口 |
| `YFY_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址 | 非 `127.0.0.1/localhost/::1` 时必须同时配置 Bearer、Host 和 Origin 白名单 |
| `YFY_HTTP_PORT` | `3000` | HTTP 监听端口 | 正整数；端口占用会导致启动失败 |
| `YFY_HTTP_MAX_SESSIONS` | `100` | 同时保留的 stateful MCP session 上限 | 正整数；达到上限时优先关闭最老且无活动请求的 session，否则返回容量错误 |
| `YFY_HTTP_SESSION_IDLE_SECONDS` | `1800` | 无活动请求 session 的空闲回收时间 | 正整数；清理周期不超过 60 秒；过小会导致长间隔客户端频繁重连 |
| `YFY_HTTP_BEARER_TOKEN` | 未配置 | HTTP Authorization Bearer | 非回环监听必填；只要配置，所有 HTTP 请求都必须携带；使用 timing-safe compare；应为高熵随机值并通过 secret 管理器注入 |
| `YFY_HTTP_ALLOWED_HOSTS` | 未配置 | 逗号分隔的 Host 白名单 | 非回环监听必填；传给 MCP Express Host 校验，填写客户端实际访问 Host |
| `YFY_HTTP_ALLOWED_ORIGINS` | 未配置 | 逗号分隔的 Origin 精确白名单 | 非回环监听必填；请求带 Origin 且不在列表时返回 403；值应包含 scheme 和端口 |

HTTP 端点为 `POST/GET/DELETE /mcp`、`GET /health` 和 `GET /metrics`。Bearer/Origin middleware 对 HTTP 应用生效；生产环境仍应在反向代理配置 TLS、请求体限制、连接限制和速率限制。

## 日志

| 变量 | 默认值 | 作用与约束 |
|---|---:|---|
| `YFY_LOG_LEVEL` | `info` | 结构化 stderr 日志最低级别；仅允许 `debug`、`info`、`warn`、`error` |

日志和 provenance 会脱敏 Bearer、签名 URL、下载 pathname 和 access context。生产环境不应通过 `debug` 长期采集高体积日志；任何级别都不应依赖日志保存原件内容或凭据。

## 通用校验规则

- 所有整数型变量解析后必须是大于 0 的整数；当前只有 `YFY_INVENTORY_CONCURRENCY` 额外限制为 1-8。ID 字段则严格要求纯数字字符串。
- CSV 变量按逗号拆分并去除空白；空字符串等同未配置。
- JSON 变量必须是合法 JSON 数组，字段名和类型严格按本页 schema；重复 Context/Workspace ID 会导致启动失败。
- 路径会通过 `path.resolve` 规范化。生产环境应显式配置绝对路径，避免工作目录变化导致状态或临时文件落到不同位置。
- 配置修改只在新进程启动时生效，不支持热重载。重启后旧 Resource token 不可用；`YFY_CLIENT_SECRET` 变化会使旧普通 cursor、Inventory ref 和 Inventory cursor 失效。
- `yfy_status.server.config_fingerprint` 可用于判断影响 Agent 契约的配置是否变化。它不包含 secret 明文，但不应被解释为 Provider 内容版本。
- Context-bound ItemRef 中的身份指纹必须与当前 Access Context 匹配；身份配置变化后调用方应重新发现 Ref，而不是修改 Ref 字符串。

## 示例

只浏览：

```env
YFY_TOOLSETS=drive
YFY_WORKSPACES_JSON=[]
YFY_WORKFLOW_PROFILES=
```

完整投标工作流（**默认矩阵，不含 transfer**）：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

投标 + 组织查询（可选扩展，仍不含 transfer）：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence,organization
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

启用 Toolset 只注册能力，不绕过 Provider ACL。`inventory` 和内容工具不修改云端，但会写本地 SQLite 或临时 Resource。`transfer` 仅在明确需要短时 Provider URL 时单独追加。
