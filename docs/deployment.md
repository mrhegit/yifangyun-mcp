# 部署指南

本文档说明如何本地运行、接入 MCP 客户端、从 GitHub 安装，以及如何验证服务可用性。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | 20 或更高版本 |
| npm | 10 或更高版本，低版本通常也可运行 |
| 网络 | 能访问亿方云 OAuth 和 OpenAPI 服务 |
| 凭证 | 亿方云开放平台 `client_id`、`client_secret`、企业 ID、用户 ID |

## 本地运行

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

启动：

```bash
npm start
```

stdio MCP 服务启动后会等待 MCP 客户端通过标准输入输出通信。直接在终端运行时不会出现交互式菜单，这是正常现象。

## Streamable HTTP

```bash
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-secret
npm start
```

端点为 `http://127.0.0.1:3000/mcp`。另提供受同一鉴权保护的 `/health` 和 `/metrics`。非 localhost 监听必须同时配置 Bearer token、`YFY_HTTP_ALLOWED_HOSTS` 和 `YFY_HTTP_ALLOWED_ORIGINS`，否则服务拒绝启动。

## MCP 客户端接入

配置示例：

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "node",
      "args": ["/absolute/path/to/yifangyun-mcp/dist/index.js"],
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

Windows 路径示例：

```json
{
  "args": ["C:/Users/you/projects/yifangyun-mcp/dist/index.js"]
}
```

路径建议使用正斜杠，避免 JSON 中反斜杠转义问题。

OpenCode 配置使用 `mcp.<name>.env` 注入环境变量，不要写成 `environment`。修改配置后需要重启 OpenCode，已启动的 MCP 进程不会热更新环境变量。

## 从 GitHub 克隆部署

```bash
git clone git@github.com:mrhegit/yifangyun-mcp.git
cd yifangyun-mcp
npm install
npm run build
```

然后将 `dist/index.js` 配置到 MCP 客户端。

## 从 GitHub 作为 npm git 依赖安装

如果你的运行环境支持从 GitHub 安装 npm 包，可以使用：

```bash
npm install git+ssh://git@github.com:mrhegit/yifangyun-mcp.git
```

包内配置了 `prepare` 脚本，安装时会执行 TypeScript 构建。

## npm 市场安装

发布到 npm 后，可以全局安装：

```bash
npm install -g yifangyun-mcp-server
```

MCP 客户端配置：

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "yifangyun-mcp-server",
      "args": [],
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

也可以用 npx：

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "npx",
      "args": ["-y", "yifangyun-mcp-server"],
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

## GitHub Actions 自动发布 npm

仓库已配置 GitHub Actions，通过仓库 Secret `NPM_TOKEN` 发布到 npm。

工作流文件：

```text
.github/workflows/publish.yml
```

触发条件：推送 `v*` tag。

发布前需要在 GitHub 仓库中配置：

```text
Settings -> Secrets and variables -> Actions -> New repository secret -> NPM_TOKEN
```

建议使用 npm 的 Automation Token。

发版流程：

```bash
npm run build
npm version patch
git push
git push --tags
```

`npm version patch` 会把 `package.json` 版本从例如 `0.1.0` 升到 `0.1.1`，并自动创建 `v0.1.1` tag。GitHub Actions 会校验 tag 版本和 `package.json` 版本一致，不一致会拒绝发布。

工作流步骤：

```text
checkout
setup-node@v4
校验 tag 与 package.json version
npm ci
npm run build
npm pack --dry-run
npm publish
创建 GitHub Release
```

发布前包内容由 `package.json` 的 `files` 字段控制，仅包含：

```text
dist/
README.md
LICENSE
docs/
.env.example
```

## 验证步骤

推荐按以下顺序验证。

### 1. 验证构建

```bash
npm run build
```

构建成功后应生成：

```text
dist/index.js
dist/client.js
dist/config.js
dist/tools/registerTools.js
```

### 2. 验证 MCP 工具列表

当前服务不是固定“11 个工具”了，而是按能力开关暴露不同工具面。

默认只读模式下，应至少看到：

```text
yfy_auth_test
yfy_get_user_info
yfy_get_department_info
yfy_list_department_children
yfy_list_department_users
yfy_list_personal_items
yfy_list_department_folders
yfy_list_folder_children
yfy_search_items_recursive
yfy_search_items
yfy_search_items_advanced
yfy_get_file_info
yfy_get_file_info_full
yfy_get_folder_info
yfy_get_file_versions
yfy_get_file_version_info
yfy_get_folder_ancestors
yfy_get_file_ancestors
yfy_assert_file_in_scope
yfy_get_file_scope_membership
yfy_validate_authority_root
yfy_start_scope_scan
yfy_advance_scope_scan
yfy_get_scope_scan
yfy_cancel_scope_scan
yfy_search_scope_snapshot
yfy_list_scope_scan_matches
yfy_list_scope_snapshot_items
yfy_build_scope_snapshot
yfy_list_folder_tree
yfy_batch_get_file_info
yfy_resolve_path
yfy_get_share_links
yfy_get_comments
yfy_list_collab_items
yfy_get_folder_collabs
yfy_list_groups
yfy_get_group_users
yfy_get_user_by_query
yfy_download_file_to_temp
yfy_download_and_hash
yfy_verify_file_current_version
yfy_lock_current_original
```

只有在显式开启时，才会额外注册：

```text
YFY_ALLOW_DOWNLOAD_URL=enabled       -> yfy_get_download_url
YFY_ENABLE_MUTATION_TOOLS=enabled    -> create/update/move/copy/delete/restore/upload/collab tools
YFY_ENABLE_ADMIN_TOOLS=enabled       -> admin department/group/user/log/sync tools
```

### 3. 验证认证

调用：

```text
yfy_auth_test
```

成功时会返回：

```json
{
  "ok": true,
  "data": {
    "enterprise_token_ok": true,
    "user_token_ok": true
  }
}
```

### 4. 验证部门目录

```text
yfy_list_department_children(department_id=0)
yfy_list_department_folders(department_id=<目标部门ID>)
yfy_list_folder_children(folder_id=<目标文件夹ID>)
```

## 私有化部署注意事项

公有云默认地址为：

```text
OpenAPI: https://open.fangcloud.com/api/v2/...
OAuth:   https://open.fangcloud.com/oauth/token
```

因此公有云部署通常不需要配置 `YFY_OPENAPI_BASE_URL` 和 `YFY_OAUTH_BASE_URL`。

私有化部署常见地址形态：

```bash
YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
YFY_OAUTH_BASE_URL=https://qiyeyun.example.com/openoauth
```

服务实际请求：

```text
https://qiyeyun.example.com/openoauth/oauth/token
https://qiyeyun.example.com/openapi/api/v2/...
```

如果你的部署已经把 OpenAPI 地址暴露到 `/openapi/api`，可以改用：

```bash
YFY_API_BASE_URL=https://qiyeyun.example.com/openapi/api
```

## 日志与敏感信息

stdio MCP 不能向 stdout 打普通日志，因为 stdout 用于 MCP 协议通信。服务只在 stderr 输出启动或失败信息。

不要在 MCP 客户端配置中提交真实 `client_secret`。推荐通过部署平台的环境变量、密钥管理或本机私密配置注入。

## 故障排查

| 问题 | 原因 | 处理 |
|---|---|---|
| 服务启动即退出 | 必填环境变量缺失 | 检查 `YFY_*` 配置 |
| `yfy_auth_test` 失败 | OAuth 地址或凭证错误 | 检查 `YFY_OAUTH_BASE_URL`、`client_id`、`client_secret` |
| 部门能查但文件不能查 | 默认用户没有文件权限 | 换 `user_id` 或启用管理员策略 |
| 私有化部署返回 404 | OpenAPI 路径拼接错误 | 在 `YFY_OPENAPI_BASE_URL` 与 `YFY_API_BASE_URL` 两种写法中选择正确一种 |
| 没有 `yfy_get_download_url` | 安全默认值关闭了敏感下载 URL 工具 | 显式设置 `YFY_ALLOW_DOWNLOAD_URL=enabled` |
| 下载原件失败 | 文件不存在、无权限、超过 `YFY_MAX_DOWNLOAD_BYTES` 或 temp 目录不可写 | 先查 `yfy_get_file_info_full`，再查下载上限和 temp 目录 |
| 提示响应不是合法 JSON | 请求命中登录页、HTML 网关错误页或代理拦截页 | 查看返回详情里的 `endpoint`、`content_type` 和 `response_preview` |
| 空 `user_id` 触发校验 | 客户端把未填写的可选参数传成空字符串 | 升级到当前版本后空字符串按未传处理；不要用 `0` 表示默认用户 |

## 生产化建议

当前第一版是 stdio 本地/单客户端部署模式。如果需要多人共享远程 MCP 服务，建议后续增加 Streamable HTTP transport，并加入以下能力：

| 能力 | 原因 |
|---|---|
| 访问控制 | 防止任意调用者使用同一套亿方云凭证 |
| 审计日志 | 记录谁查询了哪个文件或下载链接 |
| 速率限制 | 防止递归扫描或频繁搜索压垮私有化服务 |
| 下载链接脱敏策略 | 远程服务场景下下载 URL 更敏感 |
