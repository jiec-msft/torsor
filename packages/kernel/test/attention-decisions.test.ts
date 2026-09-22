import { describe, expect, it } from "vitest";

import {
  type AttentionView,
  type PrincipalContext,
  TorsorKernel,
} from "../src/index.js";
import {
  createRun,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

async function openAttention(
  kernel: TorsorKernel,
  key: string,
  targetAgentId = "agent-orbit",
  threadRootId?: string,
): Promise<{
  attention: AttentionView;
  threadRootId: string;
}> {
  const message = threadRootId
    ? await kernel.execute(
      {
        type: "ReplyToThread",
        idempotencyKey: `${key}-message`,
        threadRootId,
        body: `Synthetic Attention ${key}.`,
        targetAgentIds: [targetAgentId],
      },
      humanContext,
    )
    : await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: `${key}-message`,
        projectId: "project-sample",
        channelId: "channel-general",
        body: `Synthetic Attention ${key}.`,
        targetAgentIds: [targetAgentId],
      },
      humanContext,
    );
  const page = await kernel.query(
    {
      type: "ListOpenAttentions",
      targetAgentId,
      limit: 100,
    },
    runtimeContext,
  );
  const attention = page.items.find(
    (item) =>
      item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) {
    throw new Error("Expected the Message to open an Attention.");
  }
  return {
    attention,
    threadRootId: threadRootId ?? message.entityId,
  };
}

async function claimAttention(
  kernel: TorsorKernel,
  key: string,
  attention: AttentionView,
): Promise<{
  activationId: string;
  attentionRevision: number;
  context: PrincipalContext;
  leaseToken: string;
}> {
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
  const leaseToken = claim.relatedIds!.handlerLeaseToken!;
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-activation`,
      attentionId: attention.id,
      handlerLeaseToken: leaseToken,
    },
    runtimeContext,
  );
  return {
    activationId: activation.entityId,
    attentionRevision: claim.revision!,
    context: {
      principalId:
        attention.targetAgentId === "agent-keel"
          ? "principal-keel"
          : "principal-orbit",
      activationId: activation.entityId,
    },
    leaseToken,
  };
}

async function createOwnedRun(
  kernel: TorsorKernel,
  key: string,
  targetAgentId: "agent-orbit" | "agent-keel",
): Promise<{ runId: string; threadRootId: string }> {
  const opened = await openAttention(kernel, key, targetAgentId);
  const claimed = await claimAttention(kernel, key, opened.attention);
  const resolved = await kernel.execute(
    {
      type: "ResolveAttentionWithRun",
      idempotencyKey: `${key}-resolve`,
      attentionId: opened.attention.id,
      expectedAttentionRevision: claimed.attentionRevision,
      handlerLeaseToken: claimed.leaseToken,
    },
    claimed.context,
  );
  return {
    runId: resolved.entityId,
    threadRootId: opened.threadRootId,
  };
}

describe("Attention decisions", () => {
  it("ignores an Attention exactly once with durable reason and ended authority", async () => {
    const kernel = openMemoryKernel();
    try {
      const opened = await openAttention(kernel, "ignore");
      expect(opened.attention).toMatchObject({
        projectId: "project-sample",
        channelId: "channel-general",
        threadRootId: opened.threadRootId,
        resolutionOutcome: null,
      });
      const claimed = await claimAttention(
        kernel,
        "ignore",
        opened.attention,
      );
      const command = {
        type: "IgnoreAttention",
        idempotencyKey: "ignore-decision",
        attentionId: opened.attention.id,
        expectedAttentionRevision: claimed.attentionRevision,
        handlerLeaseToken: claimed.leaseToken,
        reason: "  The message does not require action.  ",
      } as const;

      const ignored = await kernel.execute(command, claimed.context);
      const retried = await kernel.execute(command, claimed.context);
      const thread = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: opened.threadRootId,
        },
        humanContext,
      );
      const persisted = thread.attentions.find(
        (attention) => attention.id === opened.attention.id,
      );
      const events = await kernel.readEvents(null, 500);
      const event = events.find(
        (candidate) =>
          candidate.type === "AttentionIgnored" &&
          candidate.entityId === opened.attention.id,
      );

      expect(retried).toEqual(ignored);
      expect(ignored.revision).toBe(claimed.attentionRevision + 1);
      expect(persisted).toMatchObject({
        status: "Ignored",
        resolutionOutcome: "Ignored",
        resolvedRunId: null,
        handlerLeaseHolderPrincipalId: null,
        handlerLeaseExpiresAt: null,
      });
      expect(event).toMatchObject({
        activationId: claimed.activationId,
        payload: {
          outcome: "Ignored",
          reason: "The message does not require action.",
          revision: ignored.revision,
        },
      });
      expect(
        (
          await kernel.query(
            {
              type: "ListOpenAttentions",
              targetAgentId: "agent-orbit",
            },
            runtimeContext,
          )
        ).items,
      ).toEqual([]);
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "ignore-duplicate-decision",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: "finish-ignored-attention",
            activationId: claimed.activationId,
            outcome: "Completed",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("continues one eligible existing Run without creating another Run", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const opened = await openAttention(
        kernel,
        "existing-run",
        "agent-orbit",
        setup.threadId,
      );
      const claimed = await claimAttention(
        kernel,
        "existing-run",
        opened.attention,
      );
      const command = {
        type: "ResolveAttentionWithExistingRun",
        idempotencyKey: "continue-existing-run",
        attentionId: opened.attention.id,
        expectedAttentionRevision: claimed.attentionRevision,
        handlerLeaseToken: claimed.leaseToken,
        runId: setup.runId,
        expectedRunRevision: 1,
      } as const;

      const continued = await kernel.execute(command, claimed.context);
      const retried = await kernel.execute(command, claimed.context);
      const run = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      const thread = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: setup.threadId,
        },
        humanContext,
      );
      const input = run.inputs.find(
        (candidate) =>
          candidate.id === continued.relatedIds!.runInputId,
      );
      const attention = thread.attentions.find(
        (candidate) => candidate.id === opened.attention.id,
      );
      const events = await kernel.readEvents(null, 500);
      const inputEvent = events.find(
        (event) =>
          event.type === "RunInputAdded" &&
          event.entityId === input?.id,
      );
      const attentionEvent = events.find(
        (event) =>
          event.type === "AttentionResolved" &&
          event.entityId === opened.attention.id,
      );
      const outbox = await kernel.query(
        { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
        runtimeContext,
      );

      expect(retried).toEqual(continued);
      expect(continued).toMatchObject({
        entityId: setup.runId,
        revision: 2,
      });
      expect(run.run.revision).toBe(2);
      expect(run.inputs.map((candidate) => candidate.sequence)).toEqual([1, 2]);
      expect(input).toMatchObject({
        messageRevisionId: opened.attention.messageRevisionId,
        assignedByPrincipalId: "principal-orbit",
        assignedByActivationId: claimed.activationId,
        sourceAttentionId: opened.attention.id,
        disposition: "Pending",
      });
      expect(thread.runs).toHaveLength(1);
      expect(attention).toMatchObject({
        status: "Resolved",
        resolutionOutcome: "ExistingRunContinued",
        resolvedRunId: setup.runId,
        handlerLeaseHolderPrincipalId: null,
        handlerLeaseExpiresAt: null,
      });
      expect(inputEvent).toMatchObject({
        activationId: claimed.activationId,
        causationId: opened.attention.id,
        payload: {
          runId: setup.runId,
          sequence: 2,
          runRevision: 2,
          sourceAttentionId: opened.attention.id,
        },
      });
      expect(attentionEvent).toMatchObject({
        correlationId: inputEvent?.correlationId,
        payload: {
          outcome: "ExistingRunContinued",
          runId: setup.runId,
          runInputId: input?.id,
          runRevision: 2,
        },
      });
      expect(
        outbox.items.some(
          (event) =>
            event.topic === "run-input.available" &&
            event.aggregateId === setup.runId &&
            JSON.stringify(event.payload) ===
              JSON.stringify({
                runInputId: input?.id,
                runRevision: 2,
                sourceAttentionId: opened.attention.id,
              }),
        ),
      ).toBe(true);
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "duplicate-existing-run-decision",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: "finish-continued-attention",
            activationId: claimed.activationId,
            outcome: "Completed",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("rejects Runs with the wrong owner or Thread scope", async () => {
    const kernel = openMemoryKernel();
    try {
      const targetRun = await createOwnedRun(
        kernel,
        "owner-target",
        "agent-orbit",
      );
      const wrongThreadRun = await createOwnedRun(
        kernel,
        "wrong-thread",
        "agent-orbit",
      );
      const wrongOwnerRun = await createOwnedRun(
        kernel,
        "wrong-owner",
        "agent-keel",
      );
      const opened = await openAttention(
        kernel,
        "scope-decision",
        "agent-orbit",
        targetRun.threadRootId,
      );
      const claimed = await claimAttention(
        kernel,
        "scope-decision",
        opened.attention,
      );
      const base = {
        type: "ResolveAttentionWithExistingRun",
        attentionId: opened.attention.id,
        expectedAttentionRevision: claimed.attentionRevision,
        handlerLeaseToken: claimed.leaseToken,
        expectedRunRevision: 1,
      } as const;

      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "reject-wrong-owner",
            runId: wrongOwnerRun.runId,
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "reject-wrong-thread",
            runId: wrongThreadRun.runId,
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      expect(
        (
          await kernel.query(
            {
              type: "ListOpenAttentions",
              targetAgentId: "agent-orbit",
            },
            runtimeContext,
          )
        ).items.some(
          (attention) => attention.id === opened.attention.id,
        ),
      ).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("rejects stale and terminal Run continuation", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const opened = await openAttention(
        kernel,
        "run-state",
        "agent-orbit",
        setup.threadId,
      );
      const claimed = await claimAttention(
        kernel,
        "run-state",
        opened.attention,
      );
      const base = {
        type: "ResolveAttentionWithExistingRun",
        attentionId: opened.attention.id,
        expectedAttentionRevision: claimed.attentionRevision,
        handlerLeaseToken: claimed.leaseToken,
        runId: setup.runId,
      } as const;

      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "stale-existing-run",
            expectedRunRevision: 0,
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      await kernel.execute(
        {
          type: "CompleteRun",
          idempotencyKey: "complete-before-continuation",
          runId: setup.runId,
          expectedRunRevision: 1,
          incorporatedThroughInputSequence: 1,
        },
        setup.agentContext,
      );
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "terminal-existing-run",
            expectedRunRevision: 2,
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({
        code: "TerminalRun",
        details: { state: "Completed" },
      });
    } finally {
      kernel.close();
    }
  });

  it("rejects invalid ignore reason, stale lease or revision, and other Agents", async () => {
    const kernel = openMemoryKernel();
    try {
      const opened = await openAttention(kernel, "invalid-ignore");
      const claimed = await claimAttention(
        kernel,
        "invalid-ignore",
        opened.attention,
      );
      const base = {
        type: "IgnoreAttention",
        attentionId: opened.attention.id,
        reason: "No action is needed.",
      } as const;

      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "ignore-stale-revision",
            expectedAttentionRevision: opened.attention.revision,
            handlerLeaseToken: claimed.leaseToken,
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "ignore-stale-lease",
            expectedAttentionRevision: claimed.attentionRevision,
            handlerLeaseToken: "stale-lease",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "ignore-other-agent",
            expectedAttentionRevision: claimed.attentionRevision,
            handlerLeaseToken: claimed.leaseToken,
          },
          {
            principalId: "principal-keel",
            activationId: claimed.activationId,
          },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "ignore-no-activation",
            expectedAttentionRevision: claimed.attentionRevision,
            handlerLeaseToken: claimed.leaseToken,
          },
          { principalId: "principal-orbit" },
        ),
      ).rejects.toMatchObject({ code: "Unauthorized" });
      await expect(
        kernel.execute(
          {
            ...base,
            idempotencyKey: "ignore-empty-reason",
            expectedAttentionRevision: claimed.attentionRevision,
            handlerLeaseToken: claimed.leaseToken,
            reason: "   ",
          },
          claimed.context,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });
    } finally {
      kernel.close();
    }
  });

  it("fences provider execution by Agent, Project, Channel, and Thread", async () => {
    const kernel = openMemoryKernel();
    try {
      const first = await openAttention(kernel, "domain-first");
      const second = await openAttention(
        kernel,
        "domain-second",
        "agent-orbit",
        first.threadRootId,
      );
      const otherAgent = await openAttention(
        kernel,
        "domain-other-agent",
        "agent-keel",
        first.threadRootId,
      );
      const otherThread = await openAttention(
        kernel,
        "domain-other-thread",
      );
      const claimed = await claimAttention(
        kernel,
        "domain-first",
        first.attention,
      );

      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-second-claim",
            attentionId: second.attention.id,
            expectedAttentionRevision: second.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "DomainBusy" });
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-other-agent-claim",
            attentionId: otherAgent.attention.id,
            expectedAttentionRevision: otherAgent.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        entityId: otherAgent.attention.id,
      });
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-other-thread-claim",
            attentionId: otherThread.attention.id,
            expectedAttentionRevision: otherThread.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        entityId: otherThread.attention.id,
      });

      const attempt = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "domain-first-provider",
          activationId: claimed.activationId,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [],
          requestIdempotencyKey: "domain-first-request",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "IgnoreAttention",
          idempotencyKey: "domain-first-ignore",
          attentionId: first.attention.id,
          expectedAttentionRevision: claimed.attentionRevision,
          handlerLeaseToken: claimed.leaseToken,
          reason: "The synthetic dispatch needs no durable Run.",
        },
        claimed.context,
      );
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-second-after-decision",
            attentionId: second.attention.id,
            expectedAttentionRevision: second.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "DomainBusy" });

      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "domain-first-settle",
          providerAttemptId: attempt.entityId,
          status: "Unknown",
          detail: "Synthetic provider work was reconciled after the decision.",
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-second-after-settlement",
            attentionId: second.attention.id,
            expectedAttentionRevision: second.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        entityId: second.attention.id,
      });
    } finally {
      kernel.close();
    }
  });

  it("releases an abandoned domain after its handler lease expires", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const first = await openAttention(kernel, "domain-expiry-first");
      const second = await openAttention(
        kernel,
        "domain-expiry-second",
        "agent-orbit",
        first.threadRootId,
      );
      await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "domain-expiry-first-claim",
          attentionId: first.attention.id,
          expectedAttentionRevision: first.attention.revision,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:02.000Z");
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "domain-expiry-second-claim",
            attentionId: second.attention.id,
            expectedAttentionRevision: second.attention.revision,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({ entityId: second.attention.id });
    } finally {
      kernel.close();
    }
  });

  it("rejects an Attention Activation after its lease is replaced", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const opened = await openAttention(kernel, "replaced-activation");
      const firstClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "replaced-first-claim",
          attentionId: opened.attention.id,
          expectedAttentionRevision: opened.attention.revision,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      expect(firstClaim.leaseExpiresAt).toBe(
        "2026-09-21T08:00:01.000Z",
      );
      const recoveryBeforeReplay = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      expect(
        (
          await kernel.execute(
            {
              type: "ClaimAttention",
              idempotencyKey: "replaced-first-claim",
              attentionId: opened.attention.id,
              expectedAttentionRevision: opened.attention.revision,
              leaseDurationMs: 1_000,
            },
            runtimeContext,
          )
        ).leaseExpiresAt,
      ).toBe(firstClaim.leaseExpiresAt);
      expect(
        (
          await kernel.query(
            { type: "GetAttentionRecoverySnapshot" },
            runtimeContext,
          )
        ).revision,
      ).toBe(recoveryBeforeReplay.revision);
      const staleActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "replaced-stale-activation",
          attentionId: opened.attention.id,
          handlerLeaseToken: firstClaim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:02.000Z");
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "replaced-first-claim",
            attentionId: opened.attention.id,
            expectedAttentionRevision: opened.attention.revision,
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      const replacementClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "replaced-second-claim",
          attentionId: opened.attention.id,
          expectedAttentionRevision: firstClaim.revision!,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(replacementClaim.leaseExpiresAt).toBe(
        "2026-09-21T08:00:32.000Z",
      );
      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "replaced-first-claim",
            attentionId: opened.attention.id,
            expectedAttentionRevision: opened.attention.revision,
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      await expect(
        kernel.execute(
          {
            type: "IgnoreAttention",
            idempotencyKey: "ignore-with-stale-activation",
            attentionId: opened.attention.id,
            expectedAttentionRevision: replacementClaim.revision!,
            handlerLeaseToken:
              replacementClaim.relatedIds!.handlerLeaseToken!,
            reason: "This stale Activation must not decide.",
          },
          {
            principalId: "principal-orbit",
            activationId: staleActivation.entityId,
          },
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });
});
