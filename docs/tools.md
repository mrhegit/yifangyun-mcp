# 工具参考

## 通用契约

成功时同时返回：

| 通道 | 内容 |
|---|---|
| `structuredContent` | 完整、机器可读对象 |
| `content[type=text]` | 供只读文本结果的 Host 使用 |

大结果的 text 会被压缩，但会保留操作锚点：cursor、`next_action`、Inventory Ref、`download_id`、`local_path`、`fetch_url`、哈希与关键判断字段。
文本 preview 正文只出现在 `structuredContent`。

失败时 `isError=true`，文本大致为：

```json
{
  "error": {
    "code": "YFY_...",
    "category": "invalid_input|configuration|authentication|authorization|not_found|rate_limited|timeout|provider_unavailable|provider_contract|stale_state|capacity_limit|cancelled|conflict|internal",
    "message": "...",
    "retryable": false,
    "phase": "...",
    "suggested_action": "..."
  }
}
```

---

## Ref（引用）

服务返回的引用示例：

```text
personal
collaboration
department:480
folder:501@default.<identity>
file:502@default.<identity>
workspace:tender_public
version:7001@<bound-file-ref>
inventory:<uuid>@default.<mac>
```

- Ref 与 Cursor 均绑定配置与访问身份。
- **应原样复制**服务返回值，不要自行构造、截断或修改。
- Inventory 不接受裸 `inventory_id`，必须使用带 MAC 的完整 ref。

---

## yfy_status

用于首次接入、排障与能力发现。返回包括：

- Provider 连通性
- 服务 / 版本 / 契约 / 构建标识
- 访问身份与可复制 places
- 已启用 toolsets 与 profile readiness
- `download_delivery`：传输模式、path、staged URL、fetch 上限、并发读上限
- `temp_storage`：已用字节、预留（reservation）、最大字节
- 与传输相关的 `recommended_workflows`
- 非敏感运行配置摘要

---

## Drive

### yfy_browse

列出某一 place 的**直接子项**。
首次请求传业务字段；续页只执行返回的 `next_action`。

### yfy_search

Provider **索引候选**发现，不是完整目录扫描。

务必阅读返回中的：

- `selection_policy`
- `recommended_actions`
- `agent_warnings`
- `coverage`
- `content_search_policy`

规则：

| 情况 | 正确做法 |
|---|---|
| `must_disambiguate` | 禁止直接下载 `hits[0]`，先消歧 |
| `continue_search` | 执行 `next_action` 继续 |
| 空结果 | **不能**证明文件不存在 |
| content 命中 | 永远不可直接 claim 存在性 |
| 确认当前存在 | 使用 `yfy_get` |

### yfy_resolve

从指定 place 按**精确相对路径**逐层解析。
遇同名返回 `ambiguous` 与候选列表，**不**自动选择。

### yfy_get / yfy_get_many

读取当前元数据。
`yfy_get_many` 最多 100 个 Ref，并按项保留 success / error。

### yfy_versions

| 版本类型 | `ref` | 下载时 |
|---|---|---|
| 当前版 | `null` | 省略 `version` 参数 |
| 历史版 | `VersionRef` | 原样传入 `version` |

`download_ready=true` 表示该版本具备校验下载所需的 SHA-1 与大小元数据。

---

## yfy_download

下载当前版或历史版；**正文解析由 Host 完成**。

### 输入示例

```json
{
  "file": "file:502@default.<identity>",
  "version": "version:7001@...",
  "workspace": "workspace:tender_public",
  "include_text_preview": false,
  "expected": {
    "sha1": "可选",
    "sha256": "可选",
    "size_bytes": 123
  }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `file` | 是 | FileRef |
| `version` | 否 | 历史 VersionRef；省略 = 当前版 |
| `workspace` | 否 | 提供则强制下载前/后 membership 均为 inside |
| `include_text_preview` | 否 | 默认 false；仅小文本 UTF-8 完整预览 |
| `expected` | 否 | 调用方哈希/大小断言 |

### 成功结果示例

```json
{
  "status": "ready",
  "file": {"ref": "file:..."},
  "version": {"current": true, "download_ready": true},
  "download": {
    "download_id": "dl_...",
    "local_path": "C:\\...\\file.xlsx",
    "fetch_url": null,
    "media_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "media_type_source": "file_extension",
    "sha1": "...",
    "sha256": "...",
    "size_bytes": 123,
    "expires_at": "2026-07-20T00:00:00.000Z"
  },
  "preview": null,
  "workspace": null,
  "cleanup": {
    "mode": "ttl",
    "ttl_seconds": 86400,
    "release_tool": "yfy_download_release",
    "release_args": {"download_id": "dl_..."}
  },
  "agent_hint": "..."
}
```

### 交付规则

- **stdio 默认**：`local_path` 有值，`fetch_url=null`
- **HTTP 默认**：`fetch_url` 有值，`local_path=null`
- HTTP 可显式同时开放两者；远程 Agent 应优先 URL
- `fetch_url` 使用与 MCP HTTP 相同的认证
- 在 `expires_at` 之前，仍可能因显式 release、完整性失败或 fetch 次数耗尽而失效

### 服务侧校验（摘要）

- 版本存在且顺序明确；含 SHA-1 / size
- Provider 下载结果与所选版本一致
- 下载前后版本 fingerprint 未漂移
- 可选 Workspace membership 前后均为 inside
- 可选 `expected` 全部匹配
- 写盘时同步计算大小、SHA-1、SHA-256；登记时检查最终普通文件类型与大小
- HTTP staged GET：同一 no-follow 文件句柄单遍输出并复核哈希（无预哈希二次读）
- transfer stream 可重试中断时再取一次 ticket；两次尝试共享同一 wall-time 截止点
- 进度通知单调递增，不从已报告字节数回退
- 历史 version id 以十进制**字符串**传输，不经 JavaScript `number` 转换

### 常见错误

| 错误码 | 含义 |
|---|---|
| `YFY_VERSION_NOT_FOUND` | VersionRef 失效或不属于当前文件 |
| `YFY_VERSION_METADATA_INCOMPLETE` | 缺少校验下载所需元数据 |
| `YFY_HISTORICAL_DOWNLOAD_UNAVAILABLE` | Provider 无法返回该历史原件 |
| `YFY_DOWNLOAD_DRIFT` | 下载期间版本或 Workspace 状态变化 |
| `YFY_EXPECTATION_MISMATCH` | 调用方断言不匹配；文件不会保留 |
| `YFY_LOCAL_STORAGE_INSUFFICIENT` | 共享临时配额不足 |
| `YFY_DOWNLOAD_CLEANUP_FAILED` | 删除失败（占用/权限等） |
| `YFY_PROVIDER_TIMEOUT` | ticket + stream 耗尽总 wall timeout |

---

## yfy_download_release

```json
{"download_id":"dl_..."}
```

返回 `released` 或 `already_unavailable`。

MCP annotations：

- `readOnlyHint=false`
- `destructiveHint=true`
- `idempotentHint=true`
- `openWorldHint=false`（不访问外部世界，仅本地清理）

若 HTTP 正在读取：release 会立即禁止新请求，并在活动流结束后删除文件。

---

## Workspace

### yfy_workspace_validate

校验 Workspace 配置、根目录与访问身份。
单项检查为 `pass` / `fail` / `unavailable`；顶层为 `valid` / `invalid` / `unavailable`。

### yfy_membership_check

返回 `inside` / `outside` / `unavailable`，并带：

```json
{
  "agent_interpretation": {
    "may_claim_inside": false,
    "may_claim_outside": false,
    "may_download": false,
    "narrative": "...",
    "next_steps": ["..."]
  }
}
```

`unavailable` **不能**当成 outside。应从 Workspace 根重新 browse / resolve，拿到 path-backed Ref 后再检查。

---

## Inventory（目录清单）

对 Workspace（或可选子树）做递归只读扫描，结果写入本地 SQLite。用于“是否齐全 / 是否缺失”类问题；**不能**用 Provider 搜索代替。

### 创建（须显式 limits）

```json
{
  "workspace": "workspace:tender_public",
  "root_folder": "folder:...",
  "refresh": {"mode": "reuse_if_fresh", "max_age_seconds": 300},
  "limits": {"max_item_depth": 8, "max_items": 10000}
}
```

| 字段 | 说明 |
|---|---|
| `workspace` | 必填；完整 `workspace:<id>` |
| `root_folder` | 可选；已在 Workspace 内验证过的子树根 |
| `refresh` | `reuse_if_fresh`（可复用新鲜清单）或 `force_refresh` |
| `limits` | 深度与条目上限；创建时必须给出 |

### 使用要点

1. 跟随 `next_action`，直到 `terminal=true`。
2. 运行中可按 `suggested_wait_ms` 轮询 `yfy_inventory_get`。
3. 复制返回的完整 Inventory Ref（`inventory:<uuid>@...`）。
4. 搜索使用 `yfy_inventory_search`；首查锁定当前 **commit_watermark**（已提交扫描进度），续页 cursor 沿用该值，保证同一查询结果一致、不读到尚未提交的观测。
5. **仅当**终态且 `safe_to_claim_absence=true` / `agent_guidance.may_claim_absence=true` 时，才可在扫描范围内声明缺失。
6. 部分完成或空结果且 `absence_forbidden` 时，**禁止**声称“不存在”。

相关工具：`yfy_inventory_create` / `get` / `search` / `cancel` / `release`。
`yfy_inventory_release` 会删除本地清单并使其 ref、cursor、manifest、receipt 一并失效。

---

## Transfer

`yfy_transfer_ticket_get` **仅**用于特殊集成：

- `usage_policy=special_integration_only`
- `not_for_verified_download=true`
- `do_not_echo_url=true`（勿日志、勿回显 URL）
- 仅当前版；无内容完整性保证

普通读取请始终使用 `yfy_download`。

---

## 写工具

`collaboration`、`mutation`、`admin` 均需在 `YFY_TOOLSETS` 中**显式启用**。

永久删除、协作移除、平台同步、管理员登录材料、transfer ticket：仅在用户明确要求时调用。
