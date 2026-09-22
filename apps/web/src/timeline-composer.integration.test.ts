// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComposerHttp } from "./test/run-composer-http";

const fixtures: Awaited<ReturnType<typeof runComposerHttp>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function setup() {
  const fixture = await runComposerHttp({ pauseEvents: true });
  fixtures.push(fixture);
  await fixture.appendActivity(250);
  fixture.controller.clearRun();
  await fixture.controller.loadRun(fixture.first.id);
  return fixture;
}

function sequences(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

describe("Composer and Timeline shared projection reads (§37.3, §44.2)", () => {
  it("preserves causal provenance and one committed input through terminal replay at full capacity", async () => {
    const fixture = await runComposerHttp({
      pauseEvents: true,
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
    });
    fixtures.push(fixture);
    const { kernel, controller, first, second, browser } = fixture;
    const human = { principalId: "principal-human" };
    await fixture.appendActivity(250);
    await controller.loadRun(first.id);
    await controller.loadEarlierRunActivity();
    await controller.loadEarlierRunActivity();
    const history = controller.getSnapshot().run!.activity;
    expect(history.items).toHaveLength(250);
    const initial = await kernel.query({ type: "GetRunProjection", runId: first.id }, human);
    const provenance = {
      causalRootId: first.threadId,
      parentAttentionId: initial.run.parentAttentionId,
      parentRunId: null,
      delegationDepth: 0,
    };
    expect(controller.getSnapshot().run!.run).toMatchObject(provenance);
    controller.runComposer.edit(second.id, "Keep the other Run's draft.");
    controller.runComposer.edit(first.id, "One instruction at full causal capacity.");
    const lost = browser.hold("/api/v1/commands/send-to-run", "response-loss");
    const sending = controller.sendToRun(first.id);
    await lost.observed;
    lost.release();
    await sending;
    expect(controller.runComposer.getSnapshot()[first.id]?.status).toBe("unknown");
    const originalRequest = controller.runComposer.getSnapshot()[first.id]!.request;
    expect(originalRequest).not.toBeNull();
    const committed = await kernel.query({ type: "GetRunProjection", runId: first.id }, human);
    expect(committed.run).toMatchObject({ ...provenance, state: "Active", revision: 2 });
    expect(committed.inputs).toHaveLength(2);
    await kernel.execute({
      type: "CancelRun", idempotencyKey: "causal-composer-cancel",
      runId: first.id, expectedRunRevision: 2, reason: "Human stopped this synthetic Run.",
    }, human);
    expect(await controller.refreshRunComposer(first.id)).toBe(true);
    expect(controller.getSnapshot().run!.run).toMatchObject({
      ...provenance, state: "Cancelled", revision: 3,
    });
    expect(controller.runComposer.getSnapshot()[first.id]!.request).toBe(originalRequest);
    await controller.sendToRun(first.id);
    expect(controller.runComposer.getSnapshot()[first.id]).toMatchObject({
      status: "submitted", request: null, projectionStatus: "idle",
    });
    expect(controller.getSnapshot().run!.activity).toEqual(history);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
    expect(controller.getSnapshot().thread!.runs).toHaveLength(1);
    expect(controller.getSnapshot().run!.run).toMatchObject({
      ...provenance, state: "Cancelled", revision: 3,
    });
    expect(controller.runComposer.getSnapshot()[second.id]?.draft)
      .toBe("Keep the other Run's draft.");
    const sends = browser.requests.filter((request) => request.path.endsWith("/send-to-run"));
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body).toBe(sends[0]!.body);
    const events = await kernel.query({
      type: "ReadPublicEvents", projectId: "project-sample", limit: 100,
    }, human);
    expect(events.events.filter((event) =>
      event.type === "RunCreated" && event.entityId === first.id,
    )).toHaveLength(1);
  });

  it("preserves >100 loaded activity items when a submission refreshes Run and Thread", async () => {
    const { controller, first, browser } = await setup();
    await controller.loadEarlierRunActivity();
    await controller.loadEarlierRunActivity();
    const original = controller.getSnapshot().run!.activity;
    expect(original.items).toHaveLength(250);
    controller.runComposer.edit(first.id, "Keep history after this input.");
    await controller.sendToRun(first.id);
    expect(controller.getSnapshot().run!.activity).toEqual(original);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
    expect(controller.runComposer.getSnapshot()[first.id]).toMatchObject({
      status: "submitted", request: null, projectionStatus: "idle",
    });
    expect(browser.requests.filter((request) => request.path.endsWith("/send-to-run"))).toHaveLength(1);
  });

  it("fills a paired refresh's reconnect gap and retains history loaded while its Thread half is held", async () => {
    const { controller, first, browser, appendActivity } = await setup();
    await appendActivity(250);
    const thread = browser.hold(`/api/v1/threads/${first.threadId}`);
    const paired = controller.refreshRunComposer(first.id);
    await thread.observed;
    await vi.waitFor(() => expect(
      browser.requests.filter((request) => request.path.endsWith("/activity")),
    ).toHaveLength(2));
    expect(controller.getSnapshot().run!.activity.latestSequence).toBe(250);
    await controller.loadEarlierRunActivity();
    thread.release();
    expect(await paired).toBe(true);
    expect(controller.getSnapshot().run!.activity.items.map((item) => item.sequence))
      .toEqual(sequences(51, 500));
    expect(controller.getSnapshot().run!.activity.hasEarlier).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false });
  });

  it("keeps an acknowledged receipt on gap-read failure and retries only reads", async () => {
    const { controller, first, browser, appendActivity } = await setup();
    await controller.loadEarlierRunActivity();
    await appendActivity(250);
    const original = controller.getSnapshot().run!;
    const failedGap = browser.hold(`/api/v1/runs/${first.id}/activity`, true);
    controller.runComposer.edit(first.id, "One committed instruction.");
    const sending = controller.sendToRun(first.id);
    await failedGap.observed;
    failedGap.release();
    await sending;
    expect(controller.getSnapshot().run).toBe(original);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(1);
    expect(controller.runComposer.getSnapshot()[first.id]).toMatchObject({
      status: "submitted", request: null, projectionStatus: "failed",
    });
    const receipt = controller.runComposer.getSnapshot()[first.id]!.acknowledged;
    expect(receipt).not.toBeNull();
    expect(await controller.refreshRunComposer(first.id)).toBe(true);
    expect(controller.getSnapshot().run!.activity.items.map((item) => item.sequence))
      .toEqual(sequences(51, 500));
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(controller.runComposer.getSnapshot()[first.id]!.acknowledged).toBe(receipt);
    expect(browser.requests.filter((request) => request.path.endsWith("/send-to-run"))).toHaveLength(1);
    expect(controller.getSnapshot().queryError).toBeNull();
  });

  it("lets a single Run read replace a failed paired catch-up without changing another Run's draft", async () => {
    const { controller, first, second, browser, appendActivity } = await setup();
    controller.runComposer.edit(first.id, "First unsent draft.");
    controller.runComposer.edit(second.id, "Second independent draft.");
    await appendActivity(250);
    const gap = browser.hold(`/api/v1/runs/${first.id}/activity`, true);
    const pair = controller.refreshRunComposer(first.id);
    await gap.observed;
    expect(await controller.loadRun(first.id)).toBe(true);
    gap.release();
    expect(await pair).toBe(true);
    expect(controller.getSnapshot().run!.activity.items.map((item) => item.sequence))
      .toEqual(sequences(151, 500));
    expect(controller.runComposer.getSnapshot()[first.id]?.draft).toBe("First unsent draft.");
    expect(controller.runComposer.getSnapshot()[second.id]?.draft).toBe("Second independent draft.");
    expect(controller.getSnapshot()).toMatchObject({
      loadingRun: false, loadingThread: false, queryError: null, runRefreshError: null,
    });

  });

  it.each(["selection", "session"] as const)("fences a late failed gap after changing %s", async (scope) => {
    const { controller, first, second, browser, appendActivity } = await setup();
    controller.runComposer.edit(second.id, "Keep the newly selected draft.");
    await appendActivity(250);
    const gap = browser.hold(`/api/v1/runs/${first.id}/activity`, true);
    const pair = controller.refreshRunComposer(first.id);
    await gap.observed;
    if (scope === "session") await controller.exchangeSession("synthetic-human", "project-sample");
    await controller.loadRun(second.id);
    const selected = controller.getSnapshot().run;
    gap.release();
    expect(await pair).toBe(false);
    expect(controller.getSnapshot().run).toBe(selected);
    expect(controller.runComposer.getSnapshot()[second.id]?.draft).toBe("Keep the newly selected draft.");
    expect(controller.getSnapshot()).toMatchObject({
      session: "ready", loadingRun: false, loadingThread: false,
      loadingRunHistory: false, queryError: null, runRefreshError: null,
    });
  });
});
