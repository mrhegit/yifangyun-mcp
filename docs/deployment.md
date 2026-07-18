# 部署指南

## 要求

- Node.js `>=24`
- 可写的 SQLite 和临时文件目录
- 亿方云 OAuth Client 凭据
- 至少一个可用 user ID

## 本地 stdio

```bash
npm ci
npm run build
node --env-file=.env dist/index.js
```

`npm start` 不会自动加载 `.env`，只继承调用进程已有的环境变量。生产部署应由 MCP 客户端、容器或进程管理器注入配置。全部变量和模式选择见 [配置指南](configuration.md)。

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "npx",
      "args": ["-y", "yifangyun-mcp-server@1.0.0-beta.9"],
      "env": {
        "YFY_CLIENT_ID": "...",
        "YFY_CLIENT_SECRET": "...",
        "YFY_ENTERPRISE_ID": "115",
        "YFY_DEFAULT_USER_ID": "530",
        "YFY_TOOLSETS": "drive",
        "YFY_WORKFLOW_PROFILES": "",
        "YFY_WORKSPACES_JSON": "[]"
      }
    }
  }
}
```

此示例是普通 Drive 模式。要使用 Workspace、Inventory 或 Capture，需要增加对应 toolset 和 `YFY_WORKSPACES_JSON`；Tender Prompt 还要求 `YFY_WORKFLOW_PROFILES=tender`。

`yfy_status.runtime.configuration_source=process_environment` 表示当前进程环境是唯一生效配置。项目目录中的 `.env` 只有在启动命令或 MCP Host 显式加载时才有效；排查 capability 漂移时以 `yfy_status` 为准。

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
YFY_INVENTORY_CONCURRENCY=2
```

备份 SQLite 时同时考虑 WAL 文件，推荐使用 SQLite backup API 或在服务停止后复制。
同一个 `YFY_STATE_DB` 只允许一个 MCP 进程打开；需要水平扩展时必须使用独立数据库 adapter，不能让多个实例共享该 SQLite 文件。
不要把 `YFY_STATE_DB` 放在 `YFY_TEMP_DIR/artifacts` 下，该目录属于 Evidence TTL 和配额清理范围。

beta.9 仍使用 SQLite schema 5（与 beta.8 状态库兼容），并引入 contract_version=4 的工具输入/输出破坏性变更（见 `docs/migration-v1.md`）。从 0.4.0、beta.7 或更早 beta 升级状态库时：先停止旧进程，把 `YFY_STATE_DB` 指向新的空文件路径。旧数据库及 `-wal`、`-shm`、进程锁文件应保留到功能验证完成；确认不回滚后再清理。

大型目录可逐步提高 `YFY_INVENTORY_CONCURRENCY`。默认 2 路适合多数租户；提高到 4-8 前应观察 429、Provider 延迟和前台 Drive/Capture 请求等待时间。

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

生产环境应采集结构化 stderr 日志，并对 Provider 失败、inventory incomplete 和 capture drift 设置告警。

## 发布包验证

```bash
npm run check
npm pack --dry-run
```

生产包只包含 `dist`、README、LICENSE、docs 和 `.env.example`；内部 evaluations 不进入 npm 包。

## 发布流程

仓库的 `.github/workflows/publish.yml` 只在推送 `v*` tag 时运行。发布前要求工作区干净，并确保 tag 去掉前缀 `v` 后与 `package.json.version` 完全一致：

```bash
git tag -a v1.0.0-beta.9 -m "发布 1.0.0-beta.9"
git push origin HEAD
git push origin v1.0.0-beta.9
```

Action 会依次执行 `npm ci`、build、单元/集成测试、Inventory 性能测试和 `npm pack --dry-run`。预发布版本以 npm dist-tag `next` 发布，并创建 GitHub prerelease；正式版本使用 `latest`。npm publish 使用 Trusted Publishing provenance 和仓库配置的 `NPM_TOKEN`，本地不直接运行 `npm publish`。
