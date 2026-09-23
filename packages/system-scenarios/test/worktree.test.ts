import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.8.1: fixed child stop retains the new Writer fence through durable publication and SSE", async () => {
  await runSystemScenario(async (system) => {
    expect(system.worktrees).toBeDefined();
    const worktrees = system.worktrees!;
    const publish = system.gate();
    let worktreeId = "";
    let runId = "";
    let oldLease: { generation: number; fencingToken: number; leaseToken: string };
    system.provider(async ({ cause, capabilities, worktree }) => {
      if (cause.type === "attention") {
        runId = await capabilities.createRunFromAttention();
        worktreeId = await worktrees.register(runId);
        const lease = await system.kernel.execute({
          type: "AcquireWorktreeWriterLease", idempotencyKey: "initial-writer",
          worktreeId, leaseDurationMs: 30_000,
        }, system.runtimePrincipal);
        oldLease = {
          generation: lease.leaseGeneration!,
          fencingToken: lease.fencingToken!, leaseToken: lease.leaseToken!,
        };
        await system.kernel.execute({
          type: "ReleaseWorktreeWriterLease", idempotencyKey: "initial-release",
          worktreeId, ...oldLease,
        }, system.runtimePrincipal);
      } else {
        expect(await worktree!.probe(worktreeId)).toEqual({
          digest: createHash("sha256").update("Torsor controlled Worktree probe v1.\n").digest("hex"),
          stop: "StopConfirmed",
        });

        await publish.wait();
        await capabilities.publishReport({ idempotencyKey: "probe-report", text: "Synthetic probe report." });
        await capabilities.appendActivity("worktree_probe", { text: "Synthetic probe stopped normally." });
        await capabilities.complete({
          incorporatedThroughInputSequence: 1, finalReply: { body: "Synthetic probe completed." },
        });
      }
    });
    const threadId = await system.startThread();
    const draining = system.drain();
    await Promise.race([publish.entered, draining.then(() => {
      throw new Error("Runtime ended before probe publication readiness.");
    })]);
    const physical = await system.kernel.query({ type: "GetPhysicalWorktree", worktreeId }, system.runtimePrincipal);
    expect(physical).toMatchObject({
      runId, state: "Ready", latestExecution: {
        state: "StopConfirmed", generation: 2, authorityRevokedAt: null, pid: expect.any(Number),
      },
    });
    expect(physical.latestExecution!.fencingToken).toBeGreaterThan(oldLease!.fencingToken);
    expect(await system.kernel.query({ type: "GetWorktreeWriterLease", worktreeId }, system.runtimePrincipal))
      .toMatchObject({ status: "Active", generation: 2 });
    await expect(system.kernel.execute({
      type: "RenewWorktreeWriterLease", idempotencyKey: "stale-renewal", worktreeId,
      ...oldLease!, leaseDurationMs: 30_000,
    }, system.runtimePrincipal)).rejects.toMatchObject({ code: "ConditionalCheckFailed" });
    await system.web.loadThread(threadId);
    await system.web.loadRun(runId);
    expect(system.web.getSnapshot().run!.run.state).toBe("Active");
    publish.release();
    await draining;
    await system.sync();
    const state = system.web.getSnapshot();
    expect(state.run!.run.state).toBe("Completed");
    expect(state.run!.inputs).toHaveLength(1);
    expect(state.run!.inputs[0]!.disposition).toBe("Incorporated");
    expect(state.run!.artifacts).toHaveLength(1);
    expect(state.run!.activity.items.map((item) => item.sequence)).toEqual([1]);
    expect(state.thread!.messages).toHaveLength(2);
    expect(state.thread!.messages[1]!.revisions.at(-1)!.body).toBe("Synthetic probe completed.");
    expect(await system.kernel.query({ type: "GetWorktreeWriterLease", worktreeId }, system.runtimePrincipal))
      .toMatchObject({ status: "Released", generation: 2 });
  }, { worktrees: "fixed" });
});
