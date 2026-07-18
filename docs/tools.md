# 工具参考

`1.0.0-beta.7` 使用轻量 Drive 平面与可选的 Workspace、Inventory、Evidence、Organization 平面。普通发现工具保持低成本；范围证明、完整性结论和原件固化必须进入对应的受约束工具。

## 通用结果契约

成功结果的完整对象位于 `structuredContent`。当文本序列化超过 12,000 字符时，`content` 返回 `compact_preview`，其中保留真实样本、遗漏计数、Ref、路径、分页和 `next_action` 等操作锚点。

失败返回 `isError=true` 和结构化错误：

```json
{
  "error": {
    "code": "YFY_PERMISSION_DENIED",
    "category": "authorization",
    "message": "Permission denied.",
    "retryable": false,
    "phase": "provider_request",
    "suggested_action": "Use a context with access to this item."
  }
}
```

`category` 可能是 `invalid_input`、`authentication`、`authorization`、`not_found`、`rate_limited`、`timeout`、`provider_unavailable`、`provider_contract`、`stale_state`、`capacity_limit`、`cancelled`、`conflict` 或 `internal`。

provenance 不返回 endpoint、下载 URL pathname、凭据或 access context：

```json
{"source":"yifangyun_openapi","operation":"provider_request","observed_at":"2026-07-18T00:00:00.000Z","request_id":"optional"}
```

## Ref 契约

位置引用：

```text
personal
collaboration
department:480
folder:501@default.aaaaaaaaaaaaaaaaaaaaaaaa
workspace:tender_public
```

项目与版本引用：

```text
file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa
folder:502@reviewer.bbbbbbbbbbbbbbbbbbbbbbbb
version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh
inventory:<signed-payload>
```

- ItemRef 绑定项目类型、Provider ID、`access_context` 和身份指纹。
- VersionRef 绑定 Provider version ID 和完整 FileRef，不能用于另一个文件。
- Workspace 工具只接受 `workspace:<id>`，不接受裸 Workspace ID。
- Ref 必须从当前服务结果中原样复制。修改 Context、Workspace 绑定或 `YFY_CLIENT_SECRET` 后，应重新发现 Ref。
- beta.6 的 `file:<id>`、`folder:<id>` 和 `version:<file_id>:<version_id>` 均无效。

## 分页契约

所有分页工具的顶层输入都包含严格的 `request` 对象。首次调用：

```json
{
  "request": {
    "mode": "first_request",
    "at": "personal",
    "kind": "all",
    "detail": "basic",
    "limit": 10
  }
}
```

分页结果：

```json
{
  "page": {
    "returned_count": 10,
    "has_more": true,
    "next_cursor": "..."
  },
  "next_action": {
    "tool": "yfy_browse",
    "arguments": {
      "request": {
        "mode": "continuation",
        "cursor": "..."
      }
    }
  }
}
```

续页必须原样执行 `next_action`。`continuation` 只允许 `mode` 和 `cursor`；不能再传 `limit`、查询条件、Ref、Provider 页码或首次请求参数。普通 cursor 为签名覆盖的规范 Base64URL，并绑定签发时的有效配置指纹；Access Context、Workspace 绑定或其他契约配置变化后，旧 cursor 会被拒绝。

- `YFY_CURSOR_INVALID` / `YFY_INVENTORY_CURSOR_INVALID`：输入无效，使用 `first_request` 重启。
- `YFY_CURSOR_STALE`：底层版本列表或评论集合变化，使用 `first_request` 重启。
- Inventory cursor 固定首次查询的 `commit_watermark`，后台继续扫描不会使该续页漂移。

## Status

`yfy_status` 无输入。即使 Provider 暂时不可用，它仍返回本地有效配置：

- `connected` 与 `provider.status=connected|unavailable`
- `server.version`、`contract_version`、`build_id`、`build_commit`、`instance_id`、`started_at`
- `server.config_fingerprint`，用于比较部署配置是否发生变化
- 默认 identity、可复制 `places`、已启用 `capabilities` 和 Workflow Profile readiness
- `runtime.configuration_source=process_environment` 及不含敏感值的运行参数摘要

Provider 不可用时 `identity.user` 和 provenance 可以为空。不要把 `provider.status=unavailable` 误判为配置不存在。

## Drive

| 工具 | 首次请求主要字段 | 主要输出 |
|---|---|---|
| `yfy_browse` | `request.at/kind/detail/limit/access_context` | `items/page/next_action` |
| `yfy_search` | `request.query/in/kind/field/detail/exact_name/sort/direction/limit/access_context` | `hits/coverage/page` |
| `yfy_resolve` | `path/from/access_context` | `resolved/not_found/ambiguous` outcome |
| `yfy_get` | `ref/detail` | 当前 `item` 元数据 |
| `yfy_get_many` | `refs/detail` | 保持输入顺序的 success/error 数组和 summary |
| `yfy_versions` | `request.file/limit` | 文件回显、版本、fingerprint 和分页 |
| `yfy_open` | `file/version?` | 验证后的内容 Resource |
| `yfy_comments` | `request.file/limit` | 文件回显、评论和分页 |
| `yfy_shares` | `request.item/limit` | 项目回显、脱敏分享信息和分页 |

Drive 和版本/评论/分享默认 `limit=10`，最大 100。`yfy_browse` 和 `yfy_search` 默认 `detail=basic`；`standard` 增加证据型元数据，`full` 请求更完整投影。

`yfy_search` 是 Provider 索引候选发现，固定返回 `coverage.mode=provider_index` 和 `exhaustive=false`。每个 hit 的 `match` 区分：

- 可由返回字段验证的 `local_value_match` / `provider_value_match`
- Provider snippet 提供的内容证据
- 只有索引信号、无法由返回值验证的 `provider_index_only`
- Workspace/folder 范围是本地验证、Provider 过滤或拒绝

`exact_name` 仅能与 `field=name` 组合，按大小写敏感名称相等验证。搜索空结果永远不能证明不存在；需要缺失结论时使用完整 Inventory。

`yfy_resolve` 逐层遍历精确相对路径。同一层出现多个同名候选时返回 `status=ambiguous` 和 `candidates`，不会任意选择。不存在时返回 `missing_segment`、`segment_index` 和已匹配段。

Provider 路径投影为 `provider_path_chain` 和 `path_basis=provider_supplied`。它用于观察和辅助成员关系判断，不保证不同 endpoint 返回完全相同的链。

历史内容先调用：

```json
{"request":{"mode":"first_request","file":"file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa","limit":10}}
```

复制非当前版本的 VersionRef 到 `yfy_open` 或 `yfy_capture`。当前版本省略 `version`。

## Workspace

### yfy_workspace_validate

输入：

```json
{"workspace":"workspace:tender_public","expected_path":["采购部","2026招标"]}
```

输出包含 Workspace identity、根 folder Ref、业务路径、department chain 和以下三态检查：

- `pass`：已经由当前观察证明。
- `fail`：已经观察到明确不符合。
- `unavailable`：Provider 元数据或页面信息不足，不能证明通过或失败。

顶层 `verdict` 为 `valid`、`invalid` 或 `unavailable`。任何检查为 fail 时是 invalid；没有 fail 但存在 unavailable 时是 unavailable。

### yfy_membership_check

输入必须使用同一身份下发现的 FileRef 和 WorkspaceRef：

```json
{"file":"file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa","workspace":"workspace:tender_public","mode":"query"}
```

`membership` 为：

- `inside`：根目录出现在祖先链中，或文件直接位于根目录下。
- `outside`：存在明确的跨存储空间证据，能够证明文件不属于 Workspace root 所在空间。
- `unavailable`：路径未包含 root，且现有元数据不足以安全证明 outside。格式合法但可能截断的 Provider 路径不会被当成完整祖先证明。

`mode=assert` 在 outside 时返回 `YFY_WORKSPACE_MEMBERSHIP_FAILED`，在 unavailable 时返回 `YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE`。输出中的 `relative_ancestor_chain` 以配置的 Workspace 根为基准。

## Inventory

| 工具 | 说明 |
|---|---|
| `yfy_inventory_create` | 创建、加入或按新鲜度复用递归 Inventory |
| `yfy_inventory_get` | 读取 identity、进度、诊断、存储、保留期和完整性 |
| `yfy_inventory_search` | 搜索或列出固定观察水位内的项目 |
| `yfy_inventory_cancel` | 取消活动任务；终态调用为真正 no-op |
| `yfy_inventory_release` | 删除一个本地 Inventory，使 Ref、cursor、manifest 和 receipt URI 失效 |

创建时 Workspace、refresh 和 limits 都是必填：

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

`max_item_depth` 允许 1-100，`max_items` 允许 1-1,000,000。它们是观察边界：达到限制会使结果 partial，不能通过提高文案置信度来补偿。服务不再隐藏默认扫描上限。

`refresh.mode`：

- `reuse_if_fresh`：复用满足 `max_age_seconds` 的完整等价 Inventory，或加入仍在运行/等待重试的等价任务。
- `force_refresh`：创建新任务，不具备幂等语义。

`reuse.reason` 为 `fresh_complete`、`running_join` 或 `new`。partial、cancelled 和 failed 不会自动作为完整结果复用。

Inventory 状态：

- `running`：后台扫描进行中。
- `retry_wait`：已持久化重试次数、下次重试时间和最后错误，等待恢复。
- `complete`：观察范围内分页完整。
- `partial`：因限制、Provider 契约或观察缺口终止。
- `cancelled`：调用方取消。
- `failed`：不可恢复失败。

`yfy_inventory_get` 返回：

- `workspace.ref/root/access_context/fingerprint`
- `counts.files/folders/pages`
- `completeness.pagination_complete/safe_to_claim_absence/scope/consistency_level/incomplete_reasons`
- `checkpoint.commit_watermark/control_revision/remaining_frontier_count`
- `diagnostics.retry_count/next_retry_at/last_error/incomplete_reasons`
- `retention.expires_at/storage.database_bytes/logical_bytes/wal_bytes`
- `observation_window`、manifest URI、receipt URI template 和运行中 `next_action`

只有 `terminal=true` 且 `completeness.safe_to_claim_absence=true` 时，才能在该 Workspace、身份、limits 和 observation window 内声明缺失。

Inventory 搜索首次调用：

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

省略 `query` 表示列出。默认 kind 为 all、match fields 为 name+path、大小写不敏感、limit 为 25，最大 100。`view.commit_watermark` 是当前分页视图固定的水位，`current_commit_watermark` 是任务最新进度；两者不同时，继续翻页仍保持旧视图稳定，新建 first_request 才看到新提交。

manifest 不内联全部 receipt。使用 `manifest_uri` 读取观察摘要，使用 `receipts_uri_template` 从 page 0 读取有界 receipt 页面并跟随 `next_uri`。

## Capture 与 Resource

普通读取：

```json
{"file":"file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa"}
```

Workspace-bound 固化：

```json
{
  "workspace": "workspace:tender_public",
  "file": "file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa",
  "version": "version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
  "expected": {
    "sha256": "...",
    "size_bytes": 123
  }
}
```

`yfy_open` 提供内容完整性验证；`yfy_capture` 还要求下载前后 Workspace membership 均为 inside。两者都会验证版本历史、内容 SHA-1/size 和文件元数据稳定性。

`expected` 支持 `sha1`、`sha256`、`size_bytes`、`modified_at_unix` 和当前版 `file_version_key`。历史版本不能用当前 `file_version_key` 断言。任一不匹配返回 `YFY_EXPECTATION_MISMATCH`，临时内容不会保留为 Resource。

成功输出包含 file/version、selection proof、assurance checks、expectation、Resource 和分阶段 provenance。Resource 交付方式：

- `mcp_resource`：`yfy://evidence/<token>`，合法 UTF-8 文本返回 `text`，其他内容返回 `blob`。
- `multipart_resource`：`yfy://evidence/<token>/manifest`，manifest 列出有界 part URI。
- 不返回 `local_path` 或 Provider 下载 URL。

处理完成后调用：

```json
{"resource_uri":"yfy://evidence/<token>"}
```

`yfy_resource_release` 幂等；基础 URI 和 manifest URI 都可释放。Resource 到期、释放或完整性复核失败后不可再读。

## Organization

- `yfy_department_get`：读取一个部门。
- `yfy_department_children`：分页读取子部门。
- `yfy_department_users`：分页读取部门用户。
- `yfy_user_search`：分页搜索用户。
- `yfy_group_list`：分页列出或过滤群组。
- `yfy_group_users`：分页读取群组成员。

除 `yfy_department_get` 外均使用统一 `request.mode` 分页。Organization 默认 limit 为 25，最大 100。联系字段默认不返回，只有显式 `include_contact=true` 时才投影。

## 可选写入与管理

- Mutation：`yfy_folder_create`、`yfy_item_mutate`、`yfy_file_upload`、`yfy_file_version_upload`。
- Collaboration：`yfy_collaboration_read`、`yfy_collaboration_mutate`。
- Admin：department、group、user、日志和平台管理工具。
- Transfer：`yfy_transfer_ticket_get`，仅用于明确需要短时 Provider URL 的场景。

Mutation 的 item、parent、target 和 version upload file 均使用 context-bound Ref。move/copy 的来源和目标必须属于同一身份。上传源必须位于 `YFY_UPLOAD_ROOT_DIR`，服务通过 realpath、文件句柄和 inode/device 复核降低路径替换风险。

Admin 的 department users、group list/users 和 log list/list_paginated 同样使用 `request.mode=first_request|continuation`，不再暴露 `page_id/page_capacity`。其 `next_action` 会保留 grouped tool 所需的 `action`；get、spaces、action_types、info 等非分页 action 不传 request。

Collaboration 的 FolderRef 已经选择执行身份：list/invite/remove 等 folder action 不再同时接受 `access_context`。get/update/delete 等 collaboration ID action 禁止携带无关 folder，避免 FolderRef 静默覆盖调用方选择的身份。上传同时传 parent 和 `access_context` 时，两者必须指向同一 Context。

这些 toolset 不默认启用。读取内容优先使用 `yfy_open`，不要为方便而启用 `transfer`；范围内原件固化使用 `yfy_capture`。
