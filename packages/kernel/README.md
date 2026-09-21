# `@torsor/kernel`

`@torsor/kernel` is the durable local state boundary for the first Torsor
implementation slice. It stores collaboration and execution facts in SQLite
while keeping SQL and provider details behind three consumer operations:

```ts
kernel.execute(command, principalContext);
kernel.query(query, principalContext);
kernel.readEvents(afterEventId, limit);
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

An Attention wakes its target Agent but does not choose a Run. A claimed
Attention Activation can use `IgnoreAttention`, attach the triggering Message
revision to an eligible same-Project, same-Channel, same-Thread Run with
`ResolveAttentionWithExistingRun`, or create a new Run with
`ResolveAttentionWithRun`. All three decisions consume the Attention exactly
once and end its handler Activation.

Outbox consumers use `ClaimOutboxEvents`, `AcknowledgeOutboxEvents`, and
`ListOutboxEvents`. Claims are ordered, leased, and recoverable after process
restart or lease expiry. Successful non-empty claims return `leaseExpiresAt`,
which is the exact shared expiry persisted on every returned OutboxEvent.
Idempotent recovery refreshes return the refreshed persisted expiry. A cached
batch that was acknowledged, superseded, moved outside the pending frontier,
or acquired by another lease fails with `Conflict`; Kernel never returns its
old token, expiry, or stale event views as delivery authority.

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

Runtime recovery can read one `ProviderAttempt` directly and page
`ListRecoverableAttentionExecutions` in stable Activation start order without
scanning public event history, settled Activation history, or the complete
recoverable backlog. A normalized current-state table exposes two order-aligned
indexed ranges: expired unfinished Attention Activations and finished Attention
Activations that still own a `Started` or `Acknowledged` ProviderAttempt. The
Kernel merges at most `limit + 1` rows from each range and projects all
ProviderAttempts for each selected Activation once through the
`(activation_id, started_at, id)` order index.

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

Artifact publication stores an immutable descriptor only. The caller must
finalize content in durable storage and verify its digest before
`PublishArtifact`; the kernel does not upload blobs or turn a temporary upload
location into a finalized Artifact. A failed or incomplete upload must not
publish the descriptor.

The current direct schema version is 10. Version 10 adds normalized Attention
recovery current state and ordered indexes, count-only expiry promotion, the
recovery mutation revision, incremental provider/domain counters, and durable
Agent/Project/Channel/Thread execution fences.
This pre-release schema is intentionally breaking: stop old processes and
recreate disposable databases rather than migrating version 8 or 9.
