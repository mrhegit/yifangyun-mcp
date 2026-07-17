# 配置指南

beta.5 默认只启用轻量 Drive 平面。Workspace、Inventory、Capture、Organization 和写入能力都必须显式开启。

## 配置层次

| 层次 | 配置 | 作用 |
|---|---|---|
| Toolset | `YFY_TOOLSETS` | 决定注册哪些工具 |
| Access Context | `YFY_ACCESS_CONTEXTS_JSON` | 定义可选择的 Provider 用户身份 |
| Workspace | `YFY_WORKSPACES_JSON` | 将命名业务目录绑定到身份 |
| Workflow Profile | `YFY_WORKFLOW_PROFILES` | 注册 Tender Guidance 和 Prompt，不授予权限 |

普通 Drive 权限是 Provider 权限与已启用 toolset 的交集。Workspace-bound 能力还要求文件位于配置目录内。

## 必填变量

```env
YFY_CLIENT_ID=
YFY_CLIENT_SECRET=
YFY_ENTERPRISE_ID=
YFY_DEFAULT_USER_ID=
```

ID 必须是纯数字字符串。`YFY_CLIENT_SECRET` 同时用于 cursor、Inventory ref 和配置指纹签名，不会返回给 Agent。

## Toolsets

```env
YFY_TOOLSETS=drive
```

| 值 | 云端行为 | 本地行为 | 主要能力 |
|---|---|---|---|
| `drive` | 只读和下载 | 临时 Resource | status、browse、search、resolve、get、versions、open、comments、shares、Resource release |
| `workspace` | 只读 | 无 | Workspace 校验和成员关系 |
| `inventory` | 递归只读扫描 | SQLite | freshness、完整性、搜索和取消 |
| `evidence` | 下载 | 临时 Resource | Workspace-bound Capture 和共享 Resource release |
| `organization` | 只读 | 无 | department、user、group 明确工具 |
| `collaboration` | 读写 | 无 | 协作读取和变更 |
| `mutation` | 写入 | 可读取上传目录 | 创建、移动、删除、恢复、上传 |
| `admin` | 读写 | 无 | 企业管理和日志 |
| `transfer` | 读取短时 URL | 无 | 敏感 Provider 下载 ticket |

Tender Profile 要求：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
```

## Access Context

服务自动创建 `default` Context。附加身份：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"reviewer","user_id":"531","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=default
```

`id` 只能包含字母、数字、`_` 和 `-`。`default` 不能重复定义。

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

普通位置引用为 `workspace:<id>`。Drive 工具可从该位置开始，但只有 Workspace/Inventory/Capture 工具提供范围保证。

## Inventory

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_STATE_DB` | `<temp>/state.sqlite` | SQLite 状态库；不能位于 artifacts 目录 |
| `YFY_INVENTORY_CONCURRENCY` | `2` | Provider 页并发，范围 1-8 |
| `YFY_INVENTORY_TTL_SECONDS` | `604800` | 本地保留期，不等同于调用方 freshness |
| `YFY_MAX_STATE_BYTES` | `2147483648` | SQLite/WAL/索引容量上限 |

保留期决定状态何时删除；`yfy_inventory_create.freshness.max_age_seconds` 决定本次调用是否接受复用。

beta.5 SQLite schema 为 3。旧状态库会返回 `YFY_STATE_SCHEMA_MISMATCH`，不会自动迁移。

## Content Resource

| 变量 | 默认值 |
|---|---:|
| `YFY_TEMP_DIR` | OS temp 目录 |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` |
| `YFY_MAX_EVIDENCE_RESOURCE_BYTES` | `16777216` |
| `YFY_MAX_TEMP_BYTES` | `1073741824` |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` |

单个 Resource 超过 `YFY_MAX_EVIDENCE_RESOURCE_BYTES` 时返回 multipart manifest，每个 part 不超过该上限。该上限不能大于 `YFY_MAX_DOWNLOAD_BYTES`。

任何 Agent-facing 结果都不返回服务器本地路径。Resource 到期、释放或完整性失败后会删除临时内容。

## Provider 与重试

| 变量 | 默认值 |
|---|---|
| `YFY_API_BASE_URL` | `https://open.fangcloud.com/api` |
| `YFY_OAUTH_BASE_URL` | `https://open.fangcloud.com` |
| `YFY_REQUEST_TIMEOUT_MS` | `30000` |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` |
| `YFY_RETRY_BASE_DELAY_MS` | `500` |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `4` |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `2` |
| `YFY_MAX_PAGE_CAPACITY` | `500` |

非 localhost URL 必须使用 HTTPS，不能含 userinfo 凭据。

## HTTP

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=
YFY_HTTP_ALLOWED_HOSTS=
YFY_HTTP_ALLOWED_ORIGINS=
```

非回环监听必须配置 Bearer、Host 和 Origin 白名单。会话限制由 `YFY_HTTP_MAX_SESSIONS` 和 `YFY_HTTP_SESSION_IDLE_SECONDS` 控制。

## 上传与日志

```env
YFY_UPLOAD_ROOT_DIR=
YFY_ALLOW_PRIVATE_TRANSFER_URLS=disabled
YFY_LOG_LEVEL=info
```

`YFY_UPLOAD_ROOT_DIR` 限制本地上传源；未配置时 upload 工具拒绝本地路径。日志级别为 `debug/info/warn/error`，日志和 provenance 都会脱敏下载 URL。

## 示例

只浏览：

```env
YFY_TOOLSETS=drive
YFY_WORKSPACES_JSON=[]
```

完整投标工作流：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence,organization
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

启用 Toolset 只注册能力，不绕过 Provider ACL。`inventory` 和内容工具不修改云端，但会写本地 SQLite 或临时 Resource。
