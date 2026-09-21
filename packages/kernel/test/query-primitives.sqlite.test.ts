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
      await first.execute(
        {
          type: "WaitRun",
          idempotencyKey: "sqlite-query-wait",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Persist a post-snapshot state.",
        },
        setup.agentContext,
      );
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
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
                  'public_events_project_sequence_idx',
                  'public_events_correlation_sequence_idx',
                  'threads_project_page_idx',
                  'threads_project_channel_page_idx',
                  'runs_project_page_idx',
                  'runs_project_channel_page_idx',
                  'attentions_project_agent_status_idx',
                  'activation_current_run_idx',
                  'activation_current_attention_idx'
                )
              ORDER BY name`,
          )
          .all()
          .map((row) => String(row.name));
        expect(indexes).toEqual([
          "activation_current_attention_idx",
          "activation_current_run_idx",
          "attentions_project_agent_status_idx",
          "public_events_correlation_sequence_idx",
          "public_events_project_sequence_idx",
          "runs_project_channel_page_idx",
          "runs_project_page_idx",
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
});
