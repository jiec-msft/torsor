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

interface SchemaInitializationOperation {
  readonly kind: "exec" | "read";
  readonly sql: string;
}

function downgradeToSchemaVersionOne(database: DatabaseSync): void {
  removeLeaseProtocolFence(database);
  database.exec(`
    DROP TABLE attention_history;
    ALTER TABLE attentions DROP COLUMN created_event_sequence;
    PRAGMA user_version = 1;
  `);
}

function downgradeToSchemaVersionTwo(database: DatabaseSync): void {
  removeLeaseProtocolFence(database);
  database.exec("PRAGMA user_version = 2");
}

function removeLeaseProtocolFence(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER IF EXISTS outbox_lease_protocol_fence;
    DROP TRIGGER IF EXISTS outbox_ack_protocol_fence;
  `);
  const columns = database.prepare("PRAGMA table_info(outbox_events)").all() as
    ReadonlyArray<Record<string, unknown>>;
  if (
    columns.some(
      (column) => column.name === "lease_protocol_generation",
    )
  ) {
    database.exec(
      "ALTER TABLE outbox_events DROP COLUMN lease_protocol_generation",
    );
  }
}

function prepareLegacyOutboxWorker(database: DatabaseSync): {
  claim: (
    limit: number,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: string,
  ) => {
    readonly candidateIds: readonly string[];
    readonly rejected: boolean;
  };
  acknowledge: (
    eventIds: readonly string[],
    leaseToken: string,
    now: Date,
  ) => boolean;
} {
  const selectClaimable = database.prepare(
    `SELECT id
       FROM outbox_events
      WHERE acknowledged_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY sequence
      LIMIT ?`,
  );
  const leaseEvent = database.prepare(
    `UPDATE outbox_events
        SET lease_holder_principal_id = 'principal-runtime',
            lease_token = ?,
            lease_expires_at = ?,
            delivery_attempts = delivery_attempts + 1
      WHERE id = ?`,
  );
  const selectLeased = database.prepare(
    `SELECT id
       FROM outbox_events
      WHERE acknowledged_at IS NULL
        AND lease_holder_principal_id = ?
        AND lease_token = ?
      ORDER BY sequence`,
  );
  const selectEvent = database.prepare(
    `SELECT lease_holder_principal_id, lease_token, lease_expires_at
       FROM outbox_events
      WHERE id = ?`,
  );
  const acknowledgeEvent = database.prepare(
    `UPDATE outbox_events
        SET acknowledged_at = ?,
            acknowledged_by_principal_id = 'principal-runtime',
            lease_token = NULL,
            lease_expires_at = NULL
      WHERE id = ?`,
  );
  return {
    claim: (limit, leaseToken, now, leaseExpiresAt) => {
      database.exec("BEGIN IMMEDIATE");
      let candidateIds: string[] = [];
      try {
        const candidates = selectClaimable.all(
          now.toISOString(),
          limit,
        ) as ReadonlyArray<Record<string, unknown>>;
        candidateIds = candidates.map((row) => String(row.id));
        for (const eventId of candidateIds) {
          leaseEvent.run(leaseToken, leaseExpiresAt, eventId);
        }
        database.exec("COMMIT");
        return { candidateIds, rejected: false };
      } catch {
        database.exec("ROLLBACK");
        return { candidateIds, rejected: true };
      }
    },
    acknowledge: (eventIds, leaseToken, now) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const leasedRows = selectLeased.all(
          "principal-runtime",
          leaseToken,
        ) as ReadonlyArray<Record<string, unknown>>;
        const leasedIds = leasedRows.map((row) => String(row.id));
        if (
          leasedIds.length !== eventIds.length ||
          leasedIds.some((id) => !eventIds.includes(id))
        ) {
          database.exec("ROLLBACK");
          return false;
        }
        for (const eventId of eventIds) {
          const event = selectEvent.get(eventId) as
            | Record<string, unknown>
            | undefined;
          if (
            !event ||
            event.lease_holder_principal_id !== "principal-runtime" ||
            event.lease_token !== leaseToken ||
            typeof event.lease_expires_at !== "string" ||
            new Date(event.lease_expires_at) <= now
          ) {
            database.exec("ROLLBACK");
            return false;
          }
          acknowledgeEvent.run(now.toISOString(), eventId);
        }
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

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

  it("rejects a migrated noncontiguous Outbox acknowledgement atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-outbox-v1-"));
    const databasePath = join(directory, "kernel.sqlite");
    const options = {
      databasePath,
      bootstrap,
      clock: () => new Date("2026-09-21T08:00:00.000Z"),
    };
    try {
      const first = TorsorKernel.open(options);
      for (let index = 1; index <= 3; index += 1) {
        await first.execute(
          {
            type: "StartThread",
            idempotencyKey: `legacy-outbox-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Legacy Outbox event ${index}.`,
          },
          humanContext,
        );
      }
      const beforeMigration = await first.query(
        {
          type: "ListOutboxEvents",
          includeAcknowledged: true,
          limit: 10,
        },
        runtimeContext,
      );
      first.close();

      const legacyWorker = new DatabaseSync(databasePath);
      downgradeToSchemaVersionOne(legacyWorker);
      const setLease = legacyWorker.prepare(
        `UPDATE outbox_events
            SET lease_holder_principal_id = 'principal-runtime',
                lease_token = ?,
                lease_expires_at = '2026-09-21T08:01:00.000Z',
                delivery_attempts = 1
          WHERE id = ?`,
      );
      setLease.run("lease-c", beforeMigration.items[0]!.id);
      setLease.run("lease-b", beforeMigration.items[1]!.id);
      setLease.run("lease-c", beforeMigration.items[2]!.id);
      const legacy = prepareLegacyOutboxWorker(legacyWorker);

      try {
        const migrated = TorsorKernel.open(options);
        try {
          expect(
            legacy.acknowledge(
              [
                beforeMigration.items[0]!.id,
                beforeMigration.items[2]!.id,
              ],
              "lease-c",
              options.clock(),
            ),
          ).toBe(false);

          const afterRejection = await migrated.query(
            {
              type: "ListOutboxEvents",
              includeAcknowledged: true,
              limit: 10,
            },
            runtimeContext,
          );
          expect(
            afterRejection.items.map((event) => event.acknowledgedAt),
          ).toEqual([null, null, null]);
          expect(
            afterRejection.items.map(
              (event) => event.leaseHolderPrincipalId,
            ),
          ).toEqual([null, null, null]);
          expect(
            afterRejection.items.map((event) => event.deliveryAttempts),
          ).toEqual([1, 1, 1]);

          const setCurrentLease = legacyWorker.prepare(
            `UPDATE outbox_events
                SET lease_holder_principal_id = 'principal-runtime',
                    lease_token = ?,
                    lease_expires_at = '2026-09-21T08:01:00.000Z',
                    lease_protocol_generation =
                      lease_protocol_generation + 1,
                    delivery_attempts = delivery_attempts + 1
              WHERE id = ?`,
          );
          setCurrentLease.run("lease-v2-c", beforeMigration.items[0]!.id);
          setCurrentLease.run("lease-v2-b", beforeMigration.items[1]!.id);
          setCurrentLease.run("lease-v2-c", beforeMigration.items[2]!.id);
          await expect(
            migrated.execute(
              {
                type: "AcknowledgeOutboxEvents",
                idempotencyKey: "v2-noncontiguous-ack",
                outboxEventIds: [
                  beforeMigration.items[0]!.id,
                  beforeMigration.items[2]!.id,
                ],
                leaseToken: "lease-v2-c",
              },
              runtimeContext,
            ),
          ).rejects.toMatchObject({
            code: "Conflict",
            message:
              "Outbox acknowledgement must exactly advance the oldest pending prefix.",
          });
          const afterV2Rejection = await migrated.query(
            {
              type: "ListOutboxEvents",
              includeAcknowledged: true,
              limit: 10,
            },
            runtimeContext,
          );
          expect(
            afterV2Rejection.items.map((event) => event.acknowledgedAt),
          ).toEqual([null, null, null]);

          legacyWorker.exec(
            `UPDATE outbox_events
                SET lease_holder_principal_id = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL
              WHERE acknowledged_at IS NULL`,
          );
          const recovered = await migrated.execute(
            {
              type: "ClaimOutboxEvents",
              idempotencyKey: "claim-after-v1-lease-revocation",
              limit: 3,
              leaseDurationMs: 30_000,
            },
            runtimeContext,
          );
          expect(recovered.outboxEvents?.map((event) => event.id)).toEqual(
            beforeMigration.items.map((event) => event.id),
          );
          expect(
            recovered.outboxEvents?.map((event) => event.deliveryAttempts),
          ).toEqual([3, 3, 3]);
        } finally {
          migrated.close();
        }
      } finally {
        legacyWorker.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences a prepared legacy claim after migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-outbox-fence-"));
    const databasePath = join(directory, "kernel.sqlite");
    const now = new Date("2026-09-21T08:00:00.000Z");
    const options = {
      databasePath,
      bootstrap,
      clock: () => now,
    };
    try {
      const initial = TorsorKernel.open(options);
      for (let index = 1; index <= 2; index += 1) {
        await initial.execute(
          {
            type: "StartThread",
            idempotencyKey: `protocol-fence-initial-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Protocol fence event ${index}.`,
          },
          humanContext,
        );
      }
      const initialOutbox = await initial.query(
        {
          type: "ListOutboxEvents",
          includeAcknowledged: true,
          limit: 10,
        },
        runtimeContext,
      );
      initial.close();

      const legacyConnection = new DatabaseSync(databasePath);
      downgradeToSchemaVersionOne(legacyConnection);
      const legacy = prepareLegacyOutboxWorker(legacyConnection);
      try {
        const migrated = TorsorKernel.open(options);
        try {
          const firstClaim = await migrated.execute(
            {
              type: "ClaimOutboxEvents",
              idempotencyKey: "protocol-fence-v2-first",
              limit: 1,
              leaseDurationMs: 30_000,
            },
            runtimeContext,
          );
          expect(firstClaim.outboxEvents?.map((event) => event.id)).toEqual([
            initialOutbox.items[0]!.id,
          ]);
          expect(() =>
            legacy.acknowledge(
              [initialOutbox.items[0]!.id],
              firstClaim.leaseToken!,
              now,
            ),
          ).toThrow(/outbox acknowledgement protocol generation mismatch/);
          await migrated.execute(
            {
              type: "StartThread",
              idempotencyKey: "protocol-fence-post-migration",
              projectId: "project-sample",
              channelId: "channel-general",
              body: "Created after the lease protocol migration.",
            },
            humanContext,
          );
          const withPostMigrationEvent = await migrated.query(
            {
              type: "ListOutboxEvents",
              includeAcknowledged: true,
              limit: 10,
            },
            runtimeContext,
          );
          const postMigrationEvent = withPostMigrationEvent.items[2]!;

          const legacySecondClaim = legacy.claim(
            1,
            "legacy-lease-second",
            now,
            "2026-09-21T08:01:00.000Z",
          );
          expect(legacySecondClaim).toEqual({
            candidateIds: [initialOutbox.items[1]!.id],
            rejected: true,
          });
          expect(
            legacy.acknowledge(
              [initialOutbox.items[1]!.id],
              "legacy-lease-second",
              now,
            ),
          ).toBe(false);

          const afterLegacySecondClaim = await migrated.query(
            {
              type: "ListOutboxEvents",
              includeAcknowledged: true,
              limit: 10,
            },
            runtimeContext,
          );
          expect(
            afterLegacySecondClaim.items.map((event) => ({
              acknowledgedAt: event.acknowledgedAt,
              deliveryAttempts: event.deliveryAttempts,
              leaseHolderPrincipalId: event.leaseHolderPrincipalId,
            })),
          ).toEqual([
            {
              acknowledgedAt: null,
              deliveryAttempts: 1,
              leaseHolderPrincipalId: "principal-runtime",
            },
            {
              acknowledgedAt: null,
              deliveryAttempts: 0,
              leaseHolderPrincipalId: null,
            },
            {
              acknowledgedAt: null,
              deliveryAttempts: 0,
              leaseHolderPrincipalId: null,
            },
          ]);

          await migrated.execute(
            {
              type: "AcknowledgeOutboxEvents",
              idempotencyKey: "protocol-fence-v2-first-ack",
              outboxEventIds: [initialOutbox.items[0]!.id],
              leaseToken: firstClaim.leaseToken!,
            },
            runtimeContext,
          );
          const secondClaim = await migrated.execute(
            {
              type: "ClaimOutboxEvents",
              idempotencyKey: "protocol-fence-v2-second",
              limit: 1,
              leaseDurationMs: 30_000,
            },
            runtimeContext,
          );
          expect(secondClaim.outboxEvents?.map((event) => event.id)).toEqual([
            initialOutbox.items[1]!.id,
          ]);

          const legacyPostMigrationClaim = legacy.claim(
            1,
            "legacy-lease-post-migration",
            now,
            "2026-09-21T08:01:00.000Z",
          );
          expect(legacyPostMigrationClaim).toEqual({
            candidateIds: [postMigrationEvent.id],
            rejected: true,
          });
          expect(
            legacy.acknowledge(
              [postMigrationEvent.id],
              "legacy-lease-post-migration",
              now,
            ),
          ).toBe(false);
          await migrated.execute(
            {
              type: "AcknowledgeOutboxEvents",
              idempotencyKey: "protocol-fence-v2-second-ack",
              outboxEventIds: [initialOutbox.items[1]!.id],
              leaseToken: secondClaim.leaseToken!,
            },
            runtimeContext,
          );
        } finally {
          migrated.close();
        }
      } finally {
        legacyConnection.close();
      }

      const reopened = TorsorKernel.open(options);
      try {
        const recovered = await reopened.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "protocol-fence-reopen-claim",
            limit: 1,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        );
        expect(recovered.outboxEvents).toHaveLength(1);
        expect(recovered.outboxEvents![0]).toMatchObject({
          deliveryAttempts: 1,
        });
        await reopened.execute(
          {
            type: "AcknowledgeOutboxEvents",
            idempotencyKey: "protocol-fence-reopen-ack",
            outboxEventIds: [recovered.outboxEvents![0]!.id],
            leaseToken: recovered.leaseToken!,
          },
          runtimeContext,
        );
        const finalOutbox = await reopened.query(
          {
            type: "ListOutboxEvents",
            includeAcknowledged: true,
            limit: 10,
          },
          runtimeContext,
        );
        expect(
          finalOutbox.items.every((event) => event.acknowledgedAt !== null),
        ).toBe(true);
      } finally {
        reopened.close();
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

  it("migrates schema version 2 lease state to the fenced protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-v2-protocol-"));
    const databasePath = join(directory, "kernel.sqlite");
    const options = {
      databasePath,
      bootstrap,
      clock: () => new Date("2026-09-21T08:00:00.000Z"),
    };
    try {
      const initial = TorsorKernel.open(options);
      await initial.execute(
        {
          type: "StartThread",
          idempotencyKey: "v2-protocol-event",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Migrate this synthetic v2 lease.",
        },
        humanContext,
      );
      const outbox = await initial.query(
        {
          type: "ListOutboxEvents",
          includeAcknowledged: true,
          limit: 10,
        },
        runtimeContext,
      );
      initial.close();

      const versionTwo = new DatabaseSync(databasePath);
      downgradeToSchemaVersionTwo(versionTwo);
      versionTwo
        .prepare(
          `UPDATE outbox_events
              SET lease_holder_principal_id = 'principal-runtime',
                  lease_token = 'legacy-v2-token',
                  lease_expires_at = '2026-09-21T08:01:00.000Z',
                  delivery_attempts = 1
            WHERE id = ?`,
        )
        .run(outbox.items[0]!.id);
      versionTwo.close();

      const migrated = TorsorKernel.open(options);
      try {
        const afterMigration = await migrated.query(
          {
            type: "ListOutboxEvents",
            includeAcknowledged: true,
            limit: 10,
          },
          runtimeContext,
        );
        expect(afterMigration.items[0]).toMatchObject({
          acknowledgedAt: null,
          deliveryAttempts: 1,
          leaseHolderPrincipalId: null,
          leaseExpiresAt: null,
        });
        const claimed = await migrated.execute(
          {
            type: "ClaimOutboxEvents",
            idempotencyKey: "v2-protocol-reclaim",
            limit: 1,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        );
        expect(claimed.outboxEvents![0]).toMatchObject({
          id: outbox.items[0]!.id,
          deliveryAttempts: 2,
        });
        await migrated.execute(
          {
            type: "AcknowledgeOutboxEvents",
            idempotencyKey: "v2-protocol-ack",
            outboxEventIds: [outbox.items[0]!.id],
            leaseToken: claimed.leaseToken!,
          },
          runtimeContext,
        );
      } finally {
        migrated.close();
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
      downgradeToSchemaVersionOne(versionOne);
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

  it("acquires the schema write lock before reading schema state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-order-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for(
      "torsor.kernel.schema-initialization-operation",
    );
    const operations: SchemaInitializationOperation[] = [];
    try {
      Reflect.set(
        globalThis,
        hookSymbol,
        (operation: SchemaInitializationOperation) => {
          operations.push(operation);
        },
      );
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      kernel.close();

      expect(operations[0]).toEqual({
        kind: "exec",
        sql: "BEGIN IMMEDIATE",
      });
      expect(operations[1]).toEqual({
        kind: "read",
        sql: "PRAGMA user_version",
      });
      expect(operations[2]).toMatchObject({ kind: "read" });
      expect(operations[2]!.sql).toContain("sqlite_master");
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-reads schema state after another opener wins initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-init-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for(
      "torsor.kernel.schema-initialization-operation",
    );
    let competingOpenCompleted = false;
    try {
      Reflect.set(
        globalThis,
        hookSymbol,
        (operation: SchemaInitializationOperation) => {
          if (operation.kind === "exec" && operation.sql === "BEGIN IMMEDIATE") {
            Reflect.deleteProperty(globalThis, hookSymbol);
            const competing = TorsorKernel.open({ databasePath, bootstrap });
            competingOpenCompleted = true;
            competing.close();
          }
        },
      );

      const follower = TorsorKernel.open({ databasePath, bootstrap });
      try {
        expect(competingOpenCompleted).toBe(true);
        const projection = await follower.query(
          { type: "GetBootstrap", projectId: "project-sample" },
          humanContext,
        );
        expect(projection.project.id).toBe("project-sample");
      } finally {
        follower.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-reads schema version after another opener wins migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-migration-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for(
      "torsor.kernel.schema-initialization-operation",
    );
    let competingOpenCompleted = false;
    try {
      const initial = TorsorKernel.open({ databasePath, bootstrap });
      initial.close();
      const versionOne = new DatabaseSync(databasePath);
      downgradeToSchemaVersionOne(versionOne);
      versionOne.close();

      Reflect.set(
        globalThis,
        hookSymbol,
        (operation: SchemaInitializationOperation) => {
          if (operation.kind === "exec" && operation.sql === "BEGIN IMMEDIATE") {
            Reflect.deleteProperty(globalThis, hookSymbol);
            const competing = TorsorKernel.open({ databasePath, bootstrap });
            competingOpenCompleted = true;
            competing.close();
          }
        },
      );

      const follower = TorsorKernel.open({ databasePath, bootstrap });
      try {
        expect(competingOpenCompleted).toBe(true);
        const migrated = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(
            migrated.prepare("PRAGMA user_version").get(),
          ).toMatchObject({ user_version: 3 });
        } finally {
          migrated.close();
        }
      } finally {
        follower.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
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
