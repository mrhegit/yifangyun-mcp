# 工具参考

`1.0.0-beta.9`（`contract_version=4`）使用轻量 Drive 平面与可选的 Workspace、Inventory、Evidence、Organization 平面。普通发现工具保持低成本；范围证明、完整性结论和原件固化必须进入对应的受约束工具。相对 beta.8 的破坏性变更见 `docs/migration-v1.md`。

## 通用结果契约

成功结果的完整对象位于 `structuredContent`。当文本序列化超过 12,000 字符时，`content` 返回 `compact_preview` 或 `control_only` 信封：

- **`control`**：操作平面，完整保留 `page.next_cursor`、`next_action`、`inventory`、`resource.resource_uri`、`must_release`、`empty_result_meaning`、`selection_policy`；较大的判断字段使用有界投影
- **`result_preview`**：样本平面，可压缩
- **`text_delivery.continuation_ready`**：是否可凭 text 中 control 续页

优先级字段（如 `agent_warnings`、`content_delivery.agent_readable`、`agent_guidance`）优先保留在 control。`resource.preview_text` 不进入 compact text；正文通过 embedded resource、resources/read 或 `structuredContent` 提供。

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
folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa
version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh
inventory:<encrypted-opaque-token>
```

- ItemRef 绑定项目类型、Provider ID、`access_context` 和身份指纹。
- VersionRef 绑定 Provider version ID 和完整 FileRef，不能用于另一个文件。
- Workspace 工具只接受 `workspace:<id>`，不接受裸 Workspace ID。
- Inventory Ref 由 `YFY_CLIENT_SECRET` 加密认证，可跨服务重启使用且不暴露 scan UUID。`inventory_id` 不能作为工具输入。
- Ref 必须从当前服务结果中原样复制。修改 Context、Workspace 绑定或 `YFY_CLIENT_SECRET` 后，应重新发现 Ref。
- 旧版短 Ref（如 `file:<id>`）均无效。

## 分页契约

分页输入为**扁平**字段（无 `request.mode` 包装）。首次调用：

```json
{
  "at": "personal",
  "kind": "all",
  "detail": "basic",
  "limit": 10
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
      "cursor": "..."
    }
  }
}
```

续页必须原样执行 `next_action`。续页参数**仅**允许 `cursor`（以及工具固定字段如 `inventory` / `action`）；不能再传 `limit`、查询条件或首次请求参数。普通 cursor 为签名覆盖的规范 Base64URL，并绑定签发时的有效配置指纹；Access Context、Workspace 绑定或其他契约配置变化后，旧 cursor 会被拒绝。

`tools/list` 的 `inputSchema` 使用顶层 object + `anyOf` 精确公开首次页与续页两个分支；服务执行时使用同一 Zod validator。Host 不应根据一个分支中的 optional 字段自行拼接另一个分支。

- `YFY_CURSOR_INVALID` / `YFY_INVENTORY_CURSOR_INVALID`：输入无效，省略 cursor 并用首次业务字段重启。公开错误路径 `error.diagnostics.reason` 为 `not_base64url` | `envelope_invalid` | `signature_invalid` | `payload_invalid`，**不回传 raw 解码文本**。
- `YFY_CURSOR_STALE`：底层版本列表或评论集合变化，省略 cursor 并用首次业务字段重启。
- Inventory cursor 固定首次查询的 `commit_watermark`，后台继续扫描不会使该续页漂移。

## Status

`yfy_status` 无输入。即使 Provider 暂时不可用，它仍返回本地有效配置：

- `connected` 与 `provider.status=connected|unavailable`
- `server.version`、`contract_version`（beta.9 为 `4`）、`build_id`、`build_commit`、`instance_id`、`started_at`、`recommended_workflows`
- `server.config_fingerprint`，用于比较部署配置是否发生变化
- 默认 identity、可复制 `places`、已启用 `capabilities` 和 Workflow Profile readiness
- `runtime.configuration_source=process_environment` 及不含敏感值的运行参数摘要

Provider 不可用时 `identity.user` 和 provenance 可以为空。不要把 `provider.status=unavailable` 误判为配置不存在。

`recommended_workflows[].enabled=true` 仅在其步骤引用的完整工具链均已注册时出现：Capture 需要 Drive + Workspace + Evidence，Absence Audit 需要 Workspace + Inventory。

## Drive

| 工具 | 首次请求主要字段 | 主要输出 |
|---|---|---|
| `yfy_browse` | `at/kind/detail/limit/access_context` | `items/page/next_action` |
| `yfy_search` | `query/in/kind/field/detail/exact_name/sort/direction/limit/include_unverified_index_hits/access_context` | `agent_warnings/selection_policy/hits/unverified_hits/coverage/page` |
| `yfy_resolve` | `path/from/access_context` | `resolved/not_found/ambiguous` outcome |
| `yfy_get` | `ref/detail` | 当前 `item` 元数据 |
| `yfy_get_many` | `refs/detail` | 保持输入顺序的 success/error 数组和 summary |
| `yfy_versions` | `file/limit` | 文件回显、版本（`ref` 可 null）、`version_selection_rules`、fingerprint 和分页 |
| `yfy_open` | `file/version?/include_text_preview?` | `must_release`、`content_delivery`、验证后的内容 Resource |
| `yfy_comments` | `file/limit` | 文件回显、评论和分页 |
| `yfy_shares` | `item/limit` | 项目回显、脱敏分享信息和分页 |

Drive 和版本/评论/分享默认 `limit=10`，最大 100。`yfy_browse` 和 `yfy_search` 默认 `detail=basic`；`standard` 增加证据型元数据，`full` 请求更完整投影。

### yfy_search

Provider 索引候选发现，固定返回：

```json
{
  "coverage": {
    "mode": "provider_index",
    "exhaustive": false,
    "agent_must_read": true,
    "does_not_prove_current_existence": true,
    "does_not_prove_absence": true,
    "current_existence_confirmation_tool": "yfy_get",
    "counts": {
      "provider_raw": 0,
      "returned": 0,
      "returned_verified": 0,
      "returned_unverified": 0,
      "verified_hits": 0,
      "unverified_index_hits": 0,
      "scope_rejected": 0,
      "disambiguation_groups": 0
    }
  }
}
```

每个 hit 的 `match` 区分：

| trust | claim_allowed | 含义 |
|---|---|---|
| `locally_verified` | **true** | `local_value_match` / `provider_value_match`，可由返回字段验证 |
| `provider_snippet` | false | Provider snippet 含查询词，不可作确认存在 |
| `unverified_index_hit` | false | 仅索引信号，无法由返回值验证 |

**默认行为（beta.9）**：

- 默认 `hits` 只包含 `claim_allowed=true` 的命中，未验证候选不会占用默认分页额度。
- 未验证命中默认不进 `hits`，计入 `unverified_index_hits`；`agent_warnings` 会说明省略数量。
- `field=content` 默认包含 unverified 候选；显式 `include_unverified_index_hits=false` 可隐藏。其他 field 默认隐藏，传 true 才显示。
- include unverified 时，verified 与 unverified 按 Provider 返回顺序组成同一受 `limit`/cursor 约束的候选流；切片后分别投影到 `hits` 和 `unverified_hits`。
- `selection_policy=continue_search` 表示当前页没有可见候选但仍有后续页；必须执行 `next_action`。有多个候选或仍有后续页时返回 `must_disambiguate`。
- Cursor 累计已观察的可见候选数；末页即使为空，也按累计数返回 `single_candidate_ok` 或 `must_disambiguate`，不会丢失前页候选状态。
- `filtered_out_reason_counts` 区分 `unverified_omitted_by_default` 与 `unverified_omitted_by_explicit_request`。
- Provider 当前页同名多候选时 `match.disambiguation_required=true` 和 `same_name_hit_count_in_provider_page`；Search 非穷尽，因此永不返回“全局唯一”结论。
- 顶层始终有 `agent_warnings`（非穷尽 + claim 规则等）。

`exact_name` 仅能与 `field=name` 组合，按大小写敏感名称相等验证。`claim_allowed=true` 表示返回元数据支持查询匹配，不等价于持久的当前存在证明；依赖该文件前应调用 `yfy_get`。搜索空结果永远不能证明不存在；需要缺失结论时使用完整 Inventory。

### yfy_resolve / 路径

`yfy_resolve` 逐层遍历精确相对路径。同一层出现多个同名候选时返回 `status=ambiguous` 和 `candidates`，不会任意选择。不存在时返回 `missing_segment`、`segment_index` 和已匹配段。

Provider 路径投影为 `provider_path_chain` 和 `path_basis=provider_supplied`。它用于观察和辅助成员关系判断，不保证不同 endpoint 返回完全相同的链。

### yfy_versions

```json
{"file":"file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa","limit":10}
```

| 版本类型 | `ref` | `usage.for_open_or_capture` |
|---|---|---|
| 当前版 | `null` | `omit_version_parameter` |
| 历史版 | 可复制 VersionRef | `pass_version_ref` |

结果含 `version_selection_rules.current/historical` 文案。历史内容复制 VersionRef 到 `yfy_open` 或 `yfy_capture`；当前版本省略 `version`，不要编造 ref。

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
- `outside`：规范化后的 storage space 证据明确不同，且不与路径/space ID 证据冲突。
- `unavailable`：路径或空间元数据不足，或证据互相冲突（如 `missing_ancestor_chain`、`incomplete_space_metadata`、`same_space_path_inconclusive`、`conflicting_membership_evidence`）。

`agent_interpretation`：

```json
{
  "may_claim_inside": false,
  "may_claim_outside": false,
  "may_capture": false,
  "narrative": "...",
  "next_steps": ["..."]
}
```

- inside → 可 capture；outside → 禁止声称属于 workspace，禁止 capture；unavailable → **既不能断言属于，也不能断言不属于**，应改从 workspace 浏览/resolve 获取 path-backed ref。
- `mode=assert` 在 outside 时返回 `YFY_WORKSPACE_MEMBERSHIP_FAILED`，在 unavailable 时返回 `YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE`；错误 diagnostics 含同一套 `agent_interpretation`。
- 输出中的 `relative_ancestor_chain` 以配置的 Workspace 根为基准。

## Inventory

| 工具 | 说明 |
|---|---|
| `yfy_inventory_create` | 创建、加入或按新鲜度复用递归 Inventory；可选 `root_folder` 子树 |
| `yfy_inventory_get` | 读取 identity、进度、诊断、存储、保留期、`agent_guidance` 和完整性 |
| `yfy_inventory_search` | 搜索或列出固定观察水位内的项目，并重复返回 Workspace root、scan root、`agent_guidance` 与完整性 |
| `yfy_inventory_cancel` | 取消活动任务；终态调用为真正 no-op |
| `yfy_inventory_release` | 删除一个本地 Inventory，使 Ref、cursor、manifest 和 receipt URI 失效 |

创建时 Workspace、refresh 和 limits 都是必填；`root_folder` 可选：

```json
{
  "workspace": "workspace:tender_public",
  "root_folder": "folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa",
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

`root_folder` 必须是与 Workspace 同一身份的 context-bound FolderRef，且 membership 必须为 inside；outside / unavailable 会拒绝创建。省略时扫描配置的 Workspace 根。

`max_item_depth` 允许 1-100，`max_items` 允许 1-1,000,000。它们是观察边界：达到限制会使结果 partial，不能通过提高文案置信度来补偿。服务不再隐藏默认扫描上限。

`refresh.mode`：

- `reuse_if_fresh`：复用满足 `max_age_seconds` 的完整等价 Inventory，或加入仍在运行/等待重试的等价任务。
- `force_refresh`：创建新任务，不具备幂等语义。

`reuse.reason` 为 `fresh_complete`、`running_join` 或 `new`。partial、cancelled 和 failed 不会自动作为完整结果复用。

Inventory 状态：

- `running`：后台扫描进行中（含 `suggested_wait_ms`，默认约 750）。
- `retry_wait`：已持久化重试次数、下次重试时间和最后错误，等待恢复（`suggested_wait_ms` 对齐 `next_retry_at`）。
- `complete`：观察范围内分页完整。
- `partial`：因限制、Provider 契约或观察缺口终止。
- `cancelled`：调用方取消。
- `failed`：不可恢复失败。

`yfy_inventory_get` / create 摘要返回：

- `workspace.ref/root/access_context/fingerprint`
- `inventory` 是加密认证的 opaque Ref，可跨服务重启使用且不暴露 Access Context、scan UUID 或 Workspace fingerprint
- `inventory_id` 是内部 scan UUID，仅用于显示和日志，不能作为工具输入
- `scan_root.id/ref`（实际扫描根；可能是子树）
- `counts.files/folders/pages`
- `completeness.pagination_complete/safe_to_claim_absence/scope/consistency_level/incomplete_reasons`
- `agent_guidance.may_claim_absence`、可选 `absence_forbidden_reason`、`recommended_actions`、`empty_result_meaning`
- create 可选 `planning.risk_level` / `hints`
- 运行中可选 `suggested_wait_ms`
- `checkpoint.commit_watermark/control_revision/remaining_frontier_count`
- `diagnostics.retry_count/next_retry_at/last_error/incomplete_reasons`
- `retention.expires_at/storage.database_bytes/logical_bytes/wal_bytes`
- `observation_window`、manifest URI、receipt URI template 和运行中 `next_action`

只有 `terminal=true` 且 `completeness.safe_to_claim_absence=true`（等价 `agent_guidance.may_claim_absence=true`）时，才能在持久化的 **Workspace root + scan root**、身份、limits 和 observation window 内声明缺失。子树扫描的 `completeness.scope` 为 `observed_subtree`；Workspace 根配置变化会使旧 InventoryRef、manifest 和 receipt 资源返回 `YFY_INVENTORY_STALE`。

Inventory 搜索首次调用：

```json
{
  "inventory": "inventory:<encrypted-opaque-token>",
  "query": "招标文件",
  "kind": "file",
  "match_fields": ["name", "path"],
  "case_sensitive": false,
  "limit": 25
}
```

省略 `query` 表示列出。默认 kind 为 all、match fields 为 name+path、大小写不敏感、limit 为 25，最大 100。Search 每页重复返回 `workspace`、`scan_root`、`agent_guidance` 和 `completeness`；空结果须读 `empty_result_meaning`。子树缺失结论始终绑定具体 scan root。`view.commit_watermark` 是当前分页视图固定的水位；继续翻页仍保持旧视图稳定，新建首次查询（无 cursor）才看到新提交。

manifest 不内联全部 receipt。它与 create/get/search 使用同一范围投影，分别返回配置 Workspace root、实际 scan root 和一致的 `completeness.scope`。使用 `manifest_uri` 读取观察摘要，使用 `receipts_uri_template` 从 page 0 读取有界 receipt 页面并跟随 `next_uri`。

## Capture 与 Resource

普通读取：

```json
{"file":"file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa","include_text_preview":true}
```

Workspace-bound 固化：

```json
{
  "workspace": "workspace:tender_public",
  "file": "file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa",
  "include_text_preview": true,
  "version": "version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
  "expected": {
    "sha256": "...",
    "size_bytes": 123
  }
}
```

`yfy_open` 提供内容完整性验证；`yfy_capture` 还要求下载前后 Workspace membership 均为 inside。两者都会验证版本历史、内容 SHA-1/size 和文件元数据稳定性。

`expected` 支持 `sha1`、`sha256`、`size_bytes`、`modified_at_unix` 和当前版 `file_version_key`。历史版本不能用当前 `file_version_key` 断言。任一不匹配返回 `YFY_EXPECTATION_MISMATCH`，临时内容不会保留为 Resource。

成功输出顶层字段：

```json
{
  "must_release": true,
  "content_delivery": {
    "mode": "inline_preview",
    "resource_fetch_required": false,
    "embedded_resource_in_tool_result": true,
    "host_auto_fetch_not_guaranteed": true,
    "still_must_release": true,
    "next_step": "Use the embedded text resource or resource.preview_text; still call yfy_resource_release when finished."
  }
}
```

| `content_delivery.mode` | 含义 |
|---|---|
| `inline_preview` | 不超过 32 KiB 的已验证 UTF-8 文本；同时返回标准 MCP embedded resource 和 `resource.preview_text` |
| `resource_link_only` | 可预览类型但未 inline；须 `resources/read` |
| `multipart_manifest_only` | 大文件 manifest；永不 inline |
| `binary_no_preview` | 二进制/不可预览；依赖客户端附件能力 |

Resource 交付方式：

- `include_text_preview` 默认 true；设为 false 时不把正文嵌入工具结果，交付模式为 `resource_link_only`。
- `mcp_resource`：`yfy://evidence/<token>`，读取前复核普通文件、大小与 SHA-256；合法 UTF-8 文本返回 `text`，其他内容返回 `blob`。
- `multipart_resource`：`yfy://evidence/<token>/manifest`，manifest 列出有界 part URI。
- Resource 对象同样带 `must_release: true`。
- 不返回 `local_path` 或 Provider 下载 URL。

`embedded_resource_in_tool_result=true` 只证明服务已按 MCP 协议把文本放入工具结果，不证明特定 Host 一定把它送入模型上下文。`resource_link` 同样不保证自动 fetch。始终检查 `content_delivery`，处理完成后调用：

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

除 `yfy_department_get` 外均使用扁平分页（首次业务字段 / 续页 `cursor`）。Organization 默认 limit 为 25，最大 100。联系字段默认不返回，只有显式 `include_contact=true` 时才投影。

返回 `contact_policy`：

| `fields` | 含义 |
|---|---|
| `omitted_by_default` | 未请求联系字段 |
| `included` | 本页至少一个用户含 email/phone |
| `none_available` | 已请求但 Provider 未提供可投影联系字段 |

## 可选写入与管理

- Mutation：`yfy_folder_create`、`yfy_item_mutate`、`yfy_file_upload`、`yfy_file_version_upload`。
- Collaboration：`yfy_collaboration_read`、`yfy_collaboration_mutate`。
- Admin：department、group、user、日志和平台管理工具。
- Transfer：`yfy_transfer_ticket_get`，仅用于明确需要短时 Provider URL 的场景（`usage_policy=special_integration_only`，text 通道脱敏 URL）。

Mutation 的 item、parent、target 和 version upload file 均使用 context-bound Ref。move/copy 的来源和目标必须属于同一身份。上传源必须位于 `YFY_UPLOAD_ROOT_DIR`，服务通过 realpath、文件句柄和 inode/device 复核降低路径替换风险。

Admin 的 department users、group list/users 和 log list/list_paginated 同样使用扁平分页（`action` + 业务字段 / `action` + `cursor`），不再暴露 `page_id/page_capacity`。Provider 未声明分页容量或总数时，Admin 列表保守翻页到空页；服务端 cursor 的 page_id + offset 严格执行本地 `limit`，页指纹会拒绝 Provider 重复返回同一页，避免无限循环。日志分页使用实际发送的受配置约束容量推导续页。`next_action` 会保留 grouped tool 所需的 `action`；get、spaces、action_types、info 等非分页 action 不接受无关分页或过滤字段。

Collaboration 的 FolderRef 已经选择执行身份：list/invite/remove 等 folder action 不再同时接受 `access_context`。get/update/delete 等 collaboration ID action 禁止携带无关 folder，避免 FolderRef 静默覆盖调用方选择的身份。上传同时传 parent 和 `access_context` 时，两者必须指向同一 Context。

这些 toolset 不默认启用。读取内容优先使用 `yfy_open`；证据使用 `yfy_capture`。Transfer 可启用但**不是**证据路径。
