# Operational Logging Specification

> English | [简体中文](operational-logging.zh-cn.md)

> Status: MVP 0.1 foundation
>
> Scope: local structured operational records for the trusted-local Host, HTTP, Runtime, Provider process, Writer Authority, and recovery.

This specification refines the diagnostic and audit boundaries in sections 20, 22, and 28 of [`docs/prototype/001-overview.md`](../prototype/001-overview.md). The foundation defines only the reusable logging contract. It does not satisfy the full acceptance criteria of issue #26 until HTTP, Runtime, Provider process, Writer Authority, and recovery are all integrated and an end-to-end failed-Run correlation test passes.

## 1. Output and ownership

1. Operational logs are local NDJSON. Each event must serialize to exactly one UTF-8 JSON line terminated by `\n`.
2. The logger provides no implicit stdout/stderr sink. The Host must explicitly provide and own the sink, file location, rotation, and retention policy.
3. Serialization key order is fixed; tests must not depend on incidental object or platform enumeration differences.
4. The default line limit is 2048 bytes. Configuration is restricted to 256 through 65536 bytes. An oversized event fails rather than being truncated, split, or reported as successful.
5. Sink writes are serialized. By default, at most 64 unfinished writes are accepted, configurable from 1 through 1024. At the limit, a new event fails with an explicit backpressure error before entering the queue; old events are not dropped and no silent fallback is allowed.
6. A sink failure rejects the corresponding emit with a fixed generic error. The logger must not copy the raw sink exception, nested cause, or sink payload into another log event. A failure must not permanently poison later writes.

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
writerLeaseId?
errorCode?
```

- `schemaVersion` is fixed at `1`.
- `timestamp` is a UTC ISO 8601 string produced by the injected clock. An invalid clock result fails.
- `level` is derived from `outcome`: `started` / `succeeded` use `info`, `cancelled` / `unknown` / `lost` use `warn`, and `failed` uses `error`. Callers cannot override it.
- `durationMs` is an integer from 0 through 86400000, computed by the producer from monotonic elapsed time. The logger does not infer duration from wall-clock timestamps.
- `httpStatus` is an integer from 100 through 599.
- Every ID is an opaque ID validated by a constructor: 1 through 128 ASCII characters limited to letters, digits, `.`, `_`, and `-`, with no whitespace, slash, backslash, control character, or machine path.
- `errorCode` comes only from a versioned allowlist. `failed`, `unknown`, `lost`, and `cancelled` require an error code; `started` and `succeeded` forbid one.

Stable event names and components are:

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

Stable general error codes are `host_start_failed`, `host_stop_failed`, `http_request_failed`, `runtime_activation_failed`, `writer_authority_lost`, and `recovery_failed`. Provider events reuse the stable `provider_*` error codes from MVP baseline section 20.2 rather than introducing free-text error fields.

## 3. Correlation propagation

1. The HTTP boundary creates a `requestId` for every request and propagates it unchanged into `http.request` and downstream events synchronously caused by that request.
2. When a request creates or operates on durable work, the Kernel `correlationId` must be propagated with the `requestId` into later Runtime, Provider process, Writer Authority, and recovery events.
3. The `correlationId` follows durable work across asynchronous boundaries and recovery. Background recovery must not invent a new `requestId`; omit it when no original HTTP request can be attributed.
4. When a Run, Activation, ProviderAttempt, Worktree, or Writer Lease identity is known, use its corresponding opaque ID field. Do not concatenate multiple identities into a message, path, or free text.
5. Correlation fields are diagnostic links, not authorization, Writer fencing, or idempotency proof.

## 4. Privacy boundary

The logger API and runtime validation both construct events from an allowlist. They do not accept `Record<string, unknown>`, arbitrary metadata, arbitrary messages, raw exceptions, or nested objects.

Events must not contain prompts, model responses, Tool arguments or results, environment names or values, credentials, tokens, cookies, Authorization headers, request or response bodies, URLs/queries, machine paths, cwd, command lines, stdout, stderr, Provider-authored prose, raw process/sink exceptions, stacks, nested causes, or Human/Agent message bodies.

The privacy boundary relies on the closed schema, enums, and length limits rather than regex secret replacement. Unknown fields, invalid IDs, invalid error codes, non-finite numbers, and oversized serialization fail explicitly. Tests must use synthetic canaries to prove excluded data cannot enter NDJSON through either the typed interface or a runtime-forged value.

## 5. Integration and acceptance boundary

Foundation tests cover observable NDJSON, fixed key ordering, ID and error-code validation, privacy canaries, line limits, sink failure, serialized backpressure, and recovery after failure.

Final issue #26 integration must still prove that one failed Run can be followed from HTTP `requestId` and Kernel `correlationId` through Runtime Activation, ProviderAttempt, Provider process, Writer Authority loss/quarantine, and recovery/terminal outcome. Every integration must continue to obey this specification and must not emit raw access logs or Provider transcripts.
