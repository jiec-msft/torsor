import { describe, expect, it } from "vitest";

import { type KernelCommand } from "../src/index.js";
import {
  createRun,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

describe("independent review regressions", () => {
  it("revokes execution authority when a Run enters Waiting", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "review-wait",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Waiting for another durable input.",
        },
        setup.agentContext,
      );

      await expect(
        kernel.execute(
          {
            type: "StartProviderAttempt",
            idempotencyKey: "provider-while-waiting",
            activationId: setup.activationId,
            adapter: "deterministic-fake",
            adapterVersion: "1",
            capabilitySnapshot: {},
            runInputIds: [setup.runInputId],
            requestIdempotencyKey: "provider-while-waiting",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const nextActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "review-reactivate",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      const previous = projection.activations.find(
        (activation) => activation.id === setup.activationId,
      );
      const current = projection.activations.find(
        (activation) => activation.id === nextActivation.entityId,
      );
      expect(projection.run).toMatchObject({
        state: "Active",
        activationGeneration: 2,
      });
      expect(previous).toMatchObject({
        runActivationGeneration: 1,
        revocationReason: "run_waiting",
      });
      expect(current).toMatchObject({
        runActivationGeneration: 2,
        revokedAt: null,
      });
    } finally {
      kernel.close();
    }
  });

  it("returns the existing Activation for one Attention lease", async () => {
    const kernel = openMemoryKernel();
    try {
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "duplicate-attention-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, inspect the duplicate activation case.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items[0]!;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "duplicate-attention-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const command = {
        type: "StartActivation",
        attentionId: attention.id,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      } as const;
      const first = await kernel.execute(
        { ...command, idempotencyKey: "activation-key-one" },
        runtimeContext,
      );
      const second = await kernel.execute(
        { ...command, idempotencyKey: "activation-key-two" },
        runtimeContext,
      );
      const events = await kernel.readEvents(null, 500);

      expect(second.entityId).toBe(first.entityId);
      expect(
        events.filter(
          (event) =>
            event.type === "ActivationStarted" &&
            event.entityId === first.entityId,
        ),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("ignores forged Activation provenance on Human commands", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const message = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "forged-human-provenance",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "A Human-authored message has no Activation provenance.",
        },
        {
          principalId: humanContext.principalId,
          activationId: setup.activationId,
        },
      );
      const event = (await kernel.readEvents(null, 500)).find(
        (candidate) =>
          candidate.type === "MessagePublished" &&
          candidate.entityId === message.entityId,
      );
      expect(event?.activationId).toBeNull();
    } finally {
      kernel.close();
    }
  });

  it("rejects Agent completion that marks Human input Withdrawn", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const malformed = JSON.parse(
        JSON.stringify({
          type: "CompleteRun",
          idempotencyKey: "agent-withdraw-human-input",
          runId: setup.runId,
          expectedRunRevision: 1,
          incorporatedThroughInputSequence: 1,
          exceptions: [
            {
              runInputId: setup.runInputId,
              disposition: "Withdrawn",
              reason: "An Agent cannot withdraw Human-owned input.",
            },
          ],
        }),
      ) as KernelCommand;

      await expect(
        kernel.execute(malformed, setup.agentContext),
      ).rejects.toMatchObject({ code: "InvalidCommand" });
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.inputs[0]?.disposition).toBe("Pending");
    } finally {
      kernel.close();
    }
  });

  it("paginates every open Attention with a stable cursor", async () => {
    const kernel = openMemoryKernel();
    try {
      for (let index = 0; index < 105; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `attention-page-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Synthetic attention ${index}.`,
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );
      }
      const bootstrapProjection = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        runtimeContext,
      );
      expect(bootstrapProjection.openAttentions.items).toHaveLength(100);
      expect(bootstrapProjection.openAttentions.hasMore).toBe(true);

      const remainder = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          afterCursor: bootstrapProjection.openAttentions.nextCursor!,
          limit: 100,
        },
        runtimeContext,
      );
      const cursors = [
        ...bootstrapProjection.openAttentions.items,
        ...remainder.items,
      ].map((attention) => attention.cursor);
      expect(remainder.items).toHaveLength(5);
      expect(remainder.hasMore).toBe(false);
      expect(new Set(cursors).size).toBe(105);
      expect(cursors).toEqual([...cursors].sort((left, right) => left - right));
    } finally {
      kernel.close();
    }
  });

  it("returns the latest activity window and paginates the full stream", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      for (let index = 1; index <= 105; index += 1) {
        await kernel.execute(
          {
            type: "AppendRunActivity",
            idempotencyKey: `activity-${index}`,
            runId: setup.runId,
            activationId: setup.activationId,
            kind: "status",
            payload: { index },
            retentionClass: "durable",
          },
          runtimeContext,
        );
      }
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.activity).toMatchObject({
        hasEarlier: true,
        earliestSequence: 6,
        latestSequence: 105,
      });
      expect(projection.activity.items).toHaveLength(100);

      const first = await kernel.query(
        {
          type: "ListActivity",
          runId: setup.runId,
          afterSequence: 0,
          limit: 100,
        },
        humanContext,
      );
      const second = await kernel.query(
        {
          type: "ListActivity",
          runId: setup.runId,
          afterSequence: first.nextCursor!,
          limit: 100,
        },
        humanContext,
      );
      expect(first.items).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(second.items).toHaveLength(5);
      expect(second.hasMore).toBe(false);
    } finally {
      kernel.close();
    }
  });

  it("distinguishes Provider acknowledgement and terminal Unknown", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "provider-status-start",
          activationId: setup.activationId,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [setup.runInputId],
          requestIdempotencyKey: "provider-status-request",
        },
        runtimeContext,
      );
      const malformedStatus = JSON.parse(
        JSON.stringify({
          type: "FinishProviderAttempt",
          idempotencyKey: "provider-invalid-started-status",
          providerAttemptId: provider.entityId,
          status: "Started",
        }),
      ) as KernelCommand;
      await expect(
        kernel.execute(malformedStatus, runtimeContext),
      ).rejects.toMatchObject({ code: "InvalidCommand" });
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "provider-acknowledged",
          providerAttemptId: provider.entityId,
          status: "Acknowledged",
        },
        runtimeContext,
      );
      let projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.providerAttempts[0]).toMatchObject({
        status: "Acknowledged",
        finishedAt: null,
      });

      await expect(
        kernel.execute(
          {
            type: "FinishProviderAttempt",
            idempotencyKey: "provider-unknown-without-reason",
            providerAttemptId: provider.entityId,
            status: "Unknown",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });

      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "provider-unknown-with-reason",
          providerAttemptId: provider.entityId,
          status: "Unknown",
          detail: "The transport disconnected before a terminal receipt.",
        },
        runtimeContext,
      );
      projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.providerAttempts[0]).toMatchObject({
        status: "Unknown",
        detail: "The transport disconnected before a terminal receipt.",
      });
      const eventTypes = (await kernel.readEvents(null, 500))
        .filter((event) => event.entityId === provider.entityId)
        .map((event) => event.type);
      expect(eventTypes).toContain("ProviderAttemptAcknowledged");
      expect(eventTypes).toContain("ProviderAttemptFinished");
    } finally {
      kernel.close();
    }
  });

  it("requires atomic acknowledgement of an Outbox lease batch", async () => {
    const kernel = openMemoryKernel();
    try {
      for (let index = 0; index < 2; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `outbox-batch-message-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Outbox batch message ${index}.`,
          },
          humanContext,
        );
      }
      const claim = await kernel.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "outbox-batch-claim",
          limit: 2,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(claim.outboxEvents).toHaveLength(2);

      await expect(
        kernel.execute(
          {
            type: "AcknowledgeOutboxEvents",
            idempotencyKey: "partial-outbox-batch-ack",
            outboxEventIds: [claim.outboxEvents![0]!.id],
            leaseToken: claim.leaseToken!,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });

      await kernel.execute(
        {
          type: "AcknowledgeOutboxEvents",
          idempotencyKey: "complete-outbox-batch-ack",
          outboxEventIds: claim.outboxEvents!.map((event) => event.id),
          leaseToken: claim.leaseToken!,
        },
        runtimeContext,
      );
    } finally {
      kernel.close();
    }
  });
});
