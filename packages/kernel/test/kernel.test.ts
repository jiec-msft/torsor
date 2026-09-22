import { describe, expect, it } from "vitest";

import { KernelError, TorsorKernel } from "../src/index.js";
import {
  bootstrap,
  claimRunOutboxAuthority,
  createRun,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

describe("TorsorKernel transactions and invariants", () => {
  it("atomically publishes a Message and unique Mention Attention", async () => {
    const kernel = openMemoryKernel();
    try {
      const result = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "atomic-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, inspect the synthetic fixture.",
          targetAgentIds: ["agent-orbit", "agent-orbit"],
        },
        humanContext,
      );

      const thread = await kernel.query(
        { type: "GetThreadProjection", threadRootId: result.entityId },
        humanContext,
      );
      const attentions = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          targetAgentId: "agent-orbit",
        },
        runtimeContext,
      );

      expect(thread.messages).toHaveLength(1);
      expect(thread.messages[0]?.targetAgentIds).toEqual(["agent-orbit"]);
      expect(attentions.items).toHaveLength(1);
      expect(attentions.items[0]).toMatchObject({
        messageRevisionId: thread.messages[0]?.revisions[0]?.id,
        targetAgentId: "agent-orbit",
        triggerKind: "Mention",
      });
    } finally {
      kernel.close();
    }
  });

  it("rolls back Message, Attention, events, and outbox work on failure", async () => {
    const kernel = openMemoryKernel();
    try {
      await expect(
        kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: "rollback-message",
            projectId: "project-sample",
            channelId: "channel-general",
            body: "This entire publication must roll back.",
            targetAgentIds: ["agent-orbit", "agent-missing"],
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "NotFound" });

      expect(
        (
          await kernel.query(
          { type: "ListOpenAttentions", projectId: "project-sample" },
          runtimeContext,
          )
        ).items,
      ).toEqual([]);
      expect(await kernel.readEvents(null, 100)).toEqual([]);
    } finally {
      kernel.close();
    }
  });

  it("uses expected Attention revision and a short lease for one resolver", async () => {
    const kernel = openMemoryKernel();
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "lease-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, inspect this.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const attentionPage = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const [attention] = attentionPage.items;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "lease-claim",
          attentionId: attention!.id,
          expectedAttentionRevision: 1,
          leaseDurationMs: 10_000,
        },
        runtimeContext,
      );

      await expect(
        kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "stale-claim",
            attentionId: attention!.id,
            expectedAttentionRevision: 1,
            leaseDurationMs: 10_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });

      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "lease-activation",
          attentionId: attention!.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      const run = await kernel.execute(
        {
          type: "ResolveAttentionWithRun",
          idempotencyKey: "lease-resolve",
          attentionId: attention!.id,
          expectedAttentionRevision: claim.revision!,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        {
          principalId: "principal-orbit",
          activationId: activation.entityId,
        },
      );

      await expect(
        kernel.execute(
          {
            type: "ResolveAttentionWithRun",
            idempotencyKey: "second-resolve",
            attentionId: attention!.id,
            expectedAttentionRevision: claim.revision!,
            handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
          },
          {
            principalId: "principal-orbit",
            activationId: activation.entityId,
          },
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: run.entityId },
        humanContext,
      );
      expect(projection.run).toMatchObject({
        homeChannelId: "channel-general",
        ownerAgentId: "agent-orbit",
        agentConfigRevision: 3,
        state: "Active",
      });
      expect(projection.inputs).toHaveLength(1);
      expect(thread.entityId).toBe(projection.run.threadRootId);
    } finally {
      kernel.close();
    }
  });

  it("atomically sends public input to a Run with monotonic sequence and revision", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const first = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "send-one",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "Also check the generated summary.",
          targetAgentIds: ["agent-orbit", "agent-keel"],
        },
        humanContext,
      );
      const cached = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "send-one",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "Also check the generated summary.",
          targetAgentIds: ["agent-orbit", "agent-keel"],
        },
        humanContext,
      );
      const second = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "send-two",
          runId: setup.runId,
          expectedRunRevision: 2,
          body: "Finally list the remaining uncertainty.",
        },
        humanContext,
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      const thread = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      const orbitAttentions = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const keelAttentions = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-keel" },
        runtimeContext,
      );

      expect(cached).toEqual(first);
      expect(second.revision).toBe(3);
      expect(projection.inputs.map((input) => input.sequence)).toEqual([1, 2, 3]);
      expect(new Set(projection.inputs.map((input) => input.messageRevisionId)).size).toBe(3);
      expect(thread.messages).toHaveLength(3);
      expect(projection.run.revision).toBe(3);
      expect(orbitAttentions.items).toHaveLength(0);
      expect(keelAttentions.items).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("keeps Provider delivery separate from RunInput disposition", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "provider-delivery",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "provider-start",
          activationId: setup.activationId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: { acceptsInputWhileRunning: false },
          runInputIds: [setup.runInputId],
          requestIdempotencyKey: "provider-request-1",
          diagnosticSessionId: "diagnostic-only",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "provider-finish",
          providerAttemptId: provider.entityId,
          status: "Completed",
        },
        runtimeContext,
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );

      expect(projection.providerAttempts[0]).toMatchObject({
        status: "Completed",
        diagnosticSessionId: "diagnostic-only",
      });
      expect(projection.inputs[0]?.disposition).toBe("Pending");
      expect(projection.run.state).toBe("Active");
    } finally {
      kernel.close();
    }
  });

  it("requires Agent capability context and scopes reads to its Activation", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const keelThread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "keel-private-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Keel, inspect a separate synthetic fact.",
          targetAgentIds: ["agent-keel"],
        },
        humanContext,
      );

      const bootstrap = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        { principalId: "principal-orbit" },
      );
      expect(bootstrap.openAttentions.items).toEqual([]);

      await expect(
        kernel.query(
          { type: "GetRunProjection", runId: setup.runId },
          { principalId: "principal-orbit" },
        ),
      ).rejects.toMatchObject({ code: "Unauthorized" });
      await expect(
        kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: keelThread.entityId,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      await expect(
        kernel.execute(
          {
            type: "AppendRunActivity",
            idempotencyKey: "activity-without-capability",
            runId: setup.runId,
            activationId: setup.activationId,
            kind: "status",
            payload: { text: "Forged provenance." },
            retentionClass: "durable",
          },
          { principalId: "principal-orbit" },
        ),
      ).rejects.toMatchObject({ code: "Unauthorized" });
    } finally {
      kernel.close();
    }
  });

  it("lets runtime reconciliation settle an attempt after Activation finish", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "async-provider",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "async-provider-start",
          activationId: setup.activationId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [setup.runInputId],
          requestIdempotencyKey: "async-provider-request",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "finish-before-provider",
          activationId: setup.activationId,
          outcome: "Expired",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "settle-late-provider",
          providerAttemptId: provider.entityId,
          status: "Unknown",
          detail: "Connection state could not be reconciled.",
        },
        runtimeContext,
      );

      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.providerAttempts[0]).toMatchObject({
        status: "Unknown",
        detail: "Connection state could not be reconciled.",
      });
      expect(projection.inputs[0]?.disposition).toBe("Pending");
    } finally {
      kernel.close();
    }
  });

  it("revision-fences Waiting to Active reactivation", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "wait-run",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Waiting for a new public instruction.",
        },
        setup.agentContext,
      );

      await expect(
        kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey: "stale-reactivation",
            runId: setup.runId,
            expectedRunRevision: 1,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });

      await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "fresh-reactivation",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.run).toMatchObject({ state: "Active", revision: 3 });
    } finally {
      kernel.close();
    }
  });

  it("rejects completion with Pending input and loses safely to new input", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      await expect(
        kernel.execute(
          {
            type: "CompleteRun",
            idempotencyKey: "complete-too-early",
            runId: setup.runId,
            expectedRunRevision: 1,
            incorporatedThroughInputSequence: 0,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "PendingRunInputs" });

      await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "racing-input",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "New input arriving before completion.",
        },
        humanContext,
      );

      await expect(
        kernel.execute(
          {
            type: "CompleteRun",
            idempotencyKey: "stale-complete",
            runId: setup.runId,
            expectedRunRevision: 1,
            incorporatedThroughInputSequence: 1,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });

      await expect(
        kernel.execute(
          {
            type: "CompleteRun",
            idempotencyKey: "unseen-input-complete",
            runId: setup.runId,
            expectedRunRevision: 2,
            incorporatedThroughInputSequence: 2,
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const refreshedActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "refresh-input-snapshot",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const completed = await kernel.execute(
        {
          type: "CompleteRun",
          idempotencyKey: "complete-all",
          runId: setup.runId,
          expectedRunRevision: 2,
          incorporatedThroughInputSequence: 2,
        },
        {
          principalId: "principal-orbit",
          activationId: refreshedActivation.entityId,
        },
      );
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(completed.revision).toBe(3);
      expect(projection.run.state).toBe("Completed");
      expect(
        projection.activations.find(
          (activation) => activation.id === refreshedActivation.entityId,
        )?.runInputIds,
      ).toEqual(projection.inputs.map((input) => input.id));
      expect(projection.inputs.map((input) => input.disposition)).toEqual([
        "Incorporated",
        "Incorporated",
      ]);
    } finally {
      kernel.close();
    }
  });

  it("rolls back every side effect of a conditional Reply", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const before = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "concurrent-human-reply",
          threadRootId: setup.threadId,
          body: "A concurrent public update.",
        },
        humanContext,
      );
      const changed = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );

      await expect(
        kernel.execute(
          {
            type: "PublishRunReply",
            idempotencyKey: "conditional-agent-reply",
            runId: setup.runId,
            expectedRunRevision: 1,
            expectedThreadCursor: before.cursor,
            body: "This stale reply must not be visible.",
            targetAgentIds: ["agent-keel"],
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });

      const after = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      expect(after.messages).toHaveLength(changed.messages.length);
      expect(after.attentions).toHaveLength(changed.attentions.length);
      expect(
        after.messages.some((message) =>
          message.revisions.some((revision) =>
            revision.body.includes("stale reply"),
          ),
        ),
      ).toBe(false);
    } finally {
      kernel.close();
    }
  });

  it("keeps Artifact digest and provenance immutable", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const artifact = await kernel.execute(
        {
          type: "PublishArtifact",
          idempotencyKey: "artifact-one",
          runId: setup.runId,
          expectedRunRevision: 1,
          contentDigest: "sha256:synthetic-report",
          baseRevision: "sample-base-1",
          mediaType: "application/json",
          storageLocation: "local://artifacts/synthetic-report",
          metadata: { label: "Synthetic report" },
        },
        setup.agentContext,
      );

      await expect(
        kernel.execute(
          {
            type: "PublishArtifact",
            idempotencyKey: "artifact-conflict",
            runId: setup.runId,
            expectedRunRevision: 1,
            contentDigest: "sha256:synthetic-report",
            baseRevision: "different-base",
            mediaType: "application/json",
            storageLocation: "local://artifacts/changed",
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.artifacts).toEqual([
        expect.objectContaining({
          id: artifact.entityId,
          contentDigest: "sha256:synthetic-report",
          producerRunId: setup.runId,
          producerActivationId: setup.activationId,
          baseRevision: "sample-base-1",
        }),
      ]);
    } finally {
      kernel.close();
    }
  });

  it("never reactivates or mutates a terminal Run and records late output separately", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "provider-before-terminal",
      );
      const provider = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "provider-before-terminal",
          activationId: setup.activationId,
          ...outboxAuthority,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [setup.runInputId],
          requestIdempotencyKey: "provider-before-cancel",
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "CancelRun",
          idempotencyKey: "cancel-run",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Human stopped the synthetic investigation.",
        },
        humanContext,
      );
      const before = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );

      await expect(
        kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey: "reactivate-terminal",
            runId: setup.runId,
            expectedRunRevision: 2,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "TerminalRun" });
      await expect(
        kernel.execute(
          {
            type: "FinishProviderAttempt",
            idempotencyKey: "agent-settle-after-terminal",
            providerAttemptId: provider.entityId,
            status: "Completed",
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      await expect(
        kernel.execute(
          {
            type: "StartProviderAttempt",
            idempotencyKey: "provider-after-terminal",
            activationId: setup.activationId,
            adapter: "deterministic-fake",
            adapterVersion: "1",
            capabilitySnapshot: {},
            runInputIds: [setup.runInputId],
            requestIdempotencyKey: "terminal-provider-request",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "AppendRunActivity",
            idempotencyKey: "ordinary-activity-after-terminal",
            runId: setup.runId,
            activationId: setup.activationId,
            kind: "assistant_delta",
            payload: { text: "Must be late output instead." },
            retentionClass: "durable",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      await kernel.execute(
        {
          type: "RecordLateOutput",
          idempotencyKey: "late-output",
          runId: setup.runId,
          activationId: setup.activationId,
          payload: { text: "Late diagnostic output only." },
        },
        runtimeContext,
      );
      const after = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );

      expect(after.run).toEqual(before.run);
      expect(after.inputs[0]).toMatchObject({
        disposition: "Abandoned",
        dispositionReason: "run_cancelled",
      });
      expect(after.activity.items.at(-1)).toMatchObject({ kind: "late_output" });
    } finally {
      kernel.close();
    }
  });

  it("rejects self-referential RunInput supersession", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      await expect(
        kernel.execute(
          {
            type: "CompleteRun",
            idempotencyKey: "self-supersession",
            runId: setup.runId,
            expectedRunRevision: 1,
            incorporatedThroughInputSequence: 1,
            exceptions: [
              {
                runInputId: setup.runInputId,
                disposition: "Superseded",
                reason: "Invalid self-link.",
                supersededByRunInputId: setup.runInputId,
              },
            ],
          },
          setup.agentContext,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });

      const projection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(projection.run.state).toBe("Active");
      expect(projection.inputs[0]?.disposition).toBe("Pending");
    } finally {
      kernel.close();
    }
  });

  it("rejects cyclic RunInput supersession", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel);
      const second = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "cycle-second-input",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "A second input for cycle validation.",
        },
        humanContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "cycle-activation",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );

      await expect(
        kernel.execute(
          {
            type: "CompleteRun",
            idempotencyKey: "cyclic-supersession",
            runId: setup.runId,
            expectedRunRevision: 2,
            incorporatedThroughInputSequence: 2,
            exceptions: [
              {
                runInputId: setup.runInputId,
                disposition: "Superseded",
                reason: "Cycle edge one.",
                supersededByRunInputId: second.relatedIds!.runInputId!,
              },
              {
                runInputId: second.relatedIds!.runInputId!,
                disposition: "Superseded",
                reason: "Cycle edge two.",
                supersededByRunInputId: setup.runInputId,
              },
            ],
          },
          {
            principalId: "principal-orbit",
            activationId: activation.entityId,
          },
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });
    } finally {
      kernel.close();
    }
  });

  it("revokes an Attention Activation when its handler lease expires", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "expiring-lease-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, inspect this before the lease expires.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const attentionPage = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const [attention] = attentionPage.items;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "expiring-lease-claim",
          attentionId: attention!.id,
          expectedAttentionRevision: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "expiring-lease-activation",
          attentionId: attention!.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:02.000Z");
      const agentContext = {
        principalId: "principal-orbit",
        activationId: activation.entityId,
      };

      await expect(
        kernel.query(
          { type: "GetThreadProjection", threadRootId: thread.entityId },
          agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "StartProviderAttempt",
            idempotencyKey: "provider-after-lease-expiry",
            activationId: activation.entityId,
            adapter: "deterministic-fake",
            adapterVersion: "1",
            capabilitySnapshot: {},
            runInputIds: [],
            requestIdempotencyKey: "expired-lease-provider",
          },
          agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: "agent-finish-expired-attention",
            activationId: activation.entityId,
            outcome: "Completed",
          },
          agentContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "runtime-finish-expired-attention",
          activationId: activation.entityId,
          outcome: "Expired",
        },
        runtimeContext,
      );
    } finally {
      kernel.close();
    }
  });

  it("prevents a stale Attention Activation from using a replacement lease", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => now);
    try {
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "replacement-lease-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, inspect this lease replacement case.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const attentionPage = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const [attention] = attentionPage.items;
      const firstClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "first-replacement-claim",
          attentionId: attention!.id,
          expectedAttentionRevision: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      const staleActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "stale-replacement-activation",
          attentionId: attention!.id,
          handlerLeaseToken: firstClaim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      now = new Date("2026-09-21T08:00:02.000Z");
      const replacementClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "replacement-claim",
          attentionId: attention!.id,
          expectedAttentionRevision: firstClaim.revision!,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );

      await expect(
        kernel.execute(
          {
            type: "ResolveAttentionWithRun",
            idempotencyKey: "stale-replacement-resolve",
            attentionId: attention!.id,
            expectedAttentionRevision: replacementClaim.revision!,
            handlerLeaseToken:
              replacementClaim.relatedIds!.handlerLeaseToken!,
          },
          {
            principalId: "principal-orbit",
            activationId: staleActivation.entityId,
          },
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const stillOpenPage = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const [stillOpen] = stillOpenPage.items;
      expect(stillOpen?.revision).toBe(replacementClaim.revision);
    } finally {
      kernel.close();
    }
  });

  it("orders Messages by durable Thread cursor when timestamps tie", async () => {
    let sequence = 0;
    let messageCount = 0;
    const kernel = TorsorKernel.open({
      databasePath: ":memory:",
      bootstrap,
      clock: () => new Date("2026-09-21T08:00:00.000Z"),
      idFactory: (prefix) => {
        if (prefix === "message") {
          messageCount += 1;
          return messageCount === 1 ? "message-z" : "message-a";
        }
        sequence += 1;
        return `${prefix}-${sequence}`;
      },
    });
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "ordered-root",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "First publication.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "ordered-reply",
          threadRootId: thread.entityId,
          body: "Second publication.",
        },
        humanContext,
      );
      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(
        projection.messages.map((message) => message.revisions[0]?.body),
      ).toEqual(["First publication.", "Second publication."]);
      expect(projection.messages.map((message) => message.threadCursor)).toEqual([
        1, 2,
      ]);
    } finally {
      kernel.close();
    }
  });

  it("returns the cached result for identical idempotency payload and conflicts otherwise", async () => {
    const kernel = openMemoryKernel();
    try {
      const command = {
        type: "StartThread",
        idempotencyKey: "same-key",
        projectId: "project-sample",
        channelId: "channel-general",
        body: "A stable idempotent request.",
      } as const;
      const first = await kernel.execute(command, humanContext);
      const second = await kernel.execute(command, humanContext);
      expect(second).toEqual(first);

      await expect(
        kernel.execute(
          { ...command, body: "A conflicting request body." },
          humanContext,
        ),
      ).rejects.toBeInstanceOf(KernelError);
      await expect(
        kernel.execute(
          { ...command, body: "A conflicting request body." },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const thread = await kernel.query(
        { type: "GetThreadProjection", threadRootId: first.entityId },
        humanContext,
      );
      expect(thread.messages).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("exposes stable event IDs and monotonic Thread cursors", async () => {
    const kernel = openMemoryKernel();
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "event-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Initial event.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "event-reply",
          threadRootId: thread.entityId,
          body: "Second event.",
        },
        humanContext,
      );
      const firstPage = await kernel.readEvents(null, 1);
      const remaining = await kernel.readEvents(firstPage[0]!.eventId, 100);
      const visibleCursors = [...firstPage, ...remaining]
        .filter((event) => event.threadRootId === thread.entityId)
        .map((event) => event.threadCursor)
        .filter((cursor): cursor is number => cursor !== null);

      expect(firstPage).toHaveLength(1);
      expect(new Set([...firstPage, ...remaining].map((event) => event.eventId)).size).toBe(
        firstPage.length + remaining.length,
      );
      expect(visibleCursors).toEqual([...visibleCursors].sort((a, b) => a - b));
      expect(visibleCursors.at(-1)).toBe(2);
    } finally {
      kernel.close();
    }
  });
});
