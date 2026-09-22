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

## 可执行配对契约

`npm run check:docs` 是本地与 CI 共用的确定性命令，只依赖仓库要求的 Node.js 和 Git。`npm run test:docs` 通过公开 CLI 和临时 Git 仓库测试本节要求；`npm run ci` 包含两者。

### 文件与顶部导航

- 检查当前 Git Index 跟踪的 Markdown 文件（识别 `.md` 的所有大小写形式），读取工作区内容，但有效文件名必须使用小写 `.md`。新增文件须先 `git add`；未跟踪或被忽略的文件不在范围内。已暂存及未暂存的编辑和删除均纳入检查。
- 除下节显式排除的路径外，所有 Markdown 文件都必须具有同目录、大小写精确匹配的英文 `.md` / 简体中文 `.zh-cn.md` 对照；新增文档默认要求配对。不按目录或文件名隐式豁免。
- 配对必须是一对一且可逆：对照文件的对照必须是原文件。英文文件名去除 `.md` 后须非空，且不得以任何大小写的 `.zh-cn` 结尾；中文只能在该英文名称上添加一个小写 `.zh-cn` 后缀。重复或大小写混用的 Locale 后缀、空名称和非小写扩展名以 `document-name` 报错，排除清单也不能豁免。只检查文件名中的尾部后缀，不将目录名或文件名中间的 `.zh-cn` 当作 Locale 后缀。无效旧名称可删除或更名，不为其推导虚构对照；有效旧、新名称仍须满足配对和差异规则。
- 文件必须是普通文件，不接受符号链接。首个非空行必须是 `# ` 一级标题，下一非空行必须使用本仓库的一行语言导航格式：英文使用 `> English | [简体中文](name.zh-cn.md)` 或 `> [简体中文（主要版本）](name.zh-cn.md) | English`，中文使用 `> 简体中文（主要版本） | [English](name.md)`。
- 链接目标必须是对照文件的确切同目录文件名，可带一个字面的 `./` 前缀。其余原始字符只允许 ASCII 字母、数字、`-._~` 和 `%HH` 编码；其他字面字符（包括中文文件名字符）必须使用 UTF-8 百分号编码。原始 `&` 以 `navigation-encoding` 报错，必须写成 `%26`，不解析 Markdown Entity。只解码一次，结果必须精确等于对照文件名，且不得包含 `/`、反斜杠或控制字符；不对目录、Dot Segment 或重复编码再做规范化。字面的 `#`、`?` 等不得充当 Fragment 或 Query；文件名确实含有这些字符时须分别使用 `%23`、`%3F`。
- 文档开头可有一个 BOM，换行可用 LF 或 CRLF。正文、代码块、注释、图片或其他位置的链接不能替代顶部导航。不接受外部 URL、Fragment、Query 或引用式链接；这不是通用 Markdown 解析器。

### 显式排除

以下标记内的 JSON 数组是当前排除清单；英文对照中的清单必须包含完全相同的路径，并各自提供非空理由。只允许精确、规范化的仓库相对英文 `.md` 路径，不支持 Glob、目录或 `.zh-cn.md` 排除。重复、无效、已删除或已有中文对照的排除项均报错。移动、删除或升级排除文件时，必须同步更新两份策略中的清单。未实际存在的生成文档、Vendor、License 或 Changelog 不预先获得通配豁免。

<!-- bilingual-exclusions:start -->
```json
[
  {
    "path": "apps/server/README.md",
    "reason": "组件实现参考：路由与认证语法，不是产品规格或所有者入门入口。"
  },
  {
    "path": "apps/web/README.md",
    "reason": "组件实现参考：构建和 Client 状态，不是产品基线。"
  },
  {
    "path": "packages/agent-runtime/README.md",
    "reason": "Package 实现参考：随代码维护的 Runtime Contract，不是 Human 产品基线。"
  },
  {
    "path": "packages/kernel/README.md",
    "reason": "Package 实现参考：随代码维护的 API 和 Schema，不是 Human 产品基线。"
  }
]
```
<!-- bilingual-exclusions:end -->

### Pull Request 差异检查

`npm run check:docs -- --base <git-ref>` 在完整结构检查之外，比较 `<git-ref>` 与 `HEAD` 的唯一 Merge Base 到当前工作区的净变更。它包括已提交、已暂存和未暂存的受跟踪变更；新文件仍须先 `git add`。CI 获取完整历史，检出事件中的不可变 `pull_request.head.sha`，再以 `pull_request.base.sha` 调用此模式，不能在 GitHub 合成 Merge Commit 上运行该差异检查。`push` / `main` 事件明确回退到该事件的 `github.sha`，仅执行完整结构检查和常规 `npm run ci`；本工作流不额外验证合成合并树。测试使用真实分叉、独立双语修改和合成合并 Fixture，证明所检出的 Head 与 Push 回退行为。不存在的 Ref、缺失历史、多个 Merge Base 或未解决的 Index 冲突明确失败，不退回无差异检查。

在基线或当前状态中要求配对的文件，只要有任何净变更（包括仅格式变更），对照路径也必须有净变更。排除项只有在相应状态的清单中显式列出才豁免；新加的排除不能追溯性地豁免基线中的规范性文档。对于早于本契约、两份策略都没有清单标记的基线，不假定任何基线侧排除。

重命名按旧路径删除和新路径新增处理，不依赖相似度推断。因此必须同时处理旧对照与新对照；成对重命名或删除可通过，留下孤立文件或漏改对照不可通过。暂时修改后完全还原不算净变更。仅更新对照文件的格式也可能满足机械检查，但不能替代忠实翻译与 Human Review。

### 输出与边界

成功退出码为 `0`；策略违规为 `1`；参数、Git 或读取失败为 `2`。违规输出按固定字典序排列，每行使用仓库相对 `/` 路径和稳定诊断码，不包含机器绝对路径。`--help` 显示用法。

该检查只证明文件、导航、排除清单和变更路径符合结构契约，不能证明语义等价、翻译质量、中文先写先审、排除理由合理，或正文链接全部有效。两个版本是否描述相同要求仍由 Human Review 判断。本层只涉及文档、脚本和 CI，可独立撤销，不改变产品运行行为。
