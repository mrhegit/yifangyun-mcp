# OpenAPI 覆盖矩阵

1.0 不机械映射每个 OpenAPI endpoint，而是将相关端点组合到稳定的领域工具中。

## 文件与目录

| Provider 能力 | 1.0 工具 | 状态 |
|---|---|---|
| personal/department/collaboration/folder/scope root | `yfy_root_list` | 已覆盖 |
| folder info/children | `yfy_item_get`、`yfy_folder_list` | 已覆盖 |
| file info/version info/version list | `yfy_item_get`、`yfy_file_versions` | 已覆盖 |
| indexed item search | `yfy_item_search` | 已覆盖，hint-only |
| exact path traversal | `yfy_path_resolve` | 组合覆盖 |
| recursive complete observation | Snapshot tools | 组合覆盖 |

## Authority 与 Evidence

| Provider 能力 | 1.0 工具 | 状态 |
|---|---|---|
| folder and department ancestry | `yfy_authority_validate` | 组合覆盖 |
| file path scope | `yfy_scope_check` | 组合覆盖 |
| download ticket and validated original bytes | `yfy_evidence_capture` | 组合覆盖，Scope-bound |
| content and metadata expectation checks | `yfy_evidence_capture.expected` | 组合覆盖 |
| direct download URL | `yfy_transfer_ticket_get` | 可选 sensitive toolset |

## 组织与协作

| Provider 能力 | 1.0 工具 | 状态 |
|---|---|---|
| department info/children/users | `yfy_department_read` | 已覆盖 |
| user search | `yfy_user_search` | 已覆盖 |
| group list/users | `yfy_group_read` | 已覆盖 |
| folder collabs/collab info | `yfy_collaboration_read` | 已覆盖 |
| invite/update/delete/remove collab | `yfy_collaboration_mutate` | 已覆盖 |
| file/folder share lists | `yfy_share_list` | 已覆盖，敏感字段脱敏 |
| file comments | `yfy_file_comments` | 只读覆盖 |

## 写入

| Provider 能力 | 1.0 工具 | 状态 |
|---|---|---|
| folder create | `yfy_folder_create` | 已覆盖 |
| file/folder update/move/copy/delete/restore | `yfy_item_mutate` | 已覆盖 |
| upload by folder/path | `yfy_file_upload` | 已覆盖 |
| upload new version | `yfy_file_version_upload` | 已覆盖 |

## Admin

| 域 | 1.0 工具 | 状态 |
|---|---|---|
| department | `yfy_admin_department_read/mutate` | 已覆盖主要接口 |
| group | `yfy_admin_group_read/mutate` | 已覆盖主要接口 |
| user/login material | `yfy_admin_user_read/mutate` | 已覆盖主要接口 |
| logs | `yfy_admin_log_query` | 已覆盖 4 个查询接口 |
| platform mapping/sync | `yfy_admin_platform_map/sync` | 已覆盖 |

## 暂未覆盖

- tags 和文件标签管理
- common/favorite files
- recycle bin 列表、清空和批量操作
- file version promote/delete 等版本生命周期操作
- user storage/space detail
- pack download
- blank file creation
- recent items 和 mark-as-used
- share-link create/update/close
- comment create/delete
- review/review comments
- knowledge base
- device synchronization

扩展这些能力时应增加新的可选 toolset 或扩展现有领域工具，不应重新引入一 endpoint 一 tool 的浅接口。
