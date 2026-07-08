# 架构与安全

本文档说明 `yifangyun-mcp-server` 当前的架构设计、安全默认值与边界策略。

## 架构总览

```text
MCP Client
  |
  v
yifangyun-mcp-server
  |
  |-- src/index.ts
  |     |-- 创建 McpServer
  |     |-- 使用 StdioServerTransport
  |
  |-- src/config.ts
  |     |-- 读取环境变量
  |     |-- 校验 URL、ID、能力开关、运行保护参数
  |
  |-- src/client.ts
  |     |-- 生成 JWT assertion
  |     |-- enterprise/user token 缓存和提前刷新
  |     |-- GET/POST JSON 请求
  |     |-- 429/5xx 退避
  |     |-- 下载到 temp 并计算 sha256
  |     |-- 本地文件上传到 presign_url
  |
  |-- src/tools/registerTools.ts
        |-- 注册默认只读 authority 工具
        |-- 按开关注册 mutation/admin 工具
        |-- 输出裁剪、workflow 组合、统一返回 envelope
```

核心原则：

1. **OpenAPI-first**：优先封装官方公开路径
2. **默认最小暴露**：敏感下载 URL、mutation、admin 默认不注册
3. **authority 优先**：优先支持 `metadata + ancestry + versions + download+hash`

## 认证流程

亿方云企业 JWT 模式：

```text
client_id + client_secret
  |
  |-- Basic Authorization
  v
JWT assertion payload
  |
  |-- base64(JSON)
  v
POST /oauth/token?grant_type=jwt_simple&assertion=...
  |
  v
enterprise / user access_token
```

服务按以下维度缓存 token：

```text
enterprise:<enterprise_id>
user:<user_id>
```

## 权限边界

| 能力 | Token | 原因 |
|---|---|---|
| 部门、管理员、同步、日志 | 企业 token | 组织管理平面 |
| 文件夹、文件、搜索、版本、下载、协作 | 用户 token | 云盘访问平面 |

管理员账号只是一个拥有更大云盘权限的用户账号，不等同于企业 token。

## 安全默认值

| 开关 | 默认值 | 影响 |
|---|---:|---|
| `YFY_ALLOW_DOWNLOAD_URL` | `disabled` | 不注册 `yfy_get_download_url` |
| `YFY_ENABLE_MUTATION_TOOLS` | `disabled` | 不注册写工具 |
| `YFY_ENABLE_ADMIN_TOOLS` | `disabled` | 不注册 admin 工具 |
| `YFY_ENABLE_RAW_RESPONSE` | `disabled` | 不把原始响应体透给调用方 |

## 下载安全策略

当前优先推荐：

- `yfy_download_file_to_temp`
- `yfy_download_and_hash`
- `yfy_lock_current_original`

原因：

1. `download_url` 本身是敏感的短期访问凭据
2. 对证据链来说，`temp_path + sha256 + size_bytes + metadata` 更有价值
3. 服务端可以在不暴露 URL 的前提下完成下载与哈希

下载保护包括：

- `YFY_MAX_DOWNLOAD_BYTES` 大小限制
- `YFY_TEMP_DIR` 本地落地目录
- `YFY_TEMP_FILE_TTL_SECONDS` 过期清理
- 对 `download_url` / `presign_url` 的日志脱敏

## 写操作策略

写操作通过官方 OpenAPI 路径完成，但默认不注册。包括：

- create / update / move / copy / delete / restore
- upload / upload_by_path / upload_new_version
- collab mutations
- admin department/group/user/log/sync wrappers

开启前建议：

```text
YFY_ENABLE_MUTATION_TOOLS=enabled
YFY_ENABLE_ADMIN_TOOLS=enabled
```

## 上传策略

上传采用官方推荐的两段式流程：

```text
1. 调 OpenAPI 获取 presign_url
2. 使用本地文件内容上传到该 presign_url
```

当前实现优先尝试：

1. `PUT` 原始二进制
2. 若失败，再回退到 `POST multipart/form-data`

这样做是为了兼容官方文档中“获取 presign_url 后再上传”的契约，同时尽量适配不同部署网关。

## 输出裁剪策略

默认输出会优先保留：

- id / parent / path_chain / ancestor_folder_ids
- created_at / modified_at 的 unix + ISO 双字段
- ownership / modified_by
- size / sha1 / file_version_key
- workflow 所需的关键结构

默认不回传完整原始响应体，除非显式开启 `YFY_ENABLE_RAW_RESPONSE=enabled`。

## 限流与错误处理

客户端统一处理：

- 请求超时
- 401 / 403 / 404 语义化错误
- 429 / 5xx 自动退避
- 统一返回 `request_id` 和 `rate_limit` 元数据（若服务端提供）

## 已知边界

| 边界 | 说明 |
|---|---|
| transport | 当前仍是本地 `stdio` server，不是远程 HTTP server |
| OpenAPI 依赖 | 以官方公开 OpenAPI 为准；私有化部署返回字段可能有轻微差异 |
| 上传兼容性 | presign_url 二段上传已实现，但不同存储网关的细节仍建议实测 |
| temp 文件 | 下载原件会落本地临时目录，运维需关注磁盘配额 |

## 后续建议

1. 若要远程共享部署，下一步优先补 `Streamable HTTP` transport
2. 若要更强审计，增加独立 audit sink，而不是只依赖 MCP 客户端日志
3. 若要进一步追求 OpenAPI 完整覆盖，可按当前 action-wrapper 模式继续扩展 share-link 与 review 相关接口
