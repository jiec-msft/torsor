import { describe, expect, it } from "vitest";

import {
  type AttentionView,
  TorsorKernel,
} from "../src/index.js";
import {
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

async function createRunFixture(kernel: TorsorKernel, key: string) {
  const message = await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: `${key}-thread`,
      projectId: "project-sample",
      channelId: "channel-general",
      body: `Synthetic recovery Run ${key}.`,
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
  const page = await kernel.query(
    {
      type: "ListOpenAttentions",
      targetAgentId: "agent-orbit",
      limit: 500,
    },
    runtimeContext,
  );
  const attention = page.items.find(
    (item) =>
      item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) {
    throw new Error("Expected a recovery Attention.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `${key}-claim`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 300_000,
    },
    runtimeContext,
  );
  const attentionActivation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-attention-activation`,
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    runtimeContext,
  );
  const run = await kernel.execute(
    {
      type: "ResolveAttentionWithRun",
      idempotencyKey: `${key}-resolve`,
      attentionId: attention.id,
      expectedAttentionRevision: claim.revision!,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    {
      principalId: "principal-orbit",
      activationId: attentionActivation.entityId,
    },
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-run-activation`,
      runId: run.entityId,
      expectedRunRevision: 1,
    },
    runtimeContext,
  );
  return {
    activationId: activation.entityId,
    agentContext: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    } as const,
    runId: run.entityId,
    runInputId: run.relatedIds!.runInputId!,
  };
}

async function startProviderAttempt(
  kernel: TorsorKernel,
  fixture: Awaited<ReturnType<typeof createRunFixture>>,
  key: string,
) {
  return kernel.execute(
    {
      type: "StartProviderAttempt",
      idempotencyKey: `${key}-provider`,
      activationId: fixture.activationId,
      adapter: "deterministic-fake",
      adapterVersion: "1",
      capabilitySnapshot: { supportsIdempotentRequests: true },
      runInputIds: [fixture.runInputId],
      requestIdempotencyKey: `${key}-request`,
    },
    runtimeContext,
  );
}

async function settleProviderFailure(
  kernel: TorsorKernel,
  fixture: Awaited<ReturnType<typeof createRunFixture>>,
  key: string,
  status: "Failed" | "Unknown",
) {
  const attempt = await startProviderAttempt(kernel, fixture, key);
  if (status === "Failed") {
    await kernel.execute(
      {
        type: "FailProviderAttempt",
        idempotencyKey: `${key}-failed`,
        providerAttemptId: attempt.entityId,
        error: "Synthetic provider failure.",
      },
      runtimeContext,
    );
  } else {
    await kernel.execute(
      {
        type: "FinishProviderAttempt",
        idempotencyKey: `${key}-unknown`,
        providerAttemptId: attempt.entityId,
        status: "Unknown",
        detail: "Synthetic provider outcome is unknown.",
      },
      runtimeContext,
    );
  }
  return attempt;
}

async function createAttentionExecution(
  kernel: TorsorKernel,
  key: string,
  durationMs = 300_000,
): Promise<{
  activationId: string;
  attention: AttentionView;
  context: { readonly principalId: string; readonly activationId: string };
}> {
  const message = await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: `${key}-message`,
      projectId: "project-sample",
      channelId: "channel-general",
      body: `Synthetic recovery Attention ${key}.`,
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
  const page = await kernel.query(
    {
      type: "ListOpenAttentions",
      targetAgentId: "agent-orbit",
      limit: 500,
    },
    runtimeContext,
  );
  const attention = page.items.find(
    (item) =>
      item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) {
    throw new Error("Expected an Attention execution.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `${key}-claim`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 300_000,
    },
    runtimeContext,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-activation`,
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      durationMs,
    },
    runtimeContext,
  );
  return {
    activationId: activation.entityId,
    attention,
    context: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    },
  };
}

async function startAttentionProviderAttempt(
  kernel: TorsorKernel,
  activationId: string,
  key: string,
) {
  return kernel.execute(
    {
      type: "StartProviderAttempt",
      idempotencyKey: `${key}-provider`,
      activationId,
      adapter: "deterministic-fake",
      adapterVersion: "1",
      capabilitySnapshot: {},
      runInputIds: [],
      requestIdempotencyKey: `${key}-request`,
    },
    runtimeContext,
  );
}

describe("Runtime provider recovery", () => {
  for (const status of ["Failed", "Unknown"] as const) {
    it(`atomically parks a Run after a ${status} ProviderAttempt`, async () => {
      const kernel = openMemoryKernel();
      try {
        const fixture = await createRunFixture(
          kernel,
          `park-${status.toLowerCase()}`,
        );
        const attempt = await settleProviderFailure(
          kernel,
          fixture,
          `park-${status.toLowerCase()}`,
          status,
        );
        if (status === "Unknown") {
          await kernel.execute(
            {
              type: "FinishActivation",
              idempotencyKey: "park-unknown-finished-activation",
              activationId: fixture.activationId,
              outcome: "Failed",
              detail: "The provider outcome could not be reconciled.",
            },
            runtimeContext,
          );
        }
        const outboxBefore = await kernel.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          runtimeContext,
        );
        const wakeTopics = new Set([
          "run.activation-requested",
          "run-input.available",
        ]);
        const wakeCountBefore = outboxBefore.items.filter((event) =>
          wakeTopics.has(event.topic)
        ).length;
        const command = {
          type: "ParkRunAfterProviderAttemptFailure",
          idempotencyKey: `park-${status.toLowerCase()}-command`,
          runId: fixture.runId,
          providerAttemptId: attempt.entityId,
          expectedRunRevision: 1,
          expectedActivationGeneration: 1,
          reason: `Provider attempt ${status.toLowerCase()} requires recovery.`,
        } as const;
        const parked = await kernel.execute(command, runtimeContext);
        const replayed = await kernel.execute(command, runtimeContext);
        const projection = await kernel.query(
          { type: "GetRunProjection", runId: fixture.runId },
          humanContext,
        );
        const outboxAfter = await kernel.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          runtimeContext,
        );

        expect(replayed).toEqual(parked);
        expect(projection.run).toMatchObject({
          state: "Waiting",
          revision: 2,
          activationGeneration: 1,
        });
        expect(projection.inputs).toEqual([
          expect.objectContaining({
            id: fixture.runInputId,
            disposition: "Pending",
            dispositionRevision: 1,
          }),
        ]);
        expect(
          projection.activations.find(
            (activation) => activation.id === fixture.activationId,
          ),
        ).toMatchObject(
          status === "Failed"
            ? {
              revokedAt: "2026-09-21T08:00:00.000Z",
              revocationReason: "provider_attempt_failure_parked",
              finishedAt: null,
            }
            : {
              revokedAt: null,
              revocationReason: null,
              finishedAt: "2026-09-21T08:00:00.000Z",
              outcome: "Failed",
            },
        );
        expect(projection.activity.items).toEqual([
          expect.objectContaining({
            id: parked.relatedIds!.activityId,
            kind: "provider_attempt_failure_parked",
            providerAttemptId: attempt.entityId,
            retentionClass: "durable",
            payload: {
              providerAttemptStatus: status,
              reason: command.reason,
              runRevision: 2,
            },
          }),
        ]);
        expect(
          outboxAfter.items.filter((event) => wakeTopics.has(event.topic)),
        ).toHaveLength(wakeCountBefore);
        expect(
          outboxAfter.items.filter(
            (event) =>
              event.topic === "run.waiting" &&
              event.aggregateId === fixture.runId,
          ),
        ).toHaveLength(1);
        expect(
          (await kernel.readEvents(null, 500)).filter(
            (event) =>
              event.type === "RunWaiting" &&
              event.entityId === fixture.runId,
          ),
        ).toHaveLength(1);
        await expect(
          kernel.execute(
            {
              type: "AppendRunActivity",
              idempotencyKey: `park-${status.toLowerCase()}-stale-capability`,
              runId: fixture.runId,
              activationId: fixture.activationId,
              kind: "status",
              payload: { stale: true },
              retentionClass: "durable",
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });
      } finally {
        kernel.close();
      }
    });
  }

  it("rejects every stale, mismatched, unauthorized, and ineligible parking request", async () => {
    const kernel = openMemoryKernel();
    try {
      const eligible = await createRunFixture(kernel, "guard-eligible");
      const failed = await settleProviderFailure(
        kernel,
        eligible,
        "guard-eligible",
        "Failed",
      );
      const command = {
        type: "ParkRunAfterProviderAttemptFailure",
        idempotencyKey: "guard-base",
        runId: eligible.runId,
        providerAttemptId: failed.entityId,
        expectedRunRevision: 1,
        expectedActivationGeneration: 1,
        reason: "Park after a failed delivery.",
      } as const;

      await expect(
        kernel.execute(command, humanContext),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.execute(
          { ...command, idempotencyKey: "guard-empty", reason: "   " },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-stale-revision",
            expectedRunRevision: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-wrong-generation",
            expectedActivationGeneration: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const other = await createRunFixture(kernel, "guard-other-run");
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-wrong-run",
            runId: other.runId,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const startedFixture = await createRunFixture(kernel, "guard-started");
      const started = await startProviderAttempt(
        kernel,
        startedFixture,
        "guard-started",
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-started-status",
            runId: startedFixture.runId,
            providerAttemptId: started.entityId,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const acknowledgedFixture = await createRunFixture(
        kernel,
        "guard-acknowledged",
      );
      const acknowledged = await startProviderAttempt(
        kernel,
        acknowledgedFixture,
        "guard-acknowledged",
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "guard-acknowledged-status",
          providerAttemptId: acknowledged.entityId,
          status: "Acknowledged",
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-acknowledged-park",
            runId: acknowledgedFixture.runId,
            providerAttemptId: acknowledged.entityId,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const completedFixture = await createRunFixture(
        kernel,
        "guard-completed",
      );
      const completed = await startProviderAttempt(
        kernel,
        completedFixture,
        "guard-completed",
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "guard-completed-status",
          providerAttemptId: completed.entityId,
          status: "Completed",
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-completed-park",
            runId: completedFixture.runId,
            providerAttemptId: completed.entityId,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const waiting = await createRunFixture(kernel, "guard-waiting");
      const waitingAttempt = await settleProviderFailure(
        kernel,
        waiting,
        "guard-waiting",
        "Unknown",
      );
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "guard-waiting-state",
          runId: waiting.runId,
          expectedRunRevision: 1,
          reason: "Already waiting.",
        },
        waiting.agentContext,
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-waiting-park",
            runId: waiting.runId,
            providerAttemptId: waitingAttempt.entityId,
            expectedRunRevision: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const terminal = await createRunFixture(kernel, "guard-terminal");
      const terminalAttempt = await settleProviderFailure(
        kernel,
        terminal,
        "guard-terminal",
        "Failed",
      );
      await kernel.execute(
        {
          type: "CancelRun",
          idempotencyKey: "guard-terminal-state",
          runId: terminal.runId,
          expectedRunRevision: 1,
          reason: "Cancelled before recovery.",
        },
        humanContext,
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-terminal-park",
            runId: terminal.runId,
            providerAttemptId: terminalAttempt.entityId,
            expectedRunRevision: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "TerminalRun" });

      const staleActivation = await createRunFixture(
        kernel,
        "guard-stale-activation",
      );
      const staleAttempt = await settleProviderFailure(
        kernel,
        staleActivation,
        "guard-stale-activation",
        "Failed",
      );
      await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "guard-replacement-activation",
          runId: staleActivation.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            ...command,
            idempotencyKey: "guard-stale-attempt-park",
            runId: staleActivation.runId,
            providerAttemptId: staleAttempt.entityId,
            expectedActivationGeneration: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("authorizes targeted ProviderAttempt reads by Runtime or the current Activation", async () => {
    const kernel = openMemoryKernel();
    try {
      const execution = await createAttentionExecution(
        kernel,
        "provider-query",
      );
      const attempt = await startAttentionProviderAttempt(
        kernel,
        execution.activationId,
        "provider-query",
      );

      const runtimeView = await kernel.query(
        {
          type: "GetProviderAttempt",
          providerAttemptId: attempt.entityId,
        },
        runtimeContext,
      );
      const agentView = await kernel.query(
        {
          type: "GetProviderAttempt",
          providerAttemptId: attempt.entityId,
        },
        execution.context,
      );
      expect(agentView).toEqual(runtimeView);
      expect(runtimeView).toMatchObject({
        id: attempt.entityId,
        activationId: execution.activationId,
        runId: null,
        status: "Started",
      });
      await expect(
        kernel.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: attempt.entityId,
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: attempt.entityId,
          },
          { principalId: "principal-orbit" },
        ),
      ).rejects.toMatchObject({ code: "Unauthorized" });
      await expect(
        kernel.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: attempt.entityId,
          },
          {
            principalId: "principal-keel",
            activationId: execution.activationId,
          },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "provider-query-finish",
          activationId: execution.activationId,
          outcome: "Expired",
        },
        runtimeContext,
      );
      await expect(
        kernel.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: attempt.entityId,
          },
          execution.context,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      expect(
        await kernel.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: attempt.entityId,
          },
          runtimeContext,
        ),
      ).toEqual(runtimeView);
    } finally {
      kernel.close();
    }
  });

  it("pages recoverable Attention executions without skips as settled rows disappear", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const expired = await createAttentionExecution(
        kernel,
        "recover-expired",
        1_000,
      );
      now = new Date("2026-09-21T08:00:02.000Z");
      const started = await createAttentionExecution(
        kernel,
        "recover-started",
      );
      const startedAttempt = await startAttentionProviderAttempt(
        kernel,
        started.activationId,
        "recover-started",
      );
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "recover-started-finish",
          activationId: started.activationId,
          outcome: "Failed",
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:03.000Z");
      const acknowledged = await createAttentionExecution(
        kernel,
        "recover-acknowledged",
      );
      const acknowledgedAttempt = await startAttentionProviderAttempt(
        kernel,
        acknowledged.activationId,
        "recover-acknowledged",
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "recover-acknowledged-status",
          providerAttemptId: acknowledgedAttempt.entityId,
          status: "Acknowledged",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "recover-acknowledged-finish",
          activationId: acknowledged.activationId,
          outcome: "Expired",
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:04.000Z");
      const completed = await createAttentionExecution(
        kernel,
        "recover-completed",
      );
      const completedAttempt = await startAttentionProviderAttempt(
        kernel,
        completed.activationId,
        "recover-completed",
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "recover-completed-status",
          providerAttemptId: completedAttempt.entityId,
          status: "Completed",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "recover-completed-finish",
          activationId: completed.activationId,
          outcome: "Completed",
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:05.000Z");
      await createAttentionExecution(kernel, "recover-live");

      await expect(
        kernel.query(
          { type: "ListRecoverableAttentionExecutions", limit: 2 },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      const first = await kernel.query(
        { type: "ListRecoverableAttentionExecutions", limit: 2 },
        runtimeContext,
      );
      expect(first.items.map((item) => item.activation.id)).toEqual([
        expired.activationId,
        started.activationId,
      ]);
      expect(first.items[0]).toMatchObject({
        attention: { id: expired.attention.id },
        activation: {
          id: expired.activationId,
          finishedAt: null,
        },
        providerAttempts: [],
      });
      expect(first.items[1]?.providerAttempts).toEqual([
        expect.objectContaining({
          id: startedAttempt.entityId,
          status: "Started",
        }),
      ]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(first.items[1]?.cursor);

      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "recover-expired-settle",
          activationId: expired.activationId,
          outcome: "Expired",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "recover-started-settle",
          providerAttemptId: startedAttempt.entityId,
          status: "Unknown",
          detail: "Recovered after the owning Activation ended.",
        },
        runtimeContext,
      );

      const second = await kernel.query(
        {
          type: "ListRecoverableAttentionExecutions",
          afterCursor: first.nextCursor!,
          limit: 2,
        },
        runtimeContext,
      );
      expect(second.items.map((item) => item.activation.id)).toEqual([
        acknowledged.activationId,
      ]);
      expect(second.hasMore).toBe(false);
      const restarted = await kernel.query(
        { type: "ListRecoverableAttentionExecutions", limit: 10 },
        runtimeContext,
      );
      expect(restarted.items.map((item) => item.activation.id)).toEqual([
        acknowledged.activationId,
      ]);

      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "recover-acknowledged-settle",
          providerAttemptId: acknowledgedAttempt.entityId,
          status: "Unknown",
          detail: "Recovered an acknowledged attempt without a final result.",
        },
        runtimeContext,
      );
      expect(
        await kernel.query(
          { type: "ListRecoverableAttentionExecutions", limit: 10 },
          runtimeContext,
        ),
      ).toMatchObject({ items: [], nextCursor: null, hasMore: false });
    } finally {
      kernel.close();
    }
  });

  it("invalidates a sweep when an older execution becomes recoverable behind its cursor", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const behindCursor = await createAttentionExecution(
        kernel,
        "snapshot-behind-cursor",
      );
      await startAttentionProviderAttempt(
        kernel,
        behindCursor.activationId,
        "snapshot-behind-cursor",
      );
      now = new Date("2026-09-21T08:00:01.000Z");
      const stableHead = await createAttentionExecution(
        kernel,
        "snapshot-stable-head",
        1_000,
      );
      await createAttentionExecution(
        kernel,
        "snapshot-stable-tail",
        1_000,
      );
      now = new Date("2026-09-21T08:00:03.000Z");
      const snapshot = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      const first = await kernel.query(
        {
          type: "ListRecoverableAttentionExecutions",
          recoveryRevision: snapshot.revision,
          limit: 1,
        },
        runtimeContext,
      );
      expect(first.items.map((item) => item.activation.id)).toEqual([
        stableHead.activationId,
      ]);

      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "snapshot-behind-cursor-finish",
          activationId: behindCursor.activationId,
          outcome: "Failed",
        },
        runtimeContext,
      );

      await expect(
        kernel.query(
          {
            type: "ListRecoverableAttentionExecutions",
            afterCursor: first.nextCursor!,
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      const after = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      expect(after.revision).toBeGreaterThan(snapshot.revision);
    } finally {
      kernel.close();
    }
  });

  it("invalidates a sweep when the clock crosses its earliest expiry horizon", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      await createAttentionExecution(
        kernel,
        "snapshot-future-expiry",
        5_000,
      );
      now = new Date("2026-09-21T08:00:01.000Z");
      const stableHead = await createAttentionExecution(
        kernel,
        "snapshot-clock-head",
        1_000,
      );
      await createAttentionExecution(
        kernel,
        "snapshot-clock-tail",
        1_000,
      );
      now = new Date("2026-09-21T08:00:03.000Z");
      const snapshot = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      expect(snapshot.nextExpiryAt).toBe(
        "2026-09-21T08:00:05.000Z",
      );
      const first = await kernel.query(
        {
          type: "ListRecoverableAttentionExecutions",
          recoveryRevision: snapshot.revision,
          limit: 1,
        },
        runtimeContext,
      );
      expect(first.items.map((item) => item.activation.id)).toEqual([
        stableHead.activationId,
      ]);

      now = new Date("2026-09-21T08:00:05.000Z");
      const forgedContinuation = {
        type: "ListRecoverableAttentionExecutions",
        afterCursor: first.nextCursor!,
        recoveryRevision: snapshot.revision,
        recoverySnapshot: {
          revision: snapshot.revision,
          observedAt: "2026-09-21T08:00:06.000Z",
          nextExpiryAt: null,
        },
        limit: 1,
      } as const;
      await expect(
        kernel.query(forgedContinuation, runtimeContext),
      ).rejects.toMatchObject({ code: "StaleRevision" });
    } finally {
      kernel.close();
    }
  });

  it("uses authoritative current time across backward clocks and earlier inserted expiries", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      await createAttentionExecution(
        kernel,
        "snapshot-late-horizon",
        10_000,
      );
      now = new Date("2026-09-21T08:00:03.000Z");
      const snapshot = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      expect(snapshot.nextExpiryAt).toBe(
        "2026-09-21T08:00:10.000Z",
      );

      now = new Date("2026-09-21T08:00:02.000Z");
      await expect(
        kernel.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        recoverySnapshot: {
          revision: snapshot.revision,
          observedAt: "2026-09-21T08:00:02.000Z",
        },
      });

      await createAttentionExecution(
        kernel,
        "snapshot-earlier-insert",
        2_000,
      );
      await expect(
        kernel.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      const refreshed = await kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      expect(refreshed.revision).toBeGreaterThan(snapshot.revision);
      expect(refreshed.nextExpiryAt).toBe(
        "2026-09-21T08:00:04.000Z",
      );
    } finally {
      kernel.close();
    }
  });
});
