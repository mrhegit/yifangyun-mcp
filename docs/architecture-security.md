# 架构与安全

本文档说明 `yifangyun-mcp-server` 的架构设计、认证流程、权限边界、安全策略和已知限制。

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
  |     |-- 校验 URL、ID、策略
  |
  |-- src/client.ts
  |     |-- 生成 JWT assertion
  |     |-- 换取 enterprise/user token
  |     |-- token 缓存和提前刷新
  |     |-- HTTP 请求、超时、错误归一化
  |
  |-- src/tools/registerTools.ts
        |-- 注册 11 个只读 MCP 工具
        |-- 裁剪输出字段
        |-- 标注 readOnlyHint
```

核心原则：MCP 工具层只负责表达“智能体可用能力”，认证、HTTP 请求、错误处理和脱敏全部下沉到统一客户端。

## 认证流程

亿方云企业 JWT 模式流程：

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
access_token
```

assertion payload 结构：

```json
{
  "yifangyun_sub_type": "user",
  "sub": 530,
  "exp": 1710000060,
  "iat": 1710000000,
  "jti": "随机唯一值"
}
```

| 字段 | 说明 |
|---|---|
| `yifangyun_sub_type` | `enterprise` 或 `user` |
| `sub` | 企业 ID 或用户 ID |
| `exp` | assertion 过期时间，当前实现为 60 秒后 |
| `iat` | 签发时间 |
| `jti` | 随机唯一值，降低重放风险 |

## Token 缓存

服务按以下维度缓存 token：

```text
enterprise:<enterprise_id>
user:<user_id>
```

如果 token 未到提前刷新窗口，直接复用缓存。提前刷新窗口由 `YFY_TOKEN_REFRESH_SKEW_SECONDS` 控制，默认 300 秒。

## 权限边界

企业 token 和用户 token 不能混用。

| 能力 | Token | 原因 |
|---|---|---|
| 部门详情 | 企业 token | 组织管理平面 |
| 子部门 | 企业 token | 组织管理平面 |
| 部门成员 | 企业 token | 组织管理平面 |
| 个人空间 | 用户 token | 云盘访问平面 |
| 部门文件夹 | 用户 token | 部门文件可见性取决于用户权限 |
| 文件搜索 | 用户 token | 搜索结果取决于用户可访问范围 |
| 文件详情 | 用户 token | 文件可见性取决于用户权限 |
| 下载链接 | 用户 token | 下载权限取决于用户权限 |

管理员账号只是一个拥有更大云盘权限的用户账号，不等同于企业 token。

## 输出裁剪策略

亿方云接口可能返回大量字段，例如邮箱、手机号、文件路径、协作者、权限对象、下载 URL。MCP 默认裁剪为智能体任务常用字段。

文件/文件夹默认返回：

```json
{
  "id": 501000715605,
  "name": "投标公共资料库",
  "type": "folder",
  "size": 50969339596,
  "modified_at": 1780391287,
  "parent_folder_id": 501000000000
}
```

部门默认返回：

```json
{
  "id": 480,
  "name": "投标",
  "parent_id": 478,
  "director": {
    "id": 623,
    "name": "负责人姓名",
    "login": "login@example.com"
  }
}
```

部门成员默认不返回邮箱和手机号。只有 `yfy_list_department_users` 显式传 `include_contact=true` 时才会尝试返回联系字段。

## 错误处理

服务将亿方云错误归一化为：

```json
{
  "ok": false,
  "error": {
    "message": "Permission denied. Use a user_id that has access to the requested cloud-drive resource.",
    "retryable": false,
    "status_code": 403
  }
}
```

错误信息会尽量给出下一步建议，例如检查凭证、切换 `user_id`、确认文件 ID。

## 脱敏策略

服务会对以下内容进行脱敏：

```text
Bearer token
access_token
refresh_token
client_secret
download_url 字段中的敏感值
URL 中 sign/token/access_token/authorization 参数
```

注意：`yfy_get_download_url` 的业务目标就是返回下载 URL，因此它会把下载链接返回给 MCP 调用方；但服务不会主动打印到日志，也不会下载文件内容。

## 为什么第一版只读

MCP 工具可能被智能体自动组合调用。如果第一版开放上传、移动、删除等写操作，会带来三个问题：

| 风险 | 说明 |
|---|---|
| 数据破坏 | 删除、移动、重命名可能影响真实生产云盘 |
| 权限扩散 | 协作管理可能改变文件可见范围 |
| 审计困难 | Agent 多步调用时不容易追踪业务意图 |

因此第一版只做只读访问。后续如果要开放写操作，建议增加：

```text
YFY_ALLOW_WRITE_TOOLS=disabled
二次确认参数 confirm=true
操作审计日志
危险操作工具单独命名
```

## 性能和复杂度

| 操作 | 时间复杂度 | 空间复杂度 |
|---|---|---|
| 获取详情 | O(1) | O(1) |
| 获取下载链接 | O(1) | O(1) |
| 单页列表 | O(k) | O(k) |
| 搜索 | O(k)，检索由亿方云服务端承担 | O(k) |

`k` 是当前页返回条数。第一版不做递归扫描，因此不会一次性加载整个部门目录树。

## 已知限制

| 限制 | 说明 |
|---|---|
| stdio only | 当前只实现本地 stdio transport，没有远程 HTTP transport |
| 无递归扫描 | 目录遍历需要客户端多次调用 `yfy_list_folder_children` |
| 无写工具 | 不支持上传、移动、删除等状态变更操作 |
| 下载 URL 敏感 | 调用方拿到 URL 后需要自行控制保密和有效期 |
| 依赖亿方云权限 | MCP 无法绕过亿方云用户权限，默认用户无权时需要换 `user_id` |

## 后续演进建议

| 能力 | 建议 |
|---|---|
| 递归列目录 | 增加 `max_depth`、`max_items`、超时和截断提示 |
| Streamable HTTP | 支持远程部署、多客户端共享 |
| 审计日志 | 记录工具名、用户 ID、资源 ID、耗时，不记录 token 和下载 URL |
| 写操作 | 单独版本开放，并默认关闭 |
| 细粒度字段选择 | 允许调用方选择返回字段，进一步降低上下文占用 |
