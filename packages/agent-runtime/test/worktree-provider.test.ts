import { readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";

import { TorsorKernel } from "@torsor/kernel";
import {
  OperationalLogSinkError,
  OperationalLogger,
} from "@torsor/operational-logging";
import { describe, expect, it, vi } from "vitest";
import { bootstrap, createRun, runtimeContext } from "../../kernel/test/helpers.js";
import type { ControlledChild } from "../src/controlled-process.js";
import { resolveProviderPolicy } from "../src/provider-policy.js";
import { OwnedProviderProcess } from "../src/provider-process.js";
import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { syntheticRepository } from "./fixtures/worktree-fixture.js";
import { deferred } from "./fixtures/deferred.js";

const policy = resolveProviderPolicy({ kind: "trusted-local", permissionMode: "allow-all" });

async function fixture(
  operationalLogger?: OperationalLogger,
  stopDurations: { stopGraceMs?: number; forceGraceMs?: number } =
    { stopGraceMs: 10, forceGraceMs: 10 },
) {
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
    ...stopDurations,
    ...(operationalLogger ? { operationalLogger } : {}),
  });
  return {
    repo,
    kernel,
    run,
    executor,
    providerAttemptId: attempt.entityId,
    correlationId: attempt.correlationId!,
  };
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
    vi.spyOn(f.kernel, "execute").mockImplementation(async (command, context, operationContext) => {
      const result = await execute(command, context, operationContext);
      if (command.type === "AcquireWorktreeWriterLease" || command.type === "StartWorktreeExecution") {
        order.push(command.type);
      }
      return result;
    });
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId,
        correlationId: f.correlationId, policy,
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
        correlationId: f.correlationId,
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

  it.runIf(process.platform === "win32")(
    "persists confirmed force termination instead of quarantining after the Provider ignores stdin",
    async () => {
      const f = await fixture(undefined, { stopGraceMs: 50, forceGraceMs: 2_000 });
      let owner: OwnedProviderProcess | undefined;
      let confirmed = false;
      try {
        const handle = await f.executor.startProvider({
          runId: f.run.runId, activationId: f.run.activationId,
          providerAttemptId: f.providerAttemptId, correlationId: f.correlationId,
          policy,
          start: (cwd) => owner = new OwnedProviderProcess({
            command: process.execPath, cwd, environment: {},
            args: ["-e", `
              const child = require("node:child_process").spawn(process.execPath,
                ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
              process.stdout.write(child.pid+"\\n");
              process.stdin.resume();
              process.stdin.on("end",()=>setInterval(()=>{},1000));
            `],
          }),
        });
        const [pidChunk] = await once(owner!.processHandle.stdout, "data");
        const pid = Number(String(pidChunk).trim());
        expect(pid).toBeGreaterThan(0);
        expect(await handle.stop("Synthetic Provider shutdown.")).toBe("ForceTerminated");
        const tree = (await f.kernel.query({
          type: "ListPhysicalWorktrees", runId: f.run.runId,
        }, runtimeContext)).items[0]!;
        expect(tree).toMatchObject({
          state: "Ready",
          latestExecution: { state: "ForceTerminated", authorityRevokedAt: expect.any(String) },
        });
        expect(() => handle.assertPublication()).toThrow();
        expect(() => process.kill(pid, 0)).toThrow();
        confirmed = true;
      } finally {
        await f.executor.close();
        f.kernel.close();
        if (confirmed) f.repo.dispose();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "allows the default Windows force-stop window to observe a late original-handle confirmation",
    async () => {
      const f = await fixture(undefined, { stopGraceMs: 1 });
      const closed = deferred<{ code: number; signal: null; error: null }>();
      let timer: NodeJS.Timeout | undefined;
      const delayed: ControlledChild = {
        pid: 12345, result: Promise.resolve(""), closed: closed.promise,
        requestStop: () => {},
        forceStop: () => {
          timer = setTimeout(() => closed.resolve({ code: 137, signal: null, error: null }), 1_500);
          return true;
        },
      };
      try {
        const handle = await f.executor.startProvider({
          runId: f.run.runId, activationId: f.run.activationId,
          providerAttemptId: f.providerAttemptId, correlationId: f.correlationId,
          policy, start: () => delayed,
        });
        expect(await handle.stop("Synthetic delayed Job confirmation.")).toBe("ForceTerminated");
        const tree = (await f.kernel.query({
          type: "ListPhysicalWorktrees", runId: f.run.runId,
        }, runtimeContext)).items[0]!;
        expect(tree).toMatchObject({ state: "Ready", latestExecution: { state: "ForceTerminated" } });
      } finally {
        clearTimeout(timer);
        closed.resolve({ code: 137, signal: null, error: null });
        await f.executor.close();
        f.kernel.close(); f.repo.dispose();
      }
    },
    30_000,
  );

  it("quarantines unknown stop and rejects stale publication or replacement until original-handle confirmation", async () => {
    const lines: string[] = [];
    const logger = new OperationalLogger({
      sink: { write: (line) => { lines.push(line); } },
    });
    const f = await fixture(logger);
    const owned = child(true);
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId, providerAttemptId: f.providerAttemptId,
        correlationId: f.correlationId,
        policy, start: () => owned.value,
      });
      expect(await handle.stop("Synthetic cancellation.")).toBe("Uncertain");
      expect(() => handle.assertPublication()).toThrow();
      const tree = (await f.kernel.query({ type: "ListPhysicalWorktrees", runId: f.run.runId }, runtimeContext)).items[0]!;
      expect(tree.state).toBe("Quarantined");
      const reopened = TorsorKernel.open({ databasePath: f.repo.databasePath });
      const recovered = new LocalWorktreeExecutor({
        kernel: reopened, runtimePrincipalId: runtimeContext.principalId, ...f.repo,
        operationalLogger: logger,
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
          correlationId: f.correlationId,
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
      const serialized = lines.join("");
      expect(lines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "writer_authority.acquire",
          outcome: "succeeded",
          correlationId: f.correlationId,
        }),
        expect.objectContaining({
          event: "provider_process.stop",
          outcome: "unknown",
          errorCode: "provider_cleanup_failed",
          correlationId: f.correlationId,
        }),
        expect.objectContaining({
          event: "writer_authority.quarantine",
          outcome: "succeeded",
          correlationId: f.correlationId,
        }),
        expect.objectContaining({
          event: "recovery.pass",
          outcome: "succeeded",
          correlationId: f.correlationId,
        }),
      ]));
      expect(serialized).not.toContain(f.repo.directory);
      expect(serialized).not.toContain("leaseToken");
      expect(serialized).not.toContain("fencingToken");
      expect(serialized).not.toContain("executionToken");
    } finally { owned.confirm(); await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  });

  it("records independent Writer authority loss without logging lease authority", async () => {
    const lines: string[] = [];
    const logger = new OperationalLogger({
      sink: { write: (line) => { lines.push(line); } },
    });
    const f = await fixture(logger);
    const owned = child();
    let leaseToken: string | undefined;
    const execute = f.kernel.execute.bind(f.kernel);
    vi.spyOn(f.kernel, "execute").mockImplementation(
      async (command, context, operationContext) => {
        const result = await execute(command, context, operationContext);
        if (command.type === "AcquireWorktreeWriterLease") {
          leaseToken = result.leaseToken;
        }
        return result;
      },
    );
    try {
      await f.executor.startProvider({
        runId: f.run.runId,
        activationId: f.run.activationId,
        providerAttemptId: f.providerAttemptId,
        correlationId: f.correlationId,
        policy,
        start: () => owned.value,
      });
      const tree = (await f.kernel.query({
        type: "ListPhysicalWorktrees",
        runId: f.run.runId,
      }, runtimeContext)).items[0]!;
      const lease = await f.kernel.query({
        type: "GetWorktreeWriterLease",
        worktreeId: tree.worktreeId,
      }, runtimeContext);
      await f.kernel.execute({
        type: "QuarantineWorktreeWriterLease",
        idempotencyKey: "synthetic-independent-authority-loss",
        worktreeId: tree.worktreeId,
        expectedGeneration: lease.generation,
        expectedFencingToken: lease.fencingToken,
        leaseToken: leaseToken!,
        reason: "Synthetic independent authority loss.",
      }, runtimeContext);
      await vi.waitFor(() => {
        expect(lines.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({
            event: "writer_authority.loss",
            outcome: "lost",
            errorCode: "writer_authority_lost",
            correlationId: f.correlationId,
          }),
        );
      });
      const serialized = lines.join("");
      expect(serialized).not.toContain("generation");
      expect(serialized).not.toContain("fencingToken");
      expect(serialized).not.toContain("leaseToken");
      expect(serialized).not.toContain("Synthetic independent authority loss.");
      expect(serialized).not.toContain(f.repo.directory);
    } finally {
      owned.confirm();
      await f.executor.close();
      f.kernel.close();
      f.repo.dispose();
      vi.restoreAllMocks();
    }
  });

  it("physically stops and settles after authority loss even when authority logging fails", async () => {
    const logger = new OperationalLogger({
      sink: {
        write: (line) => {
          const event = JSON.parse(line) as { event: string };
          if (event.event === "writer_authority.loss") {
            throw new Error("Synthetic private sink failure.");
          }
        },
      },
    });
    const f = await fixture(logger);
    const closed = deferred<{ code: number; signal: null; error: null }>();
    let stopRequests = 0;
    const controlled: ControlledChild = {
      pid: 12345,
      result: Promise.resolve(""),
      closed: closed.promise,
      requestStop: () => {
        stopRequests += 1;
        closed.resolve({ code: 0, signal: null, error: null });
      },
      forceStop: () => false,
    };
    let leaseToken: string | undefined;
    const execute = f.kernel.execute.bind(f.kernel);
    vi.spyOn(f.kernel, "execute").mockImplementation(
      async (command, context, operationContext) => {
        const result = await execute(command, context, operationContext);
        if (command.type === "AcquireWorktreeWriterLease") {
          leaseToken = result.leaseToken;
        }
        return result;
      },
    );
    try {
      const handle = await f.executor.startProvider({
        runId: f.run.runId,
        activationId: f.run.activationId,
        providerAttemptId: f.providerAttemptId,
        correlationId: f.correlationId,
        policy,
        start: () => controlled,
      });
      const tree = (await f.kernel.query({
        type: "ListPhysicalWorktrees",
        runId: f.run.runId,
      }, runtimeContext)).items[0]!;
      const lease = await f.kernel.query({
        type: "GetWorktreeWriterLease",
        worktreeId: tree.worktreeId,
      }, runtimeContext);
      await f.kernel.execute({
        type: "QuarantineWorktreeWriterLease",
        idempotencyKey: "synthetic-logging-failed-authority-loss",
        worktreeId: tree.worktreeId,
        expectedGeneration: lease.generation,
        expectedFencingToken: lease.fencingToken,
        leaseToken: leaseToken!,
        reason: "Synthetic independent authority loss.",
      }, runtimeContext);

      await vi.waitFor(() => expect(stopRequests).toBe(1), { timeout: 200 });
      await expect(handle.authorityClassificationError())
        .rejects.toBeInstanceOf(OperationalLogSinkError);
      expect(await f.kernel.query({
        type: "GetPhysicalWorktree",
        worktreeId: tree.worktreeId,
      }, runtimeContext)).toMatchObject({
        state: "Ready",
        latestExecution: { state: "StopConfirmed" },
      });
      expect(await f.kernel.query({
        type: "GetWorktreeWriterLease",
        worktreeId: tree.worktreeId,
      }, runtimeContext)).toMatchObject({ status: "Quarantined" });
    } finally {
      closed.resolve({ code: 0, signal: null, error: null });
      await f.executor.close();
      f.kernel.close();
      f.repo.dispose();
      vi.restoreAllMocks();
    }
  });

  it("rejects restricted policy and pre-aborted requests without creating a process", async () => {
    const f = await fixture();
    const start = vi.fn(() => child().value);
    try {
      const input = {
        runId: f.run.runId,
        activationId: f.run.activationId,
        providerAttemptId: f.providerAttemptId,
        correlationId: f.correlationId,
        start,
      };
      await expect(f.executor.startProvider({ ...input, policy: resolveProviderPolicy() })).rejects.toThrow();
      await expect(f.executor.startProvider({ ...input, policy, signal: AbortSignal.abort() })).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
      expect((await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items).toEqual([]);
    } finally { await f.executor.close(); f.kernel.close(); f.repo.dispose(); }
  });

  it("quarantines a running receipt on restart and admits a replacement only after original-tree confirmation", async () => {
    const f = await fixture();
    const owned = child(true);
    const reopened = TorsorKernel.open({ databasePath: f.repo.databasePath });
    const replacement = new LocalWorktreeExecutor({
      kernel: reopened, runtimePrincipalId: runtimeContext.principalId, ...f.repo,
    });
    try {
      const original = await f.executor.startProvider({
        runId: f.run.runId, activationId: f.run.activationId,
        providerAttemptId: f.providerAttemptId, correlationId: f.correlationId,
        policy, start: () => owned.value,
      });
      await replacement.recover();
      const tree = (await reopened.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items[0]!;
      expect(tree).toMatchObject({ state: "Quarantined", latestExecution: { state: "Uncertain" } });
      expect(() => original.assertPublication()).toThrow();
      const activation = await reopened.execute({
        type: "StartActivation", idempotencyKey: "replacement-activation", runId: f.run.runId,
        expectedRunRevision: 1, outboxEventId: f.run.outboxEventId, outboxLeaseToken: f.run.outboxLeaseToken,
      }, runtimeContext);
      const attempt = await reopened.execute({
        type: "StartProviderAttempt", idempotencyKey: "replacement-attempt", activationId: activation.entityId,
        outboxEventId: f.run.outboxEventId, outboxLeaseToken: f.run.outboxLeaseToken,
        adapter: "fixed-provider", adapterVersion: "1", capabilitySnapshot: {},
        requestIdempotencyKey: "replacement-request", runInputIds: [f.run.runInputId],
      }, runtimeContext);
      const spawn = vi.fn(() => child().value);
      const input = {
        runId: f.run.runId, activationId: activation.entityId, providerAttemptId: attempt.entityId,
        correlationId: attempt.correlationId!, policy, start: spawn,
      };
      await expect(replacement.startProvider(input)).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      owned.confirm();
      await owned.value.closed;
      await original.reconcile();
      const next = await replacement.startProvider(input);
      expect(spawn).toHaveBeenCalledOnce();
      expect(await next.finish()).toBe("StopConfirmed");
      expect(() => original.assertPublication()).toThrow();
      expect((await reopened.query({ type: "GetPhysicalWorktree", worktreeId: tree.worktreeId }, runtimeContext))
        .latestExecution).toMatchObject({
        activationId: activation.entityId, generation: 2, fencingToken: 2, state: "StopConfirmed",
      });
    } finally {
      owned.confirm();
      await f.executor.close(); await replacement.close();
      reopened.close(); f.kernel.close(); f.repo.dispose();
    }
  });
});
