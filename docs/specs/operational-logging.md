# Operational Logging Specification

> English | [简体中文](operational-logging.zh-cn.md)

> Status: MVP 0.1 schema 18 production integration
>
> Scope: local structured operational records for the trusted-local Host, HTTP, Runtime, Provider process, Writer Authority, and recovery.

This specification refines the diagnostic and audit boundaries in sections 20, 22, and 28 of [`docs/prototype/001-overview.md`](../prototype/001-overview.md) and operates with the schema 18 execution receipt, stop, and quarantine contract in the [trusted-local Provider policy](trusted-local-provider-policy.md).

## 1. Output and ownership

1. Operational logs are local NDJSON. Each event must serialize to exactly one UTF-8 JSON line terminated by `\n`.
2. The logger provides no implicit stdout/stderr sink. A library Host must explicitly provide a sink. The production CLI defaults to a private `operational.ndjson` beside the database and may select another location with `TORSOR_OPERATIONAL_LOG_PATH`; the log path itself never enters an event.
3. Serialization key order is fixed; tests must not depend on incidental object or platform enumeration differences.
4. The default line limit is 2048 bytes. Configuration is restricted to 256 through 65536 bytes. An oversized event fails rather than being truncated, split, or reported as successful.
5. Sink writes are serialized. By default, at most 64 unfinished writes are accepted, configurable from 1 through 1024. At the limit, a new event fails with an explicit backpressure error before entering the queue; old events are not dropped and no silent fallback is allowed.
6. The production file sink defaults to a 1 MiB current-file limit, configurable from 65536 through 16777216 bytes with `TORSOR_OPERATIONAL_LOG_MAX_BYTES`. Rotation retains only the current file and one `.1` predecessor. Creation, rotation, write, or backpressure failure rejects the corresponding operation and the Host lifecycle explicitly; the Host must not continue in a success-shaped "logged" state.
7. A sink failure uses a fixed generic error. The logger must not copy the raw sink exception, nested cause, path, or sink payload into another log event. A failure must not permanently poison later writes.

## 2. Closed event schema

Fields serialize in the following order. No fields other than the listed optional fields are accepted:

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

- `schemaVersion` is fixed at `1`.
- `timestamp` is a UTC ISO 8601 string produced by the injected clock. An invalid clock result fails.
- `level` is derived from `outcome`: `started` / `succeeded` use `info`, `cancelled` / `unknown` / `lost` use `warn`, and `failed` uses `error`. Callers cannot override it.
- `durationMs` is an integer from 0 through 86400000, computed by the producer from monotonic elapsed time. The logger does not infer duration from wall-clock timestamps.
- `httpStatus` is an integer from 100 through 599.
- Every ID is an opaque ID validated by a constructor: 1 through 128 ASCII characters limited to letters, digits, `.`, `_`, and `-`, with no whitespace, slash, backslash, control character, or machine path. `executionId` is the public-safe execution receipt identity. Writer Lease tokens, execution tokens, quarantine tokens, generations, and fencing tokens must never be logged.
- `errorCode` comes only from a versioned allowlist. `failed`, `unknown`, `lost`, and `cancelled` require an error code; `started` and `succeeded` forbid one.

Stable event names and components are:

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

Stable general error codes are `host_start_failed`, `host_stop_failed`, `http_request_failed`, `runtime_activation_failed`, `run_failed`, `run_cancelled`, `writer_authority_lost`, `writer_authority_quarantined`, and `recovery_failed`. Provider events reuse the stable `provider_*` error codes from MVP baseline section 20.2 rather than introducing free-text error fields.

## 3. Correlation propagation

1. The HTTP boundary creates a `requestId` for every request. `http.request` always records it. When a command commits, that event also records the Kernel-returned `correlationId`, and the HTTP command response returns the same `correlationId`, allowing an operator to enter the durable work chain from the response-header `requestId`.
2. `requestId` is not written into Kernel, Outbox, or recovery state. Later Runtime, Provider process, Writer Authority, terminal Run, and recovery events propagate only the server-issued `correlationId`; this avoids widening a short-lived transport identity into durable state.
3. Runtime obtains the original `correlationId` from the Attention or triggering RunInput creation event. An initial RunInput created by the same Attention command, with no independent public creation event, inherits the Run creation event correlation. Runtime uses that value as server-bound operation context for Activation, ProviderAttempt, Agent capability, native execution, and settlement. Prompts, Provider output, and HTTP bodies cannot supply or override it.
4. The `correlationId` follows durable work across asynchronous boundaries and recovery. Background recovery must not invent a `requestId`. If no verified source correlation exists, omit correlation rather than guessing.
5. When a Run, Activation, ProviderAttempt, Worktree, or execution receipt identity is known, use its corresponding opaque ID field. Do not concatenate multiple identities into a message, path, or free text.
6. Correlation fields are diagnostic links, not authorization, Writer fencing, or idempotency proof.

## 4. Privacy boundary

The logger API and runtime validation both construct events from an allowlist. They do not accept `Record<string, unknown>`, arbitrary metadata, arbitrary messages, raw exceptions, or nested objects.

Events must not contain prompts, model responses, Tool arguments or results, environment names or values, credentials, tokens, cookies, Authorization headers, request or response bodies, URLs/queries, machine paths, cwd, command lines, stdout, stderr, Provider-authored prose, raw process/sink exceptions, stacks, nested causes, or Human/Agent message bodies.

The privacy boundary relies on the closed schema, enums, and length limits rather than regex secret replacement. Unknown fields, invalid IDs, invalid error codes, non-finite numbers, and oversized serialization fail explicitly. Tests must use synthetic canaries to prove excluded data cannot enter NDJSON through either the typed interface or a runtime-forged value.

## 5. Integration and acceptance boundary

Tests cover observable NDJSON, fixed key ordering, ID and error-code validation, privacy canaries, line and file limits, sink failure, serialized backpressure, and recovery after failure. Production-path synthetic tests must prove that one failed trusted-local Run can be followed from HTTP `requestId` and Kernel `correlationId` through Runtime Activation, ProviderAttempt, Provider process, Writer Authority acquisition, and terminal outcome. Separate cancellation, Writer Authority loss/quarantine, and restart-recovery tests must prove that each records the verified durable correlation without disclosing lease authority or private Provider data.

Events must not become raw access logs or Provider transcripts. HTTP events contain no method, URL, query, header, or body. Provider/process events contain no command, cwd, PATH, environment, prompt, Tool payload, stdout/stderr, or raw error.
