# OpenAPI 覆盖矩阵

版本 `1.1.0-beta.3` **不是**“一个 HTTP endpoint 对应一个 MCP 工具”，而是把 Provider 差异收敛到 Drive、Workspace、Inventory、Download、Organization 等模块中。

共性约定：

- 工具使用绑定访问上下文的 Ref（context-bound Ref）
- 分页：首次用扁平业务字段，续页用 `cursor` / `next_action`
- **不包含**：PDF/Office 正文解析、OCR、Provider 知识库训练/召回

---

## Drive

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| personal / collaboration / department / folder / workspace 根 | `yfy_browse` | 已覆盖 |
| 文件夹 / 文件信息 | `yfy_get`、`yfy_get_many` | 已覆盖 |
| 索引搜索 | `yfy_search` | 已覆盖；**非穷尽**；返回字段级匹配依据 |
| 精确路径遍历 | `yfy_resolve` | 组合覆盖；同名返回 ambiguous |
| 版本列表 | `yfy_versions` | 非外协身份已覆盖；VersionRef 绑定完整 FileRef；OpenAPI 未声明外协 query |
| 当前 / 历史下载 | `yfy_download` | 非外协支持当前/历史；外协按 OpenAPI 支持当前内容；stdio → `local_path`，HTTP → `fetch_url` |
| 当前文件 / 文件夹批量打包 | `yfy_download_batch` | 1-20 个同身份非外协 Ref；结构化验证 ZIP 并接入统一下载生命周期 |
| 评论 / 分享列表 | `yfy_comments`、`yfy_shares` | 已覆盖；分享敏感字段脱敏 |

---

## Workspace、Inventory、Download

| Provider 能力 | 工具 | 状态 |
|---|---|---|
| 文件夹 / 部门祖先关系 | `yfy_workspace_validate` | 组合覆盖；检查为 pass / fail / unavailable |
| 文件是否在业务范围内 | `yfy_membership_check` | 组合覆盖；inside / outside / unavailable |
| 递归完整观测 | `yfy_inventory_*` | Worker 线程 + SQLite 后台扫描；区分 Workspace 根与 scan 根；支持 refresh、查询绑定固定 commit_watermark、显式 release |
| 校验后的当前 / 历史字节 | `yfy_download` | 可选 `workspace`；小文本 preview；大文件整文件落盘 |
| 结构已校验的批量 ZIP | `yfy_download_batch` | 可选 `workspace` 前后逐项校验；仅当前内容；OpenAPI 未声明外协 query、最大项数或归档语义完整性 |
| 期望元数据 / 内容断言 | `yfy_download.expected` | 不匹配则报错并删除 temp |
| 下载生命周期 | `yfy_download_release` + TTL | 可显式释放；主清理路径为 TTL |
| 清单生命周期 | `yfy_inventory_release` | Inventory、cursor、manifest、receipt 一并失效 |

说明：`commit_watermark` 表示已成功写入本地库的扫描进度；Inventory 搜索/分页绑定该值，避免读到未提交观测。

---

## Organization 与写入

| Provider 能力 | 工具 |
|---|---|
| 部门信息 / 子部门 / 部门用户 | `yfy_department_get` / `children` / `users` |
| 用户搜索 | `yfy_user_search` |
| 群组列表 / 群组成员 | `yfy_group_list` / `users` |
| 协作 | `yfy_collaboration_read` / `mutate` |
| 文件夹 / 文件变更与上传 | mutation toolset |
| 企业管理 | admin toolset；Provider 未声明 page capacity 的列表使用本地 offset/limit cursor |

---

## 暂未覆盖

- 标签（tags）与文件标签管理
- 收藏 / 最近项
- 回收站批量操作
- 文件版本 promote / delete
- 分享链接创建 / 更新 / 关闭
- 评论创建 / 删除
- 审批、知识库、设备同步

扩展时优先加深现有模块，避免重新退回“一 endpoint 一 tool”。
