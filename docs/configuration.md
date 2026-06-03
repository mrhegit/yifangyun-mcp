# 配置说明

本文档说明 `yifangyun-mcp-server` 的初始化配置、私有化部署地址规则、用户身份策略和运行保护参数。

## 必填配置

| 环境变量 | 说明 | 示例 |
|---|---|---|
| `YFY_OPENAPI_BASE_URL` | 亿方云 OpenAPI 服务根地址。系统会自动拼接 `/api/v2/...`；未配置时默认 `https://open.fangcloud.com` | `https://open.fangcloud.com` |
| `YFY_OAUTH_BASE_URL` | 亿方云 OAuth 服务根地址。系统会请求 `/oauth/token`；未配置时默认 `https://open.fangcloud.com` | `https://open.fangcloud.com` |
| `YFY_CLIENT_ID` | 开放平台应用 ID | `your-client-id` |
| `YFY_CLIENT_SECRET` | 开放平台应用密钥 | `your-client-secret` |
| `YFY_ENTERPRISE_ID` | 企业 ID，用于生成企业 token | `115` |
| `YFY_DEFAULT_USER_ID` | 默认用户 ID，用于文件、搜索、下载等用户态接口 | `530` |

公有云最小配置示例：

```bash
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
```

默认情况下服务会使用：

```text
OpenAPI: https://open.fangcloud.com/api/v2/...
OAuth:   https://open.fangcloud.com/oauth/token
```

## OpenAPI 地址规则

服务支持两种写法。

### 写法一：使用公有云默认地址

不配置 `YFY_OPENAPI_BASE_URL` 时，默认使用：

```bash
YFY_OPENAPI_BASE_URL=https://open.fangcloud.com
```

服务内部会生成：

```text
https://open.fangcloud.com/api/v2/...
```

### 写法二：配置私有化 openapi 根地址

```bash
YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
```

服务内部会生成：

```text
https://qiyeyun.example.com/openapi/api/v2/...
```

该写法适合大多数第三方私有化部署，因为它和常见旧脚本里的 `open_url` 保持一致。

### 写法三：直接配置 API 根地址

```bash
YFY_API_BASE_URL=https://qiyeyun.example.com/openapi/api
```

服务内部会直接生成：

```text
https://qiyeyun.example.com/openapi/api/v2/...
```

如果同时配置 `YFY_API_BASE_URL` 和 `YFY_OPENAPI_BASE_URL`，优先使用 `YFY_API_BASE_URL`。

## 用户身份策略

文件访问接口需要用户 token。服务通过 `YFY_FILE_ACCESS_USER_STRATEGY` 决定未显式传 `user_id` 时使用哪个用户。

| 策略值 | 行为 | 适用场景 |
|---|---|---|
| `default` | 使用 `YFY_DEFAULT_USER_ID` | 常规使用，推荐默认值 |
| `admin` | 使用 `YFY_ADMIN_USER_ID` | 希望统一用云盘管理员访问文件 |
| `explicit` | 工具调用必须显式传 `user_id` | 权限审计严格，禁止隐式用户身份 |

管理员模式示例：

```bash
YFY_ADMIN_USER_ID=530
YFY_FILE_ACCESS_USER_STRATEGY=admin
```

显式用户模式示例：

```bash
YFY_FILE_ACCESS_USER_STRATEGY=explicit
```

在显式用户模式下，以下工具必须传 `user_id`：

```text
yfy_get_user_info
yfy_list_personal_items
yfy_list_department_folders
yfy_list_folder_children
yfy_search_items
yfy_get_file_info
yfy_get_download_url
```

## 运行保护参数

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_REQUEST_TIMEOUT_MS` | `30000` | 所有亿方云网络请求的超时时间 |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` | token 过期前提前刷新秒数 |
| `YFY_MAX_PAGE_CAPACITY` | `500` | MCP 允许传给列表和搜索工具的最大页容量 |
| `YFY_ALLOW_DOWNLOAD_URL` | `enabled` | 是否允许 `yfy_get_download_url` 返回下载链接 |
| `YFY_LOG_LEVEL` | `info` | 预留日志级别配置 |

关闭下载链接输出：

```bash
YFY_ALLOW_DOWNLOAD_URL=disabled
```

关闭后，`yfy_get_download_url` 会返回错误，不会请求下载 URL。

## 完整 `.env` 示例

```bash
YFY_OPENAPI_BASE_URL=https://open.fangcloud.com
YFY_OAUTH_BASE_URL=https://open.fangcloud.com
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530

YFY_ADMIN_USER_ID=
YFY_FILE_ACCESS_USER_STRATEGY=default

YFY_REQUEST_TIMEOUT_MS=30000
YFY_TOKEN_REFRESH_SKEW_SECONDS=300
YFY_MAX_PAGE_CAPACITY=500
YFY_ALLOW_DOWNLOAD_URL=enabled
YFY_LOG_LEVEL=info

# 私有化部署示例：
# YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
# YFY_OAUTH_BASE_URL=https://qiyeyun.example.com/openoauth
```

## 配置校验规则

服务启动时会执行 fail-fast 校验。

| 校验项 | 规则 |
|---|---|
| 必填变量 | `client_id`、`client_secret`、企业 ID、默认用户 ID 缺失即启动失败；公有云地址有默认值 |
| URL | 必须是合法 URL；非 localhost 地址要求 HTTPS |
| ID | 企业 ID、用户 ID、部门 ID、文件 ID 必须是数字或数字字符串 |
| 管理员策略 | `YFY_FILE_ACCESS_USER_STRATEGY=admin` 时必须配置 `YFY_ADMIN_USER_ID` |
| 分页上限 | `YFY_MAX_PAGE_CAPACITY` 必须是正整数 |

## 常见配置错误

| 现象 | 可能原因 | 处理 |
|---|---|---|
| OAuth 获取 token 失败 | `client_id`、`client_secret`、企业 ID 或 OAuth 地址错误 | 先调用 `yfy_auth_test` 验证 |
| 部门能查，文件不能查 | 企业 token 正常，但默认用户没有云盘权限 | 换 `user_id` 或配置管理员用户 |
| 私有化部署 404 | OpenAPI 地址少了或多了 `/api` | 优先使用 `YFY_OPENAPI_BASE_URL=https://host/openapi` |
| 下载工具失败 | 文件不存在、用户无权限、或 `YFY_ALLOW_DOWNLOAD_URL=disabled` | 先调用 `yfy_get_file_info` 验证文件可见性 |
