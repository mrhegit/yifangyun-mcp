# 架构与安全

## 模块边界

```text
MCP Transport
  -> 工具注册 / Schema 校验 / 压缩文本
  -> Drive / Workspace / Inventory / Download / 可选写工具集
  -> Gateway：访问身份与 Ref 绑定
  -> Client：OAuth、Provider 请求、SSRF 防护、流式下载
  -> TempStorageManager + DownloadRegistry
  -> Provider OpenAPI
```

下载模块只交付**文件句柄**（路径或认证 URL），不解析正文。Host 解析器与 MCP Server 职责分离。

---

## MCP 契约

- 工具使用严格 Zod input / output schema。
- 成功：同时提供 `structuredContent` 与 text content。
- 失败：`isError=true`。

`yfy_download` 会改写本地临时环境，**不是** read-only。
`yfy_download_release` 会删除本地文件，标注为 destructive、idempotent、closed-world（`openWorldHint=false`）。

`local_path` 是**同机 stdio Host** 的部署约定，不是 MCP 标准文件 URI。
远程 HTTP Host 应使用受认证的 staged URL，避免误用服务器本机路径。

---

## Ref 与身份

ItemRef、VersionRef、InventoryRef、Cursor 均绑定 access context、身份指纹或配置指纹。
调用方只能复制服务返回的 Ref，不能自行构造。

Workspace **不**授予 Provider 新权限，只在已有权限上增加业务范围约束。
文件与 Workspace 必须属于同一访问身份。

---

## Provider 下载

Provider transfer URL **不**进入普通工具结果。Client 侧约束：

- 仅接受 HTTPS Provider URL
- 禁止 URL userinfo
- DNS 解析后拒绝私网、回环、保留地址与 IPv4-mapped 地址
- 每次 redirect 重新校验 URL；手工处理 redirect 并限制跳转次数
- 单文件上限、idle timeout（无进度超时）、wall timeout（总耗时上限）
- 流式计算 SHA-1、SHA-256 与大小；不把完整文件读入内存

仅当显式启用 `YFY_ALLOW_PRIVATE_TRANSFER_URLS` 时放宽地址限制。

---

## 临时存储

`TempStorageManager` 是 artifacts、downloads 与进行中**预留（reservation）**的唯一配额所有者。

典型流程：

1. 下载前预留空间
2. 流式写入 `artifacts/`
3. 成功后按实际字节 commit
4. Registry 将文件移到 `downloads/`（物理字节不重复计费）
5. manifest 元数据单独计费
6. **物理删除成功后**才释放 used bytes

配额不足只拒绝新请求，不驱逐仍在有效期内的旧下载。

---

## Registry 恢复

每个下载目录包含：随机 `download_id`、下载文件、原子写入的 `manifest.json`。

Manifest 记录：版本号、到期时间、文件名与媒体类型、SHA-1/SHA-256、大小、mtime、ctime、身份 Ref。

启动恢复会拒绝或删除：

- 缺失或格式错误的 manifest
- 过期记录
- 非普通文件或符号链接
- 大小 / mtime / ctime 不匹配
- download id 与目录不一致

恢复只读 manifest 与文件元数据，**不**重扫文件内容。
内容哈希在实际 HTTP 输出或 text preview 时单遍复核。
异常退出不会使下载目录永久脱离 TTL 与配额管理。

---

## staged HTTP 完整性

每次 GET：

1. 检查 download id、TTL、release 状态、剩余 fetch 次数
2. `lstat` 拒绝符号链接
3. 以 no-follow 方式打开文件句柄
4. 在同一句柄上检查普通文件、大小、mtime、ctime
5. 从该句柄单遍流式输出，同时计算 SHA-1 / SHA-256
6. 用 `pipeline` 处理客户端断开与流错误
7. 流结束时若哈希或大小不匹配，立即令该 download id 失效

该路径无“整文件二次缓冲 / 磁盘副本 / 预哈希再读”。额外内存保持在流式 chunk 级别。

安全边界依赖：服务账户独占的普通目录、no-follow 句柄、元数据快速校验。
若同一服务账户在流式输出期间恶意原地改写文件，最终哈希会使下载失效，但客户端可能已收到部分字节——这是为降低 I/O、内存与磁盘放大所做的取舍。

---

## 生命周期与租约（lease）

HTTP GET 会获取**活动读租约**。TTL 到期或 `yfy_download_release` 时：

1. 立即禁止新的本地 registry 查找与新的 HTTP GET
2. 已开始的读取可以完成
3. 最后一个租约结束后再物理删除

删除失败不会假成功，也不会提前扣减配额；调用方应在关闭本地解析器后重试。

---

## HTTP 安全

远程 HTTP 或远程 staged public base 必须配置：

- Bearer Token（timing-safe 比较）
- Host 白名单
- Origin 白名单
- HTTPS public base（非 localhost）

`/mcp` 与 `/staged/v1/...` 共用同一认证中间件。
关闭 staged delivery 时不注册 staged 路由：即使知道 `download_id` 也无法绕过配置。

Public base 不允许 userinfo、query 或 fragment。通配监听地址不能作为可广告 URL。

---

## 文本 preview

默认关闭。启用时仅处理同时满足：

- text-like MIME
- 完整文件不超过配置上限
- 无 NUL 字节
- 严格 UTF-8 解码成功

硬上限 1 MiB，避免 MCP 输出与模型上下文无界增长。
Office / PDF / OCR 始终由 Host 处理。

---

## Inventory

Inventory 在**专用 Worker 线程**内使用单连接 SQLite，保存：

- 已提交扫描进度（`commit_watermark`）
- 待扫队列（frontier）
- 条目（items）
- 分页回执（receipts）

同步事务、FTS 与维护不占用 MCP/HTTP 主事件循环。

**声明缺失**须同时满足：终态、完整分页、范围明确、`safe_to_claim_absence=true`（见 `yfy_inventory_*` 返回的 `completeness` / `agent_guidance`）。

约束：

- 同一状态库只允许一个进程持有
- 数据库、WAL、逻辑状态共同受 `YFY_MAX_STATE_BYTES` 限制
- Worker 发生 `error` / `exit` 后，活动与后续 RPC 立即失败；关闭流程不等待已不存在的 Worker 回包
- structured-clone 同步失败会在原请求内清除 pending 状态

临时存储启动恢复顺序：先计量现有目录 → Download Registry 删除过期/无效合法 download → 对仍有效文件做配额断言。
降低配额不会删除仍在 TTL 内的有效下载；恢复清理释放的过期空间不阻止服务启动。

Provider transfer 指标使用固定 endpoint 标签 `provider_transfer`；预签名 URL 的不透明路径不进入指标维度。

---

## 日志与敏感信息

日志与工具文本会脱敏：Bearer、Provider 签名 URL、transfer URL。
普通下载结果不含 Provider 原始 ticket。

`yfy_status` 不返回 Client Secret、Bearer、临时根路径或完整 public URL；只返回非敏感的交付能力与容量摘要。
