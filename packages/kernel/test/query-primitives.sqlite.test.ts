import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import {
  bootstrap,
  createRun,
  humanContext,
  runtimeContext,
} from "./helpers.js";

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
}

interface ActivationCandidates {
  readonly activationIds: readonly string[];
}

describe("Kernel server query primitives with SQLite", () => {
  it("reopens as-of projections and ignores a stale Run generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-query-primitives-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      const snapshot = await first.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      const waitCommand = {
        type: "WaitRun",
        idempotencyKey: "sqlite-query-wait",
        runId: setup.runId,
        expectedRunRevision: 1,
        reason: "Persist a post-snapshot state.",
      } as const;
      await first.execute(
        waitCommand,
        setup.agentContext,
      );
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      const historyBeforeRetry = new DatabaseSync(
        databasePath,
        { readOnly: true },
      );
      const versionCountBeforeRetry = Number(
        historyBeforeRetry.prepare(
          "SELECT COUNT(*) AS count FROM run_history WHERE run_id = ?",
        ).get(setup.runId)!.count,
      );
      historyBeforeRetry.close();
      await reopened.execute(waitCommand, setup.agentContext);
      const historyAfterRetry = new DatabaseSync(
        databasePath,
        { readOnly: true },
      );
      const versionCountAfterRetry = Number(
        historyAfterRetry.prepare(
          "SELECT COUNT(*) AS count FROM run_history WHERE run_id = ?",
        ).get(setup.runId)!.count,
      );
      historyAfterRetry.close();
      expect(versionCountAfterRetry).toBe(versionCountBeforeRetry);
      const historical = await reopened.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          snapshotEventId: snapshot.snapshotEventId,
          limit: 10,
        },
        humanContext,
      );
      const current = await reopened.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      expect(historical.items[0]?.run.state).toBe("Active");
      expect(current.items[0]?.run.state).toBe("Waiting");

      const resumed = await reopened.execute(
        {
          type: "StartActivation",
          idempotencyKey: "sqlite-query-resume",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
        runtimeContext,
      );
      const currentGeneration = await reopened.execute(
        {
          type: "StartActivation",
          idempotencyKey: "sqlite-query-new-generation",
          runId: setup.runId,
          expectedRunRevision: 3,
        },
        runtimeContext,
      );
      reopened.close();

      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(
          `UPDATE activation_attempts
              SET revoked_at = NULL,
                  revocation_reason = NULL
            WHERE id = ?`,
        ).run(resumed.entityId);
      } finally {
        database.close();
      }

      const statusKernel = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const status = await statusKernel.query(
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
          liveActivationCount: 1,
          nonterminalRunCount: 1,
          status: "active",
        });
        expect(currentGeneration.entityId).not.toBe(resumed.entityId);
      } finally {
        statusKernel.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one indexed bounded scan for authorized public events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-event-plan-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for(
      "torsor.kernel.authorized-public-event-query",
    );
    const pageHookSymbol = Symbol.for(
      "torsor.kernel.projection-page-query",
    );
    const materializationHookSymbol = Symbol.for(
      "torsor.kernel.projection-materialization-query",
    );
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const materializationQueries: RecordedQuery[] = [];
      Reflect.set(
        globalThis,
        materializationHookSymbol,
        (query: RecordedQuery) => {
          materializationQueries.push(query);
        },
      );
      try {
        await createRun(kernel);
      } finally {
        Reflect.deleteProperty(globalThis, materializationHookSymbol);
      }
      const pageQueries: RecordedQuery[] = [];
      Reflect.set(globalThis, pageHookSymbol, (query: RecordedQuery) => {
        pageQueries.push(query);
      });
      try {
        await kernel.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
            limit: 5,
          },
          humanContext,
        );
        await kernel.query(
          {
            type: "ListRunProjections",
            projectId: "project-sample",
            limit: 5,
          },
          humanContext,
        );
      } finally {
        Reflect.deleteProperty(globalThis, pageHookSymbol);
      }
      const recorded: RecordedQuery[] = [];
      Reflect.set(globalThis, hookSymbol, (query: RecordedQuery) => {
        recorded.push(query);
      });
      try {
        const page = await kernel.query(
          {
            type: "ReadPublicEvents",
            projectId: "project-sample",
            limit: 5,
          },
          humanContext,
        );
        expect(page.events.length).toBeLessThanOrEqual(5);
      } finally {
        Reflect.deleteProperty(globalThis, hookSymbol);
      }
      expect(recorded).toHaveLength(1);
      expect(pageQueries).toHaveLength(2);
      expect(materializationQueries.length).toBeGreaterThan(0);

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const query = recorded[0]!;
        const plan = database
          .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...query.parameters)
          .map((row) => String(row.detail));
        expect(
          plan.some(
            (detail) =>
              detail.includes("public_events_project_sequence_idx") &&
              /\bSEARCH\s+public_events\b/i.test(detail),
          ),
        ).toBe(true);
        expect(
          plan.some((detail) => /\bSCAN\s+public_events\b/i.test(detail)),
        ).toBe(false);

        for (const pageQuery of pageQueries) {
          const pagePlan = database
            .prepare(`EXPLAIN QUERY PLAN ${pageQuery.sql}`)
            .all(...pageQuery.parameters)
            .map((row) => String(row.detail));
          expect(
            pagePlan.some((detail) =>
              detail.includes("threads_project_page_idx") ||
              detail.includes("runs_project_page_idx")
            ),
          ).toBe(true);
          expect(
            pagePlan.some((detail) =>
              detail.includes("USE TEMP B-TREE FOR ORDER BY")
            ),
          ).toBe(false);
        }

        const messagePlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT message.*
               FROM messages AS message INDEXED BY messages_thread_idx
              WHERE message.thread_root_id = ?
                AND message.created_event_sequence <= ?
              ORDER BY message.thread_sequence`,
          )
          .all("message-does-not-exist", Number.MAX_SAFE_INTEGER)
          .map((row) => String(row.detail));
        expect(
          messagePlan.some((detail) =>
            detail.includes("messages_thread_idx")
          ),
        ).toBe(true);
        expect(
          messagePlan.some((detail) =>
            detail.includes("USE TEMP B-TREE FOR ORDER BY")
          ),
        ).toBe(false);
        const unmarkedInputPlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             UPDATE run_inputs INDEXED BY run_inputs_unmarked_idx
                SET created_event_sequence = COALESCE(created_event_sequence, ?)
              WHERE run_id = ? AND created_event_sequence IS NULL`,
          )
          .all(1, "run-does-not-exist")
          .map((row) => String(row.detail));
        expect(
          unmarkedInputPlan.some((detail) =>
            detail.includes("run_inputs_unmarked_idx")
          ),
        ).toBe(true);
        const unmarkedActivityPlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             UPDATE run_activity_events INDEXED BY run_activity_unmarked_idx
                SET created_event_sequence = COALESCE(created_event_sequence, ?)
              WHERE run_id = ? AND created_event_sequence IS NULL`,
          )
          .all(1, "run-does-not-exist")
          .map((row) => String(row.detail));
        expect(
          unmarkedActivityPlan.some((detail) =>
            detail.includes("run_activity_unmarked_idx")
          ),
        ).toBe(true);

        for (const materializationQuery of materializationQueries) {
          const materializationPlan = database
            .prepare(`EXPLAIN QUERY PLAN ${materializationQuery.sql}`)
            .all(...materializationQuery.parameters)
            .map((row) => String(row.detail));
          expect(
            materializationPlan.some((detail) =>
              detail.includes("public_events_correlation_sequence_idx")
            ),
          ).toBe(true);
          expect(
            materializationPlan.some(
              (detail) =>
                /\bSCAN\s+(?:public_events|event)\b/i.test(detail) &&
                !detail.includes("USING INDEX"),
            ),
          ).toBe(false);
        }

        const correlation = database
          .prepare(
            `SELECT correlation_id
               FROM public_events
              ORDER BY sequence
              LIMIT 1`,
          )
          .get();
        const boundaryPlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT sequence, event_id
               FROM public_events
              WHERE correlation_id = ?
              ORDER BY sequence DESC
              LIMIT 1`,
          )
          .all(String(correlation!.correlation_id))
          .map((row) => String(row.detail));
        expect(
          boundaryPlan.some((detail) =>
            detail.includes("public_events_correlation_sequence_idx")
          ),
        ).toBe(true);

        const indexes = database
          .prepare(
            `SELECT name
               FROM sqlite_master
              WHERE type = 'index'
                AND name IN (
                  'agents_project_name_idx',
                  'public_events_project_sequence_idx',
                  'public_events_correlation_sequence_idx',
                  'public_events_project_correlation_sequence_idx',
                  'threads_project_page_idx',
                  'threads_project_channel_page_idx',
                  'runs_project_page_idx',
                  'runs_project_channel_page_idx',
                  'runs_project_state_agent_idx',
                  'attentions_project_agent_status_idx',
                  'activation_live_run_expiry_idx',
                  'activation_live_run_agent_expiry_idx',
                  'activation_live_attention_expiry_idx',
                  'activation_live_attention_agent_expiry_idx'
                )
              ORDER BY name`,
          )
          .all()
          .map((row) => String(row.name));
        expect(indexes).toEqual([
          "activation_live_attention_agent_expiry_idx",
          "activation_live_attention_expiry_idx",
          "activation_live_run_agent_expiry_idx",
          "activation_live_run_expiry_idx",
          "agents_project_name_idx",
          "attentions_project_agent_status_idx",
          "public_events_correlation_sequence_idx",
          "public_events_project_correlation_sequence_idx",
          "public_events_project_sequence_idx",
          "runs_project_channel_page_idx",
          "runs_project_page_idx",
          "runs_project_state_agent_idx",
          "threads_project_channel_page_idx",
          "threads_project_page_idx",
        ]);
      } finally {
        database.close();
        kernel.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
      Reflect.deleteProperty(globalThis, pageHookSymbol);
      Reflect.deleteProperty(globalThis, materializationHookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps cursor validation Project-scoped across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-project-cursors-"));
    const databasePath = join(directory, "kernel.sqlite");
    const extendedBootstrap = {
      principals: bootstrap.principals ?? [],
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
      agents: bootstrap.agents ?? [],
    } as const;
    try {
      const first = TorsorKernel.open({
        databasePath,
        bootstrap: extendedBootstrap,
      });
      await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "reopen-cursor-sample",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Sample Project event.",
        },
        humanContext,
      );
      await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "reopen-cursor-other",
          projectId: "project-other",
          channelId: "channel-other",
          body: "Newer foreign Project event.",
        },
        humanContext,
      );
      const foreign = await first.query(
        {
          type: "ListThreadProjections",
          projectId: "project-other",
        },
        humanContext,
      );
      first.close();

      const reopened = TorsorKernel.open({
        databasePath,
        bootstrap: extendedBootstrap,
      });
      try {
        const sample = await reopened.query(
          {
            type: "ListThreadProjections",
            projectId: "project-sample",
          },
          humanContext,
        );
        expect(sample.snapshotEventId).not.toBe(foreign.snapshotEventId);
        await expect(
          reopened.query(
            {
              type: "ReadPublicEvents",
              projectId: "project-sample",
              afterEventId: foreign.snapshotEventId,
            },
            humanContext,
          ),
        ).rejects.toMatchObject({
          code: "NotFound",
          message: "Event cursor does not exist in the requested Project.",
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps equal Thread growth batches approximately linear", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-linear-history-"));
    const databasePath = join(directory, "kernel.sqlite");
    const payload = "x".repeat(2_048);
    const measure = (): number => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const pageCount = Number(
          database.prepare("PRAGMA page_count").get()!.page_count,
        );
        const pageSize = Number(
          database.prepare("PRAGMA page_size").get()!.page_size,
        );
        return pageCount * pageSize;
      } finally {
        database.close();
      }
    };
    const appendReplies = async (
      kernel: TorsorKernel,
      threadRootId: string,
      start: number,
      count: number,
    ): Promise<void> => {
      for (let index = start; index < start + count; index += 1) {
        await kernel.execute(
          {
            type: "ReplyToThread",
            idempotencyKey: `linear-reply-${index}`,
            threadRootId,
            body: `${index}:${payload}`,
          },
          humanContext,
        );
      }
    };
    try {
      let kernel = TorsorKernel.open({ databasePath, bootstrap });
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "linear-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Linear storage root.",
        },
        humanContext,
      );
      kernel.close();
      const baseline = measure();

      kernel = TorsorKernel.open({ databasePath, bootstrap });
      await appendReplies(kernel, thread.entityId, 0, 500);
      kernel.close();
      const firstBatchSize = measure();

      kernel = TorsorKernel.open({ databasePath, bootstrap });
      await appendReplies(kernel, thread.entityId, 500, 500);
      kernel.close();
      const secondBatchSize = measure();

      const firstGrowth = firstBatchSize - baseline;
      const secondGrowth = secondBatchSize - firstBatchSize;
      expect(firstGrowth).toBeGreaterThan(0);
      expect(secondGrowth).toBeLessThan(firstGrowth * 1.5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses sparse current-state plans for Agent status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-status-plan-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for("torsor.kernel.agent-status-query");
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      await createRun(kernel);
      kernel.close();

      const database = new DatabaseSync(databasePath);
      try {
        const revision = database
          .prepare(
            `SELECT id
               FROM message_revisions
              ORDER BY created_at, id
              LIMIT 1`,
          )
          .get()!;
        database.exec("BEGIN IMMEDIATE");
        database.prepare(
          `WITH RECURSIVE seed(value) AS (
             VALUES(1)
             UNION ALL
             SELECT value + 1 FROM seed WHERE value < 100000
           )
           INSERT INTO runs
             (id, project_id, home_channel_id, thread_root_id, owner_agent_id,
              agent_config_revision, state, revision, activation_generation,
              next_input_sequence, next_activity_sequence, created_at,
              updated_at, terminal_reason)
           SELECT 'historical-run-' || value, 'project-sample',
                  'channel-general', 'historical-thread', 'agent-orbit',
                  3, 'Completed', 1, 0, 1, 1,
                  '2026-01-01T00:00:00.000Z',
                  '2026-01-01T00:00:00.000Z', 'settled'
             FROM seed`,
        ).run();
        database.prepare(
          `WITH RECURSIVE seed(value) AS (
             VALUES(1)
             UNION ALL
             SELECT value + 1 FROM seed WHERE value < 100000
           )
           INSERT INTO attentions
             (id, project_id, channel_id, thread_root_id,
              message_revision_id, target_agent_id, trigger_kind,
              status, revision, created_at, resolved_at)
           SELECT 'historical-attention-' || value, 'project-sample',
                  'channel-general', 'historical-thread', ?,
                  'agent-orbit', 'historical-' || value,
                  'Resolved', 2, '2026-01-01T00:00:00.000Z',
                  '2026-01-01T00:00:01.000Z'
             FROM seed`,
        ).run(String(revision.id));
        database.exec("COMMIT; ANALYZE");
      } finally {
        database.close();
      }

      const statusKernel = TorsorKernel.open({ databasePath, bootstrap });
      const recorded: RecordedQuery[] = [];
      Reflect.set(globalThis, hookSymbol, (query: RecordedQuery) => {
        recorded.push(query);
      });
      try {
        await statusKernel.query(
          {
            type: "GetProjectAgentStatus",
            projectId: "project-sample",
          },
          humanContext,
        );
        await statusKernel.query(
          {
            type: "GetProjectAgentStatus",
            projectId: "project-sample",
            agentId: "agent-orbit",
          },
          humanContext,
        );
      } finally {
        Reflect.deleteProperty(globalThis, hookSymbol);
        statusKernel.close();
      }
      expect(recorded).toHaveLength(6);
      for (const activationQuery of [recorded[2]!, recorded[5]!]) {
        expect(activationQuery.sql).toContain("run.state = 'Active'");
        expect(activationQuery.sql).toContain(
          "activation.run_activation_generation = run.activation_generation",
        );
        expect(activationQuery.sql).toContain(
          "activation.agent_id = run.owner_agent_id",
        );
        expect(activationQuery.sql).toContain("attention.status = 'Open'");
        expect(activationQuery.sql).toContain(
          "attention.handler_lease_token = activation.attention_lease_token",
        );
        expect(activationQuery.sql).toContain(
          "attention.handler_lease_expires_at > ?",
        );
      }

      const planDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        for (const [index, query] of recorded.slice(1).entries()) {
          const plan = planDatabase
            .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.parameters)
            .map((row) => String(row.detail));
          expect(
            plan.some((detail) =>
              /\bSCAN\s+(?:runs?|attentions?)\b/i.test(detail)
            ),
          ).toBe(false);
          if (index === 1 || index === 4) {
            expect(
              plan.some(
                (detail) =>
                  /\bSEARCH\s+activation\b/i.test(detail) &&
                  detail.includes("activation_live_"),
              ),
            ).toBe(true);
          }
        }
        const projectRunPlan = planDatabase
          .prepare(`EXPLAIN QUERY PLAN ${recorded[1]!.sql}`)
          .all(...recorded[1]!.parameters)
          .map((row) => String(row.detail));
        expect(
          projectRunPlan.some((detail) =>
            detail.includes("runs_project_state_agent_idx")
          ),
        ).toBe(true);
        const agentRunPlan = planDatabase
          .prepare(`EXPLAIN QUERY PLAN ${recorded[4]!.sql}`)
          .all(...recorded[4]!.parameters)
          .map((row) => String(row.detail));
        expect(
          agentRunPlan.some((detail) =>
            detail.includes("runs_project_agent_state_idx")
          ),
        ).toBe(true);
      } finally {
        planDatabase.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("versions only changed Activations during repeated supersession", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-activation-history-"));
    const databasePath = join(directory, "kernel.sqlite");
    const hookSymbol = Symbol.for(
      "torsor.kernel.activation-version-candidates",
    );
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(kernel);
      const candidates: ActivationCandidates[] = [];
      Reflect.set(globalThis, hookSymbol, (value: ActivationCandidates) => {
        candidates.push(value);
      });
      try {
        for (let index = 0; index < 200; index += 1) {
          await kernel.execute(
            {
              type: "StartActivation",
              idempotencyKey: `activation-linear-${index}`,
              runId: setup.runId,
              expectedRunRevision: 1,
            },
            runtimeContext,
          );
        }
      } finally {
        Reflect.deleteProperty(globalThis, hookSymbol);
        kernel.close();
      }
      expect(candidates).toHaveLength(200);
      expect(
        candidates.every((candidate) => candidate.activationIds.length <= 2),
      ).toBe(true);

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const activationCount = Number(
          database.prepare(
            "SELECT COUNT(*) AS count FROM activation_attempts WHERE run_id = ?",
          ).get(setup.runId)!.count,
        );
        const versionCount = Number(
          database.prepare(
            `SELECT COUNT(*) AS count
               FROM activation_history AS history
               JOIN activation_attempts AS activation
                 ON activation.id = history.activation_id
              WHERE activation.run_id = ?`,
          ).get(setup.runId)!.count,
        );
        expect(activationCount).toBe(201);
        expect(versionCount).toBeLessThanOrEqual(activationCount * 2);
      } finally {
        database.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, hookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
