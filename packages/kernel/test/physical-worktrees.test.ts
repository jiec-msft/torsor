import { describe, expect, it } from "vitest";

import { bootstrap, createRun, runtimeContext, humanContext } from "./helpers.js";
import { TorsorKernel, type ArtifactStorage, type WorktreeMutationAuthority } from "../src/index.js";

async function setup(artifactStorage?: ArtifactStorage) {
  let now = new Date("2026-09-22T08:00:00Z");
  const kernel = TorsorKernel.open({
    databasePath: ":memory:", bootstrap, clock: () => now,
    ...(artifactStorage ? { artifactStorage } : {}),
  });
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
    rewind: () => { now = new Date("2026-09-22T08:00:00Z"); },
  };
}

describe("physical execution contracts (§22, §24, §38)", () => {
  it("fences a stopped old generation while a replacement Activation recovers an authorized committed Artifact", async () => {
    const content = Buffer.from("Synthetic controlled report.\n");
    const f = await setup({ put: async () => {}, read: async () => content });
    try {
      for (const state of ["Running", "StopRequested", "StopConfirmed"] as const) {
        await f.kernel.execute({
          type: "RecordWorktreeExecution", idempotencyKey: state, ...f.receipt,
          state, evidence: "Synthetic exact-handle evidence.", preservePublicationAuthority: true,
        }, runtimeContext);
      }
      const input = { idempotencyKey: "controlled-report", runId: f.run.runId, expectedRunRevision: 1, content };
      const artifact = await f.kernel.finalizeReport(input, f.run.agentContext);
      await f.kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: "release", ...f.authority,
      }, runtimeContext);
      const lease = await f.kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "replacement-lease",
        worktreeId: "tree", leaseDurationMs: 30_000,
      }, runtimeContext);
      expect(lease.leaseGeneration).toBe(2);
      await expect(f.kernel.finalizeReport(input, f.run.agentContext))
        .rejects.toMatchObject({ code: "WriterAuthorityLost" });
      await expect(f.kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "old-activation-new-token",
        worktreeId: "tree", activationId: f.run.activationId, executorId: "replacement-host",
        leaseToken: lease.leaseToken!, generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!,
      }, runtimeContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
      const replacement = await f.kernel.execute({
        type: "StartActivation", idempotencyKey: "replacement-activation", runId: f.run.runId,
        expectedRunRevision: 1, outboxEventId: f.run.outboxEventId, outboxLeaseToken: f.run.outboxLeaseToken,
      }, runtimeContext);
      await f.kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "replacement-execution",
        worktreeId: "tree", activationId: replacement.entityId, executorId: "replacement-host",
        leaseToken: lease.leaseToken!, generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!,
      }, runtimeContext);
      const actor = { principalId: f.run.agentContext.principalId, activationId: replacement.entityId };
      expect(await f.kernel.finalizeReport(input, actor)).toEqual(artifact);
      expect((await f.kernel.readArtifact(artifact.entityId, actor)).artifact)
        .toMatchObject({ producerActivationId: f.run.activationId, producerRunId: f.run.runId });
      expect(() => f.kernel.performWorktreeMutation(f.mutation, runtimeContext, () => {})).toThrow();
    } finally { f.kernel.close(); }
  });

  it.each(["expiry", "quarantine", "recovery"] as const)(
    "fences Agent effects, cached activities, reports and Runtime success after %s without publishing facts",
    async (loss) => {
      let writes = 0;
      const f = await setup({
        put: async () => { writes++; },
        read: async () => { throw new Error("No Artifact should be readable."); },
      });
      try {
        const activity = {
          type: "AppendRunActivity" as const, idempotencyKey: "activity",
          runId: f.run.runId, activationId: f.run.activationId,
          kind: "agent_message", payload: { text: "Synthetic progress." }, retentionClass: "durable" as const,
        };
        await f.kernel.execute(activity, f.run.agentContext);
        const attempt = await f.kernel.execute({
          type: "StartProviderAttempt", idempotencyKey: "provider", activationId: f.run.activationId,
          outboxEventId: f.run.outboxEventId, outboxLeaseToken: f.run.outboxLeaseToken,
          adapter: "synthetic", adapterVersion: "1", capabilitySnapshot: {},
          runInputIds: [f.run.runInputId], requestIdempotencyKey: "provider-request",
        }, runtimeContext);
        if (loss === "expiry") f.expire();
        else if (loss === "quarantine") {
          await f.kernel.execute({
            type: "QuarantineWorktreeWriterLease", idempotencyKey: "publication-quarantine",
            worktreeId: "tree", reason: "Synthetic authority revocation.",
            expectedGeneration: f.authority.generation, expectedFencingToken: f.authority.fencingToken,
            leaseToken: f.authority.leaseToken,
          }, runtimeContext);
        } else {
          await f.kernel.execute({
            type: "RecoverWorktreeExecution", idempotencyKey: "publication-recovery",
            executionId: f.receipt.executionId, reason: "Original executor unavailable.",
          }, runtimeContext);
        }
        const events = await f.kernel.readEvents(null, 500);
        const before = await f.kernel.query({ type: "GetRunProjection", runId: f.run.runId }, humanContext);
        for (const command of [
          activity,
          { ...activity, idempotencyKey: "late-activity" },
          { type: "PublishRunReply", idempotencyKey: "late-reply", runId: f.run.runId, expectedRunRevision: 1, body: "Stale reply." },
          { type: "CompleteRun", idempotencyKey: "late-complete", runId: f.run.runId, expectedRunRevision: 1, incorporatedThroughInputSequence: 1 },
          { type: "RecordLateOutput", idempotencyKey: "late-output", runId: f.run.runId, activationId: f.run.activationId, payload: "Stale output." },
        ] as const) {
          await expect(f.kernel.execute(command, f.run.agentContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
        }
        for (const command of [
          { ...activity, idempotencyKey: "runtime-activity" },
          { type: "FinishProviderAttempt", idempotencyKey: "runtime-success", providerAttemptId: attempt.entityId, status: "Completed" },
          { type: "FinishActivation", idempotencyKey: "activation-success", activationId: f.run.activationId, outcome: "Completed" },
        ] as const) {
          await expect(f.kernel.execute(command, runtimeContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
        }
        await expect(f.kernel.finalizeReport({
          idempotencyKey: "late-report", runId: f.run.runId, expectedRunRevision: 1, content: Buffer.from("Synthetic report."),
        }, f.run.agentContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
        expect(writes).toBe(0);
        expect(await f.kernel.readEvents(null, 500)).toEqual(events);
        expect(await f.kernel.query({ type: "GetRunProjection", runId: f.run.runId }, humanContext)).toEqual(before);
        f.rewind();
        await expect(f.kernel.execute({ ...activity, idempotencyKey: "clock-rollback" }, f.run.agentContext))
          .rejects.toMatchObject({ code: "WriterAuthorityLost" });
        await f.kernel.execute({
          type: "FinishProviderAttempt", idempotencyKey: "runtime-unknown",
          providerAttemptId: attempt.entityId, status: "Unknown", detail: "Controlled execution authority was lost.",
        }, runtimeContext);
        await f.kernel.execute({
          type: "RecordWorktreeExecution", idempotencyKey: "safe-stop", ...f.receipt,
          state: "StopConfirmed", evidence: "Original child close.",
        }, runtimeContext);
        await expect(f.kernel.execute({ ...activity, idempotencyKey: "late-close" }, f.run.agentContext))
          .rejects.toMatchObject({ code: "WriterAuthorityLost" });
      } finally { f.kernel.close(); }
    },
  );

  it("rejects Artifact finalization when authority expires during trusted storage acknowledgement", async () => {
    let writes = 0;
    const f = await setup({
      put: async () => { writes++; f.expire(); },
      read: async () => { throw new Error("Unreferenced bytes are not a descriptor."); },
    });
    try {
      const events = await f.kernel.readEvents(null, 500);
      const before = await f.kernel.query({ type: "GetRunProjection", runId: f.run.runId }, humanContext);
      await expect(f.kernel.finalizeReport({
        idempotencyKey: "racing-report", runId: f.run.runId, expectedRunRevision: 1, content: Buffer.from("Synthetic bytes."),
      }, f.run.agentContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
      expect(writes).toBe(1);
      expect(await f.kernel.readEvents(null, 500)).toEqual(events);
      expect(await f.kernel.query({ type: "GetRunProjection", runId: f.run.runId }, humanContext)).toEqual(before);
      f.rewind();
      await expect(f.kernel.finalizeReport({
        idempotencyKey: "retry-report", runId: f.run.runId, expectedRunRevision: 1, content: Buffer.from("Synthetic bytes."),
      }, f.run.agentContext)).rejects.toMatchObject({ code: "WriterAuthorityLost" });
      expect(writes).toBe(1);
    } finally { f.kernel.close(); }
  });

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
