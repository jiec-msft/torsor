import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.5: fifty nonterminal Runs occupy one root; terminal release admits one retry", async () => {
  await runSystemScenario(async (system) => {
    const full = system.gate();
    const rejections: unknown[] = [];
    system.provider(async ({ cause, capabilities }) => {
      if (cause.type === "attention") {
        try { await capabilities.createRunFromAttention(); }
        catch (error) {
          rejections.push(error);
          await full.wait();
          await capabilities.createRunFromAttention();
        }
        return;
      }
      if (cause.run.run.delegationDepth === 0) {
        for (let index = 0; index < 50; index += 1) {
          await capabilities.publishReply({
            body: `Synthetic sibling ${index}`, targetAgentIds: ["agent-keel"],
          });
        }
      }
      await capabilities.wait("Synthetic capacity remains occupied.");
    });
    const root = await system.startThread();
    const draining = system.drain();
    await full.entered;
    const before = await system.runs();
    expect(before).toHaveLength(50);
    expect(before.every(({ run }) => ["Active", "Waiting"].includes(run.state))).toBe(true);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      code: "CausalLimitExceeded",
      details: { causalRootId: root, nonTerminalRunCount: 50 },
    });
    const parent = before.find(({ run }) => run.delegationDepth === 0)!.run;
    expect(parent.state).toBe("Waiting");
    await system.cancel(parent.id);
    full.release();
    await draining;
    await system.drain();
    const after = await system.runs();
    expect(after).toHaveLength(51);
    expect(after.filter(({ run }) => run.state === "Waiting")).toHaveLength(50);
    expect(after.filter(({ run }) => run.state === "Cancelled")).toHaveLength(1);
    expect(after.every(({ run, inputs }) => run.causalRootId === root && inputs.length === 1)).toBe(true);
    expect(new Set(after.map(({ run }) => run.parentAttentionId)).size).toBe(51);
    await system.web.loadThread(root);
    await system.sync();
    expect(system.web.getSnapshot().thread!.runs).toHaveLength(51);
    expect(system.events.filter((event) => event.type === "RunCreated")).toHaveLength(51);
  });
});
