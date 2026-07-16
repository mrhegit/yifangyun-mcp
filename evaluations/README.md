# Agent Evaluations

`authority_readonly.xml` 包含 10 个只读、独立、可字符串校验的问题，用于验证 Agent 是否能正确选择 1.0 Core、Authority、Snapshot 和 Evidence 工具。

这些问题绑定固定 authority root `501000715605`。运行前应将其配置成命名 scope，并调用 `yfy_authority_validate` 确认环境仍指向预期业务路径；若 Provider 中固定资料被管理员迁移，应重新执行只读验证后更新答案。

推荐同时记录准确率、平均工具调用数、任务耗时、错误码分布和是否错误地使用 hint-only 搜索声明不存在。

`general_workflows.xml` 包含法务、采购、审计、合同和供应商资料场景，用于确认投标优化没有把 MCP 限制成单一业务工具。
