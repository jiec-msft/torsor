import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.2: Human request reaches durable completion and Web Timeline through real SSE", async () => {
  await runSystemScenario(async (system) => {
    const completion = system.gate();
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") {
        await capabilities.createRunFromAttention();
      } else {
        await capabilities.appendActivity("assistant_delta", { text: "Inspecting." });
        await capabilities.appendActivity("assistant_delta", { text: "Ready." });
        await completion.wait();
        await capabilities.complete({ finalReply: { body: "Synthetic work completed." } });
      }
    });

    const threadId = await system.startThread();
    const draining = system.drain();
    await completion.entered;
    const thread = await system.kernel.query(
      { type: "GetThreadProjection", threadRootId: threadId }, system.human,
    );
    expect(thread.runs).toHaveLength(1);
    const runId = thread.runs[0]!.id;
    await system.web.loadThread(threadId);
    await system.web.loadRun(runId);
    expect(system.web.getSnapshot().run!.run.state).toBe("Active");
    completion.release();
    await draining;
    await system.sync();
    const durable = await system.kernel.query(
      { type: "GetRunProjection", runId }, system.human,
    );
    expect(durable.run.state).toBe("Completed");
    expect(durable.inputs).toHaveLength(1);
    expect(durable.inputs[0]!.disposition).toBe("Incorporated");
    expect(system.web.getSnapshot().thread!.messages).toHaveLength(2);
    expect(system.web.getSnapshot().thread!.messages[1]!.revisions.at(-1)!.body)
      .toBe("Synthetic work completed.");
    const activity = system.web.getSnapshot().run!.activity.items;
    expect(activity.map((item) => item.sequence)).toEqual([1, 2]);
    expect(activity.map((item) => item.payload)).toEqual([
      { text: "Inspecting." }, { text: "Ready." },
    ]);
    expect(new Set(system.events.map((event) => event.eventId)).size).toBe(system.events.length);
    expect(system.events.some((event) => event.type === "RunCompleted")).toBe(true);
    expect(system.web.getSnapshot().run!.run.state).toBe("Completed");
  });
});
