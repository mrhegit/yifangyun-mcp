# 从 0.4.0 迁移到 1.0.0-beta.7

本文是唯一迁移路径，适用于从正式版本 `0.4.0` 直接升级到当前版本 `1.0.0-beta.7`。无需先安装任何中间 beta。

beta.7 将 Agent-facing Interface 重构为轻量 Drive 平面和可选的 Workspace、Inventory、Evidence、Organization 平面，并统一 context-bound Ref、互斥分页、三态证明、内容 Resource、结果预算和固定观察水位 Inventory。

这是破坏性迁移：不提供 0.4.0 工具别名、旧参数解析、旧配置键映射、旧 cursor/Ref 转换或旧 SQLite schema 原地迁移。MCP 客户端定义、Prompt、评测、配置和状态库必须作为一个版本单元同步切换。

## 工具迁移

| 0.4.0 | 1.0.0-beta.7 |
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
| 四个 `yfy_snapshot_*` | `yfy_inventory_create/get/search/cancel`，并新增 `release` |
| `yfy_evidence_capture` | `yfy_capture` |
| `yfy_evidence_release` | `yfy_resource_release` |
| `yfy_department_read`、`yfy_group_read` | 明确的 department/user/group 工具 |

`yfy_open` 是新的普通内容读取入口，不要求 Workspace。`yfy_capture` 仅用于需要 Workspace membership 和下载前后稳定性证明的原件固化。

## Toolset 与配置迁移

Toolset 重命名：

```text
core       -> drive
authority  -> workspace
snapshot   -> inventory
```

环境变量重命名：

```text
YFY_SCOPES_JSON              -> YFY_WORKSPACES_JSON
YFY_SNAPSHOT_CONCURRENCY     -> YFY_INVENTORY_CONCURRENCY
YFY_SNAPSHOT_TTL_SECONDS     -> YFY_INVENTORY_TTL_SECONDS
```

0.4.0：

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_SNAPSHOT_CONCURRENCY=2
YFY_SNAPSHOT_TTL_SECONDS=604800
```

beta.7：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence,organization
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_INVENTORY_CONCURRENCY=2
YFY_INVENTORY_TTL_SECONDS=604800
```

beta.7 默认 `YFY_TOOLSETS=drive`。Tender Profile 要求 `drive,workspace,inventory,evidence` 和至少一个 Workspace。不要同时保留新旧键；旧键不会作为 fallback 使用。

服务只读取进程环境，不自动加载 `.env`。本地运行应显式使用 `node --env-file=.env dist/index.js`，MCP Host、容器或进程管理器应自行注入环境变量。

## Ref 迁移

0.4.0 的数字 ID 参数和任何中间 beta 的数字 Ref 都不能直接复用。beta.7 Ref 示例：

```text
workspace:tender_public
file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa
folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa
version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh
inventory:<signed-payload>
```

迁移规则：

- root/scope 对象改为 PlaceRef：`personal`、`collaboration`、`department:<id>`、context-bound FolderRef 或 `workspace:<id>`。
- `item_type + item_id` 改为服务返回的 context-bound FileRef/FolderRef。
- 历史版本必须先调用 `yfy_versions`，复制绑定完整 FileRef 的 VersionRef；当前版本省略 `version`。
- Workspace 工具参数必须传 `workspace:<id>`，不能传裸 ID。
- 不要根据格式自行拼接 Ref。应从 `yfy_status`、Browse、Search、Resolve、Get、Versions 或 Inventory 结果复制。
- 修改 `YFY_CLIENT_SECRET`、Access Context 身份或 Workspace 绑定后，重新发现所有 Ref。

ItemRef 绑定 `access_context` 和 identity fingerprint。来源和目标 Ref 属于不同身份时，move/copy/capture 等操作会被拒绝，而不是只按数字 ID 请求 Provider。

## 分页迁移

0.4.0 的 `page_id`、`page_capacity` 和 `result_offset` 不再暴露。所有分页工具使用严格的 request 判别联合。

首次浏览：

```json
{
  "tool": "yfy_browse",
  "arguments": {
    "request": {
      "mode": "first_request",
      "at": "workspace:tender_public",
      "kind": "all",
      "detail": "basic",
      "limit": 50
    }
  }
}
```

续页：

```json
{
  "tool": "yfy_browse",
  "arguments": {
    "request": {
      "mode": "continuation",
      "cursor": "..."
    }
  }
}
```

实际调用应原样执行结果中的 `next_action`。continuation 只允许 cursor，混入首次请求字段会返回 `YFY_INPUT_INVALID`。不要解析 cursor，也不要将其与 Provider 页码混用。

普通 invalid/stale cursor 应使用 `request.mode=first_request` 重启对应工具。cursor 同时绑定 beta.7 contract version 2 和有效配置指纹；Access Context、Workspace 绑定或其他契约配置变化后，旧 cursor 不能续用。

## Search 与 Resolve 迁移

- `yfy_search` 固定是非穷尽 Provider index，空结果不能证明不存在。
- 每个 hit 新增 `match.fields/basis/verifiable`、scope evidence 和 Provider signals，调用方应区分本地可验证匹配与 `provider_index_only`。
- `exact_name` 只允许与 `field=name` 组合，并按大小写敏感名称相等验证。
- `yfy_resolve` 遇到同名候选返回 `status=ambiguous`，调用方必须选择候选或从更窄 FolderRef 重试。
- Item 的 `path_chain` 改为 `provider_path_chain` 和 `path_basis=provider_supplied`；Workspace 结果另返回 `relative_ancestor_chain`。

## Workspace 证明迁移

Workspace validation 不再用布尔值压平不确定性：

- 单项 checks 为 `pass`、`fail` 或 `unavailable`。
- 顶层 verdict 为 `valid`、`invalid` 或 `unavailable`。
- Provider 元数据缺失或末页无法证明时返回 unavailable，不会伪造 pass/fail。

Membership 结果为 `inside`、`outside` 或 `unavailable`。路径命中 Workspace root 时是 inside；明确跨存储空间时是 outside；路径可能被截断或证据不足时是 unavailable。`mode=assert` 会把 outside 和 unavailable 映射为不同错误。

Admin 的 department users、group list/users 和 log list/list_paginated 也已迁移到统一 request cursor，不再接受公开 `page_id/page_capacity`。Collaboration 的 folder action 只由 context-bound FolderRef 选择身份；collaboration ID action 禁止附带无关 folder。

## Inventory 迁移

创建参数从隐式 snapshot policy 改为显式 Workspace、refresh 和 limits：

```json
{
  "workspace": "workspace:tender_public",
  "refresh": {
    "mode": "reuse_if_fresh",
    "max_age_seconds": 300
  },
  "limits": {
    "max_item_depth": 8,
    "max_items": 10000
  }
}
```

关键变化：

- `limits.max_item_depth` 和 `limits.max_items` 必填，不再隐藏默认扫描边界。
- `refresh.mode` 为 `reuse_if_fresh` 或 `force_refresh`。
- 状态为 `running/retry_wait/complete/partial/cancelled/failed`，不再使用旧 snapshot 状态。
- retry count、next retry、last error、remaining frontier 和物理存储统计进入 `yfy_inventory_get`。
- manifest 不再内联 receipt；使用分页 receipt Resource。
- 新增 `yfy_inventory_release`，用于立即删除一个本地 Inventory。
- 搜索/list 使用统一 request 分页，并固定 first request 时的 `commit_watermark`。
- `safe_to_claim_absence` 只有在终态、分页完整、limits 未截断且观察范围可信时才为 true。

Inventory search 示例：

```json
{
  "inventory": "inventory:<signed-payload>",
  "request": {
    "mode": "first_request",
    "query": "招标文件",
    "kind": "file",
    "match_fields": ["name", "path"],
    "case_sensitive": false,
    "limit": 25
  }
}
```

后台扫描继续提交时，已有 cursor 仍读取固定 watermark。需要观察新增项目时，重新发起 first request。

## 内容与 Resource 迁移

0.4.0 固化调用：

```json
{"tool":"yfy_evidence_capture","arguments":{"scope_id":"tender_public","file_id":"501","version":{"kind":"current"}}}
```

beta.7：

```json
{
  "tool": "yfy_capture",
  "arguments": {
    "workspace": "workspace:tender_public",
    "file": "file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

- 当前版省略 version；历史版复制 `yfy_versions` 返回的 VersionRef。
- `expected` 不匹配返回 `YFY_EXPECTATION_MISMATCH`，不会成功返回 false。
- Capture 在下载前后验证 membership、版本历史和文件元数据；drift 时删除候选内容。
- `yfy_open` 提供非 Workspace-bound 的普通内容读取。
- 小文件通过 MCP Resource 返回 text/blob；大文件通过 multipart manifest 和 part URI 读取。
- 结果不返回服务器本地路径。
- 使用结束后调用 `yfy_resource_release`；释放幂等。
- 工具输出校验或序列化失败时，已注册 Resource 会回滚。

## SQLite 状态迁移

beta.7 Inventory SQLite schema 为 4。0.4.0 和中间 beta 状态库均不兼容，服务会返回 `YFY_STATE_SCHEMA_MISMATCH`，不会自动修改旧数据。

升级时：

1. 停止旧服务，确认没有进程持有旧 SQLite。
2. 为 beta.7 配置新的空 `YFY_STATE_DB` 路径。
3. 保留旧数据库、`-wal`、`-shm` 和进程锁文件作为只读回滚参考。
4. 完成 beta.7 功能验证并确认不再回滚后，再删除旧状态文件。

beta.7 schema 不再保存 `snapshot_seen_items` 和重复 page artifact JSON。item digest、commit sequence、搜索文本和排序键直接位于 `snapshot_items`；receipt 仍保留用于审计。

0.4.0 snapshot ID、cursor、manifest URI、Resource URI 不能转换为 beta.7 InventoryRef 或 Resource。

## 升级步骤

1. 停止 0.4.0 服务，备份旧环境配置和状态目录。
2. 安装 `yifangyun-mcp-server@1.0.0-beta.7`，要求 Node.js `>=24`。
3. 从当前 `.env.example` 重建配置，改用新 Toolset、Access Context 和 Workspace 环境变量。
4. 指定新的空 `YFY_STATE_DB`；不要让新旧服务共享数据库。
5. 原子更新 MCP 工具目录、request 包装、Ref 保存、响应解析、Prompt 和评测。
6. 调用 `yfy_status`，记录 `server.contract_version=2`、build/config fingerprint、capabilities 和 PlaceRef。
7. 调用 `yfy_workspace_validate`，分别处理 valid、invalid 和 unavailable。
8. 使用小 limits 创建 Inventory，跟随 next_action 到 terminal，检查 diagnostics、manifest/receipts 和 completeness。
9. 创建可完成的 Inventory，仅在 `safe_to_claim_absence=true` 时验证缺失结论；完成后测试 `yfy_inventory_release`。
10. 使用受控当前/历史文件验证 `yfy_open`、`yfy_capture`、expectation mismatch、multipart 和 Resource release。
11. 完成只读验证后，再按最小权限启用 mutation、collaboration、admin 或 transfer。
12. 确认不回滚后清理 0.4.0 旧数据库和临时 Resource 残留。

## 回滚

回滚必须整体切回 0.4.0 服务、配置、客户端工具定义和旧状态目录。0.4.0 与 beta.7 不能共享 SQLite、cursor、Ref、Resource URI 或 Agent 调用契约。不要尝试让同一 Prompt 同时兼容两套接口。
