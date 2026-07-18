# 迁移到 1.0.0-beta.9

本文提供两条完整路径：从正式版 `0.4.0` 直接升级到 `1.0.0-beta.9`，以及从 `1.0.0-beta.8` 升级到 beta.9。当前服务版本为 `1.0.0-beta.9`，`contract_version=4`，Node.js 要求 `>=24`。

这是 Agent-facing Interface 的破坏性升级。工具目录、调用参数、Cursor、Inventory 引用、Prompt、评测和客户端响应解析应作为一个版本单元切换。

## 从 0.4.0 直接升级

无需安装任何中间 beta。0.4.0 的旧工具名、数字 ID 参数、分页参数和 SQLite 状态不能在 beta.9 中继续使用。

### 工具映射

| 0.4.0 | beta.9 |
|---|---|
| `yfy_connection_check`、`yfy_context_get` | `yfy_status` |
| `yfy_root_list`、`yfy_folder_list` | `yfy_browse` |
| `yfy_item_search` | `yfy_search` |
| `yfy_path_resolve` | `yfy_resolve` |
| `yfy_item_get` | `yfy_get` |
| `yfy_items_get` | `yfy_get_many` |
| `yfy_file_versions` | `yfy_versions` |
| `yfy_file_comments` | `yfy_comments` |
| `yfy_share_list` | `yfy_shares` |
| `yfy_authority_validate` | `yfy_workspace_validate` |
| `yfy_scope_check` | `yfy_membership_check` |
| `yfy_snapshot_*` | `yfy_inventory_create/get/search/cancel/release` |
| `yfy_evidence_capture` | `yfy_capture` |
| `yfy_evidence_release` | `yfy_resource_release` |
| `yfy_department_read`、`yfy_group_read` | 明确的 department/user/group 工具 |

`yfy_open` 是普通内容读取入口，不要求 Workspace。`yfy_capture` 只用于需要 Workspace membership 和下载前后稳定性证明的原件固化。

### Toolset 和环境变量

```text
core       -> drive
authority  -> workspace
snapshot   -> inventory
```

```text
YFY_SCOPES_JSON          -> YFY_WORKSPACES_JSON
YFY_SNAPSHOT_CONCURRENCY -> YFY_INVENTORY_CONCURRENCY
YFY_SNAPSHOT_TTL_SECONDS -> YFY_INVENTORY_TTL_SECONDS
```

0.4.0 示例：

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
```

beta.9 Tender Profile：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_INVENTORY_CONCURRENCY=2
YFY_INVENTORY_TTL_SECONDS=604800
```

默认只启用 `drive`。Tender Profile 要求 `drive,workspace,inventory,evidence` 和至少一个 Workspace。Transfer 仅在明确需要短时 Provider URL 时启用，不能替代 open/capture。

服务只读取进程环境，不自动加载 `.env`。本地启动可使用：

```bash
node --env-file=.env dist/index.js
```

### Ref 迁移

数字文件 ID、目录 ID 和旧 beta 数字 Ref 不能复用。beta.9 使用 context-bound Ref：

```text
workspace:tender_public
file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa
folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa
version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh
inventory:<instance-handle-uuid>
inventory:<signed-payload>
```

- 从 `yfy_status`、Browse、Search、Resolve、Get、Versions 或 Inventory 结果复制 Ref，不要自行拼接。
- 当前文件版本调用 open/capture 时省略 `version`；历史版本必须复制 `yfy_versions` 返回的 VersionRef。
- Workspace 参数必须传 `workspace:<id>`，不能传裸 ID。
- ItemRef 绑定 Access Context 和身份指纹。身份或 Workspace 配置变化后，应重新发现 Ref。

### 分页迁移

Provider 的 `page_id`、`page_capacity` 和结果 offset 不再公开。首次调用直接传业务字段：

```json
{
  "at": "workspace:tender_public",
  "kind": "all",
  "detail": "basic",
  "limit": 50
}
```

续页只执行工具返回的 `next_action`：

```json
{
  "cursor": "..."
}
```

带固定字段的工具会返回例如：

```json
{
  "inventory": "inventory:<uuid>",
  "cursor": "..."
}
```

不要解析 Cursor，也不要把 Cursor 与首次查询条件混用。Cursor 绑定 contract/config fingerprint；契约或有效配置变化后必须省略 Cursor，用首次业务字段重新开始。

服务在 `tools/list.inputSchema` 中使用 object + `anyOf` 发布与运行时相同的首次/续页约束。升级后应刷新 Host 的工具目录缓存。

### Search 和 Resolve

- Search 是非穷尽 Provider index，空结果不能证明不存在。
- `match.claim_allowed=true` 只证明返回元数据支持查询匹配；依赖当前存在性前仍调用 `yfy_get`。
- Content 命中永远不可 claim。`field=content` 默认返回 unverified 候选；显式传 `include_unverified_index_hits=false` 可隐藏。
- 过滤统计区分默认隐藏和调用方显式隐藏 unverified 候选。
- `selection_policy` 为：
  - `must_disambiguate`：当前或后续页可能有竞争候选，不能直接选择 hits[0]。
  - `single_candidate_ok`：已观察分页中只有一个可见候选，仍须 `yfy_get` 确认当前存在。
  - `continue_search`：当前页没有可见候选，但必须继续 `next_action`。
  - `no_candidates`：Provider 分页已结束且未观察到候选；仍不能证明缺席。
- `yfy_resolve` 返回 ambiguous 时必须从候选中消歧或缩小起始 FolderRef。

### Workspace 证明

Workspace validation 使用 `valid/invalid/unavailable`；Membership 使用 `inside/outside/unavailable`。`unavailable` 既不是 outside，也不允许 capture。

只有在路径证据与 storage space 证据一致时才声称 inside/outside；冲突时返回 `unavailable/conflicting_membership_evidence`。

### Inventory

创建 Inventory 必须显式提供 Workspace、refresh 和 limits：

```json
{
  "workspace": "workspace:tender_public",
  "root_folder": "folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa",
  "refresh": { "mode": "reuse_if_fresh", "max_age_seconds": 300 },
  "limits": { "max_item_depth": 8, "max_items": 10000 }
}
```

- `inventory` 是加密认证的 opaque 持久引用，可在服务重启后继续访问相同 SQLite 中的 Inventory。
- `inventory_id` 仅用于显示和日志，不能作为工具输入。
- Ref 不暴露 Access Context、scan UUID 或 Workspace fingerprint；修改 `YFY_CLIENT_SECRET` 后旧 Ref 失效。
- `safe_to_claim_absence` / `agent_guidance.may_claim_absence` 只有在终态、分页完整、limits 未截断且观察范围可信时才为 true。
- Partial 空搜返回 `not_found_in_observed_prefix_only; absence_forbidden`，不能报告材料缺失。
- `yfy_inventory_release` 幂等；重复释放返回 `already_unavailable`。

### 内容和 Resource

- Open/Capture 完整对象位于 `structuredContent`。
- text content 为兼容通道；大结果只保留有界 preview 和完整操作 control，不复制 `resource.preview_text`。
- 小型 UTF-8 内容可作为标准 embedded resource 返回；Resource Link 不保证被 Host 自动读取。
- `content_delivery.agent_readable/model_has_body_text` 表示当前工具结果是否已经给模型正文。
- PDF、DOCX、XLSX、PPTX 等 binary 模式为 `agent_readable=false`，工具成功不代表模型已读正文。
- 每次成功 open/capture 都返回 `next_action=yfy_resource_release`；使用后执行，释放操作幂等。
- Transfer URL 仅存在于 `structuredContent`，text 通道脱敏；不得记录或回显。

### SQLite 状态

beta.9 使用 SQLite schema 5。0.4.0 和更早 beta 状态库不兼容，不会自动迁移或覆盖。

1. 停止旧服务，确认没有进程持有旧 SQLite。
2. 把 `YFY_STATE_DB` 指向新的空文件。
3. 保留旧数据库及 `-wal`、`-shm`、进程锁作为回滚参考。
4. 完成验证并确认不回滚后再清理旧状态。

## 从 beta.8 升级

beta.8 到 beta.9 的 SQLite schema 仍为 5，可复用状态数据库，但工具契约从 3 升为 4：

| beta.8 | beta.9 |
|---|---|
| `{request:{mode:"first_request",...}}` | 首次业务字段直接位于工具参数顶层；tools/list 以 `anyOf` 精确发布 |
| `{request:{mode:"continuation",cursor}}` | `{cursor}`，以及工具要求的固定字段 |
| 签名可读 payload `inventory` | 单一加密 opaque `inventory` Ref；不再返回 `inventory_secure_ref` |
| compact preview 可能截断/复制 Resource 正文 | control 操作锚点完整，正文不进入 compact text |
| Search 三态选择提示 | 改为四态并增加 `continue_search`，跨页候选保守消歧 |
| content include flag 默认 false | content 默认 true，但显式 false 被尊重 |

beta.8 Cursor 不能在 contract 4 中续用。升级后重新发起首次调用，并更新所有保存的 Prompt、工具参数模板和评测。

## 验证清单

1. 调用 `yfy_status`，确认 `server.version=1.0.0-beta.9`、`contract_version=4` 和 capabilities。
2. 检查 Host 的 tools/list：分页工具必须显示首次字段和 `cursor`，不能是空 properties。
3. 验证 Browse/Search 首次调用和原样执行 `next_action`。
4. 验证 content 搜索、同名消歧、`continue_search` 和过滤计数。
5. 创建非默认 Access Context 的 Inventory，验证 opaque Ref 的 get/search/cancel/release。
6. 使用相同 `YFY_CLIENT_SECRET` 重启服务，确认同一 `inventory` Ref 可继续访问；更换 secret 后确认旧 Ref 被拒绝。
7. 验证 complete 和 partial 空搜语义；只在 `may_claim_absence=true` 时报告缺席。
8. 验证文本、PDF/Office、multipart 的 open/capture、agent_readable 和重复 release。
9. 确认 Transfer URL 不出现在 text content 和日志中。

## 回滚

回滚必须整体切换服务版本、工具目录、Prompt、Cursor/Ref 保存和对应状态目录。不要让 0.4.0 与 beta.9 共享 SQLite，也不要让同一 Prompt 同时兼容 contract 3 和 contract 4。
