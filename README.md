# yifangyun-mcp-server

亿方云 OpenAPI 的 MCP Server。当前版本定位为 **OpenAPI-first 的 Cloud Authority Server**：

- 默认暴露只读 authority 能力
- 写操作与管理员操作按环境变量显式开启
- 默认不暴露 `download_url`
- 支持把原件下载到本地临时目录并计算 `sha256`

## 核心特性

| 特性 | 说明 |
|---|---|
| 企业 JWT 默认认证 | 使用 `grant_type=jwt_simple` 换取企业 token 和用户 token |
| OpenAPI-first | 以亿方云官方 OpenAPI 路径为主，不做脱离官方能力面的私有协议 |
| 分层能力面 | `只读 authority` + `受控 mutation/admin` |
| Authority 工具 | folder/file info、versions、ancestors、scope assert、snapshot、download+hash |
| 本地下载落地 | 下载文件到 `YFY_TEMP_DIR`，返回 `temp_path + sha256 + size_bytes` |
| 安全默认值 | `download_url` 默认不注册，mutation/admin 默认不注册 |
| 私有化部署适配 | 支持 `https://host/openapi` 和 `https://host/openapi/api` 两类地址配置 |
| 统一响应 | 所有工具统一返回 `ok/data/meta/warnings/raw?` 结构 |
| 限流元数据 | 返回 `request_id`、`source_api_version`、`X-Rate-Limit-*` 摘要 |

## 主要能力

### 核心能力

这部分默认开启，适合做文件定位、范围校验、版本核对和原件锁定：

- `yfy_get_folder_info`
- `yfy_get_file_info`
- `yfy_get_file_info_full`
- `yfy_get_file_versions`
- `yfy_get_file_version_info`
- `yfy_get_folder_ancestors`
- `yfy_get_file_ancestors`
- `yfy_assert_file_in_scope`
- `yfy_download_file_to_temp`
- `yfy_download_and_hash`
- `yfy_verify_file_current_version`
- `yfy_lock_current_original`

### 扩展只读能力

这部分默认也会开启，适合做目录快照、批量回源、路径解析、协作与组织信息查询：

- `yfy_build_scope_snapshot`
- `yfy_list_folder_tree`
- `yfy_search_items_recursive`
- `yfy_batch_get_file_info`
- `yfy_resolve_path`
- `yfy_search_items`
- `yfy_search_items_advanced`
- `yfy_get_share_links`
- `yfy_get_comments`
- `yfy_list_collab_items`
- `yfy_get_folder_collabs`
- `yfy_list_groups`
- `yfy_get_group_users`
- `yfy_get_user_by_query`

搜索定位建议：已知精确相对路径时优先 `yfy_resolve_path`；已知 folder scope 且希望继续走官方索引时优先 `yfy_search_items` / `yfy_search_items_advanced` 并传 `search_in_folder`；只有在已知 `root_folder_id` 且需要对子树后代名称做有界递归搜索时，再使用 `yfy_search_items_recursive`。

### 可选写入与管理员能力

这部分默认关闭。只有在显式开启对应环境变量后，才会注册：

- `yfy_create_folder`
- `yfy_update_file`
- `yfy_update_folder`
- `yfy_move_item`
- `yfy_copy_item`
- `yfy_delete_item`
- `yfy_restore_item`
- `yfy_upload_file`
- `yfy_upload_file_by_path`
- `yfy_upload_new_version`
- `yfy_manage_collab`
- `yfy_admin_departments`
- `yfy_admin_groups`
- `yfy_admin_users`
- `yfy_admin_logs`
- `yfy_admin_sync`

### 底层能力说明

为了支撑上面的工具，服务内部已经实现：

- 统一 `GET/POST JSON` 请求内核
- token 缓存和提前刷新
- 429/5xx 自动退避
- 本地 temp 下载与 `sha256` 计算
- 预签名上传地址后的本地文件投递

## 安全默认值

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_ALLOW_DOWNLOAD_URL` | `disabled` | 关闭后不注册 `yfy_get_download_url` |
| `YFY_ENABLE_MUTATION_TOOLS` | `disabled` | 关闭后不注册任何写工具 |
| `YFY_ENABLE_ADMIN_TOOLS` | `disabled` | 关闭后不注册任何 admin 工具 |
| `YFY_ENABLE_RAW_RESPONSE` | `disabled` | 关闭后工具不回传原始响应体 |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` | 默认最大下载 256 MiB |

## 快速开始

```bash
npm install
npm run build
```

最小公有云配置：

```bash
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
```

私有化部署再覆盖地址：

```bash
YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
YFY_OAUTH_BASE_URL=https://qiyeyun.example.com/openoauth

# 如果部署直接暴露 /openapi/api，可改用：
# YFY_API_BASE_URL=https://qiyeyun.example.com/openapi/api
```

启动 stdio MCP：

```bash
npm start
```

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "node",
      "args": ["/path/to/yifangyun-mcp/dist/index.js"],
      "env": {
        "YFY_CLIENT_ID": "your-client-id",
        "YFY_CLIENT_SECRET": "your-client-secret",
        "YFY_ENTERPRISE_ID": "115",
        "YFY_DEFAULT_USER_ID": "530"
      }
    }
  }
}
```

## 权限模型

亿方云 OpenAPI 仍然有两个权限平面：

| 权限平面 | Token | 适用接口 |
|---|---|---|
| 企业管理 | 企业 token | 部门、管理员、同步、日志 |
| 云盘访问 | 用户 token | 文件夹、文件、搜索、版本、下载、协作 |

即使某个账号是云盘管理员，也不要假设企业 token 能直接访问文件接口。文件访问工具默认使用 `YFY_DEFAULT_USER_ID`，或根据 `YFY_FILE_ACCESS_USER_STRATEGY` 走 `admin/explicit` 策略。

## 典型调用链

### 锁定当前原件

```text
yfy_assert_file_in_scope(file_id, root_folder_id)
  -> 证明文件属于授权根目录
yfy_lock_current_original(file_id, root_folder_id)
  -> 返回 metadata + temp_path + sha256
```

### 构建目录快照

```text
yfy_build_scope_snapshot(root_folder_id, max_depth=3, max_items=1000)
  -> 返回 root_folder + folders[] + files[] + stats
```

### 受控上传新版本

```text
设置 YFY_ENABLE_MUTATION_TOOLS=enabled
yfy_upload_new_version(file_id, local_path="/path/to/file")
  -> OpenAPI 申请 presign_url
  -> 本地字节上传
  -> 返回 current_file
```

## 开发命令

```bash
npm run build
npm test
npm run dev
```

## 详细文档

| 文档 | 内容 |
|---|---|
| [配置说明](docs/configuration.md) | 环境变量、能力开关、私有化部署地址、运行保护参数 |
| [工具参考](docs/tools.md) | 当前工具分组、推荐使用方式、默认暴露策略 |
| [OpenAPI 覆盖矩阵](docs/openapi-coverage.md) | 当前 MCP 对官方 OpenAPI 的覆盖范围、部分覆盖项与明确不在范围内的域 |
| [部署指南](docs/deployment.md) | 本地运行、MCP 客户端接入、GitHub 安装建议 |
| [架构与安全](docs/architecture-security.md) | 架构分层、认证流程、安全默认值、下载与写操作边界 |

## 版本状态

当前包版本：`0.3.0`。

这次实现把仓库从“只读目录检索 + 下载链接返回”升级成了“authority 优先、OpenAPI-first、写能力显式开关”的 MCP Server。
