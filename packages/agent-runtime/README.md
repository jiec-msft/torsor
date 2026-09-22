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
captures an authoritative recovery snapshot, supplies only its revision to
every bounded keyset page, and restarts from a fresh snapshot on stale pages
or a changed final revision. Finished Attention Activations are not reclaimed
before their expiry horizon, so a provider that has committed its decision but
is still returning retains the cross-runtime domain fence. Superseded recovery
work is discarded rather than settled from a stale page.

Runtime-local queues preserve bounded Project/domain fairness and serialize
same-domain work within one process. Kernel Attention claims provide the
cross-runtime Agent, Project, Channel, and Thread fence. `DomainBusy` skips the
contended domain without failing unrelated work, and the fence remains held
through ProviderAttempt settlement, including the interval after an Attention
decision commits and before the provider returns.

The current Kernel contract does not expose lease renewal. The runtime
therefore claims one outbox event at a time. Attention and non-empty outbox
claims return their persisted lease expiry. Run ProviderAttempt admission
atomically validates the exact Outbox event, lease token and principal, live
Kernel-clock expiry, oldest pending frontier, and delivered RunInput. The same
idempotent admission is revalidated immediately before adapter invocation, so
an acknowledged, expired, superseded, or reclaimed event cannot reuse a cached
ProviderAttempt as fresh authority.

Immediately before provider work, the runtime limits execution to the smaller
of the configured provider timeout, local remaining lease time, and the
Kernel-observed remaining admission window, minus a one-second default safety
margin. Local time can shorten that window but cannot extend it after rollback.
Runtime-requested Activation windows cover the corresponding lease window, so
a shorter Kernel default cannot truncate provider authority. Non-finite or
non-positive budgets never start provider work, and stale authority fails
closed rather than being treated as refreshable.

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
