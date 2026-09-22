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

interface RecordedPromotion {
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
  readonly changes: number;
}

function expectIndexedRecoverablePlan(planDetails: readonly string[]): void {
  expect(
    planDetails.some(
      (detail) =>
        /\bSEARCH\s+recovery\b/i.test(detail) &&
        (
          detail.includes("attention_recovery_unfinished_order_idx") ||
          detail.includes("attention_recovery_finished_order_idx")
        ),
    ),
  ).toBe(true);
  expect(
    planDetails.some((detail) => /\bCORRELATED\b/i.test(detail)),
  ).toBe(false);
  expect(
    planDetails.some((detail) => /\bSCAN\b/i.test(detail)),
  ).toBe(false);
  for (const alias of ["activation", "attention", "attention_domain"]) {
    expect(
      planDetails.some((detail) =>
        new RegExp(`\\bSEARCH\\s+${alias}\\b`, "i").test(detail)
      ),
    ).toBe(true);
  }
  expect(
    planDetails.some((detail) => /USE TEMP B-TREE/i.test(detail)),
  ).toBe(false);
}

function expectIndexedHydrationPlan(planDetails: readonly string[]): void {
  expect(
    planDetails.some(
      (detail) =>
        /\bSEARCH\s+provider_attempts\b/i.test(detail) &&
        detail.includes("provider_attempts_activation_order_idx"),
    ),
  ).toBe(true);
  expect(
    planDetails.some((detail) => /USE TEMP B-TREE/i.test(detail)),
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

function prepareRacingRecoverySnapshot(
  databasePath: string,
  signal: SharedArrayBuffer,
  observedAt: string,
): {
  readonly ready: Promise<void>;
  readonly result: Promise<{
    readonly revision: number;
    readonly observedAt: string;
    readonly nextExpiryAt: string | null;
  }>;
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
            clock: () => new Date(workerData.observedAt),
          });
          parentPort.postMessage({ type: "ready" });
          if (Atomics.wait(startSignal, 0, 0, 5000) === "timed-out") {
            throw new Error("Timed out waiting to capture recovery snapshot.");
          }
          try {
            const result = await kernel.query(
              { type: "GetAttentionRecoverySnapshot" },
              { principalId: "principal-runtime" },
            );
            parentPort.postMessage({ type: "result", result });
          } finally {
            kernel.close();
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message:
              error instanceof Error ? error.stack ?? error.message : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        observedAt,
        signal,
      },
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: {
    readonly revision: number;
    readonly observedAt: string;
    readonly nextExpiryAt: string | null;
  }) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<{
    readonly revision: number;
    readonly observedAt: string;
    readonly nextExpiryAt: string | null;
  }>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on(
    "message",
    (message: {
      readonly type: string;
      readonly message?: string;
      readonly result?: {
        readonly revision: number;
        readonly observedAt: string;
        readonly nextExpiryAt: string | null;
      };
    }) => {
      if (message.type === "ready") {
        resolveReady();
      } else if (message.type === "result" && message.result) {
        resolveResult(message.result);
      } else if (message.type === "error") {
        const error = new Error(message.message ?? "Snapshot worker failed.");
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

  it("serializes concurrent same-domain Attention claims across Kernel instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-domain-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    let firstWorker: Worker | undefined;
    let secondWorker: Worker | undefined;
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const firstMessage = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "domain-race-first-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, process the first synthetic dispatch.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const secondMessage = await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "domain-race-second-message",
          threadRootId: firstMessage.entityId,
          body: "Orbit, process the second synthetic dispatch.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        {
          type: "ListOpenAttentions",
          targetAgentId: "agent-orbit",
          limit: 10,
        },
        runtimeContext,
      );
      const firstAttention = page.items.find(
        (item) =>
          item.messageRevisionId ===
          firstMessage.relatedIds!.messageRevisionId,
      );
      const secondAttention = page.items.find(
        (item) =>
          item.messageRevisionId ===
          secondMessage.relatedIds!.messageRevisionId,
      );
      if (!firstAttention || !secondAttention) {
        throw new Error("Expected two same-domain Attentions.");
      }
      kernel.close();

      const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const startSignal = new Int32Array(signal);
      const first = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "ClaimAttention",
          idempotencyKey: "domain-race-first-claim",
          attentionId: firstAttention.id,
          expectedAttentionRevision: firstAttention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const second = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "ClaimAttention",
          idempotencyKey: "domain-race-second-claim",
          attentionId: secondAttention.id,
          expectedAttentionRevision: secondAttention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      firstWorker = first.worker;
      secondWorker = second.worker;
      await Promise.all([first.ready, second.ready]);
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0, 2);
      const outcomes = await Promise.all([first.result, second.result]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toEqual([
        expect.objectContaining({
          status: "rejected",
          code: "DomainBusy",
        }),
      ]);
      await first.worker.terminate();
      await second.worker.terminate();
      firstWorker = undefined;
      secondWorker = undefined;

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database.prepare(
            `SELECT COUNT(*) AS count
               FROM attention_domain_fences`,
          ).get(),
        ).toMatchObject({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      if (firstWorker) {
        await firstWorker.terminate();
      }
      if (secondWorker) {
        await secondWorker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent recovery snapshots and promotes expiry once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-snapshot-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    let firstWorker: Worker | undefined;
    let secondWorker: Worker | undefined;
    try {
      const kernel = TorsorKernel.open({
        databasePath,
        bootstrap,
        clock: () => new Date("2026-09-21T08:00:00.000Z"),
      });
      const message = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "snapshot-race-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, exercise concurrent recovery snapshots.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items.find(
        (item) =>
          item.messageRevisionId === message.relatedIds!.messageRevisionId,
      )!;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "snapshot-race-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "snapshot-race-activation",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
          durationMs: 1_000,
        },
        runtimeContext,
      );
      kernel.close();

      const beforeDatabase = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      const revisionBefore = (
        beforeDatabase.prepare(
          `SELECT attention_recovery_revision AS revision
             FROM kernel_runtime_state
            WHERE singleton = 1`,
        ).get() as { readonly revision: number }
      ).revision;
      beforeDatabase.close();

      const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const startSignal = new Int32Array(signal);
      const first = prepareRacingRecoverySnapshot(
        databasePath,
        signal,
        "2026-09-21T08:00:01.000Z",
      );
      const second = prepareRacingRecoverySnapshot(
        databasePath,
        signal,
        "2026-09-21T08:00:01.000Z",
      );
      firstWorker = first.worker;
      secondWorker = second.worker;
      await Promise.all([first.ready, second.ready]);
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0, 2);
      const snapshots = await Promise.all([first.result, second.result]);
      expect(snapshots[0]).toEqual(snapshots[1]);
      expect(snapshots[0]!.revision).toBe(revisionBefore + 1);
      await first.worker.terminate();
      await second.worker.terminate();
      firstWorker = undefined;
      secondWorker = undefined;

      const afterDatabase = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        expect(
          afterDatabase.prepare(
            `SELECT expired_recoverable
               FROM attention_recovery_executions`,
          ).get(),
        ).toMatchObject({ expired_recoverable: 1 });
      } finally {
        afterDatabase.close();
      }
    } finally {
      if (firstWorker) {
        await firstWorker.terminate();
      }
      if (secondWorker) {
        await secondWorker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes superseded promoted Activations from recovery across rollback and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-recovery-fence-"));
    const databasePath = join(directory, "kernel.sqlite");
    let now = new Date("2026-09-21T08:00:00.000Z");
    const options = {
      databasePath,
      bootstrap,
      clock: () => now,
    };
    const beforeCommitHookSymbol = Symbol.for(
      "torsor.kernel.command-before-commit",
    );
    let first: TorsorKernel | undefined;
    let second: TorsorKernel | undefined;
    let reopened: TorsorKernel | undefined;
    try {
      first = TorsorKernel.open(options);
      second = TorsorKernel.open(options);
      const firstMessage = await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "recovery-fence-first-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, recover the first synthetic execution.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const secondMessage = await first.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "recovery-fence-second-message",
          threadRootId: firstMessage.entityId,
          body: "Orbit, recover the second synthetic execution.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const attentions = await first.query(
        {
          type: "ListOpenAttentions",
          targetAgentId: "agent-orbit",
          limit: 10,
        },
        runtimeContext,
      );
      const attentionA = attentions.items.find(
        (attention) =>
          attention.messageRevisionId ===
          firstMessage.relatedIds!.messageRevisionId,
      );
      const attentionB = attentions.items.find(
        (attention) =>
          attention.messageRevisionId ===
          secondMessage.relatedIds!.messageRevisionId,
      );
      if (!attentionA || !attentionB) {
        throw new Error("Expected two same-domain Attentions.");
      }
      const claimA = await first.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "recovery-fence-first-claim",
          attentionId: attentionA.id,
          expectedAttentionRevision: attentionA.revision,
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      const activationA = await first.execute(
        {
          type: "StartActivation",
          idempotencyKey: "recovery-fence-first-activation",
          attentionId: attentionA.id,
          handlerLeaseToken: claimA.relatedIds!.handlerLeaseToken!,
          durationMs: 1_000,
        },
        runtimeContext,
      );

      now = new Date("2026-09-21T08:00:02.000Z");
      const promotedA = await first.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      await expect(
        first.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: promotedA.revision,
            limit: 10,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        items: [
          {
            activation: { id: activationA.entityId },
            attention: { id: attentionA.id },
          },
        ],
      });

      const claimBCommand = {
        type: "ClaimAttention",
        idempotencyKey: "recovery-fence-second-claim",
        attentionId: attentionB.id,
        expectedAttentionRevision: attentionB.revision,
        leaseDurationMs: 1_000,
      } as const;
      Reflect.set(
        globalThis,
        beforeCommitHookSymbol,
        ({ commandType }: { readonly commandType: string }) => {
          if (commandType === "ClaimAttention") {
            throw new Error("Synthetic recovery takeover rollback.");
          }
        },
      );
      await expect(
        second.execute(claimBCommand, runtimeContext),
      ).rejects.toThrow("Synthetic recovery takeover rollback.");
      Reflect.deleteProperty(globalThis, beforeCommitHookSymbol);

      const afterRollback = await first.query(
        {
          type: "ListRecoverableAttentionExecutions",
          recoveryRevision: promotedA.revision,
          limit: 10,
        },
        runtimeContext,
      );
      expect(
        afterRollback.items.map((item) => item.activation.id),
      ).toEqual([activationA.entityId]);
      const rollbackDatabase = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        expect(
          rollbackDatabase.prepare(
            `SELECT activation.revoked_at,
                    recovery.expired_recoverable,
                    domain.attention_id AS domain_attention_id
               FROM activation_attempts AS activation
               JOIN attention_recovery_executions AS recovery
                 ON recovery.activation_id = activation.id
               JOIN attention_domain_fences AS domain
                 ON domain.attention_id = activation.attention_id
              WHERE activation.id = ?`,
          ).get(activationA.entityId),
        ).toMatchObject({
          revoked_at: null,
          expired_recoverable: 1,
          domain_attention_id: attentionA.id,
        });
      } finally {
        rollbackDatabase.close();
      }

      const claimB = await second.execute(claimBCommand, runtimeContext);
      await expect(
        first.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: promotedA.revision,
            limit: 10,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "StaleRevision" });
      const activationB = await second.execute(
        {
          type: "StartActivation",
          idempotencyKey: "recovery-fence-second-activation",
          attentionId: attentionB.id,
          handlerLeaseToken: claimB.relatedIds!.handlerLeaseToken!,
          durationMs: 1_000,
        },
        runtimeContext,
      );
      first.close();
      first = undefined;
      second.close();
      second = undefined;

      now = new Date("2026-09-21T08:00:04.000Z");
      reopened = TorsorKernel.open(options);
      const promotedB = await reopened.query(
        { type: "GetAttentionRecoverySnapshot" },
        runtimeContext,
      );
      const currentPage = await reopened.query(
        {
          type: "ListRecoverableAttentionExecutions",
          recoveryRevision: promotedB.revision,
          limit: 10,
        },
        runtimeContext,
      );
      expect(
        currentPage.items.map((item) => item.activation.id),
      ).toEqual([activationB.entityId]);

      now = new Date("2026-09-21T08:00:00.500Z");
      const rollbackPage = await reopened.query(
        {
          type: "ListRecoverableAttentionExecutions",
          recoveryRevision: promotedB.revision,
          limit: 10,
        },
        runtimeContext,
      );
      expect(
        rollbackPage.items.map((item) => item.activation.id),
      ).toEqual([activationB.entityId]);
      expect(
        rollbackPage.items.some(
          (item) => item.activation.id === activationA.entityId,
        ),
      ).toBe(false);
      reopened.close();
      reopened = undefined;

      const committedDatabase = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        expect(
          committedDatabase.prepare(
            `SELECT 1
               FROM attention_recovery_executions
              WHERE activation_id = ?`,
          ).get(activationA.entityId),
        ).toBeUndefined();
        expect(
          committedDatabase.prepare(
            `SELECT revoked_at, revocation_reason
               FROM activation_attempts
              WHERE id = ?`,
          ).get(activationA.entityId),
        ).toMatchObject({
          revoked_at: "2026-09-21T08:00:02.000Z",
          revocation_reason: "attention_domain_superseded",
        });
      } finally {
        committedDatabase.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, beforeCommitHookSymbol);
      first?.close();
      second?.close();
      reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maintains Attention domain counts across rollback and concurrent settlements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-domain-count-"));
    const databasePath = join(directory, "kernel.sqlite");
    let failedWorker: Worker | undefined;
    let unknownWorker: Worker | undefined;
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const message = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "domain-count-message",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, reconcile two synthetic provider deliveries.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items.find(
        (item) =>
          item.messageRevisionId === message.relatedIds!.messageRevisionId,
      )!;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "domain-count-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "domain-count-activation",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      const attempts: CommandResult[] = [];
      for (let index = 0; index < 2; index += 1) {
        attempts.push(
          await kernel.execute(
            {
              type: "StartProviderAttempt",
              idempotencyKey: `domain-count-provider-${index}`,
              activationId: activation.entityId,
              adapter: "deterministic-fake",
              adapterVersion: "1",
              capabilitySnapshot: {},
              runInputIds: [],
              requestIdempotencyKey: `domain-count-request-${index}`,
            },
            runtimeContext,
          ),
        );
      }
      await kernel.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "domain-count-acknowledged",
          providerAttemptId: attempts[0]!.entityId,
          status: "Acknowledged",
        },
        runtimeContext,
      );
      const acknowledgedState = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        expect(
          acknowledgedState.prepare(
            `SELECT unsettled_provider_attempt_count AS count
               FROM attention_domain_fences
              WHERE attention_id = ?`,
          ).get(attention.id),
        ).toMatchObject({ count: 2 });
      } finally {
        acknowledgedState.close();
      }
      await kernel.execute(
        {
          type: "IgnoreAttention",
          idempotencyKey: "domain-count-ignore",
          attentionId: attention.id,
          expectedAttentionRevision: claim.revision!,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
          reason: "Provider settlement remains pending.",
        },
        {
          principalId: "principal-orbit",
          activationId: activation.entityId,
        },
      );
      kernel.close();

      const corrupted = new DatabaseSync(databasePath);
      corrupted.prepare(
        `UPDATE attention_domain_fences
            SET unsettled_provider_attempt_count = 0
          WHERE attention_id = ?`,
      ).run(attention.id);
      corrupted.close();
      const rollbackProbe = TorsorKernel.open({ databasePath, bootstrap });
      try {
        await expect(
          rollbackProbe.execute(
            {
              type: "FailProviderAttempt",
              idempotencyKey: "domain-count-underflow",
              providerAttemptId: attempts[0]!.entityId,
              error: "Synthetic failed delivery.",
            },
            runtimeContext,
          ),
        ).rejects.toThrow(/underflow/i);
        expect(
          await rollbackProbe.query(
            {
              type: "GetProviderAttempt",
              providerAttemptId: attempts[0]!.entityId,
            },
            runtimeContext,
          ),
        ).toMatchObject({ status: "Acknowledged" });
      } finally {
        rollbackProbe.close();
      }

      const repaired = new DatabaseSync(databasePath);
      repaired.prepare(
        `UPDATE attention_domain_fences
            SET unsettled_provider_attempt_count = 2
          WHERE attention_id = ?`,
      ).run(attention.id);
      repaired.close();

      const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const startSignal = new Int32Array(signal);
      const failed = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "FailProviderAttempt",
          idempotencyKey: "domain-count-failed",
          providerAttemptId: attempts[0]!.entityId,
          error: "Synthetic failed delivery.",
        },
        runtimeContext,
      );
      const unknown = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "domain-count-unknown",
          providerAttemptId: attempts[1]!.entityId,
          status: "Unknown",
          detail: "Synthetic unknown delivery.",
        },
        runtimeContext,
      );
      failedWorker = failed.worker;
      unknownWorker = unknown.worker;
      await Promise.all([failed.ready, unknown.ready]);
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0, 2);
      const outcomes = await Promise.all([failed.result, unknown.result]);
      expect(
        outcomes.every((outcome) => outcome.status === "fulfilled"),
      ).toBe(true);
      await failed.worker.terminate();
      await unknown.worker.terminate();
      failedWorker = undefined;
      unknownWorker = undefined;

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        expect(
          await reopened.query(
            {
              type: "GetProviderAttempt",
              providerAttemptId: attempts[0]!.entityId,
            },
            runtimeContext,
          ),
        ).toMatchObject({ status: "Failed" });
        expect(
          await reopened.query(
            {
              type: "GetProviderAttempt",
              providerAttemptId: attempts[1]!.entityId,
            },
            runtimeContext,
          ),
        ).toMatchObject({ status: "Unknown" });
        await expect(
          reopened.execute(
            {
              type: "FailProviderAttempt",
              idempotencyKey: "domain-count-failed",
              providerAttemptId: attempts[0]!.entityId,
              error: "Synthetic failed delivery.",
            },
            runtimeContext,
          ),
        ).resolves.toMatchObject({ entityId: attempts[0]!.entityId });
      } finally {
        reopened.close();
      }
      const state = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          state.prepare(
            `SELECT COUNT(*) AS count
               FROM attention_domain_fences
              WHERE attention_id = ?`,
          ).get(attention.id),
        ).toMatchObject({ count: 0 });
      } finally {
        state.close();
      }
    } finally {
      if (failedWorker) {
        await failedWorker.terminate();
      }
      if (unknownWorker) {
        await unknownWorker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pages 100,000 recoverable rows through bounded ordered index searches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-runtime-query-"));
    const databasePath = join(directory, "kernel.sqlite");
    let revisionBeforePromotion = 0;
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const execution = await createFinishedAttentionAttempt(first);
      first.close();

      const historyDatabase = new DatabaseSync(databasePath);
      try {
        const source = historyDatabase.prepare(
          `SELECT activation.attention_id,
                  attention.message_revision_id
             FROM activation_attempts AS activation
             JOIN attentions AS attention
               ON attention.id = activation.attention_id
            WHERE activation.id = ?`,
        ).get(execution.activationId) as
          | {
            readonly attention_id: string;
            readonly message_revision_id: string;
          }
          | undefined;
        if (!source) {
          throw new Error("Expected the recoverable Activation.");
        }
        const insertAttention = historyDatabase.prepare(
          `INSERT INTO attentions
            (id, project_id, channel_id, thread_root_id,
             message_revision_id, target_agent_id, trigger_kind, status,
             revision, handler_lease_holder_principal_id,
             handler_lease_token, handler_lease_expires_at, created_at)
           VALUES (
             ?, 'project-sample', 'channel-general', ?, ?,
             'agent-orbit', ?, 'Open', 1, 'principal-runtime', ?, ?, ?
           )`,
        );
        const insertDomainFence = historyDatabase.prepare(
          `INSERT INTO attention_domain_fences
            (agent_id, project_id, channel_id, thread_root_id, attention_id,
             lease_token, lease_expires_at,
             unsettled_provider_attempt_count)
           VALUES (
             'agent-orbit', 'project-sample', 'channel-general', ?, ?,
             ?, ?, 0
           )`,
        );
        const insertRecovery = historyDatabase.prepare(
          `INSERT INTO attention_recovery_executions
            (activation_id, started_at, expires_at, unfinished,
             expired_recoverable,
             unsettled_provider_attempt_count,
             finished_with_unsettled_provider)
           VALUES (?, ?, ?, 1, 0, 0, 0)`,
        );
        const insertSettledAttempt = historyDatabase.prepare(
          `INSERT INTO provider_attempts
            (id, activation_id, adapter, adapter_version,
             capability_snapshot_json, run_input_ids_json,
             request_idempotency_key, status, started_at, finished_at)
           VALUES (?, ?, 'deterministic-fake', '1', '{}', '[]', ?,
                   'Completed', ?, ?)`,
        );
        historyDatabase.exec(
          `DROP TRIGGER attention_recovery_activation_insert;
           DROP TRIGGER attention_recovery_activation_update;
           DROP TRIGGER attention_recovery_provider_insert;
           DROP TRIGGER attention_domain_provider_insert;`,
        );
        historyDatabase.exec("BEGIN");
        historyDatabase.prepare(
          `WITH RECURSIVE sequence(value) AS (
             VALUES (0)
             UNION ALL
             SELECT value + 1
               FROM sequence
              WHERE value < 99999
           )
           INSERT INTO attentions
             (id, project_id, channel_id, thread_root_id,
              message_revision_id, target_agent_id, trigger_kind, status,
              revision, handler_lease_holder_principal_id,
              handler_lease_token, handler_lease_expires_at, created_at)
           SELECT
             'attention-history-' || printf('%06d', value),
             'project-sample',
             'channel-general',
             'thread-history-' || printf('%06d', value),
             ?,
             'agent-orbit',
             'SyntheticHistory' || printf('%06d', value),
             'Open',
             1,
             'principal-runtime',
             'lease-history-' || printf('%06d', value),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             )
             FROM sequence`,
        ).run(source.message_revision_id);
        historyDatabase.exec(
          `WITH RECURSIVE sequence(value) AS (
             VALUES (0)
             UNION ALL
             SELECT value + 1
               FROM sequence
              WHERE value < 99999
           )
           INSERT INTO attention_domain_fences
             (agent_id, project_id, channel_id, thread_root_id, attention_id,
              lease_token, lease_expires_at,
              unsettled_provider_attempt_count)
           SELECT
             'agent-orbit',
             'project-sample',
             'channel-general',
             'thread-history-' || printf('%06d', value),
             'attention-history-' || printf('%06d', value),
             'lease-history-' || printf('%06d', value),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             0
             FROM sequence;

           WITH RECURSIVE sequence(value) AS (
             VALUES (0)
             UNION ALL
             SELECT value + 1
               FROM sequence
              WHERE value < 99999
           )
           INSERT INTO activation_attempts
             (id, agent_id, attention_id, attention_lease_token, cause,
              config_revision, started_at, expires_at)
           SELECT
             'activation-history-' || printf('%06d', value),
             'agent-orbit',
             'attention-history-' || printf('%06d', value),
             'lease-history-' || printf('%06d', value),
             'Attention',
             3,
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             )
             FROM sequence;

           WITH RECURSIVE sequence(value) AS (
             VALUES (0)
             UNION ALL
             SELECT value + 1
               FROM sequence
              WHERE value < 99999
           )
           INSERT INTO attention_recovery_executions
             (activation_id, started_at, expires_at, unfinished,
              expired_recoverable, unsettled_provider_attempt_count,
              finished_with_unsettled_provider)
           SELECT
             'activation-history-' || printf('%06d', value),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             1,
             0,
             0,
             0
             FROM sequence;

           WITH RECURSIVE sequence(value) AS (
             VALUES (0)
             UNION ALL
             SELECT value + 1
               FROM sequence
              WHERE value < 99999
           )
           INSERT INTO provider_attempts
             (id, activation_id, adapter, adapter_version,
              capability_snapshot_json, run_input_ids_json,
              request_idempotency_key, status, started_at, finished_at)
           SELECT
             'provider-history-' || printf('%06d', value),
             'activation-history-' || printf('%06d', value),
             'deterministic-fake',
             '1',
             '{}',
             '[]',
             'request-history-' || printf('%06d', value),
             'Completed',
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             ),
             strftime(
               '%Y-%m-%dT%H:%M:%fZ',
               '2025-01-01T00:00:00.000Z',
               '+' || value || ' seconds'
             )
             FROM sequence;`,
        );
        insertAttention.run(
          "attention-expired-recoverable",
          "thread-expired-recoverable",
          source.message_revision_id,
          "SyntheticExpiredRecoverable",
          "lease-expired-recoverable",
          "2026-09-21T07:59:30.000Z",
          "2026-09-21T07:59:00.000Z",
        );
        insertDomainFence.run(
          "thread-expired-recoverable",
          "attention-expired-recoverable",
          "lease-expired-recoverable",
          "2026-09-21T07:59:30.000Z",
        );
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
        ).run("attention-expired-recoverable");
        insertRecovery.run(
          "activation-expired-recoverable",
          "2026-09-21T07:59:00.000Z",
          "2026-09-21T07:59:30.000Z",
        );
        for (let index = 0; index < 1_000; index += 1) {
          const suffix = index.toString().padStart(4, "0");
          const timestamp = new Date(
            Date.UTC(2026, 8, 21, 8, 0, index),
          ).toISOString();
          insertSettledAttempt.run(
            `provider-hydration-${suffix}`,
            execution.activationId,
            `request-hydration-${suffix}`,
            timestamp,
            timestamp,
          );
        }
        historyDatabase.exec("COMMIT");
        revisionBeforePromotion = (
          historyDatabase.prepare(
            `SELECT attention_recovery_revision AS revision
               FROM kernel_runtime_state
              WHERE singleton = 1`,
          ).get() as { readonly revision: number }
        ).revision;
        historyDatabase.prepare(
          `DELETE FROM activation_history
            WHERE event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type = 'ActivationAttempt'
            )`,
        ).run();
        historyDatabase.prepare(
          `DELETE FROM run_history
            WHERE event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type IN ('ActivationAttempt', 'ProviderAttempt')
            )`,
        ).run();
        historyDatabase.prepare(
          `DELETE FROM provider_attempt_history
            WHERE event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type = 'ProviderAttempt'
            )`,
        ).run();
        historyDatabase.prepare(
          `UPDATE activation_attempts
              SET created_event_sequence = NULL
            WHERE created_event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type = 'ActivationAttempt'
            )`,
        ).run();
        historyDatabase.prepare(
          `UPDATE provider_attempts
              SET created_event_sequence = NULL
            WHERE created_event_sequence IN (
              SELECT sequence
                FROM public_events
               WHERE entity_type = 'ProviderAttempt'
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
      const recordedHydrationQueries: RecordedQuery[] = [];
      const recordedPromotions: RecordedPromotion[] = [];
      const queryHookSymbol = Symbol.for(
        "torsor.kernel.recoverable-attention-query",
      );
      const hydrationHookSymbol = Symbol.for(
        "torsor.kernel.recoverable-attention-hydration-query",
      );
      const promotionHookSymbol = Symbol.for(
        "torsor.kernel.recovery-snapshot-promotion",
      );
      Reflect.set(
        globalThis,
        queryHookSymbol,
        (query: RecordedQuery) => {
          recordedQueries.push(query);
        },
      );
      Reflect.set(
        globalThis,
        hydrationHookSymbol,
        (query: RecordedQuery) => {
          recordedHydrationQueries.push(query);
        },
      );
      Reflect.set(
        globalThis,
        promotionHookSymbol,
        (promotion: RecordedPromotion) => {
          recordedPromotions.push(promotion);
        },
      );
      try {
        const promotionStartedAt = performance.now();
        const snapshot = await reopened.query(
          { type: "GetAttentionRecoverySnapshot" },
          runtimeContext,
        );
        expect(performance.now() - promotionStartedAt).toBeLessThan(10_000);
        expect(snapshot.revision).toBe(revisionBeforePromotion + 1);
        const unchangedSnapshot = await reopened.query(
          { type: "GetAttentionRecoverySnapshot" },
          runtimeContext,
        );
        expect(unchangedSnapshot.revision).toBe(snapshot.revision);
        expect(recordedPromotions).toEqual([
          expect.objectContaining({ changes: 100_001 }),
          expect.objectContaining({ changes: 0 }),
        ]);
        expect(
          recordedPromotions.every(
            (promotion) => !/\bRETURNING\b/i.test(promotion.sql),
          ),
        ).toBe(true);
        const initialStartedAt = performance.now();
        const initialPage = await reopened.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        );
        const initialElapsedMs = performance.now() - initialStartedAt;
        expect(initialPage.items.map((item) => item.activation.id)).toEqual([
          "activation-history-000000",
        ]);
        expect(initialPage.hasMore).toBe(true);
        expect(initialElapsedMs).toBeLessThan(2_000);
        const continuationStartedAt = performance.now();
        const continuationPage = await reopened.query(
          {
            type: "ListRecoverableAttentionExecutions",
            afterCursor: initialPage.nextCursor!,
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        );
        const continuationElapsedMs =
          performance.now() - continuationStartedAt;
        expect(
          continuationPage.items.map((item) => item.activation.id),
        ).toEqual(["activation-history-000001"]);
        expect(continuationPage.hasMore).toBe(true);
        expect(continuationElapsedMs).toBeLessThan(2_000);
        const multiActivationPage = await reopened.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: snapshot.revision,
            limit: 10,
          },
          runtimeContext,
        );
        expect(multiActivationPage.items).toHaveLength(10);
        const hydrated = await reopened.query(
          {
            type: "ListRecoverableAttentionExecutions",
            afterCursor: {
              startedAt: "2026-09-21T07:59:00.000Z",
              activationId: "activation-expired-recoverable",
            },
            recoveryRevision: snapshot.revision,
            limit: 1,
          },
          runtimeContext,
        );
        expect(hydrated.items[0]?.activation.id).toBe(
          execution.activationId,
        );
        expect(hydrated.items[0]?.providerAttempts).toHaveLength(1_001);
        const hydrationKeys = hydrated.items[0]!.providerAttempts.map(
          (attempt) => `${attempt.startedAt}\0${attempt.id}`,
        );
        expect(hydrationKeys).toEqual([...hydrationKeys].sort());
      } finally {
        Reflect.deleteProperty(globalThis, queryHookSymbol);
        Reflect.deleteProperty(globalThis, hydrationHookSymbol);
        Reflect.deleteProperty(globalThis, promotionHookSymbol);
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
      expect(recordedQueries).toHaveLength(8);
      expect(recordedHydrationQueries).toHaveLength(4);

      const database = new DatabaseSync(databasePath);
      const recordedPlans: string[][] = [];
      try {
        const indexes = database.prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'attention_recovery_unfinished_order_idx',
                'attention_recovery_finished_order_idx',
                'attention_recovery_expiry_horizon_idx',
                'provider_attempts_activation_order_idx'
              )
            ORDER BY name`,
        ).all() as Array<{ readonly name: string }>;
        expect(indexes.map((row) => row.name)).toEqual([
          "attention_recovery_expiry_horizon_idx",
          "attention_recovery_finished_order_idx",
          "attention_recovery_unfinished_order_idx",
          "provider_attempts_activation_order_idx",
        ]);
        for (const recordedQuery of recordedQueries) {
          const queryPlan = database.prepare(
            `EXPLAIN QUERY PLAN ${recordedQuery.sql}`,
          ).all(...recordedQuery.parameters) as Array<{
            readonly detail: string;
          }>;
          recordedPlans.push(queryPlan.map((row) => row.detail));
        }
        for (const hydrationQuery of recordedHydrationQueries) {
          const hydrationPlan = database.prepare(
            `EXPLAIN QUERY PLAN ${hydrationQuery.sql}`,
          ).all(...hydrationQuery.parameters) as Array<{
            readonly detail: string;
          }>;
          expectIndexedHydrationPlan(
            hydrationPlan.map((row) => row.detail),
          );
        }
        const promotionPlan = database.prepare(
          `EXPLAIN QUERY PLAN ${recordedPromotions[0]!.sql}`,
        ).all(...recordedPromotions[0]!.parameters) as Array<{
          readonly detail: string;
        }>;
        expect(
          promotionPlan.some(
            (row) =>
              /\bSEARCH\s+recovery\b/i.test(row.detail) &&
              row.detail.includes("attention_recovery_expiry_horizon_idx"),
          ),
        ).toBe(true);
        expect(
          promotionPlan.some((row) => /\bSCAN\b/i.test(row.detail)),
        ).toBe(false);
        const domainTriggerSql = (
          database.prepare(
            `SELECT group_concat(sql, char(10)) AS sql
               FROM sqlite_master
              WHERE type = 'trigger'
                AND name LIKE 'attention_domain_provider_%'`,
          ).get() as { readonly sql: string }
        ).sql;
        expect(domainTriggerSql).not.toMatch(/\bCOUNT\s*\(/i);
        expect(domainTriggerSql).not.toMatch(
          /activation_id\s+IN\s*\(\s*SELECT/i,
        );
        database.exec(
          "DROP TRIGGER attention_recovery_activation_update;",
        );
        database.prepare(
          `UPDATE activation_attempts
              SET finished_at = '2026-09-21T08:02:00.000Z',
                  outcome = 'Expired'
            WHERE id = 'activation-expired-recoverable'
               OR id LIKE 'activation-history-%'`,
        ).run();
        database.prepare(
          `UPDATE attention_recovery_executions
              SET unfinished = 0,
                  expired_recoverable = 0,
                  finished_with_unsettled_provider = 0
            WHERE activation_id = 'activation-expired-recoverable'
               OR activation_id LIKE 'activation-history-%'`,
        ).run();
        database.prepare(
          `UPDATE kernel_runtime_state
              SET attention_recovery_revision =
                    attention_recovery_revision + 1
            WHERE singleton = 1`,
        ).run();
        const settlementStartedAt = performance.now();
        database.prepare(
          `UPDATE provider_attempts
              SET status = 'Unknown',
                  detail = 'Synthetic recovery reconciliation.',
                  finished_at = '2026-09-21T08:02:00.000Z'
            WHERE id = ?`,
        ).run(execution.attemptId);
        expect(performance.now() - settlementStartedAt).toBeLessThan(2_000);
        expect(
          database.prepare(
            `SELECT unsettled_provider_attempt_count AS count
               FROM attention_domain_fences`,
          ).get(),
        ).toMatchObject({ count: 0 });
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
        expect(page).toMatchObject({
          items: [],
          nextCursor: null,
          hasMore: false,
        });
      } finally {
        Reflect.deleteProperty(globalThis, queryHookSymbol);
        settled.close();
      }
      expect(recordedQueries).toHaveLength(10);

      const settledDatabase = new DatabaseSync(databasePath);
      try {
        for (const noRowsQuery of recordedQueries.slice(8)) {
          const noRowsPlan = settledDatabase.prepare(
            `EXPLAIN QUERY PLAN ${noRowsQuery.sql}`,
          ).all(...noRowsQuery.parameters) as Array<{
            readonly detail: string;
          }>;
          recordedPlans.push(noRowsPlan.map((row) => row.detail));
        }
        settledDatabase.exec(
          "DROP TRIGGER attention_recovery_activation_update;",
        );
        settledDatabase.prepare(
          `UPDATE activation_attempts
              SET expires_at = '2099-01-01T00:00:00.000Z',
                  finished_at = NULL,
                  outcome = NULL
            WHERE id = 'activation-expired-recoverable'
               OR id LIKE 'activation-history-%'`,
        ).run();
        settledDatabase.prepare(
          `UPDATE attention_recovery_executions
              SET expires_at = '2099-01-01T00:00:00.000Z',
                  unfinished = 1,
                  expired_recoverable = 0,
                  finished_with_unsettled_provider = 0
            WHERE activation_id = 'activation-expired-recoverable'
               OR activation_id LIKE 'activation-history-%'`,
        ).run();
        settledDatabase.prepare(
          `UPDATE kernel_runtime_state
              SET attention_recovery_revision =
                    attention_recovery_revision + 1
            WHERE singleton = 1`,
        ).run();
      } finally {
        settledDatabase.close();
      }
      const future = TorsorKernel.open({ databasePath, bootstrap });
      Reflect.set(
        globalThis,
        queryHookSymbol,
        (query: RecordedQuery) => {
          recordedQueries.push(query);
        },
      );
      try {
        const snapshot = await future.query(
          { type: "GetAttentionRecoverySnapshot" },
          runtimeContext,
        );
        expect(snapshot.nextExpiryAt).toBe(
          "2099-01-01T00:00:00.000Z",
        );
        const futureStartedAt = performance.now();
        const page = await future.query(
          {
            type: "ListRecoverableAttentionExecutions",
            recoveryRevision: snapshot.revision,
            limit: 10,
          },
          runtimeContext,
        );
        expect(page).toMatchObject({
          items: [],
          nextCursor: null,
          hasMore: false,
        });
        expect(performance.now() - futureStartedAt).toBeLessThan(2_000);
      } finally {
        Reflect.deleteProperty(globalThis, queryHookSymbol);
        future.close();
      }
      expect(recordedQueries).toHaveLength(12);
      const futureDatabase = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        for (const futureQuery of recordedQueries.slice(10)) {
          const futurePlan = futureDatabase.prepare(
            `EXPLAIN QUERY PLAN ${futureQuery.sql}`,
          ).all(...futureQuery.parameters) as Array<{
            readonly detail: string;
          }>;
          recordedPlans.push(futurePlan.map((row) => row.detail));
        }
      } finally {
        futureDatabase.close();
      }
      for (const planDetails of recordedPlans) {
        expectIndexedRecoverablePlan(planDetails);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

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
