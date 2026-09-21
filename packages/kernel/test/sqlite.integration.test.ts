import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import {
  bootstrap,
  createRun,
  humanContext,
  runtimeContext,
} from "./helpers.js";

describe("SQLite persistence", () => {
  it("recovers durable state after close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-kernel-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const created = await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "persistent-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Persist this synthetic collaboration state.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const eventsBefore = await first.readEvents(null, 100);
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const projection = await reopened.query(
          { type: "GetThreadProjection", threadRootId: created.entityId },
          humanContext,
        );
        const eventsAfter = await reopened.readEvents(null, 100);
        const cached = await reopened.execute(
          {
            type: "StartThread",
            idempotencyKey: "persistent-thread",
            projectId: "project-sample",
            channelId: "channel-general",
            body: "Persist this synthetic collaboration state.",
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );

        expect(projection.messages[0]?.revisions[0]?.body).toBe(
          "Persist this synthetic collaboration state.",
        );
        expect(eventsAfter).toEqual(eventsBefore);
        expect(cached).toEqual(created);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers expired Outbox leases in durable cursor order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-outbox-"));
    const databasePath = join(directory, "kernel.sqlite");
    let now = new Date("2026-09-21T08:00:00.000Z");
    const options = {
      databasePath,
      bootstrap,
      clock: () => now,
    };
    try {
      const first = TorsorKernel.open(options);
      const second = TorsorKernel.open(options);
      await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "outbox-first-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "First durable Outbox item.",
        },
        humanContext,
      );
      await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "outbox-second-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Second durable Outbox item.",
        },
        humanContext,
      );

      const firstClaim = await first.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "outbox-first-claim",
          limit: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      const secondClaim = await second.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "outbox-second-claim",
          limit: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      expect(firstClaim.outboxEvents).toHaveLength(1);
      expect(secondClaim.outboxEvents).toEqual([]);
      await first.execute(
        {
          type: "AcknowledgeOutboxEvents",
          idempotencyKey: "outbox-first-ack",
          outboxEventIds: [firstClaim.outboxEvents![0]!.id],
          leaseToken: firstClaim.leaseToken!,
        },
        runtimeContext,
      );
      const nextClaim = await second.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "outbox-next-claim",
          limit: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      expect(nextClaim.outboxEvents).toHaveLength(1);
      expect(nextClaim.outboxEvents![0]!.cursor).toBeGreaterThan(
        firstClaim.outboxEvents![0]!.cursor,
      );
      first.close();
      second.close();

      now = new Date("2026-09-21T08:00:02.000Z");
      const reopened = TorsorKernel.open(options);
      try {
        const recovered = await reopened.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "outbox-next-claim",
            limit: 1,
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        );
        expect(recovered.outboxEvents?.map((event) => event.id)).toEqual([
          nextClaim.outboxEvents![0]!.id,
        ]);
        expect(recovered.leaseToken).not.toBe(nextClaim.leaseToken);
        expect(recovered.outboxEvents![0]!.deliveryAttempts).toBe(2);
        await reopened.execute(
          {
            type: "AcknowledgeOutboxEvents",
            idempotencyKey: "outbox-recovery-ack",
            outboxEventIds: [recovered.outboxEvents![0]!.id],
            leaseToken: recovered.leaseToken!,
          },
          runtimeContext,
        );
        const all = await reopened.query(
          {
            type: "ListOutboxEvents",
            includeAcknowledged: true,
            limit: 10,
          },
          runtimeContext,
        );
        expect(all.items).toHaveLength(2);
        expect(all.items.every((event) => event.acknowledgedAt !== null)).toBe(
          true,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never retargets an expired Outbox idempotency key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-outbox-key-"));
    const databasePath = join(directory, "kernel.sqlite");
    let now = new Date("2026-09-21T08:00:00.000Z");
    const options = {
      databasePath,
      bootstrap,
      clock: () => now,
    };
    try {
      const workerA = TorsorKernel.open(options);
      await workerA.execute(
        {
          type: "StartThread",
          idempotencyKey: "retarget-first-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Original Outbox target.",
        },
        humanContext,
      );
      const original = await workerA.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "stable-claim-key",
          limit: 1,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      workerA.close();

      now = new Date("2026-09-21T08:00:02.000Z");
      const workerB = TorsorKernel.open(options);
      const recovered = await workerB.execute(
        {
          type: "ClaimOutboxEvents",
          idempotencyKey: "other-worker-recovery",
          limit: 1,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      await workerB.execute(
        {
          type: "AcknowledgeOutboxEvents",
          idempotencyKey: "other-worker-ack",
          outboxEventIds: recovered.outboxEvents!.map((event) => event.id),
          leaseToken: recovered.leaseToken!,
        },
        runtimeContext,
      );
      await workerB.execute(
        {
          type: "StartThread",
          idempotencyKey: "retarget-second-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "A later Outbox event must not replace the original target.",
        },
        humanContext,
      );
      workerB.close();

      const retried = TorsorKernel.open(options);
      try {
        const sameKey = await retried.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "stable-claim-key",
            limit: 1,
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        );
        expect(sameKey.outboxEvents?.map((event) => event.id)).toEqual(
          original.outboxEvents?.map((event) => event.id),
        );

        const newKey = await retried.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "new-claim-key",
            limit: 1,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        );
        expect(newKey.outboxEvents).toHaveLength(1);
        expect(newKey.outboxEvents![0]!.id).not.toBe(
          original.outboxEvents![0]!.id,
        );
      } finally {
        retried.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists stale Run activation generation across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-activation-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      const replacement = await first.execute(
        {
          type: "StartActivation",
          idempotencyKey: "replacement-run-activation",
          runId: setup.runId,
          expectedRunRevision: 1,
        },
        runtimeContext,
      );
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        await expect(
          reopened.execute(
            {
              type: "StartProviderAttempt",
              idempotencyKey: "stale-after-reopen",
              activationId: setup.activationId,
              adapter: "deterministic-fake",
              adapterVersion: "1",
              capabilitySnapshot: {},
              runInputIds: [setup.runInputId],
              requestIdempotencyKey: "stale-after-reopen",
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });
        const projection = await reopened.query(
          { type: "GetRunProjection", runId: setup.runId },
          humanContext,
        );
        expect(projection.run.activationGeneration).toBe(2);
        expect(
          projection.activations.find(
            (activation) => activation.id === setup.activationId,
          ),
        ).toMatchObject({ revocationReason: "superseded_activation" });
        expect(
          projection.activations.find(
            (activation) => activation.id === replacement.entityId,
          ),
        ).toMatchObject({ runActivationGeneration: 2 });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists Waiting revocation across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-waiting-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      await first.execute(
        {
          type: "WaitRun",
          idempotencyKey: "waiting-before-reopen",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Waiting across a process restart.",
        },
        setup.agentContext,
      );
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        await expect(
          reopened.execute(
            {
              type: "StartProviderAttempt",
              idempotencyKey: "waiting-provider-after-reopen",
              activationId: setup.activationId,
              adapter: "deterministic-fake",
              adapterVersion: "1",
              capabilitySnapshot: {},
              runInputIds: [setup.runInputId],
              requestIdempotencyKey: "waiting-provider-after-reopen",
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });
        await expect(
          reopened.execute(
            {
              type: "AppendRunActivity",
              idempotencyKey: "waiting-activity-after-reopen",
              runId: setup.runId,
              activationId: setup.activationId,
              kind: "status",
              payload: { state: "stale" },
              retentionClass: "durable",
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically reuses one Attention Activation across connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-attention-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "cross-connection-attention",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, exercise cross-connection activation contention.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await first.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items[0]!;
      const claim = await first.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "cross-connection-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const second = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const command = {
          type: "StartActivation",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        } as const;
        const left = await first.execute(
          { ...command, idempotencyKey: "cross-connection-left" },
          runtimeContext,
        );
        const right = await second.execute(
          { ...command, idempotencyKey: "cross-connection-right" },
          runtimeContext,
        );
        expect(right.entityId).toBe(left.entityId);
        expect(
          (await first.readEvents(null, 500)).filter(
            (event) =>
              event.type === "ActivationStarted" &&
              event.entityId === left.entityId,
          ),
        ).toHaveLength(1);
      } finally {
        second.close();
        first.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates complete Attention snapshot history from schema version 1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-migration-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      const events = await first.readEvents(null, 500);
      const claimEvent = events.find(
        (event) =>
          event.type === "AttentionClaimed" &&
          event.entityId === setup.attentionId,
      )!;
      const resolvedEvent = events.find(
        (event) =>
          event.type === "AttentionResolved" &&
          event.entityId === setup.attentionId,
      )!;
      first.close();

      const versionOne = new DatabaseSync(databasePath);
      versionOne.exec(`
        DROP TABLE attention_history;
        ALTER TABLE attentions DROP COLUMN created_event_sequence;
        PRAGMA user_version = 1;
      `);
      versionOne.close();

      const migrated = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const claimedSnapshot = await migrated.query(
          {
            type: "ListOpenAttentions",
            projectId: "project-sample",
            snapshotEventId: claimEvent.eventId,
            limit: 10,
          },
          runtimeContext,
        );
        expect(claimedSnapshot.items).toContainEqual(
          expect.objectContaining({
            id: setup.attentionId,
            revision: 2,
            handlerLeaseHolderPrincipalId: "principal-runtime",
          }),
        );

        const resolvedSnapshot = await migrated.query(
          {
            type: "ListOpenAttentions",
            projectId: "project-sample",
            snapshotEventId: resolvedEvent.eventId,
            limit: 10,
          },
          runtimeContext,
        );
        expect(
          resolvedSnapshot.items.some(
            (attention) => attention.id === setup.attentionId,
          ),
        ).toBe(false);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported and unversioned existing schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-"));
    const unsupportedPath = join(directory, "unsupported.sqlite");
    const unversionedPath = join(directory, "unversioned.sqlite");
    try {
      const unsupported = new DatabaseSync(unsupportedPath);
      unsupported.exec("PRAGMA user_version = 99");
      unsupported.close();
      expect(() =>
        TorsorKernel.open({ databasePath: unsupportedPath, bootstrap }),
      ).toThrow(/Unsupported kernel schema version 99/);

      const unversioned = new DatabaseSync(unversionedPath);
      unversioned.exec("CREATE TABLE legacy_state (id TEXT PRIMARY KEY)");
      unversioned.close();
      expect(() =>
        TorsorKernel.open({ databasePath: unversionedPath, bootstrap }),
      ).toThrow(/unversioned kernel schema/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
