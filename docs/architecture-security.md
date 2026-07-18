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

identity ref 用于 ItemRef、Inventory 访问隔离和本地 content 目录命名，不包含原始凭据。ItemRef 将 Provider ID 与 access context/identity ref 绑定；VersionRef 再绑定完整 FileRef，防止调用方把同一个数字 ID 或版本 ID 跨身份、跨文件复用。

WorkspaceRef 只表达命名业务边界；Inventory 分别持久化配置 Workspace root 和实际 scan root，fingerprint 同时绑定 Workspace ID、两级 root、access context 和 identity ref。读取 Inventory、manifest 或 receipt 时都会与当前 Workspace 配置复核；配置绑定变化后返回 `YFY_INVENTORY_STALE`，旧观察不会被重解释到新边界。

当前 HTTP 部署仍是单配置主体模型：一个 MCP Server 进程使用一套企业凭据和静态 context 注册表。它不是面向不可信多租户的 OAuth delegation server。

## Inventory

内部 SnapshotService 在后台自动推进 Provider 分页，外部只暴露 Inventory Interface。Agent 不管理 CAS、Provider page 或内部 frontier；可观察的 `control_revision` 只用于诊断状态变化，查询一致性由 `commit_watermark` 提供。

SQLite 表：

- `snapshots`
- `snapshot_pages`
- `snapshot_items`
- `snapshot_frontier`
- `snapshot_items_fts`
- `snapshot_items_fts_map`
- `snapshot_storage`

SQLite 启用 WAL、外键、事务、incremental auto-vacuum 和 busy timeout。`snapshot_items` 直接保存 item digest、commit sequence、原始/规范化 name/path 和稳定排序键，同时承担全局判重；不再维护重复的 `snapshot_seen_items` 或整页 artifact JSON。`snapshot_frontier` 将 FIFO cursor 独立持久化，避免宽树每页重写完整 state JSON；`snapshot_items_fts` 与映射表为 trigram 子串搜索提供索引；`snapshot_storage` 记录逻辑占用，运行时另统计数据库和 WAL 物理字节。状态明确区分 `workspaceRootFolderId` 与 `rootFolderId`（scan root）。

每个 Provider page receipt、item 索引、frontier 变化和 state checkpoint 在同一事务中提交。提交时递增 `commit_watermark`，查询只读取 `commit_seq <= watermark` 的 item。cursor 保存首次查询水位、查询规格哈希、Workspace fingerprint 和签名，所以后台扫描继续提交时，已开始的分页仍保持稳定；新的 first request 才观察更新后的水位。可选 `root_folder` 将扫描根限制为 Workspace 内已验证子树；create/get/search/manifest 使用同一范围投影，摘要暴露 `scan_root`、`agent_guidance` 与运行中 `suggested_wait_ms`。普通和 Inventory cursor 错误只在 `error.diagnostics.reason` 返回稳定枚举，不回传解码碎片。

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

`safe_to_claim_absence` 只适用于 observation window 内、当前 Workspace identity、调用 limits 和 access context 可访问并完成分页的范围。达到深度/数量限制、分页不可靠、权限变化、取消或失败都会使其为 false。

manifest 只保存观察摘要和 digest，不内联无界 receipt。receipt 通过独立分页 Resource 读取。`yfy_inventory_release` 使用级联删除回收一个 Inventory，并立即使其 Ref、cursor、manifest 和 receipt URI 失效；TTL 清理负责未显式释放的终态数据。

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
- MIME 嗅探；PDF/PNG/JPEG 等明确 magic 可覆盖错误通用类型，ZIP 容器会保留 DOCX/XLSX/PPTX 等更具体的 Office MIME
- TTL 清理
- drift 时删除候选文件

成功 Open/Capture 注册随机、短期 `yfy://evidence/{token}` Resource，并在 Agent 结果中置顶 `must_release` 与严格判别联合 `content_delivery`。不超过 32 KiB 的可预览 UTF-8 内容由 Evidence Registry 复核普通文件、大小和 SHA-256 后，同时作为 MCP embedded resource 与 `preview_text` 返回；`include_text_preview=false` 可禁止内嵌。其他内容使用 resource link 或 multipart manifest。服务只声明协议结果是否嵌入，不声称 Host 一定将内容注入模型；resource link 也不保证自动读取。每个 part 读取时流式复核整文件 SHA-256。stdio 和 HTTP 都不返回本地路径。工具输出在交给 MCP SDK 前执行严格 schema 校验；handler 成功后若输出校验或文本序列化失败，也会回滚已注册 Resource。expectation mismatch、drift 或内容选择失败同样删除候选文件。

`transfer` toolset 是唯一直接返回 Provider 下载 URL 的接口；**不进入 Tender Profile 默认矩阵**（`drive,workspace,inventory,evidence`），仅在显式启用时注册。普通内容读取优先 `yfy_open` / `yfy_capture`。

Workspace membership 使用 `inside/outside/unavailable`，并附带 `agent_interpretation`（是否可声称 inside/outside、是否可 capture、narrative 与 next_steps），避免把缺少或截断的祖先元数据误判为越界。路径命中配置 root 且不与 storage space 证据冲突时可证明 inside；规范化后的 `space.id/type` 明确不同且不冲突时可证明 outside；路径与 space 互相矛盾时返回 `unavailable/conflicting_membership_evidence`。成员关系校验同时观察文件与 Workspace root 元数据。Workspace validation 的单项检查为 `pass/fail/unavailable`，顶层 verdict 为 `valid/invalid/unavailable`；只有明确证据才能产生 fail，取消、认证、限流和系统性 Provider 错误不会被吞成成功结果。

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
