import type { ProviderExecutionContext } from "@torsor/agent-runtime";
import { expect, it, vi } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.8.2: exact expiry fences a live Writer; unknown stop quarantines until original close", async () => {
  await runSystemScenario(async (system) => {
    const worktrees = system.worktrees!;
    expect(worktrees.processes).toBeDefined();
    const started = worktrees.processes!.holdNext();
    let source: ProviderExecutionContext;
    let worktreeId = "";
    let runId = "";
    system.provider(async (context) => {
      if (context.cause.type === "attention") {
        runId = await context.capabilities.createRunFromAttention();
        worktreeId = await worktrees.register(runId);
      } else {
        source = context;
        await context.worktree!.probe(worktreeId);
        await context.capabilities.complete({ finalReply: { body: "Must not publish expired output." } });
      }
    });
    const threadId = await system.startThread();
    const draining = system.drain();
    const child = await Promise.race([started, draining.then(() => {
      throw new Error("Runtime ended before controlled child readiness.");
    })]);
    const checkpoint = {
      type: "AppendRunActivity" as const, idempotencyKey: "before-expiry",
      activationId: source!.activationId, runId, kind: "checkpoint",
      payload: { text: "Synthetic pre-expiry fact." }, retentionClass: "durable" as const,
    };
    system.clock.advance(999);
    await system.kernel.execute(checkpoint, system.runtimePrincipal);
    const before = await system.kernel.query({ type: "GetPhysicalWorktree", worktreeId }, system.runtimePrincipal);
    expect(before.latestExecution).toMatchObject({ state: "Running", generation: 1 });
    await system.web.loadThread(threadId);
    await system.web.loadRun(runId);
    system.clock.advance(1);
    for (const publish of [
      () => system.kernel.execute(checkpoint, system.runtimePrincipal),
      () => source!.capabilities.appendActivity("late_success", { text: "Must not publish." }),
      () => source!.capabilities.publishReply({ body: "Must not publish." }),
      () => source!.capabilities.publishReport({ idempotencyKey: "stale-report", text: "Must not publish." }),
      () => source!.capabilities.complete({ incorporatedThroughInputSequence: 1 }),
      () => system.kernel.execute({
        type: "FinishProviderAttempt", idempotencyKey: "stale-provider-success",
        providerAttemptId: source!.providerAttemptId, status: "Completed",
      }, system.runtimePrincipal),
      () => system.kernel.execute({
        type: "FinishActivation", idempotencyKey: "stale-activation-success",
        activationId: source!.activationId, outcome: "Completed",
      }, system.runtimePrincipal),
    ]) await expect(publish()).rejects.toMatchObject({ code: "WriterAuthorityLost" });
    expect(child.live).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(child.stopRequests).toBe(1);
    expect(child.live).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.forceRequests).toBe(1);
    expect(child.live).toBe(true);
    await system.expectRuntimeFailure(draining, (error) => {
      expect(error).toMatchObject({
        diagnosticCode: "provider_worktree_execution_failed",
        outcome: "Unknown",
        message: "provider_worktree_execution_failed: Controlled Worktree execution did not complete.",
      });
    });
    expect(await system.kernel.query({ type: "GetPhysicalWorktree", worktreeId }, system.runtimePrincipal))
      .toMatchObject({ state: "Quarantined", latestExecution: {
        state: "Uncertain", authorityRevokedAt: expect.any(String),
      } });
    await expect(system.kernel.execute({
      type: "AcquireWorktreeWriterLease", idempotencyKey: "unsafe-replacement", worktreeId, leaseDurationMs: 1000,
    }, system.runtimePrincipal)).rejects.toMatchObject({ code: "DomainBusy" });
    child.emitResult();
    child.confirmStop();
    await worktrees.executor.stopActivation(source!.activationId);
    await worktrees.executor.stopActivation(source!.activationId);
    expect(child.stopRequests).toBe(1);
    expect(child.forceRequests).toBe(1);
    expect(await system.kernel.query({ type: "GetPhysicalWorktree", worktreeId }, system.runtimePrincipal))
      .toMatchObject({ state: "Ready", latestExecution: {
        id: before.latestExecution!.id, state: "StopConfirmed", authorityRevokedAt: expect.any(String),
      } });
    const replacement = await system.kernel.execute({
      type: "AcquireWorktreeWriterLease", idempotencyKey: "safe-replacement", worktreeId, leaseDurationMs: 1000,
    }, system.runtimePrincipal);
    expect(replacement.leaseGeneration).toBe(2);
    expect(replacement.fencingToken).toBeGreaterThan(before.latestExecution!.fencingToken);
    await expect(source!.capabilities.publishReply({ body: "Must not revive." }))
      .rejects.toMatchObject({ code: "WriterAuthorityLost" });
    await system.kernel.execute({
      type: "ReleaseWorktreeWriterLease", idempotencyKey: "replacement-release", worktreeId,
      generation: replacement.leaseGeneration!, fencingToken: replacement.fencingToken!, leaseToken: replacement.leaseToken!,
    }, system.runtimePrincipal);
    await system.sync();
    const state = system.web.getSnapshot();
    expect(state.run!.run.state).toBe("Active");
    expect(state.run!.providerAttempts.map((attempt) => attempt.status)).toEqual(["Unknown"]);
    expect(state.run!.artifacts).toHaveLength(0);
    expect(state.run!.activity.items.map((item) => item.kind)).toEqual(["checkpoint"]);
    expect(state.run!.inputs[0]!.disposition).toBe("Pending");
    expect(state.thread!.messages).toHaveLength(1);
    expect(system.events.some((event) => event.type === "RunCompleted")).toBe(false);
  }, { worktrees: "scripted" });
});
