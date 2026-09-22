import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DeterministicFakeAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import { KernelError, LocalArtifactStorage, TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import { createLocalRuntimeHost } from "../src/index.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import { observeLockedChildren } from "../../../packages/agent-runtime/test/fixtures/sqlite-lock.js";
import { nodeProbeDriver, type ControlledChild } from "../../../packages/agent-runtime/src/controlled-process.js";

describe("orphaned physical Writer Host recovery (MVP 22.2)", () => {
  it("keeps Kernel available and retries Host close after physical stop persistence fails", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    let kernel!: TorsorKernel;
    let executor!: LocalWorktreeExecutor;
    let actual!: ControlledChild;
    const stops = new BigInt64Array(new SharedArrayBuffer(8));
    const requests = vi.fn(() => {
      Atomics.compareExchange(stops, 0, 0n, BigInt(Date.now()));
      actual.requestStop();
    });
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap,
      credentials: [{ token: "synthetic-human", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], adapter: new DeterministicFakeAdapter(),
      worktreeExecutorFactory: (owned) => {
        kernel = owned;
        executor = new LocalWorktreeExecutor({
          kernel, runtimePrincipalId: "runtime", ...repo,
          driver: { start: (input) => {
            actual = nodeProbeDriver.start(input);
            return { ...actual, requestStop: requests };
          } },
        });
        return executor;
      },
    });
    let lock: Awaited<ReturnType<typeof observeLockedChildren>> | undefined;
    let queued: NodeJS.Timeout | undefined;
    try {
      const run = await activeRun(kernel, "host-close-retry");
      await executor.register({
        worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
      });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      await child.result;
      lock = await observeLockedChildren(repo.databasePath, [actual.pid!], stops);
      const closing = new Promise<unknown>((resolve) => {
        queued = setTimeout(() => { void host.close().then(resolve, resolve); }, 300);
      });
      const observed = await lock.observation;
      expect(observed.alive).toEqual([false]);
      expect(observed.stopRequestedAt[0]! - lock.lockedAt).toBeLessThan(700);
      expect(await closing).toBeInstanceOf(Error);
      await actual.closed;
      expect(requests).toHaveBeenCalledTimes(1);
      await expect(host.start()).rejects.toThrow(/closed/);
      await lock.released;
      expect(Date.now() - lock.lockedAt).toBeGreaterThanOrEqual(6500);
      await host.close();
      await host.close();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        expect(await reopened.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
          .toMatchObject({ state: "Ready", latestExecution: {
            state: "StopConfirmed", authorityRevokedAt: expect.any(String),
          } });
      } finally { reopened.close(); }
    } finally {
      clearTimeout(queued);
      await lock?.release();
      actual?.forceStop();
      if (actual) await actual.closed;
      await host.close();
      repo.dispose();
    }
  }, 20_000);

  it.each(["terminal-winner", "unrelated-conflict", "unfinished-conflict"] as const)(
    "conditionally settles recovery during a two-Host interleaving: %s",
    async (mode) => {
      const repo = syntheticRepository();
      repo.addWorktree("first");
      const committed = gate();
      const resumeOriginal = gate();
      const fallback = gate();
      const resumeReplacement = gate();
      const failed = gate();
      let source = "";
      let runId = "";
      let originalKernel!: TorsorKernel;
      let originalExecutor!: LocalWorktreeExecutor;
      const options = {
        databasePath: repo.databasePath, bootstrap,
        credentials: [{ token: "synthetic-human", principalContext: { principalId: "human" } }],
        runtimePrincipalId: "runtime", projectIds: ["project"], port: 0, runtimePollIntervalMs: 5,
      };
      const original = createLocalRuntimeHost({
        ...options,
        artifactStorage: await LocalArtifactStorage.open(join(repo.directory, "artifacts")),
        adapter: new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type === "attention") {
            runId = await context.capabilities.createRunFromAttention();
            await originalExecutor.register({
              worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId,
            });
            return;
          }
          source = context.activationId;
          await context.worktree!.probe("first");
          await context.capabilities.publishReport({ idempotencyKey: "race-report", text: "Synthetic report." });
          await context.capabilities.publishReply({ body: "Synthetic committed reply." });
          await context.capabilities.appendActivity("status", { text: "Synthetic committed activity." });
          await context.capabilities.complete({ incorporatedThroughInputSequence: 1 });
        }),
        worktreeExecutorFactory(kernel) {
          originalKernel = kernel;
          const execute = kernel.execute.bind(kernel);
          vi.spyOn(kernel, "execute").mockImplementation(async (command, context) => {
            const result = await execute(command, context);
            if (source && command.type === "FinishProviderAttempt" && command.status === "Completed") {
              committed.resolve();
              await resumeOriginal.promise;
            }
            if (command.type === "FinishActivation" && command.activationId === source && command.outcome === "Failed") {
              failed.resolve();
            }
            return result;
          });
          originalExecutor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
          return originalExecutor;
        },
      });
      let replacement: ReturnType<typeof createLocalRuntimeHost> | undefined;
      try {
        const thread = await originalKernel.execute({
          type: "StartThread", idempotencyKey: "two-host-race", projectId: "project", channelId: "channel",
          body: "Synthetic concurrent recovery.", targetAgentIds: ["orbit"],
        }, { principalId: "human" });
        await original.start();
        await committed.promise;
        const before = facts(repo.databasePath);
        expect((await originalKernel.query({ type: "GetRunProjection", runId }, runtimeContext)).run.state)
          .toBe("Completed");
        const clock = () => new Date(Date.now() + 60_000);
        replacement = createLocalRuntimeHost({
          ...options, clock,
          adapter: new DeterministicFakeAdapter(async () => { throw new Error("Committed work must not rerun."); }),
          worktreeExecutorFactory(kernel) {
            const execute = kernel.execute.bind(kernel);
            vi.spyOn(kernel, "execute").mockImplementation(async (command, context) => {
              if (command.type === "FinishActivation" && command.idempotencyKey === `${source}:reconciled-authority-lost`) {
                fallback.resolve();
                await resumeReplacement.promise;
                if (mode !== "terminal-winner") {
                  throw new KernelError("Conflict", mode === "unfinished-conflict"
                    ? "The Activation is already finished." : "Synthetic unrelated conflict.");
                }
              }
              return execute(command, context);
            });
            return new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
          },
        });
        const origin = await replacement.start();
        await Promise.race([fallback.promise, replacement.finished]);
        if (mode !== "unfinished-conflict") {
          resumeOriginal.resolve();
          await failed.promise;
        }
        resumeReplacement.resolve();
        if (mode === "terminal-winner") {
          await Promise.race([
            waitForSettlement(repo.databasePath, source),
            replacement.finished.then(() => { throw new Error("Replacement stopped during settlement."); }),
          ]);
          const response = await fetch(`${origin}/api/v1/threads/${thread.entityId}`, {
            headers: { Authorization: "Bearer synthetic-human" },
          });
          expect(response.status).toBe(200);
          expect(facts(repo.databasePath)).toEqual(before);
          const inspection = new DatabaseSync(repo.databasePath, { readOnly: true });
          try {
            expect(inspection.prepare("SELECT outcome FROM activation_attempts WHERE id = ?").get(source)?.outcome)
              .toBe("Failed");
            expect(inspection.prepare("SELECT count(*) AS count FROM public_events WHERE type = 'ActivationFinished' AND entity_id = ?")
              .get(source)?.count).toBe(1);
          } finally { inspection.close(); }
          await replacement.close();
          for (let restart = 0; restart < 2; restart++) {
            const restarted = createLocalRuntimeHost({
              ...options, clock,
              adapter: new DeterministicFakeAdapter(async () => { throw new Error("Must not rerun committed work."); }),
              worktreeExecutorFactory: (kernel) => new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo }),
            });
            try {
              await restarted.start();
              await Promise.race([waitForSettlement(repo.databasePath, source), restarted.finished]);
              expect(facts(repo.databasePath)).toEqual(before);
            } finally { await restarted.close(); }
          }
        } else {
          await expect(replacement.finished).rejects.toMatchObject({ code: "Conflict" });
        }
      } finally {
        resumeOriginal.resolve();
        resumeReplacement.resolve();
        await Promise.allSettled([original.close(), replacement?.close()]);
        repo.dispose();
      }
    }, 20_000,
  );

  it.each(["Completed", "Failed", "Unknown", "Waiting", "Waiting-stale"])(
    "survives repeated Host restart after committed %s without duplicating work",
    async (outcome) => {
      const repo = syntheticRepository();
      repo.addWorktree("first");
      const artifactRoot = join(repo.directory, "artifacts");
      const seed = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
      const thread = await seed.execute({
        type: "StartThread", idempotencyKey: "crash-recovery", projectId: "project", channelId: "channel",
        body: "Synthetic recovery request.", targetAgentIds: ["orbit"],
      }, { principalId: "human" });
      seed.close();
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("./fixtures/worktree-settlement-crash.mjs", import.meta.url)),
        JSON.stringify({ ...repo, artifactRoot, outcome }),
      ], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
      let diagnostics = "";
      child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("close", resolve); child.once("error", reject);
        });
        expect(code, diagnostics).toBe(77);
        const before = facts(repo.databasePath);
        const inspection = TorsorKernel.open({ databasePath: repo.databasePath });
        const physical = await inspection.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext);
        const source = physical.latestExecution!.activationId;
        const projection = await inspection.query({ type: "GetRunProjection", runId: physical.runId }, runtimeContext);
        expect(projection.activations.find((activation) => activation.id === source)?.finishedAt).toBeNull();
        expect(projection.providerAttempts.find((attempt) => attempt.activationId === source)?.status)
          .toBe(outcome.startsWith("Waiting") ? "Completed" : outcome);
        if (outcome === "Waiting-stale") {
          expect(projection.run.activationGeneration).toBeGreaterThan(
            projection.activations.find((activation) => activation.id === source)!.runActivationGeneration!,
          );
        }
        inspection.close();
        const clock = () => new Date(Date.now() + 60_000);
        let calls = 0;
        for (let restart = 0; restart < 2; restart++) {
          const host = createLocalRuntimeHost({
            databasePath: repo.databasePath, artifactStorage: await LocalArtifactStorage.open(artifactRoot),
            credentials: [{ token: "synthetic-human", principalContext: { principalId: "human" } }],
            runtimePrincipalId: "runtime", projectIds: ["project"], port: 0, clock, runtimePollIntervalMs: 5,
            adapter: new DeterministicFakeAdapter(async () => { calls++; throw new Error("Must not rerun committed work."); }),
            worktreeExecutorFactory: (kernel) => new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo }),
          });
          try {
            const origin = await host.start();
            await expect(Promise.race([
              waitForSettlement(repo.databasePath, source),
              host.finished.then(() => { throw new Error("Host stopped during recovery."); }),
            ])).resolves.toBeUndefined();
            const response = await fetch(`${origin}/api/v1/threads/${thread.entityId}`, {
              headers: { Authorization: "Bearer synthetic-human" },
            });
            expect(response.status).toBe(200);
          } finally { await host.close(); }
          expect(facts(repo.databasePath)).toEqual(before);
          const settled = new DatabaseSync(repo.databasePath, { readOnly: true });
          try {
            expect(settled.prepare("SELECT outcome FROM activation_attempts WHERE id = ?").get(source)?.outcome)
              .toBe(outcome === "Failed" ? "Failed" : "Expired");
            expect(settled.prepare("SELECT count(*) AS count FROM public_events WHERE type = 'ActivationFinished' AND entity_id = ?")
              .get(source)?.count).toBe(1);
          } finally { settled.close(); }
        }
        expect(calls).toBe(0);
      } finally {
        child.kill("SIGKILL");
        repo.dispose();
      }
    },
  );
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function facts(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      runs: database.prepare("SELECT * FROM runs ORDER BY id").all(),
      attempts: database.prepare("SELECT * FROM provider_attempts ORDER BY id").all(),
      artifacts: database.prepare("SELECT * FROM artifacts ORDER BY id").all(),
      activities: database.prepare("SELECT * FROM run_activity_events ORDER BY id").all(),
      messages: database.prepare("SELECT * FROM messages ORDER BY id").all(),
      events: database.prepare("SELECT * FROM public_events WHERE type != 'ActivationFinished' ORDER BY sequence").all(),
    };
  } finally { database.close(); }
}

async function waitForSettlement(path: string, activationId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const activation = database.prepare("SELECT finished_at FROM activation_attempts WHERE id = ?").get(activationId);
      const pending = database.prepare("SELECT count(*) AS count FROM outbox_events WHERE acknowledged_at IS NULL").get();
      if (activation?.finished_at !== null && pending?.count === 0) return;
    } finally { database.close(); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Host failed to settle and acknowledge the orphaned Activation.");
}
