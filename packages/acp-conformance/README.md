# `@torsor/acp-conformance`

> English | [简体中文](README.zh-cn.md)

Independent ACP v1 provider scenario runner, without Torsor Kernel, Runtime, or Host dependencies. See the [paired specification](../../docs/specs/acp-conformance.md) for the contract and reuse decision. This checks an explicit protocol subset, not complete ACP certification.

## Quick start

Install and build from the repository root:

```powershell
npm ci
npm run build --workspace @torsor/acp-conformance
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json
npm exec -- acp-conformance run packages\acp-conformance\examples\cancel.yaml packages\acp-conformance\examples\malformed.yaml
npm run test:acp-conformance
```

Paths above use PowerShell syntax; use `/` in POSIX shells. `basic.json` and `basic.yaml` are equivalent; do not put both identical IDs in one CLI suite. Defaults use only the local deterministic mock, without models, network, or credentials.

```ts
import { loadScenario, runScenario, runSuite, toJsonl } from "@torsor/acp-conformance";

const scenario = loadScenario(syntheticScenarioText, { format: "yaml" });
const result = await runScenario(scenario);
const transcript = toJsonl(result);
const suite = await runSuite([scenario]);
```

The single configuration schema lives in `src/schema.ts`. JSON/YAML parse into the same bounded JSON before strict validation; unknown control fields fail. `ConfigurationError.paths` identifies structural locations without echoing values. Input is limited to 256 KiB and depth 32. `schemaVersion` must be `1`.

## Scenarios and mocks

`request` starts an asynchronous request with a local label; `response` consumes its result. `notification` sends notifications, `update` consumes matching session updates, and `close-stdin` / `exit` assert process lifecycle. `response.expect` and `update.expect` use `{ path, equals }` or `{ path, kind }`, where `path` is an RFC 6901 JSON Pointer. `errorCode` asserts RPC errors. Assertions target protocol facts, not model wording.

Parameters support `{ "$ref": "workspace" }` and `{ "$ref": "session#/sessionId" }`; the latter references a consumed response. No string interpolation, environment expansion, or executable code.

Nonempty IDs returned by `session/new` must be unique on the connection. Initial `tool_call` IDs must also be nonempty and unique within each session; announce a tool before updates or permission requests refer to it. Content/tool updates and permission requests require an active prompt. Valid permissions always receive `cancelled`; invalid lifecycles are rejected before acknowledgement. A new prompt cannot reuse that session's initial tool IDs.

`mock.handlers` registers SDK handlers by `method` / `kind`; actions are `reply`, `notify`, reverse `request`, named `wait` / `release` gates, and `fault`. `mock.onStdinClose` deterministically injects post-EOF output. `fault.kind` includes `malformed`, `oversized`, `stderr`, `stdout-close`, `stdin-close`, `exit`, `hang`, and `wire`. `wire.message` is an explicit JSON message; `wire.newline: false` tests partial frames. `oversized` / `stderr` use `bytes`. These are test faults, not production compatibility behavior.

```powershell
npm exec -- acp-conformance mock packages\acp-conformance\examples\basic.json
```

This command exposes a standard ACP stdio peer that other clients can launch directly. Normal protocol correlation and dispatch reuse the official SDK, not a second JSON-RPC engine.

`stdout-close` / `stdin-close` faults require the runner-owned mock control channel; the standalone `mock` command does not provide those two faults. Windows uses MIT-licensed Koffi prebuilt native bindings to establish a job object, without runtime compilation or PowerShell; failed ownership setup never launches a provider. Do not omit the matching native optional package during installation. POSIX uses a dedicated process group.

## Results and budgets

`--out <directory>` writes per-scenario `.result.json` and `.transcript.jsonl`, refusing overwrites. Results are `passed`, `failed`, or `skipped`. CLI codes are all-passed `0`, failure `1`, configuration/usage/I/O error `2`, and real-provider-disabled `3`; failure takes precedence over skips.

Both destinations are exclusively reserved before either file is written. A collision preserves existing files and rolls back this attempt's reservations without leaving a new partial pair; remove the conflict and retry. Rollback failures explicitly report an I/O error. Cross-scenario and crash-atomic commits are not guaranteed.

Diagnostics contain stable `code`, zero-based `step` (`-1` during startup), and descriptions without raw values. `expectFailure` exercises harness failure paths; a match retains its diagnostic, and cleanup failure never passes.

Override `limits.frameBytes`, `stdoutBytes`, `stderrBytes`, `events`, `startupMs`, `stepMs`, `runMs`, or `shutdownMs`. Defaults are respectively 262144, 1048576, 65536, 2048, 15000, 5000, 30000, and 2000. Startup has a separate budget from protocol steps. Real providers often need explicitly larger `stepMs` / `runMs`; failures never retry automatically.

JSONL retains only allowlisted protocol facts, stable identities, and ordering. Logical timestamps advance 1 ms per event and do not measure elapsed time. Prompts, generated content, stderr, error prose, environment, machine paths, and unknown payloads are omitted or redacted. This is for structural diffing, not lossless wire capture, and this slice has no replay API.

## Optional real providers

Explicit opt-in is mandatory; credential presence cannot enable execution. Use only trusted commands: the harness is not an OS sandbox.

```powershell
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json --allow-real --profile copilot-cli-v1 --inherit-env COPILOT_GITHUB_TOKEN
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json --allow-real -- provider-executable --acp
```

Authorize only necessary environment names; never put credentials in scenarios, arguments, artifacts, or the repository. Unset environment names fail explicitly. Home, config, cache, and temporary directories are isolated by default; login files are not automatically reused. The named Copilot profile disables tools and unnecessary integrations and directs logs into the temporary workspace. Lifecycle-valid permission requests receive `cancelled`, while invalid requests fail the scenario; other client-tool requests return Method Not Found. Valid tool-activity notifications alone are not protocol violations.

API callers use `runScenario(scenario, { allowReal: true, provider: { command, args, environment } })` or `provider: { profile: "copilot-cli-v1", environment }`. Command/args are separate and never invoke a shell; Windows `.cmd` / `.bat` are rejected. Ordinary CI never enables real providers. `basic` is the shared mock/real smoke subset; cancellation/fault examples require scripted coordination and cannot be assumed to match arbitrary real models.

## Maintenance boundaries

Paseo's public ACP adapter serves application sessions/timelines rather than raw protocol verdicts; no deep imports or copied source. Official ACP SDK 1.4.0 (Apache-2.0) owns protocol exchange, Ajv (MIT) validates its published method schemas, Zod (MIT) defines scenarios, and YAML (ISC) parses configuration.

Full replay, fuzzing, broad provider matrices, ACP v2, authentication flows, tool approval, and a rich DSL are deferred. Existing Torsor adapter/host tests remain independent.
