# yifangyun-mcp-server

亿方云 OpenAPI 的通用 MCP Server。默认提供轻量 Drive 平面；需要范围证明、完整性判断或原件固化时，可启用 Workspace、Inventory 和 Evidence 平面。

当前开发版本：`1.0.0-beta.6`。该版本收紧 Agent-facing 输出预算、路径、游标、错误和 Inventory manifest 契约；从 `0.4.0` 升级时按迁移文档整体切换。

## Interface

默认 `drive` toolset：

| 工具 | 用途 |
|---|---|
| `yfy_status` | 验证身份并列出可复制 PlaceRef |
| `yfy_browse` | 浏览个人盘、协作空间、部门、文件夹或 Workspace |
| `yfy_search` | Provider 索引候选发现，永远不证明不存在 |
| `yfy_resolve` | 按精确相对路径逐层解析 |
| `yfy_get` | 读取单个文件或文件夹元数据 |
| `yfy_get_many` | 批量读取最多 100 个 ItemRef |
| `yfy_versions` | 返回绑定文件身份的历史 VersionRef |
| `yfy_open` | 读取当前或历史内容，不要求 Workspace |
| `yfy_comments` | 分页读取文件评论 |
| `yfy_shares` | 分页读取脱敏分享元数据 |

高级平面：

| Toolset | 工具 |
|---|---|
| `workspace` | `yfy_workspace_validate`、`yfy_membership_check` |
| `inventory` | `yfy_inventory_create`、`yfy_inventory_get`、`yfy_inventory_search`、`yfy_inventory_cancel` |
| `evidence` | `yfy_capture` |
| `organization` | 明确的 department、user、group 工具，不使用 action union |

`yfy_resource_release` 是 Drive/Evidence 共享的 Resource 生命周期工具：启用任一平面时都会注册。

## 引用与分页

位置使用可复制字符串：

```text
personal
collaboration
department:480
folder:501000715605
workspace:tender_public
```

文件和版本引用：

```text
file:501
folder:502
version:501:7001
```

普通分页只暴露 `limit`、`cursor` 和 `next_action`。Provider 页码、实际 page capacity、过滤后的页内 offset 和签名细节都由服务端隐藏。

Drive 列表默认每页 10 条，Inventory 列表默认每页 25 条。`yfy_browse` 和 `yfy_search` 默认 `detail=basic`；需要 owner、space 等字段时显式请求 `standard` 或 `full`。

Provider 返回的路径明确投影为 `provider_path_chain` 和 `path_basis=provider_supplied`。Workspace 结果另返回基于配置根目录的相对祖先链，调用方不得比较不同 Provider endpoint 的原始路径数组来判断项目身份。

## 两个内容工具

- `yfy_open`：普通网盘内容读取，可读取当前版或 `yfy_versions` 返回的历史 VersionRef。
- `yfy_capture`：要求命名 Workspace，下载前后校验成员关系、版本历史和文件元数据，并返回三态 assurance 检查。

`expected` 是断言。任一字段不匹配时，`yfy_capture` 返回 `YFY_EXPECTATION_MISMATCH`，删除临时内容，不返回可用 Resource。

文本 Resource 返回 MCP `text`，二进制返回 `blob`。大文件返回 multipart manifest，调用方按 manifest 中的 part URI 分段读取；任何结果都不暴露服务器 `local_path`。二进制是否能直接呈现取决于 MCP 客户端附件能力，服务端不把成功下载等同于模型已读取正文。

## Inventory Freshness

`yfy_inventory_create.freshness`：

```json
{"max_age_seconds":300,"mode":"reuse_if_fresh"}
```

- `reuse_if_fresh`：只复用未超过调用方新鲜度要求的完整 Inventory，或加入仍在运行的等价 Inventory。
- `force_refresh`：始终创建新 Inventory。
- `partial`、`cancelled`、`failed`、`expired` 永不自动复用。
- 对终态调用 `yfy_inventory_cancel` 是真正 no-op，不改变状态、revision 或时间戳。

只有终态结果中 `safe_to_claim_absence=true` 时，才能在该 Workspace 和观察窗口内声明未找到。

Inventory 默认上限为 `max_item_depth=8`、`max_items=10000`。更大范围必须由调用方显式提高，避免普通查找误触发高成本递归扫描。

## Toolsets

默认配置只启用 Drive：

```env
YFY_TOOLSETS=drive
```

投标完整工作流：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501000715605","access_context":"default","tags":["tender"]}]
```

其他可选 toolset：`organization`、`collaboration`、`mutation`、`admin`、`transfer`。云端写工具不会默认注册。

## 最小配置

```env
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
YFY_TOOLSETS=drive
YFY_ACCESS_CONTEXTS_JSON=[]
YFY_WORKSPACES_JSON=[]
YFY_WORKFLOW_PROFILES=
```

Workspace 只收窄已有 Provider 权限，不授予新权限。普通 Drive 工具不自动受 Workspace 限制；需要范围保证时使用 Workspace/Inventory/Capture 工具。

## 典型流程

精确查找并读取：

1. `yfy_resolve({path,from})`
2. `yfy_open({file})`
3. 处理完 Resource 后调用 `yfy_resource_release`

完整性审计：

1. `yfy_workspace_validate`
2. `yfy_inventory_create`
3. 跟随 `next_action` 直到 `terminal=true`
4. 对每个材料类别调用 `yfy_inventory_search`
5. 仅在 `safe_to_claim_absence=true` 时声明缺失

原件固化：

1. `yfy_resolve` 或 `yfy_search`
2. 需要历史版时先调用 `yfy_versions`
3. `yfy_capture({workspace,file,version?,expected?})`
4. 记录 file/version ref、Workspace proof、SHA-256、size、观察时间和 Resource URI
5. `yfy_resource_release`

## 运行与验证

```bash
npm ci
npm run build
node --env-file=.env dist/index.js
```

要求 Node.js `>=24`。HTTP 端点为 `POST /mcp`、`GET /health`、`GET /metrics`。

```bash
npm run build
npm test
npm run test:perf
npm run check
npm pack --dry-run
```

## 文档

- [配置指南](docs/configuration.md)
- [工具参考](docs/tools.md)
- [架构与安全](docs/architecture-security.md)
- [部署](docs/deployment.md)
- [OpenAPI 覆盖](docs/openapi-coverage.md)
- [从 0.4.0 迁移到 1.0.0-beta.6](docs/migration-v1.md)
