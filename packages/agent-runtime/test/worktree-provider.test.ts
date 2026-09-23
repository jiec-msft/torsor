import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";
import { bootstrap, createRun, runtimeContext } from "../../kernel/test/helpers.js";
import type { ControlledChild } from "../src/controlled-process.js";
import { resolveProviderPolicy } from "../src/provider-policy.js";
import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { syntheticRepository } from "./fixtures/worktree-fixture.js";
import { deferred } from "./fixtures/deferred.js";

const policy = resolveProviderPolicy({ kind: "trusted-local", permissionMode: "allow-all" });

async function fixture() {
  const repo = syntheticRepository();
  const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
  const run = await createRun(kernel);
  const projection = await kernel.query({ type: "GetRunProjection", runId: run.runId }, runtimeContext);
  const attempt = await kernel.execute({
    type: "StartProviderAttempt", idempotencyKey: "provider", activationId: run.activationId,
    outboxEventId: run.outboxEventId, outboxLeaseToken: run.outboxLeaseToken,
    adapter: "fixed-provider", adapterVersion: "1", capabilitySnapshot: {},
    requestIdempotencyKey: "fixed-request", runInputIds: projection.inputs.map((input) => input.id),
  }, runtimeContext);
  const executor = new LocalWorktreeExecutor({
    kernel, runtimePrincipalId: runtimeContext.principalId, ...repo,
    stopGraceMs: 10, forceGraceMs: 10,
  });
  return { repo, kernel, run, executor, providerAttemptId: attempt.entityId };
}

function child(unknownStop = false) {
  const closed = deferred<{ code: number; signal: null; error: null }>();
  const value: ControlledChild = {
    pid: 12345, result: Promise.resolve(""),
    closed: closed.promise,
    requestStop: () => { if (!unknownStop) closed.resolve({ code: 0, signal: null, error: null }); },
    forceStop: () => false,
  };
  return { value, confirm: () => closed.resolve({ code: 0, signal: null, error: null }) };
}

describe("native provider Worktree ownership", () => {
  it("derives the assigned directory, binds intent before spawn, and retains authority through publication", async () => {
    const f = await fixture();
    const owned = child();
    const order: string[] = [];
    let cwd = "";
    const execute = f.kernel.execute.bind(f.kernel);
    vi.spyOn(f.kernel, "execute").mockImplementation(async (command, context) => {
      const result = await execute(command, context);
      if (command.type === "AcquireWorktreeWriterLease" || command.type === "StartWorktreeExecution") {
        order.push(command.type);
      }
      return result;
    });
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId, policy,
        start: (directory) => {
          order.push("spawn");
          cwd = directory;
          writeFileSync(join(directory, "native-result.txt"), "Synthetic native edit.\n");
          return owned.value;
        },
      });
      expect(order).toEqual(["AcquireWorktreeWriterLease", "StartWorktreeExecution", "spawn"]);
      const page = await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: f.run.runId, limit: 2,
      }, runtimeContext);
      expect(page.items).toHaveLength(1);
      const tree = page.items[0]!;
      expect(cwd).toBe(tree.directoryPath);
      expect(readFileSync(join(cwd, "native-result.txt"), "utf8")).toBe("Synthetic native edit.\n");
      expect(tree.latestExecution).toMatchObject({
        activationId: f.run.activationId, generation: 1, fencingToken: 1, state: "Running",
        provider: { providerAttemptId: f.providerAttemptId, policy: "trusted-local", permissionMode: "allow-all" },
      });
      handle.assertPublication();
      await expect(f.kernel.execute({
        type: "CompleteRun", idempotencyKey: "too-early", runId: f.run.runId,
        expectedRunRevision: 1, incorporatedThroughInputSequence: 1,
      }, f.run.agentContext)).rejects.toThrow();
    } finally {
      owned.confirm();
      await f.executor.close();
      vi.restoreAllMocks();
      f.kernel.close(); f.repo.dispose();
    }
  });

  it("stops normally before success and keeps the lease until Runtime closes the Activation scope", async () => {
    const f = await fixture();
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId,
        policy, start: () => child().value,
      });
      expect(await handle.finish()).toBe("StopConfirmed");
      handle.assertPublication();
      await f.kernel.execute({
        type: "CompleteRun", idempotencyKey: "completed", runId: f.run.runId,
        expectedRunRevision: 1, incorporatedThroughInputSequence: 1,
      }, f.run.agentContext);
      const tree = (await f.kernel.query({ type: "ListPhysicalWorktrees", runId: f.run.runId }, runtimeContext)).items[0]!;
      expect(await f.kernel.query({ type: "GetWorktreeWriterLease", worktreeId: tree.worktreeId }, runtimeContext))
        .toMatchObject({ status: "Active" });
      await f.executor.stopActivation(f.run.activationId);
      expect(await f.kernel.query({ type: "GetWorktreeWriterLease", worktreeId: tree.worktreeId }, runtimeContext))
        .toMatchObject({ status: "Released" });
    } finally { await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  });

  it("quarantines unknown stop and rejects stale publication or replacement until original-handle confirmation", async () => {
    const f = await fixture();
    const owned = child(true);
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId,
        policy, start: () => owned.value,
      });
      expect(await handle.stop("Synthetic cancellation.")).toBe("Uncertain");
      expect(() => handle.assertPublication()).toThrow();
      const tree = (await f.kernel.query({ type: "ListPhysicalWorktrees", runId: f.run.runId }, runtimeContext)).items[0]!;
      expect(tree.state).toBe("Quarantined");
      const reopened = TorsorKernel.open({ databasePath: f.repo.databasePath });
      const recovered = new LocalWorktreeExecutor({
        kernel: reopened, runtimePrincipalId: runtimeContext.principalId, ...f.repo,
      });
      try {
        await recovered.recover();
        expect(await reopened.query({ type: "GetPhysicalWorktree", worktreeId: tree.worktreeId }, runtimeContext))
          .toMatchObject({
            state: "Quarantined", latestExecution: {
              state: "Uncertain",
              provider: { providerAttemptId: f.providerAttemptId, policy: "trusted-local", permissionMode: "allow-all" },
            },
          });
        const replacement = vi.fn(() => child().value);
        await expect(recovered.startProvider({
          runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId,
          policy, start: replacement,
        })).rejects.toThrow();
        expect(replacement).not.toHaveBeenCalled();
      } finally { await recovered.close(); reopened.close(); }
      await expect(f.kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "blocked-replacement",
        worktreeId: tree.worktreeId, leaseDurationMs: 30_000,
      }, runtimeContext)).rejects.toThrow();
      owned.confirm();
      await owned.value.closed;
      expect(await handle.reconcile()).toBe("StopConfirmed");
      await expect(f.kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "confirmed-replacement",
        worktreeId: tree.worktreeId, leaseDurationMs: 30_000,
      }, runtimeContext)).resolves.toMatchObject({ leaseGeneration: 2, fencingToken: 2 });
    } finally { owned.confirm(); await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  });

  it("rejects restricted policy and pre-aborted requests without creating a process", async () => {
    const f = await fixture();
    const start = vi.fn(() => child().value);
    try {
      const input = { runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId, start };
      await expect(f.executor.startProvider({ ...input, policy: resolveProviderPolicy() })).rejects.toThrow();
      await expect(f.executor.startProvider({ ...input, policy, signal: AbortSignal.abort() })).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
      expect((await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items).toEqual([]);
    } finally { await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  });
});
