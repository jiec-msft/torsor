import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.3: lost Send-to-Run response freezes identity; recovery reads never resend", async () => {
  await runSystemScenario(async (system) => {
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") await capabilities.createRunFromAttention();
      else await capabilities.wait("Await synthetic Human input.");
    });
    const threadId = await system.startThread();
    await system.drain();
    const thread = await system.kernel.query(
      { type: "GetThreadProjection", threadRootId: threadId }, system.human,
    );
    const runId = thread.runs[0]!.id;
    await system.web.loadThread(threadId);
    await system.web.loadRun(runId);
    system.web.runComposer.edit(runId, "One durable instruction.");
    system.http.loseNextResponse("/api/v1/commands/send-to-run");
    await system.web.sendToRun(runId);
    const unknown = system.web.runComposer.getSnapshot()[runId]!;
    expect(unknown.status).toBe("unknown");
    const identity = unknown.request!;
    expect(identity).not.toBeNull();
    expect((await system.kernel.query({ type: "GetRunProjection", runId }, system.human)).inputs)
      .toHaveLength(2);
    await system.web.refreshRunComposer(runId);
    expect(system.web.runComposer.getSnapshot()[runId]!.request).toBe(identity);
    const sends = () => system.http.requests.filter((request) => request.path.endsWith("/send-to-run"));
    expect(sends()).toHaveLength(1);
    await expect(system.kernel.execute({
      type: "SendToRun", ...identity, body: "Changed synthetic payload.",
    }, system.human)).rejects.toMatchObject({ code: "Conflict" });
    system.http.failNextRead(`/api/v1/runs/${runId}`);
    await system.web.sendToRun(runId);
    expect(sends()).toHaveLength(2);
    expect(sends()[1]!.body).toBe(sends()[0]!.body);
    expect(system.web.runComposer.getSnapshot()[runId]).toMatchObject({
      status: "submitted", request: null, projectionStatus: "failed",
    });
    await system.web.refreshRunComposer(runId);
    await system.sync();
    expect(sends()).toHaveLength(2);
    expect(system.web.getSnapshot().run!.inputs).toHaveLength(2);
    expect(system.web.getSnapshot().thread!.messages).toHaveLength(2);
    expect(system.events.filter((event) => event.type === "RunInputAdded")).toHaveLength(1);
    expect(system.events.filter((event) => event.type === "RunCreated")).toHaveLength(1);
  });
});
