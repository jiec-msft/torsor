import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  TorsorKernel,
  type PhysicalWorktreeView,
} from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import {
  runTrustedLocalScenario,
  type TrustedLocalScenario,
} from "../src/trusted-local.js";

const providerFixturePath = fileURLToPath(new URL(
  "fixtures/trusted-local-provider.mjs",
  import.meta.url,
));
const deliberateFailure = "Synthetic deliberate trusted-local scenario failure.";

describe("trusted-local production lifecycle", () => {
  it("SS-3.10.1: completes through the production Host, Worktree owner, HTTP, SSE, and Web projection", async () => {
    vi.useRealTimers();
    await runTrustedLocalScenario({ providerMode: "success" }, async (system) => {
      await system.startThread();
      const tree = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "StopConfirmed",
        "normal trusted-local physical settlement",
      );
      const run = await system.waitForRun(
        tree.runId,
        (candidate) => candidate.run.state === "Completed",
        "normal trusted-local Run completion",
      );
      expect(tree.latestExecution).toMatchObject({
        state: "StopConfirmed",
        authorityRevokedAt: expect.any(String),
        provider: {
          providerAttemptId: run.providerAttempts.at(-1)?.id,
          policy: "trusted-local",
          permissionMode: "allow-all",
        },
      });
      expect(run.providerAttempts.at(-1)?.status).toBe("Completed");
      expect(run.activity.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_completed",
          payload: expect.objectContaining({ kind: "execute" }),
        }),
      ]));
      expect(readFileSync(join(tree.directoryPath, "native-result.txt"), "utf8"))
        .toBe("Synthetic native edit.\n");
      execFileSync(process.execPath, ["--test", "synthetic.test.cjs"], {
        cwd: tree.directoryPath,
        env: {},
        stdio: "ignore",
        timeout: 10_000,
      });

      const latestEventId = await system.sync();
      expect(latestEventId).not.toBeNull();
      expect(system.web.getSnapshot().lastEventId).toBe(latestEventId);
      expect(await system.web.loadRun(tree.runId)).toBe(true);
      expect(system.web.getSnapshot().run?.run.state).toBe("Completed");
      const publicEvidence = JSON.stringify({
        events: system.events,
        run: system.web.getSnapshot().run,
      });
      expect(publicEvidence).toContain("tool_completed");
      expectPrivateExecutionValuesAbsent(publicEvidence, system, tree);

      const outbox = await system.kernel.query(
        { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
        system.runtimePrincipal,
      );
      const delivery = outbox.items.filter((event) =>
        event.aggregateId === tree.runId &&
        (event.topic === "run.activation-requested" ||
          event.topic === "run-input.available")
      );
      expect(delivery.length).toBeGreaterThan(0);
      expect(delivery.every((event) => event.acknowledgedAt !== null)).toBe(true);
    });
  });

  it("SS-3.10.2: quarantines an unconfirmed Human cancellation and preserves it across recovery", async () => {
    vi.useRealTimers();
    await runTrustedLocalScenario({
      providerMode: "stubborn-hang",
      stopGraceMs: 1,
      forceGraceMs: 1,
    }, async (system) => {
      await system.startThread();
      const running = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "Running",
        "stubborn trusted-local Provider start",
      );
      const processIds = await system.readOwnedProcessIds(running);
      expect(await system.web.loadRun(running.runId)).toBe(true);
      expect(await system.web.cancelRun(running.runId)).toBe(true);

      const uncertain = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "Uncertain",
        "unconfirmed owned process-tree stop",
      );
      const cancelled = await system.waitForRun(
        running.runId,
        (candidate) => candidate.run.state === "Cancelled" &&
          candidate.providerAttempts.at(-1)?.status === "Unknown",
        "cancelled Run with unknown Provider settlement",
      );
      expect(cancelled.run.state).toBe("Cancelled");
      expect(uncertain).toMatchObject({
        state: "Quarantined",
        latestExecution: {
          state: "Uncertain",
          authorityRevokedAt: expect.any(String),
        },
      });
      await expect(system.kernel.execute({
        type: "AcquireWorktreeWriterLease",
        idempotencyKey: "replacement-before-confirmation",
        worktreeId: uncertain.worktreeId,
        leaseDurationMs: 30_000,
      }, system.runtimePrincipal)).rejects.toMatchObject({
        code: "DomainBusy",
      });
      await system.waitForProcessesGone(processIds);

      const latestEventId = await system.sync();
      expect(latestEventId).not.toBeNull();
      expect(system.web.getSnapshot().lastEventId).toBe(latestEventId);
      expect(await system.web.loadRun(running.runId)).toBe(true);
      expect(system.web.getSnapshot().run?.run.state).toBe("Cancelled");
      const publicEvidence = JSON.stringify({
        events: system.events,
        run: system.web.getSnapshot().run,
      });
      expectPrivateExecutionValuesAbsent(publicEvidence, system, uncertain);

      const recovered = await system.recoverWithFreshExecutor();
      const recoveredTree = await recovered.kernel.query(
        { type: "GetPhysicalWorktree", worktreeId: uncertain.worktreeId },
        system.runtimePrincipal,
      );
      expect(recoveredTree).toMatchObject({
        state: "Quarantined",
        latestExecution: { state: "Uncertain" },
      });
      await expect(recovered.kernel.execute({
        type: "AcquireWorktreeWriterLease",
        idempotencyKey: "replacement-after-recovery",
        worktreeId: uncertain.worktreeId,
        leaseDurationMs: 30_000,
      }, system.runtimePrincipal)).rejects.toMatchObject({
        code: "DomainBusy",
      });
    });
    await expectUnconfirmedCleanupPreserved();
  });

  it("SS-3.10.3: propagates an independent fence and never falsely acknowledges delivery", async () => {
    vi.useRealTimers();
    await runTrustedLocalScenario({
      providerMode: "safe-hang",
      cancellationPollMs: 1,
    }, async (system) => {
      await system.startThread();
      const running = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "Running",
        "fenced trusted-local Provider start",
      );
      const processIds = await system.readOwnedProcessIds(running);
      const run = await system.kernel.query(
        { type: "GetRunProjection", runId: running.runId },
        system.human,
      );
      const quarantined = await system
        .quarantineActiveWriter(running.worktreeId)
        .then(async (result) => {
          await system.kernel.execute({
            type: "CancelRun",
            idempotencyKey: "human-cancel-after-independent-fence",
            runId: running.runId,
            expectedRunRevision: run.run.revision,
            reason: "Synthetic Human cancellation after independent fence.",
          }, system.human);
          return result;
        });
      expect(quarantined.worktreeWriterLease).toMatchObject({
        status: "Quarantined",
        generation: running.latestExecution?.generation,
        fencingToken: (running.latestExecution?.fencingToken ?? 0) + 1,
      });

      await system.expectHostFailure((error) => {
        expect(error).toMatchObject({
          diagnosticCode: "provider_worktree_authority_lost",
          outcome: "Unknown",
        });
      });
      await system.waitForProcessesGone(processIds);

      const reopened = TorsorKernel.open({
        databasePath: system.paths.databasePath,
      });
      try {
        const tree = await reopened.query(
          { type: "GetPhysicalWorktree", worktreeId: running.worktreeId },
          system.runtimePrincipal,
        );
        expect(tree.latestExecution?.state).toBe("StopConfirmed");
        const finalRun = await reopened.query(
          { type: "GetRunProjection", runId: running.runId },
          system.human,
        );
        expect(finalRun.run.state).toBe("Cancelled");
        expect(finalRun.providerAttempts.at(-1)?.status).toBe("Unknown");
        const outbox = await reopened.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          system.runtimePrincipal,
        );
        const delivery = outbox.items.filter((event) =>
          event.aggregateId === running.runId &&
          (event.topic === "run.activation-requested" ||
            event.topic === "run-input.available")
        );
        expect(delivery.length).toBeGreaterThan(0);
        expect(delivery.every((event) => event.acknowledgedAt === null)).toBe(true);
        await expect(reopened.execute({
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "replacement-while-fenced",
          worktreeId: running.worktreeId,
          leaseDurationMs: 30_000,
        }, system.runtimePrincipal)).rejects.toMatchObject({
          code: "DomainBusy",
        });
        const writerLease = await reopened.query(
          { type: "GetWorktreeWriterLease", worktreeId: running.worktreeId },
          system.runtimePrincipal,
        );
        await reopened.execute({
          type: "ResolveWorktreeWriterLeaseQuarantine",
          idempotencyKey: randomId("resolve"),
          worktreeId: running.worktreeId,
          expectedRevision: writerLease.revision,
          expectedFencingToken: writerLease.fencingToken,
          quarantineToken: quarantined.quarantineToken!,
          resolution: "Synthetic review confirmed the owned process tree stopped.",
        }, system.runtimePrincipal);
        expect(await reopened.query(
          { type: "GetWorktreeWriterLease", worktreeId: running.worktreeId },
          system.runtimePrincipal,
        )).toMatchObject({
          status: "Released",
          quarantineResolvedAt: expect.any(String),
        });
      } finally {
        reopened.close();
      }
    });
  });
});

function randomId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function expectPrivateExecutionValuesAbsent(
  publicEvidence: string,
  system: TrustedLocalScenario,
  tree: PhysicalWorktreeView,
): void {
  const privateValues = [
    "synthetic-private",
    tree.directoryPath,
    system.paths.directory,
    system.paths.databasePath,
    system.paths.repositoryPath,
    system.paths.rootPath,
    process.execPath,
    providerFixturePath,
    join(tree.directoryPath, "native-result.txt"),
    "native-result.txt",
    "synthetic.test.cjs",
    "--input-type=commonjs",
    "--test",
  ];
  const serialized = publicEvidence.toLowerCase();
  for (const value of privateValues) {
    const variants = new Set([value, value.replaceAll("\\", "/")]);
    for (const variant of variants) {
      const encoded = JSON.stringify(variant).slice(1, -1).toLowerCase();
      expect(serialized, `public evidence exposed private execution value: ${value}`)
        .not.toContain(encoded);
    }
  }
}

async function expectUnconfirmedCleanupPreserved(): Promise<void> {
  let directory: string | undefined;
  let pidFixturePath: string | undefined;
  let rejection: unknown;
  try {
    await runTrustedLocalScenario({
      providerMode: "stubborn-hang",
      stopGraceMs: 1,
      forceGraceMs: 1,
    }, async (system) => {
      await system.startThread();
      const running = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "Running",
        "cleanup-regression stubborn Provider start",
      );
      directory = system.paths.directory;
      pidFixturePath = join(running.directoryPath, "owned-processes.json");
      await waitFor(
        () => existsSync(pidFixturePath!),
        "cleanup-regression PID fixture",
      );
      expect(false, deliberateFailure).toBe(true);
    });
  } catch (error) {
    rejection = error;
  }

  try {
    expect(rejection).toBeInstanceOf(AggregateError);
    const messages = collectErrorMessages(rejection);
    expect(messages.some((message) => message.includes(deliberateFailure))).toBe(true);
    expect(messages.some((message) =>
      message.includes("Preserved trusted-local scenario state at ")
    )).toBe(true);
    expect(directory).toBeDefined();
    expect(pidFixturePath).toBeDefined();
    expect(existsSync(directory!)).toBe(true);
  } finally {
    if (directory && pidFixturePath && existsSync(directory)) {
      const pids = readProcessIds(pidFixturePath);
      await waitFor(
        () => pids.every((pid) => !processExists(pid)),
        "cleanup-regression owned process tree to stop",
      );
      await rm(directory, { recursive: true, force: true });
    }
  }
  expect(existsSync(directory!)).toBe(false);
}

function collectErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.flatMap((item) => collectErrorMessages(item)),
    ];
  }
  return [error instanceof Error ? error.message : String(error)];
}

function readProcessIds(path: string): readonly number[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value) || value.length !== 2 ||
      value.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error("Cleanup regression fixture recorded invalid process identities.");
  }
  return value as number[];
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await delay(10);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
