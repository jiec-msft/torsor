import { describe, expect, it } from "vitest";

import { createRun, openMemoryKernel, runtimeContext, humanContext } from "./helpers.js";
import type { WorktreeMutationAuthority } from "../src/index.js";

async function setup() {
  let now = new Date("2026-09-22T08:00:00Z");
  const kernel = openMemoryKernel(() => now);
  const run = await createRun(kernel);
  await kernel.execute({
    type: "RegisterPhysicalWorktree", idempotencyKey: "register",
    worktreeId: "tree", runId: run.runId, repositoryId: "synthetic",
    repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
    directoryPath: "synthetic-private-tree", directoryIdentity: "1:2",
  }, runtimeContext);
  const lease = await kernel.execute({
    type: "AcquireWorktreeWriterLease", idempotencyKey: "acquire",
    worktreeId: "tree", leaseDurationMs: 1_000,
  }, runtimeContext);
  const authority = {
    worktreeId: "tree", generation: lease.leaseGeneration!,
    fencingToken: lease.fencingToken!, leaseToken: lease.leaseToken!,
  };
  const started = await kernel.execute({
    type: "StartWorktreeExecution", idempotencyKey: "start",
    ...authority, activationId: run.activationId, executorId: "host-one",
  }, runtimeContext);
  const receipt = {
    executionId: started.entityId, executorId: "host-one",
    executionToken: started.executionToken!,
  };
  return {
    kernel, run, authority, receipt,
    mutation: { ...authority, ...receipt } satisfies WorktreeMutationAuthority,
    expire: () => { now = new Date("2026-09-22T08:00:01Z"); },
  };
}

describe("physical execution contracts (§22, §24, §38)", () => {
  it("binds provenance, rejects stale mutations, and prevents lease release while intent is unsettled", async () => {
    const f = await setup();
    try {
      let effects = 0;
      f.kernel.performWorktreeMutation(f.mutation, runtimeContext, () => { effects++; });
      expect(effects).toBe(1);
      for (const wrong of [
        { leaseToken: "old" }, { generation: 0 }, { fencingToken: 0 },
        { executionToken: "old" }, { executorId: "host-two" },
      ]) {
        expect(() => f.kernel.performWorktreeMutation(
          { ...f.mutation, ...wrong }, runtimeContext, () => { effects++; },
        )).toThrow();
      }
      expect(() => f.kernel.performWorktreeMutation(
        f.mutation, humanContext, () => { effects++; },
      )).toThrow();
      expect(effects).toBe(1);
      await expect(f.kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: "unsafe-release", ...f.authority,
      }, runtimeContext)).rejects.toMatchObject({ code: "DomainBusy" });
      const physical = await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext);
      expect(physical).toMatchObject({
        runId: f.run.runId, repositoryId: "synthetic", baseRevision: "a".repeat(40),
        latestExecution: { activationId: f.run.activationId, generation: 1, state: "Starting" },
      });
      expect(JSON.stringify(physical)).not.toContain(f.receipt.executionToken);
    } finally { f.kernel.close(); }
  });

  it("expiry and a generic quarantine resolution cannot bypass an unfinished physical execution", async () => {
    const f = await setup();
    try {
      f.expire();
      expect(() => f.kernel.performWorktreeMutation(f.mutation, runtimeContext, () => {})).toThrow();
      await expect(f.kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "unsafe-reacquire",
        worktreeId: "tree", leaseDurationMs: 30_000,
      }, runtimeContext)).rejects.toMatchObject({ code: "DomainBusy" });
      await f.kernel.execute({
        type: "RecoverWorktreeExecution", idempotencyKey: "recovery",
        executionId: f.receipt.executionId, reason: "Original process handle unavailable.",
      }, runtimeContext);
      const quarantine = await f.kernel.execute({
        type: "QuarantineWorktreeWriterLease", idempotencyKey: "quarantine",
        worktreeId: "tree", reason: "Unconfirmed physical stop.",
      }, runtimeContext);
      await expect(f.kernel.execute({
        type: "ResolveWorktreeWriterLeaseQuarantine", idempotencyKey: "unsafe-resolve",
        worktreeId: "tree", expectedRevision: quarantine.revision!,
        expectedFencingToken: quarantine.fencingToken!, quarantineToken: quarantine.quarantineToken!,
        resolution: "A newer generation is not evidence.",
      }, runtimeContext)).rejects.toMatchObject({ code: "DomainBusy" });
      expect((await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext)).state)
        .toBe("Quarantined");
    } finally { f.kernel.close(); }
  });

  it("preserves stop history and accepts late exact-handle evidence, not stale mutation", async () => {
    const f = await setup();
    try {
      for (const state of ["Running", "StopRequested", "Uncertain", "StopConfirmed"] as const) {
        await f.kernel.execute({
          type: "RecordWorktreeExecution", idempotencyKey: state, ...f.receipt,
          state, pid: 123, evidence: state === "StopConfirmed" ? "Original child close: code=0." : state,
        }, runtimeContext);
        if (state !== "Running") {
          expect(() => f.kernel.performWorktreeMutation(f.mutation, runtimeContext, () => {})).toThrow();
        }
      }
      const physical = await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext);
      expect(physical.state).toBe("Ready");
      expect(physical.latestExecution?.events.map((event) => event.state)).toEqual([
        "Starting", "Running", "StopRequested", "Uncertain", "StopConfirmed",
      ]);
      await f.kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: "release", ...f.authority,
      }, runtimeContext);
      const lease = await f.kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "next",
        worktreeId: "tree", leaseDurationMs: 30_000,
      }, runtimeContext);
      expect(lease.leaseGeneration).toBe(2);
      await expect(f.kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "start",
        ...f.authority, activationId: f.run.activationId, executorId: "host-one",
      }, runtimeContext)).rejects.toThrow();
    } finally { f.kernel.close(); }
  });

  it("rejects directory aliases and checks current Run authority at each effect", async () => {
    const f = await setup();
    try {
      await expect(f.kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "alias",
        worktreeId: "alias", runId: f.run.runId, repositoryId: "synthetic",
        repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "another-path", directoryIdentity: "1:2",
      }, runtimeContext)).rejects.toMatchObject({ code: "Conflict" });
      await expect(f.kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "nested",
        worktreeId: "nested", runId: f.run.runId, repositoryId: "synthetic",
        repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "synthetic-private-tree/nested", directoryIdentity: "1:3",
      }, runtimeContext)).rejects.toMatchObject({ code: "Conflict" });
      await f.kernel.execute({
        type: "CancelRun", idempotencyKey: "cancel", runId: f.run.runId,
        expectedRunRevision: 1, reason: "Stop synthetic work.",
      }, humanContext);
      expect(() => f.kernel.performWorktreeMutation(f.mutation, runtimeContext, () => {})).toThrow();
      await f.kernel.execute({
        type: "RecordWorktreeExecution", idempotencyKey: "no-spawn", ...f.receipt,
        state: "StopConfirmed", evidence: "No spawn occurred.",
      }, runtimeContext);
    } finally { f.kernel.close(); }
  });
});
