# 工具参考

工具是否注册由 `YFY_TOOLSETS` 决定；Authority、Snapshot 和 Current Lock 还依赖 `YFY_SCOPES_JSON`。配置组合、权限边界和完整示例见 [配置指南](configuration.md)。

## 返回契约

成功时，`structuredContent` 直接是工具领域结果：

```json
{
  "item": {"id":"10","name":"证书.pdf","type":"file"},
  "provenance": {
    "source":"yifangyun_openapi",
    "observed_at":"2026-07-16T00:00:00.000Z",
    "access_context":"default"
  }
}
```

失败时返回 `isError=true`：

```json
{
  "error": {
    "code":"YFY_PERMISSION_DENIED",
    "category":"authorization",
    "message":"Permission denied.",
    "retryable":false,
    "phase":"provider_request",
    "suggested_action":"..."
  }
}
```

全部工具都声明具体 `outputSchema`，MCP 客户端可以验证 `structuredContent` 的稳定顶层字段和类型。`yfy_context_get.server` 返回运行版本、实例 ID、启动时间和配置指纹；任何工具都不返回 Provider raw response。

## 分页

直接暴露分页的领域工具统一接收 0-based `page_id` 和 `page_capacity`，并返回统一 `page` 对象：

```json
{
  "page": {
    "requested": {"page_id":0,"page_capacity":5},
    "effective": {"page_id":0,"page_capacity":100,"page_capacity_source":"provider"},
    "returned": {"provider_count":30,"item_count":7,"filtered_count":23,"invalid_count":0},
    "page_count": 3,
    "total_count": 124,
    "has_more": true,
    "next_page_id": 1,
    "continuation_basis":"page_count",
    "metadata_consistent":true
  }
}
```

`page_count`、`total_count` 和 `next_page_id` 在 Provider 无法提供时可以省略。Agent 应优先使用 `has_more` 和 `next_page_id`；`requested`、`effective`、`returned` 用于区分请求容量、Provider 实际容量和过滤后的返回数量。Snapshot 查询使用签名 cursor，不使用 page number。

`page.effective.page_capacity` 表示 Provider 实际采用的容量，不保证等于 `page.requested.page_capacity`。当前部署的搜索和分享接口可能忽略请求容量并返回自己的默认值；调用方不应把请求容量当作客户端结果上限，也不应自行截断后再声称分页完整。

## Core

| 工具 | 说明 |
|---|---|
| `yfy_connection_check` | 实际验证企业和 user token |
| `yfy_context_get` | 查看运行时可用的 context、scope 和 toolset |
| `yfy_item_get` | 文件、文件版本、文件夹元数据；`view=summary/evidence/full` |
| `yfy_items_get` | 最多 100 个文件的批量元数据 |
| `yfy_folder_list` | 一页直接子项，不递归 |
| `yfy_root_list` | 使用显式 root 对象枚举个人、协作、部门、文件夹或 scope 根 |
| `yfy_item_search` | 官方索引候选发现，永远是 hint-only |
| `yfy_path_resolve` | 分页逐层解析精确路径 |
| `yfy_file_versions` | 文件版本列表 |
| `yfy_file_comments` | 评论列表 |
| `yfy_share_list` | 分享元数据，URL 和密码始终脱敏 |

`yfy_item_search` 接受统一 `root`，只返回紧凑 `candidates`。文件夹或 scope 搜索会根据 `parent_folder_id` 和祖先链二次过滤；`precise=true` 且 `field=file_name` 时执行精确名称匹配。`page.total_count` 始终是 Provider 过滤前候选总数，实际过滤数见 `page.returned.filtered_count`。

`yfy_items_get` 返回输入顺序稳定的 `results[]`。单个文件失败不会丢失其他成功项，汇总位于 `summary`。

## Authority

| 工具 | 说明 |
|---|---|
| `yfy_authority_validate` | 验证命名 scope、业务路径和分页可达性 |
| `yfy_scope_check` | `mode=query` 返回 `in_scope=false`；`mode=assert` 返回业务错误 |

## Snapshot

| 工具 | 说明 |
|---|---|
| `yfy_snapshot_create` | 创建或复用后台快照，Agent 不管理 revision |
| `yfy_snapshot_get` | 状态、计数、观察窗口、完整性、artifact URI |
| `yfy_snapshot_query` | `mode=search/list`，直接查询 SQLite 索引；有后续结果时返回 opaque `next_cursor` |
| `yfy_snapshot_cancel` | 取消后台任务 |

`yfy_snapshot_create` 只接受命名 `scope_id`。根目录和访问身份由已配置的 Authority Scope 派生，Agent 不能直接指定任意根目录。

续页时原样回传 `next_cursor` 到 `cursor`。Cursor 使用服务端签名，并绑定 snapshot、revision、mode、item type 和查询词；Agent 不需要解析内部排序键，深页查询不会随已跳过行数线性变慢。后台扫描使 revision 变化时会返回 `YFY_SNAPSHOT_CURSOR_STALE`，此时从无 cursor 的第一页重新查询。

超过 100,000 项的 Snapshot 要求每个查询词至少 3 个字符，并限制单次最多 10 个查询词，以确保使用 trigram 索引而不是阻塞式全表子串扫描。

Snapshot 在每页原子提交时增量维护完整 receipt digest；manifest 最多内嵌前 1000 条 receipt，并通过 `receipt_count` 和 `receipts_truncated` 标记总量与截断状态。

典型完整性结果：

```json
{
  "pagination_complete": true,
  "safe_to_claim_absence": true,
  "scope": "within_observed_accessible_scope",
  "consistency_level": "best_effort_complete_observation",
  "incomplete_reasons": []
}
```

## Evidence

| 工具 | 说明 |
|---|---|
| `yfy_evidence_download` | 使用 `current` 或 `history/generations_back` selector 下载并校验内容 |
| `yfy_evidence_lock_current` | 范围证明、显式下载版本 0、下载后版本历史和元数据复核 |
| `yfy_evidence_verify` | 下载指定版本并比较 SHA-1、SHA-256、size、modified time 和 version key |
| `yfy_evidence_release` | 删除短期本地 Artifact 并使 resource URI 失效 |

版本详情的 `provider_version_id` 只用于版本详情接口，绝不传给下载接口。下载使用 `provider_download_version`：`0` 表示当前版，`1` 表示上一版。服务端会在请求 Provider 前拒绝越界代数，防止 Provider 静默回退当前版。

远程 HTTP Agent 应读取结果中的 `resource_uri` / `resource_link`，HTTP 结果不暴露服务器 `temp_path`；stdio 客户端仍可使用本地路径。超过 `YFY_MAX_EVIDENCE_RESOURCE_BYTES` 的 HTTP 结果会在完成哈希和元数据校验后立即删除本地文件，并通过 `resource_omitted` 与 `artifact_disposition=deleted_after_validation` 说明原因。

## Organization

| 工具 | 说明 |
|---|---|
| `yfy_department_read` | get、children、users |
| `yfy_user_search` | 企业用户搜索 |
| `yfy_group_read` | group list 或 users |

## Mutation

| 工具 | 说明 |
|---|---|
| `yfy_folder_create` | 创建文件夹 |
| `yfy_item_mutate` | update、move、copy、trash、delete_permanently、restore |
| `yfy_file_upload` | folder ID 或 path 上传 |
| `yfy_file_version_upload` | 上传新版本 |

## Collaboration

| 工具 | 说明 |
|---|---|
| `yfy_collaboration_read` | list_folder 或 get |
| `yfy_collaboration_mutate` | invite、invite_batch、update_role、delete、remove_batch |

## Admin

管理员能力按领域组合，避免 35 个浅工具：

- `yfy_admin_department_read`
- `yfy_admin_department_mutate`
- `yfy_admin_group_read`
- `yfy_admin_group_mutate`
- `yfy_admin_user_read`
- `yfy_admin_user_mutate`
- `yfy_admin_log_query`
- `yfy_admin_platform_map`
- `yfy_admin_platform_sync`

## Transfer

`yfy_transfer_ticket_get` 返回短时下载 URL，仅在 `transfer` toolset 开启时注册。常规 Evidence 工作流不需要开启它。
