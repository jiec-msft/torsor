import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-2.4: an empty SSE prefix opens and reconnects without commands or fabricated facts", async () => {
  await runSystemScenario(async (system) => {
    expect(system.web.getSnapshot().connection).toBe("connecting");
    await system.sync();
    expect(system.web.getSnapshot().connection).toBe("live");
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") await capabilities.createRunFromAttention();
      else await capabilities.complete({ finalReply: { body: "Synthetic connection result." } });
    });
    const threadId = await system.startThread();
    await system.drain();
    const [run] = await system.runs();
    await system.web.loadThread(threadId);
    await system.web.loadRun(run!.run.id);
    await system.sync();
    const facts = [...system.events];
    const before = system.http.requests.length;
    await system.disconnect();
    expect(system.web.getSnapshot().connection).toBe("reconnecting");
    await system.sync();
    expect(system.web.getSnapshot().connection).toBe("live");
    expect(system.events).toEqual(facts);
    expect(system.http.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
    expect(system.http.requests.slice(before).some((request) => request.path.includes(`/runs/${run!.run.id}`)))
      .toBe(true);
    const reopened = await system.reopen();
    await reopened.sync();
    expect(reopened.web.getSnapshot().connection).toBe("live");
    expect(reopened.events).toHaveLength(0);
  });
});
