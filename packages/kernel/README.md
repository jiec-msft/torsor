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
excluded and updated entities are read from durable as-of projection
materialization rather than current rows.

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
restart or lease expiry.

Runtime recovery can read one `ProviderAttempt` directly and page
`ListRecoverableAttentionExecutions` in stable Activation start order without
scanning public event history or settled Activation history. Expired unfinished
Attention Activations and finished Attention Activations that still own a
`Started` or `Acknowledged` ProviderAttempt are found through separate sparse
indexes and merged into the stable page.

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

The current direct schema version is 7. Version 7 adds durable Thread and Run
creation-event cursors, command-boundary projection history, and indexes for
projection pages, Project event scans, Agent status, and Activation validity.
This pre-release schema is intentionally breaking: stop old processes and
recreate disposable databases rather than migrating version 6.
