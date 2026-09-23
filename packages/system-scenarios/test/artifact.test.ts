import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { runSystemScenario } from "../src/index.js";

it("SS-3.6: trusted equal-byte reports retain separate identity, scope and restart evidence", async () => {
  await runSystemScenario(async (system) => {
    const text = "Synthetic immutable report.\n";
    const ids: string[] = [];
    system.provider(async ({ cause, capabilities, agent, activationId }) => {
      if (cause.type === "attention") {
        await capabilities.createRunFromAttention();
        return;
      }
      const id = await capabilities.publishReport({ idempotencyKey: "report", text });
      expect(await capabilities.publishReport({ idempotencyKey: "report", text })).toBe(id);
      const context = { principalId: agent.principalId, activationId };
      expect((await system.kernel.readArtifact(id, context)).content).toEqual(Buffer.from(text));
      if (ids[0]) {
        const foreign = await system.kernel.readArtifact(ids[0], context).catch((error: unknown) => error);
        const absent = await system.kernel.readArtifact("artifact-absent", context).catch((error: unknown) => error);
        expect(foreign).toMatchObject({ code: "NotFound" });
        expect(foreign).toEqual(absent);
        expect(cause.run.artifacts).toHaveLength(0);
        expect(cause.thread.artifacts).toHaveLength(0);
      }
      ids.push(id);
      await capabilities.wait("Keep report Run available for restart.");
    });
    const root = await system.startThread(["agent-orbit", "agent-keel"]);
    await system.drain();
    expect(new Set(ids).size).toBe(2);
    const runs = await system.runs();
    const artifacts = runs.flatMap((projection) => projection.artifacts);
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((artifact) => artifact.producerRunId)).size).toBe(2);
    expect(artifacts.map((artifact) => artifact.contentDigest))
      .toEqual(Array(2).fill(`sha256:${createHash("sha256").update(text).digest("hex")}`));
    const reopened = await system.reopen();
    expect((await reopened.runs()).flatMap((projection) => projection.artifacts)).toEqual(artifacts);
    for (const id of ids) {
      const response = await reopened.http.fetch(`${reopened.http.origin}/api/v1/artifacts/${id}/content`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(text);
    }
    await reopened.web.loadThread(root);
    await reopened.sync();
    expect(reopened.web.getSnapshot().thread!.artifacts).toHaveLength(2);
    expect(reopened.events.filter((event) => event.type === "ArtifactPublished")).toHaveLength(0);
  });
});
