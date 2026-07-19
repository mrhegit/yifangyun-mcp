# 部署指南

## 安装

```bash
npm install -g yifangyun-mcp-server@1.1.0-beta.1
```

或由 Host 固定版本运行：

```json
{
  "command": "npx",
  "args": ["-y", "yifangyun-mcp-server@1.1.0-beta.1"],
  "env": {
    "YFY_CLIENT_ID": "...",
    "YFY_CLIENT_SECRET": "...",
    "YFY_ENTERPRISE_ID": "115",
    "YFY_DEFAULT_USER_ID": "530",
    "YFY_TOOLSETS": "drive",
    "YFY_TRANSPORT": "stdio"
  }
}
```

---

## stdio（同机）

适合 Desktop / CLI Agent，Host 与 Server 同机：

```env
YFY_TRANSPORT=stdio
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=enabled
YFY_DOWNLOAD_STAGED_HTTP=disabled
```

Host 必须能访问 Server 返回的绝对路径。
容器化 stdio 时，Host 与 Server 需共享同一文件系统命名空间或 volume。

---

## 远程 HTTP

推荐架构：

```text
Remote MCP Host
  -> HTTPS reverse proxy
  -> yifangyun-mcp-server 127.0.0.1:3000
  -> Yifangyun OpenAPI
```

Server 配置示例：

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=disabled
YFY_DOWNLOAD_STAGED_HTTP=enabled
YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL=https://mcp.example.com
```

反向代理须转发：

```text
POST/GET/DELETE /mcp
GET /staged/v1/*
GET /health
GET /metrics
```

注意：

- **不要**重写 `Authorization`
- staged GET 与 MCP 使用相同 Bearer
- 代理超时应大于最大预期文件传输时间
- 若 public base 含前缀（如 `https://example.com/yfy-mcp`），须把 `/yfy-mcp/staged/v1/*` 映射到 Server 的 `/staged/v1/*`

---

## 临时目录与状态库

生产环境建议显式设置：

```env
YFY_TEMP_DIR=/var/lib/yifangyun-mcp/temp
YFY_STATE_DB=/var/lib/yifangyun-mcp/state/state.sqlite
YFY_MAX_TEMP_BYTES=1073741824
YFY_TEMP_FILE_TTL_SECONDS=86400
```

要求：

| 要求 | 说明 |
|---|---|
| 目录归属 | 运行用户独占 `YFY_TEMP_DIR/artifacts` 与 `downloads` |
| 状态库位置 | `YFY_STATE_DB` 不在上述两个目录内 |
| 文件系统 | 支持原子 rename |
| 监控 | 磁盘、inode、删除失败日志 |
| 多实例 | **不要**让多个实例共享同一 `YFY_TEMP_DIR` 或同一 SQLite |

正常关闭会释放当前下载；异常退出由下次启动根据 manifest 恢复或清理。

### Inventory SQLite

- 放在持久 volume
- 备份使用 SQLite backup API，或停服后同时处理数据库与 WAL
- 同一数据库只允许一个进程打开；水平扩展需独立状态后端，**不能**多实例直接共享该文件
- SQLite 由专用 Worker 线程持有；Worker 异常退出会使 Inventory RPC 立即失败——应视为实例故障并重启

---

## 容器建议

- 非 root 用户
- 只读根文件系统
- temp / state 使用独立可写 volume
- 明确 memory、CPU、磁盘与进程限制
- Client Secret 不写入镜像
- 健康检查：`GET /health`

HTTP staged 文件由 Node.js 流式输出，无需把整个文件载入容器内存。

---

## 监控

至少关注：

| 信号 | 说明 |
|---|---|
| Provider 401 / 403 / 429 / 5xx | 上游鉴权与可用性 |
| `YFY_LOCAL_STORAGE_INSUFFICIENT` | 临时盘配额不足 |
| `YFY_DOWNLOAD_CLEANUP_FAILED` | 删除失败（占用/权限） |
| `YFY_DOWNLOAD_INTEGRITY_FAILED` | 完整性校验失败 |
| staged 404 / 410、流中断 | 取文件链路问题 |
| Inventory partial / failed | 清单不完整 |
| Inventory Worker exit / error | 进程内 SQLite Worker 故障 |
| SQLite / WAL 体积 | 状态库膨胀 |
| `YFY_TEMP_DIR` 已用空间 | 磁盘压力 |

`yfy_status.temp_storage` 便于 Agent 侧排障；系统级磁盘指标仍应由宿主监控采集。

---

## 发布验证

```bash
npm ci
npm run build
npm test
npm run test:perf
npm pack --dry-run
```

发布前还应实际启动一次 HTTP transport，并对 staged 文件做真实 GET，不能只验证 URL 字符串是否生成。
