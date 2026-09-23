# Torsor

> 简体中文（主要版本） | [English](README.md)

Torsor 是一个面向人与软件 Agent 持久协作的开源环境。

Agent 可以停止、重启或迁移到其他主机，而工作应当从持久状态继续。

> Agent 会变化，工作会延续。

## 为什么叫 Torsor？

在数学中，torsor 类似一个没有指定原点的空间：即使没有任何一点永久居于中心，各点之间的关系仍然有意义。

Torsor 将这一思想用于 Agent 协作。任何 Agent Session 都不应成为某个目标、决策或下一步行动不可替代的唯一所有者。

## 状态

Torsor 仍处于早期设计和实现阶段。第一个可工作切片将聚焦于：一个人通过持久工作状态协调可替换的 Agent Session。

## 文档

- [产品定义](docs/product.zh-cn.md) ([English](docs/product.md))
- [MVP 0.1 内核与交互原型](docs/prototype/001-overview.zh-cn.md) ([English](docs/prototype/001-overview.md))
- [独立 ACP Provider 一致性 Harness](packages/acp-conformance/README.zh-cn.md) ([English](packages/acp-conformance/README.md))
- [文档语言与配对策略](docs/documentation.zh-cn.md) ([English](docs/documentation.md))
- [公开内容策略](docs/public-content.zh-cn.md) ([English](docs/public-content.md))
- [贡献指南](CONTRIBUTING.zh-cn.md) ([English](CONTRIBUTING.md))
- [安全策略](SECURITY.zh-cn.md) ([English](SECURITY.md))

## Human Run 控件

在生产 Web 的 Run detail 中，`Cancel Run` 取消可操作 Run 的逻辑工作线；`Withdraw Input` 仅撤回你分配的 Pending 输入，不删除公开 Message。取消成功不代表 Provider 已物理停止或 Worktree 已安全释放；当前视图无法确认物理停止和 quarantine。响应未知时使用 `Retry same action`，不要新建替代请求。revision / conflict 拒绝后先刷新并审阅；重新认证或同一窗口重载后保留原身份恢复。已确认提交但读取失败时，使用控件内只读刷新。详见 [Human 控件规范](docs/prototype/001-overview.zh-cn.md#4421-human-cancel-和-withdraw-控件)。

## 许可证

Torsor 使用 Apache License 2.0。
