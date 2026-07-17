# 从 0.4.0 迁移到 1.0.0-beta.5

本文适用于从正式版本 `0.4.0` 升级到 `1.0.0-beta.5`。beta.5 将 Agent-facing Interface 改为轻量 Drive 平面，加可选的 Workspace、Inventory、Evidence 和 Organization 平面。

这是破坏性迁移：不提供 `0.4.0` 工具别名、旧参数解析、旧配置键映射或旧 SQLite schema 原地迁移。MCP 客户端定义、Prompt、评测、环境变量和状态库必须作为一个版本单元同步切换。

## 工具迁移

| 0.4.0 | 1.0.0-beta.5 |
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
| 四个 `yfy_snapshot_*` | 四个 `yfy_inventory_*` |
| `yfy_evidence_capture` | `yfy_capture` |
| `yfy_evidence_release` | `yfy_resource_release` |
| `yfy_department_read`、`yfy_group_read` | 明确的 department/group 工具 |

## 参数迁移

- root 对象改为 PlaceRef：`personal`、`collaboration`、`department:<id>`、`folder:<id>`、`workspace:<id>`。
- `item_type + item_id` 改为 `file:<id>` 或 `folder:<id>`。
- 历史版本改为 `version:<file_id>:<provider_version_id>`；当前版省略 version。
- 普通分页删除 `page_id/page_capacity/result_offset`，只保留 `limit/cursor/next_action`。
- `scope_id` 改为 `workspace`。
- `expected` 不匹配不再成功返回 false，而是 `YFY_EXPECTATION_MISMATCH`。
- provenance 不再包含 endpoint、下载 pathname、status code 或 access context。

## 配置迁移

```text
core       -> drive
authority  -> workspace
snapshot   -> inventory
```

环境变量：

```text
YFY_SCOPES_JSON              -> YFY_WORKSPACES_JSON
YFY_SNAPSHOT_CONCURRENCY     -> YFY_INVENTORY_CONCURRENCY
YFY_SNAPSHOT_TTL_SECONDS     -> YFY_INVENTORY_TTL_SECONDS
```

beta.5 默认 `YFY_TOOLSETS=drive`。Tender Profile 要求 `drive,workspace,inventory,evidence` 和至少一个 Workspace。

`0.4.0` 配置示例：

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_SNAPSHOT_CONCURRENCY=2
YFY_SNAPSHOT_TTL_SECONDS=604800
```

对应的 beta.5 配置：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence,organization
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_INVENTORY_CONCURRENCY=2
YFY_INVENTORY_TTL_SECONDS=604800
```

不要同时保留新旧键。beta.5 只读取新键，旧键不会作为兼容 fallback 使用。

## 调用迁移示例

`0.4.0` 浏览命名范围：

```json
{"tool":"yfy_root_list","arguments":{"root":{"kind":"scope","scope_id":"tender_public"},"page_capacity":50}}
```

beta.5 浏览同一 Workspace：

```json
{"tool":"yfy_browse","arguments":{"at":"workspace:tender_public","limit":50}}
```

`0.4.0` 固化文件内容：

```json
{"tool":"yfy_evidence_capture","arguments":{"scope_id":"tender_public","file_id":"501","version":{"kind":"current"}}}
```

beta.5 固化当前内容：

```json
{"tool":"yfy_capture","arguments":{"workspace":"tender_public","file":"file:501"}}
```

beta.5 返回 `next_action` 时应原样执行，不要把 cursor 与 `0.4.0` 的 Provider 页码参数混用。

## 状态与 Resource

- SQLite schema 从 2 升到 3。`0.4.0` 状态库会被拒绝；升级时配置新的空 `YFY_STATE_DB`。
- `0.4.0` snapshot ID、cursor 和 manifest URI 失效，不能转换为 beta.5 Inventory ref。
- stdio 不再返回服务器本地路径。
- 大文件通过 multipart manifest/parts 读取，不再返回 omitted。
- 文本 Resource 使用 MCP `text`；二进制和 parts 使用 `blob`。

## 升级步骤

1. 停止 `0.4.0`，保留旧配置和状态目录作为只读回滚参考。
2. 从 `.env.example` 重建配置，改用新 Toolset 和 Workspace 环境变量。
3. 为 `YFY_STATE_DB` 指定新的空路径。
4. 原子更新 MCP 工具目录、调用参数、响应解析、Prompt 和评测。
5. 调用 `yfy_status`、`yfy_workspace_validate` 验证身份和目录。
6. 创建小型 Inventory，确认 freshness、终态 cancel no-op 和 `safe_to_claim_absence`。
7. 使用受控当前/历史文件验证 `yfy_open`、`yfy_capture`、expectation mismatch 和 Resource release。
8. 完成只读验证后再开启 mutation、collaboration、admin 或 transfer。

回滚必须整体切回 `0.4.0` 服务、配置和客户端定义。`0.4.0` 与 beta.5 不能共享状态数据库、cursor、Resource URI 或 Agent 调用契约。
