import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DeterministicFakeAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import { LocalArtifactStorage, TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import { createLocalRuntimeHost } from "../src/index.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import { holdSqliteWriter } from "../../../packages/agent-runtime/test/fixtures/sqlite-lock.js";
import { nodeProbeDriver, type ControlledChild } from "../../../packages/agent-runtime/src/controlled-process.js";

describe("orphaned physical Writer Host recovery (MVP 22.2)", () => {
  it("keeps Kernel available and retries Host close after physical stop persistence fails", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    let kernel!: TorsorKernel;
    let executor!: LocalWorktreeExecutor;
    let actual!: ControlledChild;
    const requests = vi.fn(() => actual.requestStop());
    const timeoutKey = Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms");
    Reflect.set(globalThis, timeoutKey, 100);
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
    Reflect.deleteProperty(globalThis, timeoutKey);
    let release: (() => Promise<void>) | undefined;
    try {
      const run = await activeRun(kernel, "host-close-retry");
      await executor.register({
        worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
      });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      await child.result;
      release = await holdSqliteWriter(repo.databasePath);
      await expect(host.close()).rejects.toThrow();
      await actual.closed;
      expect(requests).toHaveBeenCalledTimes(1);
      await expect(host.start()).rejects.toThrow(/closed/);
      await release();
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
      await release?.();
      actual?.forceStop();
      if (actual) await actual.closed;
      await host.close();
      repo.dispose();
    }
  });

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
