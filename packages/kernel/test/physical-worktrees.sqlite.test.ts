import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { bootstrap, createRun, runtimeContext } from "./helpers.js";

describe("physical Worktree SQLite fencing (§22.3)", () => {
  it("persists the pre-spawn intent across restart and refuses schema 13 without changing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torsor-physical-intent-"));
    const databasePath = join(directory, "kernel.sqlite");
    let kernel = TorsorKernel.open({ databasePath, bootstrap });
    try {
      const run = await createRun(kernel);
      await kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "physical",
        worktreeId: "tree", runId: run.runId, repositoryId: "synthetic",
        repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "synthetic-private-tree", directoryIdentity: "1:2",
      }, runtimeContext);
      const lease = await kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "lease",
        worktreeId: "tree", leaseDurationMs: 30_000,
      }, runtimeContext);
      const intent = await kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "intent", worktreeId: "tree",
        activationId: run.activationId, executorId: "old-host",
        generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!, leaseToken: lease.leaseToken!,
      }, runtimeContext);
      kernel.close();
      kernel = TorsorKernel.open({ databasePath });
      expect(await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext))
        .toMatchObject({ latestExecution: { state: "Starting", pid: null } });
      await kernel.execute({
        type: "RecoverWorktreeExecution", idempotencyKey: "recover", executionId: intent.entityId,
        reason: "Restart cannot distinguish before-spawn from after-spawn crash.",
      }, runtimeContext);
      await expect(kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "unsafe",
        worktreeId: "tree", leaseDurationMs: 30_000,
      }, runtimeContext)).rejects.toMatchObject({ code: "DomainBusy" });
      const priorPath = join(directory, "schema13.sqlite");
      const prior = new DatabaseSync(priorPath);
      prior.exec("CREATE TABLE retained (id INTEGER); INSERT INTO retained VALUES (1); PRAGMA user_version = 13;");
      prior.close();
      expect(() => TorsorKernel.open({ databasePath: priorPath })).toThrow(/schema version 13; expected 14/);
      const unchanged = new DatabaseSync(priorPath, { readOnly: true });
      try { expect(unchanged.prepare("SELECT id FROM retained").get()).toMatchObject({ id: 1 }); }
      finally { unchanged.close(); }
    } finally {
      kernel.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one racing acquisition through independent worker connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torsor-physical-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    const kernel = TorsorKernel.open({ databasePath, bootstrap });
    const workers: Worker[] = [];
    try {
      const run = await createRun(kernel);
      await kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "physical",
        worktreeId: "tree", runId: run.runId, repositoryId: "synthetic",
        repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "synthetic-private-tree", directoryIdentity: "1:2",
      }, runtimeContext);
      const signal = new SharedArrayBuffer(4);
      const ready: Promise<void>[] = [];
      const results: Promise<string>[] = [];
      for (let index = 0; index < 2; index++) {
        const worker = new Worker(`
          const { parentPort, workerData } = require("node:worker_threads");
          (async () => {
            const { TorsorKernel } = await import(workerData.module);
            const kernel = TorsorKernel.open({ databasePath: workerData.databasePath });
            parentPort.postMessage("ready");
            Atomics.wait(new Int32Array(workerData.signal), 0, 0);
            try {
              await kernel.execute({
                type: "AcquireWorktreeWriterLease", idempotencyKey: "race-" + workerData.index,
                worktreeId: "tree", leaseDurationMs: 30000,
              }, { principalId: "principal-runtime" });
              parentPort.postMessage("acquired");
            } catch (error) { parentPort.postMessage(error.code ?? String(error)); }
            finally { kernel.close(); }
          })().catch(error => { throw error; });
        `, { eval: true, workerData: {
          module: new URL("../dist/index.js", import.meta.url).href,
          databasePath, signal, index,
        } });
        workers.push(worker);
        ready.push(new Promise((resolve, reject) => {
          worker.on("message", (message) => { if (message === "ready") resolve(); });
          worker.once("error", reject);
        }));
        results.push(new Promise((resolve, reject) => {
          worker.on("message", (message: string) => { if (message !== "ready") resolve(message); });
          worker.once("error", reject);
        }));
      }
      await Promise.all(ready);
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0);
      expect((await Promise.all(results)).sort()).toEqual(["DomainBusy", "acquired"]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      kernel.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
