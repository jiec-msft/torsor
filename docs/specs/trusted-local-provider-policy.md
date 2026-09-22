# Trusted Local Provider Policy

> English | [简体中文](trusted-local-provider-policy.zh-cn.md)

## 1. Status and charter

This specification implements the intent of [#24](https://github.com/jiec-msft/torsor/issues/24):
a required MVP 0.1 slice after execution foundations land, not an already supported
real-provider launch path. Phase 1 supplies testable policy intent and environment
preparation only. It changes no existing adapter enforcement, starts no process,
adds no Host configuration entry point, and grants no Writer Authority.

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

## 6. Phase 1 acceptance

Deterministic unit tests cover the restricted default, explicit trusted-local and
Allow All, invalid selections/combinations, both environment strategies, internal
control removal, provider environment retention, input immutability, fixed bounded
configuration, and secret-free serialization. Tests start no provider, make no
network calls, and create no durable state or real credential artifacts. Existing
adapter launch enforcement remains unchanged; Phase 1 does not complete #24.
