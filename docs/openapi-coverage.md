# OpenAPI 覆盖矩阵

beta.6 不按 endpoint 创建浅工具，而是把 Provider 差异隐藏在 Drive、Inventory、Content 和 Organization Module 内。

## Drive

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| personal/collaboration/department/folder/workspace roots | `yfy_browse` | 已覆盖 |
| folder/file info | `yfy_get`、`yfy_get_many` | 已覆盖 |
| indexed search | `yfy_search` | 已覆盖，非穷尽 |
| exact path traversal | `yfy_resolve` | 组合覆盖 |
| version list | `yfy_versions` | 已覆盖，稳定 VersionRef |
| current/historical download | `yfy_open` | 组合覆盖并校验内容 |
| comments/shares | `yfy_comments`、`yfy_shares` | 已覆盖，分享敏感字段脱敏 |

## Workspace、Inventory 与 Capture

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| folder/department ancestry | `yfy_workspace_validate` | 组合覆盖 |
| file path membership | `yfy_membership_check` | 组合覆盖 |
| recursive complete observation | `yfy_inventory_*` | SQLite 后台覆盖，支持 freshness |
| validated current/historical bytes | `yfy_capture` | Workspace-bound 组合覆盖 |
| expected metadata/content assertions | `yfy_capture.expected` | mismatch 为错误并回滚 |
| resource lifecycle | `yfy_resource_release` | 单体和 multipart 均覆盖 |

## Organization 与写入

| Provider 能力 | 工具 |
|---|---|
| department info/children/users | `yfy_department_get/children/users` |
| user search | `yfy_user_search` |
| group list/users | `yfy_group_list/users` |
| collaboration | `yfy_collaboration_read/mutate` |
| folder/file mutation and upload | mutation toolset |
| enterprise administration | admin toolset |

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
