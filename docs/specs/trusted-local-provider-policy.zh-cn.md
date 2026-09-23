# Trusted Local Provider Policy

> 简体中文（主要版本） | [English](trusted-local-provider-policy.md)

## 1. 状态与设计宪章

本规范对应 [#24](https://github.com/jiec-msft/torsor/issues/24)，定义 MVP 0.1
的 trusted-local 执行。Phase 1 的策略意图和环境准备由 Phase 2 连接到已合并的
Lease 执行；schema 18 保留 schema 17 公开诊断边界并添加 Provider receipt。
策略本身仍不授予 Writer Authority。

本规范遵循[设计基线](../prototype/001-overview.zh-cn.md)第 5、22、34、43 和
44.4 节：Agent 可以直接使用获授权的 CLI、API、MCP 和 Provider-native
工具；Kernel 保护持久事实、身份、revision、幂等、来源和 Writer 所有权。
Torsor 不重写 Agent 已有的外部能力，也不把工具意图当作执行授权。

## 2. 封闭的策略意图

只支持 `restricted` 和 `trusted-local` 两种策略。可信 Host 选择策略，不能从
Prompt、Provider 输出、环境变量或未知配置推断升级。未提供选择时使用
`restricted`；无效选择必须失败，不能回退。策略值不是可动态组合的权限 DSL。

| 字段 | `restricted` | `trusted-local` |
|---|---|---|
| `kind` | `restricted` | `trusted-local` |
| `tools` | `runtime-actions-only` | `provider-native` |
| `mcp` | `disabled` | `provider-configured` |
| `customInstructions` | `disabled` | `provider-configured` |
| `environment` | `restricted-allowlist` | `inherit-user-provider` |
| `permissionMode` | `deny` | 显式选择 `provider-default` 或 `allow-all` |

`restricted` 保留当前确定性 CI、共享 Host 和无人值守执行使用的受限启动语义：
模型只看到 Runtime action sentinel，shell/write/URL 被拒绝，内置和 Session
MCP、自定义指令及 shell 启动环境被禁用。它不是操作系统沙箱。

`trusted-local` 表达普通 Provider-native shell、write、URL、已配置 MCP 和
自定义指令的意图。选择必须同时包含 `kind: "trusted-local"` 和
`permissionMode`。`provider-default` 不请求 Allow All；
`allow-all` 是明确的无人值守 Allow All 意图，不是 Lease 或权限检查的替代品。
Provider 的具体 CLI flags、ACP mode/config 标识和能力探测留在 Copilot
Adapter seam 中；本层不硬编码、不猜测这些机制。

## 3. 环境策略与凭据边界

环境准备接收显式传入的 inherited environment 和可选 provider overrides，
不得读取全局 `process.env`、修改输入或启动进程。返回值只供未来进程启动瞬时使用，
不得并入策略对象、持久状态、Prompt、日志或公开诊断。

`restricted-allowlist` 只继承 `PATH`、`PATHEXT`、`SYSTEMROOT`、`WINDIR`、
`COMSPEC`、`TEMP`、`TMP`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、
`LANG`、`LC_ALL` 和 `TERM`。Copilot 显式 overrides 只接受
`COPILOT_PROVIDER_*`、`COPILOT_PROVIDERS_CONFIG` 和 `COPILOT_HOME`；
其他名称必须以不回显名称或值的固定错误拒绝。环境内容不会启用 Allow All。

`inherit-user-provider` 保留普通用户/Provider 环境以及 Provider 自己管理的
凭据，不按凭据名称建立新存储或只允许少数认证方式。两个输入中的 `TORSOR_*`
均必须移除；整个命名空间保留给 Torsor 内部 Host/daemon/runtime 控制，
包括数据库、认证、Activation、路径和调度控制。

Copilot seam 还必须移除继承或覆盖输入中的 `COPILOT_ALLOW_ALL` 和
`COPILOT_ASSISTED_APPROVAL`，使环境不能替代显式 permission-mode 选择。
即使选择 `allow-all`，环境准备也不得注入授权变量；未来 Adapter 必须通过受支持的
启动/ACP 配置应用意图。名称过滤不区分大小写；保留原始键拼写，undefined 值省略，
同一拼写的 override 替换 inherited 值。这延续当前受限环境的键处理方式；
本层不规范化多个仅大小写不同的键。

环境不是公开可序列化配置。凭据始终归 Provider 所有，只能在本地执行边界流转；
不得复制到持久状态、Prompt、公开诊断或测试产物。测试只使用合成值，
不读取真实用户环境、凭据或 Provider 配置。

## 4. 验证与序列化

策略选择和完整策略的验证必须拒绝未知字段、缺失字段、错误类型以及不一致的组合。
只接受普通数据对象，不执行配置 accessor 或 `toJSON`。错误消息不得包含输入。
规范化后的策略是冻结对象，只有上表六个固定顺序的枚举字符串字段；无命令、路径、
环境值、MCP 载荷、自定义指令正文或凭据。没有通用扩展袋。

序列化必须重新验证完整策略并输出规范字段顺序，不能直接序列化调用方对象。
每个合法配置的紧凑 JSON 最多 256 个 ASCII 字节，反序列化后的数据可重新验证，
且顺序变化不改变结果。非法或带额外载荷的对象必须拒绝，而不是静默删字段。

## 5. Phase 2 的执行前提

只有在 [#19](https://github.com/jiec-msft/torsor/pull/19) 和 Provider
diagnostic-redaction 工作合入 main 并集成后，才能连接真实 Copilot ACP 启动：

1. Runtime 从已分配的物理 Worktree 推导 cwd，在 spawn 前获取 Writer Lease，
   绑定 Activation、Run、execution receipt、generation、fencing 和原始进程句柄。
   Provider 在整个 native-tool 执行窗口占有 Writer Authority；不逐个文件操作包装
   Kernel 事务，也不能只删除现有 deny flags。
2. 取消、过期、关闭、权限丢失或接管必须独立于 SQLite 停止所拥有的进程树。
   未确认停止不能授予同一目录新的 Writer；未知终止必须 quarantine，
   恢复必须遵守 generation 与 fencing。
3. 发布 activity、Artifact、Reply 或成功完成前重新验证权限；拒绝晚到输出。
   ACP initialize、Session、mode/config、prompt、cancel 和 close 使用受支持的
   生命周期。公开 Tool started/completed/failed 事实必须有界且归一化，
   不保存原始 Prompt、环境、无限制 stdout/stderr 或含秘密的载荷。
4. 在合并后的确定性接口上验证工具写入、取消、过期、SQLite 争用、Host 重启、
   旧输出、quarantine 和替代 Writer 准入，并与 #22 场景工具协同。
   单独显式启用的真实 Copilot smoke 只编辑和测试可丢弃 Worktree 中的合成仓库，
   不进入普通 CI，不保留生成内容或凭据；#23 再记录最终受支持的使用方式。

本切片不提供 hostile-code 沙箱、多租户隔离、任意 Worktree 外执行入口、
插件市场、通用策略编辑器、凭据存储或外部 API/MCP 副作用的 exactly-once 保证。
`restricted` 必须继续作为确定性、无真实模型/网络调用的 CI 模式。

## 6. Phase 1 验收（历史范围）

确定性单元测试覆盖默认受限策略、显式 trusted-local 与 Allow All、非法选择和组合、
两种环境策略、内部控制变量移除、Provider 环境保留、输入不变性、固定有界配置和
不含秘密的序列化。测试不启动 Provider、不发网络请求、不创建持久状态或真实凭据产物。
现有 Adapter 启动强制边界保持原样；Phase 1 不代表 #24 的最终功能已经交付。

## 7. Phase 2 启动与公开观察契约

可信 Host 显式选择策略。Attention 判断没有 Run Worktree，必须继续使用
`restricted`；只有 Run 执行可以采用 `trusted-local`。Runtime 绑定
ProviderAttempt 和策略，Executor 从 Run 派生唯一物理目录，不接受 Provider cwd。
首次执行可在配置的仓库固定 commit 上创建 detached Worktree，且不运行仓库 hooks；
未登记的残留目录或不明确的归属必须失败，不能自动收养。已登记目录必须重新验证。

取得 Lease 和持久 execution receipt 后才启动受控进程所有者；它保留原始进程树，
Windows 使用 Job Object，Linux 使用独立进程组和 `/proc` 成员观察。其他平台明确拒绝
native launch；不降级为单 PID kill。Windows 在 suspended 创建后先加入 Job 再 resume，
Job 关闭会终止所有成员；Linux owner 在观察组清空之前保留原始 group identity。
Linux 受支持的工具必须把后代保留在原进程组内；主动脱离该组的 daemon 或 hostile
程序不在此执行契约内，不能把组停止当作这类进程的隔离证明。
Provider 退出后停止剩余成员；owner 丢失或强制停止而没有完整树证明时保持不确定。
进程配置只经私有 stdin 握手传递，不放入 supervisor 命令行或磁盘配置文件。
停止证据必须覆盖整个所拥有的树，
不能仅凭 Provider 主进程退出或旧 PID 判断。正常结束在最终 actions 发布前停止进程树，
并保持 Lease 到 publication/settlement 完成。所有停止先发起 OS 操作，再等待 SQLite。
未知终止使 Worktree quarantine，恢复不得使用 PID 重新获取进程权威。

Run 的每个公开 capability 在本地拒绝已撤销/过期的执行，并在 Kernel 事务中再次验证
Writer Authority。无执行绑定的 trusted-local 调用不得发布。成功必须有正常的物理停止
和仍有效的 execution receipt。并发恢复和非阻塞监督保持不变。

Human 已提交 `CancelRun` 后，native attempt 保留 `Unknown` / `Failed` 结果并停止/隔离原进程；
Runtime 在 settlement 后确认已处理的 delivery，不把逻辑取消报告为 Provider 成功，
也不因这一预期取消关闭观察 Host。HTTP/Web 仍只声明逻辑取消，不凭 receipt 宣称物理安全。
其他 Provider 失败以及 Host 主动关闭的错误传播保持原有语义。

Schema 18 在 schema 17 的诊断隐私契约上增加 native execution 的显式
ProviderAttempt/策略绑定：`StartWorktreeExecution.provider` 只接受
`providerAttemptId`、`policy: "trusted-local"` 和
`permissionMode: "provider-default" | "allow-all"`。ProviderAttempt 必须属于同一
Activation 且仍在执行；绑定作为 receipt 的持久事实，不含任意配置。
未提供该字段继续表示固定 probe。旧开发数据库必须在停止旧进程后重新创建，
不迁移、不自动删除；不得恢复 diagnostic session 标识。

Tool 观察只保存 `tool_started`、`tool_completed`、`tool_failed` 活动，payload
只含本次 ProviderAttempt 内生成的 `toolCallId`、ACP 枚举 `kind` 和归一化 `status`。
不得保存 Provider tool ID、title、命令、路径、参数、结果、MCP server 名、错误正文。
最多跟踪 128 个 Tool、接收 512 次 Tool 更新；原始 ID 只在内存中使用且最多 256 字符。
初始 pending/in_progress 只发布一次 started，终态最多一次；未知 ID、无效状态和
终态后的状态改变必须失败。一次带终态的初始调用发布 started 和对应终态。
Timeline 使用这些固定字段及已有 Run/Activation/ProviderAttempt 来源。

Trusted-local 的原始 assistant chunks 只用于有界内存中的最终 action envelope，
不直接作为公开 streaming activity 保存；Tool 和诊断正文也不转换为报告或 Reply。
显式最终 public actions 仍通过现有 capability 通道处理。ACP Session ID 只用于内存路由，
不恢复 diagnostic session 字段；所有失败继续采用 schema 17 的稳定代码和固定摘要。

确定性测试必须证明真实固定 Provider 能在分配的 Worktree 写入并执行合成测试，
以及 Shell/MCP Tool 状态、取消、过期、SQLite 争用、Host 重启、旧输出、
未知停止/quarantine 和替代 Writer 准入。真实 Copilot smoke 必须显式 opt-in，
仅使用可丢弃合成目录，结束时删除它，不在普通 CI 中运行。

本地 Host 使用 `TORSOR_PROVIDER_POLICY`（默认 `restricted`），`trusted-local`
必须设置 `TORSOR_PROVIDER_PERMISSION_MODE`，`restricted` 则拒绝该设置。
Trusted-local 还必须设置 `TORSOR_REPOSITORY_PATH`、`TORSOR_WORKTREE_ROOT` 和完整
commit 的 `TORSOR_BASE_REVISION`，并拒绝 `TORSOR_PROVIDER_CWD`。
`TORSOR_PROVIDER_TIMEOUT_MS` 在 trusted-local 下默认为 120000，在 restricted
下默认为 25000，接受 1000 到 295000；Attention、Outbox、Activation 和 Writer
窗口均为 timeout 加 5000 毫秒。这是有界执行尝试，不是可续期 Session。

Copilot 的显式 `allow-all` 使用公开支持的 `--allow-all`，并只选择 ACP permission
请求中实际声明的 `allow_always` 或 `allow_once` option；`provider-default` 拒绝无人值守
permission 请求。优先使用声明的 `configOptions`，否则使用 legacy `modes`，只选择
已声明的 `agent` / `interactive` coding mode，不把 Autopilot 当作权限模式。
关闭 stdin 是正常 ACP close；取消先发送 `session/cancel` 再停止原进程树。
参见 [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
及 [ACP config options](https://agentclientprotocol.com/protocol/session-config-options)。

普通 CI 运行固定 native ACP smoke 与 opt-in gate 测试，不读取真实 Provider 配置。
真实 smoke 必须显式传入 `--allow-real-provider`；缺少 opt-in 时，在读取环境、创建目录
或启动 Git/Provider 前拒绝。正常停止后清除 Torsor 临时数据库与合成内容；无法确认停止
时保留隔离目录并明确报错，不能删除仍可能有 Writer 的目录。Provider 自己的全局
Session/日志以及外部 MCP/API 效果不在 Torsor 清理范围，不能声称消除了 Provider 侧留存。
