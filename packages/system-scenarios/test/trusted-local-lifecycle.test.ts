import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("SS-3.10.2: confirms Windows forced stop or quarantines unconfirmed Linux stop after Human cancellation", async () => {
    vi.useRealTimers();
    const confirmed = process.platform === "win32";
    const stopState = confirmed ? "ForceTerminated" : "Uncertain";
    const treeState = confirmed ? "Ready" : "Quarantined";
    await runTrustedLocalScenario({
      providerMode: "stubborn-hang",
      stopGraceMs: 1,
      forceGraceMs: confirmed ? 2_000 : 1,
    }, async (system) => {
      await system.startThread();
      const running = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === "Running",
        "stubborn trusted-local Provider start",
      );
      const processIds = await system.readOwnedProcessIds(running);
      expect(await system.web.loadRun(running.runId)).toBe(true);
      expect(await system.web.cancelRun(running.runId)).toBe(true);

      const stopped = await system.waitForTree(
        (candidate) => candidate.latestExecution?.state === stopState,
        confirmed ? "confirmed forced process-tree stop" : "unconfirmed owned process-tree stop",
      );
      const cancelled = await system.waitForRun(
        running.runId,
        (candidate) => candidate.run.state === "Cancelled" &&
          candidate.providerAttempts.at(-1)?.status === "Unknown",
        "cancelled Run with unknown Provider settlement",
      );
      expect(cancelled.run.state).toBe("Cancelled");
      expect(stopped).toMatchObject({
        state: treeState,
        latestExecution: {
          state: stopState,
          authorityRevokedAt: expect.any(String),
        },
      });
      if (!confirmed) {
        await expect(system.kernel.execute({
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "replacement-before-confirmation",
          worktreeId: stopped.worktreeId,
          leaseDurationMs: 30_000,
        }, system.runtimePrincipal)).rejects.toMatchObject({
          code: "DomainBusy",
        });
      }
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
      expectPrivateExecutionValuesAbsent(publicEvidence, system, stopped);

      const recovered = await system.recoverWithFreshExecutor();
      const recoveredTree = await recovered.kernel.query(
        { type: "GetPhysicalWorktree", worktreeId: stopped.worktreeId },
        system.runtimePrincipal,
      );
      expect(recoveredTree).toMatchObject({
        state: treeState,
        latestExecution: { state: stopState },
      });
      if (!confirmed) {
        await expect(recovered.kernel.execute({
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "replacement-after-recovery",
          worktreeId: stopped.worktreeId,
          leaseDurationMs: 30_000,
        }, system.runtimePrincipal)).rejects.toMatchObject({
          code: "DomainBusy",
        });
      }
    });
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
