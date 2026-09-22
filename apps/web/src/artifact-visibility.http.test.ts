// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactHttpFixture } from "../../server/test/fixtures/artifact-scope";
import { WebController } from "./controller";
import { ControlledBrowser, HttpEvents } from "./test/run-composer-http";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(equal: boolean, human = false) {
  const f = await artifactHttpFixture(equal);
  cleanup.push(() => f.close());
  const parent = f.scopes.parent;
  for (let index = 1; index <= 150; index += 1) {
    await f.kernel.execute({
      type: "AppendRunActivity", idempotencyKey: `activity-${index}`,
      runId: parent.runId, activationId: parent.context.activationId,
      kind: "agent_message_chunk", payload: { text: `Synthetic output ${index}` }, retentionClass: "transient",
    }, { principalId: "principal-runtime" });
  }
  const browser = new ControlledBrowser();
  const sources: HttpEvents[] = [];
  const broadcasts: unknown[] = [];
  const channel = Object.assign(new EventTarget(), {
    name: "synthetic", onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null,
    postMessage(message: unknown) { broadcasts.push(message); }, close() {},
  });
  const storage = new Map<string, string>();
  const controller = new WebController({
    apiBase: f.origin, fetch: browser.fetch,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    },
    eventSourceFactory(url) {
      const source = new HttpEvents(url, browser);
      sources.push(source);
      return source as unknown as EventSource;
    },
    broadcastChannelFactory: () => channel,
    agentLivenessRefreshMs: 60_000,
  });
  cleanup.push(async () => {
    browser.releaseAll();
    controller.dispose();
    await Promise.all(sources.map((source) => source.done));
  });
  await controller.exchangeSession(human ? "synthetic-human" : "synthetic-parent", "project-sample");
  await sources[0]!.ready.promise;
  await controller.loadThreads("channel-general");
  await controller.loadThread(f.scopes.threadId);
  await controller.loadRun(parent.runId);
  await controller.loadEarlierRunActivity();
  expect(controller.getSnapshot().run!.activity.items).toHaveLength(150);
  return { ...f, controller, browser, sources, broadcasts, channel };
}

describe("Artifact visibility through real HTTP/SSE Web history (MVP 23.2, 35.3, 37.3, 44.2)", () => {
  it.each([true, false])("keeps scoped initial/replacement/history projections and filtered reconnects safe (equal bytes = %s)", async (equal) => {
    const f = await setup(equal);
    const { controller, browser, sources } = f;
    const parent = f.scopes.parent;
    const originalHistory = controller.getSnapshot().run!.activity;
    expect(controller.getSnapshot().thread!.artifacts).toEqual([f.reports[0]!.artifact]);
    expect(controller.getSnapshot().threads[0]!.artifacts).toEqual([f.reports[0]!.artifact]);
    controller.runComposer.edit(parent.runId, "Keep this local draft.");
    const visible = await f.kernel.finalizeReport({
      runId: parent.runId, expectedRunRevision: 1, idempotencyKey: "visible-second",
      content: Buffer.from("Another visible synthetic report."),
    }, parent.context);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().run!.artifacts).toHaveLength(2);
      expect(controller.getSnapshot().thread!.artifacts).toHaveLength(2);
      expect(controller.getSnapshot().loadingRun).toBe(false);
      expect(controller.getSnapshot().loadingThread).toBe(false);
      expect(controller.getSnapshot().loadingThreads).toBe(false);
    });
    const beforeRequests = browser.requests.length;
    const foreignIds = f.reports.slice(1).map((report) => report.artifact.id);
    for (const [index, report] of f.reports.slice(1).entries()) {
      const result = await f.kernel.finalizeReport({
        runId: report.run.runId, expectedRunRevision: 1, idempotencyKey: "foreign-second",
        content: Buffer.from(equal ? "Shared foreign bytes." : `Foreign synthetic ${index}.`),
      }, report.run.context);
      foreignIds.push(result.entityId);
    }
    const watermark = (await f.kernel.query({
      type: "GetBootstrap", projectId: "project-sample",
    }, { principalId: "principal-human" })).latestEventId;
    await vi.waitFor(() => expect(controller.getSnapshot().lastEventId).toBe(watermark));
    expect(browser.requests).toHaveLength(beforeRequests);
    expect(sources[0]!.checkpoints).toContain(watermark);
    expect(sources[0]!.received.filter((event) => event.entityType === "Artifact").map((event) => event.entityId))
      .toEqual([visible.entityId]);
    expect(JSON.stringify(f.broadcasts)).not.toContain(visible.entityId);
    for (const id of foreignIds) expect(JSON.stringify(controller.getSnapshot())).not.toContain(id);
    const eventsBeforeReconnect = sources[0]!.received.length;
    await sources[0]!.reconnect(controller.getSnapshot().lastEventId);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().connection).toBe("live");
      expect(controller.getSnapshot().loadingRun).toBe(false);
    });
    expect(new URL(sources[0]!.connections.at(-1)!).searchParams.get("cursor")).toBe(watermark);
    expect(sources[0]!.received).toHaveLength(eventsBeforeReconnect);
    const heldThread = browser.hold(`/api/v1/threads/${f.scopes.threadId}`);
    const pair = controller.refreshRunComposer(parent.runId);
    await heldThread.observed;
    expect(await controller.loadRun(parent.runId)).toBe(true);
    heldThread.release();
    expect(await pair).toBe(true);
    expect(controller.getSnapshot().run!.activity).toEqual(originalHistory);
    expect(controller.runComposer.getSnapshot()[parent.runId]?.draft).toBe("Keep this local draft.");
    expect(controller.getSnapshot().run!.artifacts).toHaveLength(2);
    for (const id of foreignIds) expect(JSON.stringify(controller.getSnapshot())).not.toContain(id);
    const ownEvent = sources[0]!.received.find((event) => event.entityId === visible.entityId)!;
    f.channel.onmessage?.(new MessageEvent("message", {
      data: { kind: "event", event: { ...ownEvent, eventId: "untrusted-window-cursor", entityId: foreignIds[0] } },
    }));
    expect(controller.getSnapshot().lastEventId).toBe(watermark);
    await controller.signOut();
    await controller.exchangeSession("synthetic-child", "project-sample");
    await controller.loadThread(f.scopes.threadId);
    await controller.loadRun(f.scopes.child.runId);
    expect(controller.getSnapshot().thread!.artifacts).toHaveLength(2);
    expect(controller.getSnapshot().run!.activity.items).toHaveLength(0);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(visible.entityId);
    sources[0]!.dispatchEvent(new MessageEvent("checkpoint", { data: JSON.stringify({ cursor: "stale-source-cursor" }) }));
    sources[0]!.dispatchEvent(new MessageEvent("torsor", { data: JSON.stringify(ownEvent) }));
    expect(controller.getSnapshot().lastEventId).not.toBe("stale-source-cursor");
    expect(controller.getSnapshot().lastEventId).not.toBe(ownEvent.eventId);
  });

  it("retains Human Composer and loaded Timeline history with project-authorized reports", async () => {
    const f = await setup(true, true);
    const history = f.controller.getSnapshot().run!.activity;
    expect(f.controller.getSnapshot().thread!.artifacts).toHaveLength(4);
    f.controller.runComposer.edit(f.scopes.parent.runId, "Keep the authorized reports and history.");
    await f.controller.sendToRun(f.scopes.parent.runId);
    expect(f.controller.runComposer.getSnapshot()[f.scopes.parent.runId]?.status).toBe("submitted");
    expect(f.controller.getSnapshot().run!.activity).toEqual(history);
    expect(f.controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(f.controller.getSnapshot().thread!.artifacts).toHaveLength(4);
    expect(f.controller.getSnapshot().run!.artifacts).toEqual([f.reports[0]!.artifact]);
  });
});
