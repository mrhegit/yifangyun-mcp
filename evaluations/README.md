# Agent Evaluations

`authority_readonly.xml` 包含 10 个只读、独立、可字符串校验的问题，用于验证 Agent 是否能正确选择 atomic、authority 和 durable discovery 工具。

这些问题绑定固定 authority root `501000715605`。运行前应先调用 `yfy_validate_authority_root` 确认环境仍指向预期业务路径；若 Provider 中固定资料被管理员迁移，应重新执行只读验证后更新答案。

推荐同时记录准确率、平均工具调用数、任务耗时、错误码分布和是否错误地使用 hint-only 搜索声明不存在。
