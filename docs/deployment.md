# 部署指南

## 要求

- Node.js `>=22.13`
- 可写的 SQLite 和临时文件目录
- 亿方云 OAuth Client 凭据
- 至少一个可用 user ID

## 本地 stdio

```bash
npm ci
npm run build
npm start
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "npx",
      "args": ["-y", "yifangyun-mcp-server@1.0.0-beta.1"],
      "env": {
        "YFY_CLIENT_ID": "...",
        "YFY_CLIENT_SECRET": "...",
        "YFY_ENTERPRISE_ID": "115",
        "YFY_DEFAULT_USER_ID": "530",
        "YFY_SCOPES_JSON": "[]"
      }
    }
  }
}
```

## HTTP

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=long-random-token
```

反向代理或非回环监听必须配置：

```env
YFY_HTTP_ALLOWED_HOSTS=mcp.example.com
YFY_HTTP_ALLOWED_ORIGINS=https://agent.example.com
```

建议反向代理限制请求体大小、连接数和请求速率。

## 持久化

设置固定路径：

```env
YFY_STATE_DB=/var/lib/yifangyun-mcp/state.sqlite
YFY_TEMP_DIR=/var/lib/yifangyun-mcp/temp
YFY_SNAPSHOT_CONCURRENCY=2
```

备份 SQLite 时同时考虑 WAL 文件，推荐使用 SQLite backup API 或在服务停止后复制。
同一个 `YFY_STATE_DB` 只允许一个 MCP 进程打开；需要水平扩展时必须使用独立数据库 adapter，不能让多个实例共享该 SQLite 文件。
不要把 `YFY_STATE_DB` 放在 `YFY_TEMP_DIR/artifacts` 下，该目录属于 Evidence TTL 和配额清理范围。

大型目录优先使用 Provider 允许的最大 `page_capacity`，再逐步提高 `YFY_SNAPSHOT_CONCURRENCY`。默认 2 路适合多数租户；提高到 4-8 前应观察 429、Provider 延迟和前台 Authority/Evidence 请求等待时间。

## 权限

运行用户只需要：

- 读取配置和凭据
- 读写 SQLite 目录
- 读写 temp 目录
- 访问配置的 Provider HTTPS 地址

不要使用管理员 OS 账户运行。

## 健康与指标

- `/health`：进程和版本
- `/metrics`：进程内计数和延迟聚合

生产环境应采集结构化 stderr 日志，并对 Provider 失败、snapshot incomplete 和 evidence drift 设置告警。

## 发布包验证

```bash
npm run check
npm pack --dry-run
```

生产包只包含 `dist`、README、LICENSE、docs 和 `.env.example`；内部 evaluations 不进入 npm 包。
