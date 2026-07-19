# Agent 评测说明

## 用例文件

| 文件 | 用途 |
|---|---|
| `general_workflows.xml` | Drive / Workspace / Inventory / Download / 写工具的选择路径；重点：普通读文件应选 `yfy_download`；范围审计仅在需要完整性时才用 Inventory |
| `authority_readonly.xml` | 绑定固定 Workspace 根 `501000715605`，验证业务路径与完整性场景 |

运行 `authority_readonly` 前：将该目录配置为命名 Workspace，并先调用 `yfy_workspace_validate`。

## 建议记录指标

除工具选择准确率外，建议记录：

- 完整工具调用 trace
- 参数与输出字节数
- 平均调用次数
- 错误分类
- cursor / `next_action` 是否可执行
- 是否在 `safe_to_claim_absence=false` 时错误声明“不存在”
