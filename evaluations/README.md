# Agent Evaluations

`general_workflows.xml` 覆盖 Drive、Workspace、Inventory、Capture、Resource 和写入工具选择，重点检查普通任务是否避免过度调用 Inventory/Capture。

`authority_readonly.xml` 绑定固定 Workspace root `501000715605`，用于验证业务路径和完整性场景。运行前将该目录配置为命名 Workspace，并调用 `yfy_workspace_validate`。

除工具选择准确率外，应记录完整工具 trace、参数、输出字节数、平均调用数、错误分类、cursor 可执行性，以及是否在 `safe_to_claim_absence=false` 时错误声明不存在。
