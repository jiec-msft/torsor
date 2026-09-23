import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";
import { CopilotAcpAdapter } from "../src/copilot-acp-adapter.js";
import { AgentRuntime } from "../src/runtime.js";
import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { bootstrap, runtimeContext, syntheticRepository } from "./fixtures/worktree-fixture.js";
import { observeLockedChildren } from "./fixtures/sqlite-lock.js";
import type { ControlledChild } from "../src/controlled-process.js";
import { deferred } from "./fixtures/deferred.js";

const providerFile = fileURLToPath(new URL("./fixtures/native-acp-provider.mjs", import.meta.url));

async function setup(scenario = "success", permissionMode: "provider-default" | "allow-all" = "allow-all") {
  const repo = syntheticRepository();
  let now = new Date();
  const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap, clock: () => now });
  const executor = new LocalWorktreeExecutor({
    kernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 30_000,
    stopGraceMs: 1_000, forceGraceMs: 1_000,
  });
  const adapter = new CopilotAcpAdapter({
    policy: { kind: "trusted-local", permissionMode },
    command: process.execPath, commandArgs: [providerFile, scenario], unsafeAllowCustomCommandArgs: true,
    userEnvironment: {
      TORSOR_AUTH_TOKEN: "synthetic-private-control",
      COPILOT_ALLOW_ALL: "true", COPILOT_ASSISTED_APPROVAL: "true",
    },
  });
  const runtime = new AgentRuntime({
    kernel, runtimePrincipalId: "runtime", projectIds: ["project"], adapter, worktreeExecutor: executor,
    providerTimeoutMs: 20_000, activationDurationMs: 30_000, outboxLeaseMs: 30_000,
    cancellationPollMs: 10,
    clock: () => now,
  });
  const thread = await kernel.execute({
    type: "StartThread", idempotencyKey: "native-thread", projectId: "project", channelId: "channel",
    body: "Edit and test only the synthetic assigned Worktree.", targetAgentIds: ["orbit"],
  }, { principalId: "human" });
  return {
    repo, kernel, executor, runtime, threadId: thread.entityId,
    expire: () => { now = new Date(now.getTime() + 31_000); },
  };
}

describe("trusted-local Runtime integration", () => {
  it.each(["success", "permission", "tool-failed", "config-mode", "legacy-mode"])("runs fixed native shell/MCP tools with safe public facts: %s", async (scenario) => {
    const f = await setup(scenario);
    try {
      await f.runtime.drainUntilIdle();
      const trees = await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext);
      expect(trees.items).toHaveLength(1);
      const tree = trees.items[0]!;
      expect(readFileSync(join(tree.directoryPath, "native-result.txt"), "utf8")).toBe("Synthetic native edit.\n");
      expect(tree.latestExecution).toMatchObject({
        state: "StopConfirmed", provider: { policy: "trusted-local", permissionMode: "allow-all" },
      });
      const run = await f.kernel.query({ type: "GetRunProjection", runId: tree.runId }, runtimeContext);
      expect(run.run.state).toBe("Completed");
      expect(run.providerAttempts.at(-1)?.status).toBe("Completed");
      expect(run.activity.items.map((item) => item.kind)).toEqual([
        "tool_started", "tool_completed", "tool_started",
        scenario === "tool-failed" ? "tool_failed" : "tool_completed",
      ]);
      expect(JSON.stringify(run)).not.toContain("synthetic-private");
      expect(JSON.stringify(await f.kernel.readEvents(null, 500))).not.toContain("synthetic-private");
      expect(JSON.stringify(run)).not.toContain("diagnosticSessionId");
      expect(await f.kernel.query({ type: "GetWorktreeWriterLease", worktreeId: tree.worktreeId }, runtimeContext))
        .toMatchObject({ status: "Released" });
    } finally { await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  }, 30_000);

  it("does not grant unattended permissions under provider-default", async () => {
    const f = await setup("permission", "provider-default");
    try {
      await expect(f.runtime.drainUntilIdle()).rejects.toMatchObject({ diagnosticCode: "provider_cancelled" });
      const tree = (await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items[0]!;
      const run = await f.kernel.query({ type: "GetRunProjection", runId: tree.runId }, runtimeContext);
      expect(run.run.state).not.toBe("Completed");
      expect(run.activity.items.filter((item) => item.kind.startsWith("tool_"))).toEqual([]);
      expect(run.providerAttempts.at(-1)?.detail).toContain("provider_cancelled");
    } finally { await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  }, 30_000);

  it.each(["cancel", "expiry", "shutdown"] as const)(
    "physically stops on %s and rejects the provider's late final actions", async (reason) => {
    const f = await setup("hang");
    const toolStarted = deferred<string>();
    const execute = f.kernel.execute.bind(f.kernel);
    vi.spyOn(f.kernel, "execute").mockImplementation(async (command, context) => {
      const result = await execute(command, context);
      if (command.type === "AppendRunActivity" && command.kind === "tool_started") {
        toolStarted.resolve(command.runId);
      }
      return result;
    });
    const running = f.runtime.drainUntilIdle();
    void running.catch((error: unknown) => toolStarted.reject(error));
    try {
      const runId = await toolStarted.promise;
      const run = await f.kernel.query({ type: "GetRunProjection", runId }, runtimeContext);
      if (reason === "cancel") {
        await f.kernel.execute({
          type: "CancelRun", idempotencyKey: "cancel-native", runId,
          expectedRunRevision: run.run.revision, reason: "Synthetic Human stop.",
        }, { principalId: "human" });
      } else if (reason === "expiry") f.expire();
      else f.runtime.stop();
      await running.catch((error: unknown) => {
        expect(error).toMatchObject({ outcome: "Unknown" });
      });
      const latest = await f.kernel.query({ type: "GetRunProjection", runId }, runtimeContext);
      if (reason === "cancel") expect(latest.run.state).toBe("Cancelled");
      else expect(latest.run.state).not.toBe("Completed");
      const publicEvents = await f.kernel.readEvents(null, 500);
      expect(publicEvents.some((event) => event.type === "RunCompleted")).toBe(false);
      expect(JSON.stringify(publicEvents)).not.toContain("Synthetic Worktree edit and test completed.");
      expect((await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items[0]?.latestExecution)
        .toMatchObject({ state: "StopConfirmed", authorityRevokedAt: expect.any(String) });
    } finally {
      f.runtime.stop();
      await f.executor.close(); await Promise.allSettled([running]);
      vi.restoreAllMocks(); f.kernel.close(); f.repo.dispose();
    }
  }, 30_000);

  it("stops the native process tree promptly during SQLite contention without waiting for settlement", async () => {
    const f = await setup("hang");
    const toolStarted = deferred<void>();
    const stopTimes = new BigInt64Array(new SharedArrayBuffer(8));
    let original: ControlledChild | undefined;
    const startProvider = f.executor.startProvider.bind(f.executor);
    vi.spyOn(f.executor, "startProvider").mockImplementation((input) => startProvider({
      ...input,
      start: (cwd) => {
        const child = input.start(cwd);
        original = child;
        return {
          pid: child.pid, result: child.result, closed: child.closed,
          requestStop() {
            Atomics.compareExchange(stopTimes, 0, 0n, BigInt(Date.now()));
            child.requestStop();
          },
          forceStop: () => child.forceStop(),
        };
      },
    }));
    const execute = f.kernel.execute.bind(f.kernel);
    vi.spyOn(f.kernel, "execute").mockImplementation(async (command, context) => {
      const result = await execute(command, context);
      if (command.type === "AppendRunActivity" && command.kind === "tool_started") toolStarted.resolve();
      return result;
    });
    const running = f.runtime.drainUntilIdle().catch((error: unknown) => {
      toolStarted.reject(error);
      return error;
    });
    let lock: Awaited<ReturnType<typeof observeLockedChildren>> | undefined;
    try {
      await toolStarted.promise;
      lock = await observeLockedChildren(f.repo.databasePath, [original!.pid!], stopTimes);
      f.runtime.stop();
      const observed = await lock.observation;
      expect(observed.alive).toEqual([false]);
      expect(observed.stopRequestedAt[0]! - lock.lockedAt).toBeGreaterThanOrEqual(0);
      expect(observed.stopRequestedAt[0]! - lock.lockedAt).toBeLessThan(700);
      await lock.released;
      await running;
      await f.executor.close();
      const tree = (await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items[0]!;
      expect(tree.latestExecution).toMatchObject({
        state: "StopConfirmed", authorityRevokedAt: expect.any(String),
      });
      expect((await f.kernel.readEvents(null, 500)).some((event) => event.type === "RunCompleted")).toBe(false);
    } finally {
      f.runtime.stop(); await lock?.release();
      await f.executor.close(); await running;
      vi.restoreAllMocks(); f.kernel.close(); f.repo.dispose();
    }
  }, 30_000);
});
