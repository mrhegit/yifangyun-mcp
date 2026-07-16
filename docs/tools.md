# 工具参考

本文档描述当前 `yifangyun-mcp-server` 的工具分组、默认暴露策略和推荐使用方式。

如果你关心“当前到底覆盖了哪些官方 OpenAPI、哪些是部分覆盖、哪些明确不在范围内”，请同时阅读 [OpenAPI 覆盖矩阵](openapi-coverage.md)。

## 返回格式

所有工具统一返回：

```json
{
  "ok": true,
  "request_succeeded": true,
  "outcome": "success",
  "server_version": "0.4.0",
  "data": {},
  "meta": {
    "endpoint": "/api/v2/...",
    "fetched_at_iso": "2026-07-07T10:00:00.000Z",
    "fetched_at_unix": 1780000000,
    "source_api_version": "v2",
    "status_code": 200,
    "request_id": "optional",
    "rate_limit": {
      "limit": 100,
      "remaining": 97,
      "reset_seconds": 12
    }
  },
  "warnings": []
}
```

错误时返回：

```json
{
  "ok": false,
  "error": {
    "message": "错误说明",
    "retryable": false,
    "status_code": 403,
    "details": {}
  }
}
```

## 通用参数

### `user_id`

用于指定文件访问身份。文件、搜索、下载、协作、群组等用户态工具都支持该参数。

未传时按 `YFY_FILE_ACCESS_USER_STRATEGY` 决定默认用户。

### 分页参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `page_id` | `0` | 亿方云接口页码，从 0 开始 |
| `page_capacity` | `50` | 请求页容量，会受 `YFY_MAX_PAGE_CAPACITY` 限制 |

## 默认只读工具

### Durable Discovery Workflow

| Tool | 说明 |
|---|---|
| `yfy_start_scope_scan` | 初始化或复用 identity-scoped 持久化扫描 |
| `yfy_advance_scope_scan` | 按页数和 wall time 预算推进，使用 revision 做 CAS |
| `yfy_get_scope_scan` | 查询状态、frontier、完整性和 observation window |
| `yfy_cancel_scope_scan` | 显式取消 durable scan |
| `yfy_search_scope_snapshot` | 对已落盘 page artifacts 做多关键词搜索 |
| `yfy_list_scope_scan_matches` | 使用 scan policy 中保存的 query set 列出命中 |
| `yfy_list_scope_snapshot_items` | 通过 offset/limit 分页读取 snapshot items |

`pagination_complete=true` 只表示该访问身份在 observation window 内完成了策略范围内的分页观察。`safe_to_claim_absence=true` 仍限定为 `within_observed_accessible_scope`，不代表 Provider 提供强一致快照隔离。

### 基础与组织

| Tool | 说明 |
|---|---|
| `yfy_auth_test` | 验证企业 JWT、用户 JWT、基础接口 |
| `yfy_get_user_info` | 获取当前用户基础信息 |
| `yfy_get_department_info` | 获取部门详情 |
| `yfy_list_department_children` | 获取子部门 |
| `yfy_list_department_users` | 获取部门成员 |

### 文件与搜索基线

| Tool | 说明 |
|---|---|
| `yfy_list_personal_items` | 个人空间首层文件/文件夹 |
| `yfy_list_department_folders` | 部门首层文件夹 |
| `yfy_list_folder_children` | 文件夹单层 children |
| `yfy_search_items_recursive` | 基于 children 分页的有界递归名称搜索 |
| `yfy_search_items` | 官方搜索包装 |
| `yfy_search_items_advanced` | 同一官方搜索端点的增强包装 |
| `yfy_get_file_info` | 文件元信息 |
| `yfy_get_file_info_full` | richer file metadata |
| `yfy_get_folder_info` | 文件夹元信息 |

说明：`yfy_search_items_recursive` 不是 `/v2/item/search` 的直包，而是基于 `/v2/folder/{id}/children` 的分页递归能力，只在已知 `root_folder_id` 的前提下对子树后代名称做搜索。直接 children 记为深度 1，所以 `max_depth=0` 仍会扫描 root 的直接 children。结果完整性受 `max_depth`、`max_items`、`max_results` 与 `page_capacity` 共同约束。

### Authority 工具

| Tool | 说明 |
|---|---|
| `yfy_get_file_versions` | 获取文件版本列表 |
| `yfy_get_file_version_info` | 获取指定版本信息 |
| `yfy_get_folder_ancestors` | 获取文件夹祖先链 |
| `yfy_get_file_ancestors` | 获取文件祖先链 |
| `yfy_assert_file_in_scope` | 断言文件是否属于某 root folder |
| `yfy_get_file_scope_membership` | 查询文件 scope membership，允许返回 `in_scope=false` |
| `yfy_validate_authority_root` | 组合 folder、department chain 和可达性校验 |
| `yfy_build_scope_snapshot` | 构建 flat snapshot |
| `yfy_list_folder_tree` | 扁平化递归目录树 |
| `yfy_batch_get_file_info` | 批量获取文件详情 |
| `yfy_resolve_path` | 通过目录遍历解析 path |
| `yfy_verify_file_current_version` | 校验当前元数据是否与预期一致 |
| `yfy_lock_current_original` | scope proof + metadata + temp_path + sha256 |

### 协作与分享

| Tool | 说明 |
|---|---|
| `yfy_get_share_links` | 文件/文件夹分享链接列表 |
| `yfy_get_comments` | 文件评论列表 |
| `yfy_list_collab_items` | 与我协作的文件夹 |
| `yfy_get_folder_collabs` | 文件夹协作成员 |
| `yfy_list_groups` | 公司可见群组 |
| `yfy_get_group_users` | 群组成员 |
| `yfy_get_user_by_query` | 企业用户搜索 |

### 本地原件落地

| Tool | 说明 |
|---|---|
| `yfy_download_file_to_temp` | 下载到本地 temp 目录 |
| `yfy_download_and_hash` | 下载并返回 `sha256 + size_bytes + temp_path` |

## 受控敏感工具

### 下载链接工具

仅当 `YFY_ALLOW_DOWNLOAD_URL=enabled` 时注册：

| Tool | 说明 |
|---|---|
| `yfy_get_download_url` | 返回预签名 `download_url` |

## 受控 Mutation 工具

仅当 `YFY_ENABLE_MUTATION_TOOLS=enabled` 时注册：

| Tool | 说明 |
|---|---|
| `yfy_create_folder` | 创建文件夹 |
| `yfy_update_file` | 更新文件名称/描述 |
| `yfy_update_folder` | 更新文件夹名称/描述 |
| `yfy_move_item` | 移动文件/文件夹 |
| `yfy_copy_item` | 复制文件/文件夹 |
| `yfy_delete_item` | 删除到回收站或彻底删除 |
| `yfy_restore_item` | 从回收站恢复 |
| `yfy_upload_file` | 本地文件上传到指定 folder |
| `yfy_upload_file_by_path` | 本地文件上传到指定 path |
| `yfy_upload_new_version` | 上传新版本 |
| `yfy_manage_collab` | 协作 invite/update/delete/remove |

## 受控 Admin 工具

仅当 `YFY_ENABLE_ADMIN_TOOLS=enabled` 时注册：

| Tool | 说明 |
|---|---|
| `yfy_admin_departments` | admin 部门相关 action wrapper |
| `yfy_admin_groups` | admin 群组相关 action wrapper |
| `yfy_admin_users` | admin 用户相关 action wrapper |
| `yfy_admin_logs` | admin 日志相关 action wrapper |
| `yfy_admin_sync` | 平台同步与 mapping wrapper |

## 推荐使用顺序

### 找文件并锁原件

```text
1. 精确相对路径 -> yfy_resolve_path；已知 folder scope 且希望走官方索引 -> yfy_search_items(search_in_folder=...)；已知 root_folder_id 且需要对子树后代名称做有界递归搜索 -> yfy_search_items_recursive；否则 -> yfy_search_items
2. yfy_get_file_info_full
3. yfy_assert_file_in_scope
4. yfy_lock_current_original
```

### 做目录快照

```text
1. yfy_get_folder_info
2. yfy_build_scope_snapshot
3. yfy_batch_get_file_info (按需回源)
```

### 做受控上传

```text
1. 开启 YFY_ENABLE_MUTATION_TOOLS=enabled
2. yfy_upload_file / yfy_upload_new_version
3. yfy_get_file_info_full 或 yfy_get_file_versions 校验结果
```
