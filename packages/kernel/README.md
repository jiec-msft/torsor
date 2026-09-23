# `@torsor/kernel`

## Physical execution records (schema 17)

`RegisterPhysicalWorktree`, `StartWorktreeExecution`, `RecordWorktreeExecution`,
`RevokeWorktreeExecutionAuthority`, and `RecoverWorktreeExecution` are trusted Runtime-only commands.
`GetPhysicalWorktree`, `ListPhysicalWorktrees`, and `GetWorktreeStorageIdentity`
are likewise local Runtime-only queries; their paths, process receipts, and
storage identity are not public Thread events or HTTP resources.

`physical_worktrees` binds an immutable repository/base/Run/directory identity.
`worktree_executions` and append-only `worktree_execution_events` retain source
Activation, executor incarnation, lease generation, process identity, and stop
evidence. `worktree_storage_identity` binds managed roots to this database.
Unsettled physical execution independently blocks the existing lease
acquire/release/quarantine-resolution commands. Expiry alone cannot unblock it.
Physical `Ready` means the binding is not quarantined, not that it is idle:
an unsettled execution still blocks reuse independently.

The trusted synchronous `performWorktreeMutation` boundary checks live lease,
receipt, Activation, and Run under `BEGIN IMMEDIATE`. Its callback must return
`undefined` without awaiting; it is not a general capability or an OS
transaction. A previously committed intent survives OS or transaction failure.
Only the local executor checks paths and attests original-handle stop evidence;
Kernel never interprets a PID or increasing generation as physical safety.

`checkWorktreePublication` additionally requires confirmed normal stop. Every Agent
mutation (including replay), Runtime activity/success and trusted report finalization
checks its Activation's durable Writer fence. Authority loss is irreversible and
returns `WriterAuthorityLost`; late close cannot restore publication. Stop/failure/
Unknown reconciliation remains available. A clean probe retains its lease through
result publication, then scope cleanup releases it. Reads retain Artifact authorization.

`revokeLocalWorktreeAuthority` accepts only the original locally retained receipt
and Runtime identity. It adds a process-local denial without touching SQLite, so
stopping an owned child never waits for a writer lock. It grants no authority and
does not replace durable revocation or conservative restart recovery.

The first `performWorktreeMutation` opts this Kernel instance into nonblocking
supervision until close. All synchronous database scopes then use no-wait lock
admission and restore the configured busy timeout in `finally`; none crosses an
`await`. This includes ordinary commands, queries and Artifact Writer checks, so
their contention cannot starve physical deadlines on the shared event loop.
Contention is an explicit failure, not mutation permission. `checkWorktreeAuthority`
uses a short rollback-only snapshot for monitoring, discarding even tentative
expiry/revocation writes. Real mutations and publications retain their write
transactions and full fences. Durable stop/revocation retries remain the executor's
responsibility; production's configured 5000ms timeout and schema are unchanged.

Earlier schemas, including versions 14 and 15, intentionally fail to open. Stop old processes and recreate
the disposable database **and use a fresh managed root**; no migration or
automatic deletion is performed. The normative contracts are MVP §§22, 24, 38,
and 43.1 in both languages.

`@torsor/kernel` is the durable local state boundary for the first Torsor
implementation slice. It stores collaboration and execution facts in SQLite
while keeping SQL and provider details behind consumer operations:

```ts
kernel.execute(command, principalContext);
kernel.query(query, principalContext);
kernel.readEvents(afterEventId, limit);
kernel.finalizeReport({ runId, expectedRunRevision, idempotencyKey, content }, principalContext);
kernel.readArtifact(artifactId, principalContext);
```

`readEvents` is a trusted-internal synchronization feed for the local
server/runtime boundary. A transport must apply its own authenticated
Project/Channel authorization before exposing event envelopes to a client.
Authenticated transports should use the public `ReadPublicEvents` query
instead of calling `readEvents`.

Server-facing projection pages are atomic Kernel queries:

```ts
const threads = await kernel.query(
  {
    type: "ListThreadProjections",
    projectId,
    channelId,
    afterEventId,
    snapshotEventId,
    limit,
  },
  principalContext,
);

const runs = await kernel.query(
  {
    type: "ListRunProjections",
    projectId,
    channelId,
    afterEventId,
    snapshotEventId,
    limit,
  },
  principalContext,
);
```

Both return complete projections, `nextAfterEventId`, `hasMore`, and the
authoritative `snapshotEventId`. The first page captures the latest committed
command boundary. Later pages reuse that snapshot, so concurrent creates are
excluded and updated entities are reconstructed from immutable components plus
narrow Run, RunInput, Activation, ProviderAttempt, and Attention versions.
Large unchanged Message, activity, and Artifact payloads are referenced once
rather than copied at every command boundary.

Every event cursor is scoped to `projectId`. A cursor from another Project and
a nonexistent cursor both fail with `NotFound` and the generic message
`Event cursor does not exist in the requested Project.` The default snapshot is
the latest committed event in the requested Project, not the global event log.

Authorized event replay is a bounded scan:

```ts
const page = await kernel.query(
  {
    type: "ReadPublicEvents",
    projectId,
    afterEventId,
    limit,
  },
  principalContext,
);
```

`events` contains only envelopes visible to the authenticated principal.
`scannedThroughEventId` advances across filtered Project events and is the next
`afterEventId`; `hasMore` reports whether more Project events remain. For an
Agent principal, the Kernel validates the current Activation and restricts
events to its authorized Channel and Thread.

Project Agent status is also Kernel-derived:

```ts
const status = await kernel.query(
  {
    type: "GetProjectAgentStatus",
    projectId,
    agentId,
  },
  principalContext,
);
```

Each Agent row includes live Run and Attention Activation counts, total live
Activations, nonterminal Run count, and `active`, `waiting`, or `idle`.
Attention-only work is `active`. Finished, revoked, expired, stale-generation,
resolved-Attention, and terminal-Run Activations are excluded using the Kernel
clock and the same authoritative scope rules used by capabilities.

Open a file-backed production database or the same adapter in memory:

```ts
import { TorsorKernel } from "@torsor/kernel";

const kernel = TorsorKernel.open({
  databasePath: "./torsor.sqlite",
  bootstrap: {
    principals: [
      { id: "human-1", kind: "human", displayName: "Avery Stone" },
    ],
    projects: [{ id: "project-1", name: "Sample Project" }],
    channels: [
      { id: "channel-1", projectId: "project-1", name: "general" },
    ],
  },
});
```

Every command has a principal-scoped idempotency key. Runtime activity must
carry durable Activation or ProviderAttempt provenance. Provider session IDs
are diagnostic only; provider delivery never changes RunInput disposition or
other semantic state.

`EditMessage` and `DeleteMessage` require the original Human author and the
expected latest Message revision. Editing appends an immutable revision with a
complete replacement body and Mention set; deleting appends a terminal
tombstone revision. Revision history, original provenance, prior Attention and
RunInput references, and revision-specific Mentions remain queryable.

`UpdateAgentConfig` creates the next immutable JSON configuration revision for
an Agent after checking the expected current revision. `AdoptRunConfig`
explicitly pins a nonterminal Run to a valid newer revision after checking both
the Run revision and current Agent configuration revision. Existing
Activations keep their recorded revision; only later Activations use the
adopted revision. Configuration content is not included in public event
payloads. These operations use the existing schema 17 revision tables and
pointers.

An Attention wakes its target Agent but does not choose a Run. A claimed
Attention Activation can use `IgnoreAttention`, attach the triggering Message
revision to an eligible same-Project, same-Channel, same-Thread Run with
`ResolveAttentionWithExistingRun`, or create a new Run with
`ResolveAttentionWithRun`. All three decisions consume the Attention exactly
once and end its handler Activation.

New Runs pass one write-transaction causal admission boundary (sections 25.1-25.2,
28.2, 32.7 of the paired MVP specification). Kernel derives immutable
`causalRootId`, `parentAttentionId`, `parentRunId`, and `delegationDepth` from
the triggering Message and authenticated Attention. Initial Runs start at
depth 0; Agent replies inherit the parent Run's Human Message root and add one
depth. Continuing a Run never resets its origin.

`KernelOpenOptions.causalLimits` is trusted server configuration with defaults
`{ maxDepth: 4, maxNonTerminalRunsPerRoot: 50 }`. New databases persist it;
reopen without an override uses that configuration, and an explicit mismatch
fails. Agent configuration and command payloads cannot raise these limits.
Admission counts durable nonterminal Runs under `BEGIN IMMEDIATE`, including
Waiting. Only a committed Completed/Failed/Cancelled transition releases a
slot, independently of Provider stop. Creation and terminal events carry
capacity evidence; `CausalLimitExceeded` includes the exceeded dimension,
effective limits, root, proposed depth, and current occupancy. Rejection
leaves the Attention decision open, and idempotent replay allocates no slot.
Provider cost, fan-out, per-Project/Agent quotas, and UI budgeting are deferred.

Outbox consumers use `ClaimOutboxEvents`, `AcknowledgeOutboxEvents`, and
`ListOutboxEvents`. Claims are ordered, leased, and recoverable after process
restart or lease expiry. Successful non-empty claims return `leaseExpiresAt`,
which is the exact shared expiry persisted on every returned OutboxEvent.
Idempotent recovery refreshes return the refreshed persisted expiry. A cached
batch that was acknowledged, superseded, moved outside the pending frontier,
or acquired by another lease fails with `Conflict`; Kernel never returns its
old token, expiry, or stale event views as delivery authority.

Run `StartActivation` and `StartProviderAttempt` admission carry the exact
Outbox event ID and lease token. Before a Run Activation can advance the
generation or revoke an existing owner, the Kernel transaction verifies the
Runtime principal, live Kernel-clock lease, one-event ownership, oldest pending
frontier, Run association, and Pending RunInput. ProviderAttempt admission
revalidates the same authority and verifies that the event input is included in
the delivery. Cached admission retries repeat those checks and return a fresh
`authorityObservedAt`; acknowledgement, expiry, supersession, frontier loss,
or an intervening lease fails closed before ownership changes or provider
invocation.

`ClaimAttention` also returns the exact persisted `leaseExpiresAt`. Runtime
must derive provider execution time from that authority rather than request
time:

```ts
const executionBudget = Math.min(
  providerTimeoutMs,
  Date.parse(claim.leaseExpiresAt) - safetyMarginMs - Date.now(),
);
```

Runtime must not start provider work when that budget is non-positive.
A cached claim succeeds only while its original lease token remains current
and unexpired. A superseded, expired, or reclaimed cached claim fails with
`Conflict`.

Attention dispatch is fenced by Agent, Project, Channel, and Thread. A claim
that overlaps another live handler lease or an unsettled `Started` or
`Acknowledged` Attention ProviderAttempt fails with `DomainBusy`. The fence
survives Attention resolution and process restart until provider settlement;
expired abandoned leases without unsettled provider work can be reclaimed.
Reclaim by another Attention atomically clears the superseded handler lease
and revokes its unfinished Activation. Cached claims, lease-authorized
decisions, and Activation capabilities must still match the durable fence, so
clock rollback cannot resurrect superseded authority.

Runtime recovery can read one `ProviderAttempt` directly and page
`ListRecoverableAttentionExecutions` in stable Activation start order without
scanning public event history, settled Activation history, or the complete
recoverable backlog. A normalized current-state table exposes two order-aligned
indexed ranges: expired unfinished Attention Activations and finished Attention
Activations that still own a `Started` or `Acknowledged` ProviderAttempt. The
Kernel merges at most `limit + 1` rows from each range and projects all
ProviderAttempts for each selected Activation once through the
`(activation_id, started_at, id)` order index.
Expired unfinished rows must remain non-revoked and match the current durable
domain lease; finished unsettled rows must remain owned by the same durable
domain fence and do not enter the authoritative set before their Activation
expiry. Supersession removes the old unfinished Activation from recovery state
and advances the recovery revision, so an in-progress sweep becomes stale
instead of returning revoked work.

Runtime can prove a full recovery sweep stable with
`GetAttentionRecoverySnapshot`. That write-serialized query advances
clock-derived expiry eligibility through its authoritative `observedAt` using
the expiry index, then returns the resulting revision and next future expiry.
This advancement touches each newly expired Activation once; page queries do
not revisit the full expired or future backlog. Runtime passes only the
captured `revision` as `recoveryRevision` to every
`ListRecoverableAttentionExecutions` page. `observedAt` and `nextExpiryAt` are
authoritative output evidence, not continuation input. Every page uses the
current Kernel clock and fails with `StaleRevision` if the revision changed or
any expired row still needs materialization. After the sweep, Runtime calls
`GetAttentionRecoverySnapshot` again and accepts the sweep only when the final
revision equals the captured revision. The final snapshot materializes any
expiry that crossed the horizon after the last page, so equality proves that
no relevant write or clock-derived membership change occurred during the
sweep. `nextExpiryAt` may be used only to schedule the next sweep.

`ParkRunAfterProviderAttemptFailure` is a Runtime-only atomic transition for a
current `Failed` or `Unknown` ProviderAttempt. It revision- and
generation-fences the Active Run, preserves Pending RunInputs, moves the Run to
Waiting, revokes unfinished Run Activations, records durable activity, and
does not create a replacement Activation or provider wake-up.

Configure `KernelOpenOptions.artifactStorage` with a trusted `ArtifactStorage`
adapter. `LocalArtifactStorage.open(absolutePrivateRoot)` implements immutable
local storage. `finalizeReport` accepts bytes or an async byte stream from a
live Run Activation, copies at most 1 MiB / 4096 chunks, computes SHA-256,
awaits durable storage, and only then atomically publishes descriptor, public
event, Outbox and idempotency result. Direct `execute(PublishArtifact)` is
forbidden, including for an otherwise authorized Agent. Report provenance is
Kernel-derived; no caller-supplied digest, file URL, path, or descriptor is
accepted. Reports have fixed plain-text media type and a `run:<id>@<revision>`
base reference, not a fabricated Git commit.

The private storage layout is `sha256/<64 lowercase hex>` plus
`staging/<random>.tmp`. Exclusive staging, file flush, no-replace hard-link
publication and full collision verification precede descriptor publication.
Reads reject invalid keys, links/junctions, non-regular files, size mismatches
and digest mismatches. Keep the root/ancestors Host-controlled, outside any
Provider-writable directory. This is not an OS sandbox. POSIX flushes directory
entries too; portable Node on Windows provides process-crash/restart recovery,
not a directory-flush/power-loss guarantee.

Retry uses the same principal, Run, key, bytes and expected revision. A new
currently authorized Activation may recover the same committed result and
original provenance. Revoked Activations cannot replay cached results. Before
commit, crashes leave invisible staging/orphan content; after commit, projections
and durable idempotency records recover lost responses. There is no background
Provider-output replay or online GC. Offline cleanup must preserve referenced
blobs. One descriptor per Run/digest remains enforced.

`GetArtifact` and `readArtifact` reauthorize the current principal and Run scope;
the latter repeats authorization after storage I/O and verifies returned bytes.
Descriptors expose `byteLength` and `producerThreadRootId`, never storage paths.
The local model retains global Human/Runtime reads and scoped Agent reads.
An Agent sees descriptors/events only for its current Run, across current and
historical projections, bounded event replay and conditional-command catch-up.
An Attention scope sees no Artifacts. Scope validation precedes descriptor
lookup; missing and inaccessible IDs return the same generic `NotFound` without
reading storage. Filtered event scan cursors still advance.
See paired MVP sections 21.3/21.5, 23.1/23.2/23.4 and 35.3 for requirements.

Worktree mutation is fenced by a Runtime-only durable writer lease. Acquisition
creates a new monotonically increasing generation and fencing token for the
Worktree; renewal preserves both values, and release never makes the same
authority current again. The lease is live only before its persisted expiry.
At the exact expiry timestamp it is expired, cached idempotent acquisition or
renewal results fail closed, and the next acquisition receives a higher
generation and fencing token. An authority operation that first observes the
expiry commits that transition before returning its error, so a backward clock
adjustment cannot revive the old token. Runtime must include the exact generation,
fencing token, and opaque lease token when renewing or releasing authority.
The opaque token is returned only by successful acquisition or renewal,
including a live idempotent retry after restart; state queries never disclose
it to another process sharing the Runtime principal.

Uncertain or invalid writer state can be moved to `Quarantined`.
Quarantining an active lease requires its exact generation, fencing token, and
opaque lease token; public state cannot authorize a stale process to fence the
current writer. Quarantine clears live authority and advances the fencing token
as a durable barrier, including when no prior lease exists. Acquisition remains
blocked until `ResolveWorktreeWriterLeaseQuarantine` matches the current
revision and barrier token and presents the opaque reconciliation token returned
only by the quarantine command. `GetWorktreeWriterLease` materializes
clock-derived expiry, and
`ListWorktreeWriterLeaseEvents` exposes the durable acquisition, renewal,
release, expiry, quarantine, and reconciliation ledger. These primitives do
not perform filesystem mutation, process execution, or shell execution.

The current direct schema version is 17. It combines the physical records and
irreversible Writer publication fences above with trusted Artifact byte
length and source Thread provenance (replacing caller-provided storage
locations) with durable server-owned causal limits, immutable Run root/parent/depth,
and the root-scoped nonterminal admission index. Defaults remain inclusive depth
4 and at most 50 nonterminal Runs per root. Schema 16 is rejected because it
can contain pre-redaction public Provider diagnostics. Earlier schema 14 layouts
(causal-only, Artifact-only and Worktree-only) and schema 15 are also rejected
before DDL/bootstrap. There is no version-only compatibility shortcut or migration.
Artifacts trace causality through their producer Run; equal content in parent
and child Runs shares a blob, not descriptor identity, authorization or a Run slot.
Version 13 adds durable Worktree
writer lease state and its independent event ledger. It retains version 12's
bounded Attention recovery expiry horizon. Version 12 gives unfinished and
finished-unsettled Attention recovery one bounded expiry-horizon index, so
Kernel-clock promotion and revision checks remain indexed after recovery
membership moves fully into the Kernel. It retains version 11's non-revoked
Activation and durable Attention-domain ownership requirements plus the
normalized recovery state, ordered page indexes, count-only expiry promotion,
recovery mutation revision, incremental provider/domain counters, and durable
Agent/Project/Channel/Thread execution fences.
This pre-release schema is intentionally breaking: stop old processes and
explicitly recreate disposable databases rather than migrating earlier versions,
and use fresh managed roots. Opening an older database fails without
modifying its version, schema, or data.

Version 16 alone is not compatibility proof. An existing file is checked with a
read-only connection before any writable open, then rechecked under the schema
initialization lock. A reference schema in isolated memory supplies a SHA-256
fingerprint of SQLite object definitions, column/FK/index pragmas and STRICT
metadata. SQL token comparison ignores formatting/comments but preserves
quoted literals, operator boundaries, CHECK predicates and trigger bodies.
Missing, altered or extra-incompatible objects fail unchanged, including files
with an uncheckpointed WAL; no `CREATE IF NOT EXISTS` repairs are attempted.
SQLite-owned statistics are excluded. Integrity and required durable config
rows and Worktree storage identity are checked too. Only an empty version-0 database runs DDL/config/bootstrap,
atomically; a valid reopen never reapplies bootstrap.
