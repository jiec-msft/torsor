import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import {
  bootstrap,
  claimRunOutboxAuthority,
  createRun,
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

describe("MVP collaboration operations", () => {
  it("appends Message revisions, preserves historical references, and tombstones author-only", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel, "-message-revisions");
      const before = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      const root = before.messages[0]!;
      const originalRevisionId = root.revisions[0]!.id;

      await expect(
        kernel.execute(
          {
            type: "EditMessage",
            idempotencyKey: "other-human-edit",
            messageId: root.id,
            expectedMessageRevision: 1,
            body: "Riley must not rewrite Avery's Message.",
          },
          { principalId: "principal-riley" },
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });

      const edit = {
        type: "EditMessage",
        idempotencyKey: "author-edit",
        messageId: root.id,
        expectedMessageRevision: 1,
        body: "Orbit and Keel, inspect the revised public sample.",
        targetAgentIds: ["agent-orbit", "agent-keel", "agent-orbit"],
      } as const;
      const edited = await kernel.execute(edit, humanContext);
      expect(await kernel.execute(edit, humanContext)).toEqual(edited);
      await expect(
        kernel.execute(
          {
            ...edit,
            idempotencyKey: "stale-author-edit",
            body: "This stale edit must not append.",
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });

      const afterEdit = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      expect(afterEdit.cursor).toBe(before.cursor + 1);
      expect(afterEdit.messages[0]).toMatchObject({
        id: root.id,
        authorPrincipalId: "principal-human",
        latestRevision: 2,
        targetAgentIds: ["agent-keel", "agent-orbit"],
      });
      expect(afterEdit.messages[0]!.revisions).toMatchObject([
        {
          id: originalRevisionId,
          revision: 1,
          tombstone: false,
          targetAgentIds: ["agent-orbit"],
        },
        {
          revision: 2,
          tombstone: false,
          targetAgentIds: ["agent-keel", "agent-orbit"],
        },
      ]);
      const runAfterEdit = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(runAfterEdit.inputs[0]!.messageRevisionId).toBe(originalRevisionId);
      const openAttentions = await kernel.query(
        { type: "ListOpenAttentions", projectId: "project-sample" },
        runtimeContext,
      );
      expect(
        openAttentions.items.filter(
          (attention) =>
            attention.messageRevisionId ===
            afterEdit.messages[0]!.revisions[1]!.id,
        ).map((attention) => attention.targetAgentId).sort(),
      ).toEqual(["agent-keel", "agent-orbit"]);

      const deleted = await kernel.execute(
        {
          type: "DeleteMessage",
          idempotencyKey: "author-delete",
          messageId: root.id,
          expectedMessageRevision: 2,
        },
        humanContext,
      );
      expect(deleted.revision).toBe(3);
      const afterDelete = await kernel.query(
        { type: "GetThreadProjection", threadRootId: setup.threadId },
        humanContext,
      );
      expect(afterDelete.cursor).toBe(afterEdit.cursor + 1);
      expect(afterDelete.messages[0]).toMatchObject({
        authorPrincipalId: "principal-human",
        latestRevision: 3,
        targetAgentIds: [],
      });
      expect(afterDelete.messages[0]!.revisions[2]).toMatchObject({
        revision: 3,
        body: "",
        tombstone: true,
        targetAgentIds: [],
      });
      expect(
        afterDelete.attentions.some(
          (attention) => attention.messageRevisionId === originalRevisionId,
        ),
      ).toBe(true);
      expect(runAfterEdit.inputs[0]!.messageRevisionId).toBe(originalRevisionId);

      await expect(
        kernel.execute(
          {
            type: "EditMessage",
            idempotencyKey: "edit-tombstone",
            messageId: root.id,
            expectedMessageRevision: 3,
            body: "MVP does not restore tombstones.",
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "DeleteMessage",
            idempotencyKey: "delete-tombstone-again",
            messageId: root.id,
            expectedMessageRevision: 3,
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("does not let a Human edit an Agent-authored Message", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel, "-agent-message");
      const reply = await kernel.execute(
        {
          type: "PublishRunReply",
          idempotencyKey: "agent-reply",
          runId: setup.runId,
          expectedRunRevision: 1,
          body: "Agent-authored durable reply.",
        },
        setup.agentContext,
      );
      await expect(
        kernel.execute(
          {
            type: "EditMessage",
            idempotencyKey: "human-overrides-agent",
            messageId: reply.entityId,
            expectedMessageRevision: 1,
            body: "A Human must not rewrite this.",
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
    } finally {
      kernel.close();
    }
  });

  it("updates immutable Agent config and adopts it only for future Run Activations", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel, "-config-adoption");
      const pinnedRuns = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 1,
        },
        humanContext,
      );
      const pinnedThreads = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          snapshotEventId: pinnedRuns.snapshotEventId,
          limit: 1,
        },
        humanContext,
      );
      expect(pinnedRuns.items[0]!.run).toMatchObject({
        id: setup.runId,
        revision: 1,
        agentConfigRevision: 3,
      });
      expect(
        pinnedThreads.items[0]!.runs.find((run) => run.id === setup.runId),
      ).toMatchObject({
        revision: 1,
        agentConfigRevision: 3,
      });
      const updateCommand = {
        type: "UpdateAgentConfig",
        idempotencyKey: "update-agent-config",
        agentId: "agent-orbit",
        expectedAgentConfigRevision: 3,
        config: { model: "deterministic-fake-v2", mode: "read-only" },
      } as const;
      const updated = await kernel.execute(updateCommand, humanContext);
      expect(updated.revision).toBe(4);
      expect(await kernel.execute(updateCommand, humanContext)).toEqual(updated);

      const bootstrapProjection = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        humanContext,
      );
      expect(
        bootstrapProjection.agents.find((agent) => agent.id === "agent-orbit"),
      ).toMatchObject({
        id: "agent-orbit",
        configRevision: 4,
        config: { model: "deterministic-fake-v2", mode: "read-only" },
      });
      const updateEvent = (await kernel.readEvents(null, 100)).find(
        (event) => event.type === "AgentConfigUpdated",
      );
      expect(updateEvent).toMatchObject({
        entityType: "Agent",
        entityId: "agent-orbit",
        actorPrincipalId: "principal-human",
        payload: { previousRevision: 3, revision: 4 },
      });
      expect(JSON.stringify(updateEvent)).not.toContain("deterministic-fake-v2");

      await expect(
        kernel.execute(
          {
            type: "AdoptRunConfig",
            idempotencyKey: "invalid-config-target",
            runId: setup.runId,
            expectedRunRevision: 1,
            expectedAgentConfigRevision: 4,
            targetAgentConfigRevision: 5,
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "InvalidCommand" });

      const adopted = await kernel.execute(
        {
          type: "AdoptRunConfig",
          idempotencyKey: "adopt-agent-config",
          runId: setup.runId,
          expectedRunRevision: 1,
          expectedAgentConfigRevision: 4,
          targetAgentConfigRevision: 4,
        },
        humanContext,
      );
      expect(adopted).toMatchObject({
        entityId: setup.runId,
        revision: 2,
        relatedIds: { agentId: "agent-orbit", agentConfigRevision: "4" },
      });
      const afterAdoption = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(afterAdoption.run).toMatchObject({
        agentConfigRevision: 4,
        revision: 2,
      });
      const historicalRuns = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          snapshotEventId: pinnedRuns.snapshotEventId,
          limit: 1,
        },
        humanContext,
      );
      const historicalThreads = await kernel.query(
        {
          type: "ListThreadProjections",
          projectId: "project-sample",
          snapshotEventId: pinnedRuns.snapshotEventId,
          limit: 1,
        },
        humanContext,
      );
      expect(historicalRuns).toMatchObject({
        snapshotEventId: pinnedRuns.snapshotEventId,
        hasMore: false,
      });
      expect(historicalRuns.items[0]!.run).toMatchObject({
        id: setup.runId,
        revision: 1,
        agentConfigRevision: 3,
      });
      expect(historicalThreads).toMatchObject({
        snapshotEventId: pinnedRuns.snapshotEventId,
        hasMore: false,
      });
      expect(
        historicalThreads.items[0]!.runs.find(
          (run) => run.id === setup.runId,
        ),
      ).toMatchObject({
        revision: 1,
        agentConfigRevision: 3,
      });
      expect(
        afterAdoption.activations.find(
          (activation) => activation.id === setup.activationId,
        )?.configRevision,
      ).toBe(3);

      await kernel.execute(
        {
          type: "AcknowledgeOutboxEvents",
          idempotencyKey: "acknowledge-original-run-activation",
          outboxEventIds: [setup.outboxEventId],
          leaseToken: setup.outboxLeaseToken,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "finish-old-config-activation",
          activationId: setup.activationId,
          outcome: "Completed",
        },
        setup.agentContext,
      );
      const sent = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "future-work-after-adoption",
          runId: setup.runId,
          expectedRunRevision: 2,
          body: "Use the explicitly adopted configuration for future work.",
        },
        humanContext,
      );
      const authority = await claimRunOutboxAuthority(
        kernel,
        setup.runId,
        "future-work-after-adoption",
        sent.relatedIds!.runInputId!,
      );
      const laterActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "activation-after-adoption",
          runId: setup.runId,
          expectedRunRevision: 3,
          ...authority,
        },
        runtimeContext,
      );
      const finalProjection = await kernel.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      expect(
        finalProjection.activations.find(
          (activation) => activation.id === laterActivation.entityId,
        )?.configRevision,
      ).toBe(4);
    } finally {
      kernel.close();
    }
  });

  it("fences concurrent Agent config updates and Run adoption", async () => {
    const kernel = openMemoryKernel();
    try {
      const setup = await createRun(kernel, "-config-concurrency");
      const updates = await Promise.allSettled([
        kernel.execute(
          {
            type: "UpdateAgentConfig",
            idempotencyKey: "config-concurrent-a",
            agentId: "agent-orbit",
            expectedAgentConfigRevision: 3,
            config: { model: "synthetic-a" },
          },
          humanContext,
        ),
        kernel.execute(
          {
            type: "UpdateAgentConfig",
            idempotencyKey: "config-concurrent-b",
            agentId: "agent-orbit",
            expectedAgentConfigRevision: 3,
            config: { model: "synthetic-b" },
          },
          humanContext,
        ),
      ]);
      expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        updates.filter((result) => result.status === "rejected")[0],
      ).toMatchObject({ reason: { code: "StaleRevision" } });

      const adoptions = await Promise.allSettled([
        kernel.execute(
          {
            type: "AdoptRunConfig",
            idempotencyKey: "adopt-concurrent-a",
            runId: setup.runId,
            expectedRunRevision: 1,
            expectedAgentConfigRevision: 4,
            targetAgentConfigRevision: 4,
          },
          humanContext,
        ),
        kernel.execute(
          {
            type: "AdoptRunConfig",
            idempotencyKey: "adopt-concurrent-b",
            runId: setup.runId,
            expectedRunRevision: 1,
            expectedAgentConfigRevision: 4,
            targetAgentConfigRevision: 4,
          },
          humanContext,
        ),
      ]);
      expect(adoptions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        adoptions.filter((result) => result.status === "rejected")[0],
      ).toMatchObject({ reason: { code: "StaleRevision" } });
    } finally {
      kernel.close();
    }
  });

  it("reopens with durable Message and Agent config revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-collaboration-"));
    const databasePath = join(directory, "torsor.sqlite");
    let kernel = TorsorKernel.open({ databasePath, bootstrap });
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "restart-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Original durable body.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "EditMessage",
          idempotencyKey: "restart-edit",
          messageId: thread.entityId,
          expectedMessageRevision: 1,
          body: "Revised durable body.",
          targetAgentIds: ["agent-keel"],
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "UpdateAgentConfig",
          idempotencyKey: "restart-config",
          agentId: "agent-orbit",
          expectedAgentConfigRevision: 3,
          config: { model: "durable-synthetic" },
        },
        humanContext,
      );
      kernel.close();

      kernel = TorsorKernel.open({ databasePath, bootstrap });
      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(projection.messages[0]).toMatchObject({
        latestRevision: 2,
        targetAgentIds: ["agent-keel"],
      });
      expect(projection.messages[0]!.revisions.map((revision) => revision.body))
        .toEqual(["Original durable body.", "Revised durable body."]);
      const reopenedBootstrap = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        humanContext,
      );
      expect(
        reopenedBootstrap.agents.find((agent) => agent.id === "agent-orbit"),
      ).toMatchObject({
        configRevision: 4,
        config: { model: "durable-synthetic" },
      });
    } finally {
      kernel.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
