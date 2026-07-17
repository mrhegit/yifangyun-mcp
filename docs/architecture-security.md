# 架构与安全

## Runtime

```text
MCP Transport
  -> Tool Catalog
    -> Drive / Workspace / Inventory / Evidence / Organization
    -> Optional Collaboration / Mutation / Admin / Transfer
      -> AppRuntime
        -> AccessRegistry
        -> YifangyunGateway
          -> YifangyunClient
        -> SnapshotService
          -> ScopeScanEngine
          -> SqliteScopeScanStore
```

`AppRuntime` 在进程启动时创建一次。stdio 和所有 HTTP 请求共享：

- OAuth token cache 和 singleflight
- Provider 并发调度器
- AccessRegistry
- SnapshotService 后台 worker
- SQLite connection
- metrics

MCP Server 和 HTTP transport 可以按请求创建，但不重新创建业务 Runtime。

## Interface 与 Provider Adapter

Tool Catalog 只暴露稳定领域模型。Provider 路径、参数、分页和字段差异集中在 Gateway、Client 和 projector 中。

不提供 raw response 开关。未知 Provider 字段不会自动泄漏到 Agent 上下文。

## 身份

`access_context` 是 Agent 接口。它解析为：

- user ID
- 可选 external enterprise ID
- HMAC identity ref

identity ref 用于 Inventory 访问隔离和本地 content 目录命名，不包含原始凭据。

当前 HTTP 部署仍是单配置主体模型：一个 MCP Server 进程使用一套企业凭据和静态 context 注册表。它不是面向不可信多租户的 OAuth delegation server。

## Inventory

内部 SnapshotService 在后台自动推进 Provider 分页，外部只暴露 Inventory Interface。Agent 不管理 revision、CAS、Provider page 或 checkpoint。

SQLite 表：

- `snapshots`
- `snapshot_pages`
- `snapshot_items`
- `snapshot_seen_items`
- `snapshot_frontier`
- `snapshot_items_fts`
- `snapshot_storage`

启用 WAL、外键、事务和 busy timeout。`snapshot_seen_items` 提供持久化全局判重；`snapshot_frontier` 将 FIFO cursor 独立持久化，避免宽树每页重写完整 state JSON；`snapshot_items_fts` 为 3 字符以上查询提供 trigram 子串索引；`snapshot_storage` 同时参考增量逻辑字节和 SQLite 活动页/WAL 大小。页面事务提交前会按序列化增量预留 FTS、索引和 WAL 写放大空间。每个 page receipt、item index、seen index、frontier 变更和 state checkpoint 在同一事务中提交。

Provider I/O 使用有界并发抓取。正式结果由单一提交器按 FIFO canonical order 串行提交；请求完成顺序不会改变截断点、重复项胜者或 receipt 顺序。状态和局部索引查询不等待慢 Provider 请求，取消会先传播 AbortSignal，再写入 durable 终态。

文件型 SQLite 使用同主机进程锁，第二个进程不能同时打开同一个 `YFY_STATE_DB`。

Inventory 可检测：

- 分页元数据缺失
- 空页面但还有下一页
- page loop
- 重复 ID 和元数据冲突
- 目录循环
- 深度或数量上限
- 权限变化
- Provider 错误
- 根目录观察漂移

`safe_to_claim_absence` 只适用于 observation window 内、当前 access context 可访问并完成分页的范围。

## Capture 与 Resource

Capture 工具默认不返回下载 URL。Provider URL 只在服务内部使用。

安全措施：

- HTTPS 校验
- DNS 解析后私网地址拦截
- idle 和 wall timeout
- 单文件和 temp 总配额
- 并发下载预留配额；缺少 `Content-Length` 时按单文件上限预留
- identity 隔离目录
- `0600/0700` 权限尝试
- SHA-1 和 SHA-256
- MIME 嗅探
- TTL 清理
- drift 时删除候选文件

成功 Capture 注册随机、短期 `yfy://evidence/{token}` Resource。小文件读取时复核大小与 SHA-256；大文件返回 manifest 和有界 part URI，每个 part 读取时流式复核整文件 SHA-256。stdio 和 HTTP 都不返回本地路径。工具输出在交给 MCP SDK 前执行严格 schema 校验，失败或 expectation mismatch 时回滚临时内容；`transfer` toolset 是唯一直接返回 Provider 下载 URL 的接口。

## HTTP

Streamable HTTP 使用内存型 stateful session transport，`POST`、SSE `GET`、session `DELETE` 和取消通知按 `mcp-session-id` 路由。非回环监听必须配置：

- Bearer Token
- Host 白名单
- Origin 白名单

Session 数量由 `YFY_HTTP_MAX_SESSIONS` 限制，无活动请求的 session 超过 `YFY_HTTP_SESSION_IDLE_SECONDS` 后自动关闭。

本地文件上传属于显式高权限能力，所有源路径必须位于 `YFY_UPLOAD_ROOT_DIR` 内，HTTP 和 stdio 结果均不回显服务器绝对源路径。

Bearer 使用 timing-safe compare。Express 禁用 `X-Powered-By`。进程处理 SIGINT/SIGTERM 时停止 HTTP 接受请求、等待 Inventory worker 结束并关闭 SQLite。

## Provider 请求

- GET/list：429/5xx jitter retry，支持 Retry-After
- POST：默认不重试
- OAuth：singleflight 和提前刷新
- 全局并发限制
- identity/endpoint bucket 并发限制
- AbortSignal 和 wall timeout
- 稳定 `YFY_*` 错误码

## 生产边界

SQLite 适合同一主机、单写入进程。多个 MCP 进程不得同时把同一个 SQLite 文件放在不支持文件锁的网络文件系统上。

需要真正多租户或跨区域水平扩展时，应实现独立的 PostgreSQL Inventory repository 和请求主体认证 adapter。
