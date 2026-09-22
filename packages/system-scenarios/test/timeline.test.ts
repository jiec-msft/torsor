import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.4: reconnect fills bounded gaps and duplicate/reversed SSE retains loaded history", async () => {
  await runSystemScenario(async (system) => {
    const disconnected = system.gate();
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") {
        await capabilities.createRunFromAttention();
        return;
      }
      for (let index = 1; index <= 130; index += 1) {
        await capabilities.appendActivity("assistant_delta", { text: `Synthetic ${index}` });
      }
      await disconnected.wait();
      for (let index = 131; index <= 360; index += 1) {
        await capabilities.appendActivity("assistant_delta", { text: `Synthetic ${index}` });
      }
      await capabilities.complete();
    });
    const threadId = await system.startThread();
    const draining = system.drain();
    await disconnected.entered;
    const thread = await system.kernel.query(
      { type: "GetThreadProjection", threadRootId: threadId }, system.human,
    );
    const runId = thread.runs[0]!.id;
    await system.web.loadRun(runId);
    expect(system.web.getSnapshot().run!.activity.items).toHaveLength(100);
    await system.web.loadEarlierRunActivity();
    const history = system.web.getSnapshot().run!.activity.items;
    expect(history).toHaveLength(130);
    await system.sync();
    await system.disconnect();
    const requestBoundary = system.http.requests.length;
    disconnected.release();
    await draining;
    await system.sync("reverse-duplicate");
    await system.replayEvents("reverse-duplicate");
    const activity = system.web.getSnapshot().run!.activity;
    expect(activity.items.map((item) => item.sequence))
      .toEqual(Array.from({ length: 360 }, (_, index) => index + 1));
    expect(activity.items.slice(0, 130)).toEqual(history);
    expect(new Set(activity.items.map((item) => item.id)).size).toBe(360);
    expect(activity.hasEarlier).toBe(false);
    expect(system.web.getSnapshot().run!.run.state).toBe("Completed");
    const gaps = system.http.requests.slice(requestBoundary)
      .filter((request) => request.path.includes("/activity?"))
      .map((request) => new URL(request.path, system.http.origin).searchParams);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.length).toBeLessThanOrEqual(4);
    for (const gap of gaps) {
      expect(gap.get("limit")).toBe("100");
      expect(gap.get("beforeSequence")).toBe("261");
      expect(Number(gap.get("afterSequence"))).toBeGreaterThanOrEqual(130);
    }
  });
});
