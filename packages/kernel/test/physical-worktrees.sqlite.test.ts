import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { bootstrap, createRun, runtimeContext } from "./helpers.js";

describe("physical Worktree SQLite fencing (§22.3)", () => {
  it("uses no-wait supervision scopes without weakening transactions or changing the configured timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torsor-physical-no-wait-"));
    const databasePath = join(directory, "kernel.sqlite");
    let clock = new Date("2026-09-23T00:00:00Z");
    const put = vi.fn(async () => {});
    const kernel = TorsorKernel.open({
      databasePath, bootstrap, clock: () => clock,
      artifactStorage: { put, read: async () => Buffer.from("Synthetic report.") },
    });
    const holder = new DatabaseSync(databasePath);
    let sql: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const run = await createRun(kernel);
      await kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "physical", worktreeId: "tree", runId: run.runId,
        repositoryId: "synthetic", repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "synthetic-private-tree", directoryIdentity: "1:2",
      }, runtimeContext);
      const lease = await kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "lease", worktreeId: "tree", leaseDurationMs: 1000,
      }, runtimeContext);
      const binding = {
        worktreeId: "tree", generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!,
        leaseToken: lease.leaseToken!, executorId: "synthetic-host",
      };
      const intent = await kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "intent", ...binding, activationId: run.activationId,
      }, runtimeContext);
      const authority = { ...binding, executionId: intent.entityId, executionToken: intent.executionToken! };
      const effect = vi.fn(() => undefined);
      kernel.performWorktreeMutation(authority, runtimeContext, effect);
      holder.exec("BEGIN IMMEDIATE");
      const statements = vi.spyOn(DatabaseSync.prototype, "exec");
      sql = statements;
      const restored = () => expect(statements.mock.calls.at(-1)).toEqual(["PRAGMA busy_timeout = 5000"]);
      const before = performance.now();
      kernel.checkWorktreeAuthority(authority, runtimeContext);
      restored();
      expect(() => kernel.performWorktreeMutation(authority, runtimeContext, effect)).toThrow(/locked/);
      restored();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(() => kernel.checkWorktreePublication(authority, runtimeContext)).toThrow(/locked/);
      restored();
      await expect(kernel.execute({
        type: "RevokeWorktreeExecutionAuthority", idempotencyKey: "revoke", ...authority, reason: "Synthetic stop.",
      }, runtimeContext)).rejects.toThrow(/locked/);
      restored();
      await expect(kernel.query({ type: "GetWorktreeWriterLease", worktreeId: "tree" }, runtimeContext))
        .rejects.toThrow(/locked/);
      restored();
      await expect(kernel.finalizeReport({
        idempotencyKey: "blocked-report", runId: run.runId, expectedRunRevision: 1, content: Buffer.from("Synthetic report."),
      }, run.agentContext)).rejects.toThrow(/locked/);
      restored();
      expect(put).not.toHaveBeenCalled();
      expect(performance.now() - before).toBeLessThan(500);
      clock = new Date("2026-09-23T00:00:01Z");
      expect(() => kernel.checkWorktreeAuthority(authority, runtimeContext)).toThrow();
      restored();
      holder.exec("ROLLBACK");
      expect(holder.prepare("SELECT authority_revoked_at FROM worktree_executions").get()?.authority_revoked_at).toBeNull();
      expect(holder.prepare("SELECT status FROM worktree_writer_leases").get()?.status).toBe("Active");
      expect(() => kernel.checkWorktreeAuthority(authority, runtimeContext)).toThrow();
      restored();
      expect(holder.prepare("SELECT authority_revoked_at FROM worktree_executions").get()?.authority_revoked_at).toBeNull();
      expect(() => kernel.performWorktreeMutation(authority, runtimeContext, effect))
        .toThrow(expect.objectContaining({ code: "WriterAuthorityLost" }));
      restored();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(holder.prepare("SELECT authority_revoked_at FROM worktree_executions").get()?.authority_revoked_at).not.toBeNull();
    } finally {
      sql?.mockRestore();
      holder.close();
      kernel.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      expect(() => TorsorKernel.open({ databasePath: priorPath })).toThrow(/schema version 13; expected 17/);
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
