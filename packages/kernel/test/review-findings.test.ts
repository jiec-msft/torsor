import { describe, expect, it } from "vitest";

import { type KernelCommand } from "../src/index.js";
import {
  claimRunOutboxAuthority,
  createRun,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

describe("independent review regressions", () => {
  it("revalidates cached provider admission against the live Outbox frontier", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const setup = await createRun(kernel);
      const authority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "cached-provider-authority",
      );
      const command = {
        type: "StartProviderAttempt",
        idempotencyKey: "cached-provider-authority:start",
        activationId: setup.activationId,
        ...authority,
        adapter: "deterministic-fake",
        adapterVersion: "1",
        capabilitySnapshot: {},
        runInputIds: [setup.runInputId],
        requestIdempotencyKey: "cached-provider-authority:request",
      } as const;

      const first = await kernel.execute(command, runtimeContext);
      now = new Date("2026-09-21T08:00:01.000Z");
      const retry = await kernel.execute(command, runtimeContext);

      expect(retry).toMatchObject({
        entityId: first.entityId,
        leaseExpiresAt: "2026-09-21T08:00:30.000Z",
        authorityObservedAt: now.toISOString(),
      });

      await kernel.execute(
        {
          type: "AcknowledgeOutboxEvents",
          idempotencyKey: "cached-provider-authority:ack",
          outboxEventIds: [authority.outboxEventId],
          leaseToken: authority.outboxLeaseToken,
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(command, runtimeContext),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("rejects an intervening Outbox lease and admits its replacement once", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const setup = await createRun(kernel);
      const originalAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "intervening-provider-authority",
      );
      const originalCommand = {
        type: "StartProviderAttempt",
        idempotencyKey: "intervening-provider-authority:original",
        activationId: setup.activationId,
        ...originalAuthority,
        adapter: "deterministic-fake",
        adapterVersion: "1",
        capabilitySnapshot: {},
        runInputIds: [setup.runInputId],
        requestIdempotencyKey: "intervening-provider-authority:request",
      } as const;
      await kernel.execute(originalCommand, runtimeContext);

      now = new Date("2026-09-21T08:00:31.000Z");
      const replacementClaim = await kernel.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "intervening-provider-authority:replacement-claim",
          limit: 1,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(replacementClaim.outboxEvents?.[0]?.id).toBe(
        originalAuthority.outboxEventId,
      );
      await expect(
        kernel.execute(originalCommand, runtimeContext),
      ).rejects.toMatchObject({ code: "Conflict" });

      const replacementActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey:
            "intervening-provider-authority:replacement-activation",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      const replacement = await kernel.execute(
        {
          ...originalCommand,
          idempotencyKey:
            "intervening-provider-authority:replacement-attempt",
          activationId: replacementActivation.entityId,
          outboxLeaseToken: replacementClaim.leaseToken!,
        },
        runtimeContext,
      );
      const retry = await kernel.execute(
        {
          ...originalCommand,
          idempotencyKey:
            "intervening-provider-authority:replacement-attempt",
          activationId: replacementActivation.entityId,
          outboxLeaseToken: replacementClaim.leaseToken!,
        },
        runtimeContext,
      );

      expect(retry.entityId).toBe(replacement.entityId);
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        runtimeContext,
      );
      expect(
        projection.providerAttempts.filter(
          (attempt) =>
            attempt.activationId === replacementActivation.entityId,
        ),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

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

  it("allows only Runtime authority to claim Attention and mint Activations", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const current = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "runtime-replacement-activation",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "runtime-authority-attention",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, wait for trusted Runtime dispatch.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items[0]!;

      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "stale-agent-claim",
            attentionId: attention.id,
            expectedAttentionRevision: attention.revision,
            leaseDurationMs: 30_000,
          },
          { principalId: "principal-orbit" },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "runtime-authority-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey: "stale-agent-attention-activation",
            attentionId: attention.id,
            handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      const attentionActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "runtime-attention-activation",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      const attentionRetry = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "runtime-attention-activation-retry",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      expect(attentionRetry.entityId).toBe(attentionActivation.entityId);

      await expect(
        kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey: "stale-agent-run-replacement",
            runId: setup.runId,
            expectedRunRevision: 1,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.run.activationGeneration).toBe(2);
      expect(
        projection.activations.find(
          (activation) => activation.id === current.entityId,
        ),
      ).toMatchObject({
        runActivationGeneration: 2,
        revokedAt: null,
      });

      await expect(
        kernel.execute(
          {
            type: "AppendRunActivity",
            idempotencyKey: "stale-agent-authoritative-activity",
            runId: setup.runId,
            activationId: setup.activationId,
            kind: "status",
            payload: { state: "must-remain-stale" },
            retentionClass: "durable",
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const runtimeReplacement = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "runtime-next-replacement",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      const runtimeRetry = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "runtime-next-replacement",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      expect(runtimeRetry).toEqual(runtimeReplacement);
      const finalProjection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(finalProjection.run.activationGeneration).toBe(3);
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

  it("allows only the assigning Human to withdraw a RunInput", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const sent = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "withdraw-human-input",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "This Human input may be explicitly withdrawn.",
        },
        humanContext,
      );
      const runInputId = sent.relatedIds!.runInputId!;

      await expect(
        kernel.execute(
          {
            type: "WithdrawRunInput",
            idempotencyKey: "unrelated-human-withdrawal",
            runInputId,
            expectedRunRevision: 2,
            expectedDispositionRevision: 1,
            reason: "An unrelated Human cannot withdraw this input.",
          },
          { principalId: "principal-riley" },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.execute(
          {
            type: "WithdrawRunInput",
            idempotencyKey: "unrelated-agent-withdrawal",
            runInputId,
            expectedRunRevision: 2,
            expectedDispositionRevision: 1,
            reason: "An unrelated Agent cannot withdraw this input.",
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const withdrawn = await kernel.execute(
        {
          type: "WithdrawRunInput",
          idempotencyKey: "assigning-human-withdrawal",
          runInputId,
          expectedRunRevision: 2,
          expectedDispositionRevision: 1,
          reason: "The assigning Human withdrew the request.",
        },
        humanContext,
      );
      const cached = await kernel.execute(
        {
          type: "WithdrawRunInput",
          idempotencyKey: "assigning-human-withdrawal",
          runInputId,
          expectedRunRevision: 2,
          expectedDispositionRevision: 1,
          reason: "The assigning Human withdrew the request.",
        },
        humanContext,
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(cached).toEqual(withdrawn);
      expect(projection.run.revision).toBe(3);
      expect(
        projection.inputs.find((input) => input.id === runInputId),
      ).toMatchObject({
        disposition: "Withdrawn",
        dispositionRevision: 2,
      });
    } finally {
      kernel.close();
    }
  });

  it("prevents new Provider delivery after RunInput withdrawal", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const sent = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "provider-withdrawal-input",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "Do not deliver this input after it is withdrawn.",
        },
        humanContext,
      );
      const runInputId = sent.relatedIds!.runInputId!;
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "provider-withdrawal-activation",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "provider-withdrawal",
        runInputId,
      );
      const alreadyStarted = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "provider-before-withdrawal",
          activationId: activation.entityId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [runInputId],
          requestIdempotencyKey: "provider-before-withdrawal",
        },
        runtimeContext,
      );

      await kernel.execute(
        {
          type: "WithdrawRunInput",
          idempotencyKey: "withdraw-before-new-provider",
          runInputId,
          expectedRunRevision: 2,
          expectedDispositionRevision: 1,
          reason: "The assigning Human withdrew the input.",
        },
        humanContext,
      );

      await expect(
        kernel.execute(
          {
            type: "StartProviderAttempt",
            idempotencyKey: "provider-after-withdrawal",
            activationId: activation.entityId,
            ...outboxAuthority,
            adapter: "deterministic-fake",
            adapterVersion: "1",
            capabilitySnapshot: {},
            runInputIds: [runInputId],
            requestIdempotencyKey: "provider-after-withdrawal",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({
        code: "Conflict",
        message: "Provider input must still be Pending when delivery starts.",
      });
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(
        projection.providerAttempts.find(
          (attempt) => attempt.id === alreadyStarted.entityId,
        ),
      ).toMatchObject({ status: "Started", runInputIds: [runInputId] });
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

  it("keeps Attention pages bound to one event snapshot", async () => {
    const kernel = openMemoryKernel();
    try {
      for (let index = 0; index < 3; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `snapshot-attention-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Snapshot attention ${index}.`,
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );
      }
      const initial = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 10,
        },
        runtimeContext,
      );
      const first = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 2,
        },
        runtimeContext,
      );
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);

      await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "snapshot-attention-claim",
          attentionId: initial.items[2]!.id,
          expectedAttentionRevision: initial.items[2]!.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "snapshot-attention-late",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Created after the Attention snapshot.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const second = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          afterCursor: first.nextCursor!,
          snapshotEventId: first.snapshotEventId,
          limit: 2,
        },
        runtimeContext,
      );
      const events = await kernel.readEvents(first.snapshotEventId, 100);
      const newAttentionEvents = events.filter(
        (event) => event.type === "AttentionOpened",
      );
      const claimEvents = events.filter(
        (event) => event.type === "AttentionClaimed",
      );
      const current = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 10,
        },
        runtimeContext,
      );
      const recoveredIds = new Set([
        ...first.items.map((attention) => attention.id),
        ...second.items.map((attention) => attention.id),
        ...newAttentionEvents.map((event) => event.entityId),
      ]);

      expect(second.items).toHaveLength(1);
      expect(second.items[0]).toMatchObject({
        id: initial.items[2]!.id,
        revision: 1,
        handlerLeaseHolderPrincipalId: null,
      });
      expect(second.snapshotEventId).toBe(first.snapshotEventId);
      expect(newAttentionEvents).toHaveLength(1);
      expect(claimEvents).toHaveLength(1);
      expect(recoveredIds).toEqual(
        new Set(current.items.map((attention) => attention.id)),
      );
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

  it("records stale Activation output while the Run remains Active", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const current = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "superseding-active-generation",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      const before = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );

      await expect(
        kernel.execute(
          {
            type: "RecordLateOutput",
            idempotencyKey: "current-output-is-not-late",
            runId: setup.runId,
            activationId: current.entityId,
            payload: { text: "Current output." },
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await kernel.execute(
        {
          type: "RecordLateOutput",
          idempotencyKey: "superseded-output-is-late",
          runId: setup.runId,
          activationId: setup.activationId,
          payload: { text: "Output from the superseded generation." },
        },
        runtimeContext,
      );
      const after = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(after.run).toEqual(before.run);
      expect(after.activity.items.at(-1)).toMatchObject({
        kind: "late_output",
        activationId: setup.activationId,
      });
    } finally {
      kernel.close();
    }
  });

  it("distinguishes Provider acknowledgement and terminal Unknown", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "provider-status",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "provider-status-start",
          activationId: setup.activationId,
          ...outboxAuthority,
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
      expect(claim.leaseExpiresAt).toBe(
        "2026-09-21T08:00:30.000Z",
      );
      expect(
        claim.outboxEvents?.every(
          (event) => event.leaseExpiresAt === claim.leaseExpiresAt,
        ),
      ).toBe(true);

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
      await expect(
        kernel.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "outbox-batch-claim",
            limit: 2,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });
});
