# 工具参考

`1.0.0-beta.5` 使用“双平面” Interface：普通 Drive 操作保持轻量；Workspace、Inventory 和 Capture 提供范围与证据语义。

## 通用契约

成功结果直接返回领域字段。失败返回 `isError=true` 和结构化错误：

```json
{"error":{"code":"YFY_PERMISSION_DENIED","category":"authorization","message":"Permission denied.","retryable":false,"phase":"provider_request"}}
```

provenance 不返回 endpoint、下载 URL pathname 或 access context：

```json
{"source":"yifangyun_openapi","operation":"provider_request","observed_at":"2026-07-16T00:00:00.000Z","request_id":"optional"}
```

分页统一为：

```json
{"page":{"returned_count":25,"has_more":true,"next_cursor":"..."},"next_action":{"tool":"yfy_browse","arguments":{"cursor":"..."}}}
```

续页时执行返回的 `next_action`，不要解析 cursor，也不要继续传 Provider 页码。

## Drive

| 工具 | 主要输入 | 主要输出 |
|---|---|---|
| `yfy_status` | 无 | identity、places、capabilities、profiles |
| `yfy_browse` | `at/kind/detail/limit` 或 `cursor` | `items/page/next_action` |
| `yfy_search` | `query/in/kind/field/exact_name/limit` 或 `cursor` | `hits/coverage/page` |
| `yfy_resolve` | `path/from` | 精确匹配、matched segments 或 missing segment |
| `yfy_get` | `ref/detail` | 当前元数据 |
| `yfy_get_many` | `refs/detail` | 保持输入顺序的 success/error 结果 |
| `yfy_versions` | `file/limit` 或 `cursor` | 当前版本标记和绑定文件的历史 VersionRef |
| `yfy_open` | `file/version?` | verified content、assurance、Resource |
| `yfy_comments` | `file/limit` 或 `cursor` | comments/page |
| `yfy_shares` | `item/limit` 或 `cursor` | 脱敏 share metadata/page |

`yfy_search.coverage` 固定说明 Provider index 非穷尽。空结果不能证明文件不存在。

历史内容先调用 `yfy_versions`，复制 `version:<file_id>:<provider_version_id>` 到 `yfy_open` 或 `yfy_capture`。当前版省略 `version`。

## Workspace

| 工具 | 说明 |
|---|---|
| `yfy_workspace_validate` | 验证配置目录、业务路径、部门链和首尾页可达性 |
| `yfy_membership_check` | query 返回成员关系；assert 在越界时返回结构化授权错误 |

越界 diagnostics 包含 file ref/ID、workspace、root folder、观察到的 ancestor IDs 和 reason。

## Inventory

| 工具 | 说明 |
|---|---|
| `yfy_inventory_create` | 创建、加入或按 freshness 复用递归 Inventory |
| `yfy_inventory_get` | 读取状态、观察窗口、新鲜度和完整性 |
| `yfy_inventory_search` | 搜索 Inventory；省略 query 时列出，续页仅传 inventory/cursor |
| `yfy_inventory_cancel` | 取消活动任务；终态为 revision-preserving no-op |

创建参数：

```json
{"workspace":"tender_public","freshness":{"max_age_seconds":300,"mode":"reuse_if_fresh"},"max_item_depth":20,"max_items":50000}
```

复用规则：

- `fresh_complete`：完整 Inventory 满足调用方 `max_age_seconds`。
- `running_join`：等价任务仍在运行或可重试。
- `new`：强制刷新、无等价任务、旧任务过期，或旧任务是 partial/cancelled/failed/expired。

Inventory cursor 绑定 inventory、query、kind、limit、revision 和 Adapter 版本。后台状态变化导致 cursor stale 时，无 cursor 重新开始。

## Capture 与 Resource

`yfy_capture` 输入：

```json
{"workspace":"tender_public","file":"file:501","version":"version:501:7001","expected":{"sha256":"...","size_bytes":123}}
```

成功输出包含：

- `file` 稳定引用；历史 `version` 带稳定 VersionRef，当前版以 `current=true` 表示
- `selection` 下载策略证明
- `workspace` 成员关系证明
- `assurance.checks`：`pass`、`not_applicable` 或 `unavailable`
- `expectation.verdict`：`matched` 或 `not_provided`
- `resource`：SHA-1、SHA-256、size、media type 和交付方式

expected 任一不匹配时返回 `YFY_EXPECTATION_MISMATCH`，并在 diagnostics 中给出 expected、actual 和 mismatches；临时文件不会注册为 Resource。

Resource 交付：

- `mcp_resource`：单个 `yfy://evidence/<token>`；合法 UTF-8 文本返回 `text`，其他返回 `blob`。
- `multipart_resource`：`yfy://evidence/<token>/manifest`；manifest 列出有界 `part` URI，每个 part 读取时复核整文件 SHA-256。
- 不返回 `local_path`。

处理完成后调用 `yfy_resource_release({resource_uri})`。它是 Drive/Evidence 共享工具；释放操作幂等，manifest URI 和基础 URI 都可用于释放。

## Organization

- `yfy_department_get`
- `yfy_department_children`
- `yfy_department_users`
- `yfy_user_search`
- `yfy_group_list`
- `yfy_group_users`

每个关系都有明确工具；不使用 action union，也不向不支持的 Provider endpoint 发送无效 `page_capacity`。

## 可选写入与管理

- Mutation：`yfy_folder_create`、`yfy_item_mutate`、`yfy_file_upload`、`yfy_file_version_upload`
- Collaboration：`yfy_collaboration_read`、`yfy_collaboration_mutate`
- Admin：`yfy_admin_department_*`、`yfy_admin_group_*`、`yfy_admin_user_*`、日志和平台工具
- Transfer：`yfy_transfer_ticket_get`，仅用于明确需要短时 Provider URL 的场景；普通读取使用 `yfy_open`
