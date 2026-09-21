import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

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

interface HeldWriteLock {
  readonly committed: Promise<void>;
  readonly release: () => void;
  readonly worker: Worker;
}

interface HeldActivationCommand {
  readonly release: () => void;
  readonly result: Promise<{ readonly entityId: string }>;
  readonly worker: Worker;
}

interface SqliteBusyEvidence {
  readonly elapsedMs: number;
  readonly errcode: number;
  readonly message: string;
}

interface PreparedBusyOperation {
  readonly busy: Promise<SqliteBusyEvidence>;
  readonly start: () => void;
  readonly worker: Worker;
}

interface PendingBusyOperation {
  readonly busy: Promise<SqliteBusyEvidence>;
  readonly worker: Worker;
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

async function holdWriteLock(
  databasePath: string,
): Promise<HeldWriteLock> {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const releaseSignal = new Int32Array(signal);
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const releaseSignal = new Int32Array(workerData.signal);
      const database = new DatabaseSync(workerData.databasePath);
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      parentPort.postMessage({ type: "locked" });
      try {
        if (Atomics.wait(releaseSignal, 0, 0, 5000) === "timed-out") {
          throw new Error("Timed out waiting to release the write lock.");
        }
        database.exec("COMMIT");
        parentPort.postMessage({ type: "committed" });
        database.close();
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    `,
    {
      eval: true,
      workerData: {
        databasePath,
        signal,
      },
    },
  );
  let resolveLocked!: () => void;
  let rejectLocked!: (error: Error) => void;
  let resolveCommitted!: () => void;
  let rejectCommitted!: (error: Error) => void;
  const locked = new Promise<void>((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  const committed = new Promise<void>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  worker.on("message", (message: { type: string; message?: string }) => {
    if (message.type === "locked") {
      resolveLocked();
    } else if (message.type === "committed") {
      resolveCommitted();
    } else if (message.type === "error") {
      const error = new Error(message.message ?? "Write-lock worker failed.");
      rejectLocked(error);
      rejectCommitted(error);
    }
  });
  worker.on("error", (error) => {
    rejectLocked(error);
    rejectCommitted(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Write-lock worker exited with code ${code}.`);
      rejectLocked(error);
      rejectCommitted(error);
    }
  });
  await locked;
  return {
    committed,
    release: () => {
      Atomics.store(releaseSignal, 0, 1);
      Atomics.notify(releaseSignal, 0);
    },
    worker,
  };
}

async function startActivationHoldingBeforeCommit(
  databasePath: string,
  command: Readonly<Record<string, unknown>>,
): Promise<HeldActivationCommand> {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const releaseSignal = new Int32Array(signal);
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const releaseSignal = new Int32Array(workerData.signal);
      import(workerData.moduleUrl)
        .then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({
            databasePath: workerData.databasePath,
            bootstrap: workerData.bootstrap,
          });
          globalThis[Symbol.for("torsor.kernel.command-before-commit")] = (
            operation,
          ) => {
            if (operation.commandType === "StartActivation") {
              parentPort.postMessage({ type: "holding" });
              if (Atomics.wait(releaseSignal, 0, 0, 5000) === "timed-out") {
                throw new Error("Timed out waiting to commit the Activation.");
              }
            }
          };
          try {
            const result = await kernel.execute(
              workerData.command,
              workerData.principalContext,
            );
            parentPort.postMessage({
              type: "result",
              result: { entityId: result.entityId },
            });
          } finally {
            kernel.close();
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
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
        principalContext: runtimeContext,
        signal,
      },
    },
  );
  let resolveHolding!: () => void;
  let rejectHolding!: (error: Error) => void;
  let resolveResult!: (result: { readonly entityId: string }) => void;
  let rejectResult!: (error: Error) => void;
  const holding = new Promise<void>((resolve, reject) => {
    resolveHolding = resolve;
    rejectHolding = reject;
  });
  const result = new Promise<{ readonly entityId: string }>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  worker.on(
    "message",
    (message: {
      type: string;
      message?: string;
      result?: { readonly entityId: string };
    }) => {
      if (message.type === "holding") {
        resolveHolding();
      } else if (message.type === "result" && message.result) {
        resolveResult(message.result);
      } else if (message.type === "error") {
        const error = new Error(
          message.message ?? "Activation command worker failed.",
        );
        rejectHolding(error);
        rejectResult(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectHolding(error);
    rejectResult(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Activation command worker exited with code ${code}.`);
      rejectHolding(error);
      rejectResult(error);
    }
  });
  await holding;
  return {
    release: () => {
      Atomics.store(releaseSignal, 0, 1);
      Atomics.notify(releaseSignal, 0);
    },
    result,
    worker,
  };
}

async function prepareBusyActivationCommand(
  databasePath: string,
  command: Readonly<Record<string, unknown>>,
): Promise<PreparedBusyOperation> {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const startSignal = new Int32Array(signal);
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const startSignal = new Int32Array(workerData.signal);
      globalThis[Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms")] =
        workerData.busyTimeoutMs;
      import(workerData.moduleUrl)
        .then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({
            databasePath: workerData.databasePath,
            bootstrap: workerData.bootstrap,
          });
          parentPort.postMessage({ type: "ready" });
          if (Atomics.wait(startSignal, 0, 0, 5000) === "timed-out") {
            throw new Error("Timed out waiting to start the Activation contender.");
          }
          const startedAt = performance.now();
          try {
            await kernel.execute(
              workerData.command,
              workerData.principalContext,
            );
            throw new Error("Activation contender unexpectedly acquired the write lock.");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const errcode =
              typeof error === "object" && error !== null && "errcode" in error
                ? error.errcode
                : undefined;
            if (errcode !== 5 || !/database is locked/i.test(message)) {
              throw error;
            }
            parentPort.postMessage({
              type: "busy",
              evidence: {
                elapsedMs: performance.now() - startedAt,
                errcode,
                message,
              },
            });
          } finally {
            kernel.close();
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        busyTimeoutMs: 150,
        command,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        principalContext: runtimeContext,
        signal,
      },
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveBusy!: (evidence: SqliteBusyEvidence) => void;
  let rejectBusy!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const busy = new Promise<SqliteBusyEvidence>(
    (resolve, reject) => {
      resolveBusy = resolve;
      rejectBusy = reject;
    },
  );
  worker.on(
    "message",
    (message: {
      evidence?: SqliteBusyEvidence;
      type: string;
      message?: string;
    }) => {
      if (message.type === "ready") {
        resolveReady();
      } else if (message.type === "busy" && message.evidence) {
        resolveBusy(message.evidence);
      } else if (message.type === "error") {
        const error = new Error(
          message.message ?? "Activation contender worker failed.",
        );
        rejectReady(error);
        rejectBusy(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectReady(error);
    rejectBusy(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(
        `Activation contender worker exited with code ${code}.`,
      );
      rejectReady(error);
      rejectBusy(error);
    }
  });
  await ready;
  return {
    busy,
    start: () => {
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0);
    },
    worker,
  };
}

function openKernelWithShortBusyTimeout(
  databasePath: string,
): PendingBusyOperation {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      globalThis[Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms")] =
        workerData.busyTimeoutMs;
      import(workerData.moduleUrl)
        .then(({ TorsorKernel }) => {
          const startedAt = performance.now();
          try {
            const kernel = TorsorKernel.open({
              databasePath: workerData.databasePath,
              bootstrap: workerData.bootstrap,
            });
            kernel.close();
            throw new Error("Kernel opener unexpectedly acquired the write lock.");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const errcode =
              typeof error === "object" && error !== null && "errcode" in error
                ? error.errcode
                : undefined;
            if (errcode !== 5 || !/database is locked/i.test(message)) {
              throw error;
            }
            parentPort.postMessage({
              type: "busy",
              evidence: {
                elapsedMs: performance.now() - startedAt,
                errcode,
                message,
              },
            });
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        busyTimeoutMs: 150,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
      },
    },
  );
  let resolveBusy!: (evidence: SqliteBusyEvidence) => void;
  let rejectBusy!: (error: Error) => void;
  const busy = new Promise<SqliteBusyEvidence>((resolve, reject) => {
    resolveBusy = resolve;
    rejectBusy = reject;
  });
  worker.on(
    "message",
    (message: {
      evidence?: SqliteBusyEvidence;
      type: string;
      message?: string;
    }) => {
      if (message.type === "busy" && message.evidence) {
        resolveBusy(message.evidence);
      } else if (message.type === "error") {
        const error = new Error(
          message.message ?? "Kernel open worker failed.",
        );
        rejectBusy(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectBusy(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Kernel open worker exited with code ${code}.`);
      rejectBusy(error);
    }
  });
  return { busy, worker };
}

describe("SQLite persistence", () => {
  it("initializes the current schema and recovers after reopen", async () => {
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

      const metadata = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(metadata.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: 9,
        });
      } finally {
        metadata.close();
      }

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
        expect(recovered.leaseExpiresAt).toBe(
          "2026-09-21T08:00:03.000Z",
        );
        expect(recovered.outboxEvents![0]!.leaseExpiresAt).toBe(
          recovered.leaseExpiresAt,
        );
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

  it("rejects a noncontiguous Outbox acknowledgement atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-outbox-prefix-"));
    const databasePath = join(directory, "kernel.sqlite");
    const options = {
      databasePath,
      bootstrap,
      clock: () => new Date("2026-09-21T08:00:00.000Z"),
    };
    try {
      const kernel = TorsorKernel.open(options);
      for (let index = 1; index <= 3; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `prefix-event-${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Ordered Outbox event ${index}.`,
          },
          humanContext,
        );
      }
      const outbox = await kernel.query(
        {
          type: "ListOutboxEvents",
          includeAcknowledged: true,
          limit: 10,
        },
        runtimeContext,
      );
      const database = new DatabaseSync(databasePath);
      try {
        const setLease = database.prepare(
          `UPDATE outbox_events
              SET lease_holder_principal_id = 'principal-runtime',
                  lease_token = ?,
                  lease_expires_at = '2026-09-21T08:01:00.000Z',
                  delivery_attempts = 1
            WHERE id = ?`,
        );
        setLease.run("prefix-c", outbox.items[0]!.id);
        setLease.run("prefix-b", outbox.items[1]!.id);
        setLease.run("prefix-c", outbox.items[2]!.id);
      } finally {
        database.close();
      }

      await expect(
        kernel.execute(
          {
            type: "AcknowledgeOutboxEvents",
            idempotencyKey: "noncontiguous-prefix-ack",
            outboxEventIds: [outbox.items[0]!.id, outbox.items[2]!.id],
            leaseToken: "prefix-c",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({
        code: "Conflict",
        message:
          "Outbox acknowledgement must exactly advance the oldest pending prefix.",
      });
      const unchanged = await kernel.query(
        {
          type: "ListOutboxEvents",
          includeAcknowledged: true,
          limit: 10,
        },
        runtimeContext,
      );
      expect(unchanged.items.map((event) => event.acknowledgedAt)).toEqual([
        null,
        null,
        null,
      ]);
      kernel.close();
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

  it("waits for a competing Attention Activation transaction and reuses its winner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-attention-"));
    const databasePath = join(directory, "kernel.sqlite");
    let winner: HeldActivationCommand | undefined;
    let contender: PreparedBusyOperation | undefined;
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      await kernel.execute(
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
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items[0]!;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "cross-connection-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      try {
        const contenderCommand = {
          type: "StartActivation",
          idempotencyKey: "cross-connection-contender",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        } as const;
        contender = await prepareBusyActivationCommand(
          databasePath,
          contenderCommand,
        );
        winner = await startActivationHoldingBeforeCommit(databasePath, {
          ...contenderCommand,
          idempotencyKey: "cross-connection-winner",
        });
        contender.start();
        const busy = await contender.busy;
        expect(busy).toMatchObject({
          errcode: 5,
          message: expect.stringMatching(/database is locked/i),
        });
        expect(busy.elapsedMs).toBeGreaterThanOrEqual(100);
        winner.release();
        const winnerResult = await winner.result;
        const contenderResult = await kernel.execute(
          contenderCommand,
          runtimeContext,
        );

        expect(contenderResult.entityId).toBe(winnerResult.entityId);
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(
            database
              .prepare(
                `SELECT COUNT(*) AS count
                   FROM activation_attempts
                  WHERE attention_id = ? AND attention_lease_token = ?`,
              )
              .get(
                attention.id,
                claim.relatedIds!.handlerLeaseToken!,
              ),
          ).toMatchObject({ count: 1 });
        } finally {
          database.close();
        }
        expect(
          (await kernel.readEvents(null, 500)).filter(
            (event) =>
              event.type === "ActivationStarted" &&
              event.entityId === winnerResult.entityId,
          ),
        ).toHaveLength(1);
      } finally {
        if (contender) {
          await contender.worker.terminate();
          contender = undefined;
        }
        if (winner) {
          await winner.worker.terminate();
          winner = undefined;
        }
        kernel.close();
      }
    } finally {
      if (contender) {
        await contender.worker.terminate();
      }
      if (winner) {
        await winner.worker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps projection page metadata and rows on one committed read snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-query-snapshot-"));
    const databasePath = join(directory, "kernel.sqlite");
    let held: HeldActivationCommand | undefined;
    let kernel: TorsorKernel | undefined;
    try {
      kernel = TorsorKernel.open({ databasePath, bootstrap });
      const setup = await createRun(kernel);
      await kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: "query-snapshot-wait",
          runId: setup.runId,
          expectedRunRevision: 1,
          reason: "Prepare a committed Waiting projection.",
        },
        setup.agentContext,
      );

      held = await startActivationHoldingBeforeCommit(
        databasePath,
        {
          type: "StartActivation",
          idempotencyKey: "query-snapshot-resume",
          runId: setup.runId,
          expectedRunRevision: 2,
        },
      );
      const whileUncommitted = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      expect(whileUncommitted.items[0]?.run).toMatchObject({
        id: setup.runId,
        state: "Waiting",
        revision: 2,
      });

      held.release();
      await held.result;
      const afterCommit = await kernel.query(
        {
          type: "ListRunProjections",
          projectId: "project-sample",
          limit: 10,
        },
        humanContext,
      );
      expect(afterCommit.items[0]?.run).toMatchObject({
        id: setup.runId,
        state: "Active",
        revision: 3,
      });
      expect(afterCommit.snapshotEventId).not.toBe(
        whileUncommitted.snapshotEventId,
      );
    } finally {
      held?.release();
      if (held) {
        await held.worker.terminate();
      }
      kernel?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects cached Agent retries for Runtime-only authority commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-authority-cache-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "cached-authority-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, Runtime must mediate this dispatch.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const page = await kernel.query(
        { type: "ListOpenAttentions", targetAgentId: "agent-orbit" },
        runtimeContext,
      );
      const attention = page.items[0]!;
      kernel.close();

      const claimCommand = {
        type: "ClaimAttention",
        idempotencyKey: "legacy-agent-claim-cache",
        attentionId: attention.id,
        expectedAttentionRevision: attention.revision,
        leaseDurationMs: 30_000,
      } as const;
      const activationCommand = {
        type: "StartActivation",
        idempotencyKey: "legacy-agent-activation-cache",
        attentionId: attention.id,
        handlerLeaseToken: "legacy-agent-lease",
      } as const;
      const database = new DatabaseSync(databasePath);
      try {
        const insert = database.prepare(
          `INSERT INTO idempotency_records
            (principal_id, command_name, idempotency_key, payload_hash,
             result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insert.run(
          "principal-orbit",
          claimCommand.type,
          claimCommand.idempotencyKey,
          commandHash(claimCommand),
          JSON.stringify({
            commandType: claimCommand.type,
            entityId: attention.id,
            revision: attention.revision + 1,
            relatedIds: { handlerLeaseToken: "legacy-agent-lease" },
          }),
          "2026-09-21T08:00:00.000Z",
        );
        insert.run(
          "principal-orbit",
          activationCommand.type,
          activationCommand.idempotencyKey,
          commandHash(activationCommand),
          JSON.stringify({
            commandType: activationCommand.type,
            entityId: "activation-from-agent-cache",
          }),
          "2026-09-21T08:00:00.000Z",
        );
      } finally {
        database.close();
      }

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        await expect(
          reopened.execute(claimCommand, { principalId: "principal-orbit" }),
        ).rejects.toMatchObject({ code: "Forbidden" });
        await expect(
          reopened.execute(activationCommand, {
            principalId: "principal-orbit",
            activationId: "activation-stale",
          }),
        ).rejects.toMatchObject({ code: "Forbidden" });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a current-schema writer before opening another connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-init-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    let holder: HeldWriteLock | undefined;
    let pendingOpen: PendingBusyOperation | undefined;
    try {
      const initialized = TorsorKernel.open({ databasePath, bootstrap });
      await initialized.execute(
        {
          type: "StartThread",
          idempotencyKey: "open-contention-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Preserve current-schema state through opener contention.",
        },
        humanContext,
      );
      initialized.close();

      holder = await holdWriteLock(databasePath);
      pendingOpen = openKernelWithShortBusyTimeout(databasePath);
      const busy = await pendingOpen.busy;
      expect(busy).toMatchObject({
        errcode: 5,
        message: expect.stringMatching(/database is locked/i),
      });
      expect(busy.elapsedMs).toBeGreaterThanOrEqual(100);
      holder.release();
      await holder.committed;
      const follower = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const projection = await follower.query(
          { type: "GetBootstrap", projectId: "project-sample" },
          humanContext,
        );
        expect(projection.project.id).toBe("project-sample");
        expect((await follower.readEvents(null, 100))).toHaveLength(1);
      } finally {
        follower.close();
      }
    } finally {
      if (pendingOpen) {
        await pendingOpen.worker.terminate();
      }
      if (holder) {
        await holder.worker.terminate();
      }
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

  it("rejects incompatible and unversioned development schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-"));
    const unsupportedPath = join(directory, "unsupported.sqlite");
    const unversionedPath = join(directory, "unversioned.sqlite");
    try {
      const unsupported = new DatabaseSync(unsupportedPath);
      unsupported.exec(
        "CREATE TABLE preserved_state (id TEXT PRIMARY KEY); PRAGMA user_version = 1",
      );
      unsupported.close();
      expect(() =>
        TorsorKernel.open({ databasePath: unsupportedPath, bootstrap }),
      ).toThrow(
        /Incompatible development database schema version 1.*Stop old Torsor processes.*recreate the disposable local database/,
      );
      const preserved = new DatabaseSync(unsupportedPath, { readOnly: true });
      try {
        expect(
          preserved
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preserved_state'",
            )
            .get(),
        ).toMatchObject({ name: "preserved_state" });
        expect(preserved.prepare("PRAGMA journal_mode").get()).toMatchObject({
          journal_mode: "delete",
        });
        expect(preserved.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: 1,
        });
      } finally {
        preserved.close();
      }

      const unversioned = new DatabaseSync(unversionedPath);
      unversioned.exec("CREATE VIEW preserved_view AS SELECT 1 AS value");
      unversioned.close();
      expect(() =>
        TorsorKernel.open({ databasePath: unversionedPath, bootstrap }),
      ).toThrow(
        /incompatible unversioned development schema.*Stop old Torsor processes.*recreate the disposable local database/i,
      );
      const unmodified = new DatabaseSync(unversionedPath, { readOnly: true });
      try {
        expect(
          unmodified
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'preserved_view'",
            )
            .get(),
        ).toMatchObject({ name: "preserved_view" });
        expect(unmodified.prepare("PRAGMA journal_mode").get()).toMatchObject({
          journal_mode: "delete",
        });
        expect(
          unmodified
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'principals'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        unmodified.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
