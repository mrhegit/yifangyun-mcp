# 从 0.4.0 迁移到 1.0.0-beta.10

`1.0.0-beta.10` 是 1.0 正式版前的最后一个 beta。无需安装任何中间 beta；从 `0.4.0` 直接切换服务、工具目录、配置、Ref、cursor 和本地状态。

这是破坏性升级。不要把 `0.4.0` 的文件型 scan 状态当作新版 Inventory 数据库，不要复用旧 Prompt 参数模板、分页 cursor 或数字 ID。

## 升级前准备

1. 停止 `0.4.0` 服务，确认没有进程写入旧 `YFY_SCAN_DIR`。
2. 备份旧 scan 目录，保留到新版本验证完成；新版不会自动迁移或删除它。
3. 为 beta.10 配置新的空 `YFY_STATE_DB`，不要放在旧 scan 目录或 Evidence artifacts 目录内。
4. 更新 MCP Host 配置并固定版本：`yifangyun-mcp-server@1.0.0-beta.10`。
5. 删除 Host 缓存的旧 tools/list、Prompt 参数模板、Ref 和 cursor。

## 工具映射

| 0.4.0 | beta.10 |
|---|---|
| `yfy_connection_check`、`yfy_context_get` | `yfy_status` |
| `yfy_root_list`、`yfy_folder_list` | `yfy_browse` |
| `yfy_item_search` | `yfy_search` |
| `yfy_path_resolve` | `yfy_resolve` |
| `yfy_item_get`、`yfy_items_get` | `yfy_get`、`yfy_get_many` |
| `yfy_file_versions`、`yfy_file_comments` | `yfy_versions`、`yfy_comments` |
| `yfy_share_list` | `yfy_shares` |
| `yfy_authority_validate`、`yfy_scope_check` | `yfy_workspace_validate`、`yfy_membership_check` |
| `yfy_snapshot_*` | `yfy_inventory_create/get/search/cancel/release` |
| `yfy_evidence_capture/release` | `yfy_capture`、`yfy_resource_release` |
| 旧 department/group 聚合工具 | 明确的 Organization 或 Admin 工具 |

`yfy_open` 是普通读取入口，不要求 Workspace。`yfy_capture` 用于需要 Workspace membership、版本和下载稳定性证明的原件固化。

## 配置迁移

旧名称映射：

```text
core       -> drive
authority  -> workspace
snapshot   -> inventory

YFY_SCOPES_JSON          -> YFY_WORKSPACES_JSON
YFY_SNAPSHOT_CONCURRENCY -> YFY_INVENTORY_CONCURRENCY
YFY_SNAPSHOT_TTL_SECONDS -> YFY_INVENTORY_TTL_SECONDS
```

Tender Profile 示例：

```env
YFY_TOOLSETS=drive,workspace,inventory,evidence
YFY_WORKFLOW_PROFILES=tender
YFY_WORKSPACES_JSON=[{"id":"tender_public","root_folder_id":"501","access_context":"default","tags":["tender"]}]
YFY_INVENTORY_CONCURRENCY=2
YFY_INVENTORY_TTL_SECONDS=604800
YFY_STATE_DB=/var/lib/yifangyun-mcp/state.sqlite
```

默认只启用 `drive`。Tender 要求 `drive,workspace,inventory,evidence` 和至少一个 Workspace。`transfer` 仅供明确需要短时 Provider URL 的特殊集成，不是普通读取或证据路径。

服务只读取进程环境，不自动加载 `.env`。本地启动可使用 `node --env-file=.env dist/index.js`。

## Ref 与分页

数字文件/目录 ID 和旧短 Ref 全部失效。Ref 必须从当前服务结果原样复制：

```text
workspace:tender_public
file:501@default.aaaaaaaaaaaaaaaaaaaaaaaa
folder:502@default.aaaaaaaaaaaaaaaaaaaaaaaa
version:7001@ZmlsZTo1MDFAZGVmYXVsdC5hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh
inventory:123e4567-e89b-12d3-a456-426614174000@default.a1b2c3d4e5f6789012345678
```

- Workspace 参数必须传 `workspace:<id>`，不能传裸 ID。
- ItemRef 绑定 Access Context 和身份指纹；配置变化后重新发现。
- 当前版本调用 open/capture 时省略 `version`；历史版本复制 `yfy_versions` 返回的 VersionRef。
- Inventory Ref 是稳定 MAC 句柄，同一 Inventory 在 create/get/search 间字符串一致；`inventory_id` 不能作为输入。

分页首次调用直接传业务字段。续页只执行返回的 `next_action`：

```json
{"cursor":"..."}
```

带固定字段的续页可能为：

```json
{"inventory":"inventory:<uuid>@default.<mac24>","cursor":"..."}
```

不要解析 cursor，也不要与首次页字段混用。混参返回 `YFY_INPUT_INVALID`，并在 `error.diagnostics.reason` 标记 `pagination_mixed_args`。升级时丢弃所有已保存 cursor，并从首次页重新开始。

## 语义变化

- Search 是非穷尽 Provider 索引，空结果不能证明不存在。
- `claim_allowed=true` 只支持查询匹配，依赖当前存在性时仍调用 `yfy_get`。
- Content 命中永远不可 claim；同名或跨页候选按 `selection_policy` 消歧。
- 缺失结论只能来自终态 Inventory，且 `agent_guidance.may_claim_absence=true`。
- Workspace validation 使用 `valid/invalid/unavailable`；Membership 使用 `inside/outside/unavailable`。`unavailable` 不能解释为 outside。
- `yfy_open` / `yfy_capture` 返回 `structuredContent` 和兼容文本结果；提供 output schema 的结果由服务端严格校验。
- 小型 UTF-8 内容可内嵌为 MCP Resource；Resource Link 不保证 Host 自动读取。
- 当前服务不提供 PDF/Office 正文解析或 OCR。二进制成功不等于模型已读正文。
- open/capture 返回 `next_action=yfy_resource_release`；使用后执行，重复释放安全。

## 验证清单

1. `yfy_status` 返回 `server.version=1.0.0-beta.10` 和预期 capabilities。
2. Host 的 tools/list 显示严格 object + `anyOf` 分页输入，以及 output schema 和 annotations。
3. Browse/Search 首次调用成功，原样执行 `next_action` 可续页；混参返回 `pagination_mixed_args`。
4. 旧 cursor、数字 ID、旧短 Ref 和旧 Inventory Ref 被拒绝。
5. Inventory create/get/search 返回相同 `inventory` 字符串；相同 secret 重启后仍可访问，更换 secret 后被拒绝。
6. 旧 Inventory cursor 被拒绝，当前 cursor 可稳定续页。
7. complete/partial 空搜语义正确；仅在 `may_claim_absence=true` 时报告缺失。
8. 文本和二进制 open/capture 正确报告 `agent_readable`，Resource 使用后可幂等释放。
9. Transfer URL 不进入 text content 或日志。
10. 运行 `npm run check` 和 `npm pack --dry-run`。

## 回滚

回滚必须整体切换服务版本、Host 工具目录、Prompt、Ref/cursor 保存和状态路径。`0.4.0` 继续使用备份的 scan 目录，beta.10 使用独立 SQLite；不要让同一客户端模板同时兼容两套工具契约。
