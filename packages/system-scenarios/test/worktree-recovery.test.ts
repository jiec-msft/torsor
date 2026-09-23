import type { ProviderExecutionContext } from "@torsor/agent-runtime";
import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.8.3: concurrent fresh Runtime wins in an isolated directory and rejects late old output", async () => {
  await runSystemScenario(async (system) => {
    expect(system.fork).toBeTypeOf("function");
    const started = system.worktrees!.processes!.holdNext();
    let old: ProviderExecutionContext;
    let oldWorktree = "";
    let runId = "";
    system.provider(async (context) => {
      if (context.cause.type === "attention") {
        runId = await context.capabilities.createRunFromAttention();
        oldWorktree = await system.worktrees!.register(runId);
      } else {
        old = context;
        await expect(context.worktree!.probe(oldWorktree)).rejects.toMatchObject({ outcome: "Unknown" });
        await expect(context.capabilities.complete({ finalReply: { body: "Must not publish late output." } }))
          .rejects.toMatchObject({ code: "WriterAuthorityLost" });
      }
    });
    const threadId = await system.startThread();
    const originalWork = system.drain();
    const child = await Promise.race([started, originalWork.then(() => {
      throw new Error("Original Runtime ended before controlled child readiness.");
    })]);
    const [before] = await system.runs();
    await system.web.loadThread(threadId);
    await system.web.loadRun(runId);
    const replacement = await system.fork();
    expect(child.live).toBe(true);
    const abandoned = await replacement.kernel.query(
      { type: "GetPhysicalWorktree", worktreeId: oldWorktree }, replacement.runtimePrincipal,
    );
    expect(abandoned).toMatchObject({
      state: "Quarantined", latestExecution: { state: "Uncertain", authorityRevokedAt: expect.any(String) },
    });
    await expect(replacement.kernel.execute({
      type: "AcquireWorktreeWriterLease", idempotencyKey: "replacement-cannot-reuse-live-directory",
      worktreeId: oldWorktree, leaseDurationMs: 1000,
    }, replacement.runtimePrincipal)).rejects.toMatchObject({ code: "DomainBusy" });
    replacement.clock.advance(30_001);
    let newWorktree = "";
    let executions = 0;
    replacement.provider(async ({ cause, capabilities, worktree, activationId }) => {
      expect(cause.type).toBe("run");
      if (cause.type !== "run") throw new Error("Replacement must reconstruct the durable Run.");
      executions += 1;
      expect(activationId).not.toBe(old!.activationId);
      expect(cause.run.run.activationGeneration).toBe(2);
      expect(cause.run.inputs.map((input) => input.id)).toEqual(before!.inputs.map((input) => input.id));
      newWorktree = await replacement.worktrees!.register(cause.run.run.id);
      expect(await worktree!.probe(newWorktree)).toMatchObject({ stop: "StopConfirmed" });
      await capabilities.publishReport({ idempotencyKey: "replacement-report", text: "Synthetic recovery report." });
      await capabilities.appendActivity("recovery_complete", { text: "Synthetic replacement completed." });
      await capabilities.complete({
        incorporatedThroughInputSequence: 1, finalReply: { body: "Recovered from durable input." },
      });
    });
    await replacement.drain();
    await replacement.drain();
    expect(executions).toBe(1);
    expect(child.live).toBe(true);
    const newPhysical = await replacement.kernel.query(
      { type: "GetPhysicalWorktree", worktreeId: newWorktree }, replacement.runtimePrincipal,
    );
    expect(newPhysical.directoryIdentity).not.toBe(abandoned.directoryIdentity);
    expect(newPhysical.baseRevision).toBe(abandoned.baseRevision);
    expect(newPhysical.latestExecution).toMatchObject({ state: "StopConfirmed" });
    const [completed] = await replacement.runs();
    expect(completed!.run.state).toBe("Completed");
    expect(completed!.run.activationGeneration).toBe(2);
    expect(completed!.providerAttempts.map((attempt) => attempt.status)).toEqual(["Unknown", "Completed"]);
    expect(completed!.artifacts).toHaveLength(1);
    child.emitResult();
    child.confirmStop();
    await system.expectRuntimeFailure(originalWork, (error) => {
      expect(error).toMatchObject({ code: "Conflict", message: "The Activation is already finished." });
    });
    expect(await replacement.runs()).toEqual([completed]);
    expect(await replacement.kernel.query(
      { type: "GetPhysicalWorktree", worktreeId: newWorktree }, replacement.runtimePrincipal,
    )).toEqual(newPhysical);
    await system.sync("reverse-duplicate");
    expect(system.web.getSnapshot().run!.run.state).toBe("Completed");
    expect(system.web.getSnapshot().run!.activity.items.map((item) => item.kind)).toEqual(["recovery_complete"]);
    expect(system.web.getSnapshot().thread!.messages).toHaveLength(2);
    expect(system.web.getSnapshot().thread!.messages[1]!.revisions.at(-1)!.body).toBe("Recovered from durable input.");
    const reopened = await replacement.reopen();
    reopened.provider(async () => { throw new Error("Committed work must not execute after reopen."); });
    await reopened.drain();
    await reopened.drain();
    expect(await reopened.runs()).toEqual([completed]);
    await reopened.web.loadThread(threadId);
    await reopened.web.loadRun(runId);
    await reopened.sync();
    expect(reopened.web.getSnapshot().run!.artifacts).toHaveLength(1);
    expect(reopened.web.getSnapshot().thread!.messages).toHaveLength(2);
  }, { worktrees: "scripted" });
});
