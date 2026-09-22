# ACP Provider 一致性 Harness

> 简体中文（主要版本） | [English](acp-conformance.md)

状态：首个独立切片。此规格约束 `@torsor/acp-conformance`，不改变 Torsor Runtime、Kernel 或 Host 的行为。Harness 检查明确列出的 ACP v1 子集，不颁发完整 ACP 合规认证。

## 1. 复用优先研究门

2026-09-22 检查的 Paseo 默认分支 `main` 精确 Commit：
[`91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786`](https://github.com/getpaseo/paseo/tree/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786)。
搜索覆盖 ACP、conformance、harness、scenario、fixture、transcript、replay、stdio 和 permission；随后追踪实际调用者和测试，而不是仅根据名称判断。

| 候选边界 | 已确认的消费者与能力 | 决定及具体差距 |
|---|---|---|
| [`@getpaseo/plugin/server/acp`](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/plugin/src/server/acp.ts) 的 `runAcpProvider` | 插件 Worker 的 `provider.connect` → ACP Connection → `PluginAgentClientRegistry`；[集成测试](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/plugins/runtime.posix.test.ts) 实际启动插件和合成 ACP Agent | 是公开 API，但输入/输出是 Paseo `ProviderInput` / `ProviderEvent`，会转换 Timeline、Session 和权限。不是原始 ACP 验证边界；未来可作为被测兼容适配器，不作为核心依赖 |
| [插件 ACP 测试](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/plugin/src/server/acp.test.ts) | 可执行 `.cjs` Agent、内存连接、权限应答、取消后替换 Prompt 的顺序测试、2 MiB stderr 测试 | 真正可复用的设计概念，但测试不在公开 Export 中；无版本化场景、统一 Verdict 或规范化 Transcript API |
| [Server ACP 实现](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/acp-agent.ts) | Provider Registry → `GenericACPAgentClient` / 具名 Provider；使用 SDK 0.17.1；诊断测试检查超时进程退出 | 非公开深层路径；会忽略非 JSON stdout、兼容字符串化响应 ID，且无人值守策略可自动批准。严格 Harness 不能把这些行为当通用协议要求 |
| [JSONL RPC Process](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/jsonl-rpc-process.ts) / Frame Decoder | 实际消费者为 Pi / OMP CLI Runtime；使用 `type/success/data` 与分块协议 | 不是 ACP JSON-RPC。不能通过类似文件名推导互操作性 |
| [进程树工具](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/utils/tree-kill.test.ts) | Server 有 Windows CI、Windows/POSIX 子孙进程测试 | 非公开 Export；插件 ACP 自己使用直接 `spawn` / `child.kill`。仍缺统一输出预算、整体操作期限和独立清理失败判定 |
| [真实 ACP Smoke](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/acp-wrapper-smoke.test.ts) | `ACP_SMOKE` 显式启用；记录选定 RPC 事实 | 有真实消费者，但含平台特定配置和自动 allow 策略；不是无凭据的通用场景集 |

Paseo 的 JSONL Fixture、Provider 原生历史回放、CLI YAML 输出分别服务不同边界；未找到通用 ACP 场景 DSL 或 Wire Record/Replay 引擎。因此不存在可直接沿用的 Paseo 场景格式。互操作路径保留标准 ACP stdio，而不是依赖其应用事件格式。

Paseo 根 [LICENSE](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/LICENSE) 对自有代码声明 Apache-2.0。检查时公开 `@getpaseo/plugin` / `@getpaseo/server` 0.9.0 的 npm `gitHead` 为 `7f7e60bcbbfe57bf5250b10d01c5f97847b43db0`，不等于研究 Commit；测试不公开，Tarball 文件存在不等于 Export API。未复制 Paseo 源码。

**复用决定：**直接依赖 Apache-2.0 的 `@agentclientprotocol/sdk` **1.4.0**，其公开源码 Commit 为 [`e6463f444093ed7c5f1cc937c3f32afb5853e906`](https://github.com/agentclientprotocol/typescript-sdk/tree/e6463f444093ed7c5f1cc937c3f32afb5853e906)。使用稳定 v1 `client()` / `agent()` / `ndJsonStream`，不使用弃用连接类、私有测试工具或 experimental v2。复用请求关联、双向方法派发和协议类型；Harness 只补充严格 Wire 观察、场景执行、断言、预算、进程所有权和公开 Artifact 策略。SDK 的未终止行缓冲和合作式取消不提供敌对输出/整体期限保证，因此必须在其外层限制。Zod（MIT）提供唯一配置 Schema，YAML（ISC）只负责解析；不引入第二套验证规则。

Windows 原生边界复用 MIT 的 [`koffi` 3.2.0](https://www.npmjs.com/package/koffi/v/3.2.0) 公开 FFI / Struct API 绑定[文档化 Job Object API](https://learn.microsoft.com/windows/win32/procthread/job-objects)，不自行维护 Native Addon。其按平台发布的预编译包支持 Windows x86/x64/ARM64；仅 Windows 所有权子进程加载它。GitHub Windows 运行曾在 PowerShell `Add-Type` 编译阶段超时，因此不再依赖运行时编译或 PowerShell Guardian；原生绑定不可用时明确失败，不降级为可能遗漏孤儿进程的 PID 树遍历。

## 2. 公共接口和范围

Package 遵循现有 ESM / TypeScript Workspace 约定，但不依赖任何 Torsor Package。

- `loadScenario(text, { format: "json" | "yaml" })`：同步解析并验证，返回带确定性默认值的 Scenario；错误包含 `$` 开始的结构路径，不回显值、源码片段或机器路径。
- `runScenario(scenario, options?)`：验证后执行一个独立临时 Workspace，返回 `passed | failed | skipped`、稳定 Diagnostic、规范化 Transcript；默认启动内置 Mock。
- `runSuite(scenarios, options?)`：顺序执行相同公共入口，每个场景使用新进程和 Workspace；兼容子集由调用者显式选择，不按 Provider 名称隐藏失败。
- `toJsonl(result)`：把 Transcript 序列化为版本化 JSONL。
- `acp-conformance run <scenario...> [--out <directory>] [--allow-real] [--profile copilot-cli-v1 | -- <command> <args...>]`。显式 `--inherit-env NAME` 只传递被授权的环境值，不打印或记录它们。
- `acp-conformance mock <scenario>`：运行确定性的声明式 stdio 对端，可供其他 ACP Client 使用。

CLI 退出码：`0` 全部通过；`1` 场景失败；`2` 配置、用法或 Artifact I/O 错误；`3` 未启用真实 Provider 导致跳过。Human 输出只含场景 ID、步骤和固定诊断；`--out` 保存每场景 `.result.json` / `.transcript.jsonl`，不覆盖现有文件。真实 Provider 没有自动安装、登录、认证或重试。

## 3. 唯一版本化配置

顶层：`schemaVersion: 1`、`id`、`steps`、可选 `limits`、`mock` 和 `expectFailure`。`id` / 请求标签使用短 ASCII 标识符。JSON 和 YAML 输入进入同一 Zod Schema，默认值、未知字段和诊断完全一致。所有控制对象拒绝未知字段；ACP `params` / `result` 是有界 JSON，可以包含协议扩展字段，不把这些字段当 Harness 指令。

输入最多 256 KiB、JSON 深度最多 32、最多 128 个步骤/Handler/Action；YAML 只接受 JSON 兼容核心类型，拒绝重复键、自定义 Tag、Alias、Merge Key 和多个 Document。拒绝未知 Schema 版本，不猜测向前兼容。新增控制字段必须显式升级消费者；Provider 的未知扩展不等于配置字段可以静默忽略。

场景 ID 拒绝 Windows 保留的设备名称，使 Artifact 名称跨平台安全；同一 CLI Suite 的 ID 大小写不敏感地唯一。

最小场景词汇：

| `type` | 语义 |
|---|---|
| `request` | `id` 是本地唯一标签；用 `method` / `params` 开始一个异步客户端请求，不隐式等待 |
| `response` | 等待标签 `id` 的结果；可断言 JSON Pointer 的 `equals` 或 `kind`，或预期 `errorCode` |
| `notification` | 发送客户端通知，例如 `session/cancel` |
| `update` | 消费一个匹配 `sessionUpdate` 的 Provider Session Update；可加事实断言。事件从开始就有界排队，不靠 sleep 建立顺序 |
| `close-stdin` | 明确关闭输入方向 |
| `exit` | 等待 Provider 退出，并断言退出码 |

参数中的唯一替换为完整对象 `{ "$ref": "workspace" }` 或 `{ "$ref": "request-label#/json/pointer" }`，后者只读取已消费成功响应。没有字符串模板、代码求值、循环、外部文件包含或环境插值。JSON Pointer 遵循 RFC 6901；无效或未绑定引用明确失败。

`mock.handlers` 按 `method` / `kind: request | notification` 注册 SDK Handler，动作依序执行：`reply`、`notify`、`request`（向客户端请求并断言应答）、`wait` / `release`（具名 Gate）、`fault`。Gate 先释放后等待也可完成；跨 Handler 协调不需要真实 sleep。Fault 仅存在于 Mock：`malformed`、`oversized`、`stderr`、`stdout-close`、`stdin-close`、`exit`、`hang`，以及发送显式 `wire` 消息的协议畸形注入。正常消息由 SDK 编码/派发，故障注入不得成为生产兼容例外。

`expectFailure` 仅接受稳定失败码；匹配预期故障时场景可通过，但清理失败永远失败。错误诊断保留，避免“预期失败”伪装成没有发生故障。

`reply` 使用 `result` 或 `errorCode` 二选一。`fault` 内嵌具名 `fault.kind` 对象；`wire` 可显式关闭换行以测试半帧。`mock.onStdinClose` 可在输入 EOF 后执行同一动作词汇，确定性测试最终响应之后的输出，不依赖延时。Ajv（MIT）直接验证 SDK 发布的 ACP JSON Schema 中本切片使用的方法定义，不另行维护协议字段 Schema；在 SDK 通知错误日志路径之前拒绝无效负载。

## 4. Wire、状态、权限与预算

依据公开 ACP v1 [初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[Transport](https://agentclientprotocol.com/protocol/v1/transports)、[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) 与 [Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls)：

1. stdout 必须为 UTF-8、换行终止的单个 JSON-RPC 2.0 消息；不接受日志、Batch、空行、非法 UTF-8、半帧或重复/未知响应 ID。在 SDK 容错处理前检查，绝不静默修正 ID。
2. 初始化结果必须选择版本 1 并提供 Capability 对象；Session 必须先初始化，Prompt 必须先获得有效 Session ID。Prompt 结果必须有有效 `stopReason`。Capability 内容可用事实断言检查，不断言自然语言文本。
3. 取消用 `session/cancel`；取消后的 Update 仍可被接收，直到 Prompt 结果。被取消的 Prompt 必须以 `cancelled` 完成。明确协调测试覆盖取消前后竞态；不把进程被杀等同于协议取消成功。
4. 客户端仅声明版本 1 和空的可选 Capability 对象；场景不能启用 FS / Terminal，也不能为 Session 指定临时 Workspace 之外的 cwd、额外目录或 MCP Server。每个 `session/request_permission` 自动返回 `cancelled`；其他反向请求由 SDK 返回 Method Not Found，不执行本地工具。策略不可配置成允许。Tool Update 是可观察协议事实，不等同于本地执行授权，也不是通用 ACP 违规。
5. 默认每帧 256 KiB、stdout 总量 1 MiB、stderr 总量 64 KiB、2048 个协议事件、启动期限 15 s（`startupMs`）、步骤期限 5 s、场景期限 30 s、清理期限 2 s。启动期限独立覆盖 OS 所有权建立和 Provider Spawn，不用放宽协议步骤期限来适配 Windows 冷启动。所有设置必须为有上限的正整数。包括 SDK 之前的原始流和 JSON 深度限制，拒绝超限而非截断成成功。stderr 被消费和计数，但内容从不保留。
6. 无 Shell 插值；命令与参数分开，Windows `.cmd` / `.bat` 不隐式启动 Shell。命令只能是受信任的本地程序。默认环境只继承运行所需的 OS / PATH 值，HOME、配置、缓存和临时目录均重定向至本次合成 Workspace；凭据只可通过显式 Runtime 环境授权传递。
7. 每次调用启动一个仍存活的 Node 进程所有权包装层，以便 Provider 提前退出时仍能终止其后代。Windows 在启动 Provider 前建立 `KILL_ON_JOB_CLOSE` Job Object 并把所有权进程自身加入；不可继承的 Job Handle 由该进程持有，精确终止该进程会关闭 Handle 并回收包括孤儿在内的 Job 成员。Job 设置失败时不启动 Provider。POSIX 使用该次创建的独立进程组。总是等待关闭并删除临时目录；失败明确报告。逃离进程组的恶意程序、OS Sandbox 和不受控外部副作用不在保证范围内。
8. 无真实 Provider 命令时只运行 Mock，不访问模型、网络或凭据。外部命令在未显式 `allowReal` 时返回 skipped，不启动进程。环境中存在 Token 不能开启真实测试。

所有权层用内部字节计数 EOF 信号，确保消费最后一帧后才关闭 SDK 流。内置 Mock 的 `stdout-close` / `stdin-close` 使用专用控制通道确定性关闭方向，不依赖 Windows Node 自身标准句柄的销毁语义；这些故障只在 Harness 管理的 Mock 中提供，不接受真实 Provider 的同类控制信号。

只有显式 `exit` 步骤要求 Provider 自主退出及指定退出码。完成协议断言后，Runner 关闭 stdin，最多等待 `shutdownMs` 排空 stdout/stderr，然后有界终止仍存活的 Provider；强制清理本身不表示 ACP 不合规，清理失败或排空期间的协议/预算错误仍令场景失败。等待和终止各自受 `shutdownMs` 约束。

Windows 释放文件句柄可能晚于进程退出；临时目录删除使用 Node 的三次有界重试，累计等待不超过 300 ms（短清理预算下相应缩小）。重试耗尽仍明确报告 `cleanup_failed`，不忽略剩余文件。

所有权层通过显式 Ready 握手后才接收启动配置，不依赖运行时编译或控制台文本编码。启动超时只报告固定阶段名称，不披露原始系统输出或机器路径。

## 5. Transcript 与安全

JSONL 为唯一事件 Artifact 格式，每行 `schemaVersion: 1`、递增 `sequence`、`timestamp`、`direction`、`kind` 和安全事实。`timestamp` 是从 Unix Epoch 开始、每事件推进 1 ms 的**逻辑时间**，不是延迟测量；排序以 `sequence` 为准。

采用白名单投影，而不是依赖 Secret 正则：只保留已知协议 Method/Enum、版本、布尔 Capability、规范化请求/Session/Tool ID、Error Code 和生命周期事实。任意文本、Prompt、错误消息、stderr、原始工具输入/输出、未知键/方法、路径、环境、PID、Provider 元信息和二进制内容不进入 Artifact。未知值表示为固定占位符。原始值只在有界内存中用于请求关联、引用和事实断言。Diagnostic 不包含实际值。

相同确定性 Mock 场景产生相同 Transcript。真实 Provider 的 Update 数量和顺序可以不同；不把规范化伪称为确定性模型输出。Artifact 可用于稳定 Diff 和未来结构性回放；**本切片不提供无损回放或把已脱敏内容恢复成 Prompt 的 API**。

## 6. Copilot 兼容性证据（非 ACP 规范）

隔离研究使用安装的 `copilot.exe` **1.0.83**，严格 60 s 总期限、256 KiB 帧和 1 MiB 输出上限。只运行合成目录和合成 Prompt；自动拒绝所有权限/客户端工具请求；精确清理本次进程树。未保留原始输出、生成内容、环境值或机器路径。

观察事实：`--acp` 可以使用 stdio；初始化选择版本 1、Capability 对象存在、一个认证方法；`session/new` 返回 Session，合成 Prompt 以 `end_turn` 完成，观察到 9 个 Update，没有权限或客户端工具请求。该次成功不证明未来版本、认证环境或所有模型兼容；没有请求权限也不证明真实权限处理已被覆盖。

随后通过 Harness 公共 API、`copilot-cli-v1` 和同一 `basic` 场景完成第二次 opt-in Smoke；握手、Capability 和 `end_turn` 断言均通过，不需要协议例外。结果只保留规范化事实，不保存原始生成文本。

具名 `copilot-cli-v1` Profile 只组合安全启动参数：禁用更新、Remote、Custom Instructions、内置 MCP、Bash Env 和 Ask User；工具列表限制到不存在的 Sentinel，并显式拒绝 shell/write/url；日志写入合成临时目录。它不改变协议 Verdict，不将 Runtime 的 Torsor JSON Action 格式搬入 Harness。一般 Provider 使用显式 Command/Args 和同一兼容场景子集。

## 7. 交付顺序与非目标

TDD 垂直切片：公共 API/CLI 加载一个场景 → Mock stdio Initialize / New / Prompt → JSONL 与 Verdict；随后加入同 Schema 的 YAML 严格验证、故障/预算、取消/权限竞态和真实 Provider 显式启用路径。测试通过公开入口，不依赖私有类布局。普通 PR CI 运行确定性测试，不要求真实模型、网络、凭据或精确自然语言。

本 PR 不接入 Torsor 状态；不替换现有 Adapter/Host 测试；不实现 ACP 全部方法、认证流程、模型质量评估、允许工具执行、Fuzzing、广泛 Provider Matrix、无损 Record/Replay、富表达式 DSL、跨主机执行或 OS Sandbox。未来扩展须先添加中英文规范，不通过 Profile 隐藏协议失败。
