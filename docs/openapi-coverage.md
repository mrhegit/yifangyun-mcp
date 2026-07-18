# OpenAPI 覆盖矩阵

beta.9 不按 endpoint 创建浅工具，而是把 Provider 差异隐藏在 Drive、Workspace、Inventory、Content 和 Organization Module 内。所有项目工具使用 context-bound Ref，分页工具统一使用扁平 first 字段 / `cursor` 续页契约（见 `docs/migration-v1.md`）。

## Drive

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| personal/collaboration/department/folder/workspace roots | `yfy_browse` | 已覆盖 |
| folder/file info | `yfy_get`、`yfy_get_many` | 已覆盖 |
| indexed search | `yfy_search` | 已覆盖，非穷尽；返回字段级 match evidence |
| exact path traversal | `yfy_resolve` | 组合覆盖；同名候选返回 ambiguous |
| version list | `yfy_versions` | 已覆盖，VersionRef 绑定完整 FileRef |
| current/historical download | `yfy_open` | 组合覆盖并校验内容 |
| comments/shares | `yfy_comments`、`yfy_shares` | 已覆盖，分享敏感字段脱敏 |

## Workspace、Inventory 与 Capture

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| folder/department ancestry | `yfy_workspace_validate` | 组合覆盖，检查为 pass/fail/unavailable |
| file path membership | `yfy_membership_check` | 组合覆盖，结果为 inside/outside/unavailable |
| recursive complete observation | `yfy_inventory_*` | SQLite schema 5 后台覆盖，分离 Workspace root/scan root，支持 refresh、固定 commit watermark 和显式 release |
| validated current/historical bytes | `yfy_open`、`yfy_capture` | Workspace-bound 组合覆盖；小文本可按 MCP embedded resource 交付 |
| expected metadata/content assertions | `yfy_capture.expected` | mismatch 为错误并回滚 |
| resource lifecycle | `yfy_resource_release` | 单体和 multipart 均覆盖 |
| inventory artifact lifecycle | `yfy_inventory_release` | Inventory、cursor、manifest 和 receipt 一并失效 |

## Organization 与写入

| Provider 能力 | 工具 |
|---|---|
| department info/children/users | `yfy_department_get/children/users` |
| user search | `yfy_user_search` |
| group list/users | `yfy_group_list/users` |
| collaboration | `yfy_collaboration_read/mutate` |
| folder/file mutation and upload | mutation toolset |
| enterprise administration | admin toolset；Provider 未声明 page capacity 的列表使用本地 offset/limit cursor |

## 暂未覆盖

- tags 和文件标签管理
- favorite/recent items
- recycle bin 批量操作
- file version promote/delete
- pack download
- share-link create/update/close
- comment create/delete
- review、knowledge base 和 device synchronization

扩展时应优先加深现有 Module，避免重新引入一 endpoint 一 tool 的接口。
