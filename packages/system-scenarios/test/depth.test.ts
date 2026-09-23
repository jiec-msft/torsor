import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.5: public Provider delegation admits depth four and rejects five without orphan facts", async () => {
  await runSystemScenario(async (system) => {
    const rejected: unknown[] = [];
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") {
        try { await capabilities.createRunFromAttention(); }
        catch (error) {
          rejected.push(error);
          await capabilities.ignoreAttention("Synthetic depth boundary reached.");
        }
      } else {
        await capabilities.complete({
          finalReply: {
            body: "Delegate synthetic work.",
            targetAgentIds: [cause.run.run.ownerAgentId === "agent-orbit" ? "agent-keel" : "agent-orbit"],
          },
        });
      }
    });
    const root = await system.startThread();
    await system.drain();
    const runs = await system.runs();
    expect(runs.map((projection) => projection.run.delegationDepth).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: "CausalLimitExceeded",
      details: { causalRootId: root, delegationDepth: 5 },
    });
    expect(runs.every((projection) => projection.run.causalRootId === root)).toBe(true);
    expect(runs.every((projection) => projection.inputs.length === 1)).toBe(true);
    expect(runs.every((projection) => projection.run.state === "Completed")).toBe(true);
    await system.web.loadThread(root);
    await system.sync();
    expect(system.web.getSnapshot().thread!.runs).toHaveLength(5);
    expect(system.events.filter((event) => event.type === "RunCreated")).toHaveLength(5);
  });
});
