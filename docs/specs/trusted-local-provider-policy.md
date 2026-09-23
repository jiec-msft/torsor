# Trusted Local Provider Policy

> English | [简体中文](trusted-local-provider-policy.zh-cn.md)

## 1. Status and charter

This specification implements the intent of [#24](https://github.com/jiec-msft/torsor/issues/24):
the MVP 0.1 trusted-local execution slice. Phase 2 connects the Phase 1 policy
intent and environment preparation to merged lease-backed execution. Schema 18
preserves schema 17 public diagnostics and adds Provider receipts. Policy itself
still grants no Writer Authority.

The [design baseline](../prototype/001-overview.md), sections 5, 22, 34, 43, and
44.4, permits Agents to use granted CLI, API, MCP, and provider-native tools
directly. Kernel protects durable facts, identity, revisions, idempotency,
provenance, and Writer ownership. Torsor does not reimplement existing Agent
capabilities or equate tool intent with execution authority.

## 2. Closed policy intent

Exactly two policies exist: `restricted` and `trusted-local`. A trusted Host
selects policy; prompts, provider output, environment variables, and unknown
configuration cannot imply elevation. An omitted selection means `restricted`;
invalid selections fail rather than fall back. Values are not a composable policy DSL.

| Field | `restricted` | `trusted-local` |
|---|---|---|
| `kind` | `restricted` | `trusted-local` |
| `tools` | `runtime-actions-only` | `provider-native` |
| `mcp` | `disabled` | `provider-configured` |
| `customInstructions` | `disabled` | `provider-configured` |
| `environment` | `restricted-allowlist` | `inherit-user-provider` |
| `permissionMode` | `deny` | Explicit `provider-default` or `allow-all` |

`restricted` retains current restricted launch semantics for deterministic CI,
shared hosts, and unattended execution: the model sees only the Runtime action
sentinel; shell/write/URL are denied; built-in and session MCP, custom instructions,
and shell startup environment are disabled. It is not an operating-system sandbox.

`trusted-local` expresses normal provider-native shell, write, URL, configured MCP,
and custom instructions. Selection must supply both `kind: "trusted-local"` and
`permissionMode`. `provider-default` does not request Allow All; `allow-all` is an
explicit unattended Allow All intent, not a substitute for leases or authority
checks. Concrete CLI flags, ACP mode/config identifiers, and capability discovery
remain behind the Copilot adapter seam; this layer neither hard-codes nor guesses them.

## 3. Environment strategies and credentials

Environment preparation accepts explicit inherited environment and optional
provider overrides. It must not read global `process.env`, mutate inputs, or start
processes. Its result is transient future spawn input, never part of policy objects,
durable state, prompts, logs, or public diagnostics.

`restricted-allowlist` inherits only `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`,
`COMSPEC`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `LANG`,
`LC_ALL`, and `TERM`. Explicit Copilot overrides accept only `COPILOT_PROVIDER_*`,
`COPILOT_PROVIDERS_CONFIG`, and `COPILOT_HOME`; all other names fail with a fixed
error that echoes neither names nor values. Environment contents cannot enable Allow All.

`inherit-user-provider` preserves normal user/provider environment and
provider-owned credentials without introducing credential storage or restricting
authentication to a few names. Both inputs must lose all `TORSOR_*` variables.
That entire namespace is reserved for internal Torsor Host/daemon/runtime control,
including database, authentication, Activation, path, and scheduling controls.

The Copilot seam also removes inherited or overridden `COPILOT_ALLOW_ALL` and
`COPILOT_ASSISTED_APPROVAL`, so environment cannot replace explicit permission-mode
selection. Even for `allow-all`, preparation must not inject authorization variables;
the future adapter must apply intent through supported launch/ACP configuration.
Name filtering is case-insensitive; retained key spelling is preserved, undefined
values are omitted, and an override replaces an inherited value with the same
spelling. This retains current restricted key handling; this layer does not
normalize multiple keys differing only in case.

Environment is not public serializable configuration. Credentials remain
provider-owned and flow only through the local execution boundary, never into
durable state, prompts, public diagnostics, or test artifacts. Tests use synthetic
values only and read no actual user environment, credentials, or provider configuration.

## 4. Validation and serialization

Selection and full-policy validation must reject unknown fields, missing fields,
incorrect types, and inconsistent combinations. Only plain data objects are
accepted; configuration accessors and `toJSON` are not executed. Errors must not
contain input. Canonical policies are frozen objects containing only the six
fixed-order enum-string fields above: no commands, paths, environment values, MCP
payloads, instruction bodies, credentials, or general extension bag.

Serialization must revalidate the full policy and emit canonical field order,
not directly serialize the caller's object. Every valid compact JSON configuration
is at most 256 ASCII bytes; decoded data can be revalidated and field order does not
change the result. Invalid objects or additional payloads fail rather than silently
losing fields.

## 5. Phase 2 execution prerequisites

Wire real Copilot ACP launch only after [#19](https://github.com/jiec-msft/torsor/pull/19)
and provider diagnostic-redaction work have merged into main and been integrated:

1. Runtime derives cwd from the assigned physical Worktree, acquires Writer Lease
   before spawn, and binds Activation, Run, execution receipt, generation, fencing,
   and the original process handle. The provider holds Writer Authority throughout
   native-tool execution; do not wrap each filesystem operation in a Kernel
   transaction or simply remove existing deny flags.
2. Cancellation, expiry, shutdown, authority loss, and takeover stop the owned
   process tree independently of SQLite. Unconfirmed stop must not admit a new
   Writer to the same directory; unknown termination quarantines it, and recovery
   respects generation and fencing.
3. Revalidate authority before publishing activity, Artifacts, replies, or successful
   completion; reject late output. Use supported ACP initialize, session, mode/config,
   prompt, cancel, and close lifecycles. Public Tool started/completed/failed facts
   must be bounded and normalized, without raw prompts, environment, unrestricted
   stdout/stderr, or secret-bearing payloads.
4. Exercise tool writes, cancellation, expiry, SQLite contention, Host restart,
   stale output, quarantine, and replacement Writer admission against merged
   deterministic interfaces, coordinating with #22. A separately opted-in real
   Copilot smoke edits and tests only a synthetic repository in a disposable Worktree,
   stays outside ordinary CI, and retains neither generated content nor credentials.
   #23 documents the final supported usage afterward.

This slice provides no hostile-code sandbox, multi-tenant isolation, arbitrary
execution entry point outside the assigned Worktree, marketplace, general policy
editor, credential store, or exactly-once external API/MCP effects. `restricted`
must remain a deterministic CI mode without real model or network calls.

## 6. Phase 1 acceptance (historical scope)

Deterministic unit tests cover the restricted default, explicit trusted-local and
Allow All, invalid selections/combinations, both environment strategies, internal
control removal, provider environment retention, input immutability, fixed bounded
configuration, and secret-free serialization. Tests start no provider, make no
network calls, and create no durable state or real credential artifacts. Existing
adapter launch enforcement remains unchanged; Phase 1 does not complete #24.

## 7. Phase 2 launch and public observation contract

A trusted Host explicitly selects policy. Attention decisions have no Run
Worktree and must remain `restricted`; only Run execution may be `trusted-local`.
Runtime binds ProviderAttempt and policy; Executor derives the unique physical
directory from the Run, never provider cwd. First execution may create a detached
Worktree at a pinned commit in the configured repository, without repository
hooks. Unregistered leftover directories or ambiguous ownership fail rather than
being adopted. Registered directories must be revalidated.

Acquire Lease and durable execution receipt before starting the controlled
process owner. Retain the original process tree, using a Windows Job Object or
Linux process group with `/proc` membership observation. Other platforms explicitly
reject native launch rather than falling back to single-PID kill. Windows creates
the provider suspended, assigns the Job, then resumes; closing the Job kills its
members. The Linux owner retains the original group identity until observing an
empty group. Provider exit stops remaining members; lost/forced owners without
whole-tree evidence remain uncertain. Configuration crosses a private stdin
handshake, never supervisor command arguments or disk configuration files.
Stop evidence must cover the entire owned tree, not merely
the provider's exit or an old PID. Normal completion stops the tree before final
actions and retains the Lease through publication/settlement. Every stop initiates
OS operations before waiting on SQLite. Unknown termination quarantines the
Worktree; recovery must never reacquire process authority from a PID.

Every public Run capability locally rejects revoked/expired execution and
revalidates Writer Authority inside the Kernel transaction. Trusted-local cannot
publish without an execution binding. Success requires normal physical stop and
a still-valid execution receipt. Concurrent recovery and nonblocking supervision
remain intact.

Schema 18 extends schema 17's diagnostic privacy contract with explicit native
execution ProviderAttempt/policy binding. `StartWorktreeExecution.provider`
accepts only `providerAttemptId`, `policy: "trusted-local"`, and
`permissionMode: "provider-default" | "allow-all"`. The ProviderAttempt must belong
to the same Activation and remain executing. Persist this binding as a receipt
fact, never arbitrary configuration. Omission still means the fixed probe.
Stop old processes and recreate old development databases explicitly; do not
migrate, automatically delete data, or restore diagnostic-session identifiers.

Tool observation persists only `tool_started`, `tool_completed`, and `tool_failed`
activities with payload fields `toolCallId` generated within this ProviderAttempt,
ACP enum `kind`, and normalized `status`. Never store provider tool IDs, titles,
commands, paths, arguments, results, MCP server names, or error text. Track at most
128 tools and accept at most 512 tool updates; raw IDs are memory-only and at most
256 characters. Initial pending/in_progress publishes started once, terminal
state at most once; unknown IDs, invalid statuses, or terminal-state changes fail.
A terminal initial call publishes started followed by its terminal fact. Timeline
uses these fixed fields and existing Run/Activation/ProviderAttempt provenance.

Trusted-local raw assistant chunks feed only the bounded in-memory final action
envelope, not public streaming activity. Tool and diagnostic text never becomes
a report or reply automatically. Explicit final public actions still use the
existing capability channel. ACP session IDs are memory-only routing data, never
restored diagnostic-session fields; failures retain schema 17 stable codes and
fixed summaries.

Deterministic tests must demonstrate a real fixed provider writing and running a
synthetic test in the assigned Worktree, plus Shell/MCP tool states, cancellation,
expiry, SQLite contention, Host restart, stale output, unknown stop/quarantine,
and replacement Writer admission. Real Copilot smoke requires explicit opt-in,
uses only disposable synthetic directories, removes them afterward, and never
runs in ordinary CI.

The local Host uses `TORSOR_PROVIDER_POLICY` (default `restricted`) and requires
`TORSOR_PROVIDER_PERMISSION_MODE` for `trusted-local`, rejecting that permission
setting for `restricted`. Trusted-local also requires `TORSOR_REPOSITORY_PATH`,
`TORSOR_WORKTREE_ROOT`, and full-commit `TORSOR_BASE_REVISION`, and rejects
`TORSOR_PROVIDER_CWD`. `TORSOR_PROVIDER_TIMEOUT_MS` defaults to 120000 for
trusted-local and 25000 for restricted, accepts 1000 through 295000, and derives
Attention, Outbox, Activation, and Writer windows as timeout plus 5000 milliseconds.
These are bounded attempts, not renewable sessions.

Explicit Copilot `allow-all` uses the publicly supported `--allow-all` and selects
only an advertised ACP `allow_always` or `allow_once` permission option;
`provider-default` denies unattended permission requests. Prefer advertised
`configOptions`, otherwise legacy `modes`, selecting only advertised `agent` /
`interactive` coding modes, never treating Autopilot as a permission mode.
Closing stdin is normal ACP close; cancellation sends `session/cancel` before
stopping the original tree. See [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
and [ACP config options](https://agentclientprotocol.com/protocol/session-config-options).

Ordinary CI runs the fixed native ACP smoke and opt-in gate tests without reading
real provider configuration. Real smoke requires `--allow-real-provider`; missing
opt-in refuses before environment access, directory creation, Git or Provider
launch. Confirmed stop removes Torsor's temporary database and synthetic content.
Unconfirmed stop preserves the quarantined directory and fails explicitly rather
than deleting a possibly live Writer's directory. Provider-owned global sessions/logs
and external MCP/API effects are outside Torsor cleanup; no provider-side erasure
guarantee is made.
