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
- [确定性 Torsor System Scenarios](packages/system-scenarios/README.zh-cn.md) ([English](packages/system-scenarios/README.md))
- [文档语言与配对策略](docs/documentation.zh-cn.md) ([English](docs/documentation.md))
- [公开内容策略](docs/public-content.zh-cn.md) ([English](docs/public-content.md))
- [贡献指南](CONTRIBUTING.zh-cn.md) ([English](CONTRIBUTING.md))
- [安全策略](SECURITY.zh-cn.md) ([English](SECURITY.md))

## 许可证

Torsor 使用 Apache License 2.0。
