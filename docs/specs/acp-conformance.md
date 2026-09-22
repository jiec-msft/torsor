# ACP Provider Conformance Harness

> English | [简体中文](acp-conformance.zh-cn.md)

Status: first independent slice. This specification governs `@torsor/acp-conformance`, without changing Torsor Runtime, Kernel, or Host behavior. The harness checks an explicitly enumerated ACP v1 subset, not complete ACP certification.

## 1. Reuse-first research gate

Paseo default branch `main` inspected on 2026-09-22 at exact commit:
[`91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786`](https://github.com/getpaseo/paseo/tree/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786).
Broad searches covered ACP, conformance, harness, scenario, fixture, transcript, replay, stdio, and permission, followed by actual consumer and test tracing rather than name-based conclusions.

| Candidate boundary | Verified consumers and capabilities | Decision and concrete gaps |
|---|---|---|
| [`@getpaseo/plugin/server/acp`](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/plugin/src/server/acp.ts) `runAcpProvider` | Plugin worker `provider.connect` → ACP connection → `PluginAgentClientRegistry`; [integration tests](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/plugins/runtime.posix.test.ts) launch a plugin and synthetic ACP agent | Public API, but input/output are Paseo `ProviderInput` / `ProviderEvent`, converting timelines, sessions, and permissions. Not a raw ACP oracle; a future downstream compatibility target, not a core dependency |
| [Plugin ACP tests](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/plugin/src/server/acp.test.ts) | Executable `.cjs` agents, in-memory connectors, permission responses, cancel-before-replacement ordering, 2 MiB stderr test | Useful design concepts, but tests are not public exports; no versioned scenario, unified verdict, or normalized transcript API |
| [Server ACP implementation](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/acp-agent.ts) | Provider registry → `GenericACPAgentClient` / named providers; SDK 0.17.1; diagnostic tests check timed-out process exit | Non-public deep imports; ignores non-JSON stdout, accommodates stringified response IDs, and unattended policy can auto-approve. These are not universal protocol requirements |
| [JSONL RPC process](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/jsonl-rpc-process.ts) / frame decoder | Actual consumers are Pi / OMP CLI runtimes using `type/success/data` and chunk framing | Not ACP JSON-RPC; similar filenames do not establish interoperability |
| [Process-tree utilities](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/utils/tree-kill.test.ts) | Server has Windows CI and Windows/POSIX descendant tests | Non-public exports; plugin ACP independently uses direct `spawn` / `child.kill`. No uniform hostile-output budget, whole-operation deadline, or independent cleanup verdict |
| [Real ACP smoke](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/packages/server/src/server/agent/providers/acp-wrapper-smoke.test.ts) | Explicit `ACP_SMOKE` opt-in; selected RPC evidence | Real consumers, but platform-specific configuration and automatic allow policy; not a portable credential-free scenario suite |

Paseo JSONL fixtures, provider-native history replay, and CLI YAML output serve separate boundaries. No generic ACP scenario DSL or wire record/replay engine was located. There is therefore no Paseo scenario format to adopt directly. Standard ACP stdio, rather than its application event format, remains the interoperability path.

Paseo's root [LICENSE](https://github.com/getpaseo/paseo/blob/91d9cf1dbd0c095c8971d7e8f1fb73eb60a6a786/LICENSE) declares Apache-2.0 for its own code. At inspection, public npm `@getpaseo/plugin` / `@getpaseo/server` 0.9.0 reported gitHead `7f7e60bcbbfe57bf5250b10d01c5f97847b43db0`, not the audited commit; tests are not exported, and tarball inclusion is not an export contract. No Paseo source is copied.

**Reuse decision:** directly depend on Apache-2.0 `@agentclientprotocol/sdk` **1.4.0**, public source commit [`e6463f444093ed7c5f1cc937c3f32afb5853e906`](https://github.com/agentclientprotocol/typescript-sdk/tree/e6463f444093ed7c5f1cc937c3f32afb5853e906). Use stable v1 `client()` / `agent()` / `ndJsonStream`, not deprecated connection classes, private test utilities, or experimental v2. Reuse request correlation, bidirectional dispatch, and protocol types. Add only strict wire observations, scenario execution, assertions, budgets, process ownership, and public artifact policy. SDK unterminated-line buffering and cooperative cancellation do not establish hostile-output or overall-deadline guarantees, so external guards are required. Zod (MIT) supplies the single config schema; YAML (ISC) only parses, without a second validation rule set.

The Windows native boundary reuses MIT-licensed [`koffi` 3.2.0](https://www.npmjs.com/package/koffi/v/3.2.0) public FFI / struct APIs to bind [documented Job Object APIs](https://learn.microsoft.com/windows/win32/procthread/job-objects), rather than maintaining a native addon. Its platform-specific prebuilt packages support Windows x86/x64/ARM64; only the Windows ownership child loads it. Hosted Windows runs timed out during PowerShell `Add-Type` compilation, so runtime compilation and the PowerShell guardian are no longer required. Missing native bindings fail explicitly, without degrading to PID-tree traversal that can miss orphans.

## 2. Public interface and scope

The package follows existing ESM / TypeScript workspace conventions without depending on any Torsor package.

- `loadScenario(text, { format: "json" | "yaml" })`: synchronously parse and validate a scenario with deterministic defaults. Errors contain structural paths starting at `$`, never values, source snippets, or machine paths.
- `runScenario(scenario, options?)`: validate, run in a fresh temporary workspace, and return `passed | failed | skipped`, stable diagnostics, and a normalized transcript. Default provider is the built-in mock.
- `runSuite(scenarios, options?)`: sequentially use the same public entry point, with a fresh process/workspace per scenario. Callers explicitly select compatible subsets; provider names never hide failures.
- `toJsonl(result)`: serialize the transcript as versioned JSONL.
- `acp-conformance run <scenario...> [--out <directory>] [--allow-real] [--profile copilot-cli-v1 | -- <command> <args...>]`. Explicit `--inherit-env NAME` passes only authorized environment values without printing or recording them.
- `acp-conformance mock <scenario>`: expose the deterministic declarative stdio peer to other ACP clients.

CLI exit codes: `0` all passed; `1` scenario failure; `2` config, usage, or artifact I/O error; `3` skipped because real execution was not enabled. Human output contains scenario IDs, steps, and fixed diagnostics only. `--out` writes per-scenario `.result.json` / `.transcript.jsonl` without overwriting existing files. No automatic real-provider installation, login, authentication, or retry.

Each scenario's artifact pair exclusively reserves both destinations before writing content. If either destination exists, preserve existing files and close/remove reservations created by this attempt. No newly created partial pair remains after overwrite refusal, allowing a clean retry after the caller removes the conflict. Write/close failures also roll back newly created files; rollback failures explicitly return an I/O error. This guarantee applies per scenario pair, not as a cross-scenario transaction or a crash/power-loss-atomic two-file commit.

## 3. One versioned configuration

Top-level fields: `schemaVersion: 1`, `id`, `steps`, optional `limits`, `mock`, and `expectFailure`. IDs and request labels use short ASCII identifiers. JSON and YAML enter the same Zod schema, with identical defaults, unknown-field handling, and diagnostics. All control objects reject unknown fields. ACP `params` / `result` are bounded JSON and may carry protocol extensions, never interpreted as harness instructions.

Input is limited to 256 KiB, JSON depth 32, and 128 steps/handlers/actions. YAML accepts JSON-compatible core types only, rejecting duplicate keys, custom tags, aliases, merge keys, and multiple documents. Unknown schema versions fail rather than guessing forward compatibility. New control fields require explicit consumer upgrades; extensible provider payloads do not imply silently ignoring configuration fields.

Scenario IDs reject Windows reserved device names for portable artifact filenames; IDs within one CLI suite are unique case-insensitively.

Minimal scenario vocabulary:

| `type` | Meaning |
|---|---|
| `request` | Start an asynchronous client request with unique local label `id`, `method`, and `params`; do not implicitly await |
| `response` | Await labeled request `id`; assert JSON Pointer `equals` or `kind`, or expect `errorCode` |
| `notification` | Send a client notification, including `session/cancel` |
| `update` | Consume a provider session update matching `sessionUpdate`, with optional fact assertions. Bounded event queuing starts immediately; no sleeps for coordination |
| `close-stdin` | Explicitly close the input direction |
| `exit` | Await provider exit and assert its code |

The only parameter substitution is a whole object `{ "$ref": "workspace" }` or `{ "$ref": "request-label#/json/pointer" }`, the latter reading a consumed successful response. No string templates, evaluation, loops, external includes, or environment interpolation. JSON Pointers follow RFC 6901; invalid or unbound references fail explicitly.

`mock.handlers` registers SDK handlers by `method` / `kind: request | notification`. Ordered actions are `reply`, `notify`, `request` (request the client and assert its response), named-gate `wait` / `release`, and `fault`. Releasing before waiting also works; cross-handler coordination needs no real sleeps. Mock-only faults are `malformed`, `oversized`, `stderr`, `stdout-close`, `stdin-close`, `exit`, `hang`, and explicit `wire` message injection. SDK encodes and dispatches normal messages; faults never become production compatibility exceptions.

`expectFailure` accepts stable failure codes only. Matching an expected fault can pass a scenario, but cleanup failure always fails. Diagnostics remain visible rather than disguising expected failures as fault-free runs.

Execution or assertion failures in mock request, notification, and stdin EOF actions report fixed `mock_failed` through a dedicated acknowledged control channel, without raw exceptions or payloads. SDK notification logging, normal exit, omission of an `exit` step, or `expectFailure` cannot mask these failures. Only explicit `reply.errorCode` in a request handler is an intentional RPC error rather than a mock execution failure. Without the runner control channel, the standalone `mock` command emits a fixed error description and exits nonzero.

`reply` selects exactly one of `result` or `errorCode`. `fault` embeds a named `fault.kind` object; `wire` can explicitly omit its newline to test partial frames. `mock.onStdinClose` executes the same action vocabulary after input EOF, deterministically testing output after the final response without delays. Ajv (MIT) validates the used method definitions directly from the SDK's published ACP JSON Schema, without maintaining duplicate protocol field schemas; invalid payloads are rejected before SDK notification-error logging.

Fact assertions and `$ref` share RFC 6901 traversal. Arrays accept only `0` or positive integer literals without leading zeroes, and the index must be in range. Reject `length`, leading zeroes, negative numbers, exponent notation, `-`, and out-of-range indices rather than reading JavaScript array properties. JSON objects still use exact own-member lookup, including members named `length` or `01`. JSON/YAML outcomes and diagnostics must agree.

## 4. Wire, state, permissions, and budgets

Based on public ACP v1 [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [transport](https://agentclientprotocol.com/protocol/v1/transports), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), and [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls):

1. stdout must contain UTF-8, newline-terminated individual JSON-RPC 2.0 messages. Reject logs, batches, empty lines, invalid UTF-8, partial frames, and duplicate/unknown response IDs before SDK recovery. Never silently repair IDs.
2. Initialization must select version 1 and provide a capability object. Sessions require initialization; prompts require a valid acquired session ID. Prompt results require a valid `stopReason`. Fact assertions can inspect capabilities, not exact natural-language prose.
3. Cancellation uses `session/cancel`; updates remain acceptable until the prompt result. A cancelled prompt must finish with `cancelled`. Coordinated tests cover cancellation races; killing a process is not successful protocol cancellation.
4. Advertise only version 1 and an empty optional capability object. Scenarios cannot enable filesystem/terminal capabilities or choose a session cwd outside the temporary workspace, additional directories, or MCP servers. Every lifecycle-valid `session/request_permission` returns `cancelled`, while invalid lifecycles fail the scenario; SDK returns Method Not Found for other reverse requests without executing local tools. Policy cannot be changed to allow. Valid tool updates are observable protocol facts, not local execution authorization or universal ACP violations.
5. Defaults: 256 KiB frames, 1 MiB total stdout, 64 KiB total stderr, 2048 protocol events, 15 s startup deadline (`startupMs`), 5 s step deadline, 30 s scenario deadline, 2 s cleanup deadline. Startup separately covers OS ownership setup and provider spawn, without relaxing protocol-step deadlines for Windows cold starts. All settings are bounded positive integers. Raw streams and JSON depth are bounded before SDK ingestion. Exceeding budgets fails rather than truncating into success. stderr is drained and counted, never retained.
6. No shell interpolation: command and args are separate; Windows `.cmd` / `.bat` never implicitly invoke a shell. Commands must be trusted local programs. Default environment inherits only necessary OS / PATH values, redirecting home, config, cache, and temporary directories into the synthetic workspace. Credentials require explicit runtime environment authorization.
7. Each run owns a live Node wrapper so descendants remain owned even if the provider exits first. Before starting a provider, Windows creates a `KILL_ON_JOB_CLOSE` job object and assigns the owner itself. The owner holds its non-inheritable job handle; exact termination of that process closes the handle and reclaims job members, including orphans. Failed job setup never starts a provider. POSIX uses the newly created process group. Always await closure and remove the temporary directory; failure is explicit. Malicious programs escaping process groups, OS sandboxing, and uncontrolled external effects are outside the guarantee.
8. Without an external command, only the mock runs: no model, network, or credentials. External commands without explicit `allowReal` return skipped without spawning. Token presence cannot enable real tests.

The owner uses an internal byte-counted EOF signal so the final frame is consumed before the SDK stream closes. Built-in mock `stdout-close` / `stdin-close` faults use a dedicated control channel rather than Windows Node self-stdio destruction semantics. These faults are available only in harness-owned mocks; equivalent control signals are not accepted from real providers.

Only an explicit `exit` step requires voluntary provider exit and a particular code. After protocol assertions, the runner closes stdin, allows up to `shutdownMs` to drain stdout/stderr, then boundedly terminates a still-live provider. Forced cleanup alone is not ACP nonconformance; cleanup failures or protocol/budget errors during draining still fail the scenario. Draining and termination each have a `shutdownMs` bound.

Windows file-handle release can lag process exit. Temporary-directory removal uses Node's three bounded retries, waiting at most 300 ms cumulatively (less for short cleanup budgets). Exhaustion still explicitly reports `cleanup_failed` rather than ignoring remaining files.

The ownership layer receives launch configuration only after an explicit readiness handshake, without relying on runtime compilation or console text encoding. Startup timeouts report fixed stage names only, never raw system output or machine paths.

Outbound `session/` methods are limited to `session/new`, `session/prompt`, and `session/cancel`. Other session methods, including `session/load`, `session/resume`, and `session/fork`, fail with `protocol_state` before writing to provider stdin, whether sent as requests or notifications. Future extensions must first define equivalent workspace, MCP, additional-directory, and lifecycle validation. When present, `session/new`'s `additionalDirectories` must be an empty array.

`session/new` and `session/prompt` must be requests; `session/cancel` must be a notification. Prompt and cancel sessions must already exist on this connection, with at most one outstanding prompt per session. Every provider `session/update` must reference a created session; `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and `tool_call_update` additionally require an outstanding prompt for that session. A turn stays active after cancel until the prompt response or error. Reject those turn updates after terminal responses, including during draining, until another prompt begins. Session-level notifications such as commands, modes, configuration, session information, and usage do not require an active prompt.

Every successful `session/new` response must provide a nonempty ID unique among all sessions created on this connection. Returning an existing ID fails with `protocol_result` rather than merging session identity or state. Concurrent and sequential creation follow the same rule.

Each session retains its own tool identity set. Initial `tool_call` requires a nonempty `toolCallId` never used in that session; `tool_call_update` must reference a tool already announced in that session. Starting another prompt does not make IDs reusable, while different sessions may use the same raw tool ID independently. Permission messages must be requests for a created session and an announced tool in that session, received during its active prompt; recheck activity before writing the response to the provider. Violations fail with `protocol_state`, without dispatching the permission handler or sending a late response. Only lifecycle-valid permission requests receive `cancelled`; tool execution is never allowed. Existing transcript allowlists and session-scoped tool correlation remain unchanged.

## 5. Transcript and safety

JSONL is the sole event artifact format. Each line has `schemaVersion: 1`, increasing `sequence`, `timestamp`, `direction`, `kind`, and safe facts. `timestamp` is **logical time**, starting at Unix epoch and advancing 1 ms per event, not latency measurement; `sequence` defines order.

Use allowlisted projection, not secret-pattern heuristics: retain only known protocol methods/enums, versions, boolean capabilities, normalized request/session/tool IDs, error codes, and lifecycle facts. Arbitrary text, prompts, error messages, stderr, raw tool input/output, unknown keys/methods, paths, environment, PIDs, provider metadata, and binary content never enter artifacts. Unknown values use fixed placeholders. Raw values exist only in bounded memory for correlation, references, and assertions. Diagnostics never contain actual values.

The same deterministic mock scenario produces the same transcript. Real-provider update counts/order may vary; normalization does not make model output deterministic. Artifacts support stable diffs and future structural replay; **this slice has no lossless replay or API that reconstructs prompts from redacted content**.

Tool projection retains only `toolCallId`, `kind`, and `status`. Raw tool IDs are correlated by `(sessionId, toolCallId)` and assigned first-seen aliases such as `tool-1`, shared across `tool_call`, `tool_call_update`, and `session/request_permission.toolCall`. Allowed `kind` values are `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, and `other`; allowed `status` values are `pending`, `in_progress`, `completed`, and `failed`. Tool titles, input, output, locations, content, and permission-option text are never retained; unknown enum values are never emitted verbatim. This completes version 1's promised tool correlation/state facts, not lossless recording.

## 6. Copilot compatibility evidence (not ACP law)

Isolated research used installed `copilot.exe` **1.0.83**, with a strict 60 s deadline, 256 KiB frames, and 1 MiB output. Only a synthetic directory and prompt were used; every permission/client-tool request was automatically denied, and only the owned process tree was terminated. No raw output, generated content, environment values, or machine paths were retained.

Observed facts: `--acp` used stdio; initialization selected version 1 with a capability object and one authentication method; `session/new` returned a session; the synthetic prompt finished with `end_turn`, with 9 updates and no permission or client-tool requests. One success does not establish future-version, authentication-environment, or all-model compatibility. Absence of permission requests does not establish real-provider permission coverage.

A subsequent opt-in smoke used the harness public API, `copilot-cli-v1`, and the same `basic` scenario. Handshake, capability, and `end_turn` assertions passed without protocol exceptions. Only normalized facts were retained, not raw generated text.

Named profile `copilot-cli-v1` only composes safe launch arguments: disable updates, remote behavior, custom instructions, built-in MCP, bash environment, and ask-user; filter available tools to a nonexistent sentinel and explicitly deny shell/write/url; direct logs to the synthetic temporary directory. It does not alter protocol verdicts or import Torsor's runtime JSON action format. Other providers use explicit command/args with the same compatible scenario subset.

## 7. Delivery order and non-goals

TDD vertical slices: public API/CLI scenario loading → mock stdio initialize/new/prompt → JSONL and verdict; then same-schema strict YAML, faults/budgets, cancellation/permission races, and explicit real-provider opt-in. Tests exercise public interfaces rather than private class layouts. Ordinary PR CI is deterministic, requiring no real model, network, credentials, or exact natural language.

This PR does not integrate Torsor state, replace adapter/host tests, implement all ACP methods, authentication flows, model-quality evaluation, tool approval, fuzzing, broad provider matrices, lossless record/replay, a rich expression DSL, multi-host execution, or an OS sandbox. Extensions require paired specifications first, never profiles that hide protocol failures.
