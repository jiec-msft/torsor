import { describe, expect, it } from "vitest";

import {
  type AuthorizedPublicEventPage,
  type KernelBootstrap,
  type PrincipalContext,
  type PublicEventEnvelope,
  TorsorKernel,
} from "../src/index.js";
import {
  bootstrap,
  claimRunOutboxAuthority,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

async function openAttention(
  kernel: TorsorKernel,
  key: string,
  targetAgentId = "agent-orbit",
  projectId = "project-sample",
  channelId = "channel-general",
) {
  const thread = await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: `${key}-thread`,
      projectId,
      channelId,
      body: `${key} synthetic request.`,
      targetAgentIds: [targetAgentId],
    },
    humanContext,
  );
  const page = await kernel.query(
    {
      type: "ListOpenAttentions",
      projectId,
      targetAgentId,
    },
    runtimeContext,
  );
  const attention = page.items.find(
    (item) => item.threadRootId === thread.entityId,
  );
  if (!attention) {
    throw new Error("Expected an Attention for the new Thread.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `${key}-claim`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 30_000,
    },
    runtimeContext,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-attention-activation`,
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    runtimeContext,
  );
  return {
    threadId: thread.entityId,
    attention,
    claim,
    activationId: activation.entityId,
    agentContext: {
      principalId:
        targetAgentId === "agent-orbit"
          ? "principal-orbit"
          : "principal-keel",
      activationId: activation.entityId,
    } satisfies PrincipalContext,
  };
}

async function createActiveRun(
  kernel: TorsorKernel,
  key: string,
) {
  const opened = await openAttention(kernel, key);
  const resolved = await kernel.execute(
    {
      type: "ResolveAttentionWithRun",
      idempotencyKey: `${key}-resolve`,
      attentionId: opened.attention.id,
      expectedAttentionRevision: opened.claim.revision!,
      handlerLeaseToken: opened.claim.relatedIds!.handlerLeaseToken!,
    },
    opened.agentContext,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-run-activation`,
      runId: resolved.entityId,
      expectedRunRevision: 1,
    },
    runtimeContext,
  );
  return {
    ...opened,
    runId: resolved.entityId,
    runInputId: resolved.relatedIds!.runInputId!,
    runActivationId: activation.entityId,
    runContext: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    } satisfies PrincipalContext,
  };
}

function openExtendedKernel(): TorsorKernel {
  const extended: KernelBootstrap = {
    principals: [
      ...(bootstrap.principals ?? []),
      {
        id: "principal-nova",
        kind: "agent",
        displayName: "Nova",
      },
    ],
    projects: [
      ...(bootstrap.projects ?? []),
      { id: "project-other", name: "Other Project" },
    ],
    channels: [
      ...(bootstrap.channels ?? []),
      {
        id: "channel-other",
        projectId: "project-other",
        name: "other",
      },
    ],
    agents: [
      ...(bootstrap.agents ?? []),
      {
        id: "agent-nova",
        principalId: "principal-nova",
        projectId: "project-other",
        name: "Nova",
        configRevision: 1,
        config: { model: "deterministic-fake" },
      },
    ],
  };
  let nextId = 0;
  return TorsorKernel.open({
    databasePath: ":memory:",
    bootstrap: extended,
    clock: () => new Date("2026-09-21T08:00:00.000Z"),
    idFactory: (prefix) => `${prefix}-extended-${++nextId}`,
  });
}

describe("Kernel server query primitives", () => {
  it("keeps Thread pages stable and materializes true as-of projections", async () => {
    const kernel = openMemoryKernel();
    try {
      const firstThread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "thread-page-first",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "First Thread.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "thread-page-second",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Second Thread.",
        },
        humanContext,
      );

      const firstPage = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          limit: 1,
        },
        humanContext,
      );
      expect(firstPage.items.map((item) => item.threadRootId)).toEqual([
        firstThread.entityId,
      ]);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextAfterEventId).not.toBeNull();
      expect(firstPage.snapshotEventId).not.toBeNull();

      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "thread-page-mutation",
          threadRootId: firstThread.entityId,
          body: "This reply was published after the page snapshot.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "thread-page-late",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Created after the page snapshot.",
        },
        humanContext,
      );

      const historicalFirst = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          snapshotEventId: firstPage.snapshotEventId,
          limit: 10,
        },
        humanContext,
      );
      expect(historicalFirst.items).toHaveLength(2);
      expect(historicalFirst.items[0]?.messages).toHaveLength(1);

      const secondPage = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          afterEventId: firstPage.nextAfterEventId,
          snapshotEventId: firstPage.snapshotEventId,
          limit: 1,
        },
        humanContext,
      );
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]?.messages[0]?.revisions[0]?.body).toBe(
        "Second Thread.",
      );
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.snapshotEventId).toBe(firstPage.snapshotEventId);

      const current = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      expect(current.items).toHaveLength(3);
      expect(
        current.items.find(
          (item) => item.threadRootId === firstThread.entityId,
        )?.messages,
      ).toHaveLength(2);
    } finally {
      kernel.close();
    }
  });

  it("keeps Run pages stable across state mutations and concurrent creates", async () => {
    const kernel = openMemoryKernel();
    try {
      const first = await createActiveRun(kernel, "run-page-first");
      const second = await createActiveRun(kernel, "run-page-second");
      const firstPage = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 1,
        },
        humanContext,
      );
      expect(firstPage.items[0]?.run.id).toBe(first.runId);
      expect(firstPage.items[0]?.run.state).toBe("Active");

      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "run-page-wait",
          runId: first.runId,
          expectedRunRevision: 1,
          reason: "Waiting after the page snapshot.",
        },
        first.runContext,
      );
      await createActiveRun(kernel, "run-page-late");

      const historical = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          snapshotEventId: firstPage.snapshotEventId,
          limit: 10,
        },
        humanContext,
      );
      expect(historical.items).toHaveLength(2);
      expect(
        historical.items.find((item) => item.run.id === first.runId)?.run.state,
      ).toBe("Active");

      const secondPage = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          afterEventId: firstPage.nextAfterEventId,
          snapshotEventId: firstPage.snapshotEventId,
          limit: 1,
        },
        humanContext,
      );
      expect(secondPage.items.map((item) => item.run.id)).toEqual([
        second.runId,
      ]);
      expect(secondPage.hasMore).toBe(false);

      const current = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      expect(
        current.items.find((item) => item.run.id === first.runId)?.run.state,
      ).toBe("Waiting");
      expect(current.items).toHaveLength(3);
    } finally {
      kernel.close();
    }
  });

  it("reconstructs mutable projection components exactly as of a snapshot", async () => {
    const kernel = openMemoryKernel();
    try {
      const opened = await openAttention(kernel, "component-history");
      const claimedSnapshot = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
        },
        humanContext,
      );
      const resolved = await kernel.execute(
        {
          type: "ResolveAttentionWithRun",
          idempotencyKey: "component-history-resolve",
          attentionId: opened.attention.id,
          expectedAttentionRevision: opened.claim.revision!,
          handlerLeaseToken: opened.claim.relatedIds!.handlerLeaseToken!,
        },
        opened.agentContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "component-history-run-activation",
          runId: resolved.entityId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      const runContext = {
        principalId: "principal-orbit",
        activationId: activation.entityId,
      } as const;
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        resolved.entityId,
        "component-history",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "component-history-provider",
          activationId: activation.entityId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: { streaming: true },
          runInputIds: [resolved.relatedIds!.runInputId!],
          requestIdempotencyKey: "component-history-request",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "AppendRunActivity",
          idempotencyKey: "component-history-activity",
          runId: resolved.entityId,
          activationId: activation.entityId,
          kind: "progress",
          payload: { text: "Historical output." },
          retentionClass: "durable",
        },
        runContext,
      );
      const sent = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "component-history-send",
          runId: resolved.entityId,
          expectedRunRevision: 1,
          body: "Additional synthetic input.",
          targetAgentIds: ["agent-keel"],
        },
        humanContext,
      );
      const activeSnapshot = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
        },
        humanContext,
      );
      const replacementActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "component-history-replacement-activation",
          runId: resolved.entityId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const replacementContext = {
        principalId: "principal-orbit",
        activationId: replacementActivation.entityId,
      } as const;

      await kernel.execute(
        {
          type: "WithdrawRunInput",
          idempotencyKey: "component-history-withdraw",
          runInputId: sent.relatedIds!.runInputId!,
          expectedRunRevision: 2,
          expectedDispositionRevision: 1,
          reason: "Withdraw after the historical snapshot.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "component-history-provider-finish",
          providerAttemptId: provider.entityId,
          status: "Completed",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "component-history-wait",
          runId: resolved.entityId,
          expectedRunRevision: 3,
          reason: "Wait after the historical snapshot.",
        },
        replacementContext,
      );

      const claimed = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          snapshotEventId: claimedSnapshot.snapshotEventId,
        },
        humanContext,
      );
      expect(claimed.items[0]?.messages[0]).toMatchObject({
        targetAgentIds: ["agent-orbit"],
        latestRevision: 1,
      });
      expect(claimed.items[0]?.attentions[0]).toMatchObject({
        status: "Open",
        revision: 2,
        handlerLeaseHolderPrincipalId: "principal-runtime",
      });
      expect(claimed.items[0]?.runs).toEqual([]);

      const historical = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          snapshotEventId: activeSnapshot.snapshotEventId,
        },
        humanContext,
      );
      const historicalRun = historical.items[0]!;
      expect(historicalRun.run).toMatchObject({
        state: "Active",
        revision: 2,
        activationGeneration: 1,
      });
      expect(historicalRun.inputs).toHaveLength(2);
      expect(historicalRun.inputs[1]).toMatchObject({
        disposition: "Pending",
        dispositionRevision: 1,
      });
      expect(historicalRun.activations[0]).toMatchObject({
        revokedAt: null,
        finishedAt: null,
      });
      expect(historicalRun.providerAttempts[0]).toMatchObject({
        status: "Started",
        finishedAt: null,
      });
      expect(historicalRun.activity.items[0]).toMatchObject({
        kind: "progress",
        payload: { text: "Historical output." },
      });

      const current = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
        },
        humanContext,
      );
      const currentRun = current.items[0]!;
      expect(currentRun.run).toMatchObject({
        state: "Waiting",
        revision: 4,
        activationGeneration: 2,
      });
      expect(currentRun.inputs[1]).toMatchObject({
        disposition: "Withdrawn",
        dispositionRevision: 2,
      });
      expect(currentRun.activations).toHaveLength(2);
      expect(
        currentRun.activations.every(
          (currentActivation) => currentActivation.revokedAt !== null,
        ),
      ).toBe(true);
      expect(currentRun.providerAttempts[0]).toMatchObject({
        status: "Completed",
      });
    } finally {
      kernel.close();
    }
  });

  it("reads bounded authorized event scans without rescanning filtered rows", async () => {
    const kernel = openExtendedKernel();
    try {
      const scoped = await createActiveRun(kernel, "event-scope");
      const otherThread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "event-other-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "A different Thread in the same Project.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "event-other-project",
          projectId: "project-other",
          channelId: "channel-other",
          body: "An event from another Project.",
        },
        humanContext,
      );

      const humanPage = await kernel.query(
        {
          type: "ReadPublicEvents",
          projectId: "project-sample",
          limit: 500,
        },
        humanContext,
      );
      expect(humanPage.events.length).toBeGreaterThan(0);
      expect(
        humanPage.events.every(
          (event) => event.projectId === "project-sample",
        ),
      ).toBe(true);

      const seenEventIds = new Set<string>();
      const visibleEvents: PublicEventEnvelope[] = [];
      let afterEventId: string | null = null;
      let insertedMutation = false;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page: AuthorizedPublicEventPage = await kernel.query(
          {
            type: "ReadPublicEvents",
            projectId: "project-sample",
            afterEventId,
            limit: 2,
          },
          scoped.runContext,
        );
        for (const event of page.events) {
          expect(seenEventIds.has(event.eventId)).toBe(false);
          seenEventIds.add(event.eventId);
          visibleEvents.push(event);
        }
        expect(page.scannedThroughEventId).not.toBe(afterEventId);
        afterEventId = page.scannedThroughEventId;
        if (!insertedMutation) {
          insertedMutation = true;
          await kernel.execute(
            {
              type: "ReplyToThread",
              idempotencyKey: "event-filtered-mutation",
              threadRootId: otherThread.entityId,
              body: "A filtered event inserted during pagination.",
            },
            humanContext,
          );
          await kernel.execute(
            {
              type: "AppendRunActivity",
              idempotencyKey: "event-visible-mutation",
              runId: scoped.runId,
              activationId: scoped.runActivationId,
              kind: "progress",
              payload: { detail: "Visible during slow pagination." },
              retentionClass: "durable",
            },
            scoped.runContext,
          );
        }
        if (!page.hasMore) {
          break;
        }
      }
      expect(visibleEvents.length).toBeGreaterThan(0);
      expect(
        visibleEvents.every(
          (event) =>
            event.projectId === "project-sample" &&
            event.channelId === "channel-general" &&
            event.threadRootId === scoped.threadId,
        ),
      ).toBe(true);
      expect(
        visibleEvents.some((event) => event.type === "RunActivityAppended"),
      ).toBe(true);

      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "event-finish-activation",
          activationId: scoped.runActivationId,
          outcome: "Completed",
        },
        scoped.runContext,
      );
      await expect(
        kernel.query(
          {
            type: "ReadPublicEvents",
            projectId: "project-sample",
            afterEventId,
          },
          scoped.runContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("includes internally appended parked-run activity in temporal projections", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createActiveRun(kernel, "parked-activity");
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "parked-activity",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "parked-activity-provider",
          activationId: setup.runActivationId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [setup.runInputId],
          requestIdempotencyKey: "parked-activity-request",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FailProviderAttempt",
          idempotencyKey: "parked-activity-fail",
          providerAttemptId: provider.entityId,
          error: "Synthetic provider failure.",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "ParkRunAfterProviderAttemptFailure",
          idempotencyKey: "parked-activity-park",
          runId: setup.runId,
          providerAttemptId: provider.entityId,
          expectedRunRevision: 1,
          expectedActivationGeneration: 1,
          reason: "Park after provider failure.",
        },
        runtimeContext,
      );
      const page = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
        },
        humanContext,
      );
      expect(page.items[0]?.activity.items).toEqual([
        expect.objectContaining({
          kind: "provider_attempt_failure_parked",
        }),
      ]);
    } finally {
      kernel.close();
    }
  });

  it("derives Agent status from live Attention and Run scope validity", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const attentionOnly = await openAttention(kernel, "status-attention");
      let status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents).toEqual([
        {
          agentId: "agent-orbit",
          liveRunActivationCount: 0,
          liveAttentionActivationCount: 1,
          liveActivationCount: 1,
          nonterminalRunCount: 0,
          status: "active",
        },
      ]);

      const resolved = await kernel.execute(
        {
          type: "ResolveAttentionWithRun",
          idempotencyKey: "status-resolve",
          attentionId: attentionOnly.attention.id,
          expectedAttentionRevision: attentionOnly.claim.revision!,
          handlerLeaseToken:
            attentionOnly.claim.relatedIds!.handlerLeaseToken!,
        },
        attentionOnly.agentContext,
      );
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveActivationCount: 0,
        nonterminalRunCount: 1,
        status: "waiting",
      });

      const firstRunActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "status-run-activation",
          runId: resolved.entityId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveRunActivationCount: 1,
        liveAttentionActivationCount: 0,
        status: "active",
      });

      const firstRunContext = {
        principalId: "principal-orbit",
        activationId: firstRunActivation.entityId,
      } as const;
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "status-finish-run-activation",
          activationId: firstRunActivation.entityId,
          outcome: "Completed",
        },
        firstRunContext,
      );
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveRunActivationCount: 0,
        nonterminalRunCount: 1,
        status: "waiting",
      });

      const secondRunActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "status-run-activation-two",
          runId: resolved.entityId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      const secondRunContext = {
        principalId: "principal-orbit",
        activationId: secondRunActivation.entityId,
      } as const;
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "status-wait-run",
          runId: resolved.entityId,
          expectedRunRevision: 1,
          reason: "Waiting for a synthetic dependency.",
        },
        secondRunContext,
      );
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveActivationCount: 0,
        nonterminalRunCount: 1,
        status: "waiting",
      });

      const terminalActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "status-terminal-activation",
          runId: resolved.entityId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FailRun",
          idempotencyKey: "status-fail-run",
          runId: resolved.entityId,
          expectedRunRevision: 3,
          reason: "Synthetic terminal transition.",
        },
        {
          principalId: "principal-orbit",
          activationId: terminalActivation.entityId,
        },
      );
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveActivationCount: 0,
        nonterminalRunCount: 0,
        status: "idle",
      });

      const expiring = await openAttention(kernel, "status-expiring");
      now = new Date("2026-09-21T08:00:31.000Z");
      status = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
          agentId: "agent-orbit",
        },
        humanContext,
      );
      expect(status.agents[0]).toMatchObject({
        liveAttentionActivationCount: 0,
        status: "idle",
      });
      expect(expiring.activationId).not.toBe("");
    } finally {
      kernel.close();
    }
  });

  it("filters Agent status by Project and enforces Project authorization", async () => {
    const kernel = openExtendedKernel();
    try {
      const sample = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-sample",
        },
        humanContext,
      );
      expect(sample.agents.map((agent) => agent.agentId)).toEqual([
        "agent-keel",
        "agent-orbit",
      ]);
      const other = await kernel.query(
        {
          type: "GetProjectAgentStatus",
          projectId: "project-other",
        },
        humanContext,
      );
      expect(other.agents.map((agent) => agent.agentId)).toEqual([
        "agent-nova",
      ]);
      await expect(
        kernel.query(
          {
            type: "GetProjectAgentStatus",
            projectId: "project-sample",
          },
          { principalId: "principal-nova" },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
    } finally {
      kernel.close();
    }
  });

  it("scopes snapshots and cursors to the requested Project", async () => {
    const kernel = openExtendedKernel();
    try {
      const firstSample = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "cursor-sample-first",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "First Sample Project event.",
        },
        humanContext,
      );
      const other = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "cursor-other",
          projectId: "project-other",
          channelId: "channel-other",
          body: "Newer foreign Project event.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "cursor-sample-second",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Second Sample Project event.",
        },
        humanContext,
      );

      const otherPage = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-other",
          limit: 10,
        },
        humanContext,
      );
      const foreignEventId = otherPage.snapshotEventId!;
      const samplePage = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          limit: 1,
        },
        humanContext,
      );
      expect(samplePage.items[0]?.threadRootId).toBe(firstSample.entityId);
      expect(samplePage.snapshotEventId).not.toBe(foreignEventId);

      const invalidEventId = "event-does-not-exist";
      const captureError = async (
        operation: () => Promise<unknown>,
      ): Promise<{ code: unknown; message: string }> => {
        try {
          await operation();
          throw new Error("Expected the cursor to be rejected.");
        } catch (error) {
          const value = error as { code?: unknown; message?: unknown };
          return {
            code: value.code,
            message: String(value.message),
          };
        }
      };
      const foreignSnapshotError = await captureError(() =>
        kernel.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
            snapshotEventId: foreignEventId,
          },
          humanContext,
        )
      );
      const invalidSnapshotError = await captureError(() =>
        kernel.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
            snapshotEventId: invalidEventId,
          },
          humanContext,
        )
      );
      expect(foreignSnapshotError).toEqual(invalidSnapshotError);
      expect(foreignSnapshotError.code).toBe("NotFound");

      const foreignAfterError = await captureError(() =>
        kernel.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
            afterEventId: foreignEventId,
          },
          humanContext,
        )
      );
      const invalidAfterError = await captureError(() =>
        kernel.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
            afterEventId: invalidEventId,
          },
          humanContext,
        )
      );
      expect(foreignAfterError).toEqual(invalidAfterError);

      const foreignReplayError = await captureError(() =>
        kernel.query(
          {
            type: "ReadPublicEvents",
            projectId: "project-sample",
            afterEventId: foreignEventId,
          },
          humanContext,
        )
      );
      const invalidReplayError = await captureError(() =>
        kernel.query(
          {
            type: "ReadPublicEvents",
            projectId: "project-sample",
            afterEventId: invalidEventId,
          },
          humanContext,
        )
      );
      expect(foreignReplayError).toEqual(invalidReplayError);
      const foreignAttentionError = await captureError(() =>
        kernel.query(
          {
            type: "ListOpenAttentions",
            projectId: "project-sample",
            snapshotEventId: foreignEventId,
          },
          runtimeContext,
        )
      );
      const invalidAttentionError = await captureError(() =>
        kernel.query(
          {
            type: "ListOpenAttentions",
            projectId: "project-sample",
            snapshotEventId: invalidEventId,
          },
          runtimeContext,
        )
      );
      expect(foreignAttentionError).toEqual(invalidAttentionError);
      expect(other.entityId).not.toBe("");
    } finally {
      kernel.close();
    }
  });

  it("normalizes unscoped Attention snapshots to a command boundary", async () => {
    const kernel = openMemoryKernel();
    try {
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "attention-boundary-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Notify both synthetic Agents atomically.",
          targetAgentIds: ["agent-orbit", "agent-keel"],
        },
        humanContext,
      );
      const events = await kernel.readEvents(null, 10);
      const firstAttentionEvent = events.find(
        (event) => event.type === "AttentionOpened",
      );
      expect(firstAttentionEvent).toBeDefined();
      const page = await kernel.query(
        {
          type: "ListOpenAttentions",
          snapshotEventId: firstAttentionEvent!.eventId,
          limit: 10,
        },
        runtimeContext,
      );
      expect(page.items.map((attention) => attention.targetAgentId)).toEqual([
        "agent-orbit",
        "agent-keel",
      ]);
      expect(page.snapshotEventId).toBe(events.at(-1)?.eventId);
    } finally {
      kernel.close();
    }
  });
});
