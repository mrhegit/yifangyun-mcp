# 测试指南

## 标准验证

```bash
npm run build
npm test
npm run test:perf
npm pack --dry-run --json
```

`npm test` 先编译到 `dist-test/`，再用 Node.js test runner 执行。
对接真实 Provider 的 Live 测试默认跳过，普通回归**不需要**凭据。

---

## 测试分层

| 范围 | 主要文件 | 覆盖目标 |
|---|---|---|
| Provider Client | `src/client.test.ts` | OAuth、重试、身份并发桶、transfer SSRF、流清理、指标标签、URL 序列化 |
| Download Registry | `src/downloads.test.ts` | manifest、配额、恢复、TTL、junction、lease、完整性、并发 |
| Worker SQLite | `src/workerStore.test.ts`、`src/snapshot.test.ts` | Worker 退出、pending RPC、clone 失败、start lock、活动扫描关闭、Inventory 行为 |
| MCP Tools | `src/tools.test.ts`、`src/tooling.test.ts` | schema、错误分类、下载 deadline、progress、版本、structuredContent |
| HTTP | `src/httpDownloads.test.ts` | Bearer、Host、Origin、staged 流、fetch 限制、活动中 release |
| Catalog / Config | `src/catalog.test.ts`、`src/config.test.ts` | 工具目录、annotations、配置矩阵、安全启动条件 |

---

## 性能测试

`npm run test:perf` 设置 `YFY_RUN_PERF_TESTS=1` 并跑 Inventory 性能场景。大规模场景使用与生产一致的 Worker Store，例如：

- 50,000 文件的 SQLite / FTS 建库与查询
- 2,000 宽目录 frontier（待扫队列）
- WAL、配额、过期清理

性能断言含 Windows 独立预算，避免把“同步 SQLite 主线程”误当成生产基准。

---

## Live 测试

须显式启用：

```env
YFY_LIVE_DOWNLOAD_TESTS=enabled
YFY_LIVE_MCP_TESTS=enabled
YFY_LIVE_READ_TESTS=enabled
# 可选扩展
YFY_LIVE_INVENTORY_TESTS=enabled
YFY_LIVE_HISTORY_TESTS=enabled
YFY_LIVE_ENV_PATH=<path-to-live-env>
YFY_LIVE_SEARCH_QUERY=<controlled-search-term>
YFY_LIVE_DOWNLOAD_FILE_ID=<controlled-file-id>
YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID=<workspace-root-folder-id>
YFY_LIVE_WORKSPACE_ROOT_FOLDER_ID=<workspace-root-folder-id>
```

运行前配置测试用 Enterprise、用户、Workspace 与受控文件。
`YFY_LIVE_MCP_TESTS` 会通过 MCP 协议验证单文件下载、Provider 批量 ZIP 和显式 release。
`YFY_LIVE_INVENTORY_TESTS` 是 `YFY_LIVE_READ_TESTS` 的可选分支，并要求 `YFY_LIVE_WORKSPACE_ROOT_FOLDER_ID`。
**不要**用生产敏感文件验证下载或写入。

---

## 关键回归路径

以下行为须保持测试覆盖：

| 场景 | 期望 |
|---|---|
| Worker 退出 | 拒绝活动与后续 RPC；`close()` 仍可完成 |
| structured-clone 失败 | pending Map 清零 |
| 过期下载清理 | 先清理过期，再按降低后的临时配额断言 |
| transfer 指标 | 不透明 ticket 不增加 metrics endpoint 基数 |
| 并发分桶 | 同身份跨路径共享并发；不同用户 / Enterprise / external enterprise 隔离 |
| 大 version id | 超过 `Number.MAX_SAFE_INTEGER` 时最终 URL 仍为精确十进制文本 |
| stream 重试 | 只用剩余 wall-time；取消不重试；progress 不倒退 |
| stream 失败 | 删除部分 artifact，不遗留未计费文件 |
| Registry 注册失败 | Registry 独占 artifact 清理；不重复扣减其他文件配额 |
| 批量 ZIP | 真实中央目录、空 ZIP、截断 ZIP、统一 deadline、4 路 Workspace 校验上限 |
| MCP 非法输入 | 缺字段、错误类型、未知字段均返回统一 `YFY_INPUT_INVALID` envelope |
| staged 慢客户端 | 读租约达到 wall timeout 后中止并释放并发槽 |

---

## 发布前检查

```bash
npx tsc -p tsconfig.build.json --noEmit --noUnusedLocals --noUnusedParameters
git diff --check
```

`git diff --check` 在 Windows 上可能只报告 LF/CRLF 提示；真正的 whitespace error 必须修复。
