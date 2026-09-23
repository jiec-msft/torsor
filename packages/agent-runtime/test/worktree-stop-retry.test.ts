import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { nodeProbeDriver, type ControlledChild } from "../src/controlled-process.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "./fixtures/worktree-fixture.js";
import { holdSqliteWriter } from "./fixtures/sqlite-lock.js";

describe("physical stop independent of SQLite persistence (MVP 22.4)", () => {
  it.each(["stop", "cancel", "expiry", "shutdown", "force", "uncertain"] as const)(
    "attempts physical %s under an independent write lock and retries durable cleanup",
    async (mode) => {
      const repo = syntheticRepository();
      repo.addWorktree("first");
      const timeoutKey = Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms");
      Reflect.set(globalThis, timeoutKey, mode === "stop" ? 5000 : 100);
      const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
      Reflect.deleteProperty(globalThis, timeoutKey);
      const run = await activeRun(kernel, "stop-retry");
      let actual!: ControlledChild;
      const requestStop = vi.fn(() => {
        if (mode !== "force" && mode !== "uncertain") actual.requestStop();
      });
      const forceStop = vi.fn(() => mode === "uncertain" ? false : actual.forceStop());
      const executor = new LocalWorktreeExecutor({
        kernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: mode === "expiry" ? 1000 : 30_000,
        stopGraceMs: mode === "force" || mode === "uncertain" ? 30 : 500, forceGraceMs: 500,
        driver: { start: (input) => {
          actual = nodeProbeDriver.start(input);
          return { ...actual, requestStop, forceStop };
        } },
      });
      let release: (() => Promise<void>) | undefined;
      try {
        await executor.register({
          worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
        });
        const controller = new AbortController();
        const child = await executor.start({ worktreeId: "first", activationId: run.activationId, signal: controller.signal });
        await child.result;
        release = await holdSqliteWriter(repo.databasePath);
        if (mode === "cancel") controller.abort();
        if (mode === "expiry") await new Promise((resolve) => setTimeout(resolve, 1100));
        const first = mode === "shutdown" ? executor.close() : child.stop("Synthetic stop under contention.");
        await expect(first).rejects.toThrow();
        expect(requestStop).toHaveBeenCalledTimes(1);
        await expect(child.finish()).rejects.toThrow();
        if (mode !== "uncertain") await actual.closed;
        await release();
        if (mode === "expiry") {
          await vi.waitFor(async () => {
            expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
              .latestExecution?.state).toBe("StopConfirmed");
          }, { timeout: 2000 });
        }
        await expect(kernel.execute({
          type: "AppendRunActivity", idempotencyKey: "locally-revoked", runId: run.runId,
          activationId: run.activationId, kind: "status", payload: "Must not publish.", retentionClass: "durable",
        }, { principalId: "agent", activationId: run.activationId })).rejects.toMatchObject({ code: "WriterAuthorityLost" });
        if (mode === "uncertain") {
          expect(await child.stop("Retry after SQLite unlock.")).toBe("Uncertain");
          expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext)).state)
            .toBe("Quarantined");
          actual.requestStop();
          await actual.closed;
          expect(await child.reconcile()).toBe("StopConfirmed");
        }
        await executor.close();
        await executor.close();
        await expect(child.result).rejects.toThrow();
        expect(requestStop).toHaveBeenCalledTimes(1);
        expect(forceStop.mock.calls.length).toBe(mode === "force" || mode === "uncertain" ? 1 : 0);
        expect(await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
          .toMatchObject({ state: "Ready", latestExecution: {
            state: mode === "force" ? "ForceTerminated" : "StopConfirmed",
            authorityRevokedAt: expect.any(String),
          } });
        expect(() => process.kill(actual.pid!, 0)).toThrow();
      } finally {
        await release?.();
        actual?.forceStop();
        if (actual) await actual.closed;
        await executor.close().catch(() => undefined);
        kernel.close(); repo.dispose();
      }
    }, 20_000,
  );

  it("stops a spawned child when recording Running fails and retries through executor shutdown", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const timeoutKey = Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms");
    Reflect.set(globalThis, timeoutKey, 100);
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    Reflect.deleteProperty(globalThis, timeoutKey);
    const run = await activeRun(kernel, "startup-lock");
    let release: (() => Promise<void>) | undefined;
    let actual!: ControlledChild;
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo,
      driver: { start: (input) => { actual = nodeProbeDriver.start(input); return actual; } },
    });
    const execute = kernel.execute.bind(kernel);
    const spy = vi.spyOn(kernel, "execute").mockImplementation(async (command, actor) => {
      if (command.type === "RecordWorktreeExecution" && command.state === "Running") {
        release = await holdSqliteWriter(repo.databasePath);
      }
      return execute(command, actor);
    });
    try {
      await executor.register({
        worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
      });
      await expect(executor.start({ worktreeId: "first", activationId: run.activationId })).rejects.toThrow();
      await actual.closed;
      await release!();
      await executor.close();
      expect(await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
        .toMatchObject({ state: "Ready", latestExecution: {
          state: "StopConfirmed", authorityRevokedAt: expect.any(String),
        } });
    } finally {
      spy.mockRestore();
      await release?.();
      actual?.forceStop();
      if (actual) await actual.closed;
      await executor.close();
      kernel.close(); repo.dispose();
    }
  });

  it("retries recovery after an independent SQLite writer blocks the first recovery pass", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const timeoutKey = Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms");
    Reflect.set(globalThis, timeoutKey, 100);
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    Reflect.deleteProperty(globalThis, timeoutKey);
    const run = await activeRun(kernel, "recover-retry");
    const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    const restarted = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    let release: (() => Promise<void>) | undefined;
    try {
      await executor.register({
        worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
      });
      await executor.probe({ worktreeId: "first", activationId: run.activationId });
      release = await holdSqliteWriter(repo.databasePath);
      await expect(restarted.recover()).rejects.toThrow();
      await release();
      await restarted.recover();
      expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
        .latestExecution?.authorityRevokedAt).not.toBeNull();
    } finally {
      await release?.(); await executor.close(); await restarted.close();
      kernel.close(); repo.dispose();
    }
  });
});
