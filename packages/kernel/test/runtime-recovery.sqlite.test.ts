import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  type CommandResult,
  type KernelCommand,
  type PrincipalContext,
  TorsorKernel,
} from "../src/index.js";
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

function expectIndexedRecoverablePlan(planDetails: readonly string[]): void {
  expect(
    planDetails.some(
      (detail) =>
        /\bSEARCH\s+expired\b/i.test(detail) &&
        detail.includes("activation_attention_expired_idx") &&
        detail.includes("expires_at"),
    ),
  ).toBe(true);
  expect(
    planDetails.some(
      (detail) =>
        /\bSEARCH\s+unsettled\b/i.test(detail) &&
        detail.includes("provider_attempts_unsettled_activation_idx") &&
        detail.includes("status"),
    ),
  ).toBe(true);
  expect(
    planDetails.some(
      (detail) =>
        /\bSEARCH\s+activation\b/i.test(detail) &&
        /\bid\s*=\s*\?/i.test(detail),
    ),
  ).toBe(true);
  expect(
    planDetails.some((detail) => /\bCORRELATED\b/i.test(detail)),
  ).toBe(false);
  expect(
    planDetails.some(
      (detail) => /\bSCAN\s+(?:expired|activation)\b/i.test(detail),
    ),
  ).toBe(false);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function commandHash(command: unknown): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

async function failRunProvider(
  kernel: TorsorKernel,
  setup: Awaited<ReturnType<typeof createRun>>,
  key: string,
) {
  const attempt = await kernel.execute(
    {
      type: "StartProviderAttempt",
      idempotencyKey: `${key}-provider`,
      activationId: setup.activationId,
      adapter: "deterministic-fake",
      adapterVersion: "1",
      capabilitySnapshot: {},
      runInputIds: [setup.runInputId],
      requestIdempotencyKey: `${key}-request`,
    },
    runtimeContext,
  );
  await kernel.execute(
    {
      type: "FailProviderAttempt",
      idempotencyKey: `${key}-failed`,
      providerAttemptId: attempt.entityId,
      error: "Synthetic provider failure.",
    },
    runtimeContext,
  );
  return attempt;
}

async function crashCommandBeforeCommit(
  databasePath: string,
  command: KernelCommand,
  principalContext: PrincipalContext,
): Promise<number> {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.moduleUrl)
        .then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({
            databasePath: workerData.databasePath,
            bootstrap: workerData.bootstrap,
          });
          globalThis[Symbol.for("torsor.kernel.command-before-commit")] = (
            operation,
          ) => {
            if (operation.commandType === workerData.command.type) {
              parentPort.postMessage({ type: "crashing" });
              process.exit(73);
            }
          };
          await kernel.execute(workerData.command, workerData.principalContext);
          process.exit(74);
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message:
              error instanceof Error
                ? error.stack ?? error.message
                : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        command,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        principalContext,
      },
    },
  );
  let resolveCrash!: () => void;
  let rejectCrash!: (error: Error) => void;
  const crashing = new Promise<void>((resolve, reject) => {
    resolveCrash = resolve;
    rejectCrash = reject;
  });
  worker.on(
    "message",
    (message: { readonly type: string; readonly message?: string }) => {
      if (message.type === "crashing") {
        resolveCrash();
      } else if (message.type === "error") {
        rejectCrash(new Error(message.message ?? "Crash worker failed."));
      }
    },
  );
  worker.on("error", rejectCrash);
  await crashing;
  return new Promise<number>((resolve, reject) => {
    worker.on("exit", resolve);
    worker.on("error", reject);
  });
}

type RacingOutcome =
  | { readonly status: "fulfilled"; readonly result: CommandResult }
  | {
    readonly status: "rejected";
    readonly code: string | null;
    readonly message: string;
  };

function prepareRacingCommand(
  databasePath: string,
  signal: SharedArrayBuffer,
  command: KernelCommand,
  principalContext: PrincipalContext,
): {
  readonly ready: Promise<void>;
  readonly result: Promise<RacingOutcome>;
  readonly worker: Worker;
} {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const startSignal = new Int32Array(workerData.signal);
      import(workerData.moduleUrl)
        .then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({
            databasePath: workerData.databasePath,
            bootstrap: workerData.bootstrap,
          });
          parentPort.postMessage({ type: "ready" });
          if (Atomics.wait(startSignal, 0, 0, 5000) === "timed-out") {
            throw new Error("Timed out waiting to start the racing command.");
          }
          try {
            const result = await kernel.execute(
              workerData.command,
              workerData.principalContext,
            );
            parentPort.postMessage({
              type: "outcome",
              outcome: { status: "fulfilled", result },
            });
          } catch (error) {
            parentPort.postMessage({
              type: "outcome",
              outcome: {
                status: "rejected",
                code:
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error
                    ? error.code
                    : null,
                message:
                  error instanceof Error ? error.message : String(error),
              },
            });
          } finally {
            kernel.close();
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message:
              error instanceof Error
                ? error.stack ?? error.message
                : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        command,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        principalContext,
        signal,
      },
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (outcome: RacingOutcome) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<RacingOutcome>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on(
    "message",
    (message: {
      readonly type: string;
      readonly message?: string;
      readonly outcome?: RacingOutcome;
    }) => {
      if (message.type === "ready") {
        resolveReady();
      } else if (message.type === "outcome" && message.outcome) {
        resolveResult(message.outcome);
      } else if (message.type === "error") {
        const error = new Error(message.message ?? "Racing worker failed.");
        rejectReady(error);
        rejectResult(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  return { ready, result, worker };
}

async function createFinishedAttentionAttempt(
  kernel: TorsorKernel,
): Promise<{ readonly activationId: string; readonly attemptId: string }> {
  await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: "history-independent-message",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Orbit, recover this synthetic Attention execution.",
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
      idempotencyKey: "history-independent-claim",
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 30_000,
    },
    runtimeContext,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: "history-independent-activation",
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    runtimeContext,
  );
  const attempt = await kernel.execute(
    {
      type: "StartProviderAttempt",
      idempotencyKey: "history-independent-provider",
      activationId: activation.entityId,
      adapter: "deterministic-fake",
      adapterVersion: "1",
      capabilitySnapshot: {},
      runInputIds: [],
      requestIdempotencyKey: "history-independent-request",
    },
    runtimeContext,
  );
  await kernel.execute(
    {
      type: "FinishActivation",
      idempotencyKey: "history-independent-finish",
      activationId: activation.entityId,
      outcome: "Expired",
    },
    runtimeContext,
  );
  return { activationId: activation.entityId, attemptId: attempt.entityId };
}

describe("Runtime recovery with SQLite", () => {
  it("rolls back a pre-commit crash and persists the committed Waiting state across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-runtime-crash-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      const attempt = await failRunProvider(first, setup, "crash-boundary");
      const command = {
        type: "ParkRunAfterProviderAttemptFailure",
        idempotencyKey: "crash-boundary-park",
        runId: setup.runId,
        providerAttemptId: attempt.entityId,
        expectedRunRevision: 1,
        expectedActivationGeneration: 1,
        reason: "Park after a crashed provider delivery.",
      } as const;
      first.close();

      expect(
        await crashCommandBeforeCommit(
          databasePath,
          command,
          runtimeContext,
        ),
      ).toBe(73);

      const afterCrash = TorsorKernel.open({ databasePath, bootstrap });
      const beforeCommit = await afterCrash.query(
        { type: "GetRunProjection", runId: setup.runId },
        humanContext,
      );
      const retryableOutbox = await afterCrash.query(
        { type: "ListOutboxEvents", limit: 500 },
        runtimeContext,
      );
      expect(beforeCommit.run).toMatchObject({ state: "Active", revision: 1 });
      expect(beforeCommit.activity.items).toEqual([]);
      expect(
        retryableOutbox.items.some(
          (event) =>
            event.topic === "run.activation-requested" &&
            event.aggregateId === setup.runId,
        ),
      ).toBe(true);
      await afterCrash.execute(command, runtimeContext);
      afterCrash.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const committed = await reopened.query(
          { type: "GetRunProjection", runId: setup.runId },
          humanContext,
        );
        expect(committed.run).toMatchObject({
          state: "Waiting",
          revision: 2,
        });
        expect(committed.inputs[0]).toMatchObject({
          id: setup.runInputId,
          disposition: "Pending",
        });
        expect(committed.activity.items).toEqual([
          expect.objectContaining({
            kind: "provider_attempt_failure_parked",
            providerAttemptId: attempt.entityId,
          }),
        ]);
        expect(await reopened.execute(command, runtimeContext)).toMatchObject({
          commandType: command.type,
          entityId: setup.runId,
          revision: 2,
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves terminal and parking races with one revision-fenced winner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-runtime-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    let parkWorker: Worker | undefined;
    let cancelWorker: Worker | undefined;
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(kernel);
      const attempt = await failRunProvider(kernel, setup, "terminal-race");
      kernel.close();

      const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const startSignal = new Int32Array(signal);
      const park = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "ParkRunAfterProviderAttemptFailure",
          idempotencyKey: "terminal-race-park",
          runId: setup.runId,
          providerAttemptId: attempt.entityId,
          expectedRunRevision: 1,
          expectedActivationGeneration: 1,
          reason: "Park after provider failure.",
        },
        runtimeContext,
      );
      const cancel = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "CancelRun",
          idempotencyKey: "terminal-race-cancel",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Human cancellation wins if committed first.",
        },
        humanContext,
      );
      parkWorker = park.worker;
      cancelWorker = cancel.worker;
      await Promise.all([park.ready, cancel.ready]);
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0, 2);
      const outcomes = await Promise.all([park.result, cancel.result]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toEqual([
        expect.objectContaining({
          status: "rejected",
          code: "StaleRevision",
        }),
      ]);

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const projection = await reopened.query(
          { type: "GetRunProjection", runId: setup.runId },
          humanContext,
        );
        expect(projection.run.revision).toBe(2);
        expect(["Waiting", "Cancelled"]).toContain(projection.run.state);
        if (projection.run.state === "Waiting") {
          expect(projection.inputs[0]?.disposition).toBe("Pending");
          expect(projection.activity.items).toEqual([
            expect.objectContaining({
              kind: "provider_attempt_failure_parked",
            }),
          ]);
        } else {
          expect(projection.inputs[0]?.disposition).toBe("Abandoned");
          expect(projection.activity.items).toEqual([]);
        }
      } finally {
        reopened.close();
      }
    } finally {
      if (parkWorker) {
        await parkWorker.terminate();
      }
      if (cancelWorker) {
        await cancelWorker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("searches sparse recovery indexes instead of settled Activation history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-runtime-query-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const execution = await createFinishedAttentionAttempt(first);
      first.close();

      const historyDatabase = new DatabaseSync(databasePath);
      try {
        const source = historyDatabase.prepare(
          `SELECT attention_id
             FROM activation_attempts
            WHERE id = ?`,
        ).get(execution.activationId) as
          | { readonly attention_id: string }
          | undefined;
        if (!source) {
          throw new Error("Expected the recoverable Activation.");
        }
        const insertHistory = historyDatabase.prepare(
          `INSERT INTO activation_attempts
            (id, agent_id, attention_id, attention_lease_token, cause,
             config_revision, started_at, expires_at, finished_at, outcome)
           VALUES (?, 'agent-orbit', ?, ?, 'Attention', 3, ?, ?, ?, 'Completed')`,
        );
        historyDatabase.exec("BEGIN");
        for (let index = 0; index < 10_000; index += 1) {
          const suffix = index.toString().padStart(5, "0");
          const timestamp = new Date(
            Date.UTC(2025, 0, 1, 0, 0, index),
          ).toISOString();
          insertHistory.run(
            `activation-history-${suffix}`,
            source.attention_id,
            `lease-history-${suffix}`,
            timestamp,
            timestamp,
            timestamp,
          );
        }
        historyDatabase.prepare(
          `INSERT INTO activation_attempts
            (id, agent_id, attention_id, attention_lease_token, cause,
             config_revision, started_at, expires_at)
           VALUES (
             'activation-expired-recoverable',
             'agent-orbit',
             ?,
             'lease-expired-recoverable',
             'Attention',
             3,
             '2026-09-21T07:59:00.000Z',
             '2026-09-21T07:59:30.000Z'
           )`,
        ).run(source.attention_id);
        historyDatabase.exec("COMMIT");
        historyDatabase.prepare(
          `DELETE FROM thread_projection_history
            WHERE event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type IN ('ActivationAttempt', 'ProviderAttempt')
            )`,
        ).run();
        historyDatabase.prepare(
          `DELETE FROM run_projection_history
            WHERE event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type IN ('ActivationAttempt', 'ProviderAttempt')
            )`,
        ).run();
        historyDatabase.prepare(
          `DELETE FROM public_events
            WHERE entity_type IN ('ActivationAttempt', 'ProviderAttempt')`,
        ).run();
        historyDatabase.exec("ANALYZE");
      } finally {
        historyDatabase.close();
      }

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      const recordedQueries: RecordedQuery[] = [];
      const queryHookSymbol = Symbol.for(
        "torsor.kernel.recoverable-attention-query",
      );
      Reflect.set(
        globalThis,
        queryHookSymbol,
        (query: RecordedQuery) => {
          recordedQueries.push(query);
        },
      );
      try {
        const initialPage = await reopened.query(
          { type: "ListRecoverableAttentionExecutions", limit: 1 },
          runtimeContext,
        );
        expect(initialPage.items.map((item) => item.activation.id)).toEqual([
          "activation-expired-recoverable",
        ]);
        expect(initialPage.hasMore).toBe(true);
        const continuationPage = await reopened.query(
          {
            type: "ListRecoverableAttentionExecutions",
            afterCursor: initialPage.nextCursor!,
            limit: 1,
          },
          runtimeContext,
        );
        expect(
          continuationPage.items.map((item) => item.activation.id),
        ).toEqual([execution.activationId]);
        expect(continuationPage.hasMore).toBe(false);
      } finally {
        Reflect.deleteProperty(globalThis, queryHookSymbol);
      }
      expect(
        await reopened.query(
          {
            type: "GetProviderAttempt",
            providerAttemptId: execution.attemptId,
          },
          runtimeContext,
        ),
      ).toMatchObject({
        id: execution.attemptId,
        activationId: execution.activationId,
        status: "Started",
      });
      reopened.close();
      expect(recordedQueries).toHaveLength(2);

      const database = new DatabaseSync(databasePath);
      const recordedPlans: string[][] = [];
      try {
        const indexes = database.prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'activation_attention_expired_idx',
                'provider_attempts_unsettled_activation_idx'
              )
            ORDER BY name`,
        ).all() as Array<{ readonly name: string }>;
        expect(indexes.map((row) => row.name)).toEqual([
          "activation_attention_expired_idx",
          "provider_attempts_unsettled_activation_idx",
        ]);
        for (const recordedQuery of recordedQueries) {
          const queryPlan = database.prepare(
            `EXPLAIN QUERY PLAN ${recordedQuery.sql}`,
          ).all(...recordedQuery.parameters) as Array<{
            readonly detail: string;
          }>;
          recordedPlans.push(queryPlan.map((row) => row.detail));
        }
        database.prepare(
          `UPDATE activation_attempts
              SET finished_at = '2026-09-21T08:02:00.000Z',
                  outcome = 'Expired'
            WHERE id = 'activation-expired-recoverable'`,
        ).run();
        database.prepare(
          `UPDATE provider_attempts
              SET status = 'Unknown',
                  detail = 'Synthetic recovery reconciliation.',
                  finished_at = '2026-09-21T08:02:00.000Z'
            WHERE id = ?`,
        ).run(execution.attemptId);
        database.exec("ANALYZE");
      } finally {
        database.close();
      }

      const settled = TorsorKernel.open({ databasePath, bootstrap });
      Reflect.set(
        globalThis,
        queryHookSymbol,
        (query: RecordedQuery) => {
          recordedQueries.push(query);
        },
      );
      try {
        const page = await settled.query(
          { type: "ListRecoverableAttentionExecutions", limit: 10 },
          runtimeContext,
        );
        expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
      } finally {
        Reflect.deleteProperty(globalThis, queryHookSymbol);
        settled.close();
      }
      expect(recordedQueries).toHaveLength(3);

      const settledDatabase = new DatabaseSync(databasePath);
      try {
        const noRowsQuery = recordedQueries[2]!;
        const noRowsPlan = settledDatabase.prepare(
          `EXPLAIN QUERY PLAN ${noRowsQuery.sql}`,
        ).all(...noRowsQuery.parameters) as Array<{
          readonly detail: string;
        }>;
        recordedPlans.push(noRowsPlan.map((row) => row.detail));
      } finally {
        settledDatabase.close();
      }
      for (const planDetails of recordedPlans) {
        expectIndexedRecoverablePlan(planDetails);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks Runtime authority before returning a forged cached parking result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-runtime-auth-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(first);
      const attempt = await failRunProvider(first, setup, "cached-authority");
      first.close();
      const command = {
        type: "ParkRunAfterProviderAttemptFailure",
        idempotencyKey: "cached-authority-park",
        runId: setup.runId,
        providerAttemptId: attempt.entityId,
        expectedRunRevision: 1,
        expectedActivationGeneration: 1,
        reason: "A forged Agent cache must not bypass Runtime authority.",
      } as const;
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(
          `INSERT INTO idempotency_records
            (principal_id, command_name, idempotency_key, payload_hash,
             result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          "principal-orbit",
          command.type,
          command.idempotencyKey,
          commandHash(command),
          JSON.stringify({
            commandType: command.type,
            entityId: setup.runId,
            revision: 2,
          }),
          "2026-09-21T08:00:00.000Z",
        );
      } finally {
        database.close();
      }

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        await expect(
          reopened.execute(command, {
            principalId: "principal-orbit",
            activationId: setup.activationId,
          }),
        ).rejects.toMatchObject({ code: "Forbidden" });
        const projection = await reopened.query(
          { type: "GetRunProjection", runId: setup.runId },
          humanContext,
        );
        expect(projection.run).toMatchObject({ state: "Active", revision: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
