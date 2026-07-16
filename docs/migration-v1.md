# 1.0 迁移说明

1.0 是一次完整的破坏性重构，不提供旧工具别名、旧参数解析、旧响应 envelope 或旧配置映射。升级时应把 Agent 配置、调用代码和部署配置作为一个整体切换，不要混用两个版本的契约。

## 主要变化

- 工具按 Core、Authority、Snapshot、Evidence、Organization 等领域重新组织
- Agent 使用命名 `access_context`，不再在每个工具中传递裸 `user_id`
- Authority 工作流使用命名 `scope_id`，根目录和访问身份由 scope 配置统一派生
- Snapshot 是 1.0 新增的完整目录观察能力，负责后台分页、重试、完整性判断和索引查询
- Evidence capture 统一处理范围证明、当前版本固定、下载、哈希和下载后漂移复核
- 工具成功结果直接返回领域字段，不再包含通用成功 envelope 或 Provider raw response
- Streamable HTTP 使用有状态 MCP session，支持 `POST`、`GET`、`DELETE` 和 SSE

## 工具迁移

| 旧版工具 | 1.0 工具 |
|---|---|
| `yfy_auth_test`、`yfy_get_user_info` | `yfy_connection_check`、`yfy_context_get` |
| `yfy_get_file_info`、`yfy_get_file_info_full`、`yfy_get_folder_info` | `yfy_item_get` |
| `yfy_batch_get_file_info` | `yfy_items_get` |
| `yfy_list_folder_children` | `yfy_folder_list` |
| `yfy_search_items`、`yfy_search_items_advanced` | `yfy_item_search` |
| `yfy_resolve_path` | `yfy_path_resolve` |
| 递归目录扫描与 scope scan 工具 | `yfy_snapshot_create`、`yfy_snapshot_get`、`yfy_snapshot_query` |
| 文件范围查询与断言工具 | `yfy_scope_check` |
| 下载、哈希和原件锁定工具 | `yfy_evidence_capture`、`yfy_evidence_verify` |
| 多个文件 mutation 工具 | `yfy_item_mutate`、`yfy_folder_create`、upload 工具 |
| 多个管理原子工具 | 对应的 admin read/mutate 工具 |

`yfy_snapshot_create` 必须传 `scope_id`。1.0 不允许 Agent 直接传任意根目录创建 Authority Snapshot。

## 参数与响应

- `user_id`、`external_enterprise_id` 改由 `access_context` 配置管理
- Authority 工作流中的 `root_folder_id` 改为 `scope_id`
- `detail_level`、`include_full_metadata` 改为各工具定义的稳定 view 或领域字段
- Snapshot 使用 opaque `cursor` / `next_cursor`，不接受 offset 分页
- 所有 Agent-facing ID 使用数字字符串
- 错误通过 MCP `isError=true` 返回 `{error:{code,message,...}}`

调用方必须按每个 1.0 工具的 `inputSchema` 和 `outputSchema` 重新生成参数与解析逻辑，不应继续判断 `ok`、`request_succeeded`、`outcome`、`data` 或 `raw`。

## 配置重建

最小配置：

```env
YFY_CLIENT_ID=...
YFY_CLIENT_SECRET=...
YFY_ENTERPRISE_ID=...
YFY_DEFAULT_USER_ID=...
YFY_API_BASE_URL=https://open.fangcloud.com/api
YFY_OAUTH_BASE_URL=https://open.fangcloud.com
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
YFY_ACCESS_CONTEXTS_JSON=[]
YFY_SCOPES_JSON=[]
```

需要 Authority、Snapshot 或 current-locked Evidence 时，应先配置 scope：

```env
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

不要把旧配置文件直接交给 1.0 使用。以 `.env.example` 为模板重新建立配置，并显式选择需要启用的 toolset。

## 升级步骤

1. 停止旧服务，保留旧配置和产物作为只读回滚参考。
2. 使用 `.env.example` 创建 1.0 配置，定义 access context、scope 和 toolset。
3. 为 `YFY_STATE_DB` 配置新的本地路径；Snapshot 是 1.0 新能力，不读取旧扫描产物。
4. 更新 MCP 客户端中的工具名、参数、响应解析和 HTTP session 处理。
5. 运行 `yfy_connection_check`、`yfy_context_get` 和 `yfy_authority_validate` 验证身份与 scope。
6. 创建一个小范围 Snapshot，确认 `safe_to_claim_absence` 只在完整观察后为 true。
7. 使用受控文件执行一次 Evidence capture，核对 file ID、version、SHA-256、size 和 path proof。
8. 完成只读验证后，再按需开启 `mutation`、`collaboration`、`admin` 或 `transfer`。

旧扫描结果和旧 evidence 元数据不属于 1.0 合同。需要继续作为权威证据使用的文件，应通过 1.0 重新 capture，生成新的 provenance、哈希和 resource reference。

## 回滚边界

1.0 与旧版不能共享调用契约或运行状态。回滚时应整体切回旧服务、旧配置和旧客户端定义；不要让两个版本同时写同一状态目录，也不要把 1.0 Snapshot 或 Evidence metadata 交给旧版解析。
