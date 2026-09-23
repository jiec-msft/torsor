# 运维日志规格

> 简体中文（主要版本） | [English](operational-logging.md)

> 状态：MVP 0.1 schema 18 production integration
>
> 适用范围：trusted-local Host、HTTP、Runtime、Provider process、Writer Authority 与 recovery 的本地结构化运维记录。

本规格细化 [`docs/prototype/001-overview.zh-cn.md`](../prototype/001-overview.zh-cn.md) 第 20、22、28 节的诊断与审计边界，并与 [trusted-local Provider policy](trusted-local-provider-policy.zh-cn.md) 的 schema 18 execution receipt、停止和 quarantine 契约共同生效。

## 1. 输出与所有权

1. 运维日志是本地 NDJSON；每个事件必须恰好序列化为一行 UTF-8 JSON，并以 `\n` 结束。
2. Logger 不提供隐式 stdout/stderr sink。Library Host 必须显式提供 sink。Production CLI 默认使用数据库同目录下的私有 `operational.ndjson`，也可通过 `TORSOR_OPERATIONAL_LOG_PATH` 显式选择位置；日志路径本身不进入事件。
3. 序列化键顺序固定，测试不得依赖对象或平台的偶然枚举差异。
4. 默认单行上限为 2048 bytes。配置只能在 256 到 65536 bytes 之间；超限事件必须失败，不能截断、拆行或伪装成成功。
5. Sink write 串行执行。默认最多接受 64 个尚未完成的 write，配置范围为 1 到 1024；达到上限时，新事件在进入队列前以明确 backpressure 错误失败，不能丢弃旧事件或静默降级。
6. Production file sink 默认把当前文件限制为 1 MiB，可通过 `TORSOR_OPERATIONAL_LOG_MAX_BYTES` 配置为 65536 到 16777216 bytes；轮转时只保留当前文件和一个 `.1` predecessor。创建、轮转、写入或 backpressure 失败必须使对应操作和 Host lifecycle 明确失败；不得继续运行成看似已记录的状态。
7. Sink 失败使用固定通用错误；不得把原始 sink exception、嵌套 cause、路径或 sink payload 复制进另一个日志事件。失败不能永久毒化后续 write。
8. 运维日志不是 safety gate。取消、Writer Authority loss、Lease expiry、shutdown 或未知停止的物理 stop/containment 必须先启动且不能等待可能失败的日志 write；日志失败仍须明确传播，但不得阻止或替代 OS stop、持久化 stop/quarantine evidence，也不得掩盖独立的 stop 失败。

## 2. 封闭事件 Schema

字段按下列顺序序列化；除列出的可选字段外，不接受其他字段：

```text
schemaVersion
timestamp
level
component
event
outcome
durationMs?
httpStatus?
requestId?
correlationId?
runId?
activationId?
providerAttemptId?
worktreeId?
executionId?
errorCode?
```

- `schemaVersion` 固定为 `1`。
- `timestamp` 是由注入 clock 产生的 UTC ISO 8601 字符串。无效 clock 结果必须失败。
- `level` 由 `outcome` 确定：`started` / `succeeded` 为 `info`，`cancelled` / `unknown` / `lost` 为 `warn`，`failed` 为 `error`。调用者不能覆盖。
- `durationMs` 是生产者用 monotonic elapsed time 计算的 0 到 86400000 之间整数；logger 不从 wall clock 推断 duration。
- `httpStatus` 仅允许 100 到 599 之间整数。
- 所有 ID 都是经过构造器验证的不透明 ID：1 到 128 个 ASCII 字符，只允许字母、数字、`.`、`_`、`-`，不得包含空白、斜杠、反斜杠、控制字符或机器路径。`executionId` 是公开安全的 execution receipt 身份；Writer Lease token、execution token、quarantine token、generation 和 fencing token 不得记录。
- `errorCode` 只能来自版本化白名单。`failed`、`unknown`、`lost` 和 `cancelled` 必须提供错误码；`started` 和 `succeeded` 不得提供错误码。

稳定事件名称与组件为：

| `event` | `component` |
|---|---|
| `host.start` | `host` |
| `host.stop` | `host` |
| `http.request` | `http` |
| `runtime.activation` | `runtime` |
| `runtime.provider_attempt` | `runtime` |
| `runtime.run_terminal` | `runtime` |
| `provider_process.spawn` | `provider_process` |
| `provider_process.stop` | `provider_process` |
| `writer_authority.acquire` | `writer_authority` |
| `writer_authority.loss` | `writer_authority` |
| `writer_authority.quarantine` | `writer_authority` |
| `recovery.pass` | `recovery` |

稳定通用错误码为 `host_start_failed`、`host_stop_failed`、`http_request_failed`、`runtime_activation_failed`、`run_failed`、`run_cancelled`、`writer_authority_lost`、`writer_authority_quarantined` 和 `recovery_failed`。Provider 事件复用 MVP 基线第 20.2 节的 `provider_*` 稳定错误码，不创建自由文本错误字段。

## 3. 关联传播

1. HTTP 边界为每个请求创建 `requestId`。`http.request` 始终记录该 ID；当 command 已提交时，同一事件还记录 Kernel 返回的 `correlationId`。成功 command response 只能在该必需事件已由 sink 接受后返回 2xx，并返回同一 `correlationId`，使 Operator 能从 response header 的 `requestId` 进入 durable work 链。若 commit 后日志失败，Host 必须明确失败，且客户端不得观察到 2xx；客户端可把 command outcome 视为 uncertain，并用原 idempotency key 恢复。
2. `requestId` 不写入 Kernel、Outbox 或 recovery 状态。后续 Runtime、Provider process、Writer Authority、terminal Run 和 recovery 事件只传播服务端签发的 `correlationId`；这避免把短期 transport identity 扩大为持久状态。
3. Runtime 从 Attention 或触发 RunInput 的创建事件取得原始 `correlationId`；由 Attention 同一命令创建、没有独立公开创建事件的初始 RunInput 继承 Run 创建事件的关联。Runtime 把该值作为 server-bound operation context 用于 Attention/Run Activation、ProviderAttempt、Agent capability、native execution 和 settlement；对应 durable Kernel events 与运维事件必须保留同一已验证关联。Prompt、Provider 输出和 HTTP body 不能提供或覆盖该值。
4. `correlationId` 跟随持久工作跨异步边界和 recovery；后台 recovery 不得伪造 `requestId`。没有可验证来源关联时，事件必须省略关联而不是猜测。
5. 已知 Run、Activation、ProviderAttempt、Worktree 或 execution receipt 身份时，使用对应不透明 ID 字段；不得把多个身份拼进 message、路径或自由文本。
6. 关联字段是诊断链接，不是授权、Writer fencing 或幂等证明。

## 4. 隐私边界

Logger API 和运行时校验都必须按白名单构造事件，不接受 `Record<string, unknown>`、任意 metadata、任意 message、原始 exception 或嵌套对象。

以下内容不得进入事件：Prompt、模型响应、Tool 参数或结果、环境变量或值、Credential、Token、Cookie、Authorization header、请求或响应 body、URL/query、机器路径、cwd、命令行、stdout、stderr、Provider 自由文本、原始进程/sink exception、stack、嵌套 cause 或 Human/Agent 消息正文。

隐私边界依靠封闭 Schema、枚举和长度限制，不依赖正则 Secret 替换。未知字段、无效 ID、无效错误码、非有限数字和超限序列化必须明确失败。测试必须使用合成 canary 证明被排除数据不能通过类型接口或运行时伪造进入 NDJSON。

## 5. 集成与验收边界

测试覆盖可观察 NDJSON、固定键顺序、ID 与错误码校验、隐私 canary、单行与文件上限、sink 失败、串行 backpressure 和失败后的恢复。Production-path 合成测试必须证明：一个 trusted-local 失败 Run 可从 HTTP `requestId` 和 Kernel `correlationId` 关联到 Runtime Activation、ProviderAttempt、Provider process、Writer Authority acquire 和 terminal outcome；独立的取消、Writer Authority loss/quarantine 与 restart recovery 测试必须证明各自沿已验证的 durable correlation 记录，且不泄露 lease authority 或私有 Provider 数据。

事件不得成为 raw access log 或 Provider transcript。HTTP 事件不含 method、URL、query、header 或 body；Provider/process 事件不含 command、cwd、PATH、环境、Prompt、Tool payload、stdout/stderr 或原始错误。
