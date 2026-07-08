# OpenAPI 覆盖矩阵

本文档用于回答两个问题：

1. 当前 MCP 已经覆盖了哪些亿方云官方 OpenAPI 能力
2. 哪些能力是部分覆盖、暂未覆盖，或明确不在当前 server 范围内

## 设计边界

当前 `yifangyun-mcp-server` 的目标不是把 FangCloud 全部 OpenAPI 机械镜像成上百个工具，而是优先覆盖：

- 云盘目录与文件定位
- 文件范围校验与原件锁定
- 版本链、下载与哈希
- 基础协作、群组、组织、管理员治理
- 受控写入能力

不在当前主范围内的域：

- 设备同步
- 常用文件 / 标签
- 审阅 / 审阅评论
- 知识库
- 智能体

## 已覆盖能力

### 认证与组织

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| `/v2/user/info` | `yfy_get_user_info` | 已覆盖 |
| `/v2/user/search` | `yfy_get_user_by_query` | 已覆盖 |
| `/v2/admin/department/{id}/info` | `yfy_get_department_info`, `yfy_admin_departments(action=info)` | 已覆盖 |
| `/v2/admin/department/{id}/children` | `yfy_list_department_children`, `yfy_admin_departments(action=children)` | 已覆盖 |
| `/v2/admin/department/{id}/users` | `yfy_list_department_users`, `yfy_admin_departments(action=users)` | 已覆盖 |

### 文件与文件夹只读

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| `/v2/folder/personal_items` | `yfy_list_personal_items` | 已覆盖 |
| `/v2/folder/department_folders` | `yfy_list_department_folders` | 已覆盖 |
| `/v2/folder/{id}/children` | `yfy_list_folder_children`, `yfy_list_folder_tree`, `yfy_build_scope_snapshot`, `yfy_search_items_recursive`, `yfy_resolve_path` | 已覆盖 |
| `/v2/folder/{id}/info` | `yfy_get_folder_info` | 已覆盖 |
| `/v2/file/{id}/info_v2` | `yfy_get_file_info`, `yfy_get_file_info_full` | 已覆盖 |
| `/v2/item/search` | `yfy_search_items`, `yfy_search_items_advanced` | 已覆盖 |

注：`yfy_search_items_recursive` 是基于 `children` 分页递归出来的组合型只读能力，不是官方 `/v2/item/search` 的直包。

### Authority / 证据链

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| `/v2/file/{id}/versions` | `yfy_get_file_versions` | 已覆盖 |
| `/v2/file/{id}/version/{version_id}/info` | `yfy_get_file_version_info` | 已覆盖 |
| `/v2/file/{id}/download_v2` | `yfy_get_download_url`, `yfy_download_file_to_temp`, `yfy_download_and_hash`, `yfy_lock_current_original` | 已覆盖 |
| 文件/文件夹祖先链（依赖 `info/info_v2` 返回的 path） | `yfy_get_folder_ancestors`, `yfy_get_file_ancestors`, `yfy_assert_file_in_scope` | 已覆盖 |
| 多层目录快照（基于 `children` 分页） | `yfy_build_scope_snapshot`, `yfy_list_folder_tree` | 已覆盖 |

### 协作、分享、群组

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| `/v2/folder/collab_folders` | `yfy_list_collab_items` | 已覆盖 |
| `/v2/folder/{id}/collabs` | `yfy_get_folder_collabs` | 已覆盖 |
| `/v2/file/{id}/share_links` | `yfy_get_share_links(item_type=file)` | 已覆盖 |
| `/v2/folder/{id}/share_links` | `yfy_get_share_links(item_type=folder)` | 已覆盖 |
| `/v2/file/{id}/comments` | `yfy_get_comments` | 已覆盖 |
| `/v2/group/list` | `yfy_list_groups` | 已覆盖 |
| `/v2/group/{id}/users` | `yfy_get_group_users` | 已覆盖 |
| `/v2/collab/invite` 等 6 个协作接口 | `yfy_manage_collab` | 已覆盖 |

### 受控写入

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| `/v2/folder/create` | `yfy_create_folder` | 已覆盖 |
| `/v2/file/{id}/update` | `yfy_update_file` | 已覆盖 |
| `/v2/folder/{id}/update` | `yfy_update_folder` | 已覆盖 |
| `/v2/file/{id}/move` | `yfy_move_item(item_type=file)` | 已覆盖 |
| `/v2/folder/{id}/move` | `yfy_move_item(item_type=folder)` | 已覆盖 |
| `/v2/file/{id}/copy` | `yfy_copy_item(item_type=file)` | 已覆盖 |
| `/v2/folder/{id}/copy` | `yfy_copy_item(item_type=folder)` | 已覆盖 |
| `/v2/file/{id}/delete` / `delete_from_trash` | `yfy_delete_item(item_type=file, from_trash=...)` | 已覆盖 |
| `/v2/folder/{id}/delete` / `delete_from_trash` | `yfy_delete_item(item_type=folder, from_trash=...)` | 已覆盖 |
| `/v2/file/{id}/restore_from_trash` | `yfy_restore_item(item_type=file)` | 已覆盖 |
| `/v2/folder/{id}/restore_from_trash` | `yfy_restore_item(item_type=folder)` | 已覆盖 |
| `/v2/file/upload_v2` | `yfy_upload_file` | 已覆盖 |
| `/v2/file/upload_by_path` | `yfy_upload_file_by_path` | 已覆盖 |
| `/v2/file/{id}/new_version_v2` | `yfy_upload_new_version` | 已覆盖 |

### 管理员治理

| 官方 OpenAPI | 当前工具 | 覆盖状态 |
|---|---|---|
| admin department create/update/delete/add/remove user/update space | `yfy_admin_departments` | 已覆盖 |
| admin group create/update/delete/add/remove user | `yfy_admin_groups` | 已覆盖 |
| admin user info/create/update/delete/get_user_info/login_url/login_params | `yfy_admin_users` | 已覆盖 |
| admin logs `action_type_info/log_info/log_list/log_list_by_pagination` | `yfy_admin_logs` | 已覆盖 |
| admin platform `mapping_*` / `sync_*` | `yfy_admin_sync` | 已覆盖 |

## 部分覆盖能力

这些域已经覆盖了当前最核心的使用场景，但还没有把该域全部公开接口都做完。

### 文件域

| 官方 OpenAPI | 当前状态 | 说明 |
|---|---|---|
| `/v2/file/{id}/trash` | 未覆盖 | 当前已支持 delete/restore，但未单独暴露 trash detail |
| `/v2/file/recent_items` | 未覆盖 | 不影响 authority 主链 |
| `/v2/file/{item_id}/mark_as_used` | 未覆盖 | 不影响 authority 主链 |
| `/v2/file/create_blank_file` | 未覆盖 | 当前不是核心能力 |
| `/v2/file/pack_download` | 未覆盖 | 当前只做单文件原件链路 |
| `/v2/file/{id}/copy_by_path` | 未覆盖 | 当前已有 copy，但未做 path 变体 |

### 文件夹域

| 官方 OpenAPI | 当前状态 | 说明 |
|---|---|---|
| `/v2/folder/create_by_path` | 未覆盖 | 当前已有 `yfy_resolve_path` + `yfy_create_folder`，但未直接包装 path create |
| `/v2/folder/{id}/trash` | 未覆盖 | 当前已支持 delete/restore，但未单独暴露 trash detail |

### 分享与评论域

| 官方 OpenAPI | 当前状态 | 说明 |
|---|---|---|
| `/v2/share_link/create` / `info` / `info_detail` / `update` / `close` | 未覆盖 | 当前只覆盖了 file/folder 上的 share_links list |
| `/v2/comment/create` / `{id}/delete` | 未覆盖 | 当前只覆盖评论读取 |

### 用户域

| 官方 OpenAPI | 当前状态 | 说明 |
|---|---|---|
| `/v2/user/departments` | 未覆盖 | 当前主链不依赖 |
| `/v2/user/space_usage` | 未覆盖 | 当前主链不依赖 |
| `/v2/user/as_user_code` | 未覆盖 | 当前 JWT 模式不依赖 |
| `/v2/user/{id}/info` / `update` / `profile_pic_download` | 部分 | 当前覆盖的是当前用户信息和企业用户搜索 |

### 管理员域

| 官方 OpenAPI | 当前状态 | 说明 |
|---|---|---|
| `/v2/admin/department/{platform_id}/get_file_manager_info` | 未覆盖 | 当前 admin wrapper 未纳入 |

## 明确不在当前范围内

| 域 | 说明 |
|---|---|
| 设备同步 | 当前不是云盘 authority 主链 |
| 常用文件 / 标签 | 当前不是主链 |
| 审阅 / 审阅评论 | 当前不是主链 |
| 知识库 | 建议单独 server 或单独工具面 |
| 智能体 | 建议单独 server 或单独工具面 |

## 维护建议

后续如果继续扩展，建议优先顺序：

1. 分享链接完整域
2. 评论写操作
3. 回收站详情与列表
4. recent items / mark_as_used

继续扩展前，优先保持：

- 不破坏默认安全开关
- 不把非主域能力混入默认只读工具面
- 先补覆盖矩阵和测试，再扩工具
