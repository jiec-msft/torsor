# 文档语言与配对策略

> 简体中文（主要版本） | [English](documentation.md)

简体中文是 Human 编写和所有者 Review 的主要语言。无语言后缀的英文文件继续作为公开发现入口。两个版本都是规范性对照，必须描述相同要求。

## 命名与同步

- 英文使用无语言后缀路径：`README.md`、`docs/product.md` 或 `docs/specs/foo.md`。
- 简体中文使用 `.zh-cn.md`：`README.zh-cn.md`、`docs/product.zh-cn.md` 或 `docs/specs/foo.zh-cn.md`。
- 两个文件都在顶部附近互相链接。
- 行为变更必须在同一个 Pull Request 中更新两个版本。
- 代码标识符、命令、UI 字面量、Schema、协议字段和机器可读示例保持英文语法。
- 如果需求缺失、含糊或冲突，应先澄清规格，不得在实现时猜测。

## 已跟踪文档审计

本审计覆盖采用该策略时仓库内每一个已跟踪 Markdown 文件。

采用该策略前，`docs/prototype/001-overview.zh-cn.md` 是唯一带 Locale 后缀的文档，但没有英文对照；根目录 `README.md` 将它链接为 MVP 0.1 内核基线。因此，原本只有英文的 Copilot 指令、顶层入门与策略文件、产品/公开内容文档，以及两个原型入口都需要简体中文对照。下表中的四个组件/Package README 也已完成审查，并基于表中理由有意排除。

| 英文路径 | 简体中文路径 | 分类 | 配对决定 |
|---|---|---|---|
| `.github/copilot-instructions.md` | `.github/copilot-instructions.zh-cn.md` | Agent 与仓库策略 | 已配对；规范性工作流 |
| `README.md` | `README.zh-cn.md` | 顶层入门 | 已配对 |
| `CONTRIBUTING.md` | `CONTRIBUTING.zh-cn.md` | 贡献策略 | 已配对 |
| `SECURITY.md` | `SECURITY.zh-cn.md` | 公开安全策略 | 已配对 |
| `docs/product.md` | `docs/product.zh-cn.md` | 产品规格 | 已配对；规范性 |
| `docs/public-content.md` | `docs/public-content.zh-cn.md` | 公开内容策略 | 已配对；规范性 |
| `docs/prototype/001-overview.md` | `docs/prototype/001-overview.zh-cn.md` | MVP 0.1 设计基线 | 已配对；简体中文为主要版本 |
| `docs/prototype/mvp-0.1/README.md` | `docs/prototype/mvp-0.1/README.zh-cn.md` | 原型使用说明与证据索引 | 已配对；面向所有者的设计入口 |
| `prototype/README.md` | `prototype/README.zh-cn.md` | 较早原型入门 | 已配对；面向所有者的入口 |
| `docs/documentation.md` | `docs/documentation.zh-cn.md` | 文档策略与审计 | 已配对；规范性 |
| `docs/specs/acp-conformance.md` | `docs/specs/acp-conformance.zh-cn.md` | 独立 ACP Harness 规格与公开复用研究 | 已配对；规范性 |
| `packages/acp-conformance/README.md` | `packages/acp-conformance/README.zh-cn.md` | 独立工具入门 | 已配对；面向所有者与外部 Provider 作者 |
| `apps/server/README.md` | 不要求 | 组件实现参考 | 保持英文；路由与认证参考直接绑定英文 API 语法，不是产品规格或所有者入门入口 |
| `apps/web/README.md` | 不要求 | 组件实现参考 | 保持英文；构建和 Client 状态参考直接绑定实现 |
| `packages/agent-runtime/README.md` | 不要求 | Package 实现参考 | 保持英文；详细 Runtime Contract 随代码维护，不作为 Human 产品基线 |
| `packages/kernel/README.md` | 不要求 | Package 实现参考 | 保持英文；详细 API 和 Schema 参考随代码维护，不作为 Human 产品基线 |

文档原型目录中的生成资产和源文件、截图、License 文本，以及当前不存在的 Changelog/Vendor Artifact 都不是产品规格，不属于 Markdown 配对范围。

当某个排除文件变成规范性文件、出现在顶层所有者导航中，或成为某个产品领域的主要入口时，应重新评估该排除。
