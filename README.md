# yifangyun-mcp-server

亿方云 OpenAPI 的通用 Cloud Authority 与 Evidence MCP Server，针对投标资料查找、完整性判断、范围证明和原件固化进行了重点优化，同时可复用于法务、采购、审计、合规和档案业务。

当前版本：`1.0.0-beta.3`。

## 1.0 设计

- Agent 使用 `access_context`，不再向每个工具传递裸 `user_id`
- 业务使用命名 `scope`，不再反复传递 Authority Root ID
- 默认只暴露高频只读工具，其他能力通过 toolset 开启
- 官方索引搜索只用于候选发现，不能证明资料不存在
- 大目录扫描由后台 Snapshot Module 有界并发抓取、确定顺序提交、自动 checkpoint 和恢复
- Snapshot 状态和索引存储在 SQLite，不再依赖 JSON 页面目录
- Evidence 工具统一完成版本选择、范围证明、下载、SHA-1/SHA-256 和漂移复核
- Evidence 在资源大小上限内返回短期 `yfy://evidence/...` resource link，远程 HTTP Agent 不依赖服务器本地路径
- 工具成功结果直接返回领域数据，不再使用 `ok/request_succeeded/outcome` envelope
- 不暴露 Provider raw response
- stdio 和 Streamable HTTP 共享同一个 Runtime、缓存和 snapshot repository

## 先选择使用方式

| 需求 | 推荐配置 | 结果 |
|---|---|---|
| 只浏览和搜索云盘 | `YFY_TOOLSETS=core` | 不下载、不扫描、不修改云端内容 |
| 搜索并下载校验文件 | `YFY_TOOLSETS=core,evidence` | 增加当前/历史版本下载、SHA-1/SHA-256 和验证 |
| 做范围证明和完整性判断 | `YFY_TOOLSETS=core,authority,snapshot,evidence`，并配置 Scope | 增加 Scope 断言、SQLite Snapshot 和 Current Lock |
| 使用投标专用 Prompt | 五个默认 Toolset、至少一个 Scope、`YFY_WORKFLOW_PROFILES=tender` | 增加投标审计、原件固化和版本比较工作流模板 |
| 修改云端内容 | 显式增加 `mutation`、`collaboration` 或 `admin` | 开启云端写能力，应隔离部署并限制 Agent 权限 |

需要区分三个概念：

- Toolset 决定注册哪些工具。
- Authority Scope 决定权威工作流允许在哪个目录和身份范围内运行。
- Workflow Profile 只注册专用 Prompt 和 Guidance，不授予新的亿方云权限。

Scope 只约束 Authority、Snapshot 和 Current Lock 等 Scope-bound 流程，不会自动限制所有 Core 读取工具。需要目录边界时必须显式使用 Scope 相关工具。

完整选项、默认值和配置示例见 [配置指南](docs/configuration.md)。

## 默认工具

| 工具 | 用途 |
|---|---|
| `yfy_connection_check` | 验证企业和用户认证 |
| `yfy_context_get` | 查看 access context、scope、toolset 和 workflow profile |
| `yfy_item_get` | 获取文件、文件版本或文件夹稳定元数据 |
| `yfy_items_get` | 批量读取文件元数据 |
| `yfy_folder_list` | 分页列出直接子项 |
| `yfy_root_list` | 枚举个人、协作、部门、文件夹或 scope 根 |
| `yfy_item_search` | 官方索引候选发现 |
| `yfy_path_resolve` | 按精确路径逐层解析 |
| `yfy_authority_validate` | 验证命名 Authority Scope |
| `yfy_scope_check` | 查询或断言文件范围 |
| `yfy_snapshot_create` | 创建后台可恢复快照 |
| `yfy_snapshot_get` | 查询快照状态和完整性 |
| `yfy_snapshot_query` | 查询 SQLite 快照索引 |
| `yfy_snapshot_cancel` | 取消快照 |
| `yfy_evidence_download` | 按当前版或历史代数下载并校验证据 |
| `yfy_evidence_lock_current` | 在 Authority Scope 内锁定当前原件 |
| `yfy_evidence_verify` | 验证元数据或内容证据 |
| `yfy_evidence_release` | 释放本地短期证据资源 |

## Toolsets

```env
YFY_TOOLSETS=core,authority,snapshot,evidence,organization
```

可选值：

| Toolset | 能力 |
|---|---|
| `core` | 文件、目录、搜索、路径、版本、评论、分享 |
| `authority` | 命名 scope 验证和范围证明 |
| `snapshot` | SQLite 后台快照 |
| `evidence` | 下载、哈希、漂移检测 |
| `organization` | 部门、用户和群组读取 |
| `collaboration` | 协作查询和变更 |
| `mutation` | 创建、更新、移动、复制、删除、上传 |
| `admin` | 部门、群组、用户、日志和平台治理 |
| `transfer` | 敏感的短时下载 URL |

## Access Context

默认 context 使用 `YFY_DEFAULT_USER_ID`。其他身份通过 JSON 配置：

```env
YFY_ACCESS_CONTEXTS_JSON=[{"id":"reviewer","user_id":"530","external_enterprise_id":"9"}]
YFY_DEFAULT_ACCESS_CONTEXT=default
```

工具只接收 `access_context="reviewer"`，不会在每次调用中传播裸身份信息。

## Authority Scope

```env
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender","public-material"]}]
```

投标资料工作流使用 `scope_id="tender_public"`。同一套工具也可定义合同库、供应商库或审计底稿 scope。

## 投标工作流

### 完整性检查

1. `yfy_authority_validate`
2. `yfy_snapshot_create`
3. 轮询 `yfy_snapshot_get`
4. `yfy_snapshot_query`
5. 只有 `safe_to_claim_absence=true` 时才能声明资料在已观察范围内不存在

### 原件固化

1. `yfy_path_resolve` 或 `yfy_item_search`
2. `yfy_scope_check(mode="assert")`
3. `yfy_evidence_lock_current`
4. 保存 file ID、path proof、`provider_download_version`、SHA-256、size 和 observation time

## 最小配置

```env
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_SCOPES_JSON=[]
YFY_WORKFLOW_PROFILES=
```

这是通用模式。默认 Toolset 为 `core,authority,snapshot,evidence,organization`，但没有 Scope 时不能创建 Authority Snapshot 或执行 Current Lock。

启用投标专用工作流：

```env
YFY_TOOLSETS=core,organization,authority,snapshot,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_SCOPES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender","public-material"]}]
```

Scope 不会授予云盘权限，只会把 Authority、Snapshot 和 Current Lock 等 Scope-bound 流程限制在指定业务目录。

## 运行

```bash
npm ci
npm run build
node --env-file=.env dist/index.js
```

`npm start` 也可以启动服务，但只继承当前进程环境，不会自动读取 `.env`。MCP 客户端部署通常直接在服务器配置的 `env` 中传入变量。

要求 Node.js `>=24`，因为 Snapshot Module 依赖内置 `node:sqlite` 的 FTS5 能力和稳定性能。

## HTTP

```env
YFY_TRANSPORT=http
YFY_HTTP_HOST=127.0.0.1
YFY_HTTP_PORT=3000
YFY_HTTP_BEARER_TOKEN=replace-with-a-long-random-token
```

端点：`POST /mcp`、`GET /health`、`GET /metrics`。

非回环监听必须同时配置 Bearer、Host 白名单和 Origin 白名单。

## 开发验证

```bash
npm run build
npm test
npm run test:perf
npm run check
npm pack --dry-run
```

生产构建输出到 `dist`，测试构建输出到 `dist-test`。npm 包不再包含测试文件和 source map。

## 文档

- [配置指南：模式、Toolset、Context、Scope、Profile 和全部环境变量](docs/configuration.md)
- [工具](docs/tools.md)
- [架构与安全](docs/architecture-security.md)
- [部署](docs/deployment.md)
- [OpenAPI 覆盖](docs/openapi-coverage.md)
- [1.0 迁移说明](docs/migration-v1.md)
