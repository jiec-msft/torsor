import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.7: process crash preserves committed facts, hides uncommitted report and resumes from SQLite", async () => {
  await runSystemScenario(async (system) => {
    const threadId = await system.startThread();
    await system.crashDuringReport();
    const [before] = await system.runs();
    expect(before!.run.state).toBe("Active");
    expect(before!.inputs).toHaveLength(1);
    expect(before!.inputs[0]!.disposition).toBe("Pending");
    expect(before!.activity.items.filter((item) => item.kind === "synthetic_checkpoint")).toHaveLength(1);
    expect(before!.artifacts).toHaveLength(0);
    const reopened = await system.reopen();
    reopened.clock.advance(30_001);
    let continuations = 0;
    reopened.provider(async ({ cause, capabilities }) => {
      expect(cause.type).toBe("run");
      if (cause.type !== "run") throw new Error("Recovery must use the durable Run.");
      continuations += 1;
      expect(cause.run.inputs.map((input) => input.id)).toEqual(before!.inputs.map((input) => input.id));
      expect(cause.run.activity.items.some((item) => item.kind === "synthetic_checkpoint")).toBe(true);
      await capabilities.publishReport({ idempotencyKey: "crash-report", text: "Synthetic crash report.\n" });
      await capabilities.complete({ finalReply: { body: "Resumed from durable facts." } });
    });
    await reopened.drain();
    await reopened.drain();
    expect(continuations).toBe(1);
    const [after] = await reopened.runs();
    expect(after!.run.state).toBe("Completed");
    expect(after!.inputs).toHaveLength(1);
    expect(after!.artifacts).toHaveLength(1);
    expect(after!.activity.items.filter((item) => item.kind === "synthetic_checkpoint")).toHaveLength(1);
    expect(after!.providerAttempts.map((attempt) => attempt.status)).toEqual(["Unknown", "Completed"]);
    await reopened.web.loadThread(threadId);
    await reopened.web.loadRun(after!.run.id);
    await reopened.sync();
    expect(reopened.web.getSnapshot().thread!.messages).toHaveLength(2);
    expect(reopened.events.filter((event) => event.type === "ArtifactPublished")).toHaveLength(1);
  });
});
