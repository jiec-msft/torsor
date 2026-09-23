# Torsor System Scenario Harness

> 简体中文（主要版本） | [English](system-scenarios.md)

## 1. 范围与依赖

**SS-1.1** 本工具验证确定性 Provider 行为导致的 Torsor 系统行为：

```text
Scenario -> Scripted Provider -> Agent Runtime -> Kernel/SQLite
         -> HTTP/SSE -> WebController -> Assertions

Scenario -> Local Runtime Host -> trusted-local ACP Adapter
         -> LocalWorktreeExecutor -> native process-tree owner
         -> Kernel/SQLite -> HTTP/SSE -> WebController -> Assertions
```

使用真实 Runtime、临时文件 SQLite、生产 HTTP/SSE 与无浏览器 WebController。
`@torsor/system-scenarios` 是仅用于测试的组合包，不进入产品运行时依赖。
`@torsor/acp-conformance` 继续独立验证 ACP v1；两者不互相依赖，
不扩展其严格协议 DSL 为系统测试 DSL。

**SS-1.2** 复用 `TorsorKernel.open`、`AgentRuntime`、
`createTorsorHttpService`、`createLocalRuntimeHost`、`CopilotAcpAdapter` 与
`LocalWorktreeExecutor` 的公开 API。
Web 包公开 `@torsor/web/controller`，仅导出 headless controller、其选项、
状态与事件源端口，不导出 React/App 私有实现。默认浏览器行为不变。
测试不得深层导入其他包的 source/test 内部文件。

## 2. 词汇与公开接口

**SS-2.1** Scenario 是一个有编号契约引用的 TypeScript 测试；
Given 建立合成协作状态；When 执行 Human 命令、Provider capability 或调度步；
Then 读取公开 Kernel、HTTP 与 Web 投影。使用
`runSystemScenario(async (system) => { ... })` 管理整个生命周期，
不引入 YAML、表达式解析器或新的领域对象。

**SS-2.2** `system.provider` 按真实 `ProviderExecutionContext` 编排行为，
只能通过 capability 影响领域状态；脚本错误必须使场景失败，不得被 Runtime
记录为 Provider 失败后掩盖。`system.drain()` 有界消费持久工作，
`system.advanceUntil(predicate)` 逐个 Runtime pass 推进至公开持久条件成立，
条件在空闲时仍不成立则明确失败，不继续执行与断言无关的工作；
`system.sync()` 从真实 SSE 字节推进 Web 投影；断言等待可观察条件，
不得依赖到达时间。`system.reopen()` 丢弃 Runtime/Controller/Provider
实例并重开同一 SQLite/Artifact root；只保留持久状态与场景显式输入。

**SS-2.3** 核心时钟可显式推进，Provider gate 有明确到达/释放信号。
测试 runner 控制应用 timer；未推进的 timer 不得成为正确性前提。
SSE 重连从明确 cursor 回放，允许在传输端暂停、重复、倒序投递已捕获的
真实通知，但不得伪造 Kernel 事实。活动补读保持有限上界和每页最多 100。
`sync()` 先捕获至调用时的持久高水位，再一次性释放该有限 SSE 前缀；
网络分包不得决定投影刷新次数。支持断线期间捕获前缀后倒序/重复释放。
禁止任意 sleep、真实模型、互联网、浏览器和真实凭据。
runner 同时控制 `performance.now()` 与应用 timer；磁盘或 CPU 延迟不能消耗
逻辑场景的执行预算。Kernel 日期时钟仍单独显式推进。fresh-process 基准使用
测试进程外的真实单调时钟，不把虚拟时间作为速度证据。

**SS-2.4** 无新增事实、首次连接或重开后 cursor 已在高水位时，`sync()` 仍必须
完成真实认证 SSE handshake 并通知 Web `onopen`，等待其重连读取与 invalidation
重试完成。不得伪造事件、重发命令或停留在 `connecting`/`reconnecting`。

**SS-2.5** `runTrustedLocalScenario` 使用真实 Host/Runtime/Adapter/Worktree
composition 和平台原生进程树 owner。Provider 是本包拥有的固定合成 ACP child，
只使用一次性 Git fixture，不读取用户环境、登录配置、真实凭据或网络。
场景可观察公开持久投影、公开 HTTP/SSE/Web 状态及该合成 child 自行写入的
PID fixture；不得以 mock owner、fake Kernel 或预制成功结果替代生产路径。

## 3. 首批目录与派生方法

**SS-3.1** 每个规则按正常路径、边界、重试/回放、打断/并发四个维度推导；
首片只选关键代表，不展开笛卡尔积。每次先增加一个失败的公开行为测试，
再最小实现，随后运行该 tracer，才增加下一个测试。
以下编号同时是实现与测试的追踪依据；领域语义由配对
[MVP 规范](../prototype/001-overview.zh-cn.md) 管辖。

| 编号 | 代表场景 | MVP 来源 |
|---|---|---|
| SS-3.2 | Human 创建 Thread，Runtime 的 Attention 决议创建 Run；Provider 顺序活动、显式最终 Reply 与完成。持久 Run、输入处置、Timeline 顺序、Thread Reply 无重复；SSE 驱动 Web 可见状态 | 17–21、37、44.1 |
| SS-3.3 | Send-to-Run 已提交但响应丢失；冻结原始 key/payload/revision，重复请求仅一个输入与 Message。相同 key 改 payload 冲突；恢复读取不重发命令 | 19.2、21.2、44.2 |
| SS-3.4 | 超过 100 条活动，分页、断线后有限补读、重复/乱序回放均不丢失、重复或重置已加载历史 | 26、37.2–37.3 |
| SS-3.5 | depth 4 可准入、5 拒绝；root 同时非终态上限 50，Waiting 占位，只有终态提交释放；释放后重试不重复准入且保持来源 | 25.1–25.2 |
| SS-3.6 | 可信报告 digest、固化、重开和重试；相同字节在不同 Run 保留独立 descriptor；父子或兄弟不可互读，不存在与越界读取不可区分 | 21.3–21.5、23 |
| SS-3.7 | 崩溃/重开保留已提交事实，不保留未提交工作；新 Runtime 只从持久输入继续，不需要长寿命 Agent 内存 | 20–21 |
| SS-3.8 | schema 18 的公开 lease execution：旧 generation、fenced/expired 活进程不能发布变更、descriptor、成功活动或完成；新 generation 胜出，晚到输出拒绝/隔离，重启与 reconciliation 确定 | 21.5、22、24、38 |
| SS-3.10 | 生产路径 trusted-local 生命周期：正常完成、Human cancel 后停止结果未知并隔离/恢复、独立 fencing 后取消且不误确认 delivery | 20.2、22、24、27、31.1、45 |

**SS-3.8.1** 使用公开 `LocalWorktreeExecutor`，由 Human/Runtime 创建 Run，
在合成 detached Git worktree 执行固定 `write-probe-v1` child。只有固定 digest、
原 handle 正常停止及有效 Writer authority 同时成立，才发布可信报告、活动、Reply
和 completion；HTTP/SSE/Web 显示同一已提交结果。新 lease generation/fencing
拒绝旧 token；正常停止保留 publication window，settlement 后才释放。

**SS-3.8.2** 通过公开 executor options 的 trusted process driver，仅编排固定
probe 的 result、stop request、force request 与原 handle close。逻辑时钟推进到
精确 expiry，runner 显式推进 monitor/grace timer，不用 sleep。旧进程仍 live 时，
拒绝活动（含幂等重放）、Reply、Artifact 固化及成功结束；expiry、stop request
或 force request 本身不证明停止。没有 close 则 `Uncertain`/quarantine，拒绝
同目录 acquisition；晚到原 handle close 可收敛物理状态，但不能复活旧 Writer。
Runtime 失败断言只匹配第 20.2 节定义的稳定 allowlisted diagnostic code 和通用说明，
不得依赖或暴露原始 process error、路径、命令、环境或 Provider 文本。

**SS-3.8.3** 在同一 SQLite 上打开独立 Kernel/Runtime/HTTP/Web composition，
以受控交错代表 executor 重启与并发恢复；不 mock Kernel、不复用 Agent 内存。
新 executor 必须隔离旧 incarnation 未停止的 intent。新的合法 Run Activation
可在从已知合成 base 提供的独立目录完成，旧输出不得污染新结果；旧 receipt 的
晚到停止不得修改新执行。重开和重复恢复保留已提交事实，不重复 Provider 成功。
此场景不声称覆盖真实掉电或跨重启 OS containment。

**SS-3.8.4** `runSystemScenario` 的可选 Worktree 模式只提供固定合成 Git
provisioning、公开 executor 与窄 process controls；Git 使用隔离配置、空 hooks、
固定身份/日期、明确 argument vector 及有界 watchdog。每个 scenario 独占目录，
同库 composition 共享目录所有者并按依赖顺序关闭。显式预期的 Runtime 失败必须
由断言逐个确认；不得忽略其他脚本异常。清理必须释放 held result/close，停止 executor、
取消 monitor/grace/retry timer，再关闭 SQLite；失败路径也遵守该顺序。

**SS-3.9** 普通场景只查询公开投影；仅专门的 schema/crash 边界可检查
数据库字节/布局或在事务内制造进程退出。普通 Provider 脚本不 mock Kernel。
物理执行仅允许已批准的固定受控 tracer 与 SS-3.10 的合成 trusted-local ACP
fixture；不开放 Human Terminal、任意外部 host command、插件市场或宽泛文件系统接口。

**SS-3.10.1** 正常 trusted-local 场景必须经 `createLocalRuntimeHost`、
真实 Runtime、`CopilotAcpAdapter`、`LocalWorktreeExecutor` 和平台原生 owner，
在分配 Worktree 中实际写入文件并执行固定 Node test。最终证据必须同时包含
`StopConfirmed`、绑定正确 ProviderAttempt/policy/permission mode 的 execution receipt、
Completed Run/ProviderAttempt、公开 allowlisted Tool activity、HTTP/SSE/Web 一致投影，
以及对应 delivery 已确认；原始 tool id、命令、路径、payload、session id 和私密
Provider 文本不得进入公开证据。

**SS-3.10.2** stubborn 合成 Provider 必须创建真实 descendant。Human cancel 使用
极短 stop/force grace 形成没有原 handle close 证据的 `Uncertain`，Run 为 Cancelled，
ProviderAttempt 为 Unknown，Worktree 保持 quarantine。场景独立确认
Provider 与 descendant PID 均消失；确认前同目录 acquisition 必须以 `DomainBusy`
拒绝。新建 executor 在同一 SQLite/root 上执行 `recover()` 后仍不得清除
`Uncertain`、quarantine 或 replacement denial。

**SS-3.10.3** 独立 Runtime 必须以执行时捕获的精确 live Writer authority 执行
fence，随后 Human cancel。真实 owner 停止完整进程树；Host 必须传播稳定
`provider_worktree_authority_lost`/`Unknown`，不得降格为成功或普通取消。
重开后 Run 为 Cancelled、ProviderAttempt 为 Unknown、物理停止有确认，
触发该执行的 delivery 仍未确认。只有独立 PID 消失证据成立后，场景才可按
公开 quarantine token/revision/fencing 契约显式解除隔离。

**SS-3.10.4** trusted-local 清理必须先关闭恢复 executor/Kernel，再关闭在线
Controller/SSE/HTTP/Host，并独立等待已记录进程树消失。只有持久 stop receipt
为 `StopConfirmed`/`ForceTerminated`，或场景已独立确认其全部 owned PID 消失，
才可删除一次性目录。失败发生在物理停止确认前时，清理必须失败并保留明确目录，
不得删除可能仍由 Writer 使用的 Worktree。

## 4. 速度、清理与证据

**SS-4.1** 当前 main 的完整 16 场景包本地目标少于 20 秒；单个 in-process 场景通常
少于 300 ms。这是测量目标，不是脆弱的逐测试 wall-clock 断言。
重用同一测试进程但每场景隔离持久目录；只允许极少的 crash/物理边界启动 child。
真实 trusted-local Host/ACP/Git/process-tree 场景是较慢的边界例外。
提供 fresh Node process 重复命令，报告每轮总时间和测试计数；CI 可见。

**SS-4.2** 即使断言失败也关闭 Controller、SSE、HTTP、Runtime 工作、
Provider gate、SQLite 与场景创建的临时目录。清理失败不能通过。
未消费的脚本错误、unhandled rejection、遗留 timer/handle/child 或生成状态
均使测试失败。只清理本场景拥有的明确路径和进程，不扫描/终止其他进程。
不采用强制成功退出掩盖泄漏；超时是失败 watchdog，不是调度机制。
物理 Writer 停止未确认时必须保留其目录并报告清理失败。
速度目标不作为 hosted runner 的失败 deadline：单测试 watchdog 为 60 秒，
清理 hook 为 30 秒，fresh-process 外层 watchdog 为 120 秒。慢磁盘仍报告
真实耗时和目标是否达到，不放宽任何领域断言或 SQLite durability。
应用 timer 由 Vitest fake timers 计数；native TCP/pipe/process/timer 由
`async_hooks` 追踪。唯一预知例外是 Node 自有、不可通过 server.close 取消的
进程级 HTTP Date-header cache timer；该例外不包含应用 timer。

## 5. 公开安全与延后

**SS-5.1** 所有名称、正文、报告、凭据和 Git fixture 都是合成数据。
loopback credential 每次在内存生成，禁止读取真实登录配置、环境 secret、
用户工作目录或外部服务。公开证据只记录测试名、计数、时间、公开 commit/CI
引用，不发布临时绝对路径、token、进程环境或非公开材料。

**SS-5.2** 延后真实外部模型/browser 测试、完整 ACP 协议覆盖、fuzzing、
完整 Cartesian catalog、分布式多主机、通用虚拟时间框架、power-loss 保证和
跨进程草稿恢复。本包不是 OS sandbox，不声称验证 LLM 理解或通用 exactly-once。
SS-3.10 已覆盖受支持 trusted-local 路径上的合成 ACP write/test 与实际 owned
进程树生命周期，但不声称防御恶意本机 owner、主动逃离 owned tree 的 daemon、
任意第三方 Provider 行为或外部 MCP/API exactly-once；这些边界遵循 Core §31.1，
且不能替代最终 exact-head 独立审查。
