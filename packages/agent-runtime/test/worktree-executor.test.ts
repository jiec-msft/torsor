import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it } from "vitest";

import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { nodeProbeDriver, type ControlledProcessDriver, type ControlledChild } from "../src/controlled-process.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "./fixtures/worktree-fixture.js";

describe("controlled Worktree executor (§22, §24, §38)", () => {
  it("writes a fixed file and runs a real exact-argument child through live Kernel authority", async () => {
    const repo = syntheticRepository();
    const path = repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "probe");
    const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      const digest = await child.result;
      const content = readFileSync(join(path, "torsor-probe.txt"), "utf8");
      expect(digest).toBe(createHash("sha256").update(content).digest("hex"));
      expect(await child.stop("Controlled operation complete.")).toBe("StopConfirmed");
      const physical = await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext);
      expect(physical).toMatchObject({
        runId: run.runId, baseRevision: repo.baseRevision, state: "Ready",
        latestExecution: { state: "StopConfirmed", activationId: run.activationId },
      });
      expect(physical.latestExecution?.pid).toBeGreaterThan(0);
      expect(await kernel.query({ type: "GetWorktreeWriterLease", worktreeId: "first" }, runtimeContext))
        .toMatchObject({ status: "Released" });
    } finally { await executor.close(); await run.close(); kernel.close(); repo.dispose(); }
  });

  it("does not reuse an expired directory with a live child; uncertainty needs original-handle reconciliation", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    let now = new Date();
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap, clock: () => now });
    const run = await activeRun(kernel, "uncertain");
    let actual!: ControlledChild;
    const driver: ControlledProcessDriver = {
      start: (input) => {
        actual = nodeProbeDriver.start(input);
        return { ...actual, requestStop: () => {}, forceStop: () => false };
      },
    };
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo, driver, stopGraceMs: 20, forceGraceMs: 20,
    });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      await child.result;
      now = new Date(now.getTime() + 31_000);
      expect(await child.stop("Lease expired without physical stop.")).toBe("Uncertain");
      process.kill(actual.pid!, 0);
      await expect(kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "unsafe", worktreeId: "first", leaseDurationMs: 30_000,
      }, runtimeContext)).rejects.toMatchObject({ code: "DomainBusy" });
      expect(await child.reconcile()).toBe("Uncertain");
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      const restarted = new LocalWorktreeExecutor({ kernel: reopened, runtimePrincipalId: "runtime", ...repo });
      try {
        await restarted.recover();
        process.kill(actual.pid!, 0);
        await expect(restarted.start({ worktreeId: "first", activationId: run.activationId }))
          .rejects.toMatchObject({ code: "DomainBusy" });
      } finally { await restarted.close(); reopened.close(); }
      actual.requestStop();
      await actual.closed;
      expect(await child.reconcile()).toBe("StopConfirmed");
      const acquired = await kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "safe", worktreeId: "first", leaseDurationMs: 30_000,
      }, runtimeContext);
      expect(acquired.leaseGeneration).toBe(2);
    } finally {
      actual?.forceStop();
      if (actual) await actual.closed;
      await executor.close(); await run.close(); kernel.close(); repo.dispose();
    }
  });

  it("rejects traversal, symlink aliases, and a pre-existing linked output without touching the target", async () => {
    const repo = syntheticRepository();
    const path = repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "paths");
    const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    try {
      for (const directoryName of ["..", "../first", "..\\first", path]) {
        await expect(executor.register({
          worktreeId: "bad", directoryName, baseRevision: repo.baseRevision, runId: run.runId,
        })).rejects.toThrow();
      }
      symlinkSync(path, join(repo.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
      await expect(executor.register({
        worktreeId: "alias", directoryName: "alias", baseRevision: repo.baseRevision, runId: run.runId,
      })).rejects.toThrow();
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const outside = join(repo.directory, "outside.txt");
      writeFileSync(outside, "Do not modify.");
      // A hard link is available without Windows symlink privileges.
      const { linkSync } = await import("node:fs");
      linkSync(outside, join(path, "torsor-probe.txt"));
      await expect(executor.start({ worktreeId: "first", activationId: run.activationId })).rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("Do not modify.");
    } finally { await executor.close(); await run.close(); kernel.close(); repo.dispose(); }
  });

  it("quarantines after a real executor crash regardless of OS descendant cleanup", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "restart");
    const host = spawn(process.execPath, [
      fileURLToPath(new URL("./fixtures/orphan-worktree-host.mjs", import.meta.url)),
      JSON.stringify({ ...repo, runId: run.runId, activationId: run.activationId }),
    ], { shell: false, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const hostClosed = new Promise<void>((resolve) => host.once("close", () => resolve()));
    let orphanPid: number | undefined;
    const recoveredKernel = TorsorKernel.open({ databasePath: repo.databasePath });
    const restarted = new LocalWorktreeExecutor({
      kernel: recoveredKernel, runtimePrincipalId: "runtime", ...repo,
    });
    try {
      orphanPid = await new Promise<number>((resolve, reject) => {
        host.once("message", (message) => {
          if (message && typeof message === "object" && "pid" in message && typeof message.pid === "number") resolve(message.pid);
          else reject(new Error("Crash fixture returned no child PID."));
        });
        host.once("error", reject);
        host.once("exit", (code) => { if (code !== null) reject(new Error(`Crash fixture exited: ${code}`)); });
      });
      process.kill(orphanPid, 0);
      host.kill("SIGKILL");
      await hostClosed;
      await restarted.recover();
      expect(await recoveredKernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
        .toMatchObject({ state: "Quarantined", latestExecution: { state: "Uncertain", pid: orphanPid } });
      await expect(restarted.start({ worktreeId: "first", activationId: run.activationId }))
        .rejects.toMatchObject({ code: "DomainBusy" });
      // Some hosts kill descendants with the parent. PID absence is still not
      // original-handle evidence, and cannot make the directory reusable.
      try { process.kill(orphanPid, "SIGKILL"); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
      orphanPid = undefined;
      const anotherRestart = new LocalWorktreeExecutor({
        kernel: recoveredKernel, runtimePrincipalId: "runtime", ...repo,
      });
      await anotherRestart.recover();
      await expect(anotherRestart.start({ worktreeId: "first", activationId: run.activationId }))
        .rejects.toMatchObject({ code: "DomainBusy" });
      await anotherRestart.close();
    } finally {
      host.kill("SIGKILL");
      await hostClosed;
      if (orphanPid) {
        try { process.kill(orphanPid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await restarted.close(); recoveredKernel.close();
      await run.close(); kernel.close(); repo.dispose();
    }
  });

  it("requires close evidence after a force request and persists the force outcome", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "force");
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo, stopGraceMs: 20,
      driver: { start: (input) => ({ ...nodeProbeDriver.start(input), requestStop: () => {} }) },
    });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      await child.result;
      expect(await child.stop("Force fixture stop.")).toBe("ForceTerminated");
      expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext)).latestExecution?.events)
        .toMatchObject([
          { state: "Starting" }, { state: "Running" }, { state: "StopRequested" },
          { state: "ForceTerminated", evidence: expect.stringContaining("Original child close") },
        ]);
    } finally { await executor.close(); await run.close(); kernel.close(); repo.dispose(); }
  });

  it("rejects replacement directories, wrong bases, and another database claiming the root", async () => {
    const repo = syntheticRepository();
    const path = repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const otherKernel = TorsorKernel.open({ databasePath: ":memory:", bootstrap });
    const run = await activeRun(kernel, "replacement");
    const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    try {
      await expect(executor.register({
        worktreeId: "wrong", directoryName: "first", baseRevision: "a".repeat(40), runId: run.runId,
      })).rejects.toThrow(/base revision/);
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const otherExecutor = new LocalWorktreeExecutor({ kernel: otherKernel, runtimePrincipalId: "runtime", ...repo });
      await expect(otherExecutor.recover()).rejects.toThrow(/another Kernel storage identity/);
      await otherExecutor.close();
      const moved = join(repo.rootPath, "moved");
      renameSync(path, moved);
      mkdirSync(path);
      copyFileSync(join(moved, ".git"), join(path, ".git"));
      await expect(executor.start({ worktreeId: "first", activationId: run.activationId })).rejects.toThrow(/identity changed/);
    } finally { await executor.close(); await run.close(); otherKernel.close(); kernel.close(); repo.dispose(); }
  });

  it("keeps different Runs in different directories and fences cross-Run activation", async () => {
    const repo = syntheticRepository();
    const firstPath = repo.addWorktree("first");
    const secondPath = repo.addWorktree("second");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const firstRun = await activeRun(kernel, "first-run");
    const secondRun = await activeRun(kernel, "second-run");
    const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: firstRun.runId });
      await expect(executor.register({
        worktreeId: "alias", directoryName: "first", baseRevision: repo.baseRevision, runId: secondRun.runId,
      })).rejects.toMatchObject({ code: "Conflict" });
      await executor.register({ worktreeId: "second", directoryName: "second", baseRevision: repo.baseRevision, runId: secondRun.runId });
      await expect(executor.start({ worktreeId: "first", activationId: secondRun.activationId }))
        .rejects.toMatchObject({ code: "Forbidden" });
      const results = await Promise.all([
        executor.probe({ worktreeId: "first", activationId: firstRun.activationId }),
        executor.probe({ worktreeId: "second", activationId: secondRun.activationId }),
      ]);
      expect(results.every((result) => result.stop === "StopConfirmed")).toBe(true);
      expect(readFileSync(join(firstPath, "torsor-probe.txt"), "utf8"))
        .toBe(readFileSync(join(secondPath, "torsor-probe.txt"), "utf8"));
    } finally { await executor.close(); await firstRun.close(); await secondRun.close(); kernel.close(); repo.dispose(); }
  });

  it("does not confuse successful force signalling with close confirmation", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "force-uncertain");
    let actual!: ControlledChild;
    let observeClose!: (evidence: Awaited<ControlledChild["closed"]>) => void;
    const delayedClose = new Promise<Awaited<ControlledChild["closed"]>>((resolve) => { observeClose = resolve; });
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo, stopGraceMs: 20, forceGraceMs: 20,
      driver: { start: (input) => {
        actual = nodeProbeDriver.start(input);
        return { ...actual, requestStop: () => {}, closed: delayedClose };
      } },
    });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      const child = await executor.start({ worktreeId: "first", activationId: run.activationId });
      await child.result;
      expect(await child.stop("Force succeeded but observation is delayed.")).toBe("Uncertain");
      expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext)).state)
        .toBe("Quarantined");
      observeClose(await actual.closed);
      expect(await child.reconcile()).toBe("ForceTerminated");
    } finally {
      actual?.forceStop();
      if (actual) observeClose(await actual.closed);
      await executor.close(); await run.close(); kernel.close(); repo.dispose();
    }
  });

  it("automatically stops on cancellation and on its independent lease deadline", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    repo.addWorktree("second");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "automatic-stop");
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 1_000,
    });
    try {
      for (const worktreeId of ["first", "second"]) {
        await executor.register({ worktreeId, directoryName: worktreeId, baseRevision: repo.baseRevision, runId: run.runId });
      }
      const controller = new AbortController();
      const cancelled = await executor.start({ worktreeId: "first", activationId: run.activationId, signal: controller.signal });
      await cancelled.result;
      controller.abort();
      expect(await cancelled.stop("Cancellation observed.")).toBe("StopConfirmed");
      const expired = await executor.start({ worktreeId: "second", activationId: run.activationId });
      await expired.result;
      await expect.poll(async () => (await kernel.query({
        type: "GetPhysicalWorktree", worktreeId: "second",
      }, runtimeContext)).latestExecution?.state).toBe("StopConfirmed");
      expect(await expired.stop("Deadline already observed.")).toBe("StopConfirmed");
    } finally { await executor.close(); await run.close(); kernel.close(); repo.dispose(); }
  });

  it("quarantines a thrown spawn window instead of claiming that no child exists", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    const run = await activeRun(kernel, "spawn-window");
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo,
      driver: { start: () => { throw new Error("Synthetic lost spawn handle."); } },
    });
    try {
      await executor.register({ worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId });
      await expect(executor.start({ worktreeId: "first", activationId: run.activationId }))
        .rejects.toThrow(/lost spawn handle/);
      expect(await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
        .toMatchObject({ state: "Quarantined", latestExecution: { state: "Uncertain", pid: null } });
    } finally { await executor.close(); await run.close(); kernel.close(); repo.dispose(); }
  });
});
