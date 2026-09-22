import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import { LocalWorktreeExecutor, type ControlledWorktreeProcess } from "../src/worktree-executor.js";
import { nodeProbeDriver, type ControlledChild } from "../src/controlled-process.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "./fixtures/worktree-fixture.js";
import { observeLockedChildren } from "./fixtures/sqlite-lock.js";

describe("nonblocking physical supervision with production SQLite timeout (MVP 22.4)", () => {
  it.each(["expiry", "stop", "cancel", "shutdown"] as const)(
    "requests %s promptly while an independent writer holds SQLite for 6500ms",
    async (mode) => {
      const repo = syntheticRepository();
      repo.addWorktree("first");
      repo.addWorktree("second");
      // Deliberately use the production 5000ms timeout, never the fast test override.
      expect(Reflect.has(globalThis, Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms"))).toBe(false);
      const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
      const runs = [await activeRun(kernel, "first"), await activeRun(kernel, "second")];
      const children: ControlledChild[] = [];
      const stops = new BigInt64Array(new SharedArrayBuffer(16));
      const requests = [vi.fn(), vi.fn()];
      const forces = [vi.fn(), vi.fn()];
      const deadlines: number[] = [];
      const execute = kernel.execute.bind(kernel);
      vi.spyOn(kernel, "execute").mockImplementation(async (command, context) => {
        const result = await execute(command, context);
        if (command.type === "AcquireWorktreeWriterLease") deadlines.push(Date.parse(result.leaseExpiresAt!));
        return result;
      });
      const executor = new LocalWorktreeExecutor({
        kernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 1000,
        driver: { start(input) {
          const index = children.length;
          const actual = nodeProbeDriver.start(input);
          children.push(actual);
          return {
            ...actual,
            requestStop() {
              Atomics.compareExchange(stops, index, 0n, BigInt(Date.now()));
              requests[index]!();
              actual.requestStop();
            },
            forceStop() { forces[index]!(); return actual.forceStop(); },
          };
        } },
      });
      let lock: Awaited<ReturnType<typeof observeLockedChildren>> | undefined;
      let queued: NodeJS.Timeout | undefined;
      let stopping: Promise<unknown>[] = [];
      try {
        for (const [index, worktreeId] of ["first", "second"].entries()) {
          await executor.register({
            worktreeId, directoryName: worktreeId, baseRevision: repo.baseRevision, runId: runs[index]!.runId,
          });
        }
        const controllers = [new AbortController(), new AbortController()];
        const handles: ControlledWorktreeProcess[] = [];
        for (const [index, worktreeId] of ["first", "second"].entries()) {
          const handle = await executor.start({
            worktreeId, activationId: runs[index]!.activationId, signal: controllers[index]!.signal,
          });
          handles.push(handle);
          await handle.result;
          if (index === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        lock = await observeLockedChildren(repo.databasePath, children.map((child) => child.pid!), stops);
        if (mode !== "expiry") {
          queued = setTimeout(() => {
            if (mode === "cancel") controllers.forEach((controller) => controller.abort());
            else stopping = (mode === "shutdown" ? [executor.close()] : handles.map((handle) => handle.stop("Queued stop.")))
              .map((promise) => promise.catch((error: unknown) => error));
          }, 300);
        }
        const observed = await lock.observation;
        expect(observed.alive).toEqual([false, false]);
        for (const [index, requestedAt] of observed.stopRequestedAt.entries()) {
          expect(requestedAt).toBeGreaterThan(lock.lockedAt);
          if (mode === "expiry") {
            expect(requestedAt - deadlines[index]!).toBeGreaterThanOrEqual(-100);
            expect(requestedAt - deadlines[index]!).toBeLessThan(400);
          } else {
            expect(requestedAt - lock.lockedAt).toBeLessThan(700);
          }
          expect(requests[index]).toHaveBeenCalledTimes(1);
          expect(forces[index]).not.toHaveBeenCalled();
        }
        // The observer and automatic release run outside the potentially blocked event loop.
        await lock.released;
        expect(Date.now() - lock.lockedAt).toBeGreaterThanOrEqual(6500);
        await Promise.all(stopping);
        await executor.close();
        await executor.close();
        for (const worktreeId of ["first", "second"]) {
          expect(await kernel.query({ type: "GetPhysicalWorktree", worktreeId }, runtimeContext))
            .toMatchObject({ state: "Ready", latestExecution: {
              state: "StopConfirmed", authorityRevokedAt: expect.any(String),
            } });
        }
        requests.forEach((request) => expect(request).toHaveBeenCalledTimes(1));
        await Promise.all(children.map((child) => child.closed));
      } finally {
        clearTimeout(queued);
        await lock?.release();
        children.forEach((child) => child.forceStop());
        await Promise.all(children.map((child) => child.closed));
        await Promise.all(stopping);
        await executor.close();
        kernel.close();
        repo.dispose();
      }
    }, 20_000,
  );
});
