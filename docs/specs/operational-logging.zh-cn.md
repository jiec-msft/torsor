# 运维日志规格

> 简体中文（主要版本） | [English](operational-logging.md)

> 状态：MVP 0.1 foundation
>
> 适用范围：trusted-local Host、HTTP、Runtime、Provider process、Writer Authority 与 recovery 的本地结构化运维记录。

本规格细化 [`docs/prototype/001-overview.zh-cn.md`](../prototype/001-overview.zh-cn.md) 第 20、22、28 节的诊断与审计边界。Foundation 只定义可复用日志契约；在 HTTP、Runtime、Provider process、Writer Authority 和 recovery 全部完成接线并通过端到端失败 Run 关联测试之前，不满足 issue #26 的完整验收。

## 1. 输出与所有权

1. 运维日志是本地 NDJSON；每个事件必须恰好序列化为一行 UTF-8 JSON，并以 `\n` 结束。
2. Logger 不提供隐式 stdout/stderr sink。Host 必须显式提供并拥有 sink、文件位置、轮转和保留策略。
3. 序列化键顺序固定，测试不得依赖对象或平台的偶然枚举差异。
4. 默认单行上限为 2048 bytes。配置只能在 256 到 65536 bytes 之间；超限事件必须失败，不能截断、拆行或伪装成成功。
5. Sink write 串行执行。默认最多接受 64 个尚未完成的 write，配置范围为 1 到 1024；达到上限时，新事件在进入队列前以明确 backpressure 错误失败，不能丢弃旧事件或静默降级。
6. Sink 失败必须使对应 emit 失败，并使用固定通用错误；不得把原始 sink exception、嵌套 cause 或 sink payload 复制进另一个日志事件。失败不能永久毒化后续 write。

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
writerLeaseId?
errorCode?
```

- `schemaVersion` 固定为 `1`。
- `timestamp` 是由注入 clock 产生的 UTC ISO 8601 字符串。无效 clock 结果必须失败。
- `level` 由 `outcome` 确定：`started` / `succeeded` 为 `info`，`cancelled` / `unknown` / `lost` 为 `warn`，`failed` 为 `error`。调用者不能覆盖。
- `durationMs` 是生产者用 monotonic elapsed time 计算的 0 到 86400000 之间整数；logger 不从 wall clock 推断 duration。
- `httpStatus` 仅允许 100 到 599 之间整数。
- 所有 ID 都是经过构造器验证的不透明 ID：1 到 128 个 ASCII 字符，只允许字母、数字、`.`、`_`、`-`，不得包含空白、斜杠、反斜杠、控制字符或机器路径。
- `errorCode` 只能来自版本化白名单。`failed`、`unknown`、`lost` 和 `cancelled` 必须提供错误码；`started` 和 `succeeded` 不得提供错误码。

稳定事件名称与组件为：

| `event` | `component` |
|---|---|
| `host.start` | `host` |
| `host.stop` | `host` |
| `http.request` | `http` |
| `runtime.activation` | `runtime` |
| `runtime.provider_attempt` | `runtime` |
| `provider_process.spawn` | `provider_process` |
| `provider_process.stop` | `provider_process` |
| `writer_authority.acquire` | `writer_authority` |
| `writer_authority.loss` | `writer_authority` |
| `recovery.pass` | `recovery` |

稳定通用错误码为 `host_start_failed`、`host_stop_failed`、`http_request_failed`、`runtime_activation_failed`、`writer_authority_lost` 和 `recovery_failed`。Provider 事件复用 MVP 基线第 20.2 节的 `provider_*` 稳定错误码，不创建自由文本错误字段。

## 3. 关联传播

1. HTTP 边界为每个请求创建 `requestId`，在 `http.request` 及该请求同步触发的下游事件中原样传播。
2. 当请求创建或操作持久工作时，Kernel 的 `correlationId` 必须与 `requestId` 一起传播到后续 Runtime、Provider process、Writer Authority 和 recovery 事件。
3. `correlationId` 跟随持久工作跨异步边界和 recovery；后台 recovery 不得伪造新的 `requestId`。无法归属原 HTTP 请求时省略 `requestId`。
4. 已知 Run、Activation、ProviderAttempt、Worktree 或 Writer Lease 身份时，使用对应不透明 ID 字段；不得把多个身份拼进 message、路径或自由文本。
5. 关联字段是诊断链接，不是授权、Writer fencing 或幂等证明。

## 4. 隐私边界

Logger API 和运行时校验都必须按白名单构造事件，不接受 `Record<string, unknown>`、任意 metadata、任意 message、原始 exception 或嵌套对象。

以下内容不得进入事件：Prompt、模型响应、Tool 参数或结果、环境变量或值、Credential、Token、Cookie、Authorization header、请求或响应 body、URL/query、机器路径、cwd、命令行、stdout、stderr、Provider 自由文本、原始进程/sink exception、stack、嵌套 cause 或 Human/Agent 消息正文。

隐私边界依靠封闭 Schema、枚举和长度限制，不依赖正则 Secret 替换。未知字段、无效 ID、无效错误码、非有限数字和超限序列化必须明确失败。测试必须使用合成 canary 证明被排除数据不能通过类型接口或运行时伪造进入 NDJSON。

## 5. 集成与验收边界

Foundation 测试覆盖可观察 NDJSON、固定键顺序、ID 与错误码校验、隐私 canary、单行上限、sink 失败、串行 backpressure 和失败后的恢复。

Issue #26 的最终集成仍必须证明：同一个失败 Run 可从 HTTP `requestId` 和 Kernel `correlationId` 关联到 Runtime Activation、ProviderAttempt、Provider process、Writer Authority loss/quarantine 及 recovery/terminal outcome；所有接线继续遵守本规格，且不输出 raw access log 或 Provider transcript。
