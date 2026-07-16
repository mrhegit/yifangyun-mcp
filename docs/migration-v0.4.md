# v0.4 迁移说明

## 新增首选工具

大目录任务迁移到 `yfy_start_scope_scan`、`yfy_advance_scope_scan`、`yfy_get_scope_scan`、`yfy_search_scope_snapshot` 和 `yfy_list_scope_snapshot_items`。

`yfy_build_scope_snapshot`、`yfy_list_folder_tree`、`yfy_search_items_recursive` 暂时保留，定位为小目录同步兼容工具。它们至少保留一个发布周期，移除前会在 README 和工具描述中再次公告。

## 搜索语义

`yfy_search_items_advanced` 是首选官方索引搜索。其结果包含 `authority.level=hint_only`，不得用于证明文件不存在。

`yfy_search_items` 作为简化 alias 保留一个弃用周期。

## Scope 语义

新增 `yfy_get_file_scope_membership` 作为查询工具，允许成功返回 `in_scope=false`。

`yfy_assert_file_in_scope` 现在符合 assert 语义：范围不匹配时返回 `isError=true` 和 `YFY_SCOPE_ASSERTION_FAILED`。依赖旧行为的调用方应改用 membership 工具。

## 返回契约

统一 envelope 新增 `request_succeeded`、`outcome` 和 `server_version`。原有 `ok` 字段继续保留。

默认 projection 改为 `minimal`，不再返回 owner、modified_by 的 login/email。需要较丰富 metadata 时显式传 `detail_level=standard|full`；联系人字段仍需工具明确支持 `include_contact=true`。

## 写请求重试

所有非幂等 POST 默认不再自动重试。调用方收到未知结果时应先回读 Provider 状态，不得直接重放写请求。
