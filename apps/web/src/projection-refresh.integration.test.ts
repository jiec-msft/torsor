// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComposerHttp } from "./test/run-composer-http";

const fixtures: Awaited<ReturnType<typeof runComposerHttp>>[] = [];
async function setup() {
  const fixture = await runComposerHttp();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("independent Thread/Run refresh ownership over HTTP/SSE/SQLite (§44.2)", () => {
  it("settles an existing Run load superseded by a pair when a real Reply replaces only the Thread half", async () => {
    const { controller, browser, first, sources, reply } = await setup();
    controller.runComposer.edit(first.id, "Keep this draft enabled.");
    const oldRun = browser.hold(`/api/v1/runs/${first.id}`);
    const single = controller.loadRun(first.id);
    await oldRun.observed;
    const pairRun = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await pairRun.observed;
    await reply("An ordinary concurrent Reply.");
    await vi.waitFor(() => {
      expect(sources[0]!.received.some((event) => event.type === "MessagePublished")).toBe(true);
      expect(controller.getSnapshot().thread?.messages).toHaveLength(2);
      expect(controller.getSnapshot().loadingThread).toBe(false);
    });
    oldRun.release();
    pairRun.release();
    expect(await pair).toBe(true);
    expect(await single).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, queryError: null });
    expect(controller.runComposer.getSnapshot()[first.id]?.draft).toBe("Keep this draft enabled.");
  });

  it.each([
    ["run", "thread", "run"], ["run", "thread", "thread"],
    ["thread", "run", "run"], ["thread", "run", "thread"],
  ] as const)("follows %s/%s replacements when the old %s response is released first", async (firstHalf, secondHalf, releaseFirst) => {
    const { controller, browser, first } = await setup();
    const paths = { run: `/api/v1/runs/${first.id}`, thread: `/api/v1/threads/${first.threadId}` };
    const heldRun = browser.hold(paths.run);
    const heldThread = browser.hold(paths.thread);
    const pair = controller.refreshRunComposer(first.id);
    await Promise.all([heldRun.observed, heldThread.observed]);
    const replace = (half: "run" | "thread") =>
      half === "run" ? controller.loadRun(first.id) : controller.loadThread(first.threadId);
    const firstGate = browser.hold(paths[firstHalf]);
    const replacement1 = replace(firstHalf);
    await firstGate.observed;
    const secondGate = browser.hold(paths[secondHalf]);
    const replacement2 = replace(secondHalf);
    await secondGate.observed;
    (releaseFirst === "run" ? heldRun : heldThread).release();
    (releaseFirst === "run" ? heldThread : heldRun).release();
    firstGate.release();
    expect(await replacement1).toBe(true);
    expect(controller.getSnapshot()[secondHalf === "run" ? "loadingRun" : "loadingThread"]).toBe(true);
    secondGate.release();
    expect(await replacement2).toBe(true);
    expect(await pair).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false, queryError: null });
  });

  it.each([false, true])("hands a paired refresh to a newer pair without dependency cycles (replacement failure: %s)", async (fail) => {
    const { controller, browser, first } = await setup();
    const older = browser.hold(`/api/v1/runs/${first.id}`, true);
    const firstPair = controller.refreshRunComposer(first.id);
    await older.observed;
    const newer = browser.hold(`/api/v1/threads/${first.threadId}`, fail);
    const nextPair = controller.refreshRunComposer(first.id);
    await newer.observed;
    newer.release();
    expect(await nextPair).toBe(!fail);
    older.release();
    expect(await firstPair).toBe(!fail);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false });
    expect(controller.runComposer.getSnapshot()[first.id]?.projectionStatus).toBe(fail ? "failed" : "idle");
    expect(controller.getSnapshot().queryError === null).toBe(!fail);
  });

  it("rechecks session scope after waiting for a replacement read", async () => {
    const { controller, browser, first } = await setup();
    const original = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await original.observed;
    const heldReplacement = browser.hold(`/api/v1/runs/${first.id}`);
    const replacement = controller.loadRun(first.id);
    await heldReplacement.observed;
    original.release();
    await vi.waitFor(() => expect(controller.getSnapshot().loadingThread).toBe(false));
    await controller.exchangeSession("synthetic-human", "project-sample");
    await controller.loadRun(first.id);
    await controller.loadThread(first.threadId);
    heldReplacement.release();
    await replacement;
    expect(await pair).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ session: "ready", loadingRun: false, loadingThread: false, queryError: null });
  });

  it.each(["run", "thread"] as const)("propagates a newer %s replacement failure and settles the still-current other half", async (half) => {
    const { controller, browser, first } = await setup();
    const held = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await held.observed;
    const failed = browser.hold(half === "run" ? `/api/v1/runs/${first.id}` : `/api/v1/threads/${first.threadId}`, true);
    const replacement = half === "run" ? controller.loadRun(first.id) : controller.loadThread(first.threadId);
    await failed.observed;
    failed.release();
    expect(await replacement).toBe(false);
    held.release();
    expect(await pair).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false });
    expect(controller.getSnapshot().queryError).toContain("Read failed");
  });

  it.each(["selection", "session", "project"] as const)("does not settle or overwrite a newer %s scope", async (scope) => {
    const { controller, browser, first, second } = await setup();
    const held = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await held.observed;
    if (scope !== "selection") {
      await controller.exchangeSession("synthetic-human", scope === "project" ? "project-other" : "project-sample");
    }
    const newer = scope === "project" ? null : browser.hold(`/api/v1/runs/${second.id}`);
    const next = newer ? controller.loadRun(second.id) : Promise.resolve(true);
    if (newer) await newer.observed;
    held.release();
    expect(await pair).toBe(false);
    expect(controller.getSnapshot().run).toBeNull();
    expect(controller.getSnapshot().loadingRun).toBe(newer !== null);
    if (newer) {
      newer.release();
      expect(await next).toBe(true);
      expect(controller.getSnapshot().run?.run.id).toBe(second.id);
    } else {
      expect(controller.getSnapshot().bootstrap?.project.id).toBe("project-other");
    }
    expect(controller.getSnapshot().queryError).toBeNull();
  });

  it("settles the Run half without clearing a newer Thread selection's loading or error", async () => {
    const { controller, browser, first, second } = await setup();
    const held = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await held.observed;
    const newer = browser.hold(`/api/v1/threads/${second.threadId}`, true);
    const next = controller.loadThread(second.threadId);
    await newer.observed;
    held.release();
    expect(await pair).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: true, thread: null });
    newer.release();
    expect(await next).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false, thread: null });
    expect(controller.getSnapshot().queryError).toContain(second.threadId);
    expect(controller.getSnapshot().run?.run.id).toBe(first.id);
  });

  it.each(["run", "thread"] as const)("does not restore cleared %s selection or loading on a late pair", async (half) => {
    const { controller, browser, first } = await setup();
    const held = browser.hold(`/api/v1/runs/${first.id}`);
    const pair = controller.refreshRunComposer(first.id);
    await held.observed;
    if (half === "run") controller.clearRun();
    else controller.clearThread();
    held.release();
    expect(await pair).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ run: null, loadingRun: false, loadingThread: false, queryError: null });
    if (half === "thread") expect(controller.getSnapshot().thread).toBeNull();
  });

  it("hands both older single reads to a paired replacement that fails", async () => {
    const { controller, browser, first } = await setup();
    const run = browser.hold(`/api/v1/runs/${first.id}`);
    const thread = browser.hold(`/api/v1/threads/${first.threadId}`);
    const singles = [controller.loadRun(first.id), controller.loadThread(first.threadId)];
    await Promise.all([run.observed, thread.observed]);
    const failure = browser.hold(`/api/v1/threads/${first.threadId}`, true);
    const pair = controller.refreshRunComposer(first.id);
    await failure.observed;
    failure.release();
    expect(await pair).toBe(false);
    run.release();
    thread.release();
    expect(await Promise.all(singles)).toEqual([false, false]);
    expect(controller.getSnapshot()).toMatchObject({ loadingRun: false, loadingThread: false });
    expect(controller.getSnapshot().queryError).toContain("Read failed");
  });
});
