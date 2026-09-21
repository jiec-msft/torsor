# `@torsor/agent-runtime`

`@torsor/agent-runtime` consumes durable Kernel work and runs one provider
process for each Activation. The Kernel remains authoritative for Attention,
Run, RunInput, provenance, revisions, terminal state, and outbox delivery.

The runtime provides:

- Runtime-owned Attention claims and Activation creation.
- Explicit Agent decisions to ignore an Attention, continue one eligible
  same-thread Run, or create a new Run.
- Configurably bounded Attention concurrency across independent Agent/Thread
  domains and Projects, with page-round-robin discovery, hierarchical
  Project/domain dispatch, in-pass reconsideration, and same-domain ordering
  preserved locally across pages and claim races. The configured Project
  rotation persists at the first globally unadmitted Project. Each Project
  retains at most the smaller of `attentionConcurrency + 1` and its equal
  share of the global candidate buffer, with a minimum of one candidate. Thus,
  when ready Projects outnumber the candidate buffer, a concurrency-one
  runtime gives every Project its first provider start within one ready-Project
  rotation. Per-Project snapshot and keyset continuations also persist across
  saturated admission rounds, so a full first page cannot repeatedly hide
  ready work on a later page. A continuation is cleared after its snapshot is
  exhausted; the next pass starts a fresh snapshot so empty/refilled Projects,
  claim losses, evictions, and newly opened Attentions are reconsidered.
  Continuations are keyed by the stable Project ID and consume only bounded
  metadata per known Project. Later-page candidates replace queued candidates
  within the same bounded Project reservoir rather than joining an unbounded
  FIFO.
- Ordered, leased outbox consumption with idempotent command keys.
- A provider-neutral adapter contract and deterministic fake adapter.
- A GitHub Copilot CLI ACP stdio adapter using `copilot --acp --stdio`.
- An Activation-scoped capability bridge that binds Agent identity, Run,
  Activation, ProviderAttempt, revisions, and provenance on the server side.

Provider session IDs are diagnostic only. Recovery always rebuilds provider
input from Kernel projections and never treats a provider session as
authoritative state. Provider delivery failures park Runs through one atomic
Kernel command, and expired Attention executions are discovered through
bounded targeted projections rather than public-event history scans. Recovery
restarts bounded keyset sweeps after settlements, so an older Activation that
becomes eligible behind an advanced cursor during a productive sweep is still
reconciled in the same drain. Proving that an otherwise clean complete sweep
was mutation-free still requires a Kernel recovery-set revision or snapshot
token.

Cross-runtime same-Agent/Thread serialization still requires a Kernel claim
domain fence. Runtime-local domain queues cannot prevent a second runtime from
claiming the next Attention after the first decision commits but before its
ProviderAttempt finishes.

The current Kernel contract does not expose lease renewal. The runtime
therefore claims one outbox event at a time and requires Attention and outbox
leases to exceed the configured provider timeout by a safety margin.
The current claim result contract does not return the authoritative Attention
lease expiry, so provider execution cannot yet shrink its timeout to account
for setup time already consumed after the claim.

Because the Kernel outbox is globally ordered, runtime instances coordinate
through the same leased stream. `projectIds` supplies the Projects whose
existing open Attentions are scanned at startup; Projects encountered in
outbox events are loaded dynamically.

The Copilot adapter starts with a deny-by-default provider policy. It filters
the model-visible tool list to a nonexistent Runtime sentinel, explicitly
denies shell, write, and URL permissions, disables built-in MCP servers and
custom instructions, supplies no session MCP servers, and launches with a
minimal environment allowlist. Custom command arguments are rejected unless
the caller explicitly enables the unsafe development option used by test
fixtures. Child stdin write, end, EOF, and pipe failures are folded into the
same provider failure and cleanup path.

Copilot returns a bounded JSON action envelope rather than invoking Kernel
commands directly. Frame, stream, persisted activity, pending write, JSON
depth, action, target, and field limits are enforced before unbounded effects.
The bridge then applies only server-bound Kernel capabilities; provider output
cannot choose provenance, Agent identity, Activation identity, or
ProviderAttempt identity.

Artifact publication is intentionally unavailable to providers until the
runtime has a trusted finalizer that persists bytes and computes the immutable
digest and location. The Copilot process is also not an operating-system
sandbox; this slice relies on the CLI tool-availability boundary and sanitized
environment and does not provide Worktree, Git, terminal, or multi-host
execution.
