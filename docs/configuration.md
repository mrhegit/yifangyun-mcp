# 配置说明

本文档说明 `yifangyun-mcp-server` 的初始化配置、私有化部署地址规则、用户身份策略以及能力开关。

## 必填配置

| 环境变量 | 说明 | 示例 |
|---|---|---|
| `YFY_OPENAPI_BASE_URL` | 亿方云 OpenAPI 服务根地址。未配置时默认 `https://open.fangcloud.com` | `https://open.fangcloud.com` |
| `YFY_OAUTH_BASE_URL` | 亿方云 OAuth 服务根地址。未配置时默认 `https://open.fangcloud.com` | `https://open.fangcloud.com` |
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

## OpenAPI 地址规则

### 写法一：使用公有云默认地址

```bash
YFY_OPENAPI_BASE_URL=https://open.fangcloud.com
```

内部请求：

```text
https://open.fangcloud.com/api/v2/...
```

### 写法二：配置私有化 openapi 根地址

```bash
YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
```

内部请求：

```text
https://qiyeyun.example.com/openapi/api/v2/...
```

### 写法三：直接配置 API 根地址

```bash
YFY_API_BASE_URL=https://qiyeyun.example.com/openapi/api
```

该写法优先级最高，会直接作为 API 根地址使用。

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

## 能力开关

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_ALLOW_DOWNLOAD_URL` | `disabled` | 是否注册 `yfy_get_download_url` |
| `YFY_ENABLE_MUTATION_TOOLS` | `disabled` | 是否注册写操作工具 |
| `YFY_ENABLE_ADMIN_TOOLS` | `disabled` | 是否注册 admin 工具 |
| `YFY_ENABLE_RAW_RESPONSE` | `disabled` | 是否在工具输出中附带 `raw` 原始响应 |

推荐只读 authority 配置：

```bash
YFY_ALLOW_DOWNLOAD_URL=disabled
YFY_ENABLE_MUTATION_TOOLS=disabled
YFY_ENABLE_ADMIN_TOOLS=disabled
YFY_ENABLE_RAW_RESPONSE=disabled
```

## 推荐运行模式

### 1. 默认只读模式

适合资料查询、目录快照、证据锁定与版本核验。

```bash
YFY_ALLOW_DOWNLOAD_URL=disabled
YFY_ENABLE_MUTATION_TOOLS=disabled
YFY_ENABLE_ADMIN_TOOLS=disabled
YFY_ENABLE_RAW_RESPONSE=disabled
```

### 2. 受控写入模式

适合需要创建目录、上传文件、上传新版本、移动/恢复文件的自动化流程。

```bash
YFY_ALLOW_DOWNLOAD_URL=disabled
YFY_ENABLE_MUTATION_TOOLS=enabled
YFY_ENABLE_ADMIN_TOOLS=disabled
YFY_ENABLE_RAW_RESPONSE=disabled
```

### 3. 管理治理模式

适合组织同步、管理员日志、部门/群组/用户治理，不建议作为常规默认模式。

```bash
YFY_ALLOW_DOWNLOAD_URL=disabled
YFY_ENABLE_MUTATION_TOOLS=disabled
YFY_ENABLE_ADMIN_TOOLS=enabled
YFY_ENABLE_RAW_RESPONSE=disabled
```

## 运行保护参数

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `YFY_REQUEST_TIMEOUT_MS` | `30000` | 所有亿方云网络请求的超时时间 |
| `YFY_TOKEN_REFRESH_SKEW_SECONDS` | `300` | token 过期前提前刷新秒数 |
| `YFY_MAX_PAGE_CAPACITY` | `500` | 列表和搜索工具允许的最大页容量 |
| `YFY_MAX_DOWNLOAD_BYTES` | `268435456` | 单次下载最大字节数，默认 256 MiB |
| `YFY_TEMP_DIR` | 系统临时目录下的 `yifangyun-mcp` | 下载原件的本地临时目录 |
| `YFY_TEMP_FILE_TTL_SECONDS` | `86400` | temp 文件保留秒数 |
| `YFY_RETRY_MAX_ATTEMPTS` | `3` | 429/5xx 最大尝试次数 |
| `YFY_RETRY_BASE_DELAY_MS` | `500` | 退避基准毫秒数 |
| `YFY_MAX_RETRY_DELAY_MS` | `30000` | 单次退避最大毫秒数 |
| `YFY_MAX_CONCURRENT_PROVIDER_REQUESTS` | `4` | Provider 全局并发请求上限 |
| `YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` | `2` | access identity + endpoint 分桶并发上限 |
| `YFY_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` | 下载无数据 idle timeout |
| `YFY_DOWNLOAD_WALL_TIMEOUT_MS` | `300000` | 下载/上传 wall timeout |
| `YFY_MAX_TEMP_BYTES` | `1073741824` | temp 目录总字节配额 |
| `YFY_SCAN_DIR` | `YFY_TEMP_DIR/scans` | durable scan 状态和 page artifacts 目录 |
| `YFY_SCAN_TTL_SECONDS` | `604800` | scan artifact 默认保留 7 天 |
| `YFY_MAX_SCAN_BYTES` | `2147483648` | durable scan store 总字节配额 |
| `YFY_AUTHORITY_ROOT_FOLDER_ID` | 空 | 可选的配置期 authority root |
| `YFY_ALLOW_PRIVATE_TRANSFER_URLS` | `disabled` | 私有化可信部署是否允许传输 URL 指向私网 |
| `YFY_TRANSPORT` | `stdio` | `stdio` 或 `http` |
| `YFY_LOG_LEVEL` | `info` | 结构化日志级别 |

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

YFY_ALLOW_DOWNLOAD_URL=disabled
YFY_ENABLE_MUTATION_TOOLS=disabled
YFY_ENABLE_ADMIN_TOOLS=disabled
YFY_ENABLE_RAW_RESPONSE=disabled

YFY_REQUEST_TIMEOUT_MS=30000
YFY_DOWNLOAD_IDLE_TIMEOUT_MS=30000
YFY_DOWNLOAD_WALL_TIMEOUT_MS=300000
YFY_TOKEN_REFRESH_SKEW_SECONDS=300
YFY_MAX_PAGE_CAPACITY=500
YFY_MAX_DOWNLOAD_BYTES=268435456
YFY_MAX_TEMP_BYTES=1073741824
YFY_TEMP_DIR=
YFY_TEMP_FILE_TTL_SECONDS=86400
YFY_SCAN_DIR=
YFY_SCAN_TTL_SECONDS=604800
YFY_MAX_SCAN_BYTES=2147483648
YFY_AUTHORITY_ROOT_FOLDER_ID=
YFY_RETRY_MAX_ATTEMPTS=3
YFY_RETRY_BASE_DELAY_MS=500
YFY_MAX_RETRY_DELAY_MS=30000
YFY_MAX_CONCURRENT_PROVIDER_REQUESTS=4
YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY=2
YFY_LOG_LEVEL=info

YFY_TRANSPORT=stdio
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=
YFY_HTTP_ALLOWED_HOSTS=
YFY_HTTP_ALLOWED_ORIGINS=
```

## 配置校验规则

服务启动时会执行 fail-fast 校验。

| 校验项 | 规则 |
|---|---|
| 必填变量 | `client_id`、`client_secret`、企业 ID、默认用户 ID 缺失即启动失败 |
| URL | 必须是合法 URL；非 localhost 地址要求 HTTPS |
| ID | 企业 ID、用户 ID、部门 ID、文件 ID 必须是数字或数字字符串 |
| 管理员策略 | `YFY_FILE_ACCESS_USER_STRATEGY=admin` 时必须配置 `YFY_ADMIN_USER_ID` |
| 分页上限 | `YFY_MAX_PAGE_CAPACITY` 必须是正整数 |
| 下载上限 | `YFY_MAX_DOWNLOAD_BYTES` 必须是正整数 |
| retry 参数 | `YFY_RETRY_MAX_ATTEMPTS`、`YFY_RETRY_BASE_DELAY_MS` 必须是正整数 |

## 常见配置错误

| 现象 | 可能原因 | 处理 |
|---|---|---|
| OAuth 获取 token 失败 | `client_id`、`client_secret`、企业 ID 或 OAuth 地址错误 | 先调用 `yfy_auth_test` 验证 |
| 部门能查，文件不能查 | 企业 token 正常，但默认用户没有云盘权限 | 换 `user_id` 或配置管理员用户 |
| 私有化部署 404 | OpenAPI 地址少了或多了 `/api` | 优先使用 `YFY_OPENAPI_BASE_URL=https://host/openapi` |
| 没有 `yfy_get_download_url` | `YFY_ALLOW_DOWNLOAD_URL=disabled` | 按安全默认值设计，显式开启才注册 |
| 没有写工具或 admin 工具 | 对应能力开关未开启 | 设置 `YFY_ENABLE_MUTATION_TOOLS=enabled` 或 `YFY_ENABLE_ADMIN_TOOLS=enabled` |
| 下载失败提示超出大小限制 | 原件大于 `YFY_MAX_DOWNLOAD_BYTES` | 提高下载上限，或改成分批处理 |
