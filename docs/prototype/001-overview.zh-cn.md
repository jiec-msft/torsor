# Torsor 最小内核推导

> 简体中文（主要版本） | [English](001-overview.md)

> 状态：工作笔记  
> 更新时间：2026-09-22
>
> 目的：记录当前已经达成的设计共识、仍未解决的问题，以及下一轮推导入口。  
> 注意：本文只记录当前讨论结论，不代表最终产品规格。
>
> **阅读提示：第 1-13 节保留推导历史。第 14 节开始是当前权威的 MVP 内核候选汇总；如有冲突，以第 14 节及之后为准。**

配套的公开交互原型位于 [`mvp-0.1/`](mvp-0.1/)，场景截图和验证索引见
[`mvp-0.1/README.zh-cn.md`](mvp-0.1/README.zh-cn.md)（[English](mvp-0.1/README.md)）。

## 1. 产品目标

Torsor 使用 Human 熟悉的 Channel、Thread、Message 和 Mention 作为协作语言，但不模拟 Human 的串行、迟缓和注意力瓶颈。

核心方向是：

```text
Human-shaped interface
Agent-native execution

像 Human 一样容易协作
但按 Agent 的能力并发、响应和交付
```

一个 Agent 是稳定的身份、配置和能力定义，不是单一常驻进程。一个 Agent 可以同时产生许多执行实例，在多个 Thread 和 Run 中并行工作。

## 2. 当前确认的基础关系

1. 一个 Project 可以有多个 Channel。
2. 一个 Channel 只绑定一个 Project。
3. Channel 包含 Message。
4. 一条 Root Message 可以有 Reply。
5. Thread 只有一层，所有 Reply 都直接指向 Root Message。
6. Human 和 Agent 都可以发 Message、Reply 和 Mention。
7. Message 不等于 Agent Run。
8. Mention 可以产生 Attention，但不必自动产生 Run。
9. Agent 通过 Torsor 提供的 capability 自主创建和管理 Run。
10. 一个 Run 在 Channel 绑定的 Project 中工作。
11. 可写 Run 使用独占 Worktree。
12. 不同 Run 不得并发写同一个 Worktree。
13. 同一个 Agent 可以同时拥有多个 Run。
14. 同一个 Thread 也可以包含同一个 Agent 的多个 Run。
15. Thread 是公开协作空间，不是唯一执行 Session。

## 3. 当前最小对象

### 3.1 Project

提供代码、配置和执行边界。

### 3.2 Channel

绑定一个 Project，承载公开协作。

### 3.3 Message

Human 或 Agent 的持久化表达。Message 可以是 Root Message 或一级 Reply。

Agent Message 必须记录真实来源，例如：

```text
author_agent_id
caused_by_attention_id
caused_by_run_id
```

具体字段可以后续调整，但不能只记录一个无法追溯的 Agent 显示名。

### 3.4 Agent

稳定身份和配置，不是单一进程或单一 Provider Session。

同一个 Agent 可以同时实例化多个执行者：

```text
Agent Fixer
├─ Instance A：处理 Thread 1
├─ Instance B：处理 Thread 2
├─ Instance C：处理 Thread 1 的新 Attention
└─ Instance D：独立 Review
```

### 3.5 Attention

某条 Message 需要某个 Agent 处理的持久化事实。

Attention 激活 Agent 实例，但不等于创建 Run。

Agent 实例可以在处理 Attention 时调用 Torsor capability：

```text
create_run
list_runs
get_run
send_input_to_run
pause_run
cancel_run
resume_run
reply
mention
publish_artifact
ignore_attention
```

能力名称尚未最终确定。

### 3.6 Run

Agent 创建和管理的一条持久工作线。

Run 可以：

- 经历多次 Agent 激活。
- 等待 Human 或外部条件。
- 产生 Message 和 Artifact。
- 创建子 Run、Fork、Successor 或 Replacement Run。
- 被暂停、取消或完成。

Run 不是一次 LLM 调用。

Run 进入 `Completed`、`Failed` 或 `Cancelled` 等终态后，不应被旧实例重新变回 `Running`。后续工作创建关联的新 Run。

### 3.7 Worktree Lease

保护可写工作空间的独占写入。

```text
一个 Worktree
→ 同时最多一个有效 Writer
```

多个 Agent 实例可以读取或管理同一个 Run，但不能同时写同一个 Worktree。

### 3.8 Artifact

Run 产生的持久化成果引用，例如：

- commit
- patch
- branch ref
- 调查报告
- Review 结论
- 测试日志

Artifact 必须不可变并可追溯到来源 Run 和基础版本。

## 4. Agent Instance 与 Activation

Agent Instance 或 Activation 是 runtime 执行概念，不一定需要成为用户可见的长期领域对象。

但协议和审计至少需要：

```text
activation_id
agent_id
caused_by_attention_id 或 caused_by_run_id
capability scope
observed revision / event cursor
```

Agent 实例的隐藏 LLM 上下文不是共享真相。其他实例只能依赖 Torsor 中持久化的 Message、Run、Artifact、状态和事件。

## 5. Torsor 与 Agent 的责任边界

### 5.1 Torsor 负责

- 保存 Project、Channel、Message、Attention、Run 和 Artifact。
- 给 Agent 提供读取、发消息和管理 Run 的 capability。
- 认证 Human 和 Agent 身份。
- 将 capability 调用绑定到服务端签发的 Activation Context。
- 保证 capability 调用幂等。
- 保护 Worktree 单 Writer。
- 原子更新 Run 状态。
- 拒绝旧 revision 覆盖新状态。
- 记录来源和因果关系。
- 暴露 Provider 支持的能力。
- 允许 Agent 使用已授予的 CLI、API、MCP 或插件能力完成外部操作。
- 当 Torsor 管理某项外部能力时，限制其授权范围，并持久化重要操作的请求身份、幂等键、结果和外部引用。
- 返回操作失败、版本冲突和资源冲突。
- 保留 Human 的强制停止能力。

### 5.2 Agent 负责

- 判断新消息是不是工作请求。
- 决定继续、Fork、新建、替换或 Ignore。
- 创建和管理 Run。
- 判断多个 Run 是否重复或语义冲突。
- 决定哪个方向继续。
- 创建临时协调 Run。
- 暂停、取消或替换其他 Run。
- 综合多个 Artifact。
- 根据有效 Prompt、当前上下文和 capability 判断工作何时完成。
- 决定是否创建 PR、等待 CI、合并、部署或只发布 Artifact。
- 向 Human 解释结论。
- 必要时 Mention 其他 Agent 或请求 Human 判断。

### 5.3 Human 负责

Human 不必参与每次协调，但保留最终控制：

- 停止工作。
- 改变目标。
- 配置 Agent 的 Prompt、capability 和预期结果。
- 选择候选方案。
- 拒绝 Agent 的协调结论。
- 在不可自动决定的问题上作选择。

## 6. 冲突分类

### 6.1 机械冲突

Torsor 必须直接阻止：

- 两个实例同时写同一个 Worktree。
- 旧 Run revision 覆盖新 revision。
- 同一个 Attention 因重试重复产生相同副作用。
- 已取消的 Run 被旧实例恢复。
- Artifact 来源被伪造。

主要保护机制：

```text
idempotency key
entity revision
expected revision
atomic state transition
Worktree Lease
immutable Artifact
```

### 6.2 执行冲突

例如一个实例请求暂停 Run，但 Provider 仍在执行。

Torsor 必须区分：

```text
stop requested
provider accepted
stopped gracefully
force terminated
```

不能假设所有 Provider 都支持立即 Interrupt、Steer、Pause 或 Resume。

### 6.3 语义分歧

例如：

```text
R1：问题来自缓存
R2：问题来自代理配置
```

Torsor 不负责理解自然语言并宣布存在语义冲突。

Torsor 提供：

- 完整 Thread。
- 活跃 Run。
- Run 状态和来源。
- Artifact 和基础版本。
- 消息和事件顺序。

Agent 读取这些信息后，自主判断是否需要协调、验证或请求 Human 决策。

## 7. 并发原则

### 7.1 高度并行

以下行为默认可以并行：

- 不同 Thread 的 Attention。
- 同一个 Agent 的不同 Run。
- 同一个 Thread 中的独立 Run。
- 不同 Worktree 上的调查和修改。
- 多个 Agent 实例读取相同状态。
- 多个 Agent 实例发布有明确来源的 Message。

### 7.2 局部原子提交

只有操作同一个受保护资源时需要局部串行：

```text
Attention 副作用 → idempotency
Run 状态变化    → expected revision
Worktree 写入   → exclusive lease
Artifact         → immutable provenance
```

这不是中央 Coordinator，而是局部并发控制。

### 7.3 按需协调

复杂 Thread 可以由 Agent 自主创建协调 Run：

```text
R1：实现
R2：独立调查
R3：协调 R1 与 R2 的冲突
```

Lead 或协调 Run 不是内核固定角色，也不是所有操作必须经过的中心。

## 8. Provider 边界

Torsor 不需要知道 Provider 内部：

- 调用了几次 LLM。
- 什么时候检查新输入。
- 一轮执行了多少工具。
- 是否存在安全边界。
- Prompt 如何组织。

Torsor 只依赖 Provider Adapter 暴露的外部能力，例如：

```text
accepts_input_while_running
supports_cancel
supports_resume
supports_session_continuation
supports_graceful_pause
```

这些名称尚未最终确定。

如果 Provider 不支持实时 Steer，新 Agent 实例仍然可以：

- 立即回复 Human。
- 保存后续输入。
- 创建新的并行 Run。
- 请求停止旧 Run。
- 创建 Replacement Run。

## 9. 当前确认的不变量

1. Channel 只绑定一个 Project。
2. Reply 与 Root Message 必须属于同一个 Channel。
3. Thread 只有一层。
4. Message 不等于 Run。
5. Mention 不等于自动执行。
6. Agent 是身份和配置，不是单一执行进程。
7. 同一个 Agent 可以有多个并发实例和 Run。
8. 同一个 Thread 可以包含多个 Run。
9. 同一个 Attention 的相同逻辑副作用必须幂等。
10. Run 状态有单调递增的 revision。
11. 冲突状态转换必须基于 expected revision。
12. 终态 Run 不能被旧实例重新激活。
13. Message 中的“完成了”不等于 Run 权威状态已经完成。
14. 一个可写 Worktree 同时只有一个 Writer。
15. Artifact 不可变并可追溯到来源 Run。
16. Agent Message 必须记录来源 Attention 或 Run。
17. 晚到结果可以保留，但不能覆盖较新的平台事实。
18. 语义分歧不由 Torsor 内核自动裁决。
19. Agent 可以创建协调 Run 处理复杂冲突。
20. Human 始终保留最终停止和改变方向的能力。
21. Thread 中的 Message 和相关事件具有稳定、单调的顺序。
22. Agent Reply 可以记录它生成时所依据的 Thread event cursor。
23. 普通交流允许交叉发布，不因 Thread 出现任意新消息而全局串行。
24. 需要最新上下文的 Reply 可以使用条件发布；Thread 已变化时，Torsor 不发布并返回新增事件。
25. Message 条件发布只保护对话时效性，不能替代 Run revision 或 Worktree Lease。
26. Message 发布失败时，其中的 Mention 不得单独产生 Attention。

## 10. 当前不需要进入内核的概念

- 通用 Task。
- 通用 Decision。
- 通用 Result。
- 通用 Approval。
- 固定 Lead Agent。
- 中央 Agent Coordinator。
- 唯一 Response Authority。
- Agent 级全局 Session。
- Thread 级全局发言锁。
- 一个 Agent/Thread 只能有一个 Run。
- AgentInstance 作为长期用户可见对象。
- 所有 Provider 都支持的统一 Interrupt。
- 平台自动理解自然语言并判断语义冲突。

## 11. 当前明确保留的未知问题

1. 普通 Reply 没有再次 Mention Agent 时，是否产生 Attention。
2. Run 在发出“完成”回复后何时进入终态。
3. 物理 Worktree 在 Run 等待或暂停时保留多久。
4. Agent 配置更新是否影响正在运行的 Run。
5. Run 的“完成”是否只由有效 Prompt 表达，还是需要持久化一个最小的 expected outcome。
6. Provider 不支持 Steer 时，后续输入的统一交付语义是什么。
7. Reply capability 是否要求每次显式选择并发发布或条件发布，还是将并发发布作为默认行为。
8. Thread revision 应包含哪些事件：仅 Message，还是 Run 状态、Artifact 和其他 Thread 可见事件。

此前“多个候选 Artifact 如何进入真实集成流程”的问题已经解决：

- Torsor 不设置中央 Integration Manager。
- 普通 Agent Run 根据自己的有效 Prompt、capability 和上下文决定是否创建 PR、等待 CI 或合并。
- 多候选方案需要综合时，Agent 可以自行创建普通协调 Run；它不是固定内核角色。
- 外部仓库的 Branch Protection、Required Review 和 CI 决定操作最终能否被接受。

## 12. 上下文时效性

Human 在 Slack 中无法保证回复永远基于最新消息。常见行为是：

```text
并行阅读和思考
发现新消息后重新判断
已经发布过时回复时再补充修正
```

Torsor 可以使用 Thread event cursor 提供更可靠的乐观并发能力。

Agent 读取 Thread 时获得：

```text
observed_through_event = 42
```

发布 Reply 时可以选择：

```text
allow_concurrent
```

即使 Thread 已经变化，仍然发布，并记录该回复基于哪个 event cursor。

或者：

```text
require_unchanged
```

只有 Thread 仍处于所观察版本时才发布。Thread 已变化时，Torsor 不发布，并把新增事件返回给 Agent 重新判断。

这个能力适合：

- 普通进度或独立发现使用并发发布。
- 最终综合、方向改变和依赖完整最新上下文的回复使用条件发布。

Torsor 不分析 Message 内容来决定哪种模式。语义选择仍由 Agent 完成。

条件检查与 Message 发布必须是同一个原子操作，不能先检查再无条件发布。

## 13. 下一轮工作

下一轮重新检查当前最小内核的：

- 完备性：关键交互是否都能表达。
- 自洽性：对象、状态和责任边界是否互相矛盾。
- 表达能力：复杂协作是否必须提前引入 Task、Decision、Result、Approval 或中央 Coordinator。
- 最小性：是否存在尚未被具体故事证明必要的对象。

## 14. MVP 内核候选 v0.1

本节综合前面的场景推导，并补齐身份、权限、Attention 消费、Run 生命周期、RunInput、Provider 投递、崩溃恢复、Worktree fencing、Artifact、同步、预算和 GC 等实现边界。

### 14.1 总体原则

```text
Human-shaped interface
Agent-native execution
Durable facts
Provider-neutral runtime
Local atomic protection
No central semantic coordinator
```

具体含义：

1. 使用 Channel、Thread、Message 和 Mention 作为 Human 熟悉的协作界面。
2. Agent 是可并发实例化的逻辑身份，不模拟 Human 的串行注意力。
3. Message、Attention、Run、RunInput 和 Artifact 是持久事实。
4. Provider Session、LLM Turn 和工具循环不是领域真相。
5. Torsor 保护身份、权限、幂等、revision、fencing、来源和终态边界。
6. Agent 判断消息含义、语义冲突和最佳协调方式。
7. 只在争用同一资源时局部原子化，不引入全局 Coordinator。

### 14.2 权威对象模型

```text
Project
└─ Channel(project_id, visibility scope)
   ├─ Message(thread_root_id, immutable revisions)
   │  └─ Attention(message_revision_id, target_agent_id)
   │
   └─ Run(home_channel_id, owner_agent_id, state, revision)
      ├─ RunInput(message_revision_id, sequence, disposition)
      ├─ Artifact(content_digest, base_revision, provenance)
      ├─ RunLink(kind, related_run_id)
      └─ Worktree(base_revision, generation)
         └─ WriterLease(holder_kind, holder_id, fencing_token)
```

运行层必须持久化，但不作为主要用户协作对象：

```text
ActivationAttempt
ProviderAttempt
CapabilityContext
IdempotencyRecord
OutboxEvent
AuditEvent
```

### 14.3 核心语义

```text
Message
= 公开表达

Attention
= 某个 Agent 需要对一个 Message revision 作出决定

Run
= 一个 Agent 在一个 Project/Channel 范围内管理的持久工作线

RunInput
= Agent 将某个 Message revision 纳入某个已有 Run 的持久事实

ProviderAttempt
= 一次实际 Provider 请求、Session 投递或执行尝试

Artifact
= Run 产生的不可变成果引用
```

严格保持以下不等式：

```text
Message != Attention
Attention != Run
Run != ActivationAttempt
RunInput disposition != Provider delivery
Artifact produced != Artifact integrated
Agent identity != Agent instance
```

## 15. Identity、认证与权限

### 15.1 Agent 和 Activation

1. `Agent` 是稳定 Principal。
2. Agent Instance 不拥有新的长期身份。
3. 每次 Activation 使用短期、可撤销、范围受限的 Capability Context。
4. Capability Context 至少绑定：
   - `agent_id`
   - `activation_id`
   - 触发 Attention 或 Run
   - Project
   - home Channel
   - 允许操作的 Run
   - 有效期
5. Provider 不获得长期 Agent 凭据。

### 15.2 服务端权威来源

以下字段只能由 Torsor 根据 Capability Context 写入：

```text
author_agent_id
caused_by_attention_id
caused_by_run_id
activation_id
agent_config_revision
```

Provider 或 Agent 请求中的同名字段不能成为权威事实。

### 15.3 Run 的可见性边界

1. MVP Run 必须绑定一个 `home_channel_id`。
2. Run 默认只接受该 Channel 中的 Message revision。
3. Project 是代码和资源边界，但不是足够的消息可见性边界。
4. 跨 Channel Run、跨 Channel Artifact 分享和 Project 级私有 Run 推迟。
5. 每次 capability 调用重新检查当前授权；不能只依赖 Token 未过期。
6. Provider 已获得的上下文无法召回，因此投递前必须最小化上下文。

### 15.4 Agent 配置版本

1. Run 创建时固定 `agent_config_revision`。
2. 每次 Activation 记录实际使用的配置版本。
3. Agent 配置更新不自动改变已存在 Run。
4. 现有 Run 采用新配置必须显式执行 `adopt_config_revision`。

## 16. Message 和 Thread

### 16.1 Message revision

1. Message 使用 append-only revision。
2. 编辑命令必须携带 expected Message revision。
3. UI 默认显示最新 revision，并允许查看历史。
4. MVP 删除只创建 tombstone，不抹除历史引用。
5. 已创建的 Attention、RunInput 和 ProviderAttempt 不因编辑或删除被秘密撤销。

### 16.2 Thread 结构

1. Thread 只有一层。
2. 所有 Reply 直接指向 Root Message。
3. Thread 是公开协作空间，不是 Agent Session。
4. 一个 Thread 可以包含多个 Agent、多个 Run 和多个候选 Artifact。

### 16.3 Thread 事件顺序

1. 每个 Thread 有稳定、单调的 event cursor。
2. cursor 包含 Thread 中语义可见的事件：
   - Message 创建、编辑、删除
   - Artifact 发布
   - 公开 Run 状态变化
3. cursor 不包含 ProviderAttempt、Lease 续期和内部重试。
4. 不要求所有 Project 或 Channel 共享全局总序。

### 16.4 Reply 上下文时效性

Reply capability 使用通用条件提交，而不引入复杂 freshness 对象：

```text
reply(
  observed_thread_cursor,
  optional expected_thread_cursor
)
```

规则：

1. 未提供 `expected_thread_cursor` 时，允许并发追加。
2. 提供时，只有 Thread 未变化才发布。
3. 条件失败时，不发布 Message，也不创建其中的 Attention，并返回新增事件。
4. 普通进度和独立发现默认允许并发追加。
5. 综合结论、方向改变和取消说明，默认 Agent 策略使用条件发布。
6. Reply 是否过时不改变 Run、Worktree 或 Artifact 的权威状态。

## 17. Attention

### 17.1 触发方式

MVP 默认：

1. 显式 Agent Mention 产生 Attention。
2. 显式系统操作可以产生 Attention，例如 Run 失败后请求 Agent 恢复。
3. 普通 Reply 不自动唤醒曾参与 Thread 的 Agent。
4. Thread watch、订阅和自动通知所有参与 Agent 推迟。
5. Agent Mention 自己默认不产生 Attention；自调度使用显式 capability。

### 17.2 唯一性

同一个：

```text
(message_revision_id, target_agent_id, trigger_kind)
```

最多创建一个 Attention。

Message 发布与 Attention 创建必须在同一数据库事务中完成。

### 17.3 状态机

```text
Open
├─→ Resolved
└─→ Ignored
```

Attention 决议记录：

- outcome
- actor
- activation
- 时间
- 创建或更新的 Run
- 创建的 RunInput
- 发布的 Reply
- Ignore reason

### 17.4 并发消费

1. Runtime 使用短期 handler lease，避免无限重复激活。
2. 最终 `resolve_attention(expected_revision)` 只能有一个提交成功。
3. 同一个 Attention 的副作用使用稳定派生幂等键。
4. Attention 不自动过期。
5. 老 Attention 仍是未处理事实；UI 显示年龄，Agent 可显式 Ignore。

### 17.5 Message 编辑的影响

1. 新 revision 新增 Mention 时，创建新 Attention。
2. 移除 Mention 或 tombstone 不自动撤销已有 Attention。
3. Activation 同时获得触发 revision 和当前最新 revision。
4. Human 如需停止已触发工作，使用显式取消或停止操作。

## 18. Run

### 18.1 最小状态机

```text
Active ⇄ Waiting
Active/Waiting ─→ Paused ─→ Active

任何非终态 ─→ Completed
任何非终态 ─→ Failed
任何非终态 ─→ Cancelled
```

含义：

- `Active`：Run 可以接受 Activation 和继续工作，不表示 Provider 正在执行。
- `Waiting`：等待 Message、Human 或外部条件，可按策略重新激活。
- `Paused`：禁止新工作，必须显式 Resume。
- `Completed`：目标完成，当前 RunInput 已明确处置。
- `Failed`：当前工作线无法完成。
- `Cancelled`：工作线被明确终止。

瞬时 Provider `Running` 不属于 Run 生命周期。

### 18.2 状态权威

1. Message 中说“完成”不能改变 Run 状态。
2. 只有显式 capability 可以改变权威状态。
3. 所有状态变化携带 expected Run revision。
4. 终态 Run 不可重新激活。
5. 后续工作创建 Successor、Retry 或 Replacement Run。

### 18.3 RunLink

不为 Fork、Retry、Replacement、Coordination 分别创建对象。

统一使用：

```text
RunLink
- parent
- fork
- retry
- successor
- replacement
- coordination
- review
```

协调 Run 可以关联多个 Run。

### 18.4 终态规则

#### Completed

1. 同一事务检查 expected Run revision。
2. 不允许存在 `Pending` RunInput。
3. Agent 可以批量声明输入处置到某个 sequence，并列出例外。
4. 新 RunInput 与 Complete 竞争同一个 Run revision。
5. 最终摘要 Message 可以在同一组合 capability 中原子发布，但不是强制要求。
6. MVP 使用显式、幂等的 `complete_run` capability；Provider 回合结束、进程退出或发布 Message 都不能隐式完成 Run。
7. 不新增 `CompletionDeclaration` 领域对象。完成摘要、Artifact 和外部引用作为 `complete_run` 的可选参数和既有对象关系保存。

#### Failed

1. ProviderAttempt 失败不自动令 Run Failed。
2. Agent/Human 或恢复策略明确放弃工作线时，Run 才进入 Failed。
3. Failed 不被 Pending RunInput 阻止。
4. 未明确处置的 Pending RunInput 自动变成 `Abandoned(reason=run_failed)`。
5. 可以在同一事务中转交给 Retry 或 Replacement Run。

#### Cancelled

1. Human 取消和安全停止不能被输入清理阻塞。
2. 逻辑取消先发生，Provider 停止异步进行。
3. 未明确处置的 Pending RunInput 自动变成 `Abandoned(reason=run_cancelled)`。
4. 取消不默认级联子 Run；Human 或 Agent 明确选择目标集合。
5. 暂时停止使用 Paused，不使用 Cancelled。

### 18.5 终态后的输入

1. 终态 Run 拒绝新 RunInput。
2. capability 返回终态和创建 Successor 的建议。
3. Agent决定创建 Successor、加入其他 Run、只回复或 Ignore。

## 19. RunInput

### 19.1 定义

RunInput 是不可变分配事实：

> 某个 Agent 在某次 Activation 中，将某个 Message 的特定 revision 分配给某个已有 Run。

最小字段：

```text
id
run_id
message_revision_id
run_input_sequence
assigned_by_principal_id
assigned_by_activation_id
source_attention_id
created_at
disposition
disposition_revision
```

### 19.2 创建规则

1. Agent 可以通过 capability 创建 RunInput。
2. Human 可以在 Run Workbench 中使用 `send_to_run`；该组合操作原子创建 home Thread Message 和对应 RunInput。
3. Human 直接发送到 Run 时，`assigned_by_principal_id` 记录 Human；不伪装成 Agent 判断。
4. 同一 `(run_id, message_revision_id)` 默认唯一。
5. Message 新 revision 可以产生新 RunInput。
6. 同一 Message revision 可以分别加入不同 Run。
7. RunInput 创建时原子分配单调递增的 `run_input_sequence`。
8. RunInput 创建会增加 Run revision。
9. Human `send_to_run` 必须携带观察到的 `expected_run_revision`；不是可选字段。revision 检查、公开 Message、Human-assigned RunInput、revision 增加和投递 Outbox 在同一事务内提交。
10. Client 提交状态与 RunInput `Pending` disposition 分离。确定的事务拒绝不产生 Message 或 RunInput；响应丢失则提交结果未知，不能据此声称两者未提交。

### 19.3 语义 disposition

```text
Pending
Incorporated
Declined
Superseded
Withdrawn
Abandoned
```

含义：

- `Pending`：仍需要该 Run 明确处置。
- `Incorporated`：Agent 明确声明已纳入当前 Run 的工作或结果。
- `Declined`：Agent 判断与当前 Run 无关或无需行动，必须记录原因。
- `Superseded`：转给其他 RunInput 或 Successor Run，必须记录链接。
- `Withdrawn`：来源 Human 或 Agent 明确撤回。
- `Abandoned`：因 Run Failed、Cancelled 或不可恢复原因未处理，必须记录原因。

### 19.4 Completed 的批量处置

避免逐条 capability：

```text
complete_run(
  expected_run_revision,
  incorporated_through_input_sequence,
  exceptions,
  optional summary,
  optional final_message_id,
  optional artifact_refs,
  optional external_refs
)
```

Torsor 检查：

1. 调用 Activation 被提供过相关 RunInput。
2. sequence 范围内每条输入都有明确处置。
3. 新输入没有在思考期间加入。
4. Superseded 的目标有效。

Torsor只能证明 Agent被提供过输入并作出声明，不能证明 LLM真正理解正确。

`complete_run` 的自然组合操作可以是：

```text
发布最终 Thread Reply
+
处置 RunInput
+
Run → Completed
```

三者可以原子提交，但最终 Reply 不是所有 Run 的硬性要求。只读后台维护、
外部等待和无公开结果的 Run 仍可在没有新 Message 的情况下显式完成。

## 20. ProviderAttempt 和 RunInput 投递

### 20.1 分层

```text
RunInput disposition
= Agent 的语义处置

ProviderAttempt
= 机械交付和执行事实
```

Provider接收输入绝不自动等于 `Incorporated`。

### 20.2 ProviderAttempt 最小结果

```text
Started
Acknowledged
Completed
Failed
Unknown
```

每次记录：

- adapter/version
- capability snapshot
- activation
- 输入 RunInput IDs
- 请求幂等键
- 开始和结束时间
- 结果或 Unknown 原因

### 20.3 Provider 能力

Adapter 暴露带版本的 capability profile，例如：

```text
accepts_input_while_running
supports_cancel
supports_resume
supports_session_continuation
supports_graceful_pause
supports_idempotent_input
```

未知能力一律视为不支持。

### 20.4 不支持实时 Steer

1. RunInput 仍立即持久化。
2. 不伪造 Delivered 或 Accepted。
3. Runtime 在下一次 Activation 中从 durable RunInput 重建上下文。
4. Agent如果认为等待太慢，可以创建并行或 Replacement Run。

### 20.5 交付保证

```text
本地领域副作用：effectively-once
外部 Provider 投递：at-least-once 或明确 Unknown
语义处理：由 RunInput disposition 表达
```

不能承诺通用端到端 exactly-once。

## 21. Activation、幂等和崩溃恢复

### 21.1 ActivationAttempt

至少记录：

```text
activation_id
agent_id
cause
scope
config_revision
started_at
finished_at
outcome
```

Activation 是运行记录，不是主要用户对象。

### 21.2 幂等

幂等作用域：

```text
(principal_id, capability_name, idempotency_key)
```

规则：

1. 保存 payload hash 和完整结果。
2. 相同 key、不同 payload 必须冲突。
3. 幂等记录至少与其创建或修改的持久对象同寿命。
4. 不能因短期日志 GC 而允许旧请求再次产生副作用。

### 21.3 事务 Outbox

以下组合使用同一数据库事务和 Outbox：

- Message 发布与 Attention 创建
- RunInput 创建与投递调度
- Run 状态变化与通知
- Artifact descriptor 与上传完成事件

外部 Worker 可以重复消费 Outbox。

首个可信 Artifact 切片只固化不可变报告字节。Torsor 必须先接收有界字节或字节流、
自行计算 SHA-256、确认内容已持久落盘，再在现有 Kernel 事务中原子写入
descriptor、`ArtifactPublished`、`artifact.published` Outbox 和完整幂等结果。
存储失败不得发布 descriptor；Outbox 不是“将来再上传”却已可下载的承诺。

### 21.4 过期 Activation

1. 所有 Run 变更要求 expected revision。
2. Worktree 写入要求当前 fencing token。
3. Run 终态、权限撤销或 Attention 已决议后，旧 scope 失效。
4. 旧 Provider 输出可以保存为 late output，但不能自动改变领域状态。

### 21.5 Reconciler

Runtime 定期恢复：

- 未完成 Outbox
- 过期 Activation
- Unknown ProviderAttempt
- Open Attention
- Suspect Writer Lease
- 未完成 Artifact 固化

所有恢复操作继续使用幂等键。

报告固化以 `(principal_id, run_id, idempotency_key)` 标识一次请求。相同请求的
字节、expected Run revision 必须相同，否则冲突。提交响应丢失后，重试返回原
Artifact 和原始 provenance，不重复发布事件。新 Activation 只有在当前授权允许
读取该 Run 时才可重试；重试不是重新使用旧 Activation 权限的途径。

首片采用调用方重试恢复，不后台重放 Provider 输出：临时写入期间崩溃只留下不可见
临时文件；内容已发布但数据库未提交只留下不可见的内容寻址 blob；数据库提交后
响应丢失可通过持久幂等结果和 Run/Thread 投影恢复。重试复用并核对既有 blob，
在事务中再次检查当前权限、Activation 和 Run revision。权限撤销或 Run 终态
阻止新 descriptor；已提交 descriptor 仍由当前获授权的 Human/Runtime 查询。
首片不自动删除 orphan 或 staging 文件，避免与并发固化竞争；清理留给停机维护。

持久因果限制与可信 Artifact 的整合数据库使用 schema **15**，同时保留第 25 节的
Run root/parent/depth、不可变约束、准入索引及持久配置，以及第 23 节的可信报告
descriptor。此前 causal-only schema 14 和独立开发的 Artifact-only schema 14
均不兼容；不得因版本数字相同而接受另一套布局。打开任何旧版或未版本化的非空
开发数据库必须在应用 DDL/Bootstrap 前明确拒绝，不迁移、不改写版本、不删除数据。
停止旧进程后由操作者显式重建可丢弃数据库。schema 15 重开仍校验持久 causal 配置。

`user_version = 15` 不是布局证明。已有数据库必须在任何 DDL、Bootstrap 或配置写入
之前，以只读方式对照由可信 DDL 在隔离内存库生成的完整 schema 指纹：对象集合、
列/type/not-null/default/PK/FK、索引/唯一性/partial predicate、trigger、CHECK
和 STRICT 等约束。比较 SQLite 解析后的 metadata 与保留 literal/operator 语义的
SQL token；只忽略空白、注释和未引用 keyword/identifier 大小写，不删除字符串内空白。
缺失、额外不兼容、部分、损坏、前驱形状或未来布局必须拒绝，保持原文件字节及逻辑
状态不变，不用 `CREATE IF NOT EXISTS` 修补。SQLite 自有统计对象不属于应用布局。
只有没有持久对象的 version 0 数据库可在同一事务内执行 DDL、初始配置及 Bootstrap；
失败完整回滚。有效 schema 15 重开不重新应用 Bootstrap，也不修改持久 causal 配置。

Runtime Host 调度恢复 pass 时，连续执行的 pass 数量必须有界，并在继续前让出事件循环并重新检查关闭请求。积压处理不得饿死 HTTP、timer、signal 或关闭处理。空闲轮询等待必须可被关闭请求中断；无论等待还是关闭先完成，都必须移除对应 listener 并取消不再需要的 timer。

## 22. Worktree 和 Writer Lease

### 22.1 所有权

1. 物理 Worktree 属于一个 Run。
2. Writer Authority 属于当前 Agent Activation 或 Human Principal。
3. 一个 Worktree 同时只有一个平台认可的 Writer Authority；Human 可以强制接管，但系统必须报告旧进程仍未停止的风险。
4. Lease 带单调递增的 fencing token。

### 22.2 创建

1. writable Run 不必立即创建 Worktree。
2. 第一次需要写操作时惰性创建。
3. 创建时固定：
   - repository identity
   - base commit/content revision
   - Run
   - Worktree generation

### 22.3 Lease 过期

Lease 过期不能证明旧进程已停止。

禁止：

```text
Lease 超时
→ 直接把同一目录交给新 Writer
```

必须：

1. 确认旧进程已停止；或
2. 将旧目录标记 `Suspect/Quarantined`；并
3. 从已知 base/checkpoint 创建新的 Worktree generation。

### 22.4 Pause、Cancel 和 GC

1. Waiting/Paused 停止执行后释放 Writer Lease。
2. Provider未停止时，Worktree保持隔离。
3. Cancel 不立即删除 Worktree。
4. 先停止进程、固化必要 patch/log，再进入保留期。
5. 只有满足以下条件才 GC：
   - Run 终态
   - 无 active/suspect Writer
   - 必要 Artifact 已固化
   - 保留期结束
   - 无调查或保留要求

## 23. Artifact 和集成

### 23.1 Artifact 身份

权威引用必须不可变：

- commit SHA
- patch digest
- immutable blob digest

可移动 branch ref 只能作为辅助元数据。

Artifact 记录：

```text
content_digest
producer_run_id
producer_activation_id
base_revision
media_type
byte_length
producer_thread_root_id
visibility_scope
```

首片报告使用 `sha256:<lowercase hex>`，固定 `text/plain; charset=utf-8`，
`base_revision` 为 Torsor 生成的 `run:<id>@<expected revision>`，不声称是 Git
commit。来源 Run、Activation、Thread 和 home Channel 从可信上下文推导。
Provider 提供的 digest、descriptor、文件路径或 `file://` URL 均不具有权威性。
普通 `PublishArtifact` 命令必须拒绝；只有接收字节的可信 finalizer 可进入发布事务。

报告上限为 1 MiB；流还限制为最多 4096 个 chunk。finalizer 复制输入字节后计算
digest，存储适配器不接收 Provider 路径。窄接口只有不可变写入与按 digest/长度读取；
适配器由可信 Host 静态配置，不向 Provider 暴露。相同 Run/digest 保留一个
descriptor；其他 key 重复发布同一内容返回冲突，不改写 provenance。

父子 Run 可以固化相同字节并复用一个内容寻址 blob，但必须各有独立 descriptor、
来源 Run/Activation/Thread 和幂等作用域。Artifact 通过 `producer_run_id` 追溯到
Run 的不可变 causal root、parent Attention/Run 和 depth，不另存可漂移的因果副本。
父子关系和相同 digest 均不授予跨 Run 读取权。固化、下载、失败和重放都不创建或
释放 Run 名额、不重写因果来源，也不处置 RunInput 或隐式完成 Run；重启后的
Run/Thread 及分页投影必须同时保留 causal 字段和 Artifact 引用。

开发/测试本地布局为私有 root 下 `sha256/<64 hex>` 和 `staging/<random>.tmp`。
先独占创建临时文件、写入并 flush，再用不覆盖目标的原子 hard-link 发布；同名目标
必须核对长度、digest 和全部字节，不得覆盖。读取同样核对长度和 digest。
拒绝非法 digest、路径穿越、符号链接/目录联接和非普通文件。root 及其祖先必须由
可信 Host 控制，不可放在 Provider/Worktree 可写范围；此适配器不是对同一 OS 用户
恶意并发改写的沙箱。POSIX 同时 flush 目录；Windows 支持进程崩溃/重启恢复，但不
承诺 portable Node API 无法提供的目录 flush/断电持久性。生产远端存储另行实现接口。

### 23.2 权限

1. Artifact 默认继承 Run 的 home Channel 可见性。
2. 每次 descriptor 查询和下载重新检查当前 Principal、Project、home Channel、
   Run/Activation scope；读取异步存储之后、返回字节之前再次检查。
3. 首片公开契约只有 Artifact ID 和 descriptor，不暴露内部路径或直接存储 URL。
   HTTP 使用 `GET /api/v1/artifacts/:id` 和 `GET /api/v1/artifacts/:id/content`；
   持有 ID/digest 不是授权。响应禁用缓存，内容按 attachment/plain text 返回。
4. 当前本地权限模型中 Human/Runtime 拥有全局读取权，Agent 受实时 Activation
   的 Project/Channel/Thread/Run scope 限制；不在本片新增 ACL 管理系统。
   如后续使用短期签名 URL，它不能绕过当前权限复核。
5. Agent 只能读取 `producer_run_id = scope.runId` 的平台 Artifact metadata；
   Attention scope 没有 Run，因此不含任何 Artifact。此规则同时适用于当前/历史
   Thread 与 Run 投影、列表、分页、条件提交的 catch-up 错误、事件和 SSE，以及
   Runtime 提供给 Provider 的上下文；同 Thread、亲属关系或相同内容不扩大授权。
   不返回被过滤 Artifact 的列表项、数量、digest、来源或事件 payload。显式公开
   Message 的正文仍是 Channel/Thread 沟通，不因此变成 descriptor 或读取授权。
6. 查找 Artifact ID 前先校验 Principal 和当前 Activation/scope。已授权调用者的
   不存在及不可见 ID 均返回相同的 `NotFound`（HTTP 404）、通用 message 和响应
   headers，不附带存在性、存储或来源详情，不读取不可见 blob。未认证仍为 401；
   stale/revoked scope 的确定性错误在查找前产生，与 ID 是否存在无关。
7. 过滤不阻断有界扫描：`scannedThroughEventId` 继续推进，它是 opaque 高水位而非
   隐藏报告的数量或身份。SSE 对过滤尾部发送只含 opaque `cursor` 的 `checkpoint`
   事件并设置 `id`；Client 的原生重连及替换连接采用该高水位，不合成 Artifact
   timeline 条目、不暴露过滤 payload，也不清空已加载历史或 Composer 状态。
   条件提交的 catch-up 最多扫描 100 个事件，同时返回 `scannedThroughEventId`
   和 `hasMore`，过滤发生在扫描之后。Artifact 事件不通过跨窗口 BroadcastChannel
   转发或接收；每个窗口只消费自己的已认证流，旧连接不能覆盖新 scope 的游标。

### 23.3 集成

1. 不增加全局 mutable `Accepted` 状态。
2. Agent 根据有效 Prompt、当前上下文和已授予 capability，自主决定是否创建 PR、等待 CI、合并或只发布 Artifact。
3. 多个候选 Artifact 需要验证和组合时，Agent 可以创建普通协调 Run；Torsor 不内置固定的 Integration Run 类型或中央 Integration Manager。
4. 任何写入或组合工作的 Run 仍使用独占 Worktree。
5. 创建 PR 是提交集成建议；只有 PR 被 merge 后，结果才真正进入目标分支。
6. Torsor 持久化重要外部操作的来源 Run、Worktree generation、source commit、目标仓库/分支、幂等键、操作结果和外部引用。
7. PR、CI 和 merge 的实时状态仍由外部系统权威维护；Torsor 不复制完整的 GitHub 状态机。
8. Artifact 采用关系由后续 Run、Artifact、Message、RunLink 和外部引用表达。
9. 外部主分支、部署或受保护资源是否需要 Human Approval，由 Agent Prompt、capability 授权和外部保护规则共同决定，不加入通用 Approval 对象。

### 23.4 Artifact 输入

MVP 不新增 `ArtifactInput`。

Artifact 通过 Thread 中的 Message 或卡片引用，再将该 Message revision 分配为 RunInput。

引用只使用已固化 Artifact ID；引用、报告文本和 Provider 输出都不自动授予读取权、
创建 RunInput 或完成 Run。Runtime 的可选 `publish_report` capability 只接受稳定
请求 key 和报告文本，不接受 digest/location/provenance；任意 ACP
`publish_artifact` 仍禁用。

## 24. Provider 取消、暂停和 Resume

### 24.1 Resume

`resume_run` 只保证：

> 在同一逻辑 Run 上创建新的 Activation。

是否复用 Provider Session 只是优化。

### 24.2 Pause 和 Cancel

1. 先原子改变 Torsor 逻辑状态。
2. 撤销新副作用权限和 Writer Lease。
3. 再异步请求 Provider 停止。
4. UI 独立显示逻辑状态和 Provider 执行状态。

### 24.3 Provider 不支持 Cancel

Run仍可立即逻辑 Cancel：

- 旧 capability 被拒绝
- Worktree 被隔离
- Provider termination 显示 pending/unknown
- 晚到输出不能自动发布、改变 Run 或处理 RunInput

### 24.4 Unknown 是否重试

只有 Adapter 能证明操作幂等时才自动重试。

否则保留 `Unknown`，由后续 Activation读取事实并决定。

## 25. 委派、循环和预算

### 25.1 因果链

首个持久因果限制切片使用以下不可变 Run 来源：

```text
causal_root_id
parent_attention_id
parent_run_id
delegation_depth
```

1. `causal_root_id` 是发起请求的 Human Message ID，而不是 Thread ID 或 Provider Session。Human 的 `StartThread`、`ReplyToThread` 和 `SendToRun` 所发布的新 Message 各自开启新 root；同一 Message 的多个 Mention 共享 root。
2. 当前所有新 Run 都通过 `ResolveAttentionWithRun` 创建。Kernel 从已认证的 Attention Activation、Attention 的确切 Message revision 和该 Message 的服务端来源推导字段；`parent_attention_id` 是本次决议的 Attention ID。
3. Human Message 直接触发的 Run 的 `parent_run_id = null`、`delegation_depth = 0`。Agent 的 `PublishRunReply` 或 `CompleteRun.finalReply` 触发的新 Run 使用 Message 的 `caused_by_run_id` 作为 parent，继承该 Run 的 root，并将 depth 加一。父 Run 已进入终态也不重置来源或深度。
4. Attention 通过不可变 Message revision 和 Message 来源追溯因果链，不复制一套可漂移的预算字段。没有可信 Human 或 Run 来源时必须拒绝创建，不能退回到新 root。
5. 将 Attention 接入已有 Run、Human Send-to-Run、Activation/Provider 重试均不重写已有 Run 来源，也不创建新的 Run 容量占用。已有 Run 后续发布的委派继续使用该 Run 的原始 root，而不是最新输入的 root。
6. Agent/Provider payload 中的 root、parent、depth 或 limit 字段不能成为权威事实；Kernel 拒绝显式提交的这些服务端字段。当前切片不新增直接 Fork、Retry、Successor 或 Replacement 创建命令；未来创建路径必须复用同一准入边界。

### 25.2 预算 envelope

首个切片只实施两个硬限制，已批准的初始默认值为：

```text
delegation depth: 4
max non-terminal Runs per causal root: 50
```

1. 最大 depth 为包含端点的 4（初始 Run 为 0）；同一 root 的非终态 Run 总数最多为 50，包含初始 Run，跨该 root 的所有 Agent 计数。
2. 数值属于服务端 `KernelOpenOptions.causalLimits`，不是 Agent 配置或命令参数。创建新数据库时持久化默认值或显式配置；所有连接及重启从同一持久配置读取。重开时显式指定不同值必须明确失败。当前不提供在线改限额命令。
3. Kernel 在同一 `BEGIN IMMEDIATE` 事务中推导来源、检查 depth、从持久 Run 状态计算占用、创建 Run/RunInput、决议 Attention、写入事件、Outbox 和幂等结果。多个 SQLite 连接竞争最后一个名额时最多一个成功。
4. `Active` 和 `Waiting` 均占一个名额；Activation 数量、Provider 状态、Lease 过期和进程退出不释放名额。未来的 `Paused` 也属于非终态。
5. 只有 `Completed`、`Failed`、`Cancelled` 的成功提交释放该 Run 的一个名额；不递归释放子 Run，也不表示 Provider 已停止。终态事件与容量证据原子提交。终态 parent 的待处理 Attention 仍可创建子 Run，但必须保留原 root/depth 并重新检查容量。
6. 容量是当前非终态 Run 的计数，不是累计 Run 数或预付费余额。成功命令重放返回原幂等结果，不再次计数；新逻辑 Run 才占新名额。失败事务完整回滚，不留下 Run、输入、决议、事件、Outbox 或幂等结果。
7. 超限返回 `CausalLimitExceeded`，包含 root、拟创建 depth、当前占用、有效限制和触发的维度。Attention 保持 Open，handler authority 不被该失败消费，Agent 可以显式 Ignore、继续已有 Run，或在条件改变后重试；不得静默丢弃或伪装成功。
8. Project/Agent 并发配额、fan-out、Attention 速率、Provider 成本、预算划分和完整 policy language 均推迟；本切片不承诺这些维度已受限，也不增加 UI budgeting。

### 25.3 默认 Agent 策略

1. 没有新证据时不重复 Mention 同一 Agent 处理同一事实。
2. 不创建同类重复 Replacement。
3. 协调优先读取和管理现有 Run。
4. 预算接近上限时请求 Human。

## 26. 多客户端同步

1. 事件具有稳定 `event_id` 和可恢复 cursor。
2. 客户端按 event ID 去重。
3. cursor 已被压缩时，返回快照和新 cursor。
4. HTTP command response 与实时事件可能乱序。
5. 客户端依据实体 revision 和 event ID 合并，不能依赖到达顺序。
6. 窗口路由、滚动位置和草稿默认属于客户端本地状态。

## 27. 隐私和最小上下文

1. Activation 默认只获得：
   - 触发 Thread
   - 关联 Run
   - 显式 RunInput
   - 必要 Artifact
2. 不自动获得整个 Channel 历史。
3. 扩大读取范围需要 Channel 权限和显式 capability。
4. Mention 无权限 Agent 时，MVP 默认整条发布事务失败，避免产生“看似通知成功”的 Message。
5. MVP只支持 tombstone；法务硬删除、加密擦除和租户保留策略在正式多租户发布前单独设计。

## 28. 审计、指标和可解释性

### 28.1 最小审计字段

```text
event_id
actor principal
activation_id
causation_id
correlation_id
entity revision before/after
idempotency key
timestamp
result
```

敏感 Prompt 和隐藏思维不默认写入审计日志。

### 28.2 基础指标

- Open Attention 年龄
- Pending RunInput 数量
- ProviderAttempt Unknown
- stale revision 冲突
- late output
- suspect Worktree Lease
- Run 终态延迟
- 委派深度
- 预算消耗

本切片将后两项具体化为：Run 投影中的不可变 root、parent Attention/Run 和 depth；`RunCreated` 事件中的来源、有效限制及提交后非终态占用；`RunCompleted`、`RunFailed`、`RunCancelled` 事件中的 root 和释放后的占用；超限响应中的准入证据。占用以同一事务内的持久 Run 状态为准，可由创建/终态事件解释，不使用进程内计数器。拒绝创建不提交新的领域事件；重启保留已有来源、配置和事件。成本核算及其他预算指标仍推迟。

### 28.3 可解释性

从 Message、Run、RunInput、RunLink 和 Artifact 可以追溯到原始 Human Message。

不要求保存完整隐藏思维过程。

## 29. UI 必须保持的事实差异

不能把以下内容压缩成一个 `Running/Done`：

- Run 逻辑状态
- Provider 执行状态
- Stop requested
- Provider stop confirmed
- RunInput disposition
- Provider delivery outcome
- late output
- Worktree quarantined

Human 优先看到通俗状态：

```text
已加入 R1
等待 R1 处理
正在处理
已转交 R2
未处理：Run 已失败
已取消，Provider 停止仍待确认
```

## 30. GC 和长期保留

### 30.1 不可作为普通日志删除

- Message revision
- Attention 决议
- Run
- RunInput disposition
- Artifact descriptor
- 终态事件
- 关键幂等记录

### 30.2 可按策略 GC

- Provider 原始日志
- Session handle
- 临时输出
- 终态 Worktree
- 可重建缓存

GC 不得改变领域状态。

## 31. 完备性结论

当前 MVP 内核可以表达：

- Human/Agent Channel 和 Thread 协作
- 显式 Mention 和 Attention
- Agent自主创建和管理 Run
- 同 Agent 多实例并发
- 多 Agent 委派
- RunInput 可靠归属和 Provider-neutral 投递
- Provider 不支持 Steer/Cancel/Resume
- Worktree 单 Writer 和故障隔离
- Run Retry、Fork、Replacement、Coordination
- Artifact 产生、Agent 自主外部操作和可选协调 Run
- 多客户端同步
- Message 编辑和删除历史
- 上下文时效性
- Late output
- Crash recovery
- 委派循环和预算控制

当前没有发现必须引入以下对象的证据：

- Task
- Decision
- Result
- Approval
- 中央 Coordinator
- 全局 Agent Session
- 唯一 Response Authority
- Workflow DAG
- Artifact 全局 Accepted 状态

## 32. 仍需 Human Review 的少量产品选择

以下问题无法仅靠技术原则得到唯一答案。本文已经给出推荐默认值：

1. **普通 Reply 是否自动通知曾参与 Thread 的 Agent**
   - 推荐：MVP Mention-only。
2. **Run 是否永远绑定 home Channel**
   - 推荐：MVP 是。
3. **现有 Run 是否固定 Agent 配置版本**
   - 推荐：固定，显式升级。
4. **完成 Run 是否必须发布公开摘要**
   - 推荐：不强制；支持原子链接摘要。
5. **哪些代码集成或部署必须 Human Approval**
   - 推荐：由 Agent Prompt、capability 授权和外部受保护系统共同决定，不加入通用 Approval。
6. **数据硬删除和保留期限**
   - 取决于部署和隐私承诺。
7. **预算、深度和并发默认数值**
   - 首个切片已批准最大 depth 4（root Run 为 0）、每个 causal root 最多 50 个非终态 Run；服务端持久配置及容量语义见 §25.1–25.2。成本、fan-out 和其他预算维度仍待后续设计。
8. **Waiting、Paused、Failed、Cancelled Worktree 的物理保留期限**
   - 作为运行配置。
9. **Human 是否需要直接 Send-to-Run**
   - 已由 Run Workbench 场景证明必要。MVP 支持原子创建公开 Message 和 Human-assigned RunInput。
10. **无权限 Mention 是整条 Message 失败，还是只让 Mention 失败**
    - 推荐整条事务失败。

这些是 Review 点，不阻塞内核对象和不变量的成立。

## 33. 建议实现顺序

1. Principal、Capability Context 和服务端来源字段。
2. Message revision、Thread event cursor 和 Attention。
3. Run、Run revision、RunLink 和状态机。
4. RunInput、disposition 和终态事务。
5. IdempotencyRecord、Outbox 和 Reconciler。
6. ActivationAttempt、ProviderAttempt 和 capability negotiation。
7. Worktree generation、Writer Lease、fencing 和 quarantine。
8. Artifact digest、存储、外部操作结果/引用和 integration capability。
9. 多客户端同步、UI 状态和观测指标。
10. 预算、递归限制和 GC。

## 34. Torsor 设计宪章

后续迭代不必反复重述全部背景。可以使用以下目标描述：

> **设计一个最小而语义闭合、Agent-native、可组合、可追溯、可恢复、可演进的协作内核。Human 使用熟悉的 Channel、Thread 和 Message；Agent 通过 capability 自主并发工作；Torsor 只固化事实并保护硬边界；Provider 和 UI 都是可替换适配层。新增能力优先成为 capability、runtime resource 或现有对象的 view projection，只有具体故事证明无法表达时才增加领域对象。**

更直接的产品定位是：

> **Torsor 是 Human 和 Agent 的协作与执行平台，不是替 Agent 做语义决策的中央管理者。平台提供能力和边界，Agent 负责理解、判断和行动，Human 保留观察、指导、接管和停止的权力。**

责任关系可以简写为：

```text
Prompt             决定 Agent 应该做什么
Capability         决定 Agent 能够做什么
Torsor             固化事实并保护机械边界
External system    决定外部操作最终能否被接受
Human              保留最终控制和介入能力
```

检查任何新设计时，使用以下十条：

1. **最小内核**：没有具体故事证明必要，不新增领域对象。
2. **语义闭合**：每个用户可见事实都有明确来源、持久化位置和状态变化。
3. **责任分离**：Agent 做语义判断；Torsor 保护机械不变量；Provider 负责执行；Client 负责视图组合。
4. **Agent-native 并发**：不因模拟 Human 而人为串行；只对争用的具体资源局部加锁。
5. **Provider-neutral**：不把某个 Provider 的 Session、Turn、Steer 或 Interrupt 模型写进领域内核。
6. **可追溯和可恢复**：任何重要行为可追到 Human Message、Attention、Run、RunInput 和 Artifact；崩溃后能从持久事实恢复。
7. **最小权限和安全失败**：身份、授权、revision、idempotency、Lease 和 fencing 由平台强制。
8. **投影式 UX**：页面、Tab、面板和 Workspace 是领域对象与 runtime resource 的组合视图，不自动成为新领域对象。
9. **平台而非中央管理者**：Torsor 提供 capability、事实、隔离、观测和控制；不硬编码 Agent 必须采用的工作流、固定角色、评论或集成步骤。
10. **插件式外部能力**：Agent 已能直接使用的 CLI、API 或 MCP 不由 Core 重写；只有当 Torsor 需要管理凭据、事件、状态、权限或 UI 时，才通过窄插件接口接入。插件不能扩张或绕过 Core 不变量。

以后可以简写为：

> **按 Torsor 设计宪章推导：平台提供能力和边界，Agent 负责判断和行动，Human 保留控制权；同时保持最小内核、语义闭合、Agent-native 并发、Provider-neutral、可追溯可恢复，以及投影式 UX。**

## 35. Run Workbench

### 35.1 定义

`Run Workbench` 是面向 Human 的工作现场视图，不是新的领域对象。

它投影已有对象和 runtime resource：

```text
Run Workbench
├─ home Channel / Thread
├─ Run 和 RunInput
├─ Agent Message
├─ Run Activity Stream
├─ ProviderAttempt
├─ Worktree / Files
├─ TerminalSession
└─ Artifact
```

它可以在 UI 中继续叫 `Workspace`，但领域模型中不要增加另一个与 Project、Run 和 Worktree 重叠的 Workspace 对象。

### 35.2 入口

1. Human 从 Thread 中点击 Run 状态卡进入 Run Workbench。
2. Workbench 顶部显示 Agent、Run 状态、Project、home Channel、Worktree generation 和 Provider 状态。
3. 所有页面保留返回原 Channel/Thread 的入口。
4. 一个 Client Window 可以打开多个不同 Run Workbench。
5. 不同 Client Window 的当前 Tab 相互独立。

### 35.3 推荐视图

```text
Conversation  - Thread 上下文、直接 Send-to-Run
Live          - Agent 的 typed activity timeline 和固定 Run composer
Files         - Run Worktree 文件与变更
Terminal      - 观察或控制 TerminalSession
Artifacts     - commit、patch、报告和日志
Activity      - Run、ProviderAttempt、Lease 和状态时间线
```

这些 Tab 是 Client view state，不是领域对象。

首片通过既有 Run/Thread 的 Artifact 投影提供已固化报告的 digest、长度、media
type 和 Run/Thread 来源，并通过授权 HTTP 接口下载。尚未固化的 Provider 文本、
临时文件和 orphan blob 不得显示为已发布 Artifact。存储缺失、篡改、权限变化或
下载失败必须显式失败，不能显示空白成功。新增 Artifacts UI、GitHub 状态机、
Worktree 执行、通用插件市场和 ArtifactInput 均不属于本片。

初始页面、历史回填和实时替换均遵循 §23.2 的当前 scope，不能把同 Thread 的
其他 Run 报告混入 Agent 的列表或计数。过滤 checkpoint 只更新恢复游标，不构造
报告条目或重置 Timeline/Composer；切换认证 scope 后不得保留前一 scope 的投影。

`Live` 不应是静态 Run Dashboard。推荐按时间顺序投影：

```text
Human RunInput
Agent user-visible output
Tool started / completed / failed
File change
Provider or delivery status
Artifact / external reference
Run completion
```

Run 状态、Worktree generation、Pending inputs、child Runs 和 diff stat
压缩到 Header 或可展开的摘要，不应长期占据主要阅读区域。

生产 Web 的 Live Agent Timeline 首先投影已经存在的持久事实：可见 delta、
公开 status、RunInput、ProviderAttempt 和显式 Run 终态。Timeline 是主要阅读区，
Activation 等诊断信息可折叠；保留来源 Thread、窄视口导航和键盘可访问性。
本切片不改变 Human Run Composer，也不伪造尚无 Producer 的 Tool Call 或文件事件。

## 36. Human 直接 Send-to-Run

Run Workbench 中的输入框不是绕过 Channel 的私有 Provider 输入。

它执行一个原子组合操作：

```text
send_to_run(
  run_id,
  message_body,
  expected_run_revision
)

→ 在 Run 的 home Thread 创建 Human Message
→ 创建引用该 Message revision 的 RunInput
→ 增加 Run revision
→ 调度 Provider delivery 或下一次 Activation
```

规则：

1. Message 对 Thread 中其他参与者可见。
2. RunInput 记录 `assigned_by_principal_id = Human`。
3. 不创建目标 Agent Attention，因为 Human 已明确选择 Run。
4. Message 中如包含其他 Agent Mention，仍可原子创建那些 Agent 的 Attention。
5. 终态 Run 拒绝 Send-to-Run，并让 Client 提供创建 Successor 的操作。
6. Provider 不支持实时 Steer 时，RunInput 保持 Pending，Human仍立即看到“已加入 Run”。
7. Message 和 RunInput 必须一起成功或一起失败。
8. Web 使用现有 `POST /api/v1/commands/send-to-run`，请求包含 `idempotencyKey`、`runId`、`body` 和必填 `expectedRunRevision`；目标 Thread 和 Agent 由 Run 决定，不能改走普通 Reply 或直接 Provider 输入。
9. 一个提交身份固定 Human Principal、Run、正文、revision 和幂等键。响应丢失、网络错误、不可读响应或服务端结果不确定时，保留该身份；恢复必须重试同一请求，不能以新 revision 或新 key 猜测重发。幂等重放返回原结果，即使 Run 已推进或进入终态。
10. 当前凭据失效时要求重新认证，并保留草稿和提交身份；恢复必须使用原 Human Principal。旧凭据请求的迟到 `401` 不得清除替代会话，可在同一 Principal 的替代凭据下重试原请求。恢复中的认证/权限拒绝不能证明之前的未知提交未发生。
11. 明确的 stale revision 或 terminal Run 事务拒绝不创建任何一半；保留草稿，刷新事实供 Human 重新判断，不自动修改 revision 重发。终态不允许新发送；若 Client 尚无 Successor 创建能力，明确显示不可用并引导 Human 回到公开 Thread 请求后续工作，不提供虚假操作。

这不是普通 `@Agent` 的替代：

```text
@Agent
= 请 Agent 自己判断新建、接续、Fork 或 Ignore

Send-to-Run
= Human 已明确选择这条工作线
```

## 37. Streaming Output

### 37.1 不等于 Message

Agent streaming output 属于 runtime activity，不自动成为 Thread Message。

```text
Provider token/delta
→ RunActivityEvent
→ Workbench Live view
```

只有 Agent显式调用 `reply`，或 Adapter 有明确的 final-public-response 映射时，才创建持久 Message。

当前 ACP Adapter 的 `agent_message_chunk` 经 capability bridge 的
`AppendRunActivity` 持久化后才进入 Timeline。delta、status、Provider 回合结束、
HTTP 读取和 SSE 重放都不得自动发布 Message、处置 RunInput 或完成 Run。

### 37.2 RunActivityEvent

它是运行记录，不是新的协作领域对象。

至少包含：

```text
run_id
activation_id / provider_attempt_id
sequence
kind
timestamp
payload reference
retention class
```

可包括：

- user-visible assistant delta
- tool started/completed
- tool failed/cancelled
- public RunInput delivery update
- file change summary
- Artifact or external reference published
- status update
- provider reconnect
- delivery retry
- terminal output reference

活动身份和顺序以服务端分配的 `id` 和 Run 内单调 `sequence` 为准，不以
timestamp、HTTP 返回顺序或 SSE 到达顺序为准。SQLite 写入活动、分配 sequence
和公开 invalidation event 必须原子提交。Run projection 默认仅含最近 100 条；
这不是完整历史。`ListActivity` / HTTP activity API 每页有界，支持 exclusive
`afterSequence` 向前续读和 exclusive `beforeSequence` 向后回填；向后页仍按
sequence 升序返回，`nextCursor` 指向该页最早 sequence。同时提供两个边界时，
在有限区间内向前读取。Client 每次显式加载较早历史最多读取 100 条。

### 37.3 安全边界

1. 不展示或持久化隐藏 chain-of-thought。
2. 只展示 Provider明确标记为 user-visible 的输出和工具活动。
3. Streaming output 不得改变 Run 权威状态。
4. 断线重连通过 `sequence` 从保留窗口内续读。
5. 长期保留的是最终 Message、Artifact 和审计事实；原始 token stream 可以按策略 GC。
6. 如果 streaming draft 最终对应一条 Message，可以记录关联，但二者仍是不同事实。
7. Tool Call 使用稳定 call ID；Started、Completed、Failed 和 Cancelled 更新同一条时间线记录，而不是生成互不相关的卡片。
8. Client 只有在 Human 仍位于时间线底部时自动跟随新输出；Human 向上滚动后停止强制滚动，并显示“回到最新”。
9. Tool Call 默认折叠，运行状态始终可见；Human 按需展开参数、命令、输出、diff 或错误。
10. UI 不展示隐藏 chain-of-thought。可展示的是 Agent 明确公开的计划、状态说明和 Provider 标记为 user-visible 的 reasoning summary。
11. SSE 只使投影失效，不是活动正文或状态权威。Client 从认证 HTTP 读取持久事实；
    重放、重复、乱序通知和重连必须按活动身份去重并按 sequence 排序，保留已加载历史。
    新窗口与已加载末尾之间的缺口以每页最多 100 条、固定读取上界补齐，不追逐无限增长的 head。
12. 后台刷新不得卸载 Timeline 或夺走焦点。向前追加时，Human 向上滚动后保持阅读位置；
    向前部插入历史时保持可见条目及其相对位置。`Back to latest` 显式恢复跟随。
    切换 Run 重置该视图的历史、错误和跟随状态；旧 Run/旧 session 的迟到响应不得写入新视图。
    窄视口 Drawer 的延迟焦点操作必须在切换或卸载时撤销，且不能夺走 Human 已在 Drawer 内选择的焦点。
13. 历史读取失败必须可见、可重试，且不得清空已有条目或把未知历史显示成完整历史。
    认证、跨窗口 session 更新、授权范围及 revision fencing 继续适用于所有补读请求。
14. Composer 的组合刷新和单独 Run 刷新必须使用同一 Timeline 历史合并规则；不能以最近 100 条替换已加载历史。
    Run 的刷新归属包含有界的缺口补读；与 Thread 读取仍各自独立。
    组合结果发布前完成的较早历史回填必须保留。补读失败遵循第 44.2 节的组合读取失败语义，
    不改变已确认提交的回执、待恢复身份、另一 Run 的草稿、阅读锚点或跟随状态。

## 38. Files

Files Tab 是 Worktree 的读取投影，不是新的 File 领域对象。

规则：

1. 文件树根目录固定在当前 Run 的 Worktree 或只读 Project snapshot。
2. 不暴露 Host 任意文件系统。
3. Human 可以在 Agent工作时查看文件和 diff。
4. 文件内容可能随 Agent写入变化；读取结果带 Worktree generation、path 和内容 hash。
5. Client 可以提示文件已变化并刷新。
6. MVP Files Tab 默认只读。
7. Human编辑文件需要获得当前 Worktree Writer Lease，或进入单独派生的 Worktree。

## 39. TerminalSession

### 39.1 定义

Terminal 是需要持久 runtime identity 的资源：

```text
TerminalSession
- origin_run_id
- initial_working_directory
- creator_principal
- process identity
- status
- controller lease
- output sequence
```

Tab 只是 TerminalSession 的一个 Client view。关闭 Tab 不一定终止 TerminalSession；多个 Client 可以观察同一个 Session。

### 39.2 Human 完整控制

`New Terminal` 默认启动完整、可交互的 Human Shell。

原则：

1. Torsor 不解析、过滤或限制 Human 输入的命令。
2. Human 可以编辑、创建、删除文件，运行任意程序，启动后台进程，执行 Git 操作，或者离开初始目录。
3. Terminal使用 Human 自己的 OS 权限，不继承 Agent 的长期凭据。
4. 从 Run Workbench 打开时，初始 cwd 是该 Run 的 Worktree；`origin_run_id` 只记录入口来源，不限制 Terminal只能操作该 Run。
5. Terminal行为不自动变成 Message、RunInput、Artifact 或 Run状态变化。
6. Torsor 可以记录 Terminal 的创建、关闭和控制权变化，但不要求把完整命令历史或输出永久写入审计日志。

### 39.3 Human 与 Agent 的写入交接

Human 能做任何事情，不表示 Torsor 应悄悄允许 Human 与 Agent 自动化实例同时争抢同一 Worktree。

打开以 Run Worktree 为初始目录的完整 Terminal 时：

1. Human 获得该 Worktree 的 Writer Authority。
2. Torsor 请求 Agent停止写入，并撤销 Agent Writer Lease。
3. 如果旧 Agent进程无法确认停止，UI 明确显示存在并发写入风险；Human仍可选择强制接管并自行处理进程。
4. Human控制期间，可以打开多个 Terminal 并执行任意命令。
5. Human结束控制后，Agent不能直接假设 Worktree未变化；新的 Activation 必须重新读取 Git/filesystem 状态。
6. Torsor记录 `human_intervention`，使后续 Agent和 Artifact provenance 知道 Worktree 曾被 Human直接操作。

Writer Authority 是并发归属，不是对 Human 命令能力的限制。

### 39.4 Writer Authority

自动化写入仍保持：

```text
同一个 Worktree generation
→ 同时只有一个自动化 Writer Authority
```

Holder 可以是：

```text
holder_kind = agent_activation | human_principal
holder_id
fencing_token
```

Human是最高控制者。Human强制接管时，Torsor撤销 Agent权威并诚实报告仍未停止的外部进程；不能谎称操作已经安全回滚。

### 39.5 Terminal 输入并发

1. 多个 Client 可以观察同一个 TerminalSession。
2. 同时只有一个 Client 持有 Terminal controller lease。
3. Controller lease 只避免多个 Client 同时向同一个终端进程交叉输入，不限制 Human在其他 Terminal中操作。
4. Terminal进程结束不自动终止 Run。
5. Run进入终态后，Human Terminal仍可继续运行和修改文件；这些修改不自动改变已终态 Run，也不自动归属于该 Run。

## 40. Workspace 操作菜单映射

截图中的 Workspace 操作可以在 Torsor 中这样映射：

| 工作台操作 | Torsor 语义 |
|---|---|
| 新建 Agent | 选择 Agent，并创建 Attention 或显式新 Run/Fork/Review Run |
| 新建 Terminal | 创建不受命令过滤的完整 Human TerminalSession，初始 cwd 为当前 Run Worktree |
| 文件 | 打开当前 Run Worktree 的 Files view |
| Agent 输出 | 订阅 RunActivityEvent stream |
| 复制 workspace 路径 | 仅本地可信 Client 可见 Worktree path；远程 Client使用逻辑 Run 链接 |
| 导入会话 | Provider/Conversation 导入属于 Adapter 能力，不改变 Message/Run 核心语义 |
| 显示 setup | 展示 Project/Worktree provisioning Activity 和日志 |

Terminal profile 是 Client/runtime 配置，不是 Torsor 协作领域对象。

## 41. 对内核完备性的影响

该场景只新增或提升以下能力：

### 正式提升为 MVP

1. Human `send_to_run`。
2. `assigned_by_principal_id` 支持 Human 和 Agent。
3. Writer Authority 支持 Agent Activation 和 Human Principal，并记录 Human intervention。

### 新增运行层记录

1. `RunActivityEvent`。
2. `TerminalSession`。
3. Terminal controller lease。

### 不新增领域对象

- Workspace
- Tab
- Pane
- File
- Agent draft
- Streaming Message

因此 UI 能获得工作台式的工作现场能力，但不会破坏：

- Channel/Thread 是公开协作来源。
- Run 是持久工作线。
- Worktree 单 Writer。
- Provider-neutral。
- Client view 独立。
- Message 与 runtime stream 分离。

## 42. 桌面协作现场：Conversation Dock、Thread Workspace Tree 与 Split Panes

### 42.1 问题不是缺少返回按钮，而是上下文被替换

上一版使用：

```text
Channel → Thread → Run Workbench
```

作为页面导航。这个关系在领域上正确，但如果 UI 每深入一层就替换上一层，
Human 在观察 Run 时会同时失去：

- 产生工作的 Root Message；
- Thread 中后来出现的新 Reply；
- 同一 Thread 中其他 Run 的进展；
- 当前 Run 与其他 Worktree 的关系。

Agent工作不是普通文档钻取。Human 经常需要一边看对话为什么要求这件事，
一边看 Agent 现在做到了哪里。因此桌面端不应把领域来源实现成只能后退的
导航层级。

推荐改成**同时展开的上下文投影**：

```text
Global navigation
├─ Channel / Thread selection
├─ Conversation Dock
│  ├─ Root Message
│  └─ Thread Replies
└─ Thread Workbench
   ├─ Project / Worktree tree
   └─ split panel canvas
```

`Channel → Root Message → Thread → Run` 仍然是事实来源关系；只是桌面 Client
不再用页面替换表达它，而是用相邻 Panel 表达。

### 42.2 Conversation Dock

Conversation Dock 固定展示当前 Thread 的：

1. home Channel；
2. Root Message；
3. Thread Replies；
4. Reply composer；
5. Message 与 Run、RunInput、Artifact 的轻量来源标记。

打开 Files、Terminal 或 Live 时，Conversation Dock 不消失。Human 可以折叠
或展开它，但折叠是 Client view state，不改变 Thread，也不表示停止关注。

这解决两个实际问题：

- Agent streaming 或文件变化不能让 Human 忘记原始要求。
- 新 Reply 到达时，Human 不需要退出 Terminal 或关闭文件才能看到。

### 42.3 Thread Workspace Tree

当前 Thread 的 Agent Details 首先显示一个树状投影：

```text
Project torsor
├─ Worktree generation 04
│  ├─ Sable · Run R184
│  │  ├─ Agent activity
│  │  └─ Artifacts
│  ├─ Files
│  └─ TerminalSession pwsh-1
└─ Worktree generation 01
   ├─ Keel · Run R185
   │  └─ Review activity
   ├─ Files
   └─ TerminalSession pwsh-2
```

这里的 `Workspace` 只是面向 Human 的名称，默认对应一个具体 Worktree
generation。它不新增领域对象。

必须保留以下边界：

1. 独立写入 Run 默认使用不同 Worktree。
2. 一个 Worktree 中可以同时显示 Agent、Files、Terminal 和 Artifact Tab，
   但这些 Tab 不代表多个自动化 Writer。
3. 如果多个 Agent 节点指向同一 Worktree，必须明确其中哪些只读，或者它们
   是同一 Run 的不同 Activation；不能因此绕过单 Writer Authority。
4. 点击文件节点，会在右侧工作区打开带
   `worktree_generation + path + content_hash` 的 File Tab。
5. 点击 Agent 节点打开 Live/Activity Tab；点击 Terminal 节点打开对应
   TerminalSession。

树是 Run、Worktree、TerminalSession 和 Artifact 的组合投影，不是新的
持久层级真相。

### 42.4 Split Pane Canvas

桌面工作区允许将 Tab 放入多个 Panel：

```text
左右分屏：

┌─ Sable Live ─────────┬─ index.html ─────────┐
│ streaming + activity │ file content / diff  │
└──────────────────────┴──────────────────────┘

上下分屏：

┌─ Keel Review ───────────────────────────────┐
├─ Terminal pwsh-1 ──────────────────────────┤
└─────────────────────────────────────────────┘
```

推荐支持：

- split right；
- split down；
- move Tab to another Panel；
- close Tab / close Panel；
- collapse Conversation Dock；
- collapse Workspace Tree；
- reset layout。
- 将当前 Tab 移动到另一个 Panel。

这些都是 Client view state。MVP 可以只在当前 Client 本地保存布局；以后可选
同步布局偏好，但不应把 Pane、Tab 或 split tree 放进协作内核。

同时打开两个 Panel 不复制领域对象：

- 两个 File Tab 可以观察同一内容 revision；
- 多个 Client 可以观察同一 TerminalSession，但 controller lease 仍只有一个；
- Live Panel 订阅 RunActivityEvent；
- Conversation Dock 订阅 Thread event cursor。

### 42.5 为什么这种 UI 与 Torsor 宪章一致

1. **最小内核**：只增加投影组合，不新增 Workspace、Tab 或 Pane 领域对象。
2. **语义闭合**：每个 Panel 都显示来源，例如 Thread、Run、Worktree
   generation、TerminalSession 或文件 hash。
3. **责任分离**：Client 决定布局；Torsor 继续保护 Run revision、Writer
   Authority 和 Terminal controller lease。
4. **Agent-native 并发**：Human 可以同时观察多个并发 Run，而不是被迫逐页
   查看。
5. **Provider-neutral**：Live Tab 消费统一 RunActivityEvent，不依赖某个
   Provider 的 Session UI。
6. **可追溯和可恢复**：Conversation 始终在场，执行输出不会脱离工作请求。
7. **安全失败**：多 Panel 不等于多 Writer；冲突和控制权仍明确展示。
8. **投影式 UX**：树、Tab、Panel 和布局都只是现有事实的视图。

### 42.6 全局 Activity Center

当 Agent 在很多 Thread 中并发工作时，只靠逐个 Channel 浏览会失去整体态势。
因此值得提供一个全局 `Activity` 入口，但它仍然是投影，不是新的 Task 对象。

Activity Center 聚合：

```text
Attention
Run / RunInput
RunActivityEvent
ProviderAttempt
Worktree conflict
Artifact
Human intervention
```

默认按 Human 的处理需求分组，而不是展示原始事件洪流：

1. **Needs you**：需要 Human 决定、冲突、权限、失败和等待确认。
2. **Running**：跨 Project、Channel 和 Thread 的活跃 Run。
3. **Recently changed**：新 Message、状态变化和 Artifact。
4. **Completed**：最近完成，可按时间折叠。

每个 Activity item 必须链接回：

```text
Project → Channel → Root Message / Thread → Run（如适用）
```

Activity Center 的边界：

- 它不取代 Channel，也不成为新的工作分配真相。
- 它不把每个 token 或 tool event 都推给 Human。
- 它优先显示“状态发生什么变化、是否需要我、来源在哪里”。
- Agent 状态和 Presence 只是过滤条件；Human 最终回到 Thread 完成协作。

### 42.7 MVP 桌面默认布局

建议宽屏默认：

```text
┌────┬──────────┬────────────────┬──────────────┬─────────────────────┐
│Rail│ Channels │ Conversation   │ Workspaces   │ Split Pane Canvas   │
│    │ Threads  │ Root + Replies │ Project tree │ Live / File / Term  │
└────┴──────────┴────────────────┴──────────────┴─────────────────────┘
```

- Rail：固定窄栏，提供 Channels、Activity、Agents。
- Channels：可折叠。
- Conversation：默认展开，可折叠。
- Workspaces：默认展开，限于当前 Thread。
- Canvas：获得剩余空间，可左右或上下分屏。

这不是把所有信息永久塞在屏幕上。原则是：

> **重要来源默认同时可见；空间不足时由 Human 折叠，而不是由导航替换。**

桌面 Client 至少提供三种可逆的视图状态：

```text
完整上下文
Rail | Channels | Conversation | Workspaces | Run Canvas

Thread 协作
Rail | Conversation | Workspaces | Run Canvas

Run 专注
Rail | Workspaces | Run Canvas
```

规则：

1. Human 可以只收起 Channels，继续保留 Root Message 和 Replies。
2. Human 可以同时收起 Channels 与 Conversation，专注一个或多个 Agent Run。
3. Workspaces 也可独立收起，使单个 Run Timeline 或分屏获得最大空间。
4. 顶部始终保留明确的恢复入口，不能要求 Human 逐层后退。
5. 收起任何 Panel 都只是当前 Client 的 view state；新 Thread Message、Attention
   和 RunInput 仍继续到达。
6. 收起 Conversation 时，Run Header 仍显示来源 Channel/Thread；Human 可以一键
   恢复完整上下文。

### 42.8 仍然不进入内核

- Conversation Dock
- Activity Center
- Workspace Tree
- Editor Group
- Split Pane
- Tab
- Panel layout
- Panel collapse state

它们都可以由现有领域事实和 runtime resource 重建。

## 43. 平台定位与 Agent 自主集成

### 43.1 Torsor 的角色

Torsor 不是项目经理、中央调度大脑或固定工作流引擎。它是 Human 和 Agent
共享的协作与执行平台：

```text
Human / Agent     工作主体
Prompt            工作方式和职责说明
Torsor            协作空间、执行基础设施、事实记录和硬边界
Provider          模型执行能力
GitHub 等系统     外部代码托管、CI、保护规则和最终资源状态
```

Torsor 不替 Agent 判断：

- 一条 Message 是否值得行动；
- 应继续已有 Run 还是新建、Fork、替换或 Ignore；
- 是否需要另一个 Agent Review；
- 工作何时达到语义上的完成；
- 是否应该发 Reply、发布 Artifact、创建 PR 或请求 Human。

Torsor 必须保证：

- 身份和 capability 不能伪造；
- 每个重要行为能追溯到来源 Message、Run 和 Worktree；
- 自动化 Writer 不并发写同一个 Worktree；
- revision、幂等、Lease、fencing 和终态不被绕过；
- 失败、冲突、晚到结果和外部操作结果不会静默丢失；
- Human 可以观察、指导、接管和停止。

### 43.2 PR 和真实集成

最常见的实现 Agent Prompt 可以要求：

```text
完成修改和验证后：
1. 检查完整 diff；
2. 推送自己的分支；
3. 创建 PR；
4. 在来源 Thread 中报告 PR 和验证结果；
5. PR 创建成功后结束本次 Run。
```

自然流程是：

```text
Thread Message
  → Agent 创建 Run 和独占 Worktree
  → Agent 修改、验证和自查
  → Agent 判断达到 Prompt 中的完成条件
  → Agent 调用创建 PR capability
  → Torsor 记录操作结果和外部引用
  → Agent 在原 Thread 回复
  → Run Completed
```

如果 Prompt 要求“负责到 merge”，Run 就继续存在，直到：

- PR 成功 merge；
- 外部规则拒绝；
- 出现需要 Human 介入的冲突或审批；
- Agent 明确失败或 Run 被取消。

创建 PR 与 merge 必须区分：

```text
创建 PR    提交集成建议
merge PR   真正进入目标分支
```

Torsor 不硬编码必须由 Human、Agent 或某个固定 Coordinator merge。最终行为由：

```text
Agent Prompt + capability scope + 外部保护规则
```

共同决定。

### 43.3 最小持久事实

Torsor 不需要复制完整的 GitHub PR 状态机，也不必新增庞大的 Integration
领域对象。MVP 至少记录：

```text
actor principal
source Run
source Worktree generation
source commit
action type
target repository / branch
idempotency key
operation result
external reference
timestamp
```

这些事实可以由审计记录、RunActivityEvent 和 Artifact/外部引用共同承载。
PR 的实时状态继续由 GitHub 权威维护。

### 43.4 下一步设计问题

“谁负责集成”已经不再是内核缺口。下一步应推导：

> **Run 如何表达并证明它已经完成当前 Prompt 所约定的结果？**

需要区分：

```text
调查完成并发布报告
代码修改和本地验证完成
Artifact 已发布
PR 已创建
CI 已通过
PR 已 merge
部署已完成
```

Agent 仍负责语义判断。待决定的是 Torsor 是否只保存有效 Prompt 和
Agent 的完成声明，还是额外保存一个很小的 expected outcome / completion
evidence，使 Human、恢复逻辑和 Activity Center 能理解 `Completed`
具体代表什么。

当前 MVP 结论是：

1. 不增加 `CompletionDeclaration` 对象。
2. 使用显式、幂等的 `complete_run`。
3. Agent 根据有效 Prompt 判断语义上是否完成。
4. Torsor只检查权限、revision、RunInput disposition 和引用归属。
5. Human通过最终 Message、Artifact、外部引用和 Activity 投影理解具体结果。
6. 如果真实场景证明仅靠这些事实无法恢复或审计，再讨论很小的 expected outcome，
   而不是预先建设通用 Result/Approval 系统。

## 44. Agent Timeline、Run Composer 与外部扩展

### 44.1 Agent Timeline 是 RunActivityEvent 的投影

Agent 工作现场应像持续增长的工程记录，而不是一次性报告：

```text
Run source
├─ Human RunInput
├─ Agent visible output
├─ Tool Call
│  └─ command / input / output / error / diff
├─ File or Artifact change
├─ Provider and delivery status
└─ explicit Run completion
```

Timeline item 必须显示其来源类型，但不需要把每种显示节点升级为领域对象。
稳定历史和活跃 streaming head 可以分开传输，Client 再组合成一条连续时间线。

每个活动显示来源类型、原始 kind、Run 内 sequence、timestamp，以及可用的
Activation/ProviderAttempt 来源。已知可见 delta 和 status 使用聚焦的纯文本呈现；
未知 kind 只显示通用活动标记和来源元数据，不执行 HTML，也不猜测或展开未知 payload。
RunInput 和 ProviderAttempt 使用已有投影的当前事实、时间和各自身份；不得伪造
RunActivityEvent sequence。RunInput 的语义 disposition 与 Provider delivery 分开显示。
Run `Active` 不等于 Provider 正在运行，Provider `Completed` 不等于 Run 完成；
Run `Completed`、`Failed`、`Cancelled` 以服务端 Run 状态和 revision 为准。
取消后 Provider 仍为 `Started` / `Acknowledged` / `Unknown` 时，明确显示停止未确认。

### 44.2 Run Composer

每个 Agent Run Pane 底部固定一个 Composer。它明确显示目标 Agent 和 Run：

```text
Send to Sable · R184
Also published in #torsor-core / current Thread
```

发送继续使用第 36 节的原子 `send_to_run`，不依赖 Live Timeline 的实现。

1. Composer 显示目标 Agent 名称和 ID、完整 Run ID、观察到的 revision，以及公开 home Channel/Thread 的明确目的地与返回入口。
2. 提交中显示 `Submitting`，禁止重复提交；未确认前不将乐观 Message 或 RunInput 插入已提交投影。成功显示两者已提交，刷新 Thread 与 RunInput 事实；读取失败只表示投影待刷新，不能撤销已确认的提交。
3. 确定的事务拒绝显示原因及两者均未提交。首次尝试在命令执行前收到带 `requestId` 的结构化 `413/payload_too_large`，且此前没有未知结果时，也属于明确拒绝：释放待恢复请求身份，保留可编辑草稿，允许 Human 缩短或替换正文后以新幂等键再次发送。revision conflict 保留草稿，要求刷新并由 Human 再次发送；终态拒绝不能退化为普通 Reply。
4. 丢失响应或其他不确定结果显示 `Submission outcome unknown`，绝不显示 `Not submitted`。冻结原请求并提供 `Retry same submission`；此前结果未知时，即使重试遭遇认证/权限失败或 `413/payload_too_large`，也继续保留未知状态及原请求身份，直到同一身份的幂等重放确认结果。后续请求在命令执行前被拒绝，不能证明先前请求未提交。
5. 草稿和待恢复身份按 Run 保留为当前 Client Window 的本地状态，跨 Panel 关闭、Run 切换、后台刷新和重新认证保留。旧 Run 的迟到结果只更新该 Run 的提交状态，不清空另一 Run 的草稿或切回旧 Run。此切片不承诺浏览器重载或进程退出后的草稿恢复。
6. 已提交不代表 Provider 已收到、接受或纳入工作。没有公开交付证据时不得显示 `Delivered` 或 `Accepted`；RunInput disposition 独立展示。实时 Steer 能力未知时明确说明不保证即时投递，不阻止持久 RunInput 提交。
7. 提供 label、可感知的 Pending/成功/错误状态、可见焦点、键盘提交和恢复。Enter 在多行正文中换行，Ctrl/Cmd+Enter 显式提交且不能干扰 IME；异步结果不得抢走其他 Run 或控件的焦点。窄视口中目的地、正文、状态和按钮必须可换行/滚动并可通过键盘访问。
8. 未选择/加载到匹配 Run、无可用认证、终态及未实现的 Successor/实时控制能力都有明确说明；不能呈现可点击但无效果的操作。
9. Thread 与 Run 的投影读取各自拥有 replacement、loading 和错误归属，组合刷新不得以共享 freshness 条件丢弃仍有效的一半。某一半被单独刷新或另一组合刷新替代时，只交接该投影的归属；仍有效的一半必须完成或明确失败。替代失败必须传递给等待者；旧响应不得清除新选择、新 Session 或新 Project 的 loading、错误或事实。两半仍有效且成功时一起发布；两半仍有效但任一读取失败时保留原投影并结束 loading，允许重试读取。
10. 已确认提交后的任一投影读取失败，必须在该 Run 的 Composer 内显示可感知的 `Committed; projections could not be refreshed`，包括窄屏 modal；不能只在 modal 外的 inert 主区域报告。Composer 内现有刷新操作只重试读取，不重新提交命令。保留已确认请求的幂等身份与回执，和未确认请求的恢复身份分开；刷新失败不把已提交状态变成未知或可重发命令。刷新状态按 Run 和刷新尝试隔离，跨 Pane 重新挂载保留；旧刷新结果不覆盖较新的刷新，异步状态不抢走 Human 焦点。

### 44.3 Tool Call 展开和失败

默认时间线只显示：

```text
Read src/workbench.ts          completed
Edit src/workbench.ts          running
Shell npm test                 failed
```

Human 展开后才看到：

- 参数和工作目录；
- 截断后的输出；
- changed files 或 diff summary；
- error 和 retry/replace 结果；
- ProviderAttempt 或 TerminalSession 来源。

运行、失败和取消必须在折叠状态下也能区分。展开状态属于 Client view state。

以上 Tool Call 生命周期是后续 Producer 能力的要求，不是本次 Live Timeline
启用 ACP native tools 的授权。当前 Adapter 保持 deny-by-default；不把文本 delta
解析为工具执行，不生成假 Tool Call。当前已存在的 Provider 运行/失败/Unknown 与
Run 失败/取消事实无需展开即可区分，细节按需展开。

### 44.4 外部能力和插件边界

保持 Core 小而浓缩的判断规则：

```text
Agent 可以直接调用，Torsor只关心最终引用
→ 使用 Agent 已有 CLI、API 或 MCP，不需要 Torsor 插件

Torsor需要管理凭据、授权、事件、实时状态或专用 UI
→ 使用窄插件接口
```

插件可以提供 Provider、Runtime、GitHub、Storage、Notification 等适配，但：

1. 不能新增绕过 Principal、revision、idempotency、Lease 或 provenance 的写入口。
2. 插件结果回到 Core 时仍表示为既有 RunActivityEvent、Artifact、外部引用或审计事实。
3. MVP 只需要静态或配置加载的内部 adapter seam。
4. 暂不建设插件市场、动态下载、热更新、复杂依赖解析或第三方沙箱。
5. 至少出现第二种真实集成后，再从共同需求提炼公开插件 SDK。

### 44.5 已证明需要验证的桌面 UX 场景

Prototype 和 evidence 至少覆盖：

1. Channel、Root Message、Replies、Workspaces 和 Run 同时可见。
2. 只收起 Channels，Conversation 继续可见。
3. 同时收起 Channels 和 Conversation，专注多个 Agent Runs。
4. 单个 Agent 的 streaming Timeline、Tool Call 折叠和展开。
5. Tool Call 的 running、completed 和 failed 状态。
6. Run Composer 同时产生公开 Thread Message 和 RunInput。
7. 同一 Thread 中两个 Agent 使用不同 Worktree 并排工作。
8. 不同 Run 修改同一文件时保留独立 Artifact，并显式协调冲突。
9. Failed Run、Replacement Run、Abandoned/Reassigned input 和 late output。
10. 只读调查 Run 没有写入能力。
11. Human Terminal 接管 Writer Authority，但命令不受 Torsor 过滤。
12. Agent 递归委派达到深度或预算限制。
13. Activity Center 聚合跨 Thread 工作，并返回来源 Thread/Run。
14. 一个稳定 Agent 身份在多个 Thread 中并发拥有独立 Run。
15. 多 Client 共享服务端事实，但各自保持独立 Panel、Tab、草稿和滚动状态。
