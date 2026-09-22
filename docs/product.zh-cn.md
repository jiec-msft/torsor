# 产品定义

> 简体中文（主要版本） | [English](product.md)

## 承诺

Torsor 帮助一个人领导多个软件 Agent，而不必成为它们的调度器、看门人或记忆载体。

Agent Session 可以被替换。目标、承诺、决策、证据和待办行动必须持久化。

## 原则

1. **Human 领导工作。** Agent 在明确授权内执行、调查、Review 和报告。
2. **工作跨越 Session 延续。** 关闭所有 Agent Session 不得抹去下一步行动或已接受的上下文。
3. **承诺必须显式。** Chat Message 不会静默变成共享 Task、Decision、Approval 或 Result。
4. **Task 与尝试分离。** Task 可以跨越失败、取消、重试或重新分配的 Run。
5. **不确定性必须可见。** 连接丢失不自动代表成功或失败。
6. **本地执行留在本地。** Host 保持对其文件、进程、凭据和 Workspace 的控制。
7. **系统以确定性方式继续。** 常规推进不依赖某个长驻 Agent 记得继续。

## 第一个可工作切片

第一个切片将证明：

1. 一个人创建一个持久 Workstream。
2. 一个 Agent 执行 Task 并提交 Result。
3. 另一个 Agent Review 该 Result。
4. 两个 Agent Session 都可以关闭并重新创建。
5. 下一步行动仍然可用，不需要 Human 重复上下文。
6. 最终结果进入显式 Human Review 状态。

## 初始非目标

- 替代通用社交 Chat。
- 永久维持一个 Coordinator Agent Session。
- 对任意外部系统声称 exactly-once 行为。
- 在第一个端到端切片可工作前构建所有协作视图。
