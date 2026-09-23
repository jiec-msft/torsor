# `@torsor/agent-runtime`

## Controlled physical Worktree tracer

The optional `LocalWorktreeExecutor` implements only `write-probe-v1`, governed by
MVP §§22.1–22.4, 24.2–24.3, 38.1–38.4, and 43.1. It registers a trusted,
pre-provisioned detached Git worktree under a private managed root, exclusively
creates `torsor-probe.txt`, and runs a fixed Node child to digest the content.
It does not provision Git worktrees, execute repository code, run arbitrary
commands, or grant ACP native shell/write tools.

`register` binds immutable physical/repository/Run facts; `start` and `probe`
require a live Run Activation. Every mediated mutation is checked under the
Kernel write lock after a durable execution intent. `stopActivation`, `recover`,
and `close` bound the lifecycle. Runtime gives explicitly enabled trusted
adapters only `context.worktree.probe(worktreeId)`, never a path or executable.
Attention contexts have no such capability.

Clean `probe` requires the fixed digest, normal child close and a current Writer
fence; it retains the lease until Activation publication/settlement ends. Kernel
guards activity, report finalization, terminal effects and cached mutation results.
Cancellation, uncertainty, expiry or restart irreversibly revokes publication,
even if a late child close makes the directory physically reusable. Reports go
through the existing authorized `publishReport` capability, never raw descriptors.
The fixed stdout protocol is bounded to 65 bytes, stderr to 1024 discarded bytes;
the child inherits no credentials or injection settings. Provider-facing failures
are fixed `Unknown` diagnostics, not local paths or raw process output.

Logical lease expiry is not process exit. An unsettled execution blocks lease
release and reacquisition. Unconfirmed stop quarantines the directory; only
original-handle close evidence permits local reconciliation. A restart that
loses that handle leaves quarantine in place even when the old PID disappears.
There is no manual text-based physical quarantine override.

Stopping an owned child does not wait for SQLite persistence. Local receipt-bound
authority is revoked immediately; physical stop/force and retained close evidence
are independent of durable revocation/disposition/release. Persistence failures
surface to callers and retain a retry timer; repeated stop/close retries writes
without resending successful signals. Host keeps Kernel open on cleanup failure
until a later close succeeds. Recovery of already committed Provider completion
uses an `Expired` Activation settlement if Writer authority is lost, preserves
the committed result, and acknowledges the recovered outbox without rerunning work.
If another Host wins that settlement, only the specific already-finished conflict
plus a fresh authoritative terminal Activation permits acknowledging delivery;
unrelated conflicts and unfinished Activations remain errors.

The monitor uses Kernel's rollback-only authority observation, not a write lock.
Before the first physical effect, the Kernel instance opts into no-wait synchronous
database scopes for the rest of its lifetime, restoring the configured production
busy timeout after each call. This covers commands, publications and cleanup
retries as well as monitoring, so SQLite contention cannot starve another handle's
deadline, queued cancellation or shutdown. Every actual mutation still rechecks
authority transactionally; observational snapshots grant no effect permission.

The managed root is bound to one database storage identity by `.torsor-owner`.
Use a fresh root after recreating the database. Do not concurrently run copied
databases against it. The private root must exclude concurrent external path
replacement; path checks are not a same-user OS sandbox. General process-tree
containment, cross-restart stop proof, Pause/Resume, Terminal, Files UI, GC, and
external integration remain out of scope.

`controlled-process.ts` is an isolated trusted process-driver seam. Synthetic
fixtures exercise stop uncertainty and crashes without adding another Provider
conformance engine.

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
claims return their persisted lease expiry. Run Activation creation atomically
validates the exact Outbox event, lease token and principal, live Kernel-clock
expiry, oldest pending frontier, and Pending RunInput before it can advance the
generation or revoke another owner. ProviderAttempt admission revalidates that
authority and the delivered RunInput immediately before adapter invocation, so
an acknowledged, expired, superseded, or reclaimed event cannot reuse a cached
Activation or ProviderAttempt as fresh authority.

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

When the Host configures Artifact storage, a Run bridge offers
`publishReport({ idempotencyKey, text })`. ACP exposes only the bounded
`publish_report` action with those fields. The bridge binds Run/revision and
Activation, and Kernel finalization computes the digest and persists real bytes
before publication. Stable report keys are Run-scoped, not ProviderAttempt
sequence numbers. Extra descriptor/provenance fields fail before actions apply;
`publish_artifact` remains forbidden. Without storage the capability fails closed
and is not advertised. Report publication does not complete the Run.

The Copilot process is also not an operating-system
sandbox; this slice relies on the CLI tool-availability boundary and sanitized
environment and does not provide Worktree, Git, terminal, or multi-host
execution.
